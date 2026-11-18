import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { assertSchemaCurrent, migrate } from "../database";
import { assertSavedViewsSchema } from "./views-schema";

test("146 upgrades and restarts without changing old records; rollback and drift fail closed", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new Pool({ connectionString: url.href });
  const name = "akh_saved_view_test_" + randomUUID().replaceAll("-", "");
  await admin.query('CREATE DATABASE "' + name + '"');
  url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    await migrate(pool);
    // Downgrade only this exclusively owned empty fixture to the preceding schema.
    await pool.query(
      "DROP TABLE personal_saved_views,personal_saved_view_mutations; DELETE FROM schema_migrations WHERE version=146",
    );
    const db = await pool.connect();
    try {
      await db.query("INSERT INTO workspaces(id) VALUES('existing')");
      await assertSavedViewsSchema(db, "DRIFT");
      await expect(assertSchemaCurrent(pool)).rejects.toThrow(
        "SCHEMA_NOT_CURRENT",
      );
      await db.query("BEGIN");
      await db.query(
        await readFile(
          new URL(
            "../migrations/146-personal-saved-views.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await db.query("ROLLBACK");
      expect(
        (await db.query("SELECT to_regclass('personal_saved_views') AS name"))
          .rows[0].name,
      ).toBeNull();
      await migrate(pool);
      await migrate(pool);
      await assertSchemaCurrent(pool);
      await assertSavedViewsSchema(db, "DRIFT");
      expect((await db.query("SELECT id FROM workspaces")).rows).toEqual([
        { id: "existing" },
      ]);
      await db.query("BEGIN");
      await db.query(
        "ALTER TABLE personal_saved_views ADD COLUMN unexpected text",
      );
      await expect(assertSavedViewsSchema(db, "DRIFT")).rejects.toThrow(
        "DRIFT",
      );
      await db.query("ROLLBACK");
      await db.query("BEGIN");
      await db.query(
        "DROP TABLE personal_saved_views,personal_saved_view_mutations",
      );
      await expect(assertSavedViewsSchema(db, "DRIFT")).rejects.toThrow(
        "DRIFT",
      );
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  } finally {
    await pool.end();
    await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
  }
});
