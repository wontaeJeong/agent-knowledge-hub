import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { KnowledgeService } from "../service";
let f: Awaited<ReturnType<typeof fixture>>, w: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  w = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
    "https://wiki.example",
  );
});
afterEach(async () => {
  await f?.pool.end();
});
async function node(
  id: string,
  title = id,
  content = "본문",
  sourceIds: string[] = [],
) {
  const { versions, ...metadata } = page;
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
    [f.workspaceId, id, { ...metadata, id, title }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    id,
    { ...versions[0], content, sourceIds },
  ]);
}
const link = (id: string, label = id) =>
  `[${label}](/?app=1&space=${f.workspaceId}&document=${id})`;
async function publish(content: string) {
  const b = await w.proposeEdit(f.editor, "topic", {
      content,
      baseVersion: 1,
      reason: "C8 test",
    }),
    s = new KnowledgeService(f.pool);
  await s.approve(f.ctx, b.id, b.hash);
  await s.publish(f.ctx, b.id, b.hash, "c8-publish");
  return { b, s };
}
test("duplicate title suggestions return distinct stable IDs; unresolved title text never creates edges", async () => {
  await node("a", "중복");
  await node("b", "중복");
  const r = await w.resolveLinkSuggestions(f.reader, "중복");
  expect(r.items.map((x) => x.id)).toEqual(["a", "b"]);
  await publish("[[중복]]");
  expect((await w.backlinks(f.reader, "a", {})).items).toEqual([]);
});
test("publication records exact references atomically; replay and rename preserve identity; draft has no edges", async () => {
  await node("a", "중복");
  await node("b", "중복");
  await w.saveDraft(f.editor, {
    id: "private",
    expectedRevision: 0,
    title: "초안",
    content: link("b"),
    pageId: "topic",
    baseVersion: 1,
  });
  expect((await w.navigation(f.reader, "b")).backlinks).toEqual([]);
  const { b, s } = await publish(link("a", "선택한 문서"));
  const data = (
    await f.pool.query(
      "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic' AND number=2",
      [f.workspaceId],
    )
  ).rows[0].data;
  expect(data.linkReferences).toEqual([
    { targetPageId: "a", label: "선택한 문서", sourceBlockId: null },
  ]);
  await s.publish(f.ctx, b.id, b.hash, "c8-publish");
  expect(
    (
      await f.pool.query(
        "SELECT * FROM published_page_links WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toHaveLength(1);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{title}',to_jsonb('변경된 제목'::text)) WHERE workspace_id=$1 AND id='a'",
    [f.workspaceId],
  );
  expect((await w.navigation(f.reader, "topic")).links).toEqual([
    { id: "a", title: "변경된 제목", version: 1 },
  ]);
  expect((await w.backlinks(f.reader, "a", {})).items.map((x) => x.id)).toEqual(
    ["topic"],
  );
});
test.each(["source", "target", "raw", "ancestor"] as const)(
  "backlinks hide current %s revocation even with stale index",
  async (kind) => {
    await node("a");
    await node("parent");
    await publish(link("a"));
    if (kind === "ancestor")
      await w.setDocumentState(f.ctx, "topic", {
        expectedRevision: 0,
        parentId: "parent",
        reason: "test",
      });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND principal_id=$4",
      [
        f.workspaceId,
        kind === "raw" ? "source" : "page",
        kind === "raw"
          ? "source-a"
          : kind === "source"
            ? "topic"
            : kind === "ancestor"
              ? "parent"
              : "a",
        "reader",
      ],
    );
    if (kind === "target")
      await expect(w.backlinks(f.reader, "a", {})).rejects.toThrow();
    else
      expect(await w.backlinks(f.reader, "a", {})).toMatchObject({
        items: [],
        nextCursor: null,
      });
  },
);
test("opaque cursors bind actor target limit and current data; bounded pages have no repeats", async () => {
  await node("a");
  for (let i = 0; i < 27; i++)
    await node("n" + String(i).padStart(2, "0"), "참조 " + i, link("a"));
  const first = await w.backlinks(f.reader, "a", {});
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await w.backlinks(f.reader, "a", { cursor: first.nextCursor });
  expect(second.items.map((x) => x.id)).toEqual(["n25", "n26"]);
  await expect(
    w.backlinks(f.editor, "a", { cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    w.backlinks(f.reader, "a", { cursor: first.nextCursor, limit: 1 }),
  ).rejects.toThrow("STALE_CURSOR");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='n26' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    w.backlinks(f.reader, "a", { cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
});
test("trusted same-origin links work; external links, code and unresolved titles are not edges", async () => {
  await node("a");
  await node("b");
  await publish(
    `[same](https://wiki.example/?app=1&space=${f.workspaceId}&document=a)\n\n[external](https://evil.example/?app=1&space=${f.workspaceId}&document=b)\n\n\`\`\`md\n${link("b")}\n\`\`\`\n[[b]]`,
  );
  expect((await w.backlinks(f.reader, "a", {})).items.map((x) => x.id)).toEqual(
    ["topic"],
  );
  expect((await w.backlinks(f.reader, "b", {})).items).toEqual([]);
});
test("replacement removes deleted body links while retaining provenance, and stale index edges cannot invent backlinks", async () => {
  await node("a");
  await node("b");
  await publish(link("a"));
  const batch = await w.proposeEdit(f.editor, "topic", {
      content: "링크를 제거함",
      baseVersion: 2,
      reason: "remove",
    }),
    service = new KnowledgeService(f.pool);
  await service.approve(f.ctx, batch.id, batch.hash);
  await service.publish(f.ctx, batch.id, batch.hash, "remove");
  expect((await w.backlinks(f.reader, "a", {})).items).toEqual([]);
  await f.pool.query(
    "INSERT INTO published_page_links VALUES($1,'topic',2,'b') ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  expect((await w.backlinks(f.reader, "b", {})).items).toEqual([]);
  expect((await w.navigation(f.reader, "topic")).links).toEqual([]);
});
test("actual resource erasure removes derived index and queued query cannot return erased source metadata", async () => {
  await node("a");
  await publish(link("a"));
  const { OperationsService } = await import("../operations/service"),
    { previewErasure, executeErasure } = await import("../operations/erasure");
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const service = new OperationsService(f.pool, authorizeInTransaction),
    actor = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    input = { scope: "resource", resource: { kind: "source", id: "source-a" } };
  const preview = await previewErasure(service, actor, input);
  expect(preview.counts.published_page_links).toBe(1);
  await executeErasure(service, actor, {
    ...input,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(
    (
      await f.pool.query(
        "SELECT * FROM published_page_links WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([]);
  expect((await w.backlinks(f.reader, "a", {})).items).toEqual([]);
});
test("queued query rechecks erasure fence before returning source or target", async () => {
  await node("a");
  await publish(link("a"));
  const db = await f.pool.connect();
  await db.query("BEGIN");
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
    f.workspaceId,
  ]);
  const pending = w.backlinks(f.reader, "a", {});
  try {
    await db.query(
      "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,delete_content,approved_by) VALUES($1,'erase-c8','page','topic',true,'reviewer')",
      [f.workspaceId],
    );
    await db.query("COMMIT");
    expect((await pending).items).toEqual([]);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("final asynchronous identity revalidation cannot return pre-revocation backlink or suggestion metadata", async () => {
  await node("a");
  await publish(link("a"));
  let calls = 0;
  const ctx = {
    ...f.reader,
    authorization: {
      sessionId: "c8-recheck",
      assertSession: async () => {},
      revalidate: async () => {
        if (++calls === 2)
          await f.pool.query(
            "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
            [f.workspaceId],
          );
      },
    },
  };
  expect((await w.backlinks(ctx, "a", {})).items).toEqual([]);
  calls = 0;
  ctx.authorization.revalidate = async () => {
    if (++calls === 2)
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='a' AND principal_id='reader'",
        [f.workspaceId],
      );
  };
  expect((await w.resolveLinkSuggestions(ctx, "a")).items).toEqual([]);
});

test("backlink continuation uses one stable ASCII ID order, including case and punctuation", async () => {
  await node("target");
  for (const id of ["Z", "a", "A_", "A-", "B"])
    await node(id, id, link("target"));
  const first = await w.backlinks(f.reader, "target", { limit: 2 });
  const second = await w.backlinks(f.reader, "target", {
    limit: 2,
    cursor: first.nextCursor,
  });
  const third = await w.backlinks(f.reader, "target", {
    limit: 2,
    cursor: second.nextCursor,
  });
  expect(
    [...first.items, ...second.items, ...third.items].map((x) => x.id),
  ).toEqual(["A-", "A_", "B", "Z", "a"]);
  expect(third.nextCursor).toBeNull();
});
