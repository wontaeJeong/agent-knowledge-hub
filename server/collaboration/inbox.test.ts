import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
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
  const inbox = (service as any).inbox;
  expect(inbox, "canonical personal inbox").toBeDefined();
  return { ...f, service, inbox };
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function notice(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  principal = "reader",
  db: any = f.pool,
) {
  await db.query(
    "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data) VALUES($1,$2,$3,'topic',1,'publication','{}') ON CONFLICT DO NOTHING",
    [f.workspaceId, id, principal],
  );
}
test("duplicate events get one recipient sequence with actor separation", async () => {
  const f = await setup();
  await notice(f, "one");
  await notice(f, "one");
  await notice(f, "editor-only", "editor");
  const r = await f.inbox.list(f.reader, {});
  expect(r.items.map((x: any) => [x.id, x.sequence, x.type, x.target])).toEqual(
    [["one", 1, "document-updated", { kind: "document", pageId: "topic" }]],
  );
  expect(r.unreadCount).toBe(1);
  expect(r.items[0].revision).toBe(1);
});
test("pending creation and delayed delivery cannot cross committed read boundary", async () => {
  const f = await setup();
  await notice(f, "before");
  const seen = await f.inbox.list(f.reader, {});
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await notice(f, "pending", "reader", db);
    const mark = f.inbox.readAll(f.reader, {
      boundary: seen.readBoundary,
      mutationId: "read-one",
    });
    await db.query("COMMIT");
    expect(await mark).toEqual({ updated: 1 });
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  await notice(f, "delayed");
  expect(
    (await f.inbox.list(f.reader, { state: "unread" })).items.map(
      (x: any) => x.id,
    ),
  ).toEqual(["delayed", "pending"]);
});
test("explicit unread survives old boundary replay and stale-tab state CAS fails", async () => {
  const f = await setup();
  await notice(f, "one");
  const seen = await f.inbox.list(f.reader, {});
  const mark = { boundary: seen.readBoundary, mutationId: "bulk-one" };
  expect(await f.inbox.readAll(f.reader, mark)).toEqual({ updated: 1 });
  expect((await f.inbox.list(f.reader, {})).items[0].revision).toBe(2);
  const mutation = {
    read: false,
    expectedRevision: 2,
    mutationId: "unread-one",
  };
  expect((await f.inbox.setState(f.reader, "one", mutation)).revision).toBe(3);
  expect((await f.inbox.setState(f.reader, "one", mutation)).revision).toBe(3);
  await expect(
    f.inbox.setState(f.reader, "one", {
      read: true,
      expectedRevision: 2,
      mutationId: "stale-tab",
    }),
  ).rejects.toThrow("STALE_VERSION");
  await expect(
    f.inbox.setState(f.reader, "one", { ...mutation, read: true }),
  ).rejects.toThrow("MUTATION_CONFLICT");
  expect(await f.inbox.readAll(f.reader, mark)).toEqual({ updated: 1 });
  expect(
    await f.inbox.readAll(f.reader, {
      ...mark,
      mutationId: "old-boundary-new-mutation",
    }),
  ).toEqual({ updated: 0 });
  expect(
    (await f.inbox.list(f.reader, { state: "unread" })).items,
  ).toHaveLength(1);
});
test("archive and restore preserve read state and visible counts", async () => {
  const f = await setup();
  await notice(f, "one");
  const archived = await f.inbox.setState(f.reader, "one", {
    archived: true,
    expectedRevision: 1,
    mutationId: "archive",
  });
  expect(archived.readAt).toBeNull();
  expect(archived.archivedAt).not.toBeNull();
  expect((await f.inbox.list(f.reader, {})).unreadCount).toBe(0);
  expect(
    (await f.inbox.list(f.reader, { state: "archived" })).items,
  ).toHaveLength(1);
  await f.inbox.setState(f.reader, "one", {
    archived: false,
    expectedRevision: 2,
    mutationId: "restore",
  });
  expect(
    (await f.inbox.list(f.reader, { state: "unread" })).items,
  ).toHaveLength(1);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect(await f.inbox.list(f.reader, {})).toMatchObject({
    items: [],
    unreadCount: 0,
  });
  await expect(
    f.inbox.setState(f.reader, "one", {
      read: true,
      expectedRevision: 3,
      mutationId: "revoked",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
test("signed boundary binds actor and pagination binds current visibility", async () => {
  const f = await setup();
  for (let n = 0; n < 27; n++) await notice(f, `n${n}`);
  const first = await f.inbox.list(f.reader, {});
  expect(first.items).toHaveLength(25);
  expect(first.unreadCount).toBe(27);
  expect(
    (await f.inbox.list(f.reader, { cursor: first.nextCursor })).items.map(
      (x: any) => x.id,
    ),
  ).toEqual(["n1", "n0"]);
  expect((await f.inbox.list(f.reader, { limit: 5 })).items).toHaveLength(5);
  await expect(
    f.inbox.readAll(f.editor, {
      boundary: first.readBoundary,
      mutationId: "foreign",
    }),
  ).rejects.toThrow("INVALID_BOUNDARY");
  await expect(
    f.inbox.readAll(f.reader, {
      boundary: first.readBoundary + "x",
      mutationId: "forged",
    }),
  ).rejects.toThrow("INVALID_BOUNDARY");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.inbox.list(f.reader, { cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
});
test("session revoked after computation prevents protected disclosure", async () => {
  const f = await setup();
  await notice(f, "one");
  let validations = 0;
  const ctx = {
    ...f.reader,
    authorization: {
      revalidate: async () => {
        if (++validations === 2) throw Error("UNAUTHENTICATED");
      },
      assertSession: async () => {},
    },
  };
  await expect(f.inbox.list(ctx, {})).rejects.toThrow("UNAUTHENTICATED");
});
test("job success outbox delivers without page and source revocation removes badge", async () => {
  const f = await setup();
  await f.pool.query(
    `INSERT INTO durable_jobs(id,workspace_id,principal_id,credential_id,kind,lane,idempotency_key,body_hash,input,envelope,policy_hash,max_attempts,timeout_ms,available_at,created_at,updated_at,budget_day,reserved_tokens,reserved_cost_micros,status) VALUES('inbox-job',$1,'editor','fixture','lint','maintenance','inbox-success','fixture',$2,$3,'fixture',1,1000,now(),now(),now(),current_date,0,0,'succeeded')`,
    [
      f.workspaceId,
      { pageIds: [], sourceIds: ["source-a"] },
      { pageIds: [], sourceIds: ["source-a"] },
    ],
  );
  await f.service.scanEvents();
  await f.service.scanEvents();
  const result = await f.inbox.list(f.editor, {});
  expect(result.items.map((i: any) => [i.type, i.target])).toEqual([
    ["job-succeeded", { kind: "job", id: "inbox-job" }],
  ]);
  expect((await f.inbox.list(f.reader, {})).items).toEqual([]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await f.inbox.list(f.editor, {})).unreadCount).toBe(0);
});
test("rejected changeset outcome remains owner-readable but never grants reviewer authority", async () => {
  const f = await setup();
  const { RuntimeService } = await import("../runtime/knowledge");
  const { KnowledgeService } = await import("../service");
  const runtime = new RuntimeService(f.pool),
    core = new KnowledgeService(f.pool);
  const batch = await core.propose(
    f.editor,
    [
      {
        id: "topic",
        title: "검토 대상",
        summary: "요약",
        content: "변경",
        sourceIds: ["source-a"],
        baseVersion: 1,
        scope: "team",
        links: [],
        facts: [],
      },
    ],
    ["source-a"],
  );
  await runtime.reject(f.ctx, batch.id, batch.hash, "수정 필요");
  expect(typeof (runtime as any).changeset).toBe("function");
  expect(await (runtime as any).changeset(f.editor, batch.id)).toMatchObject({
    id: batch.id,
    status: "rejected",
    reviewFeedback: { reason: "수정 필요" },
    readOnly: true,
  });
  await expect(
    (runtime as any).changeset(f.reader, batch.id),
  ).rejects.toThrow();
  await f.service.scanEvents();
  expect(
    (await f.inbox.list(f.editor, {})).items.map((i: any) => [
      i.type,
      i.target,
    ]),
  ).toEqual([["review-decided", { kind: "review", id: batch.id }]]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(
    (runtime as any).changeset(f.editor, batch.id),
  ).rejects.toThrow();
  expect((await f.inbox.list(f.editor, {})).unreadCount).toBe(0);
});
test("non-admin applicant can read own access decision without hidden document title or reason", async () => {
  const f = await setup();
  const { GovernanceService } = await import("../workflows/governance/service");
  const governance = new GovernanceService(
    f.pool,
    authorizeInTransaction as any,
  );
  await f.pool.query(
    "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,resource_type,reason,status,revision,decision_reason) VALUES('own-access',$1,'reader','hidden-page','page','request','rejected',2,'private decision detail')",
    [f.workspaceId],
  );
  expect(typeof (governance as any).accessRequest).toBe("function");
  const own = await (governance as any).accessRequest(f.reader, "own-access");
  expect(own).toMatchObject({
    id: "own-access",
    status: "rejected",
    readOnly: true,
  });
  expect(JSON.stringify(own)).not.toContain("hidden-page");
  expect(JSON.stringify(own)).not.toContain("private decision detail");
  await expect(
    (governance as any).accessRequest(f.editor, "own-access"),
  ).rejects.toThrow();
  await f.service.scanEvents();
  expect(
    (await f.inbox.list(f.reader, {})).items.map((i: any) => [
      i.title,
      i.type,
      i.target,
    ]),
  ).toEqual([
    [
      "접근 요청 결정",
      "access-decided",
      { kind: "access-request", id: "own-access" },
    ],
  ]);
});
test("configured metadata pruning keeps legal-held workspaces and does not reset recipient sequence", async () => {
  const f = await setup();
  await notice(f, "old");
  await f.pool.query(
    "UPDATE workflow_notifications SET created_at=now()-interval '91 days' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect(typeof (f.service as any).pruneInbox).toBe("function");
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','workspace',$1,'fixture-owner')",
    [f.workspaceId],
  );
  expect(await (f.service as any).pruneInbox()).toBe(0);
  await f.pool.query(
    "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect(await (f.service as any).pruneInbox()).toBe(1);
  await notice(f, "new");
  expect((await f.inbox.list(f.reader, {})).items[0].sequence).toBe(2);
});
test("new inbox control tables are classified by retention and outcome event erasure follows source lineage", async () => {
  const f = await setup();
  await notice(f, "one");
  await f.inbox.setState(f.reader, "one", {
    read: true,
    expectedRevision: 1,
    mutationId: "read",
  });
  const { inventory } = await import("../retention/inventory");
  const db = await f.pool.connect();
  try {
    await expect(inventory(db, f.workspaceId)).resolves.toBeDefined();
  } finally {
    db.release();
  }
  const { selectErasureRows } = await import("../operations/erasure");
  const rows: any[] = [
    {
      table: "durable_jobs",
      locator: "(0,1)",
      data: { id: "job", input: { sourceIds: ["source"] } },
    },
    {
      table: "collaboration_events",
      locator: "(0,2)",
      data: { id: "success:job:1", kind: "job-success", resource_id: "job" },
    },
    {
      table: "workflow_notifications",
      locator: "(0,3)",
      data: { id: "notice", data: { eventId: "success:job:1" } },
    },
  ];
  expect(
    selectErasureRows(rows, { kind: "source", id: "source" }).map(
      (r) => r.table,
    ),
  ).toEqual(["durable_jobs", "collaboration_events", "workflow_notifications"]);
});
test("real delayed publication outbox arrives unread after an earlier read-all", async () => {
  const f = await setup();
  const { KnowledgeService } = await import("../service");
  const core = new KnowledgeService(f.pool);
  await f.service.subscribe(f.reader, { scope: "space", enabled: true });
  const seen = await f.inbox.list(f.reader, {});
  const batch = await core.propose(
    f.editor,
    [
      {
        id: "topic",
        title: "발행 대상",
        summary: "요약",
        content: "변경",
        sourceIds: ["source-a"],
        baseVersion: 1,
        scope: "team",
        links: [],
        facts: [],
      },
    ],
    ["source-a"],
  );
  await core.approve(f.ctx, batch.id, batch.hash);
  await core.publish(f.ctx, batch.id, batch.hash, "delayed-publication");
  expect(
    await f.inbox.readAll(f.reader, {
      boundary: seen.readBoundary,
      mutationId: "before-delivery",
    }),
  ).toEqual({ updated: 0 });
  await f.service.scanEvents();
  await f.service.scanEvents();
  const page = await f.inbox.list(f.reader, { state: "unread" });
  expect(page.items.map((i: any) => [i.type, i.target])).toEqual([
    ["document-updated", { kind: "document", pageId: "topic" }],
  ]);
  expect(page.unreadCount).toBe(1);
});
test("actual mention and subscription comment recipients have distinct types and exact comment target", async () => {
  const f = await setup();
  const { WorkflowService } = await import("../workflows/service");
  const { RuntimeService } = await import("../runtime/knowledge");
  const workflow = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  await f.service.subscribe(f.ctx, { scope: "space", enabled: true });
  const comment = await workflow.addComment(f.editor, "topic", {
    version: 1,
    content: "검토 확인",
    mentions: ["reader"],
  });
  const mention = (await f.inbox.list(f.reader, {})).items[0],
    subscribed = (await f.inbox.list(f.ctx, {})).items[0];
  expect(mention.type).toBe("mention");
  expect(subscribed.type).toBe("document-updated");
  expect(mention.target).toEqual({
    kind: "comment",
    pageId: "topic",
    commentId: comment.id,
  });
  expect(subscribed.target).toEqual(mention.target);
});
test("document ancestor revocation removes inbox metadata and counts", async () => {
  const f = await setup();
  await notice(f, "child");
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','hidden-parent')",
    [f.workspaceId],
  );
  expect(await f.inbox.list(f.reader, {})).toMatchObject({
    items: [],
    unreadCount: 0,
  });
});
test("configured signing key survives restart while receipt replay rechecks current visibility", async () => {
  const f = await setup();
  const make = () =>
    new CollaborationService(f.pool, f.service.hooks, {
      applicationOrigin: "https://knowledge.example.test",
      inboxSigningKey: "test-only-inbox-signing-key-32-characters",
    } as any);
  const first = (make() as any).inbox;
  await notice(f, "one");
  const seen = await first.list(f.reader, {});
  const mutation = { boundary: seen.readBoundary, mutationId: "restart-read" };
  expect(await first.readAll(f.reader, mutation)).toEqual({ updated: 1 });
  const restarted = (make() as any).inbox;
  expect(await restarted.readAll(f.reader, mutation)).toEqual({ updated: 1 });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(restarted.readAll(f.reader, mutation)).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("ephemeral signing restart rejects the old boundary without marking new inbox state", async () => {
  const f = await setup();
  await notice(f, "one");
  const seen = await f.inbox.list(f.reader, {});
  const restarted = new CollaborationService(f.pool, f.service.hooks, {
    applicationOrigin: "https://knowledge.example.test",
  });
  await expect(
    (restarted as any).inbox.readAll(f.reader, {
      boundary: seen.readBoundary,
      mutationId: "expired-process",
    }),
  ).rejects.toThrow("INVALID_BOUNDARY");
  expect(
    (await (restarted as any).inbox.list(f.reader, { state: "unread" })).items,
  ).toHaveLength(1);
});
test("pagination cursor changes when an authorized source revision changes", async () => {
  const f = await setup();
  await notice(f, "one");
  await notice(f, "two");
  const first = await f.inbox.list(f.reader, { limit: 1 });
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}','\"정정된 원문\"') WHERE workspace_id=$1 AND id='source-a'",
    [f.workspaceId],
  );
  await expect(
    f.inbox.list(f.reader, { limit: 1, cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
});
