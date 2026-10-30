import type { PoolClient } from "pg";
import type { Context } from "./service";
import type { Role, State, Page, Source } from "../src/domain/types";
import type { Batch } from "../src/domain/wiki";

export async function membership(db: PoolClient, ctx: Context): Promise<Role> {
  const r = await db.query(
    "SELECT effective_membership(workspace_id,principal_id) AS role FROM memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE",
    [ctx.workspaceId, ctx.principalId],
  );
  if (!r.rowCount || !r.rows[0].role) throw Error("NOT_FOUND");
  return r.rows[0].role;
}
export async function readers(
  db: PoolClient,
  workspace: string,
  kind: string,
  id: string,
): Promise<string[]> {
  const r = await db.query(
    "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND effective_membership(workspace_id,principal_id) IS NOT NULL FOR SHARE",
    [workspace, kind, id],
  );
  return r.rows.map((r) => r.principal_id);
}
export async function requireRead(
  db: PoolClient,
  ctx: Context,
  kind: string,
  id: string,
) {
  if (!(await readers(db, ctx.workspaceId, kind, id)).includes(ctx.principalId))
    throw Error("NOT_FOUND");
}
export async function addResource(
  db: PoolClient,
  workspace: string,
  kind: string,
  id: string,
  audience: string[],
) {
  await db.query("INSERT INTO resources VALUES($1,$2,$3)", [
    workspace,
    kind,
    id,
  ]);
  for (const principal of audience) {
    await db.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
      workspace,
      kind,
      id,
      principal,
    ]);
  }
}
export async function audit(
  db: PoolClient,
  ctx: Context,
  operation: string,
  id: string,
) {
  await db.query(
    "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,$2,$3,$4)",
    [ctx.workspaceId, ctx.principalId, operation, id],
  );
}

/** Internal canonical state only; never send this aggregate to a client. */
export async function loadState(
  db: PoolClient,
  workspace: string,
): Promise<State> {
  const pages = await db.query(
    "SELECT data FROM pages WHERE workspace_id=$1 ORDER BY id",
    [workspace],
  );
  const versions = await db.query(
    "SELECT page_id,data FROM versions WHERE workspace_id=$1 ORDER BY number",
    [workspace],
  );
  const sources = await db.query(
    "SELECT data FROM sources WHERE workspace_id=$1 ORDER BY id",
    [workspace],
  );
  const batches = await db.query(
    "SELECT data FROM batches WHERE workspace_id=$1 ORDER BY id",
    [workspace],
  );
  return {
    schemaVersion: 1,
    role: "reviewer",
    pages: pages.rows.map((r) => ({
      ...r.data,
      versions: versions.rows
        .filter((v) => v.page_id === r.data.id)
        .map((v) => v.data),
    })) as Page[],
    sources: sources.rows.map((r) => r.data) as Source[],
    changes: [],
    runs: [],
    audit: [],
    shares: [],
    schedule: { daily: "", weekly: "", enabled: false },
    knowledge: {
      batches: batches.rows.map((r) => r.data) as Batch[],
      answers: [],
      issues: [],
    },
  };
}
