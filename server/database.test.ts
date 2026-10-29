import { afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { migrate, transaction } from "./database";

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
afterAll(() => pool.end());

test("migration is repeatable and transactions roll back all writes", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw Error("TEST_DATABASE_URL is required; use compose.test.yaml");
  await migrate(pool);
  await migrate(pool);
  await pool.query(
    "INSERT INTO workspaces(id) VALUES('migration-test') ON CONFLICT DO NOTHING",
  );
  await expect(
    transaction(pool, "migration-test", async (db) => {
      await db.query(
        "INSERT INTO memberships(workspace_id, principal_id, role) VALUES('migration-test', 'rollback', 'reader')",
      );
      throw Error("abort transaction");
    }),
  ).rejects.toThrow("abort transaction");
  expect(
    (
      await pool.query(
        "SELECT * FROM memberships WHERE principal_id='rollback'",
      )
    ).rowCount,
  ).toBe(0);
  expect((await pool.query("SELECT * FROM schema_migrations")).rowCount).toBe(
    5,
  );
});
