// Evidence-only synthetic identities; never import from the production runtime.
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture, page } from "../../../server/test-support";
import { authorizeInTransaction } from "../../../server/access";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { WorkflowService } from "../../../server/workflows/service";
import { createRuntimeHandler } from "../../../server/runtime/http";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../../../server/collaboration";
if (
  process.env.AKH_C3_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic capture opt-in and test database required");
const base = new URL(process.env.TEST_DATABASE_URL);
if (
  !base.pathname.includes("test") ||
  !["127.0.0.1", "localhost"].includes(base.hostname)
)
  throw Error("Loopback test database required");
const admin = new Pool({ connectionString: base.href }),
  name = `akh_c3_ui_${Date.now()}`;
await admin.query(`CREATE DATABASE "${name}"`);
base.pathname = "/" + name;
process.env.TEST_DATABASE_URL = base.href;
const f = await fixture();
await adoptFixture(f.pool, f.workspaceId);
const runtime = new RuntimeService(f.pool),
  workflow = new WorkflowService(f.pool, runtime, authorizeInTransaction);
for (let n = 1; n <= 28; n++) {
  const id = `library-${String(n).padStart(2, "0")}`,
    { versions, ...metadata } = {
      ...page,
      id,
      title: `합성 문서 ${String(n).padStart(2, "0")}`,
    };
  await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
    f.workspaceId,
    id,
  ]);
  for (const actor of ["editor", "reviewer", "reader"])
    await f.pool.query("INSERT INTO resource_readers VALUES($1,'page',$2,$3)", [
      f.workspaceId,
      id,
      actor,
    ]);
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, id, metadata],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    id,
    versions[0],
  ]);
  await workflow.favorite(f.ctx, id, true);
  if (n <= 3) await workflow.subscribe(f.ctx, id, true);
  if (n <= 4) await workflow.document(f.ctx, id);
}
const collaboration = new CollaborationService(
  f.pool,
  {
    authorize: authorizeInTransaction,
    assertDispatcher: async () => {},
    verifyRecipient: async () => {
      throw Error("UNCONFIGURED");
    },
    resolveReviewResponsibility: resolveGovernanceResponsibility,
  },
  { applicationOrigin: "http://127.0.0.1:5193" },
);
const auth = {
  authenticate: async (req: { headers: { cookie?: string } }) => ({
    ...(req.headers.cookie === "synthetic-editor" ? f.editor : f.ctx),
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
    origin: "http://127.0.0.1:5193",
    workspaceId: f.workspaceId,
    auth,
    collaboration,
  } as any),
);
await new Promise<void>((r) => server.listen(4393, "127.0.0.1", r));
await writeFile(
  "/private/tmp/akh-c3-browser.json",
  JSON.stringify({ workspaceId: f.workspaceId, database: name }),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((r) => server.close(() => r()));
  await f.pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
console.log("Synthetic C3 runtime ready on 4393");
