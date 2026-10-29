import { createServer } from "node:http";
import { Pool } from "pg";
import { migrate, assertSchemaCurrent } from "../database";
import { OidcAuth } from "./auth";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";

if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 5000,
});
if (process.argv.includes("--migrate")) {
  await migrate(pool);
  await pool.end();
} else {
  await assertSchemaCurrent(pool);
  const auth = await OidcAuth.create(pool);
  // Accepted in-flight jobs are visible after restart as interrupted, never silently successful.
  await pool.query(
    `UPDATE runtime_jobs SET status='failed',error_code='PROCESS_INTERRUPTED',finished_at=now() WHERE status='running';
     DELETE FROM batches WHERE data->>'requestAuthorizationPending'='true';
     DELETE FROM runtime_answers WHERE data->>'requestAuthorizationPending'='true';`,
  );
  const service = new RuntimeService(pool);
  const server = createServer(
    createRuntimeHandler({
      pool,
      service,
      auth,
      origin: auth.origin,
      workspaceId: auth.workspaceId,
    }),
  );
  server.requestTimeout = 75000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
  const stop = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
