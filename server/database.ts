import type { Pool, PoolClient } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

/** Read-only compatibility gate: the web process must never apply migrations. */
export async function assertSchemaCurrent(pool: Pool): Promise<void> {
  try {
    const directory = new URL("./migrations/", import.meta.url);
    const expected = await Promise.all(
      (await readdir(directory))
        .filter((n) => /^\d+-.*\.sql$/.test(n))
        .sort()
        .map(async (name) => ({
          version: Number(name.split("-")[0]),
          hash: createHash("sha256")
            .update(await readFile(new URL(name, directory), "utf8"))
            .digest("hex"),
        })),
    );
    const actual = await pool.query(
      "SELECT version,hash FROM schema_migrations",
    );
    if (
      actual.rows.length !== expected.length ||
      expected.some(
        (item) =>
          !actual.rows.some(
            (row) => row.version === item.version && row.hash === item.hash,
          ),
      )
    )
      throw Error("SCHEMA_NOT_CURRENT");
  } catch {
    throw Error("SCHEMA_NOT_CURRENT");
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(720291)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, hash text NOT NULL)",
    );
    const directory = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^\d+-.*\.sql$/.test(n))
      .sort()) {
      const version = Number(name.split("-")[0]);
      const sql = await readFile(new URL(name, directory), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const previous = await db.query(
        "SELECT hash FROM schema_migrations WHERE version=$1",
        [version],
      );
      if (previous.rowCount && previous.rows[0].hash !== hash)
        throw Error("Migration checksum mismatch");
      if (!previous.rowCount) {
        await db.query(sql);
        await db.query("INSERT INTO schema_migrations VALUES($1,$2)", [
          version,
          hash,
        ]);
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function transaction<T>(
  pool: Pool,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
  usage?: { principalId: string; operation: string },
): Promise<T> {
  const db = await pool.connect();
  const start = performance.now();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const workspace = await db.query(
      "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
      [workspaceId],
    );
    if (!workspace.rowCount) throw Error("NOT_FOUND");
    const result = await operation(db);
    if (usage)
      await db.query(
        "INSERT INTO usage_events(workspace_id,principal_id,operation,succeeded,duration_ms) VALUES($1,$2,$3,true,$4)",
        [
          workspaceId,
          usage.principalId,
          usage.operation,
          performance.now() - start,
        ],
      );
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    if (usage) {
      try {
        // Record only known members, not untrusted identities or arbitrary workspace names.
        await db.query(
          "INSERT INTO usage_events(workspace_id,principal_id,operation,succeeded,duration_ms) SELECT workspace_id,principal_id,$3,false,$4 FROM memberships WHERE workspace_id=$1 AND principal_id=$2",
          [
            workspaceId,
            usage.principalId,
            usage.operation,
            performance.now() - start,
          ],
        );
      } catch {
        throw Error("USAGE_UNAVAILABLE");
      }
    }
    throw error;
  } finally {
    db.release();
  }
}
