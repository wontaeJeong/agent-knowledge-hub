import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { DocumentStructureService } from "./structure";
let f: Awaited<ReturnType<typeof fixture>>,
  workflows: WorkflowService,
  s: DocumentStructureService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  s = new DocumentStructureService(workflows);
});
afterEach(async () => {
  await f?.pool.end();
});
async function node(id: string, parentId: string | null = null) {
  const { versions, ...data } = page;
  await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
    f.workspaceId,
    id,
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT $1,'page',$2,unnest($3::text[])",
    [f.workspaceId, id, ["editor", "reviewer", "reader"]],
  );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, id, { ...data, id, title: id }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    id,
    versions[0],
  ]);
  if (parentId)
    await workflows.setDocumentState(f.ctx, id, {
      expectedRevision: 0,
      parentId,
      reason: "fixture tree",
    });
}
const move = (
  pageId: string,
  parentId: string | null,
  expectedRevision = 0,
  beforeId: string | null = null,
) => ({
  pageId,
  parentId,
  expectedRevision,
  beforeId,
  mutationId: randomUUID(),
  reason: "문서 정리",
});
test("three-level current tree and path omit restricted children, ancestors and counts", async () => {
  await node("child", "topic");
  await node("leaf", "child");
  await node("hidden", "topic");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='hidden' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect(
    (await s.children(f.reader, { parentId: "topic" })).items.map((x) => x.id),
  ).toEqual(["child"]);
  expect((await s.path(f.reader, "leaf")).items.map((x) => x.id)).toEqual([
    "topic",
    "child",
    "leaf",
  ]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='child' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(s.path(f.reader, "leaf")).rejects.toThrow();
  expect(
    JSON.stringify(await s.children(f.reader, { parentId: "topic" })),
  ).not.toMatch(/child|leaf|hidden|count/);
});
test("paged continuation rejects changed data, authority, actor and parent", async () => {
  for (let i = 0; i < 27; i++) await node("n" + String(i).padStart(2, "0"));
  const first = await s.children(f.reader, {});
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  expect(
    (await s.children(f.reader, { cursor: first.nextCursor! })).items,
  ).toHaveLength(3);
  await expect(
    s.children(f.editor, { cursor: first.nextCursor! }),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    s.children(f.reader, { parentId: "topic", cursor: first.nextCursor! }),
  ).rejects.toThrow("STALE_CURSOR");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='n26' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    s.children(f.reader, { cursor: first.nextCursor! }),
  ).rejects.toThrow("STALE_CURSOR");
});
test("move and order are atomic, CAS/idempotent and stable ID links survive", async () => {
  await node("a");
  await node("b");
  await node("child", "topic");
  const input = {
    ...move("child", null, 1, "a"),
    expectedStructureRevision: (await s.children(f.ctx, {})).revision,
  };
  const result = await s.move(f.ctx, input);
  expect(await s.move(f.ctx, input)).toEqual(result);
  expect((await s.children(f.ctx, {})).items.map((x) => x.id)).toEqual([
    "child",
    "a",
    "b",
    "topic",
  ]);
  expect((await workflows.document(f.ctx, "child")).page.id).toBe("child");
  await expect(s.move(f.ctx, { ...input, reason: "changed" })).rejects.toThrow(
    "IDEMPOTENCY_CONFLICT",
  );
  await expect(s.move(f.ctx, move("child", "topic", 1))).rejects.toThrow(
    "STALE_VERSION",
  );
});
test("cycles, self, trash parent and moved neighbor reject without partial writes", async () => {
  await node("child", "topic");
  await node("leaf", "child");
  await node("other");
  for (const input of [
    move("topic", "leaf"),
    move("topic", "topic"),
    move("topic", null, 0, "leaf"),
  ])
    await expect(s.move(f.ctx, input)).rejects.toThrow();
  await workflows.setDocumentState(f.ctx, "other", {
    expectedRevision: 0,
    state: "trash",
    reason: "fixture",
  });
  await expect(s.move(f.ctx, move("topic", "other"))).rejects.toThrow();
  expect((await workflows.document(f.ctx, "topic")).settings.revision).toBe(0);
});
test("moving from a restricted ancestor rejects audience widening and rolls back metadata/order/audit", async () => {
  await node("restricted");
  await node("child", "restricted");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='restricted' AND principal_id='reader'",
    [f.workspaceId],
  );
  const before = (
    await f.pool.query("SELECT count(*) FROM audit WHERE workspace_id=$1", [
      f.workspaceId,
    ])
  ).rows[0].count;
  await expect(s.move(f.ctx, move("child", null, 1))).rejects.toThrow(
    "SOURCE_SCOPE_CONFLICT",
  );
  expect((await workflows.document(f.ctx, "child")).settings.parent_id).toBe(
    "restricted",
  );
  expect(
    (
      await f.pool.query("SELECT count(*) FROM audit WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rows[0].count,
  ).toBe(before);
});
test("duplicate is a private page-less draft retaining exact original version and source dependencies with durable retry", async () => {
  const input = {
    pageId: "topic",
    version: 1,
    parentId: null,
    mutationId: randomUUID(),
  };
  const copy = await s.duplicateToDraft(f.editor, input);
  expect(copy.pageId).toBeUndefined();
  expect(copy.dependencyVersions).toEqual({ topic: 1 });
  expect(copy.sourceIds).toEqual(["source-a"]);
  expect(copy.content).toBe("기존 내용");
  expect(await s.duplicateToDraft(f.editor, input)).toEqual(copy);
  expect((await workflows.drafts(f.ctx)).items).toHaveLength(0);
  expect((await workflows.drafts(f.editor)).items).toHaveLength(1);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(s.duplicateToDraft(f.editor, input)).rejects.toThrow();
  expect((await workflows.drafts(f.editor)).items).toHaveLength(0);
});

test("stale neighbor order, cross-actor and cross-parent structure tokens reject atomically", async () => {
  await node("a");
  await node("b");
  await node("parent");
  const token = (await s.children(f.ctx, {})).revision;
  await expect(
    s.move(f.editor, {
      ...move("a", null, 0, "b"),
      expectedStructureRevision: token,
    }),
  ).rejects.toThrow();
  await s.move(f.ctx, move("b", null));
  await expect(
    s.move(f.ctx, {
      ...move("a", null, 0, "b"),
      expectedStructureRevision: token,
    }),
  ).rejects.toThrow("STALE_VERSION");
  const fresh = (await s.children(f.ctx, { parentId: "parent" })).revision;
  await expect(
    s.move(f.ctx, {
      ...move("a", null, 0, "b"),
      expectedStructureRevision: fresh,
    }),
  ).rejects.toThrow("STALE_VERSION");
  expect((await workflows.document(f.ctx, "a")).settings.revision).toBe(0);
});
test.each(["acl", "trash", "retention", "revision"] as const)(
  "queued move observes concurrent %s fence before mutating",
  async (kind) => {
    await node("a");
    const db = await f.pool.connect();
    await db.query("BEGIN");
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.workspaceId,
    ]);
    const pending = s.move(f.ctx, move("a", "topic")).then(
      () => null,
      (e) => e,
    );
    try {
      if (kind === "acl")
        await db.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='topic' AND principal_id='reviewer'",
          [f.workspaceId],
        );
      if (kind === "trash")
        await db.query(
          "INSERT INTO workflow_document_state VALUES($1,'topic',null,'trash',1,'{}')",
          [f.workspaceId],
        );
      if (kind === "revision")
        await db.query(
          "INSERT INTO workflow_document_state VALUES($1,'a',null,'active',1,'{}')",
          [f.workspaceId],
        );
      if (kind === "retention")
        await db.query(
          "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,delete_content,approved_by) VALUES($1,'erase','page','a',true,'reviewer')",
          [f.workspaceId],
        );
      await db.query("COMMIT");
      expect(await pending).toBeInstanceOf(Error);
      const stored = (
        await f.pool.query(
          "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id='a'",
          [f.workspaceId],
        )
      ).rows[0];
      expect(stored?.parent_id ?? null).toBeNull();
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM workflow_events WHERE workspace_id=$1 AND kind='page.structure.move'",
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  },
);
test("duplicate retry survives title changes, retains lineage after body replacement and cannot bypass private publication", async () => {
  const input = {
    pageId: "topic",
    version: 1,
    parentId: null,
    mutationId: randomUUID(),
  };
  const copy = await s.duplicateToDraft(f.editor, input);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{title}','\"바뀐 제목\"') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  expect(await s.duplicateToDraft(f.editor, input)).toEqual(copy);
  const revised = await workflows.saveDraft(f.editor, {
    id: copy.id,
    expectedRevision: 1,
    title: "파생 초안",
    content: "다른 표현",
  });
  expect(revised.dependencyVersions).toEqual({ topic: 1 });
  expect(revised.sourceIds).toEqual(["source-a"]);
  await expect(
    workflows.submitDraft(f.editor, copy.id, 2, "공유"),
  ).rejects.toThrow("SOURCE_REGISTRATION_REQUIRED");
});

test("order inventory preserves page lineage and duplicate bodies are included in actual source erasure", async () => {
  const { inventory } = await import("../retention/inventory"),
    { selectErasureRows, previewErasure, executeErasure } =
      await import("../operations/erasure"),
    { OperationsService } = await import("../operations/service");
  await s.move(f.ctx, move("topic", null));
  const copy = await s.duplicateToDraft(f.editor, {
    pageId: "topic",
    version: 1,
    parentId: null,
    mutationId: randomUUID(),
  });
  const db = await f.pool.connect();
  try {
    const rows = await inventory(db, f.workspaceId);
    expect(
      selectErasureRows(rows, { kind: "source", id: "source-a" }).some(
        (r) => r.table === "workflow_document_order",
      ),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("기존 내용");
  } finally {
    db.release();
  }
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const ops = new OperationsService(f.pool, authorizeInTransaction),
    admin = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    input = { scope: "resource", resource: { kind: "source", id: "source-a" } };
  const preview = await previewErasure(ops, admin, input);
  expect(preview.counts.workflow_document_order).toBe(1);
  expect(preview.counts.workflow_drafts).toBe(1);
  await executeErasure(ops, admin, {
    ...input,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT data FROM workflow_drafts WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, copy.id],
        )
      ).rows,
    ),
  ).not.toContain("기존 내용");
  await expect(
    s.duplicateToDraft(f.editor, {
      pageId: "topic",
      version: 1,
      parentId: null,
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow();
});
test("order inventory rejects an unreviewed content-column schema extension", async () => {
  const { inventory } = await import("../retention/inventory");
  await f.pool.query(
    "ALTER TABLE workflow_document_order ADD COLUMN private_title text",
  );
  const db = await f.pool.connect();
  try {
    await expect(inventory(db, f.workspaceId)).rejects.toThrow(
      "RETENTION_GRAPH_UNSUPPORTED",
    );
  } finally {
    db.release();
    await f.pool.query(
      "ALTER TABLE workflow_document_order DROP COLUMN private_title",
    );
  }
});
test.each(["resource", "workspace"] as const)(
  "approved %s erasure deletes order rows atomically and legal holds preserve them",
  async (scope) => {
    const { previewErasure, executeErasure } =
        await import("../operations/erasure"),
      { OperationsService } = await import("../operations/service");
    await s.move(f.ctx, move("topic", null));
    await f.pool.query(
      "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
    const ops = new OperationsService(f.pool, authorizeInTransaction),
      admin = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
      input =
        scope === "workspace"
          ? { scope }
          : { scope, resource: { kind: "page", id: "topic" } };
    await f.pool.query(
      "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'c7-hold','page','topic','fixture-owner')",
      [f.workspaceId],
    );
    const held = await previewErasure(ops, admin, input),
      confirm =
        scope === "workspace"
          ? "ERASE_ENTIRE_WORKSPACE"
          : "ERASE_PREVIEWED_RESOURCE_LINEAGE";
    await expect(
      executeErasure(ops, admin, {
        ...input,
        previewHash: held.previewHash,
        confirm,
      }),
    ).rejects.toThrow("LEGAL_HOLD");
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM workflow_document_order WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(1);
    await f.pool.query(
      "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const preview = await previewErasure(ops, admin, input);
    await executeErasure(ops, admin, {
      ...input,
      previewHash: preview.previewHash,
      confirm,
    });
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM workflow_document_order WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  },
);

test.each(["reorder", "trash"] as const)(
  "queued before-neighbor move rejects concurrent %s with no partial target write",
  async (kind) => {
    await node("a");
    await node("b");
    const input = {
      ...move("a", null, 0, "b"),
      expectedStructureRevision: (await s.children(f.ctx, {})).revision,
    };
    const db = await f.pool.connect();
    await db.query("BEGIN");
    await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.workspaceId,
    ]);
    const pending = s.move(f.ctx, input).then(
      () => null,
      (e) => e,
    );
    try {
      if (kind === "reorder")
        await db.query(
          "INSERT INTO workflow_document_order VALUES($1,'b',99)",
          [f.workspaceId],
        );
      else
        await db.query(
          "INSERT INTO workflow_document_state VALUES($1,'b',null,'trash',1,'{}')",
          [f.workspaceId],
        );
      await db.query("COMMIT");
      expect(await pending).toMatchObject({ message: "STALE_VERSION" });
      expect((await workflows.document(f.ctx, "a")).settings.revision).toBe(0);
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM workflow_document_order WHERE workspace_id=$1 AND page_id='a'",
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  },
);
test("duplicate mutation IDs belong to actor and space, so another author gets a separate private draft", async () => {
  const input = {
    pageId: "topic",
    version: 1,
    parentId: null,
    mutationId: randomUUID(),
  };
  const first = await s.duplicateToDraft(f.editor, input),
    second = await s.duplicateToDraft(f.ctx, input);
  expect(first.id).toBe(second.id);
  expect(
    (
      await f.pool.query(
        "SELECT owner_id FROM workflow_drafts WHERE workspace_id=$1 AND id=$2 ORDER BY owner_id",
        [f.workspaceId, first.id],
      )
    ).rows.map((x) => x.owner_id),
  ).toEqual(["editor", "reviewer"]);
  expect(await s.duplicateToDraft(f.editor, input)).toEqual(first);
  expect(await s.duplicateToDraft(f.ctx, input)).toEqual(second);
});
