import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { KnowledgeService } from "../service";
import { VersionService } from "../workflows/versions/service";
import { segmentAnchors, resolveAnchor } from "../workflows/versions/diff";
import { internalReferences } from "../workflows/references";
let f: Awaited<ReturnType<typeof fixture>>,
  w: WorkflowService,
  v: VersionService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  w = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  v = new VersionService(f.pool, authorizeInTransaction);
});
afterEach(async () => {
  await f?.pool.end();
});
async function publish(content: string, baseVersion: number) {
  const b = await w.proposeEdit(f.editor, "topic", {
      content,
      baseVersion,
      reason: "C9 synthetic regression",
    }),
    s = new KnowledgeService(f.pool);
  await s.approve(f.ctx, b.id, b.hash);
  await s.publish(f.ctx, b.id, b.hash, `c9-${baseVersion}`);
  return b;
}
test("adjacent headings and paragraph each have separate stable published block identity", async () => {
  await publish(
    "# 설치\n## 설치\n본문\n\n```ts\n코드\n```\n\n| 값 |\n|---|\n| 표 |",
    1,
  );
  const snap = await v.version(f.reader, "topic", 2);
  expect(
    snap.anchors.anchors.map((a: { startLine: number }) => a.startLine),
  ).toEqual([1, 2, 3, 5, 9]);
  const d = await w.document(f.reader, "topic");
  expect(d).toHaveProperty("anchors", snap.anchors);
});
test("moving unique blocks keeps IDs; changed/deleted/identical duplicate blocks fail closed without rewriting old snapshot", async () => {
  await publish("# 시작\n\n보존\n\n변경 전\n\n삭제", 1);
  const old = await v.version(f.reader, "topic", 2);
  await publish("# 시작\n\n변경 후\n\n보존", 2);
  const next = await v.version(f.reader, "topic", 3);
  const keep = old.anchors.anchors[1];
  expect(resolveAnchor(keep, next.anchors.anchors)).toMatchObject({
    resolved: true,
    status: "moved",
  });
  for (const anchor of old.anchors.anchors.slice(2))
    expect(resolveAnchor(anchor, next.anchors.anchors).resolved).toBe(false);
  expect(await v.version(f.reader, "topic", 2)).toMatchObject({
    content: old.content,
    anchors: old.anchors,
  });
  const duplicate = segmentAnchors("topic", 4, "같음\n\n같음");
  expect(duplicate.anchors.every((a) => !a.stable)).toBe(true);
  expect(resolveAnchor(duplicate.anchors[0], duplicate.anchors).resolved).toBe(
    false,
  );
});
test("new inferred references ignore invisible raw HTML but preserve Markdown links outside code and trusted origin policy", () => {
  const href = `/?app=1&space=${f.workspaceId}&document=topic`;
  expect(
    internalReferences(
      `<a href="${href}">숨김</a>\n\n<div><a href="${href}">중첩</a></div>\n\n[표시](${href})\n\n\`[예제](${href})\``,
      f.workspaceId,
    ),
  ).toEqual([{ targetPageId: "topic", label: "표시", sourceBlockId: null }]);
  expect(
    internalReferences(
      `[외부](https://outside.example${href})`,
      f.workspaceId,
      "https://wiki.example",
    ),
  ).toEqual([]);
});
test("current raw source permission loss hides fixed published bodies and anchors", async () => {
  await publish("# 제목\n\n본문", 1);
  expect(
    (await v.version(f.reader, "topic", 2)).anchors.anchors.length,
  ).toBeGreaterThan(0);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(v.version(f.reader, "topic", 2)).rejects.toThrow("NOT_FOUND");
  await expect(w.document(f.reader, "topic")).rejects.toThrow("NOT_FOUND");
});

test("legacy coarse anchors are immutable and unchanged fallback IDs remain compatible", async () => {
  const old = await v.version(f.reader, "topic", 1);
  expect(old.anchors).toEqual(segmentAnchors("topic", 1, old.content));
  await publish("# 새 제목\n본문", 1);
  expect((await v.version(f.reader, "topic", 1)).anchors).toEqual(old.anchors);
  expect((await v.latestVersion(f.reader, "topic")).number).toBe(2);
});
test("explicit historical HTML relation preserves published lineage, approval, duplication and restore authority", async () => {
  const { DocumentStructureService } = await import("./structure");
  const { page } = await import("../test-support");
  const { randomUUID } = await import("node:crypto");
  await f.pool.query("INSERT INTO resources VALUES($1,'page','target')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT $1,'page','target',unnest($2::text[])",
    [f.workspaceId, ["reader", "editor", "reviewer"]],
  );
  const { versions, ...metadata } = page;
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'target',$2)",
    [f.workspaceId, { ...metadata, id: "target", links: [] }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'target',1,$2)", [
    f.workspaceId,
    versions[0],
  ]);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{links}','[\"target\"]') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  const raw = `<a href="/?app=1&space=${f.workspaceId}&document=target">기존 HTML 관계</a>`;
  const first = await publish(raw, 1);
  const before = (
    await f.pool.query(
      "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic' AND number=2",
      [f.workspaceId],
    )
  ).rows[0].data;
  expect(before.linkReferences).toContainEqual({
    targetPageId: "target",
    label: "target",
    sourceBlockId: null,
  });
  const structure = new DocumentStructureService(w),
    input = {
      pageId: "topic",
      version: 2,
      parentId: null,
      mutationId: randomUUID(),
    };
  const copy = await structure.duplicateToDraft(f.editor, input);
  expect(copy.dependencyVersions).toEqual({ topic: 2 }); // Exact origin pin carries Page.links transitively; the revocation assertions below verify authority.
  await publish("다음 본문", 2);
  const preview = await v.previewRestore(f.editor, {
    batchId: first.id,
    pages: [{ pageId: "topic", fields: ["content"] }],
  });
  expect(preview).toHaveProperty("previewHash");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic' AND number=2",
        [f.workspaceId],
      )
    ).rows[0].data,
  ).toEqual(before);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='target' AND principal_id IN ('editor','reader','reviewer')",
    [f.workspaceId],
  );
  await expect(v.version(f.reader, "topic", 2)).rejects.toThrow();
  await expect(structure.duplicateToDraft(f.editor, input)).rejects.toThrow();
  await expect(
    v.previewRestore(f.editor, {
      batchId: first.id,
      pages: [{ pageId: "topic", fields: ["content"] }],
    }),
  ).rejects.toThrow();
  await expect(
    v.proposeRestoreSelection(f.editor, {
      previewHash: preview.previewHash,
      reason: "권한 철회 후 복원",
    }),
  ).rejects.toThrow();
});
test("background current revalidation does not create a visit and current source revocation hides latest snapshots", async () => {
  await publish("# 위치\n\n검사", 1);
  await w.document(f.reader, "topic", { recordVisit: false });
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM workflow_activity WHERE workspace_id=$1 AND principal_id='reader'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(v.latestVersion(f.reader, "topic")).rejects.toThrow("NOT_FOUND");
});

test("source erasure removes permission to fixed and latest block snapshots", async () => {
  const { OperationsService } = await import("../operations/service");
  const { previewErasure, executeErasure } =
    await import("../operations/erasure");
  await publish("# 삭제 대상\n\n합성 본문", 1);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    ops = new OperationsService(f.pool, authorizeInTransaction),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    };
  const preview = await previewErasure(ops, ctx, request);
  expect(
    (
      await executeErasure(ops, ctx, {
        ...request,
        previewHash: preview.previewHash,
        confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
      })
    ).status,
  ).toBe("completed");
  await expect(v.version(f.reader, "topic", 2)).rejects.toThrow();
  await expect(v.latestVersion(f.reader, "topic")).rejects.toThrow();
});
