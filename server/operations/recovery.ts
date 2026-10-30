import type { Pool } from "pg";
import {
  MUTATION_GATE,
  sealExport,
  openExport,
  replayTombstones,
  type Tombstone,
} from "./service";
import { revokeHistoricalAuthority } from "./current-policy";
import { replayProductErasure } from "./erasure";
import { hashHasLiveReference } from "../../scripts/k8s/operations-storage-graph.mjs";
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
    const legalHolds = (
      await db.query(
        "SELECT workspace_id,id,resource_kind,resource_id,active,placed_by FROM operations_legal_holds",
      )
    ).rows;
    const erasedArtifacts = (
      await db.query(
        "SELECT workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by FROM operations_erased_artifacts",
      )
    ).rows;
    const sealed = sealExport(
      {
        version: 2,
        at: new Date().toISOString(),
        tombstones,
        readers,
        legalHolds,
        erasedArtifacts,
      },
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
  version: 1 | 2;
  legalHolds?: {
    workspace_id: string;
    id: string;
    resource_kind: string;
    resource_id: string;
    active: boolean;
    placed_by: string;
  }[];
  erasedArtifacts?: {
    workspace_id: string;
    artifact_kind: string;
    artifact_id: string;
    hashes: string[];
    preview_hash: string;
    approved_by: string;
  }[];
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
    ![1, 2].includes(ledger.version) ||
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
  backupIdentity?: {
    backupId: string;
    database: string;
    systemIdentifier: string;
    databaseSha256: string;
  },
) {
  const name = (await pool.query("SELECT current_database() AS name")).rows[0]
    .name as string;
  if (!/^akh_ops_restore_[a-f0-9]{32}$/.test(name))
    throw Error("ISOLATED_RESTORE_DATABASE_REQUIRED");
  // Commit the startup barrier BEFORE any later validation/replay can fail.
  await pool.query(
    "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) SELECT id,'restore-quarantine','source','__all__','[]','[]',false,'recovery-verifier' FROM workspaces ON CONFLICT DO NOTHING",
  );
  const revoke = await pool.connect();
  try {
    await revoke.query("BEGIN");
    await revoke.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    await revokeHistoricalAuthority(revoke);
    await revoke.query("COMMIT");
  } catch (e) {
    await revoke.query("ROLLBACK");
    throw e;
  } finally {
    revoke.release();
  }
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
  const quarantine = await pool.connect();
  try {
    await quarantine.query("BEGIN");
    await quarantine.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    await quarantine.query("DELETE FROM operations_recovery_acl");
    await quarantine.query(
      "INSERT INTO operations_recovery_acl SELECT workspace_id,kind,resource_id,principal_id FROM resource_readers",
    );
    await quarantine.query("DELETE FROM resource_readers");
    await revokeHistoricalAuthority(quarantine);
    if (ledger.version === 2) {
      if (!Array.isArray(ledger.erasedArtifacts))
        throw Error("CURRENT_ARTIFACT_DELETION_LEDGER_REQUIRED");
      for (const a of ledger.erasedArtifacts)
        if (
          (
            await quarantine.query("SELECT 1 FROM workspaces WHERE id=$1", [
              a.workspace_id,
            ])
          ).rowCount
        )
          await quarantine.query(
            "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            [
              a.workspace_id,
              a.artifact_kind,
              a.artifact_id,
              JSON.stringify(a.hashes),
              a.preview_hash,
              a.approved_by,
            ],
          );
    }
    if (ledger.version === 2) {
      if (!Array.isArray(ledger.legalHolds))
        throw Error("CURRENT_LEGAL_HOLDS_REQUIRED");
      await quarantine.query("DELETE FROM operations_legal_holds");
      for (const h of ledger.legalHolds) {
        if (
          (
            await quarantine.query("SELECT 1 FROM workspaces WHERE id=$1", [
              h.workspace_id,
            ])
          ).rowCount
        )
          await quarantine.query(
            "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,active,placed_by) VALUES($1,$2,$3,$4,$5,$6)",
            [
              h.workspace_id,
              h.id,
              h.resource_kind,
              h.resource_id,
              h.active,
              h.placed_by,
            ],
          );
      }
    }
    for (const workspaceId of new Set(
      ledger.tombstones
        .filter((t) => t.delete_content)
        .map((t) => t.workspace_id),
    ))
      if (
        (
          await quarantine.query("SELECT 1 FROM workspaces WHERE id=$1", [
            workspaceId,
          ])
        ).rowCount
      )
        await replayProductErasure(
          quarantine,
          workspaceId,
          ledger.tombstones
            .filter((t) => t.workspace_id === workspaceId && t.delete_content)
            .map((t) => ({ kind: t.resource_kind, id: t.resource_id })),
        );
    await quarantine.query(
      "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) SELECT id,'restore-quarantine','source','__all__','[]','[]',false,'recovery-verifier' FROM workspaces ON CONFLICT DO NOTHING",
    );
    if (backupIdentity) {
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(backupIdentity.backupId) ||
        !/^\d+$/.test(backupIdentity.systemIdentifier) ||
        !/^[a-f0-9]{64}$/.test(backupIdentity.databaseSha256)
      )
        throw Error("INVALID_VERIFIED_BACKUP_IDENTITY");
      await quarantine.query(
        "INSERT INTO operations_recovery_releases(id,backup_id,source_database,source_system_identifier,policy_hash,preview_hash,operator_id,status) VALUES('restore-binding',$1,$2,$3,'verified-archive',$4,'restore-verifier','previewed') ON CONFLICT(id) DO UPDATE SET backup_id=excluded.backup_id,source_database=excluded.source_database,source_system_identifier=excluded.source_system_identifier,preview_hash=excluded.preview_hash",
        [
          backupIdentity.backupId,
          backupIdentity.database,
          backupIdentity.systemIdentifier,
          backupIdentity.databaseSha256,
        ],
      );
    }
    await quarantine.query("COMMIT");
  } catch (e) {
    await quarantine.query("ROLLBACK");
    throw e;
  } finally {
    quarantine.release();
  }
  const deletedHashes: string[] = [];
  const erasedHashes = (
    await pool.query(
      "SELECT DISTINCT value AS hash FROM operations_tombstones t CROSS JOIN LATERAL jsonb_array_elements_text(t.blob_hashes) WHERE t.delete_content UNION SELECT DISTINCT value AS hash FROM operations_erased_artifacts a CROSS JOIN LATERAL jsonb_array_elements_text(a.hashes)",
    )
  ).rows;
  for (const { hash: sha } of erasedHashes) {
    const check = await pool.connect();
    try {
      if (!(await hashHasLiveReference(check, sha))) deletedHashes.push(sha);
    } finally {
      check.release();
    }
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
