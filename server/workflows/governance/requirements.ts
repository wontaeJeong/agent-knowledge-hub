import type { PoolClient } from "pg";
import type { Context } from "../../service";
import type { Draft } from "../../../src/domain/wiki";

export type PropertyWarning = {
  pageId: string;
  key: string;
  code: "PROPERTY_REQUIRED";
  mode: "warn" | "block";
};
/** Current workflow properties, not a request's claimed metadata or the legacy display owner. */
export async function publicationRequirements(
  db: PoolClient,
  ctx: Context,
  updates: Draft[],
) {
  const present = await db.query(
    "SELECT to_regclass('governance_type_policies') AS policies",
  );
  if (!present.rows[0].policies)
    return {
      warnings: [] as PropertyWarning[],
      blockers: [] as PropertyWarning[],
      policy: [] as unknown[],
    };
  const policies = (
    await db.query(
      "SELECT * FROM governance_type_policies WHERE workspace_id=$1 ORDER BY document_type",
      [ctx.workspaceId],
    )
  ).rows;
  const warnings: PropertyWarning[] = [],
    blockers: PropertyWarning[] = [];
  const metadata: unknown[] = [];
  for (const d of updates) {
    const p = (
      await db.query("SELECT data FROM pages WHERE workspace_id=$1 AND id=$2", [
        ctx.workspaceId,
        d.id,
      ])
    ).rows[0]?.data;
    const workflow = (
      await db.query(
        "SELECT revision,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, d.id],
      )
    ).rows[0];
    const owner = (
      await db.query(
        "SELECT * FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, d.id],
      )
    ).rows[0];
    const type = p?.category || "연결된 지식";
    const policy =
      policies.find((r) => r.document_type === type) ??
      policies.find((r) => r.document_type === "*");
    metadata.push({
      pageId: d.id,
      type,
      workflow: workflow ?? null,
      owner: owner ?? null,
    });
    if (!policy) continue;
    const properties = workflow?.data?.properties ?? {};
    for (const key of policy.required_keys as string[]) {
      const value =
        key === "businessOwner"
          ? owner?.owner_id
          : key === "reviewDue"
            ? workflow?.data?.reviewDue
            : key === "summary"
              ? d.summary
              : key === "tags"
                ? p?.tags
                : properties[key];
      if (
        value == null ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length)
      ) {
        const item: PropertyWarning = {
          pageId: d.id,
          key,
          code: "PROPERTY_REQUIRED",
          mode: policy.mode,
        };
        (policy.mode === "block" ? blockers : warnings).push(item);
      }
    }
  }
  return { warnings, blockers, policy: [policies, metadata] };
}
