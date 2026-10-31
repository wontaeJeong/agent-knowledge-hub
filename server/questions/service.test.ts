import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeActionDb } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { QuestionsService } from "./service";
import { transaction } from "../database";
import type { Pool } from "pg";
import type { RuntimeExecution } from "../runtime/knowledge";
import { capturePublishedVersionMetadata } from "../workflows/versions/metadata";
const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const authorization = {
    revalidate: async () => {},
    assertSession: async () => {},
  };
  const runtime = new RuntimeService(f.pool);
  const service = new QuestionsService(f.pool, {
    authorize: async (...args) => {
      await authorizeActionDb(...args);
    },
    runtime,
    runQuery: async () => {
      throw Error("REAL_RUNTIME_CONTEXT_NOT_YET_WIRED");
    },
  });
  return {
    ...f,
    reader: { ...f.reader, authorization },
    ctx: { ...f.ctx, authorization },
    service,
    runtime,
  };
}

test("private durable thread admission CAS, nonce replay and orphan enqueue retry", async () => {
  const f = await setup();
  const thread = await f.service.createThread(f.reader);
  const input = {
    expectedRevision: 0,
    nonce: "accepted-once",
    question: "기존 내용",
    mode: "offline",
  };
  const accepted = await f.service.acceptTurn(f.reader, thread.id, input);
  expect(accepted).toMatchObject({
    threadId: thread.id,
    revision: 1,
    status: "pending",
  });
  expect(await f.service.acceptTurn(f.reader, thread.id, input)).toEqual(
    accepted,
  );
  await expect(
    f.service.acceptTurn(f.reader, thread.id, { ...input, nonce: "other" }),
  ).rejects.toThrow("STALE_VERSION");
  await expect(f.service.readThread(f.ctx, thread.id)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect((await f.service.listThreads(f.ctx)).items).toEqual([]);
  const adapter = f.service.questionJobAdapter();
  const prepared = await transaction(f.pool, f.workspaceId, (db) =>
    adapter.prepare(db, f.reader, {
      threadId: thread.id,
      turnId: accepted.turnId,
    }),
  );
  expect(JSON.stringify(prepared.payload)).not.toContain("기존 내용");
  let submitted = 0;
  f.service.setSubmit(async (_ctx, payload, key) => {
    submitted++;
    expect(payload).toEqual({ threadId: thread.id, turnId: accepted.turnId });
    expect(key).toBe(`question:${accepted.turnId}`);
    return { id: "durable-job", status: "queued" };
  });
  expect(
    await f.service.resumeTurn(f.reader, thread.id, accepted.turnId),
  ).toMatchObject({ id: "durable-job", status: "queued" });
  expect(submitted).toBe(1);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    transaction(f.pool, f.workspaceId, (db) =>
      adapter.prepare(db, f.reader, prepared.payload),
    ),
  ).rejects.toThrow("STALE_VERSION");
  const read = await f.service.readThread(f.reader, thread.id);
  expect(read.turns).toEqual([]);
  expect(read.contextOmitted).toBe(true);
  expect(JSON.stringify(read)).not.toContain("기존 내용");
});

test("historical search reads actual old body, reports unknown metadata and binds cursors to filters and ACL", async () => {
  const f = await setup();
  await f.pool.query("INSERT INTO versions VALUES($1,$2,2,$3)", [
    f.workspaceId,
    "topic",
    {
      id: "v2",
      number: 2,
      content: "현재 권고 내용",
      author: "editor",
      reason: "new",
      at: "2026-10-30T00:00:00Z",
      sourceIds: ["source-a"],
    },
  ]);
  expect(
    (await f.service.search(f.reader, { query: "기존", historical: false }))
      .items,
  ).toEqual([]);
  const old = await f.service.search(f.reader, {
    query: "기존",
    historical: true,
  });
  expect(old.items).toHaveLength(1);
  expect(old.items[0]).toMatchObject({
    pageId: "topic",
    version: 1,
    content: "기존 내용",
    historical: true,
    currentRecommendation: false,
    metadataStatus: "unknown",
  });
  expect(old.items[0].title).toBeNull();
  const all = await f.service.search(f.reader, { historical: true, limit: 1 });
  expect(all.nextCursor).toBeTruthy();
  const next = await f.service.search(f.reader, {
    historical: true,
    limit: 1,
    cursor: all.nextCursor,
  });
  expect(next.items[0].version).not.toBe(all.items[0].version);
  await expect(
    f.service.search(f.reader, {
      query: "changed",
      historical: true,
      limit: 1,
      cursor: all.nextCursor,
    }),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    f.service.search(f.ctx, {
      historical: true,
      limit: 1,
      cursor: all.nextCursor,
    }),
  ).rejects.toThrow("STALE_CURSOR");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.service.search(f.reader, {
      historical: true,
      limit: 1,
      cursor: all.nextCursor,
    }),
  ).rejects.toThrow("STALE_CURSOR");
  expect(
    (await f.service.search(f.reader, { historical: true })).items,
  ).toEqual([]);
});

test("feedback binds actual answer/version and page versions, routes active business responsibility only and remains an unverified claim", async () => {
  const f = await setup();
  const answer = await f.runtime.query(f.reader, "기존", "offline");
  await f.pool.query(
    "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,$2,1,$3,$4)",
    [f.workspaceId, "topic", "editor", "reviewer"],
  );
  const input = {
    answerId: answer.id,
    version: 1,
    nonce: "report1",
    category: "incorrect",
    reason: "조건이 누락되었습니다.",
  };
  const result = await f.service.reportFeedback(f.reader, input);
  expect(result).toMatchObject({
    answerId: answer.id,
    version: 1,
    claim: true,
    verified: false,
    work: [
      {
        pageId: "topic",
        version: 1,
        recipientIds: ["editor"],
        status: "pending",
      },
    ],
  });
  expect(await f.service.reportFeedback(f.reader, input)).toEqual(result);
  await expect(
    f.service.reportFeedback(f.reader, { ...input, reason: "changed" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    f.service.reportFeedback(f.reader, {
      ...input,
      nonce: "wrong-version",
      version: 2,
    }),
  ).rejects.toThrow();
  await expect(
    f.service.reportFeedback(f.ctx, { ...input, nonce: "stolen" }),
  ).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "UPDATE access_principals SET active=false WHERE id='editor'",
  );
  const disabled = await f.service.reportFeedback(f.reader, {
    ...input,
    nonce: "report-disabled-owner",
  });
  expect(disabled.work[0]).toMatchObject({
    recipientIds: [],
    status: "pending-unassigned",
  });
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM question_feedback WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("2");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.service.reportFeedback(f.reader, { ...input, nonce: "revoked" }),
  ).rejects.toThrow();
  expect((await f.service.feedback(f.reader)).items).toEqual([]);
  // Restore global fixture principal for other workspaces/tests.
  await f.pool.query(
    "UPDATE access_principals SET active=true WHERE id='editor'",
  );
});

test("concurrent admissions have exactly one CAS winner and reject forged grants or another owner turn", async () => {
  const f = await setup();
  const t = await f.service.createThread(f.reader);
  const input = { expectedRevision: 0, question: "기존", mode: "offline" };
  const results = await Promise.allSettled([
    f.service.acceptTurn(f.reader, t.id, { ...input, nonce: "a" }),
    f.service.acceptTurn(f.reader, t.id, { ...input, nonce: "b" }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.message,
  ).toBe("STALE_VERSION");
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM question_turns WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("1");
  await expect(
    f.service.acceptTurn(f.reader, t.id, {
      ...input,
      nonce: "bad",
      principalId: "editor",
    }),
  ).rejects.toThrow();
  const winner = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
      turnId: string;
    }>
  ).value;
  await expect(
    transaction(f.pool, f.workspaceId, (db) =>
      f.service
        .questionJobAdapter()
        .prepare(db, f.ctx, { threadId: t.id, turnId: winner.turnId }),
    ),
  ).rejects.toThrow("NOT_FOUND");
});

test("trusted adapter contract omits revoked prior raw question and rejects changed sealed inputs before invoking runner (not runtime end-to-end evidence)", async () => {
  const f = await setup();
  const t = await f.service.createThread(f.reader);
  const first = await f.service.acceptTurn(f.reader, t.id, {
    expectedRevision: 0,
    nonce: "one",
    question: "기존 USER_PROTECTED_QUOTE",
    mode: "offline",
  });
  // A historical fixture with an ACTUAL RuntimeService-produced answer, not a made-up answer ID.
  const answer = await f.runtime.query(
    f.reader,
    "기존 USER_PROTECTED_QUOTE",
    "offline",
  );
  await f.pool.query(
    "UPDATE question_turns SET status='completed',answer_id=$3,answer_version=1 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, first.turnId, answer.id],
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const next = await f.service.acceptTurn(f.reader, t.id, {
    expectedRevision: 1,
    nonce: "two",
    question: "새로운 질문",
    mode: "model",
  });
  expect(next.contextOmitted).toBe(true);
  let invoked = 0;
  let modelInput: unknown;
  const contract = new QuestionsService(f.pool, {
    runtime: f.runtime,
    authorize: async (...a) => {
      await authorizeActionDb(...a);
    },
    runQuery: async (ctx, question, _mode, _execution, context) => {
      invoked++;
      modelInput = await transaction(f.pool, f.workspaceId, async (db) => ({
        question,
        ...(await context.resolve(db, (await f.runtime.view(db, ctx)).state)),
      }));
      throw Error("INSPECTED_CONTEXT");
    },
  });
  const adapter = contract.questionJobAdapter();
  const prepared = await transaction(f.pool, f.workspaceId, (db) =>
    adapter.prepare(db, f.reader, { threadId: t.id, turnId: next.turnId }),
  );
  await expect(
    adapter.execute(f.reader, prepared.payload, {} as RuntimeExecution),
  ).rejects.toThrow("INSPECTED_CONTEXT");
  expect(invoked).toBe(1);
  expect(JSON.stringify(modelInput)).not.toContain("USER_PROTECTED_QUOTE");
  expect(modelInput).toMatchObject({
    messages: [],
    pageIds: [],
    sourceIds: [],
  });
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a','reader')",
    [f.workspaceId],
  );
  // Read permission and source input changed since admission: no silently expanded context.
  // Empty previously admitted context must not include newly allowed sources.
  const visible = (await contract.readThread(f.reader, t.id)).turns;
  expect(visible).toHaveLength(2);
  // The seal intentionally contains no newly allowed sources; queue selects only admitted inputs.
  const thirdThread = await contract.createThread(f.reader);
  const third = await contract.acceptTurn(f.reader, thirdThread.id, {
    expectedRevision: 0,
    nonce: "three",
    question: "기존",
    mode: "model",
  });
  const sealed = await transaction(f.pool, f.workspaceId, (db) =>
    adapter.prepare(db, f.reader, {
      threadId: thirdThread.id,
      turnId: third.turnId,
    }),
  );
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed source\"') WHERE workspace_id=$1 AND id='source-a'",
    [f.workspaceId],
  );
  await expect(
    adapter.execute(f.reader, sealed.payload, {} as RuntimeExecution),
  ).rejects.toThrow("STALE_VERSION");
  expect(invoked).toBe(1);
});

test("combined current filters use actual workflow/business metadata and literal long text, with no unapproved filter keys", async () => {
  const f = await setup();
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId, { tags: ["postgres", "production"], category: "runbook" }],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','archived',$2)",
    [
      f.workspaceId,
      {
        properties: { project: "checkout", environment: "Ubuntu" },
        reviewDue: "2026-11-03T00:00:00Z",
      },
    ],
  );
  await f.pool.query(
    "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
    [f.workspaceId],
  );
  const filters = {
    query: "기존",
    type: "runbook",
    businessOwner: "editor",
    tags: ["postgres", "production"],
    state: "archived",
    reviewDateFrom: "2026-11-01T00:00:00.000Z",
    reviewDateTo: "2026-11-05T00:00:00.000Z",
    periodFrom: "2026-10-01T00:00:00.000Z",
    periodTo: "2026-10-30T00:00:00.000Z",
    project: "checkout",
    environment: "Ubuntu",
    archived: true,
  };
  expect((await f.service.search(f.reader, filters)).items).toHaveLength(1);
  for (const wrong of [
    { tags: ["not-present"] },
    { businessOwner: "reader" },
    { environment: "Windows" },
    { archived: false },
    { project: "other" },
  ])
    expect(
      (await f.service.search(f.reader, { ...filters, ...wrong })).items,
    ).toEqual([]);
  expect(
    (await f.service.search(f.reader, { query: "%'; DROP TABLE pages; --" }))
      .items,
  ).toEqual([]);
  await expect(
    f.service.search(f.reader, { query: "기존", rawSQL: "true" }),
  ).rejects.toThrow();
  expect(
    (await f.service.search(f.reader, { historical: true, type: "runbook" }))
      .items,
  ).toEqual([]);
});

test("migration103 snapshots search actual historical title/type/tags/environment without copying current metadata or current business owner", async () => {
  const f = await setup();
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='topic'",
    [
      f.workspaceId,
      { title: "이전 제목", category: "old-type", tags: ["old-tag"] },
    ],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [
      f.workspaceId,
      {
        properties: { environment: "old-env", project: "old-project" },
        reviewDue: "2026-10-01T00:00:00Z",
      },
    ],
  );
  await transaction(f.pool, f.workspaceId, async (db) => {
    const original = (
      await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic' AND number=1",
        [f.workspaceId],
      )
    ).rows[0].data;
    await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
      f.workspaceId,
      { ...original, id: "captured-v2", number: 2 },
    ]);
    await capturePublishedVersionMetadata(db, f.editor, "topic", 2);
  });
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='topic'",
    [
      f.workspaceId,
      { title: "현재 비밀 제목", category: "new-type", tags: ["new-tag"] },
    ],
  );
  await f.pool.query(
    "UPDATE workflow_document_state SET data=$2,revision=revision+1 WHERE workspace_id=$1 AND page_id='topic'",
    [
      f.workspaceId,
      { properties: { environment: "new-env", project: "new-project" } },
    ],
  );
  await f.pool.query(
    "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
    [f.workspaceId],
  );
  const result = await f.service.search(f.reader, {
    historical: true,
    query: "기존",
    type: "old-type",
    tags: ["old-tag"],
    environment: "old-env",
    project: "old-project",
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    title: "이전 제목",
    version: 2,
    historical: true,
    currentRecommendation: false,
    metadataStatus: "known",
  });
  expect(JSON.stringify(result)).not.toContain("현재 비밀 제목");
  expect(
    (await f.service.search(f.reader, { historical: true, type: "new-type" }))
      .items,
  ).toEqual([]);
  // migration103 did not record the then-business-owner; never infer today's owner.
  expect(
    (
      await f.service.search(f.reader, {
        historical: true,
        businessOwner: "editor",
      })
    ).items,
  ).toEqual([]);
});
