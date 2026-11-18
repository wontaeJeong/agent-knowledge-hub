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
      "DROP TABLE personal_saved_views,personal_saved_view_mutations; DELETE FROM schema_migrations WHERE version IN (146,147,148)",
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
      const old = await readFile(
        new URL("../migrations/146-personal-saved-views.sql", import.meta.url),
        "utf8",
      );
      await db.query(old);
      await db.query(
        "INSERT INTO schema_migrations(version,hash) VALUES(146,encode(sha256(convert_to($1,'UTF8')),'hex'))",
        [old],
      );
      await db.query(
        "INSERT INTO personal_saved_view_mutations VALUES('existing','owner',gen_random_uuid(),'old',gen_random_uuid(),1)",
      );
      await assertSavedViewsSchema(db, "DRIFT");
      await db.query("BEGIN");
      await db.query(
        await readFile(
          new URL("../migrations/147-private-view-audit.sql", import.meta.url),
          "utf8",
        ),
      );
      await db.query("ROLLBACK");
      await assertSavedViewsSchema(db, "DRIFT");
      const audit = await readFile(
        new URL("../migrations/147-private-view-audit.sql", import.meta.url),
        "utf8",
      );
      const required = await readFile(
        new URL(
          "../migrations/148-private-view-audit-writes.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await db.query(audit);
      await db.query(
        "INSERT INTO schema_migrations(version,hash) VALUES(147,encode(sha256(convert_to($1,'UTF8')),'hex'))",
        [audit],
      );
      await db.query("BEGIN");
      await db.query(required);
      await db.query("ROLLBACK");
      // The rolled-back 148 fence is absent. v147 still accepts the six-column binary.
      await db.query(
        "INSERT INTO personal_saved_view_mutations VALUES('existing','old-web',gen_random_uuid(),'old',gen_random_uuid(),1)",
      );
      await db.query(
        "DELETE FROM personal_saved_view_mutations WHERE owner_id='old-web'",
      );
      await migrate(pool);
      await migrate(pool);
      expect(
        (
          await db.query(
            "SELECT operation,applied_at FROM personal_saved_view_mutations",
          )
        ).rows,
      ).toEqual([{ operation: null, applied_at: null }]);
      await expect(
        db.query(
          "INSERT INTO personal_saved_view_mutations VALUES('existing','old-web',gen_random_uuid(),'old',gen_random_uuid(),1)",
        ),
      ).rejects.toThrow("personal_saved_view_audit_required");
      await expect(
        db.query(
          "UPDATE personal_saved_view_mutations SET revision=revision WHERE owner_id='owner'",
        ),
      ).rejects.toThrow("personal_saved_view_audit_required");
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
