import type { PoolClient } from "pg";
import { MUTATION_GATE } from "./gate";

/** Called only inside an approved erasure/replay transaction with the exclusive
 * mutation gate. A failed or blocked receipt alone is never authorization. */
export async function assertCredentialErasureScope(db: PoolClient, workspaceId: string) {
  const malformed = await db.query(`SELECT EXISTS (
    SELECT 1 FROM agent_api_keys k JOIN agent_device_clients c ON c.id=k.device_client_id
      WHERE (k.workspace_id=$1 OR c.workspace_id=$1) AND (k.workspace_id<>c.workspace_id OR k.principal_id<>c.principal_id)
    UNION ALL SELECT 1 FROM agent_device_grants g JOIN agent_device_clients c ON c.id=g.client_id
      WHERE (g.workspace_id=$1 OR c.workspace_id=$1) AND (g.workspace_id<>c.workspace_id OR (g.status='approved' AND g.approved_by IS DISTINCT FROM c.principal_id))
    UNION ALL SELECT 1 FROM agent_key_audit a JOIN agent_api_keys k ON k.id=a.key_id
      WHERE (a.workspace_id=$1 OR k.workspace_id=$1) AND a.workspace_id<>k.workspace_id
  ) AS present`, [workspaceId]);
  if (malformed.rows[0].present) throw Error("ERASURE_CREDENTIAL_SCOPE_MISMATCH");
}

export async function retireErasedCredentials(db: PoolClient, workspaceId: string) {
  await assertCredentialErasureScope(db, workspaceId);
  await db.query("UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE workspace_id=$1", [workspaceId]);
  await db.query("UPDATE agent_device_clients SET active=false WHERE workspace_id=$1", [workspaceId]);
  await db.query("UPDATE agent_device_grants SET status='denied' WHERE workspace_id=$1 AND status IN ('pending','approved')", [workspaceId]);
  // Optional feature migrations may not exist in an older installation. When
  // present, erase only the inspected authority schemas; unknown shape fails
  // the same transaction rather than silently retaining a new authority form.
  const schemas: Record<string, string[]> = {
    legacy_compat_memberships: ["workspace_id:text:NO","principal_id:text:NO","role:text:NO","subject:text:NO","revoked:boolean:NO","captured_at:timestamp with time zone:NO"],
    storage_collector_connections: ["workspace_id:text:NO","id:text:NO","principal_id:text:NO","configuration_hash:text:NO","active:boolean:NO","revision:integer:NO","created_at:timestamp with time zone:NO"],
  };
  for (const [table, expected] of Object.entries(schemas)) {
    const cols=(await db.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
    if (!cols.length) continue;
    const actual=cols.map(c=>`${c.column_name}:${c.data_type}:${c.is_nullable}`).sort();
    if (JSON.stringify(actual)!==JSON.stringify([...expected].sort())) throw Error("ERASURE_AUTHORITY_SCHEMA_UNSUPPORTED");
    if (table === "legacy_compat_memberships")
      await db.query("UPDATE legacy_compat_memberships SET revoked=true WHERE workspace_id=$1 AND NOT revoked",[workspaceId]);
    else
      await db.query("UPDATE storage_collector_connections SET active=false,revision=revision+1 WHERE workspace_id=$1 AND active",[workspaceId]);
  }
}

/** Trusted writes use the same transaction/gate as publication, before recording
 * plaintext metadata. Never revive a space whose approved erasure is fenced. */
export async function assertProductWritesNotErased(db: PoolClient, workspaceId: string, pageId: string) {
  const gate = await db.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=0 AND objid=$1 AND mode IN ('ShareLock','ExclusiveLock')`, [MUTATION_GATE]);
  if (!gate.rowCount) throw Error("ERASURE_MUTATION_GATE_REQUIRED");
  const r = await db.query(`SELECT EXISTS(
    SELECT 1 FROM operations_tombstones WHERE workspace_id=$1 AND resource_kind='page' AND resource_id=$2 AND delete_content
    UNION ALL SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND scope='workspace' AND
      (status='completed' OR (status='blocked' AND error_code IN ('PHYSICAL_BLOB_PURGE_REQUIRED','SHARED_LIVE_BLOB_RETAINED')))
  ) AS fenced`, [workspaceId, pageId]);
  if (r.rows[0].fenced) throw Error("ERASURE_PRODUCT_WRITES_FENCED");
}
