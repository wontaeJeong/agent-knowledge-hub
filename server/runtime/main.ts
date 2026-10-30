import { createServer } from "node:http";
import { Pool } from "pg";
import { migrate, assertSchemaCurrent } from "../database";
import { OidcAuth } from "./auth";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import { bootstrapAccess, validateAccessBootstrap } from "../access";
import { authorizeInTransaction } from "../access";
import { StorageService, FileBlobStore, UrlCollector } from "../storage";
import { RefinementService } from "../refinement/service";
import {
  createSemanticProvider,
  semanticConfigFromEnvironment,
} from "../refinement/semantic";
import { HttpAdmission } from "./admission";
import {
  OperationsService,
  operationsRoutes,
  operationsAuthorizer,
  assertOperationalStartup,
} from "../operations";
import { createRuntimeJobs } from "../jobs/runtime";
import { directoryFromEnvironment } from "./directory";
import { z } from "zod";
import { ShutdownController, operationsProbeHandler } from "../operations";
import { modelConfig } from "./model";
import { modelAvailabilityProbe } from "./probe-model";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5000,
});
if (process.argv.includes("--migrate")) {
  await migrate(pool);
  if (process.env.ACCESS_BOOTSTRAP_JSON) {
    const input = validateAccessBootstrap(
      JSON.parse(process.env.ACCESS_BOOTSTRAP_JSON),
    );
    for (const s of input.spaces ?? [])
      await pool.query(
        "INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING",
        [s.workspaceId],
      );
    await bootstrapAccess(pool, input);
  }
  await pool.end();
} else {
  await assertSchemaCurrent(pool);
  await assertOperationalStartup(pool);
  const auth = await OidcAuth.create(pool);
  // Accepted in-flight jobs are visible after restart as interrupted, never silently successful.
  await pool.query(
    `UPDATE runtime_jobs SET status='failed',error_code='PROCESS_INTERRUPTED',finished_at=now() WHERE status='running';
     DELETE FROM batches WHERE data->>'requestAuthorizationPending'='true';
     DELETE FROM runtime_answers WHERE data->>'requestAuthorizationPending'='true';`,
  );
  const service = new RuntimeService(pool);
  if (!process.env.AKH_BLOB_ROOT) throw Error("STORAGE_NOT_CONFIGURED");
  const minimumAvailableBytes = Number(
    process.env.AKH_BLOB_MIN_AVAILABLE_BYTES ?? 64 * 1024 * 1024,
  );
  if (
    !Number.isSafeInteger(minimumAvailableBytes) ||
    minimumAvailableBytes < 5 * 1024 * 1024
  )
    throw Error("STORAGE_CAPACITY_CONFIGURATION");
  const storage = new StorageService(
    pool,
    new FileBlobStore(process.env.AKH_BLOB_ROOT),
    authorizeInTransaction,
    { minimumAvailableBytes },
  );
  const collector = new UrlCollector({
    enabled: process.env.AKH_URL_COLLECTION_ENABLED === "true",
    approvedOrigins: JSON.parse(
      process.env.AKH_APPROVED_COLLECTION_ORIGINS ?? "[]",
    ),
  });
  const refinement = new RefinementService(
    pool,
    authorizeInTransaction,
    createSemanticProvider(semanticConfigFromEnvironment()),
  );
  const operations = operationsRoutes(
    new OperationsService(
      pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport:
          process.env.AKH_ADMIN_AUDIT_METADATA_EXPORT_ENABLED === "true",
      }),
    ),
  );
  let platformOperatorIds: string[];
  try {
    platformOperatorIds = z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/))
      .max(100)
      .parse(JSON.parse(process.env.AKH_PLATFORM_OPERATOR_IDS ?? "[]"));
  } catch {
    throw Error("PLATFORM_OPERATOR_CONFIGURATION_REQUIRED");
  }
  const jobs = createRuntimeJobs(pool, service, {
    ...directoryFromEnvironment(),
    platformOperatorIds,
    semanticLint: refinement.semanticJobAdapter(),
    revalidateInteractiveGrant: (binding) =>
      auth.revalidateInteractiveGrant(binding),
    assertInteractiveGrant: (db, binding) =>
      auth.assertInteractiveGrant(db, binding),
  });
  const shutdown = new ShutdownController();
  const probe = operationsProbeHandler({
    pool,
    shutdown,
    metricsToken: process.env.AKH_METRICS_TOKEN,
    modelProbe: modelAvailabilityProbe({
      ...modelConfig(),
      baseUrl: process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL,
      apiKey: process.env.AGENT_KNOWLEDGE_HUB_LLM_API_KEY,
    }),
    contentDirectory: process.env.AKH_BLOB_ROOT,
    minimumAvailableBytes,
  });
  const server = createServer(
    createRuntimeHandler({
      pool,
      service,
      auth,
      origin: auth.origin,
      workspaceId: auth.workspaceId,
      storage,
      collector,
      refinement,
      operations,
      jobs,
      platformOperatorIds,
      shutdown,
      probe,
      admission: new HttpAdmission(),
    }),
  );
  server.requestTimeout = 75000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
  jobs.start();
  const stop = () => {
    shutdown.draining = true;
    server.close(async () => {
      await jobs.stop();
      await shutdown.drain(8000);
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
