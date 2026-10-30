import type { Pool } from "pg";
import {
  MUTATION_GATE,
  sealExport,
  openExport,
  replayTombstones,
  type Tombstone,
} from "./service";
/** Infrastructure/operator-only recovery ledger; not a per-space browser export. Contains no source content. */
export async function captureRecoveryLedger(
  pool: Pool,
  key: string,
  signingKey: string,
) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    const tombstones = (
      await db.query(
        "SELECT workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by FROM operations_tombstones ORDER BY workspace_id,created_at,id",
      )
    ).rows;
    const readers = (
      await db.query(
        "SELECT workspace_id,kind,resource_id,principal_id FROM resource_readers ORDER BY workspace_id,kind,resource_id,principal_id",
      )
    ).rows;
    const sealed = sealExport(
      { version: 1, at: new Date().toISOString(), tombstones, readers },
      key,
      signingKey,
    );
    await db.query("COMMIT");
    return sealed;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
interface RecoveryLedger {
  version: 1;
  at: string;
  tombstones: Tombstone[];
  readers: {
    workspace_id: string;
    kind: string;
    resource_id: string;
    principal_id: string;
  }[];
}
export function readRecoveryLedger(
  encrypted: string,
  key: string,
  signingKey: string,
  maxAgeMs = 900000,
) {
  const ledger = openExport(encrypted, key, signingKey) as RecoveryLedger;
  const age = Date.now() - new Date(ledger.at).getTime();
  if (
    ledger.version !== 1 ||
    !Array.isArray(ledger.tombstones) ||
    !Array.isArray(ledger.readers) ||
    !Number.isFinite(age) ||
    age < -60000 ||
    age > maxAgeMs
  )
    throw Error("RECOVERY_LEDGER_STALE_OR_INVALID");
  return ledger;
}
/** Isolated recovery only. Intersect current signed read grants, replay deletions, then quarantine ALL restored workspaces.
 * Never reopen a restored image with historical Owner/session/credential grants. Current identity/access import must precede promotion.
 */
export async function secureRestoredDatabase(
  pool: Pool,
  ledger: RecoveryLedger,
) {
  const name = (await pool.query("SELECT current_database() AS name")).rows[0]
    .name as string;
  if (!/^akh_ops_restore_[a-f0-9]{32}$/.test(name))
    throw Error("ISOLATED_RESTORE_DATABASE_REQUIRED");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "CREATE TEMP TABLE current_recovery_readers(workspace_id text,kind text,resource_id text,principal_id text) ON COMMIT DROP",
    );
    for (const r of ledger.readers)
      await db.query(
        "INSERT INTO current_recovery_readers VALUES($1,$2,$3,$4)",
        [r.workspace_id, r.kind, r.resource_id, r.principal_id],
      );
    await db.query(
      "DELETE FROM resource_readers r WHERE NOT EXISTS(SELECT 1 FROM current_recovery_readers c WHERE c.workspace_id=r.workspace_id AND c.kind=r.kind AND c.resource_id=r.resource_id AND c.principal_id=r.principal_id)",
    );
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
  await replayTombstones(pool, ledger.tombstones);
  // Access state is intentionally NOT a restored snapshot's authority to reopen the service.
  await pool.query("DELETE FROM resource_readers");
  await pool.query(
    "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) SELECT id,'restore-quarantine','source','__all__','[]','[]',false,'recovery-verifier' FROM workspaces ON CONFLICT DO NOTHING",
  );
  const deletedHashes: string[] = [];
  for (const sha of new Set(
    ledger.tombstones
      .filter((t) => t.delete_content)
      .flatMap((t) => t.blob_hashes),
  )) {
    const live = await pool.query(
      "SELECT 1 FROM storage_blobs b WHERE b.sha256=$1 AND NOT EXISTS(SELECT 1 FROM operations_tombstones t WHERE t.workspace_id=b.workspace_id AND t.resource_kind=b.parent_kind AND t.resource_id=b.parent_id AND t.delete_content AND t.blob_hashes ? b.sha256) LIMIT 1",
      [sha],
    );
    if (!live.rowCount) deletedHashes.push(sha);
  }
  return {
    quarantined: true,
    requiresCurrentIdentityImport: true,
    deletedHashes,
  };
}
export async function assertOperationalStartup(pool: Pool) {
  if (
    (
      await pool.query(
        "SELECT 1 FROM operations_tombstones WHERE id='restore-quarantine' LIMIT 1",
      )
    ).rowCount
  )
    throw Error(
      "RESTORED_DATABASE_QUARANTINED_CURRENT_IDENTITY_IMPORT_REQUIRED",
    );
}
