import type { PoolClient } from "pg";
import type { Context } from "../service";
import { effectiveAccess, authorizeInTransaction } from "../access";
import { readers } from "../repository";
import type { InputEnvelope } from "../provenance";

export async function personalOwner(db: PoolClient, ctx: Context) {
  const a = await effectiveAccess(db, ctx);
  return a.space.namespaceKind === "personal" && a.space.owner;
}
export async function qualifiedReviewers(db: PoolClient, ctx: Context) {
  const configured = new Set(
    (process.env.IMPORT_DISCLOSURE_REVIEWERS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const rows = (
    await db.query(
      "SELECT r.principal_id FROM access_reviewers r JOIN access_principals p ON p.id=r.principal_id AND p.active AND p.kind='human' WHERE r.workspace_id=$1",
      [ctx.workspaceId],
    )
  ).rows;
  const allowed: string[] = [];
  for (const row of rows) {
    const access = await effectiveAccess(db, {
      workspaceId: ctx.workspaceId,
      principalId: row.principal_id,
    });
    if (
      access.capabilities.includes("changeset.approve") &&
      configured.has(row.principal_id)
    )
      allowed.push(row.principal_id);
  }
  return allowed;
}
export async function readDisclosureInputs(
  db: PoolClient,
  ctx: Context,
  envelope: InputEnvelope,
) {
  for (const [kind, ids] of [
    ["source", envelope.sourceIds],
    ["page", envelope.pageIds],
  ] as const)
    for (const id of ids)
      await authorizeInTransaction(db, ctx, "knowledge.read", { kind, id });
}
export async function assertDisclosureAudience(
  db: PoolClient,
  ctx: Context,
  audience: string[],
  envelope?: InputEnvelope,
) {
  for (const principalId of audience)
    if (
      !(
        await effectiveAccess(db, { workspaceId: ctx.workspaceId, principalId })
      ).role
    )
      throw Error("FORBIDDEN");
  if (envelope)
    for (const [kind, ids] of [
      ["source", envelope.sourceIds],
      ["page", envelope.pageIds],
    ] as const)
      for (const id of ids) {
        const allowed = await readers(db, ctx.workspaceId, kind, id);
        if (audience.some((who) => !allowed.includes(who)))
          throw Error("SOURCE_SCOPE_CONFLICT");
      }
}
