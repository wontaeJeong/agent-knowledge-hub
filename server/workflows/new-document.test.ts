import { beforeEach, afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction, AccessService } from "../access";
import { WorkflowService } from "./service";
import { RuntimeService } from "../runtime/knowledge";
import { handleWorkflowRoute } from "./http";
let f: Awaited<ReturnType<typeof fixture>>, s: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  s = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
});
afterEach(async () => {
  await f?.pool.end();
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
});
async function post(
  ctx: typeof f.editor,
  path: string,
  body: unknown,
): Promise<any> {
  let result: unknown;
  const found = await handleWorkflowRoute(
    {
      method: "POST",
      path: "/api/v1/workflows" + path,
      body,
      ctx,
      send: (_status, data) => {
        result = data;
      },
    },
    s,
  );
  expect(found, "new document endpoint must exist").toBe(true);
  return result;
}
async function save(ctx = f.editor) {
  return s.saveDraft(ctx, {
    id: "new-private",
    expectedRevision: 0,
    title: "새 문서",
    content: "사람이 작성한 정확한 본문",
  });
}
async function request(ctx = f.editor, extra = {}) {
  return post(ctx, "/drafts/new-private/disclosure", {
    expectedRevision: 1,
    title: "새 문서",
    parentId: null,
    readers: ["editor", "reviewer", "reader"],
    reviewerId: "reviewer",
    reason: "공유 요청",
    mutationId: randomUUID(),
    ...extra,
  });
}
async function approve(d: any, ctx = f.ctx) {
  return post(ctx, `/draft-disclosures/${d.id}/decision`, {
    hash: d.hash,
    decision: "approve",
    reason: "고정 내용 확인",
    mutationId: randomUUID(),
  });
}
function submitInput(d: any) {
  return {
    expectedRevision: 1,
    title: "새 문서",
    parentId: null,
    reason: "최초 검토 요청",
    disclosureId: d.id,
    disclosureHash: d.hash,
    mutationId: randomUUID(),
  };
}
test("team first publication preserves manual text and requires separate disclosure then independent knowledge review", async () => {
  await save();
  expect((await s.drafts(f.ctx)).items).toHaveLength(0);
  await expect(
    s.submitDraft(f.editor, "new-private", 1, "기존 경로"),
  ).rejects.toThrow("SOURCE_REGISTRATION_REQUIRED");
  const d = await request();
  expect(d.status).toBe("pending");
  expect(
    (
      await f.pool.query("SELECT 1 FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", submitInput(d)),
  ).rejects.toThrow("DISCLOSURE_REQUIRED");
  await approve(d);
  const input = submitInput(d);
  const result = await post(f.editor, "/drafts/new-private/submit-new", input);
  expect(result.status).toBe("knowledge-review-pending");
  expect(await post(f.editor, "/drafts/new-private/submit-new", input)).toEqual(
    result,
  );
  expect(
    (
      await f.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, result.sourceId],
      )
    ).rows[0].data.content,
  ).toBe("사람이 작성한 정확한 본문");
  await expect(
    s.runtime.core.approve(f.editor, result.batchId, result.hash),
  ).rejects.toThrow();
  await s.runtime.core.approve(f.ctx, result.batchId, result.hash);
  await s.runtime.core.publish(
    f.ctx,
    result.batchId,
    result.hash,
    randomUUID(),
  );
  const pages = await s.runtime.pages(f.reader);
  expect(pages.some((p) => p.content === "사람이 작성한 정확한 본문")).toBe(
    true,
  );
  expect(
    (
      await f.pool.query("SELECT 1 FROM import_runs WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("owner-only personal publication requires explicit owner confirmation and canonical knowledge approval", async () => {
  const p = await new AccessService(f.pool).createSpace(f.editor, "개인 공간"),
    ctx = { ...f.editor, workspaceId: p.id };
  await save(ctx);
  await expect(
    request(ctx, { readers: ["editor", "reader"], reviewerId: undefined }),
  ).rejects.toThrow();
  const d = await request(ctx, { readers: ["editor"], reviewerId: undefined });
  expect(d.status).toBe("pending-confirmation");
  await expect(
    post(ctx, "/drafts/new-private/submit-new", submitInput(d)),
  ).rejects.toThrow("DISCLOSURE_REQUIRED");
  await approve(d, ctx);
  const r = await post(ctx, "/drafts/new-private/submit-new", submitInput(d));
  await s.runtime.core.approve(ctx, r.batchId, r.hash);
  await s.runtime.core.publish(ctx, r.batchId, r.hash, randomUUID());
  expect((await s.runtime.pages(ctx))[0].content).toBe(
    "사람이 작성한 정확한 본문",
  );
});
test("stale draft and parent changes cannot use an approved disclosure", async () => {
  await save();
  const d = await request();
  await approve(d);
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", {
      ...submitInput(d),
      parentId: "topic",
    }),
  ).rejects.toThrow("APPROVAL_STALE");
  await s.saveDraft(f.editor, {
    id: "new-private",
    expectedRevision: 1,
    title: "새 문서",
    content: "수정 본문",
  });
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", {
      ...submitInput(d),
      expectedRevision: 2,
    }),
  ).rejects.toThrow("APPROVAL_STALE");
  expect(
    (
      await f.pool.query("SELECT 1 FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("template ancestry cannot be widened or stripped, and revocation invalidates a snapshot", async () => {
  await s.saveDraft(f.editor, {
    id: "new-private",
    expectedRevision: 0,
    title: "새 문서",
    content: "템플릿 본문",
    dependencyVersions: { topic: 1 },
    sourceIds: ["source-a"],
  });
  const d = await request();
  await approve(d);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", submitInput(d)),
  ).rejects.toThrow();
});
test("saved draft templates retain source lineage when creating a new private document", async () => {
  await s.saveDraft(f.editor, {
    id: "template-origin",
    expectedRevision: 0,
    title: "원본 템플릿",
    content: "제한된 예제",
    sourceIds: ["source-a"],
  });
  await s.saveTemplate(f.editor, {
    id: "private-template",
    retainLineage: true,
    expectedRevision: 0,
    title: "템플릿",
    content: "제한된 예제",
    sourceDraftId: "template-origin",
    sourceDraftRevision: 1,
  });
  const d = await s.saveDraft(f.editor, {
    id: "new-from-template",
    expectedRevision: 0,
    title: "복사",
    content: "제한된 예제",
    templateId: "private-template",
    templateRevision: 1,
  });
  expect(d.sourceIds).toEqual(["source-a"]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await s.drafts(f.editor)).items).toHaveLength(0);
});
test("registered manual source itself obeys current inherited source readers after registration", async () => {
  await s.saveDraft(f.editor, {
    id: "new-private",
    expectedRevision: 0,
    title: "새 문서",
    content: "계보가 있는 수동 본문",
    sourceIds: ["source-a"],
  });
  const d = await request();
  await approve(d);
  const r = await post(
    f.editor,
    "/drafts/new-private/submit-new",
    submitInput(d),
  );
  expect(
    (await s.runtime.sources(f.ctx)).some((x) => x.id === r.sourceId),
  ).toBe(true);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect(
    (await s.runtime.sources(f.ctx)).some((x) => x.id === r.sourceId),
  ).toBe(false);
});
test("two concurrent submissions produce exactly one source and batch, and the reviewed parent is applied only at publication", async () => {
  await save();
  const d = await request(f.editor, { parentId: "topic" });
  await approve(d);
  const input = { ...submitInput(d), parentId: "topic" };
  const [a, b] = await Promise.all([
    post(f.editor, "/drafts/new-private/submit-new", input),
    post(f.editor, "/drafts/new-private/submit-new", input),
  ]);
  expect(a).toEqual(b);
  const before = await f.pool.query(
    "SELECT 1 FROM pages WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, "document-" + d.id],
  );
  expect(before.rowCount).toBe(0);
  await s.runtime.core.approve(f.ctx, a.batchId, a.hash);
  await s.runtime.core.publish(f.ctx, a.batchId, a.hash, randomUUID());
  expect((await s.document(f.ctx, "document-" + d.id)).settings.parent_id).toBe(
    "topic",
  );
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM sources WHERE workspace_id=$1 AND data->>'tool'='manual'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
});
test("policy revision or inherited parent changes require a fresh raw disclosure", async () => {
  await save();
  const d = await request(f.editor, { parentId: "topic" });
  await approve(d);
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{}')",
    [f.workspaceId],
  );
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", {
      ...submitInput(d),
      parentId: "topic",
    }),
  ).rejects.toThrow("APPROVAL_STALE");
  const d2 = await request();
  await approve(d2);
  await f.pool.query(
    "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", submitInput(d2)),
  ).rejects.toThrow("APPROVAL_STALE");
});
test("manual snapshots are private in retention inventory and participate in actual transitive legal erasure", async () => {
  const secret = "C6_SYNTHETIC_PRIVATE_ERASURE";
  await s.saveDraft(f.editor, {
    id: "new-private",
    expectedRevision: 0,
    title: "새 문서",
    content: secret,
    sourceIds: ["source-a"],
  });
  const d = await request();
  await approve(d);
  const created = await post(
    f.editor,
    "/drafts/new-private/submit-new",
    submitInput(d),
  );
  const db = await f.pool.connect();
  try {
    const { inventory } = await import("../retention/inventory");
    const rows = await inventory(db, f.workspaceId);
    expect(rows.some((r) => r.table === "workflow_draft_disclosures")).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain(secret);
  } finally {
    db.release();
  }
  const { OperationsService } = await import("../operations/service"),
    { previewErasure, executeErasure } = await import("../operations/erasure");
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const ops = new OperationsService(f.pool, authorizeInTransaction),
    admin = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    input = { scope: "resource", resource: { kind: "source", id: "source-a" } };
  const preview = await previewErasure(ops, admin, input);
  expect(preview.counts.workflow_draft_disclosures).toBe(1);
  expect(preview.counts.sources).toBe(2);
  const result = await executeErasure(ops, admin, {
    ...input,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(["completed", "blocked"]).toContain(result.status);
  for (const table of [
    "sources",
    "workflow_drafts",
    "workflow_draft_disclosures",
    "batches",
  ]) {
    expect(
      JSON.stringify(
        (
          await f.pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
  }
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM sources WHERE workspace_id=$1 AND id=$2 AND data->>'content'=$3",
        [f.workspaceId, created.sourceId, secret],
      )
    ).rowCount,
  ).toBe(0);
  await expect(
    post(f.editor, "/drafts/new-private/submit-new", submitInput(d)),
  ).rejects.toThrow();
});
test("private new drafts persist an authorized target parent for exact resume without publishing", async () => {
  const d = await s.saveDraft(f.editor, {
    id: "positioned",
    expectedRevision: 0,
    title: "하위 초안",
    content: "개인 내용",
    parentId: "topic",
  });
  expect(d.parentId).toBe("topic");
  expect(
    (
      await new WorkflowService(
        f.pool,
        new RuntimeService(f.pool),
        authorizeInTransaction,
      ).drafts(f.editor)
    ).items.find((x) => x.id === "positioned").parentId,
  ).toBe("topic");
});
test("erasing a registered manual source removes its owner-bound private draft copies without touching a namesake owner", async () => {
  await save();
  const d = await request();
  await approve(d);
  const created = await post(
    f.editor,
    "/drafts/new-private/submit-new",
    submitInput(d),
  );
  await s.saveDraft(f.ctx, {
    id: "new-private",
    expectedRevision: 0,
    title: "다른 소유자",
    content: "독립된 다른 사람의 초안",
  });
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const { OperationsService } = await import("../operations/service"),
    { previewErasure, executeErasure } = await import("../operations/erasure");
  const ops = new OperationsService(f.pool, authorizeInTransaction),
    admin = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  const input = {
    scope: "resource",
    resource: { kind: "source", id: created.sourceId },
  };
  const preview = await previewErasure(ops, admin, input);
  expect(preview.counts.workflow_drafts).toBe(1);
  const result = await executeErasure(ops, admin, {
    ...input,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(["completed", "blocked"]).toContain(result.status);
  const rows = (
    await f.pool.query(
      "SELECT owner_id,data FROM workflow_drafts WHERE workspace_id=$1 AND id='new-private'",
      [f.workspaceId],
    )
  ).rows;
  expect(rows.find((r) => r.owner_id === "editor").data.content).not.toBe(
    "사람이 작성한 정확한 본문",
  );
  expect(rows.find((r) => r.owner_id === "reviewer").data.content).toBe(
    "독립된 다른 사람의 초안",
  );
});
test("source JSON cannot forge a private draft deletion edge", async () => {
  await s.saveDraft(f.ctx, {
    id: "victim",
    expectedRevision: 0,
    title: "다른 소유자",
    content: "보존해야 할 독립 초안",
  });
  await f.pool.query(
    "UPDATE sources SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='source-a'",
    [
      f.workspaceId,
      JSON.stringify({ manualOwnerId: "reviewer", manualDraftId: "victim" }),
    ],
  );
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const { OperationsService } = await import("../operations/service"),
    { previewErasure } = await import("../operations/erasure");
  const preview = await previewErasure(
    new OperationsService(f.pool, authorizeInTransaction),
    { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    { scope: "resource", resource: { kind: "source", id: "source-a" } },
  );
  expect(preview.counts.workflow_drafts ?? 0).toBe(0);
});
test("registered disclosure remains an erasure authority after private draft deletion so prior template copies are removed", async () => {
  await save();
  await s.saveTemplate(f.editor, {
    id: "registered-template",
    expectedRevision: 0,
    title: "사본",
    content: "사람이 작성한 정확한 본문",
    sourceDraftId: "new-private",
    sourceDraftRevision: 1,
    retainLineage: true,
  });
  const d = await request();
  await approve(d);
  const created = await post(
    f.editor,
    "/drafts/new-private/submit-new",
    submitInput(d),
  );
  await s.deleteDraft(f.editor, "new-private", 1);
  expect(
    (
      await f.pool.query(
        "SELECT snapshot FROM workflow_draft_disclosures WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, d.id],
      )
    ).rows[0].snapshot,
  ).toEqual({});
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const { OperationsService } = await import("../operations/service"),
    { previewErasure, executeErasure } = await import("../operations/erasure");
  const ops = new OperationsService(f.pool, authorizeInTransaction),
    admin = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    input = {
      scope: "resource",
      resource: { kind: "source", id: created.sourceId },
    };
  const preview = await previewErasure(ops, admin, input);
  expect(preview.counts.workflow_templates).toBe(1);
  await executeErasure(ops, admin, {
    ...input,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(
    (
      await f.pool.query(
        "SELECT data FROM workflow_templates WHERE workspace_id=$1 AND id='registered-template'",
        [f.workspaceId],
      )
    ).rows[0].data.content,
  ).not.toBe("사람이 작성한 정확한 본문");
});
test("completed workspace erasure fences private manual writes and disclosure snapshots", async () => {
  await save();
  await f.pool.query(
    "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,$3,'workspace','fixture-owner','completed','{}')",
    [f.workspaceId, randomUUID(), "a".repeat(64)],
  );
  await expect(
    s.saveDraft(f.editor, {
      id: "fresh-after-erasure",
      expectedRevision: 0,
      title: "차단",
      content: "다시 남기면 안 되는 본문",
    }),
  ).rejects.toThrow("ERASURE_PRODUCT_WRITES_FENCED");
  await expect(request()).rejects.toThrow("ERASURE_PRODUCT_WRITES_FENCED");
});
