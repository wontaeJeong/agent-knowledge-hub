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
  const { readdir } = await import("node:fs/promises");
  expect((await pool.query("SELECT * FROM schema_migrations")).rowCount).toBe(
    (await readdir(new URL("./migrations/", import.meta.url))).filter((n) =>
      /^\d+-.*\.sql$/.test(n),
    ).length,
  );
});
test("coordinated backup excludes application transactions before workspace writes begin", async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO workspaces VALUES('mutation-gate-test') ON CONFLICT DO NOTHING",
  );
  const holder = await pool.connect();
  let entered = false,
    pending: Promise<unknown> | undefined;
  try {
    await holder.query("SELECT pg_advisory_lock(822025)");
    pending = transaction(pool, "mutation-gate-test", async () => {
      entered = true;
      return true;
    });
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!entered && Date.now() < deadline) {
      const row = await holder.query(
        "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted",
      );
      if (row.rowCount) {
        blocked = true;
        break;
      }
    }
    expect(entered).toBe(false);
    expect(blocked).toBe(true);
  } finally {
    await holder.query("SELECT pg_advisory_unlock(822025)");
    holder.release();
    await pending;
  }
  expect(entered).toBe(true);
});
