import { MUTATION_GATE } from "./operations-backup.mjs";
/** Privileged operator/job contract: current DB legal holds and persisted policy gate physical backup removal.
 * A global DB bundle cannot silently choose between conflicting space policies. Conflicts fail closed.
 */
export async function withBackupRetentionPolicy(pool, requestedDays, work) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='30s'");
    await db.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    if (
      (
        await db.query(
          "SELECT 1 FROM operations_legal_holds WHERE active LIMIT 1",
        )
      ).rowCount
    )
      throw Error("LEGAL_HOLD_BLOCKS_BACKUP_RETENTION");
    const policies = (
      await db.query(
        "SELECT DISTINCT coalesce(p.backup_days,30) AS days FROM workspaces w LEFT JOIN operations_policy p ON p.workspace_id=w.id",
      )
    ).rows;
    if (policies.length > 1) throw Error("BACKUP_RETENTION_POLICY_CONFLICT");
    const days = policies[0]?.days ?? 30;
    if (requestedDays !== undefined && requestedDays !== days)
      throw Error("BACKUP_RETENTION_POLICY_MISMATCH");
    const result = await work(days);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
