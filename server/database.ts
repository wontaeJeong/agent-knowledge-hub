import type { Pool, PoolClient } from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function migrate(pool: Pool): Promise<void> {
  const sql = await readFile(new URL("./migrations/001-knowledge.sql", import.meta.url), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(720291)");
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, hash text NOT NULL)");
    const previous = await db.query("SELECT hash FROM schema_migrations WHERE version=1");
    if (previous.rowCount && previous.rows[0].hash !== hash) throw Error("Migration checksum mismatch");
    if (!previous.rowCount) {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations VALUES(1,$1)", [hash]);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
export async function transaction<T>(
  pool: Pool, workspaceId: string, operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const workspace = await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    if (!workspace.rowCount) throw Error("NOT_FOUND");
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
