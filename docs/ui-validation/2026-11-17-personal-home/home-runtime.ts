// Synthetic loopback browser evidence only; never imported by production.
import { sourceHashes } from "./manifest.mjs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture } from "../../../server/test-support";
import { AccessService, authorizeInTransaction } from "../../../server/access";
import { requireRead } from "../../../server/repository";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import { WorkflowService } from "../../../server/workflows/service";
import { JobService } from "../../../server/jobs/service";
import {
  CollaborationService,
  resolveGovernanceResponsibility,
} from "../../../server/collaboration";
if (
  process.env.AKH_C4_SYNTHETIC_CAPTURE !== "1" ||
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
  name = "akh_c4_test_ui_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE "${name}"`);
base.pathname = "/" + name;
process.env.TEST_DATABASE_URL = base.href;
process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
for (const key of Object.keys(process.env))
  if (key.startsWith("AGENT_KNOWLEDGE_HUB_LLM_")) delete process.env[key];
const pools: Pool[] = [];
try {
  const main = await fixture();
  pools.push(main.pool);
  await adoptFixture(main.pool, main.workspaceId);
  const empty = await new AccessService(main.pool).createSpace(
    main.editor,
    "합성 빈 공간",
  );
  const runtime = new RuntimeService(main.pool),
    workflows = new WorkflowService(main.pool, runtime, authorizeInTransaction);
  const jobs = new JobService(main.pool, {
    authorize: async (db, ctx) =>
      authorizeInTransaction(
        db,
        { ...ctx, credentialId: undefined },
        "knowledge.read",
      ),
    resolveIdentity: async (_db, i) => ({ ...i }),
    policyFingerprint: async () => "synthetic-home",
    validateScope: async (db, ctx, input) => {
      for (const id of input.pageIds) await requireRead(db, ctx, "page", id);
      for (const id of input.sourceIds)
        await requireRead(db, ctx, "source", id);
    },
  });
  const scenarios = [];
  for (let n = 0; n < 4; n++) {
    const f = n === 0 ? main : await fixture();
    if (n !== 0) {
      pools.push(f.pool);
      await adoptFixture(f.pool, f.workspaceId);
    }
    for (let i = 0; i < 28; i++)
      await workflows.saveDraft(f.editor, {
        id: `d${String(i).padStart(2, "0")}`,
        expectedRevision: 0,
        title: i === 27 ? "정확한 기존 문서 초안" : "개인 작업 " + i,
        content:
          i === 27 ? "정확한 기존 문서 초안 본문" : "개인 작업 본문 " + i,
        pageId: "topic",
        baseVersion: 1,
      });
    await workflows.saveDraft(f.editor, {
      id: "new-document",
      expectedRevision: 0,
      title: "정확한 신규 문서 초안",
      content: "정확한 신규 문서 본문",
    });
    await workflows.saveDraft(f.ctx, {
      id: "other-owner",
      expectedRevision: 0,
      title: "다른 사람 비공개 초안",
      content: "외부 표시 금지",
      pageId: "topic",
      baseVersion: 1,
    });
    const disclosure = await workflows.manualDisclosures.request(
      f.editor,
      "new-document",
      {
        expectedRevision: 1,
        title: "정확한 신규 문서 초안",
        parentId: null,
        readers: ["editor", "reviewer"],
        reviewerId: "reviewer",
        reason: "초안 공개 범위 검토",
        mutationId: randomUUID(),
      },
    );
    const proposal = await workflows.proposeEdit(f.editor, "topic", {
      baseVersion: 1,
      content: "검토할 새 내용",
      reason: "내용 수정",
    });
    await main.pool.query(
      "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,resource_type,reason) VALUES($1,$2,'editor','topic','page','권한 검토')",
      ["own-access-" + n, f.workspaceId],
    );
    await workflows.favorite(f.editor, "topic", true);
    const input = {
      kind: "lint",
      key: "synthetic-home-failure",
      payload: {},
      pageIds: ["topic"],
      sourceIds: ["source-a"],
      reservation: { tokens: 0, costMicros: 0 },
      timeoutMs: 1000,
      maxAttempts: 1,
    };
    const job = await jobs.enqueue(
      { ...f.editor, credentialId: "synthetic-only" },
      input,
    );
    await main.pool.query(
      "UPDATE durable_jobs SET status='dead',error_code='EXECUTION_FAILED' WHERE id=$1",
      [job.id],
    );
    scenarios.push({
      spaceId: f.workspaceId,
      proposalId: proposal.id,
      disclosureId: disclosure.id,
      jobId: job.id,
    });
  }
  const auth = {
    authenticate: async (req: any) => ({
      workspaceId: req.headers["x-space-id"] ?? main.workspaceId,
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
    { applicationOrigin: "http://127.0.0.1:5194" },
  );
  const server = createServer(
    createRuntimeHandler({
      pool: main.pool,
      service: runtime,
      origin: "http://127.0.0.1:5194",
      workspaceId: main.workspaceId,
      auth,
      collaboration,
      jobs: { jobs, readiness: () => ({ serviceDirectoryConfigured: false }) },
    } as any),
  );
  await new Promise<void>((r) => server.listen(4394, "127.0.0.1", r));
  await writeFile(
    "/private/tmp/akh_c4_browser.json",
    JSON.stringify({
      database: name,
      emptySpace: empty.id,
      scenarios,
      startedAt: new Date().toISOString(),
      ...(await sourceHashes()),
    }),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  console.log("Synthetic C4 runtime ready on4394");
} catch (e) {
  await Promise.all(pools.map((p) => p.end()));
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  throw e;
}
