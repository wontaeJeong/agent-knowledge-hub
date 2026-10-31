import type { PoolClient } from "pg";
import type { Context } from "../service";
import { authorizeInTransaction } from "../access/index";
import { fingerprint } from "../provenance";
import { appendOperationalAudit } from "../operations/service";

export type Resource = {
  kind: "page" | "source";
  id: string;
  version?: number;
};
export async function assertPolicyTransaction(db: PoolClient) {
  // SAVEPOINT rejects an autocommit client: policy changes/guards must participate
  // in the host's short canonical transaction, never a partly committed sequence.
  await db.query("SAVEPOINT policy_transaction_check");
  await db.query("RELEASE SAVEPOINT policy_transaction_check");
}
export async function authorize(
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: Resource,
) {
  if (!ctx.authorization && !ctx.credentialId) throw Error("UNAUTHENTICATED");
  if (ctx.credentialId) {
    const credential = await db.query(
      "SELECT 1 FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked AND expires_at>clock_timestamp() FOR SHARE",
      [ctx.credentialId, ctx.principalId, ctx.workspaceId],
    );
    if (!credential.rowCount) throw Error("UNAUTHENTICATED");
  }
  await authorizeInTransaction(db, ctx, action, resource);
}
export async function policyAdmin(db: PoolClient, ctx: Context) {
  await assertPolicyTransaction(db);
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
    ctx.workspaceId,
  ]);
  if (ctx.credentialId) throw Error("FORBIDDEN");
  await authorize(db, ctx, "space.admin");
  const p = await db.query(
    "SELECT kind FROM access_principals WHERE id=$1 AND active",
    [ctx.principalId],
  );
  if (p.rows[0]?.kind !== "human") throw Error("FORBIDDEN");
}
/** Caller holds the canonical workspace transaction lock. Never call over network. */
export async function policyEvent(
  db: PoolClient,
  ctx: Context,
  operation: string,
  targetId: string,
  revision: number,
  data: unknown,
) {
  const last = await db.query(
    "SELECT sequence,hash FROM policy_events WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1",
    [ctx.workspaceId],
  );
  const sequence = Number(last.rows[0]?.sequence ?? 0) + 1;
  const previous = last.rows[0]?.hash ?? "genesis";
  const hash = fingerprint({
    sequence,
    previous,
    principalId: ctx.principalId,
    operation,
    targetId,
    revision,
    data,
  });
  await db.query(
    "INSERT INTO policy_events(workspace_id,sequence,principal_id,operation,target_id,revision,data,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      ctx.workspaceId,
      sequence,
      ctx.principalId,
      operation,
      targetId,
      revision,
      data,
      previous,
      hash,
    ],
  );
  await appendOperationalAudit(db, ctx, { operation });
  await db.query(
    "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
}
