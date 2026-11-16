import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../test-support";
import { KnowledgeService } from "../service";
import { authorizeInTransaction } from "../access";
import { CollaborationService, resolveGovernanceResponsibility } from "./index";
const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async () => {
        throw Error("UNCONFIGURED");
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  return { ...f, service, core: new KnowledgeService(f.pool) };
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function propose(f: Awaited<ReturnType<typeof setup>>) {
  return f.core.propose(
    f.editor,
    [
      {
        id: "topic",
        title: page.title,
        summary: page.summary,
        content: "更新内容",
        sourceIds: ["source-a"],
        baseVersion: 1,
        scope: "team",
        links: [],
        facts: [],
      },
    ],
    ["source-a"],
  );
}
test("topic and space subscriptions are idempotent and expose only currently readable categories", async () => {
  const f = await setup();
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: true,
  });
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: true,
  });
  await f.service.subscribe(f.reader, { scope: "space", enabled: true });
  expect((await f.service.subscriptions(f.reader)).items).toHaveLength(2);
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: false,
  });
  expect((await f.service.subscriptions(f.reader)).items).toHaveLength(1);
  await expect(
    f.service.subscribe(f.reader, {
      scope: "topic",
      target: "unknown",
      enabled: true,
    }),
  ).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect((await f.service.subscriptions(f.reader)).topics).toEqual([]);
});
test("canonical proposals and publication produce deduplicated events with current subscription and full-source revalidation", async () => {
  const f = await setup();
  await f.service.subscribe(f.ctx, { scope: "space", enabled: true });
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: true,
  });
  const b = await propose(f);
  await f.service.scanEvents();
  await f.service.scanEvents();
  expect(
    (await f.service.notifications(f.ctx)).items
      .flatMap((i) => i.events)
      .map((e) => e.kind),
  ).toEqual(["change-review-request"]);
  expect((await f.service.notifications(f.reader)).items).toEqual([]);
  await f.core.approve(f.ctx, b.id, b.hash);
  await f.core.publish(f.ctx, b.id, b.hash, "pub-event");
  await f.service.scanEvents();
  await f.service.scanEvents();
  expect(
    (await f.service.notifications(f.reader)).items
      .flatMap((i) => i.events)
      .map((e) => e.kind),
  ).toEqual(["publication"]);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{category}','\"changed\"') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  expect((await f.service.notifications(f.reader)).items).toEqual([]);
  await f.service.subscribe(f.reader, { scope: "space", enabled: true });
  expect((await f.service.notifications(f.reader)).items).toHaveLength(1);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect((await f.service.notifications(f.reader)).items).toEqual([]);
});
test("expiry emits once per validity setting and becomes ineligible when extended", async () => {
  const f = await setup();
  await f.service.subscribe(f.reader, { scope: "space", enabled: true });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [f.workspaceId, { effectiveUntil: "2020-01-01T00:00:00Z" }],
  );
  await f.service.scanEvents();
  await f.service.scanEvents();
  const notices = (await f.service.notifications(f.reader)).items.flatMap(
    (i) => i.events,
  );
  expect(notices.map((e) => e.kind)).toEqual(["expiry"]);
  await f.service.processNotification(f.reader, notices[0].id);
  expect(
    (await f.service.notifications(f.reader)).items[0].events[0].processed,
  ).toBe(true);
  await f.pool.query(
    "UPDATE workflow_document_state SET data=$2,revision=revision+1 WHERE workspace_id=$1 AND page_id='topic'",
    [f.workspaceId, { effectiveUntil: "2099-01-01T00:00:00Z" }],
  );
  expect((await f.service.notifications(f.reader)).items).toEqual([]);
});
test("failed jobs notify only the explicit human owner and gate every input source before displaying metadata", async () => {
  const f = await setup();
  await f.pool.query(
    `INSERT INTO durable_jobs(id,workspace_id,principal_id,credential_id,kind,lane,idempotency_key,body_hash,input,envelope,policy_hash,max_attempts,timeout_ms,available_at,created_at,updated_at,budget_day,reserved_tokens,reserved_cost_micros,status,error_code) VALUES('failed-job',$1,'editor','fixture','lint','maintenance','failure','fixture',$2,$3,'fixture',1,1000,now(),now(),now(),current_date,0,0,'dead','MODEL_UNAVAILABLE')`,
    [
      f.workspaceId,
      { pageIds: ["topic"], sourceIds: ["source-a"] },
      { pageIds: ["topic"], sourceIds: ["source-a"] },
    ],
  );
  await f.service.scanEvents();
  await f.service.scanEvents();
  const item = (await f.service.notifications(f.editor)).items[0];
  expect(item.events[0].kind).toBe("job-failure");
  expect(item.url).toContain("jobs");
  expect((await f.service.notifications(f.ctx)).items).toEqual([]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await f.service.notifications(f.editor)).items).toEqual([]);
});
test("topic comments join the existing notification flow and unsubscribe suppresses the digest content", async () => {
  const f = await setup();
  const { WorkflowService } = await import("../workflows/service");
  const { RuntimeService } = await import("../runtime/knowledge");
  const workflow = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: true,
  });
  await workflow.addComment(f.editor, "topic", {
    version: 1,
    content: "synthetic comment",
  });
  expect((await f.service.notifications(f.reader)).items).toHaveLength(1);
  await f.pool.query(
    "UPDATE workflow_notifications SET created_at=now()-interval '2 minutes' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect((await f.service.previewDigest(f.reader, "daily")).items).toHaveLength(
    1,
  );
  await f.service.subscribe(f.reader, {
    scope: "topic",
    target: page.category,
    enabled: false,
  });
  expect((await f.service.previewDigest(f.reader, "daily")).items).toEqual([]);
});
test("an unsubscribed projected event and a now-stale review are removed before digest rendering", async () => {
  const f = await setup();
  await f.service.subscribe(f.ctx, { scope: "space", enabled: true });
  const b = await propose(f);
  await f.service.scanEvents();
  await f.pool.query(
    "UPDATE workflow_notifications SET created_at=now()-interval '2 minutes' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect((await f.service.previewDigest(f.ctx, "weekly")).items).toHaveLength(
    1,
  );
  await f.service.subscribe(f.ctx, { scope: "space", enabled: false });
  expect((await f.service.previewDigest(f.ctx, "weekly")).items).toEqual([]);
  await f.service.subscribe(f.ctx, { scope: "space", enabled: true });
  await f.pool.query(
    "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, b.id],
  );
  expect((await f.service.previewDigest(f.ctx, "weekly")).items).toEqual([]);
});
test("a projected expiry loses all digest content when a source is revoked at the final delivery gate", async () => {
  const f = await setup();
  let now = new Date("2030-01-01T08:00:00Z");
  let finalized: unknown = "not-called";
  const service = new CollaborationService(
    f.pool,
    {
      ...f.service.hooks,
      verifyRecipient: async ({ workspaceId, principalId }) => ({
        ctx: { workspaceId, principalId },
        address: "synthetic@example.test",
        issuer: "fixture",
        subject: principalId,
        verifiedAt: now.toISOString(),
        validUntil: new Date(+now + 20000).toISOString(),
        assertCurrent: async () => {},
      }),
    },
    {
      applicationOrigin: "https://knowledge.example.test",
      clock: () => now,
      gateway: {
        status: async () => null,
        send: async ({ finalize }) => {
          await f.pool.query(
            "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
            [f.workspaceId],
          );
          finalized = await finalize();
          return null;
        },
      },
    },
  );
  await service.preferences(f.reader, {
    expectedRevision: 0,
    dailyDigest: true,
  });
  await service.syncPlans();
  await service.subscribe(f.reader, { scope: "space", enabled: true });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [f.workspaceId, { effectiveUntil: "2030-01-01T08:20:00Z" }],
  );
  now = new Date("2030-01-01T08:30:00Z");
  await service.scanEvents();
  now = new Date("2030-01-01T09:01:00Z");
  await service.planDigests();
  const lease = await service.claim("synthetic-worker");
  expect(lease).toBeTruthy();
  await service.runDigest(lease!, new AbortController().signal);
  expect(finalized).toBeNull();
  expect((await service.notifications(f.reader)).items).toEqual([]);
});
test("DB event ordering retains sub-millisecond subscription precision", async () => {
  const f = await setup();
  await f.service.subscribe(f.reader, { scope: "space", enabled: true });
  await f.pool.query(
    "UPDATE collaboration_subscriptions SET created_at='2026-11-16T01:00:00.123100Z' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO collaboration_events(workspace_id,id,kind,page_id,version,resource_id,revision,created_at) VALUES($1,'precision','publication','topic',1,'synthetic-publication','1','2026-11-16T01:00:00.123200Z')",
    [f.workspaceId],
  );
  await f.service.scanEvents();
  expect((await f.service.notifications(f.reader)).items).toHaveLength(1);
});
test("topic discovery obeys resource authorization in addition to reader ACLs", async () => {
  const f = await setup();
  const service = new CollaborationService(
    f.pool,
    {
      ...f.service.hooks,
      authorize: async (db, ctx, action, resource) => {
        if (resource?.kind === "source") throw Error("NOT_FOUND");
        await authorizeInTransaction(db, ctx, action);
      },
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  expect((await service.subscriptions(f.reader)).topics).toEqual([]);
});
