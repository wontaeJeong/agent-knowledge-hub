import type { PoolClient } from "pg";
import type { Context } from "../service";
/** Call only after full current authorization, inside the document-read transaction. */
export async function recordDocumentVisit(
  db: PoolClient,
  ctx: Context,
  pageId: string,
) {
  await db.query(
    "INSERT INTO workflow_activity(workspace_id,principal_id,page_id,kind,at) VALUES($1,$2,$3,'recent',now()) ON CONFLICT(workspace_id,principal_id,page_id,kind) DO UPDATE SET at=now()",
    [ctx.workspaceId, ctx.principalId, pageId],
  );
}
