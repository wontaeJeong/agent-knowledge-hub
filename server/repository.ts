import type { PoolClient } from "pg";
import type { Context } from "./service";
import type { Role, State, Page, Source } from "../src/domain/types";
import type { Batch } from "../src/domain/wiki";
import { effectiveAccess } from "./access/index";
import { appendOperationalAudit } from "./operations/service";

export async function membership(db: PoolClient, ctx: Context): Promise<Role> {
  const modern = await db.query(
    "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
  if (modern.rowCount || ctx.authorization || ctx.credentialId) {
    await ctx.authorization?.assertSession(db);
    const a = await effectiveAccess(db, ctx);
    if (!a.role) throw Error("NOT_FOUND");
    // Compatibility FK rows are not authority. Only the modern engine above can admit this principal.
    await db.query(
      "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT DO NOTHING",
      [ctx.workspaceId, ctx.principalId],
    );
    // Legacy role prechecks describe the space role, never a delegated action bundle.
    // Each managed operation separately authorizes its exact action and credential ceiling.
    return ["maintain", "admin"].includes(a.role)
      ? "reviewer"
      : a.role === "write"
        ? "editor"
        : "reader";
  }
  // Historical service-level fixtures only. No runtime session can enter this branch.
  const r = await db.query(
    "SELECT role FROM memberships WHERE workspace_id=$1 AND principal_id=$2 FOR SHARE",
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
  options?: { includeSelfTrash?: boolean },
): Promise<string[]> {
  const r = await db.query(
    "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 FOR SHARE",
    [workspace, kind, id],
  );
  let result: string[] = r.rows.map((r) => r.principal_id);
  const tables = await db.query(
    "SELECT to_regclass('workflow_document_state') AS documents,to_regclass('workflow_source_state') AS sources",
  );
  if (kind === "source" && tables.rows[0].sources) {
    const s = await db.query(
      "SELECT state FROM workflow_source_state WHERE workspace_id=$1 AND source_id=$2",
      [workspace, id],
    );
    if (s.rowCount && s.rows[0].state !== "active") return [];
  }
  if (kind === "page" && tables.rows[0].documents) {
    const ancestors = await db.query(
      `WITH RECURSIVE chain AS (
      SELECT page_id,parent_id,state,ARRAY[page_id] AS visited FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2
      UNION ALL SELECT p.page_id,p.parent_id,p.state,c.visited||p.page_id FROM workflow_document_state p JOIN chain c ON p.page_id=c.parent_id
      WHERE p.workspace_id=$1 AND NOT p.page_id=ANY(c.visited)
    ) SELECT * FROM chain`,
      [workspace, id],
    );
    if (
      ancestors.rows.some(
        (p) =>
          (p.state === "trash" &&
            !(options?.includeSelfTrash && p.page_id === id)) ||
          (p.parent_id && p.visited.includes(p.parent_id)),
      )
    )
      return [];
    const parents = new Set<string>(
      ancestors.rows
        .flatMap((p) => [p.page_id, p.parent_id])
        .filter((p) => p && p !== id),
    );
    for (const parentId of parents) {
      const a = await db.query(
        "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id=$2",
        [workspace, parentId],
      );
      result = result.filter((who) =>
        a.rows.some((r) => r.principal_id === who),
      );
      const v = await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
        [workspace, parentId],
      );
      if (!v.rowCount) return [];
      for (const sourceId of new Set<string>([
        ...(v.rows[0].data.sourceIds ?? []),
        ...(v.rows[0].data.provenance?.sourceIds ?? []),
      ])) {
        const upper = await readers(db, workspace, "source", sourceId);
        result = result.filter((who) => upper.includes(who));
      }
    }
  }
  return result;
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
  const kind = operation.startsWith("source.")
    ? "source"
    : operation.startsWith("page.")
      ? "page"
      : undefined;
  await appendOperationalAudit(db, ctx, {
    operation,
    ...(kind ? { resource: { kind, id } } : {}),
  });
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
  const space = await db.query(
    "SELECT n.kind FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id WHERE s.workspace_id=$1",
    [workspace],
  );
  return {
    ...(space.rows[0]?.kind === "personal"
      ? { serverPersonalSpace: true }
      : {}),
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
