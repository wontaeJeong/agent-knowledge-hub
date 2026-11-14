import type { PoolClient } from "pg";
import type { Context } from "../service";
import { fingerprint } from "../provenance";
import { contains, inventory, unknownPrivateReference } from "./inventory";
import { selectErasureRows } from "../operations/erasure";

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
  const gate=(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=0 AND objid=822025 AND mode='ExclusiveLock'")).rowCount;
  if (!gate) throw Error("RETENTION_EXCLUSIVE_GATE_REQUIRED");
  const retired = (await db.query(`SELECT v.page_id,v.number FROM versions v JOIN operations_erased_artifacts a ON a.workspace_id=v.workspace_id AND a.artifact_kind='published-version' AND a.artifact_id=v.page_id||'/'||v.number::text WHERE v.workspace_id=$1`,[workspaceId])).rows;
  if (retired.length) {
    const all = await inventory(db, workspaceId);
    for (const v of retired) {
      const refs = all.filter(r => {
        if (unknownPrivateReference(r) || r.table === "board_posts" || r.table === "board_comments") return true;
        if (r.table === "pages" && r.data.id === v.page_id) return false;
        if (r.table === "versions" && r.data.page_id === v.page_id) return contains(r.data.data, v.page_id);
        return contains(r.data,v.page_id);
      });
      const held=(await db.query(`SELECT 1 FROM operations_legal_holds WHERE workspace_id=$1 AND active AND (resource_kind='workspace' OR resource_kind='page' AND resource_id=$2) UNION ALL SELECT 1 FROM content_retention_holds WHERE workspace_id=$1 AND content_class='publishedVersions' LIMIT 1`,[workspaceId,v.page_id])).rowCount;
      const shared=(await db.query("SELECT 1 FROM access_shares WHERE workspace_id=$1 AND page_id=$2 AND version=$3 LIMIT 1",[workspaceId,v.page_id,v.number])).rowCount;
      if (refs.length || held || shared || !all.some(r => r.table==='versions' && r.data.page_id===v.page_id && Number(r.data.number)>v.number))
        throw Error("RETENTION_REPLAY_REFERENCE_CONFLICT");
    }
    await db.query(`DELETE FROM versions v WHERE v.workspace_id=$1 AND EXISTS (SELECT 1 FROM operations_erased_artifacts a WHERE a.workspace_id=v.workspace_id AND a.artifact_kind='published-version' AND a.artifact_id=v.page_id||'/'||v.number::text)`,[workspaceId]);
  }
  const snapshots = (await db.query(`SELECT s.id,s.source_id,s.blob_id,s.content_hash FROM storage_snapshots s JOIN operations_erased_artifacts a ON a.workspace_id=s.workspace_id AND a.artifact_kind='source-snapshot' AND a.artifact_id=s.source_id||'/'||s.content_hash WHERE s.workspace_id=$1`,[workspaceId])).rows;
  if (snapshots.length) {
    const all=await inventory(db,workspaceId);
    for (const snap of snapshots) {
      const refs=all.filter(r => {
        if (unknownPrivateReference(r) || r.table==='board_posts' || r.table==='board_comments') return true;
        if (r.table==='sources' && r.data.id===snap.source_id) return false;
        if (r.table==='storage_blobs' && r.data.parent_kind==='source' && r.data.parent_id===snap.source_id && (r.data.id===snap.blob_id || r.data.sha256!==snap.content_hash)) return false;
        if (r.table==='storage_snapshots' && (r.data.id===snap.id || (r.data.source_id===snap.source_id && r.data.blob_id!==snap.blob_id && r.data.content_hash!==snap.content_hash))) return false;
        return contains(r.data,snap.source_id) || contains(r.data,snap.blob_id) || contains(r.data,snap.content_hash);
      });
      const held=(await db.query(`SELECT 1 FROM operations_legal_holds WHERE workspace_id=$1 AND active AND (resource_kind='workspace' OR resource_kind='source' AND resource_id=$2) UNION ALL SELECT 1 FROM content_retention_holds WHERE workspace_id=$1 AND content_class='sourceVersions' LIMIT 1`,[workspaceId,snap.source_id])).rowCount;
      const blob=(await db.query("SELECT parent_kind,parent_id,sha256 FROM storage_blobs WHERE workspace_id=$1 AND id=$2",[workspaceId,snap.blob_id])).rows[0];
      if (refs.length || held || !blob || blob.parent_kind!=='source' || blob.parent_id!==snap.source_id || blob.sha256!==snap.content_hash) throw Error("RETENTION_REPLAY_REFERENCE_CONFLICT");
      await db.query("DELETE FROM storage_snapshots WHERE workspace_id=$1 AND id=$2",[workspaceId,snap.id]);
      await db.query("DELETE FROM storage_tickets WHERE workspace_id=$1 AND blob_id=$2 AND revoked",[workspaceId,snap.blob_id]);
      await db.query("DELETE FROM storage_blobs WHERE workspace_id=$1 AND id=$2",[workspaceId,snap.blob_id]);
    }
  }
  const rows = await db.query(
    "SELECT owner_id,id FROM workflow_drafts WHERE workspace_id=$1 UNION SELECT owner_id,draft_id AS id FROM workflow_draft_revision_history WHERE workspace_id=$1 UNION SELECT owner_id,draft_id AS id FROM workflow_draft_save_mutations WHERE workspace_id=$1 UNION SELECT owner_id,binding->>'id' AS id FROM workflow_draft_recovery_grants WHERE workspace_id=$1 LIMIT 10001",
    [workspaceId],
  );
  if (rows.rows.length > 10000) throw Error("RETENTION_GRAPH_BOUND");
  for (const row of rows.rows) {
    const ctx = { workspaceId, principalId: row.owner_id };
    if (await isDraftRetired(db, ctx, row.id)) {
      const all=await inventory(db,workspaceId);
      const draft=all.find(r=>r.table==='workflow_drafts' && r.data.owner_id===row.owner_id && r.data.id===row.id);
      const refs=all.filter(r=> {
        if (unknownPrivateReference(r)) return true;
        if (["board_posts","board_comments","question_turns","question_feedback","agent_outcomes","agent_personal_pages","agent_personal_revisions","agent_requests","imports"].includes(r.table)) return true;
        if (r===draft) return false;
        if (r.data.owner_id===row.owner_id && (["workflow_draft_revision_history","workflow_draft_save_mutations"].includes(r.table) && r.data.draft_id===row.id || r.table==='workflow_draft_recovery_grants' && (r.data.binding as {id?:string})?.id===row.id)) return false;
        return contains(r.data,row.id);
      });
      const holds=(await db.query("SELECT resource_kind,resource_id FROM operations_legal_holds WHERE workspace_id=$1 AND active",[workspaceId])).rows;
      const classHold=(await db.query("SELECT 1 FROM content_retention_holds WHERE workspace_id=$1 AND content_class='drafts'",[workspaceId])).rowCount;
      if (refs.length || classHold || holds.some(h=>h.resource_kind==='workspace' || (draft && selectErasureRows(all,{kind:h.resource_kind,id:h.resource_id}).includes(draft)))) throw Error("RETENTION_REPLAY_REFERENCE_CONFLICT");
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
