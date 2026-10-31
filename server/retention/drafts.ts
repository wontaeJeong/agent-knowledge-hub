import type { PoolClient } from "pg";
import type { Context } from "../service";
import { fingerprint } from "../provenance";

export const draftRetirementId = (owner: string, id: string) =>
  fingerprint([owner, id]);
export async function isDraftRetired(db: PoolClient, ctx: Context, id: string) {
  return !!(
    await db.query(
      "SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='draft' AND artifact_id=$2",
      [ctx.workspaceId, draftRetirementId(ctx.principalId, id)],
    )
  ).rowCount;
}
export async function assertDraftNotRetired(
  db: PoolClient,
  ctx: Context,
  id: string,
) {
  if (await isDraftRetired(db, ctx, id)) throw Error("NOT_FOUND");
}

/** After importing the signed current operations ledger, before releasing restore quarantine. */
export async function replayRetentionTombstones(
  db: PoolClient,
  workspaceId: string,
) {
  const rows = await db.query(
    "SELECT owner_id,id FROM workflow_drafts WHERE workspace_id=$1 UNION SELECT owner_id,draft_id AS id FROM workflow_draft_revision_history WHERE workspace_id=$1 UNION SELECT owner_id,draft_id AS id FROM workflow_draft_save_mutations WHERE workspace_id=$1 UNION SELECT owner_id,binding->>'id' AS id FROM workflow_draft_recovery_grants WHERE workspace_id=$1 LIMIT 10001",
    [workspaceId],
  );
  if (rows.rows.length > 10000) throw Error("RETENTION_GRAPH_BOUND");
  for (const row of rows.rows) {
    const ctx = { workspaceId, principalId: row.owner_id };
    if (await isDraftRetired(db, ctx, row.id)) {
      await db.query(
        "DELETE FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
        [workspaceId, row.owner_id, row.id],
      );
      await db.query(
        "DELETE FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [workspaceId, row.owner_id, row.id],
      );
      await db.query(
        "DELETE FROM workflow_draft_save_mutations WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [workspaceId, row.owner_id, row.id],
      );
      await db.query(
        "DELETE FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2 AND binding->>'id'=$3",
        [workspaceId, row.owner_id, row.id],
      );
    }
  }
}
