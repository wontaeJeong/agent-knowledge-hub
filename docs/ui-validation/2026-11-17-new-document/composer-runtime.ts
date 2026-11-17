// Synthetic capture adapter only. Never imported by the production runtime.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture } from "../../../server/test-support";
import { AccessService, authorizeInTransaction } from "../../../server/access";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../../../server/collaboration";
if (
  process.env.AKH_C6_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic capture opt-in required");
const url = new URL(process.env.TEST_DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.includes("test")
)
  throw Error("Loopback test DB required");
const admin = new Pool({ connectionString: url.href }),
  name = "akh_c6_ui_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE "${name}"`);
url.pathname = "/" + name;
process.env.TEST_DATABASE_URL = url.href;
for (const key of Object.keys(process.env))
  if (key.startsWith("AGENT_KNOWLEDGE_HUB_LLM_")) delete process.env[key];
process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
let pool: Pool | undefined;
try {
  const f = await fixture();
  pool = f.pool;
  await adoptFixture(f.pool, f.workspaceId);
  const p = await new AccessService(f.pool).createSpace(
    f.editor,
    "합성 개인 공간",
  );
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",
    [f.workspaceId],
  );
  const runtime = new RuntimeService(f.pool),
    collaboration = new CollaborationService(
      f.pool,
      {
        authorize: authorizeInTransaction,
        assertDispatcher: async () => {},
        verifyRecipient: async () => {
          throw Error("UNCONFIGURED");
        },
        resolveReviewResponsibility: resolveGovernanceResponsibility,
      },
      { applicationOrigin: "http://127.0.0.1:5196" },
    );
  const auth = {
    authenticate: async (req: { headers: { cookie?: string } }) => ({
      workspaceId: req.headers.cookie?.includes("synthetic-personal")
        ? p.id
        : f.workspaceId,
      principalId: req.headers.cookie?.includes("synthetic-reviewer")
        ? "reviewer"
        : "editor",
      csrfToken: "test-only-csrf",
    }),
    requestGuard: () => ({
      revalidate: async () => {},
      assertSession: async () => {},
    }),
  };
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      origin: "http://127.0.0.1:5196",
      workspaceId: f.workspaceId,
      auth,
      collaboration,
    } as any),
  );
  await new Promise<void>((r) => server.listen(4396, "127.0.0.1", r));
  await writeFile(
    "/private/tmp/akh_c6_browser.json",
    JSON.stringify({
      workspaceId: f.workspaceId,
      personalId: p.id,
      database: name,
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  console.log("Synthetic C6 runtime ready on 4396");
} catch (e) {
  await pool?.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  throw e;
}
