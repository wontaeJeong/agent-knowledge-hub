import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { fixture } from "../test-support";
import { migrate, assertSchemaCurrent } from "../database";
test("143 backfill covers multiple 500-row batches, rolls back cleanly, enforces unique page order and survives restart", async () => {
  const f = await fixture();
  let restarted: Pool | undefined;
  try {
    await f.pool.query(
      "INSERT INTO resources SELECT $1,'page','backfill-'||i FROM generate_series(1,1001) i",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) SELECT $1,'backfill-'||i,'{}'::jsonb FROM generate_series(1,1001) i",
      [f.workspaceId],
    );
    await f.pool.query("DROP TABLE workflow_document_order");
    await f.pool.query("DELETE FROM schema_migrations WHERE version=143");
    const sql = await readFile(
      new URL("../migrations/143-document-order.sql", import.meta.url),
      "utf8",
    );
    const db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(sql);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM workflow_document_order WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(1002);
      await db.query("ROLLBACK");
      expect(
        (
          await db.query(
            "SELECT to_regclass('workflow_document_order') AS name",
          )
        ).rows[0].name,
      ).toBeNull();
    } finally {
      db.release();
    }
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    await expect(
      f.pool.query("INSERT INTO workflow_document_order VALUES($1,'topic',0)", [
        f.workspaceId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
    restarted = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await migrate(restarted);
    await assertSchemaCurrent(restarted);
    expect(
      (
        await restarted.query(
          "SELECT count(*)::int AS n FROM workflow_document_order WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(1002);
  } finally {
    await restarted?.end();
    await f.pool.end();
  }
}, 20000);
