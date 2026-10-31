import type { Pool } from "pg";
import { MUTATION_GATE } from "./gate";

/**
 * Test-only precursor. A receipt is a write fence, not proof of approval.
 * A standalone operational entry point could revoke on a failed/blocked
 * request. Do not import this outside tests or mount it in any route.
 */
export async function revokeWorkspaceCredentials(
  pool: Pool,
  workspaceId: string,
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Match the existing global lock order: gate before any workspace row.
    await db.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    const workspace = await db.query(
      "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
      [workspaceId],
    );
    if (!workspace.rowCount) throw Error("NOT_FOUND");
    const fence = await db.query(
      "SELECT EXISTS(SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND scope='workspace' AND status IN ('blocked','completed')) AS fenced",
      [workspaceId],
    );
    if (!fence.rows[0].fenced) throw Error("ERASURE_FENCE_REQUIRED");
    // The schema does not enforce these relationships across workspace/owner.
    // Refuse both incoming and outgoing malformed references before any update.
    const malformed = await db.query(
      `SELECT EXISTS (
      SELECT 1 FROM agent_api_keys k JOIN agent_device_clients c ON c.id=k.device_client_id
        WHERE (k.workspace_id=$1 OR c.workspace_id=$1) AND (k.workspace_id<>c.workspace_id OR k.principal_id<>c.principal_id)
      UNION ALL SELECT 1 FROM agent_device_grants g JOIN agent_device_clients c ON c.id=g.client_id
        WHERE (g.workspace_id=$1 OR c.workspace_id=$1) AND (g.workspace_id<>c.workspace_id OR (g.status='approved' AND g.approved_by IS DISTINCT FROM c.principal_id))
      UNION ALL SELECT 1 FROM agent_key_audit a JOIN agent_api_keys k ON k.id=a.key_id
        WHERE (a.workspace_id=$1 OR k.workspace_id=$1) AND a.workspace_id<>k.workspace_id
    ) AS present`,
      [workspaceId],
    );
    if (malformed.rows[0].present)
      throw Error("ERASURE_CREDENTIAL_SCOPE_MISMATCH");
    await db.query(
      "UPDATE agent_api_keys SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND revoked_at IS NULL",
      [workspaceId],
    );
    await db.query(
      "UPDATE agent_device_clients SET active=false WHERE workspace_id=$1 AND active",
      [workspaceId],
    );
    await db.query(
      "UPDATE agent_device_grants SET status='denied' WHERE workspace_id=$1 AND status IN ('pending','approved')",
      [workspaceId],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
