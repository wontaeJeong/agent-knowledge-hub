import type { PoolClient } from "pg";
import type { Context } from "../../service";
import { authorizeActionDb } from "../../access/index";
import { loadState, membership } from "../../repository";
import { visiblePageIds } from "../../provenance";
import { current } from "../../../src/domain/wiki";
export type DueReviewWork = {
  pageId: string;
  version: number;
  ownerId: string | null;
  backupId: string | null;
  dueAt: string;
};
/** Current-access filtered input to collaboration delivery. This is work, not a falsehood verdict
 * or a delivery receipt. Callers must recheck each recipient immediately before dispatch. */
export async function dueReviewWork(
  db: PoolClient,
  ctx: Context,
  now = new Date(),
): Promise<DueReviewWork[]> {
  await membership(db, ctx);
  await ctx.authorization?.assertSession(db);
  await authorizeActionDb(db, ctx, "knowledge.read");
  const state = await loadState(db, ctx.workspaceId),
    visible = await visiblePageIds(db, ctx, state);
  const policies = (
    await db.query(
      "SELECT document_type,cadence_days FROM governance_type_policies WHERE workspace_id=$1",
      [ctx.workspaceId],
    )
  ).rows;
  const docs = (
    await db.query(
      "SELECT page_id,state,data FROM workflow_document_state WHERE workspace_id=$1",
      [ctx.workspaceId],
    )
  ).rows;
  const owners = (
    await db.query(
      "SELECT page_id,owner_id,backup_id FROM governance_business_owners WHERE workspace_id=$1",
      [ctx.workspaceId],
    )
  ).rows;
  const items: DueReviewWork[] = [];
  for (const page of state.pages) {
    if (!visible.has(page.id)) continue;
    const doc = docs.find((d) => d.page_id === page.id);
    if (doc && doc.state !== "active") continue;
    const days = (
      policies.find((p) => p.document_type === page.category) ??
      policies.find((p) => p.document_type === "*")
    )?.cadence_days;
    const v = current(page);
    const due = doc?.data?.reviewDue
      ? Date.parse(doc.data.reviewDue)
      : days
        ? Date.parse(page.verifiedAt ?? v.at) + days * 86400000
        : NaN;
    if (!Number.isFinite(due) || due > now.getTime()) continue;
    await authorizeActionDb(db, ctx, "knowledge.read", {
      kind: "page",
      id: page.id,
    });
    const owner = owners.find((o) => o.page_id === page.id);
    items.push({
      pageId: page.id,
      version: v.number,
      ownerId: owner?.owner_id ?? null,
      backupId: owner?.backup_id ?? null,
      dueAt: new Date(due).toISOString(),
    });
  }
  return items.sort(
    (a, b) =>
      a.dueAt.localeCompare(b.dueAt) || a.pageId.localeCompare(b.pageId),
  );
}
