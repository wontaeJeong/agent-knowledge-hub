// Evidence-only loopback identities. Never imported by the production runtime.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture, page } from "../../../server/test-support";
import { authorizeInTransaction } from "../../../server/access";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../../../server/collaboration";
import { capturePublishedVersionMetadata } from "../../../server/workflows/versions/metadata";
import { transaction } from "../../../server/database";
if (
  process.env.AKH_C5_SYNTHETIC_CAPTURE !== "1" ||
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
  name = `akh_c5_ui_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${name}"`);
base.pathname = "/" + name;
process.env.TEST_DATABASE_URL = base.href;
// Deliberately disconnected: these evidence processes cannot inherit a provider configuration.
for (const key of Object.keys(process.env))
  if (key.startsWith("AGENT_KNOWLEDGE_HUB_LLM_")) delete process.env[key];
let fixturePool: Pool | undefined;
try {
  const f = await fixture();
  fixturePool = f.pool;
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool);
  for (let n = 1; n <= 28; n++) {
    const id = `search-${String(n).padStart(2, "0")}`,
      { versions, ...metadata } = {
        ...page,
        id,
        title:
          n === 28
            ? "코드_retry 안내"
            : `합성 검색 문서 ${String(n).padStart(2, "0")}`,
        tags: ["synthetic"],
      };
    await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
      f.workspaceId,
      id,
    ]);
    for (const actor of ["editor", "reviewer", "reader"])
      await f.pool.query(
        "INSERT INTO resource_readers VALUES($1,'page',$2,$3)",
        [f.workspaceId, id, actor],
      );
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
      [f.workspaceId, id, metadata],
    );
    await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
      f.workspaceId,
      id,
      {
        ...versions[0],
        id: `v-${id}`,
        content: `# 합성 키워드 문서 ${n}\n\n코드_retry 사용 조건\n\n<img src=\"https://external.invalid/never.png\">`,
        at: n === 28 ? "2026-01-01T00:00:00Z" : "2026-10-29T00:00:00Z",
      },
    ]);
  }
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'page','history-topic')",
    [f.workspaceId],
  );
  for (const actor of ["editor", "reviewer", "reader"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','history-topic',$2)",
      [f.workspaceId, actor],
    );
  await transaction(f.pool, f.workspaceId, async (db) => {
    const { versions, ...metadata } = {
      ...page,
      id: "history-topic",
      title: "이전 전용 제목",
    };
    await db.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,'history-topic',$2)",
      [f.workspaceId, metadata],
    );
    await db.query("INSERT INTO versions VALUES($1,'history-topic',1,$2)", [
      f.workspaceId,
      { ...versions[0], id: "history-v1", content: "# 과거_조건\n\n당시 본문" },
    ]);
    await db.query(
      "UPDATE pages SET data=jsonb_set(data,'{title}',to_jsonb('이전 전용 제목'::text)) WHERE workspace_id=$1 AND id='history-topic'",
      [f.workspaceId],
    );
    await capturePublishedVersionMetadata(db, f.ctx, "history-topic", 1);
    await db.query(
      "UPDATE pages SET data=jsonb_set(data,'{title}',to_jsonb('현재 전용 제목'::text)) WHERE workspace_id=$1 AND id='history-topic'",
      [f.workspaceId],
    );
    await db.query("INSERT INTO versions VALUES($1,'history-topic',2,$2)", [
      f.workspaceId,
      {
        ...page.versions[0],
        id: "history-v2",
        number: 2,
        content: "현재 전용 본문",
        at: "2026-11-01T00:00:00Z",
      },
    ]);
    await capturePublishedVersionMetadata(db, f.ctx, "history-topic", 2);
  });
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
    { applicationOrigin: "http://127.0.0.1:5195" },
  );
  const auth = {
    authenticate: async (req: { headers: { cookie?: string } }) => ({
      ...(req.headers.cookie?.includes("synthetic-other") ? f.editor : f.ctx),
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
      origin: "http://127.0.0.1:5195",
      workspaceId: f.workspaceId,
      auth,
      collaboration,
    } as any),
  );
  await new Promise<void>((r) => server.listen(4395, "127.0.0.1", r));
  await writeFile(
    "/private/tmp/akh-c5-browser.json",
    JSON.stringify({ workspaceId: f.workspaceId, database: name }),
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
  console.log("Synthetic C5 runtime ready on 4395");
} catch (error) {
  await fixturePool?.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  throw error;
}
