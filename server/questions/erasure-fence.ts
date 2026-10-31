import type { PoolClient } from "pg";

/** Called inside a transaction holding the shared mutation gate. */
export async function assertQuestionWritesNotErased(
  db: PoolClient,
  workspaceId: string,
) {
  const result = await db.query(
    "SELECT EXISTS(SELECT 1 FROM operations_tombstones WHERE workspace_id=$1 AND delete_content UNION ALL SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND scope='workspace' AND status IN ('completed','blocked')) AS fenced",
    [workspaceId],
  );
  if (result.rows[0].fenced) throw Error("ERASURE_QUESTION_WRITES_FENCED");
}
