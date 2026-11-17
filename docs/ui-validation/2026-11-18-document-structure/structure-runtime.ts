// Explicit synthetic loopback actor adapter; canonical HTTP and PostgreSQL only.
import { sourceHashes } from "./manifest.mjs";
import * as oidc from "openid-client";
import { once } from "node:events";
import { OidcAuth, sessionHash } from "../../../server/runtime/auth";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture, page } from "../../../server/test-support";
import { authorizeInTransaction } from "../../../server/access";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import { WorkflowService } from "../../../server/workflows/service";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../../../server/collaboration";
if (
  process.env.AKH_C7_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic opt-in required");
const base = new URL(process.env.TEST_DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(base.hostname) ||
  !base.pathname.includes("test")
)
  throw Error("Loopback test DB required");
const admin = new Pool({ connectionString: base.href }),
  name = "akh_c7_test_ui_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE "${name}"`);
base.pathname = "/" + name;
process.env.TEST_DATABASE_URL = base.href;
for (const key of Object.keys(process.env))
  if (key.startsWith("AGENT_KNOWLEDGE_HUB_LLM_")) delete process.env[key];
const pools: Pool[] = [];
try {
  const main = await fixture();
  pools.push(main.pool);
  const runtime = new RuntimeService(main.pool),
    workflows = new WorkflowService(main.pool, runtime, authorizeInTransaction),
    scenarios = [];
  for (let n = 0; n < 4; n++) {
    const f = n === 0 ? main : await fixture();
    if (n) pools.push(f.pool);
    await adoptFixture(f.pool, f.workspaceId);
    await f.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{title}','\"운영 지식\"') WHERE workspace_id=$1 AND id='topic'",
      [f.workspaceId],
    );
    for (const [id, title, parentId] of [
      ["child", "문서 탐색", "topic"],
      ["leaf", "문서 구조", "child"],
      ["review", "검토 절차", null],
      ["hidden", "비공개 자료", null],
    ]) {
      await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
        f.workspaceId,
        id,
      ]);
      await f.pool.query(
        "INSERT INTO resource_readers SELECT $1,'page',$2,unnest($3::text[])",
        [
          f.workspaceId,
          id,
          id === "hidden" ? ["editor"] : ["editor", "reviewer", "reader"],
        ],
      );
      const { versions, ...metadata } = page;
      await f.pool.query(
        "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
        [
          f.workspaceId,
          id,
          { ...metadata, id, title, summary: "합성 문서 구조 검증" },
        ],
      );
      await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
        f.workspaceId,
        id,
        {
          ...versions[0],
          content:
            `[검토 절차](http://127.0.0.1:5197/?app=1&space=${f.workspaceId}&document=review)\n\n` +
            "## 문서 구조\n\n문서는 안정적인 ID로 연결됩니다. 상위 위치와 표시 순서를 바꿔도 기존 링크를 유지합니다.\n\n## 변경 절차\n\n1. 대상 상위 문서와 배치 위치를 선택합니다.\n2. 이동 이유를 입력합니다.\n3. 현재 권한과 버전을 확인한 뒤 위치를 저장합니다.",
        },
      ]);
      if (parentId)
        await workflows.setDocumentState(f.ctx, id!, {
          parentId,
          expectedRevision: 0,
          reason: "합성 3단계 구조",
        });
    }
    scenarios.push({ spaceId: f.workspaceId });
  }
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "reviewer", groups: ["reviewers"] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as any).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const realAuth = new OidcAuth(
    main.pool,
    config,
    "http://127.0.0.1:5197",
    main.workspaceId,
    { reviewers: "reviewer" },
  );
  const sessionId = sessionHash("c7-synthetic-session");
  await main.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','test-only-csrf',now()+interval '1 hour','reviewer','token')",
    [sessionId, main.workspaceId],
  );
  const auth = {
    authenticate: async (req: any) => ({
      workspaceId: req.headers["x-space-id"] ?? main.workspaceId,
      principalId: req.headers.cookie?.includes("synthetic-editor")
        ? "editor"
        : "reviewer",
      csrfToken: "test-only-csrf",
    }),
    requestGuard: (_req: any, session: any) => ({
      sessionId,
      revalidate: async () => {},
      assertSession: async () => {},
    }),
    revalidateInteractiveGrant:
      realAuth.revalidateInteractiveGrant.bind(realAuth),
    assertInteractiveGrant: realAuth.assertInteractiveGrant.bind(realAuth),
  };
  const collaboration = new CollaborationService(
    main.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async () => {
        throw Error("UNCONFIGURED");
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "http://127.0.0.1:5197" },
  );
  const server = createServer(
    createRuntimeHandler({
      pool: main.pool,
      service: runtime,
      auth,
      collaboration,
      origin: "http://127.0.0.1:5197",
      workspaceId: main.workspaceId,
    } as any),
  );
  await new Promise<void>((r) => server.listen(4397, "127.0.0.1", r));
  await writeFile(
    "/private/tmp/akh_c7_browser.json",
    JSON.stringify({
      database: name,
      scenarios,
      startedAt: new Date().toISOString(),
      ...(await sourceHashes()),
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  console.log("Synthetic C7 runtime ready on 4397");
} catch (e) {
  await Promise.all(pools.map((p) => p.end()));
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  throw e;
}
