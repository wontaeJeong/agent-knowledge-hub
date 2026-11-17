import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "../workflows/service";
const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup(count = 1) {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  const module = await import(/* @vite-ignore */ String("./personal")).catch(
    () => ({ PersonalLibraryService: undefined }),
  );
  expect(
    module.PersonalLibraryService,
    "canonical personal library service",
  ).toBeDefined();
  const library = new module.PersonalLibraryService!(workflows);
  for (let n = 1; n < count; n++) {
    const id = `p${String(n).padStart(2, "0")}`;
    const { versions, ...metadata } = { ...page, id, title: `문서 ${n}` };
    await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
      f.workspaceId,
      id,
    ]);
    for (const actor of ["reader", "editor", "reviewer"])
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
      versions[0],
    ]);
  }
  return { ...f, workflows, library };
}
async function favorites(f: Awaited<ReturnType<typeof setup>>) {
  await f.pool.query(
    "INSERT INTO workflow_activity SELECT workspace_id,'reader',id,'favorite','2026-11-17'::timestamptz FROM pages WHERE workspace_id=$1",
    [f.workspaceId],
  );
}
test("personal lists paginate all authorized favorites with actor/filter/data bound cursors", async () => {
  const f = await setup(28);
  await favorites(f);
  const first = await f.library.list(f.reader, { kind: "favorites" });
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await f.library.list(f.reader, {
    kind: "favorites",
    cursor: first.nextCursor,
  });
  expect(second.items).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.items, ...second.items].map((x: any) => x.id)).size,
  ).toBe(28);
  await expect(
    f.library.list(f.editor, { kind: "favorites", cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    f.library.list(f.reader, { kind: "recent", cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    f.library.list(f.reader, { kind: "favorites", limit: 26 }),
  ).rejects.toThrow();
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.library.list(f.reader, { kind: "favorites", cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
  expect(
    (await f.library.list(f.reader, { kind: "favorites" })).items.some(
      (x: any) => x.id === "topic",
    ),
  ).toBe(false);
});
test("lists, current state and keyword rendering never visit; authorized opens deduplicate recent visits", async () => {
  const f = await setup();
  expect(await f.library.documentState(f.reader, "topic")).toEqual({
    favorite: false,
    subscribed: false,
  });
  await f.workflows.favorite(f.reader, "topic", true);
  await f.workflows.subscribe(f.reader, "topic", true);
  expect(await f.library.documentState(f.reader, "topic")).toEqual({
    favorite: true,
    subscribed: true,
  });
  expect(
    (await f.library.list(f.reader, { kind: "subscriptions" })).items,
  ).toHaveLength(1);
  await f.library.list(f.reader, { kind: "favorites" });
  await f.workflows.linkSearch(f.reader, { query: "주제" });
  expect((await f.library.list(f.reader, { kind: "recent" })).items).toEqual(
    [],
  );
  await f.workflows.document(f.reader, "topic");
  await f.workflows.document(f.reader, "topic");
  expect(
    (await f.library.list(f.reader, { kind: "recent" })).items,
  ).toHaveLength(1);
  await f.workflows.favorite(f.reader, "topic", false);
  await f.workflows.subscribe(f.reader, "topic", false);
  expect(await f.library.documentState(f.reader, "topic")).toEqual({
    favorite: false,
    subscribed: false,
  });
  expect(
    (await f.library.list(f.reader, { kind: "subscriptions" })).items,
  ).toEqual([]);
});
test("hidden ancestors and inherited sources remove titles and state without recording visits", async () => {
  const f = await setup(2);
  await favorites(f);
  await f.workflows.subscribe(f.reader, "p01", true);
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,revision,state,parent_id,data) VALUES($1,'p01',1,'active','topic','{}')",
    [f.workspaceId],
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect((await f.library.list(f.reader, { kind: "favorites" })).items).toEqual(
    [],
  );
  expect(
    (await f.library.list(f.reader, { kind: "subscriptions" })).items,
  ).toEqual([]);
  await expect(f.library.documentState(f.reader, "p01")).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("favorite reorder uses actor CAS, current authorization and replay without hidden IDs", async () => {
  const f = await setup(3);
  await favorites(f);
  const first = await f.library.list(f.reader, { kind: "favorites" });
  const reorder = {
    pageIds: ["topic", "p02", "p01"],
    expectedRevision: first.revision,
    mutationId: "move-one",
  };
  const done = await f.library.reorderFavorites(f.reader, reorder);
  expect(
    (await f.library.list(f.reader, { kind: "favorites" })).items.map(
      (x: any) => x.id,
    ),
  ).toEqual(["topic", "p02", "p01"]);
  expect(await f.library.reorderFavorites(f.reader, reorder)).toEqual(done);
  await expect(
    f.library.reorderFavorites(f.reader, { ...reorder, mutationId: "stale" }),
  ).rejects.toThrow("STALE_VERSION");
  await expect(
    f.library.reorderFavorites(f.reader, {
      ...reorder,
      pageIds: ["p01", "p02", "topic"],
    }),
  ).rejects.toThrow("MUTATION_CONFLICT");
  await expect(f.library.reorderFavorites(f.editor, reorder)).rejects.toThrow(
    "NOT_FOUND",
  );
  await f.workflows.favorite(f.reader, "p02", false);
  await expect(
    f.library.reorderFavorites(f.reader, {
      pageIds: ["topic", "p01"],
      expectedRevision: done.revision,
      mutationId: "changed-set",
    }),
  ).rejects.toThrow("STALE_VERSION");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(f.library.reorderFavorites(f.reader, reorder)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect((await f.library.list(f.reader, { kind: "favorites" })).items).toEqual(
    [],
  );
});
test("ancestor source ceilings apply even when the child has an independently readable source", async () => {
  const f = await setup(2);
  await favorites(f);
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'source','child-source')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','child-source','reader')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) SELECT workspace_id,'child-source',data||'{\"id\":\"child-source\"}' FROM sources WHERE workspace_id=$1 AND id='source-a'",
    [f.workspaceId],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{sourceIds}','[\"child-source\"]') WHERE workspace_id=$1 AND page_id='p01'",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,revision,state,parent_id,data) VALUES($1,'p01',1,'active','topic','{}')",
    [f.workspaceId],
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect((await f.library.list(f.reader, { kind: "favorites" })).items).toEqual(
    [],
  );
  await expect(f.workflows.document(f.reader, "p01")).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("cursor expires when current dependency ACL changes without removing the caller", async () => {
  const f = await setup(2);
  await favorites(f);
  const first = await f.library.list(f.reader, { kind: "favorites", limit: 1 });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(
    f.library.list(f.reader, {
      kind: "favorites",
      limit: 1,
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow("STALE_CURSOR");
});
