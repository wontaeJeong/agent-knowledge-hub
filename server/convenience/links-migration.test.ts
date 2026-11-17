import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { fixture } from "../test-support";
import { migrate, assertSchemaCurrent, transaction } from "../database";
import { rebuildPublishedLinks, replacePublishedLinks } from "./links";
import { inventory } from "../retention/inventory";
test("144 upgrade rollback, bounded resumable backfill, repair and restart preserve latest canonical edges", async () => {
  const f = await fixture();
  let restart: Pool | undefined;
  try {
    await f.pool.query(
      "INSERT INTO resources SELECT $1,'page','old-'||lpad(i::text,3,'0') FROM generate_series(1,103) i",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) SELECT $1,'old-'||lpad(i::text,3,'0'),jsonb_build_object('links',jsonb_build_array('target')) FROM generate_series(1,103) i",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO versions SELECT $1,'old-'||lpad(i::text,3,'0'),1,jsonb_build_object('number',1,'content','[[unresolved]]','sourceIds','[]'::jsonb) FROM generate_series(1,103) i",
      [f.workspaceId],
    );
    await f.pool.query("DROP TABLE published_page_links");
    await f.pool.query("DELETE FROM schema_migrations WHERE version=144");
    const sql = await readFile(
        new URL("../migrations/144-published-page-links.sql", import.meta.url),
        "utf8",
      ),
      db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(sql);
      await db.query("ROLLBACK");
      expect(
        (await db.query("SELECT to_regclass('published_page_links') AS t"))
          .rows[0].t,
      ).toBeNull();
    } finally {
      db.release();
    }
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    const first = await rebuildPublishedLinks(f.pool, f.workspaceId, {
      limit: 100,
    });
    expect(first).toEqual({ processed: 100, skipped: 0, nextAfter: "old-100" });
    const second = await rebuildPublishedLinks(f.pool, f.workspaceId, {
      after: first.nextAfter!,
    });
    expect(second).toEqual({ processed: 4, skipped: 0, nextAfter: null });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM published_page_links WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(103);
    // A later version wins; queued/outdated repair cannot restore its earlier edges.
    await transaction(f.pool, f.workspaceId, async (db) => {
      await db.query("INSERT INTO versions VALUES($1,'old-001',2,$2)", [
        f.workspaceId,
        { number: 2, content: "none", sourceIds: [], linkReferences: [] },
      ]);
      await replacePublishedLinks(db, {
        workspaceId: f.workspaceId,
        pageId: "old-001",
        version: 2,
        refs: [],
      });
      await expect(
        replacePublishedLinks(db, {
          workspaceId: f.workspaceId,
          pageId: "old-001",
          version: 1,
          refs: [
            { targetPageId: "target", label: "target", sourceBlockId: null },
          ],
        }),
      ).rejects.toThrow("STALE_VERSION");
    });
    restart = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await migrate(restart);
    await assertSchemaCurrent(restart);
    await rebuildPublishedLinks(restart, f.workspaceId);
    expect(
      (
        await restart.query(
          "SELECT * FROM published_page_links WHERE workspace_id=$1 AND page_id='old-001'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([]);
    await restart.query(
      "DELETE FROM published_page_links WHERE workspace_id=$1 AND page_id='old-002'",
      [f.workspaceId],
    );
    await rebuildPublishedLinks(restart, f.workspaceId, { limit: 2 });
    expect(
      (
        await restart.query(
          "SELECT target_page_id FROM published_page_links WHERE workspace_id=$1 AND page_id='old-002'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ target_page_id: "target" }]);
  } finally {
    await restart?.end();
    await f.pool.end();
  }
}, 20000);
test("retention inventory recognizes both endpoints and rejects unknown index content columns", async () => {
  const f = await fixture(),
    db = await f.pool.connect();
  try {
    await rebuildPublishedLinks(f.pool, f.workspaceId);
    await inventory(db, f.workspaceId);
    await db.query(
      "ALTER TABLE published_page_links ADD COLUMN private_title text",
    );
    await expect(inventory(db, f.workspaceId)).rejects.toThrow(
      "RETENTION_GRAPH_UNSUPPORTED",
    );
  } finally {
    await db.query(
      "ALTER TABLE published_page_links DROP COLUMN IF EXISTS private_title",
    );
    db.release();
    await f.pool.end();
  }
});


test("legacy rebuild preserves exact version bytes and already approved proposal identity", async () => {
  const f=await fixture();
  try {
    const {RuntimeService}=await import("../runtime/knowledge");
    const {loadState}=await import("../repository");
    const {draftOf}=await import("../../src/domain/wiki");
    const runtime=new RuntimeService(f.pool);
    const state=await transaction(f.pool,f.workspaceId,db=>loadState(db,f.workspaceId));
    const batch=await runtime.core.propose(f.editor,[{...draftOf(state.pages[0]),content:"approved pending content"}],["source-a"]);
    await runtime.core.approve(f.ctx,batch.id,batch.hash);
    const before=(await f.pool.query("SELECT data::text AS bytes,md5(data::text) AS hash FROM versions WHERE workspace_id=$1 ORDER BY page_id,number",[f.workspaceId])).rows;
    const approved=(await f.pool.query("SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",[f.workspaceId,batch.id])).rows[0];
    await rebuildPublishedLinks(f.pool,f.workspaceId);
    expect((await f.pool.query("SELECT data::text AS bytes,md5(data::text) AS hash FROM versions WHERE workspace_id=$1 ORDER BY page_id,number",[f.workspaceId])).rows).toEqual(before);
    expect((await f.pool.query("SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",[f.workspaceId,batch.id])).rows[0]).toEqual(approved);
    expect(await runtime.core.publish(f.ctx,batch.id,batch.hash,"approved-after-rebuild")).toMatchObject({versions:{topic:2}});
  } finally {await f.pool.end();}
});
test("legacy rebuild leaves prior answer envelope current for discovery and actual refiling", async () => {
  const f=await fixture();
  try {
    const {RuntimeService}=await import("../runtime/knowledge");
    const {discoveryReport}=await import("../discovery");
    const runtime=new RuntimeService(f.pool),answer=await runtime.query(f.editor,"기존","offline");
    const before=(await f.pool.query("SELECT data::text AS bytes FROM runtime_answers WHERE workspace_id=$1 AND id=$2",[f.workspaceId,answer.id])).rows[0];
    await rebuildPublishedLinks(f.pool,f.workspaceId);
    expect((await discoveryReport(f.pool,runtime,f.editor,7)).mostCited.map(p=>[p.id,p.citations])).toEqual([["topic",1]]);
    expect((await f.pool.query("SELECT data::text AS bytes FROM runtime_answers WHERE workspace_id=$1 AND id=$2",[f.workspaceId,answer.id])).rows[0]).toEqual(before);
    expect(await runtime.file(f.editor,answer.id)).toHaveProperty("id");
  } finally {await f.pool.end();}
});
