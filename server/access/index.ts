import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { readers } from "../repository";
import { acquireSharedMutationGate } from "../operations/gate";
import { appendOperationalAudit } from "../operations/service";

export const spaceRoles = [
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
] as const;
export type SpaceRole = (typeof spaceRoles)[number];
export const actionRoles = {
  "knowledge.read": "read",
  "comment.write": "read",
  "queue.triage": "triage",
  "source.create": "write",
  "changeset.propose": "write",
  "lint.run": "write",
  "personal.sync": "write",
  "changeset.approve": "maintain",
  "changeset.publish": "maintain",
  "policy.strengthen": "maintain",
  "space.admin": "admin",
  "usage.read_aggregate": "admin",
  "draft.write": "write",
  "triage.manage": "triage",
  "knowledge.protect": "maintain",
  "lifecycle.manage": "maintain",
  "share.manage": "admin",
  "data.export": "read",
  "local.copy": "read",
} as const;
export type Action = keyof typeof actionRoles;
const delegated = new Set<Action>([
  "knowledge.read",
  "source.create",
  "changeset.propose",
  "personal.sync",
  "lint.run",
  "local.copy",
]);
const ident = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const role = z.enum(spaceRoles);
const expiry = z.iso
  .datetime({ offset: true })
  .refine(
    (v) =>
      Date.parse(v) > Date.now() && Date.parse(v) < Date.now() + 366 * 86400000,
  );
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type DB = Pick<PoolClient, "query">;
export async function recordAccessAudit(
  db: DB,
  ctx: Context,
  operation: string,
  targetId: string,
  data: unknown = {},
) {
  const workspace = await db.query("SELECT id FROM workspaces WHERE id=$1", [
    ctx.workspaceId,
  ]);
  await db.query(
    "INSERT INTO access_audit(principal_id,operation,workspace_id,target_id,data) VALUES($1,$2,$3,$4,$5)",
    [
      ctx.principalId,
      operation,
      workspace.rowCount ? ctx.workspaceId : null,
      targetId,
      data,
    ],
  );
  if (workspace.rowCount)
    await appendOperationalAudit(db as PoolClient, ctx, {
      operation,
      ...(operation === "source.egress-policy"
        ? { resource: { kind: "source" as const, id: targetId } }
        : {}),
    });
}
export type SpaceDescriptor = {
  id: string;
  namespaceId: string;
  namespaceKind: "personal" | "team";
  namespaceSlug: string;
  slug: string;
  visibility: "private" | "team" | "company";
  policyVersion: number;
  owner: boolean;
};
export type EffectiveAccess = {
  role: SpaceRole | null;
  capabilities: string[];
  paths: { role: SpaceRole; via: string }[];
  space: SpaceDescriptor;
};

export async function effectiveAccess(
  db: DB,
  ctx: Context,
): Promise<EffectiveAccess> {
  const r = await db.query(
    `SELECT s.*,n.kind,n.slug AS namespace_slug,n.owner_id,p.kind AS principal_kind,p.company_reader,p.team_create
    FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id
    JOIN access_principals p ON p.id=$2 AND p.active
      AND (p.kind='human' OR EXISTS(SELECT 1 FROM access_service_accounts sa JOIN access_principals sponsor ON sponsor.id=sa.sponsor_id AND sponsor.active AND sponsor.kind='human' JOIN access_team_members sm ON sm.principal_id=sponsor.id AND sm.team_id=sa.namespace_id AND sm.active WHERE sa.principal_id=p.id AND sa.namespace_id=s.namespace_id AND sa.expires_at>clock_timestamp()))
    WHERE s.workspace_id=$1 AND s.active FOR SHARE OF p`,
    [ctx.workspaceId, ctx.principalId],
  );
  if (!r.rowCount) throw Error("NOT_FOUND");
  const s = r.rows[0];
  if (s.principal_kind === "service")
    await db.query(
      "SELECT p.id FROM access_service_accounts sa JOIN access_principals p ON p.id=sa.sponsor_id WHERE sa.principal_id=$1 FOR SHARE OF p",
      [ctx.principalId],
    );
  const paths: EffectiveAccess["paths"] = [];
  const member = await db.query(
    "SELECT role FROM access_team_members WHERE team_id=$1 AND principal_id=$2 AND active",
    [s.namespace_id, ctx.principalId],
  );
  const owner =
    s.kind === "personal"
      ? s.owner_id === ctx.principalId
      : member.rows[0]?.role === "owner";
  if (s.kind === "personal" && !owner) throw Error("NOT_FOUND");
  if (owner) paths.push({ role: "admin", via: "owner" });
  if (member.rowCount) {
    const grants = await db.query(
      `SELECT g.role,g.principal_id,g.group_id FROM access_grants g
      WHERE g.workspace_id=$1 AND NOT g.revoked AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
      AND (g.principal_id=$2 OR g.group_id IN (SELECT gm.group_id FROM access_group_members gm JOIN access_groups ag ON ag.id=gm.group_id WHERE gm.principal_id=$2 AND ag.team_id=$3))`,
      [ctx.workspaceId, ctx.principalId, s.namespace_id],
    );
    for (const g of grants.rows)
      paths.push({
        role: g.role,
        via: g.group_id ? `group:${g.group_id}` : "direct",
      });
    if (s.visibility === "team" && s.principal_kind === "human")
      paths.push({ role: "read", via: "visibility:team" });
  }
  if (
    s.visibility === "company" &&
    s.company_reader &&
    s.principal_kind === "human"
  )
    paths.push({ role: "read", via: "visibility:company" });
  let best: SpaceRole | null = null;
  for (const p of paths)
    if (best === null || spaceRoles.indexOf(p.role) > spaceRoles.indexOf(best))
      best = p.role;
  let capabilities = Object.entries(actionRoles)
    .filter(
      ([, min]) =>
        best !== null && spaceRoles.indexOf(best) >= spaceRoles.indexOf(min),
    )
    .map(([a]) => a);
  // Visibility grants only allow published reads/comments, never raw/queue access.
  const direct = paths.some((p) => !p.via.startsWith("visibility:"));
  if (!direct)
    capabilities = capabilities.filter(
      (a) => a === "knowledge.read" || a === "comment.write",
    );
  if (s.principal_kind !== "human")
    capabilities = capabilities.filter((a) => delegated.has(a as Action));
  if (ctx.credentialId) {
    const c = await db.query(
      "SELECT actions FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked AND expires_at>clock_timestamp()",
      [ctx.credentialId, ctx.principalId, ctx.workspaceId],
    );
    if (!c.rowCount) throw Error("UNAUTHENTICATED");
    capabilities = capabilities.filter(
      (a) => delegated.has(a as Action) && c.rows[0].actions.includes(a),
    );
  } else if (s.principal_kind === "human") {
    capabilities.push("space.create");
    if (s.team_create || process.env.ACCESS_ALLOW_ORG_CREATE === "true")
      capabilities.push("team.create");
    if (owner && s.kind === "team") capabilities.push("team.admin");
  }
  return {
    role: best,
    capabilities,
    paths,
    space: {
      id: ctx.workspaceId,
      namespaceId: s.namespace_id,
      namespaceKind: s.kind,
      namespaceSlug: s.namespace_slug,
      slug: s.slug,
      visibility: s.visibility,
      policyVersion: s.policy_version,
      owner,
    },
  };
}

/** Common server authorization. Resource checks narrow, never widen, current raw ACLs. */
export async function authorizeActionDb(
  db: DB,
  ctx: Context,
  action: Action,
  resource?: { kind: "page" | "source"; id: string; version?: number },
) {
  const a = await effectiveAccess(db, ctx);
  let shared = false;
  if (
    resource?.kind === "page" &&
    resource.version &&
    action === "knowledge.read" &&
    !ctx.credentialId &&
    a.space.namespaceKind === "team"
  ) {
    const m = await db.query(
      "SELECT 1 FROM access_team_members WHERE team_id=$1 AND principal_id=$2 AND active",
      [a.space.namespaceId, ctx.principalId],
    );
    if (m.rowCount)
      shared = !!(
        await db.query(
          `SELECT 1 FROM access_shares WHERE workspace_id=$1 AND page_id=$2 AND version=$3 AND NOT revoked AND expires_at>clock_timestamp() AND $4=ANY(actions) AND (principal_id=$5 OR group_id IN (SELECT group_id FROM access_group_members WHERE principal_id=$5))`,
          [
            ctx.workspaceId,
            resource.id,
            resource.version,
            action,
            ctx.principalId,
          ],
        )
      ).rowCount;
  }
  if (!a.role && !shared) throw Error("NOT_FOUND");
  if (!a.capabilities.includes(action) && !shared) throw Error("FORBIDDEN");
  if (resource) {
    ident.parse(resource.id);
    const manageTrash = action === "lifecycle.manage";
    if (
      !(
        await readers(
          db as PoolClient,
          ctx.workspaceId,
          resource.kind,
          resource.id,
          { includeSelfTrash: manageTrash },
        )
      ).includes(ctx.principalId)
    )
      throw Error("NOT_FOUND");
    if (
      resource.kind === "source" &&
      (action === "data.export" || action === "local.copy")
    ) {
      const p = await db.query(
        "SELECT local_copy_allowed,export_allowed FROM access_source_policy WHERE workspace_id=$1 AND source_id=$2",
        [ctx.workspaceId, resource.id],
      );
      if (
        p.rows[0]?.[
          action === "data.export" ? "export_allowed" : "local_copy_allowed"
        ] !== true
      )
        throw Error("FORBIDDEN");
    }
    if (resource.kind === "page") {
      const pending = [resource.id],
        seen = new Set<string>();
      while (pending.length) {
        const pageId = pending.pop()!;
        if (seen.has(pageId)) continue;
        seen.add(pageId);
        if (
          !(
            await readers(db as PoolClient, ctx.workspaceId, "page", pageId, {
              includeSelfTrash: manageTrash && pageId === resource.id,
            })
          ).includes(ctx.principalId)
        )
          throw Error("NOT_FOUND");
        const v = await db.query(
          "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND (number=(SELECT max(number) FROM versions WHERE workspace_id=$1 AND page_id=$2) OR number=$3)",
          [
            ctx.workspaceId,
            pageId,
            pageId === resource.id ? (resource.version ?? null) : null,
          ],
        );
        if (!v.rowCount) throw Error("NOT_FOUND");
        for (const row of v.rows) {
          const input = row.data;
          for (const sourceId of new Set<string>([
            ...(input.sourceIds ?? []),
            ...(input.provenance?.sourceIds ?? []),
          ])) {
            if (
              !(
                await readers(
                  db as PoolClient,
                  ctx.workspaceId,
                  "source",
                  sourceId,
                )
              ).includes(ctx.principalId)
            )
              throw Error("NOT_FOUND");
            if (action === "data.export" || action === "local.copy") {
              const s = await db.query(
                "SELECT local_copy_allowed,export_allowed FROM access_source_policy WHERE workspace_id=$1 AND source_id=$2",
                [ctx.workspaceId, sourceId],
              );
              if (
                s.rows[0]?.[
                  action === "data.export"
                    ? "export_allowed"
                    : "local_copy_allowed"
                ] !== true
              )
                throw Error("FORBIDDEN");
            }
          }
          pending.push(...(input.provenance?.pageIds ?? []));
        }
        const p = await db.query(
          "SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, pageId],
        );
        pending.push(...(p.rows[0]?.data.links ?? []));
      }
    }
  } else if (action === "data.export" || action === "local.copy") {
    throw Error("FORBIDDEN"); // Reading is never an implicit export/local-copy policy.
  }
  return a;
}
export async function authorizeAction(
  pool: Pool,
  ctx: Context,
  action: Action,
  resource?: { kind: "page" | "source"; id: string; version?: number },
) {
  return transaction(pool, ctx.workspaceId, async (db) => {
    await ctx.authorization?.assertSession(db);
    return authorizeActionDb(db, ctx, action, resource);
  });
}
/** Workflow adapter. Unknown actions fail closed, callers must already hold the workspace lock. */
export async function authorizeInTransaction(
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: { kind: "page" | "source"; id: string; version?: number },
): Promise<void> {
  if (!Object.hasOwn(actionRoles, action)) throw Error("FORBIDDEN");
  await ctx.authorization?.assertSession(db);
  await authorizeActionDb(db, ctx, action as Action, resource);
}
export async function authorizeManaged(
  db: PoolClient,
  ctx: Context,
  action: Action,
  resource?: { kind: "page" | "source"; id: string },
) {
  const s = await db.query(
    "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
  if (s.rowCount || ctx.authorization || ctx.credentialId)
    return authorizeActionDb(db, ctx, action, resource);
}
async function credentialCeiling(db: DB, ctx: Context, action: Action) {
  if (action === "local.copy") {
    if (!(await effectiveAccess(db, ctx)).capabilities.includes(action))
      throw Error("FORBIDDEN");
  } else await authorizeActionDb(db, ctx, action);
}

/** Verified identity sync deliberately never creates, restores or changes product grants. */
export async function syncIdentity(
  pool: DB,
  input: { issuer: string; subject: string; principalId?: string },
) {
  const principalId =
    input.principalId ?? hash(input.issuer + "\0" + input.subject);
  const r = await pool.query(
    "INSERT INTO access_principals(id,issuer,subject) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET issuer=coalesce(access_principals.issuer,excluded.issuer),subject=coalesce(access_principals.subject,excluded.subject) WHERE access_principals.kind='human' AND access_principals.active AND (access_principals.issuer IS NULL OR (access_principals.issuer=excluded.issuer AND access_principals.subject=excluded.subject)) RETURNING id",
    [principalId, input.issuer, input.subject],
  );
  if (!r.rowCount) throw Error("UNAUTHENTICATED");
  return principalId;
}
const bootstrapSchema = z
  .object({
    spaces: z.array(
      z
        .object({
          workspaceId: ident,
          team: z.object({ slug, name: z.string().min(1).max(100) }).strict(),
          owners: z
            .array(
              z.union([
                z.object({ principalId: ident }).strict(),
                z
                  .object({ issuer: z.url(), subject: z.string().min(1) })
                  .strict(),
              ]),
            )
            .min(1),
          grants: z
            .array(z.object({ principalId: ident, role }).strict())
            .default([]),
          reviewers: z.array(ident).default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type AccessBootstrap = z.input<typeof bootstrapSchema>;
export const validateAccessBootstrap = (input: unknown) =>
  bootstrapSchema.parse(input);
/** Explicit migration transaction, callable only by deployment/operator code, never an HTTP route. */
export async function bootstrapAccess(pool: Pool, input: AccessBootstrap) {
  const config = bootstrapSchema.parse(input);
  for (const s of config.spaces)
    await transaction(pool, s.workspaceId, async (db) => {
      if (
        (
          await db.query("SELECT 1 FROM access_spaces WHERE workspace_id=$1", [
            s.workspaceId,
          ])
        ).rowCount
      )
        return;
      const owners: string[] = [];
      for (const o of s.owners) {
        const id =
          "principalId" in o ? o.principalId : await syncIdentity(db, o);
        await db.query(
          "INSERT INTO access_principals(id,team_create) VALUES($1,true) ON CONFLICT(id) DO UPDATE SET team_create=true",
          [id],
        );
        const human = await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [id],
        );
        if (!human.rowCount) throw Error("VALIDATION_FAILED");
        owners.push(id);
      }
      const ns = randomUUID();
      await db.query(
        "INSERT INTO access_namespaces(id,kind,slug,name) VALUES($1,'team',$2,$3)",
        [ns, s.team.slug, s.team.name],
      );
      for (const id of owners)
        await db.query(
          "INSERT INTO access_team_members VALUES($1,$2,'owner',true)",
          [ns, id],
        );
      await db.query(
        "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES($1,$2,'knowledge')",
        [s.workspaceId, ns],
      );
      for (const g of s.grants) {
        await db.query(
          "INSERT INTO access_principals(id) VALUES($1) ON CONFLICT DO NOTHING",
          [g.principalId],
        );
        await db.query(
          "INSERT INTO access_team_members VALUES($1,$2,'member',true) ON CONFLICT DO NOTHING",
          [ns, g.principalId],
        );
        await db.query(
          "INSERT INTO access_grants(id,workspace_id,principal_id,role) VALUES($1,$2,$3,$4)",
          [randomUUID(), s.workspaceId, g.principalId, g.role],
        );
      }
      for (const id of s.reviewers) {
        const human = await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [id],
        );
        if (!human.rowCount) throw Error("VALIDATION_FAILED");
        const g = s.grants.find((g) => g.principalId === id);
        if (!owners.includes(id) && (!g || spaceRoles.indexOf(g.role) < 3))
          throw Error("VALIDATION_FAILED");
        await db.query("INSERT INTO access_reviewers VALUES($1,$2)", [
          s.workspaceId,
          id,
        ]);
      }
      for (const id of [...owners, ...s.grants.map((g) => g.principalId)])
        await db.query(
          "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT DO NOTHING",
          [s.workspaceId, id],
        );
      await db.query("DELETE FROM approvals WHERE workspace_id=$1", [
        s.workspaceId,
      ]);
      await db.query(
        "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,$2,'access.bootstrap',$1)",
        [s.workspaceId, owners[0]],
      );
      await recordAccessAudit(
        db,
        { workspaceId: s.workspaceId, principalId: owners[0] },
        "access.bootstrap",
        s.workspaceId,
        { namespaceId: ns, owners },
      );
    });
}

export class AccessService {
  constructor(readonly pool: Pool) {}
  async sourcePolicy(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const a = await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "source",
        id: ident.parse(id),
      });
      const p = await db.query(
        "SELECT local_copy_allowed,export_allowed,revision FROM access_source_policy WHERE workspace_id=$1 AND source_id=$2",
        [ctx.workspaceId, id],
      );
      return {
        sourceId: id,
        localCopyAllowed: p.rows[0]?.local_copy_allowed ?? false,
        exportAllowed: p.rows[0]?.export_allowed ?? false,
        revision: p.rows[0]?.revision ?? 0,
        policyVersion: a.space.policyVersion,
      };
    });
  }
  async setSourcePolicy(ctx: Context, id: string, input: unknown) {
    const b = z
      .object({
        localCopyAllowed: z.boolean(),
        exportAllowed: z.boolean(),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db) => {
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "source",
        id: ident.parse(id),
      });
      await this.bump(db, ctx, b.expectedVersion);
      await db.query(
        "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,source_id) DO UPDATE SET local_copy_allowed=excluded.local_copy_allowed,export_allowed=excluded.export_allowed,revision=access_source_policy.revision+1",
        [ctx.workspaceId, id, b.localCopyAllowed, b.exportAllowed],
      );
      await recordAccessAudit(db, ctx, "source.egress-policy", id, {
        localCopyAllowed: b.localCopyAllowed,
        exportAllowed: b.exportAllowed,
      });
      return { sourceId: id, ...b, policyVersion: b.expectedVersion + 1 };
    });
  }
  async createServicePrincipal(ctx: Context, input: unknown) {
    const b = z
      .object({ name: z.string().min(1).max(100), expiresAt: expiry })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      const id = randomUUID();
      await db.query(
        "INSERT INTO access_principals(id,kind) VALUES($1,'service')",
        [id],
      );
      await db.query(
        "INSERT INTO access_service_accounts VALUES($1,$2,$3,$4,$5)",
        [id, a.space.namespaceId, b.name, ctx.principalId, b.expiresAt],
      );
      await db.query(
        "INSERT INTO access_team_members VALUES($1,$2,'member',true)",
        [a.space.namespaceId, id],
      );
      await db.query(
        "INSERT INTO access_grants(id,workspace_id,principal_id,role) VALUES($1,$2,$3,'read')",
        [randomUUID(), ctx.workspaceId, id],
      );
      await db.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
        ctx.workspaceId,
        id,
      ]);
      await this.bump(db, ctx, a.space.policyVersion);
      return { id, spaceId: ctx.workspaceId, sponsorId: ctx.principalId, ...b };
    });
  }
  async issueServiceCredential(
    ctx: Context,
    principalId: string,
    input: unknown,
  ) {
    const b = z
      .object({
        actions: z
          .array(z.enum(Object.keys(actionRoles) as [Action, ...Action[]]))
          .min(1)
          .max(10),
        expiresAt: expiry,
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      const svc = await db.query(
        "SELECT * FROM access_service_accounts WHERE principal_id=$1 AND namespace_id=$2 AND expires_at>$3",
        [ident.parse(principalId), a.space.namespaceId, b.expiresAt],
      );
      if (!svc.rowCount) throw Error("NOT_FOUND");
      for (const action of b.actions) {
        if (!delegated.has(action)) throw Error("FORBIDDEN");
        await credentialCeiling(db, ctx, action);
        await credentialCeiling(
          db,
          { workspaceId: ctx.workspaceId, principalId },
          action,
        );
      }
      const id = randomUUID(),
        secret = `akh_${randomBytes(32).toString("base64url")}`;
      await db.query(
        "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          hash(secret),
          principalId,
          ctx.workspaceId,
          [...new Set(b.actions)],
          b.expiresAt,
        ],
      );
      return { id, secret, principalId, spaceId: ctx.workspaceId, ...b };
    });
  }
  async servicePrincipals(ctx: Context) {
    const a = await authorizeAction(this.pool, ctx, "space.admin");
    return (
      await this.pool.query(
        'SELECT s.principal_id AS id,s.name,s.sponsor_id AS "sponsorId",s.expires_at AS "expiresAt",p.active FROM access_service_accounts s JOIN access_principals p ON p.id=s.principal_id WHERE s.namespace_id=$1',
        [a.space.namespaceId],
      )
    ).rows;
  }
  async updateServicePrincipal(ctx: Context, id: string, input: unknown) {
    const b = z
      .object({
        sponsorId: ident,
        expiresAt: expiry,
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      await this.activeMember(db, a.space.namespaceId, b.sponsorId);
      const human = await db.query(
        "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
        [b.sponsorId],
      );
      if (!human.rowCount) throw Error("NOT_FOUND");
      const r = await db.query(
        "UPDATE access_service_accounts SET sponsor_id=$3,expires_at=$4 WHERE principal_id=$1 AND namespace_id=$2 RETURNING principal_id",
        [ident.parse(id), a.space.namespaceId, b.sponsorId, b.expiresAt],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      await this.bump(db, ctx, b.expectedVersion);
      return { id, ...b };
    });
  }
  async serviceCredentials(ctx: Context, id: string) {
    const a = await authorizeAction(this.pool, ctx, "space.admin");
    return (
      await this.pool.query(
        'SELECT c.id,c.workspace_id AS "spaceId",c.actions,c.expires_at AS "expiresAt",c.revoked,c.last_used_at AS "lastUsedAt" FROM access_credentials c JOIN access_service_accounts s ON s.principal_id=c.principal_id WHERE s.namespace_id=$1 AND s.principal_id=$2 AND c.workspace_id=$3',
        [a.space.namespaceId, ident.parse(id), ctx.workspaceId],
      )
    ).rows;
  }
  async revokeServiceCredential(
    ctx: Context,
    id: string,
    credentialId: string,
  ) {
    return this.mutate(ctx, "space.admin", async (db, a) => {
      await db.query(
        "UPDATE access_credentials c SET revoked=true FROM access_service_accounts s WHERE s.principal_id=c.principal_id AND s.namespace_id=$1 AND s.principal_id=$2 AND c.workspace_id=$3 AND c.id=$4",
        [
          a.space.namespaceId,
          ident.parse(id),
          ctx.workspaceId,
          ident.parse(credentialId),
        ],
      );
      await recordAccessAudit(
        db,
        ctx,
        "service.credential.revoke",
        credentialId,
      );
      return { ok: true };
    });
  }
  async deleteSpace(ctx: Context, input: unknown) {
    const b = z
      .object({
        expectedVersion: z.number().int().positive(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      if (!a.space.owner) throw Error("FORBIDDEN");
      await this.bump(db, ctx, b.expectedVersion);
      await db.query(
        "UPDATE access_spaces SET active=false WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      await db.query(
        "UPDATE access_credentials SET revoked=true WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      return { ok: true };
    });
  }
  async revokeServicePrincipal(ctx: Context, id: string) {
    return this.mutate(ctx, "space.admin", async (db, a) => {
      const r = await db.query(
        "SELECT 1 FROM access_service_accounts WHERE principal_id=$1 AND namespace_id=$2",
        [ident.parse(id), a.space.namespaceId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      await db.query("UPDATE access_principals SET active=false WHERE id=$1", [
        id,
      ]);
      await db.query(
        "UPDATE access_credentials SET revoked=true WHERE principal_id=$1",
        [id],
      );
      await this.bump(db, ctx, a.space.policyVersion);
      return { ok: true };
    });
  }
  async createShare(ctx: Context, input: unknown) {
    const b = z
      .object({
        pageId: ident,
        version: z.number().int().positive(),
        principalId: ident.optional(),
        groupId: ident.optional(),
        actions: z.array(z.literal("knowledge.read")).length(1),
        expiresAt: expiry,
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .refine((v) => !!v.principalId !== !!v.groupId)
      .parse(input);
    return this.mutate(ctx, "share.manage", async (db, a) => {
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: b.pageId,
        version: b.version,
      });
      let targets: string[];
      if (b.principalId) targets = [b.principalId];
      else {
        const g = await db.query(
          "SELECT 1 FROM access_groups WHERE id=$1 AND team_id=$2",
          [b.groupId, a.space.namespaceId],
        );
        if (!g.rowCount) throw Error("NOT_FOUND");
        targets = (
          await db.query(
            "SELECT principal_id FROM access_group_members WHERE group_id=$1",
            [b.groupId],
          )
        ).rows.map((r) => r.principal_id);
      }
      const version = await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3",
        [ctx.workspaceId, b.pageId, b.version],
      );
      if (!version.rowCount || !targets.length) throw Error("NOT_FOUND");
      for (const target of targets) {
        await this.activeMember(db, a.space.namespaceId, target);
        await this.assertShareInputs(
          db,
          { workspaceId: ctx.workspaceId, principalId: target },
          b.pageId,
          b.version,
        );
      }
      const id = randomUUID();
      await this.bump(db, ctx, b.expectedVersion);
      await db.query(
        "INSERT INTO access_shares(id,workspace_id,page_id,version,principal_id,group_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          ctx.workspaceId,
          b.pageId,
          b.version,
          b.principalId ?? null,
          b.groupId ?? null,
          b.actions,
          b.expiresAt,
        ],
      );
      return { id, ...b };
    });
  }
  async assertShareInputs(
    db: PoolClient,
    ctx: Context,
    pageId: string,
    version: number,
  ) {
    const pending = [{ id: pageId, version }],
      seen = new Set<string>();
    while (pending.length) {
      const p = pending.pop()!;
      if (seen.has(`${p.id}:${p.version}`)) continue;
      seen.add(`${p.id}:${p.version}`);
      if (
        !(await readers(db, ctx.workspaceId, "page", p.id)).includes(
          ctx.principalId,
        )
      )
        throw Error("NOT_FOUND");
      const r = await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND (number=$3 OR number=(SELECT max(number) FROM versions WHERE workspace_id=$1 AND page_id=$2))",
        [ctx.workspaceId, p.id, p.version],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      for (const v of r.rows) {
        for (const sid of new Set<string>([
          ...(v.data.sourceIds ?? []),
          ...(v.data.provenance?.sourceIds ?? []),
        ]))
          if (
            !(await readers(db, ctx.workspaceId, "source", sid)).includes(
              ctx.principalId,
            )
          )
            throw Error("NOT_FOUND");
        for (const id of v.data.provenance?.pageIds ?? [])
          pending.push({ id, version: 1 });
      }
      const meta = await db.query(
        "SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, p.id],
      );
      for (const id of meta.rows[0]?.data.links ?? [])
        pending.push({ id, version: 1 });
    }
  }
  async shares(ctx: Context) {
    await authorizeAction(this.pool, ctx, "space.admin");
    return (
      await this.pool.query(
        'SELECT id,page_id AS "pageId",version,principal_id AS "principalId",group_id AS "groupId",actions,expires_at AS "expiresAt",revoked FROM access_shares WHERE workspace_id=$1',
        [ctx.workspaceId],
      )
    ).rows;
  }
  async revokeShare(ctx: Context, id: string, expectedVersion: number) {
    return this.mutate(ctx, "share.manage", async (db) => {
      await this.bump(db, ctx, expectedVersion);
      await db.query(
        "UPDATE access_shares SET revoked=true WHERE id=$1 AND workspace_id=$2",
        [ident.parse(id), ctx.workspaceId],
      );
      return { ok: true };
    });
  }
  async readShare(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      const r = await db.query(
        "SELECT * FROM access_shares WHERE workspace_id=$1 AND id=$2 AND NOT revoked AND expires_at>clock_timestamp() AND (principal_id=$3 OR group_id IN (SELECT group_id FROM access_group_members WHERE principal_id=$3))",
        [ctx.workspaceId, ident.parse(id), ctx.principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      const s = r.rows[0];
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: s.page_id,
        version: s.version,
      });
      await this.assertShareInputs(db, ctx, s.page_id, s.version);
      const v = await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3",
        [ctx.workspaceId, s.page_id, s.version],
      );
      return {
        id: s.page_id,
        version: s.version,
        content: v.rows[0].data.content,
      };
    });
  }
  async savePersonal(ctx: Context, id: string, hash: string, key: string) {
    const a = await this.effective(ctx);
    if (
      ctx.credentialId ||
      !a.space.owner ||
      a.space.namespaceKind !== "personal"
    )
      throw Error("FORBIDDEN");
    const { approve, publish } = await import("../publication");
    await approve(this.pool, ctx, ident.parse(id), hash);
    return publish(this.pool, ctx, id, hash, key);
  }
  effective(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, (db) =>
      effectiveAccess(db, ctx),
    );
  }
  async spaces(ctx: Context) {
    if (ctx.credentialId) {
      const a = await this.effective(ctx);
      return a.role
        ? [{ ...a.space, role: a.role, capabilities: a.capabilities }]
        : [];
    }
    const rows = await this.pool.query(
      "SELECT workspace_id FROM access_spaces WHERE active ORDER BY workspace_id",
    );
    const result = [];
    for (const r of rows.rows)
      try {
        const a = await this.effective({ ...ctx, workspaceId: r.workspace_id });
        if (a.role)
          result.push({
            ...a.space,
            role: a.role,
            capabilities: a.capabilities,
          });
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
      }
    return result;
  }
  async teams(ctx: Context) {
    if (ctx.credentialId) throw Error("FORBIDDEN");
    return (
      await this.pool.query(
        `SELECT n.id,n.slug,n.name,n.version,m.role FROM access_namespaces n JOIN access_team_members m ON m.team_id=n.id JOIN access_principals p ON p.id=m.principal_id AND p.active WHERE m.principal_id=$1 AND m.active ORDER BY n.slug`,
        [ctx.principalId],
      )
    ).rows;
  }
  async teamMembers(ctx: Context, teamId: string) {
    return this.globalTransaction(ctx, "team.members.read", async (db) => {
      const n = await this.teamOwner(db, ctx, teamId);
      return {
        teamId,
        version: n.version,
        items: (
          await db.query(
            'SELECT m.principal_id AS "principalId",m.role,m.active,p.kind FROM access_team_members m JOIN access_principals p ON p.id=m.principal_id WHERE team_id=$1 ORDER BY principal_id',
            [teamId],
          )
        ).rows,
        invitations: (
          await db.query(
            'SELECT id,principal_id AS "principalId",kind,status,expires_at AS "expiresAt" FROM access_invitations WHERE team_id=$1 ORDER BY expires_at',
            [teamId],
          )
        ).rows,
      };
    });
  }
  async accessFor(ctx: Context, principalId?: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      const actor = await authorizeActionDb(db, ctx, "knowledge.read");
      let target = ctx;
      if (principalId && principalId !== ctx.principalId) {
        await authorizeActionDb(db, ctx, "space.admin");
        ident.parse(principalId);
        if (actor.space.namespaceKind !== "team") throw Error("NOT_FOUND");
        await this.activeMember(db, actor.space.namespaceId, principalId);
        target = { workspaceId: ctx.workspaceId, principalId };
      }
      const a = await effectiveAccess(db, target);
      const grants = actor.capabilities.includes("space.admin")
        ? (
            await db.query(
              'SELECT id,principal_id AS "principalId",group_id AS "groupId",role,expires_at AS "expiresAt",revoked FROM access_grants WHERE workspace_id=$1 ORDER BY id',
              [ctx.workspaceId],
            )
          ).rows
        : [];
      return {
        ...a,
        principalId: target.principalId,
        grants,
        blockedReasons: a.role ? [] : ["NO_SPACE_GRANT"],
      };
    });
  }
  async members(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const actor = await authorizeActionDb(db, ctx, "space.admin");
      const candidates =
        actor.space.namespaceKind === "personal"
          ? [ctx.principalId]
          : (
              await db.query(
                "SELECT m.principal_id FROM access_team_members m JOIN access_principals p ON p.id=m.principal_id WHERE m.team_id=$1 AND m.active AND p.active ORDER BY m.principal_id",
                [actor.space.namespaceId],
              )
            ).rows.map((r) => r.principal_id as string);
      const result = [];
      for (const principalId of candidates) {
        try {
          const a = await effectiveAccess(db, {
            workspaceId: ctx.workspaceId,
            principalId,
          });
          if (a.role)
            result.push({
              principalId,
              role: a.capabilities.includes("changeset.approve")
                ? "reviewer"
                : a.capabilities.includes("changeset.propose")
                  ? "editor"
                  : "reader",
              spaceRole: a.role,
            });
        } catch (e) {
          if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
        }
      }
      return result;
    });
  }
  async principal(db: DB, ctx: Context) {
    const r = await db.query(
      "SELECT * FROM access_principals WHERE id=$1 AND active AND kind='human'",
      [ctx.principalId],
    );
    if (!r.rowCount || ctx.credentialId) throw Error("FORBIDDEN");
    return r.rows[0];
  }
  async teamOwner(db: DB, ctx: Context, teamId: string) {
    await this.principal(db, ctx);
    const r = await db.query(
      "SELECT n.* FROM access_namespaces n JOIN access_team_members m ON m.team_id=n.id WHERE n.id=$1 AND n.kind='team' AND m.principal_id=$2 AND m.active AND m.role='owner' FOR UPDATE OF n",
      [ident.parse(teamId), ctx.principalId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    return r.rows[0];
  }
  async mutate<T>(
    ctx: Context,
    action: Action,
    run: (db: PoolClient, a: EffectiveAccess) => Promise<T>,
  ) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      await this.principal(db, ctx);
      const a = await authorizeActionDb(db, ctx, action);
      const before = (
        await db.query(
          "SELECT id,principal_id,group_id,role,expires_at,revoked FROM access_grants WHERE workspace_id=$1 ORDER BY id",
          [ctx.workspaceId],
        )
      ).rows;
      const result = await run(db, a);
      const after = (
        await db.query(
          "SELECT id,principal_id,group_id,role,expires_at,revoked FROM access_grants WHERE workspace_id=$1 ORDER BY id",
          [ctx.workspaceId],
        )
      ).rows;
      await recordAccessAudit(db, ctx, action, ctx.workspaceId, {
        actorRole: a.role,
        policyVersion: a.space.policyVersion,
        grantsBefore: before,
        grantsAfter: after,
      });
      await db.query(
        "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,$2,$3,$1)",
        [ctx.workspaceId, ctx.principalId, action],
      );
      return result;
    });
  }
  async bump(db: DB, ctx: Context, expected: number) {
    if (!Number.isInteger(expected)) throw Error("VALIDATION_FAILED");
    const r = await db.query(
      "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1 AND policy_version=$2 RETURNING policy_version",
      [ctx.workspaceId, expected],
    );
    if (!r.rowCount) throw Error("STALE_VERSION");
    await this.retireApprovals(db, [ctx.workspaceId]);
    return r.rows[0].policy_version as number;
  }
  async retireApprovals(db: DB, spaceIds: string[]) {
    await db.query("DELETE FROM approvals WHERE workspace_id=ANY($1::text[])", [
      spaceIds,
    ]);
    await db.query(
      "UPDATE batches SET data=jsonb_set(data,'{status}','\"pending\"') WHERE workspace_id=ANY($1::text[]) AND data->>'status'='approved'",
      [spaceIds],
    );
  }
  async createTeam(ctx: Context, input: unknown) {
    const b = z
      .object({ slug, name: z.string().min(1).max(100) })
      .strict()
      .parse(input);
    return this.globalTransaction(ctx, "team.create", async (db) => {
      const p = await this.principal(db, ctx);
      if (!p.team_create && process.env.ACCESS_ALLOW_ORG_CREATE !== "true")
        throw Error("FORBIDDEN");
      const owned = await db.query(
        "SELECT count(*)::int AS n FROM access_team_members WHERE principal_id=$1 AND role='owner' AND active",
        [ctx.principalId],
      );
      if (owned.rows[0].n >= 20) throw Error("RATE_LIMITED");
      const id = randomUUID();
      await db.query(
        "INSERT INTO access_namespaces(id,kind,slug,name) VALUES($1,'team',$2,$3)",
        [id, b.slug, b.name],
      );
      await db.query(
        "INSERT INTO access_team_members VALUES($1,$2,'owner',true)",
        [id, ctx.principalId],
      );
      return { id, ...b, role: "owner", version: 1 };
    });
  }
  async globalTransaction<T>(
    ctx: Context,
    operation: string,
    run: (db: PoolClient) => Promise<T>,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      await acquireSharedMutationGate(db);
      await db.query("SELECT pg_advisory_xact_lock(720292)");
      await ctx.authorization?.assertSession(db);
      const r = await run(db);
      await recordAccessAudit(
        db,
        ctx,
        operation,
        typeof r === "object" && r && "id" in r && typeof r.id === "string"
          ? r.id
          : ctx.workspaceId,
      );
      await db.query("COMMIT");
      return r;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async createSpace(ctx: Context, input: unknown) {
    const b = z
      .object({ slug, teamId: ident.optional() })
      .strict()
      .parse(input);
    return this.globalTransaction(ctx, "space.create", async (db) => {
      await this.principal(db, ctx);
      let ns: string;
      if (b.teamId) {
        await this.teamOwner(db, ctx, b.teamId);
        ns = b.teamId;
      } else {
        const existing = await db.query(
          "SELECT id FROM access_namespaces WHERE kind='personal' AND owner_id=$1",
          [ctx.principalId],
        );
        ns = existing.rows[0]?.id ?? randomUUID();
        if (!existing.rowCount)
          await db.query(
            "INSERT INTO access_namespaces(id,kind,slug,name,owner_id) VALUES($1,'personal',$2,'Personal',$3)",
            [ns, `user-${ctx.principalId}`, ctx.principalId],
          );
      }
      const id = randomUUID();
      await db.query("INSERT INTO workspaces VALUES($1)", [id]);
      await db.query(
        "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES($1,$2,$3)",
        [id, ns, b.slug],
      );
      await db.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
        id,
        ctx.principalId,
      ]);
      if (b.teamId) await this.ensureCompatibilityMembers(db, ns, id);
      return (await effectiveAccess(db, { ...ctx, workspaceId: id })).space;
    });
  }
  async activeMember(db: DB, teamId: string, principalId: string) {
    const r = await db.query(
      "SELECT 1 FROM access_team_members m JOIN access_principals p ON p.id=m.principal_id AND p.active WHERE team_id=$1 AND principal_id=$2 AND m.active",
      [teamId, principalId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
  }
  /** FK rows only: effective_membership/authorizeAction still return NONE without a grant. */
  async ensureCompatibilityMembers(
    db: DB,
    namespaceId: string,
    workspaceId?: string,
  ) {
    await db.query(
      "INSERT INTO memberships(workspace_id,principal_id,role) SELECT s.workspace_id,m.principal_id,'reader' FROM access_spaces s JOIN access_team_members m ON m.team_id=s.namespace_id AND m.active JOIN access_principals p ON p.id=m.principal_id AND p.active WHERE s.namespace_id=$1 AND s.active AND ($2::text IS NULL OR s.workspace_id=$2) ON CONFLICT DO NOTHING",
      [namespaceId, workspaceId ?? null],
    );
  }
  async invite(ctx: Context, teamId: string, input: unknown) {
    const b = z
      .object({
        principalId: ident,
        expiresAt: expiry,
        kind: z.enum(["member", "owner-transfer"]).default("member"),
      })
      .strict()
      .parse(input);
    return this.globalTransaction(ctx, "team.invite", async (db) => {
      await this.teamOwner(db, ctx, teamId);
      const p = await db.query(
        "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
        [b.principalId],
      );
      if (!p.rowCount || b.principalId === ctx.principalId)
        throw Error("VALIDATION_FAILED");
      const id = randomUUID();
      await db.query(
        "INSERT INTO access_invitations(id,team_id,principal_id,kind,from_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [id, teamId, b.principalId, b.kind, ctx.principalId, b.expiresAt],
      );
      return { id, teamId, ...b, status: "pending" };
    });
  }
  async invitations(ctx: Context) {
    await this.principal(this.pool, ctx);
    return (
      await this.pool.query(
        'SELECT id,team_id AS "teamId",kind,expires_at AS "expiresAt",status FROM access_invitations WHERE principal_id=$1 AND status=\'pending\' AND expires_at>now()',
        [ctx.principalId],
      )
    ).rows;
  }
  async acceptInvite(ctx: Context, id: string) {
    return this.globalTransaction(ctx, "team.invite.accept", async (db) => {
      await this.principal(db, ctx);
      const r = await db.query(
        "SELECT * FROM access_invitations WHERE id=$1 AND principal_id=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE",
        [ident.parse(id), ctx.principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      const i = r.rows[0];
      // Inert protocol metadata, written only by authorized server code/migration.
      // All qualification and resulting rights still use canonical tables/actions.
      const metadata = (
        await db.query(
          "SELECT data FROM access_audit WHERE operation='legacy.invitation' AND target_id=$1 ORDER BY id DESC LIMIT 1",
          [i.id],
        )
      ).rows[0]?.data;
      const targetSpace =
        typeof metadata?.workspaceId === "string" ? metadata.workspaceId : null;
      const inviter = {
        workspaceId: targetSpace ?? ctx.workspaceId,
        principalId: i.from_id,
      };
      if (targetSpace) await authorizeActionDb(db, inviter, "space.admin");
      else await this.teamOwner(db, inviter, i.team_id);
      await this.lockTeamSpaces(db, i.team_id);
      if (targetSpace) {
        await authorizeActionDb(db, inviter, "space.admin");
        const target = await db.query(
          "SELECT 1 FROM access_spaces WHERE workspace_id=$1 AND namespace_id=$2 AND active",
          [targetSpace, i.team_id],
        );
        if (!target.rowCount) throw Error("NOT_FOUND");
        try {
          await this.activeMember(db, i.team_id, ctx.principalId);
        } catch {
          throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
        }
        const grantedRole = role.parse(
          z
            .enum(["Read", "Triage", "Write", "Maintain", "Admin"])
            .parse(metadata.role)
            .toLowerCase(),
        );
        const grant = await db.query(
          "SELECT id FROM access_grants WHERE workspace_id=$1 AND principal_id=$2",
          [targetSpace, ctx.principalId],
        );
        if (grant.rowCount)
          await db.query(
            "UPDATE access_grants SET role=$2,expires_at=NULL,revoked=false WHERE id=$1",
            [grant.rows[0].id, grantedRole],
          );
        else
          await db.query(
            "INSERT INTO access_grants(id,workspace_id,principal_id,role) VALUES($1,$2,$3,$4)",
            [randomUUID(), targetSpace, ctx.principalId, grantedRole],
          );
        await db.query(
          "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT DO NOTHING",
          [targetSpace, ctx.principalId],
        );
      } else
        await db.query(
          "INSERT INTO access_team_members VALUES($1,$2,$3,true) ON CONFLICT(team_id,principal_id) DO UPDATE SET active=true,role=CASE WHEN access_team_members.active AND access_team_members.role='owner' THEN 'owner' ELSE excluded.role END",
          [
            i.team_id,
            ctx.principalId,
            i.kind === "owner-transfer" ? "owner" : "member",
          ],
        );
      if (
        !targetSpace &&
        i.kind === "owner-transfer" &&
        metadata?.retainPreviousOwner !== true
      )
        await db.query(
          "UPDATE access_team_members SET role='member' WHERE team_id=$1 AND principal_id=$2",
          [i.team_id, i.from_id],
        );
      await db.query(
        "UPDATE access_invitations SET status='accepted' WHERE id=$1",
        [id],
      );
      if (!targetSpace) await this.ensureCompatibilityMembers(db, i.team_id);
      await this.invalidateTeam(db, i.team_id);
      return { id, status: "accepted" };
    });
  }
  async revokeInvite(ctx: Context, teamId: string, id: string) {
    return this.globalTransaction(ctx, "team.invite.revoke", async (db) => {
      await this.teamOwner(db, ctx, teamId);
      await db.query(
        "UPDATE access_invitations SET status='revoked' WHERE id=$1 AND team_id=$2 AND status='pending'",
        [ident.parse(id), teamId],
      );
      return { ok: true };
    });
  }
  async lockTeamSpaces(db: DB, teamId: string) {
    await db.query(
      "SELECT w.id FROM workspaces w JOIN access_spaces s ON s.workspace_id=w.id WHERE s.namespace_id=$1 ORDER BY w.id FOR UPDATE OF w",
      [teamId],
    );
  }
  async invalidateTeam(db: DB, teamId: string) {
    await db.query(
      "UPDATE access_spaces SET policy_version=policy_version+1 WHERE namespace_id=$1",
      [teamId],
    );
    const spaces = await db.query(
      "SELECT workspace_id FROM access_spaces WHERE namespace_id=$1",
      [teamId],
    );
    await this.retireApprovals(
      db,
      spaces.rows.map((r) => r.workspace_id),
    );
    await db.query(
      "UPDATE access_namespaces SET version=version+1 WHERE id=$1",
      [teamId],
    );
  }
  async removeMember(
    ctx: Context,
    teamId: string,
    principalId: string,
    expectedVersion?: number,
  ) {
    return this.globalTransaction(ctx, "team.member.remove", async (db) => {
      const team = await this.teamOwner(db, ctx, teamId);
      if (expectedVersion !== undefined && team.version !== expectedVersion)
        throw Error("STALE_VERSION");
      await this.lockTeamSpaces(db, teamId);
      const owners = await db.query(
        "SELECT principal_id FROM access_team_members WHERE team_id=$1 AND role='owner' AND active",
        [teamId],
      );
      if (
        owners.rows.some((r) => r.principal_id === principalId) &&
        owners.rowCount === 1
      )
        throw Error("LAST_OWNER");
      await db.query(
        "UPDATE access_team_members SET active=false WHERE team_id=$1 AND principal_id=$2",
        [teamId, ident.parse(principalId)],
      );
      await db.query(
        "UPDATE access_invitations SET status='revoked' WHERE team_id=$1 AND (principal_id=$2 OR from_id=$2) AND status='pending'",
        [teamId, principalId],
      );
      await db.query(
        "UPDATE access_grants SET revoked=true WHERE principal_id=$2 AND workspace_id IN (SELECT workspace_id FROM access_spaces WHERE namespace_id=$1)",
        [teamId, principalId],
      );
      await db.query(
        "DELETE FROM access_group_members WHERE principal_id=$2 AND group_id IN (SELECT id FROM access_groups WHERE team_id=$1)",
        [teamId, principalId],
      );
      await db.query(
        "UPDATE access_credentials SET revoked=true WHERE principal_id=$2 AND workspace_id IN (SELECT workspace_id FROM access_spaces WHERE namespace_id=$1)",
        [teamId, principalId],
      );
      await this.invalidateTeam(db, teamId);
      return { ok: true };
    });
  }
  async groups(ctx: Context, teamId?: string) {
    if (ctx.credentialId) throw Error("FORBIDDEN");
    return (
      await this.pool.query(
        `SELECT g.id,g.team_id AS "teamId",g.name FROM access_groups g JOIN access_team_members m ON m.team_id=g.team_id WHERE m.principal_id=$1 AND m.active AND ($2::text IS NULL OR g.team_id=$2) ORDER BY g.name`,
        [ctx.principalId, teamId ?? null],
      )
    ).rows;
  }
  async createGroup(ctx: Context, input: unknown) {
    const b = z
      .object({
        teamId: ident,
        name: z.string().min(1).max(100),
        principalIds: z.array(ident).max(100).default([]),
      })
      .strict()
      .parse(input);
    return this.globalTransaction(ctx, "group.create", async (db) => {
      await this.teamOwner(db, ctx, b.teamId);
      await this.lockTeamSpaces(db, b.teamId);
      for (const p of b.principalIds) await this.activeMember(db, b.teamId, p);
      const id = randomUUID();
      await db.query("INSERT INTO access_groups VALUES($1,$2,$3)", [
        id,
        b.teamId,
        b.name,
      ]);
      for (const p of new Set(b.principalIds))
        await db.query("INSERT INTO access_group_members VALUES($1,$2)", [
          id,
          p,
        ]);
      await this.invalidateTeam(db, b.teamId);
      return { id, ...b };
    });
  }
  async setGroupMembers(ctx: Context, id: string, input: unknown) {
    const b = z
      .object({
        principalIds: z.array(ident).max(100),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.globalTransaction(ctx, "group.members.update", async (db) => {
      const g = await db.query("SELECT * FROM access_groups WHERE id=$1", [
        ident.parse(id),
      ]);
      if (!g.rowCount) throw Error("NOT_FOUND");
      const n = await this.teamOwner(db, ctx, g.rows[0].team_id);
      if (n.version !== b.expectedVersion) throw Error("STALE_VERSION");
      await this.lockTeamSpaces(db, n.id);
      for (const p of b.principalIds) await this.activeMember(db, n.id, p);
      await db.query("DELETE FROM access_group_members WHERE group_id=$1", [
        id,
      ]);
      for (const p of new Set(b.principalIds))
        await db.query("INSERT INTO access_group_members VALUES($1,$2)", [
          id,
          p,
        ]);
      await this.invalidateTeam(db, n.id);
      return { ok: true };
    });
  }
  async setGrant(ctx: Context, input: unknown) {
    const b = z
      .object({
        principalId: ident.optional(),
        groupId: ident.optional(),
        role,
        expiresAt: expiry.optional(),
        expectedVersion: z.number().int().positive(),
      })
      .strict()
      .refine((b) => !!b.principalId !== !!b.groupId)
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      if (b.principalId)
        await this.activeMember(db, a.space.namespaceId, b.principalId);
      else {
        const g = await db.query(
          "SELECT 1 FROM access_groups WHERE id=$1 AND team_id=$2",
          [b.groupId, a.space.namespaceId],
        );
        if (!g.rowCount) throw Error("NOT_FOUND");
      }
      await this.bump(db, ctx, b.expectedVersion);
      const existing = await db.query(
        "SELECT id FROM access_grants WHERE workspace_id=$1 AND (principal_id=$2 OR group_id=$3)",
        [ctx.workspaceId, b.principalId ?? null, b.groupId ?? null],
      );
      const id = existing.rows[0]?.id ?? randomUUID();
      if (existing.rowCount)
        await db.query(
          "UPDATE access_grants SET role=$2,expires_at=$3,revoked=false WHERE id=$1",
          [id, b.role, b.expiresAt ?? null],
        );
      else
        await db.query(
          "INSERT INTO access_grants(id,workspace_id,principal_id,group_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            ctx.workspaceId,
            b.principalId ?? null,
            b.groupId ?? null,
            b.role,
            b.expiresAt ?? null,
          ],
        );
      if (b.principalId)
        await db.query(
          "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT DO NOTHING",
          [ctx.workspaceId, b.principalId],
        );
      if (b.groupId)
        await db.query(
          "INSERT INTO memberships SELECT $1,principal_id,'reader' FROM access_group_members WHERE group_id=$2 ON CONFLICT DO NOTHING",
          [ctx.workspaceId, b.groupId],
        );
      return { id, ...b };
    });
  }
  async removeGrant(ctx: Context, target: string, expectedVersion: number) {
    return this.mutate(ctx, "space.admin", async (db) => {
      await this.bump(db, ctx, expectedVersion);
      await db.query(
        "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND (principal_id=$2 OR group_id=$2 OR id=$2)",
        [ctx.workspaceId, ident.parse(target)],
      );
      return { ok: true };
    });
  }
  async reviewPolicy(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const a = await authorizeActionDb(db, ctx, "knowledge.read");
      const r = await db.query(
        "SELECT minimum_approvals FROM access_spaces WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      return {
        minimumApprovals: r.rows[0].minimum_approvals,
        reviewerIds: (
          await db.query(
            "SELECT principal_id FROM access_reviewers WHERE workspace_id=$1 ORDER BY principal_id",
            [ctx.workspaceId],
          )
        ).rows.map((r) => r.principal_id),
        policyVersion: a.space.policyVersion,
        documentTypes: (
          await db.query(
            'SELECT document_type AS "documentType",minimum_approvals AS "minimumApprovals",reviewer_ids AS "reviewerIds" FROM access_review_rules WHERE workspace_id=$1 ORDER BY document_type',
            [ctx.workspaceId],
          )
        ).rows,
      };
    });
  }
  async setReviewPolicy(ctx: Context, input: unknown) {
    const b = z
      .object({
        minimumApprovals: z.number().int().min(1).max(10),
        reviewerIds: z.array(ident).max(100),
        expectedVersion: z.number().int().positive(),
        documentTypes: z
          .array(
            z
              .object({
                documentType: z.string().min(1).max(100),
                minimumApprovals: z.number().int().min(1).max(10),
                reviewerIds: z.array(ident).max(100),
              })
              .strict(),
          )
          .max(100)
          .optional(),
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "policy.strengthen", async (db, a) => {
      const old = await db.query(
        "SELECT minimum_approvals FROM access_spaces WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      if (b.minimumApprovals < old.rows[0].minimum_approvals && !a.space.owner)
        throw Error("FORBIDDEN");
      const oldReviewers = (
        await db.query(
          "SELECT principal_id FROM access_reviewers WHERE workspace_id=$1 ORDER BY principal_id",
          [ctx.workspaceId],
        )
      ).rows.map((r) => r.principal_id);
      const oldRules = (
        await db.query(
          'SELECT document_type AS "documentType",minimum_approvals AS "minimumApprovals",reviewer_ids AS "reviewerIds" FROM access_review_rules WHERE workspace_id=$1 ORDER BY document_type',
          [ctx.workspaceId],
        )
      ).rows;
      const sameIds = (one: string[], two: string[]) =>
        JSON.stringify([...new Set(one)].sort()) ===
        JSON.stringify([...new Set(two)].sort());
      if (
        !a.capabilities.includes("space.admin") &&
        (!sameIds(oldReviewers, b.reviewerIds) ||
          b.minimumApprovals < old.rows[0].minimum_approvals ||
          b.documentTypes !== undefined)
      )
        throw Error("FORBIDDEN");
      if (
        b.documentTypes &&
        !a.space.owner &&
        oldRules.some(
          (old) =>
            !b.documentTypes!.some(
              (next) =>
                next.documentType === old.documentType &&
                next.minimumApprovals >= old.minimumApprovals &&
                next.reviewerIds.every((id) => old.reviewerIds.includes(id)),
            ),
        )
      )
        throw Error("FORBIDDEN");
      for (const id of new Set([
        ...b.reviewerIds,
        ...(b.documentTypes ?? []).flatMap((r) => r.reviewerIds),
      ])) {
        const p = await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [id],
        );
        if (
          !p.rowCount ||
          !(
            await effectiveAccess(db, {
              workspaceId: ctx.workspaceId,
              principalId: id,
            })
          ).capabilities.includes("changeset.approve")
        )
          throw Error("VALIDATION_FAILED");
      }
      await this.bump(db, ctx, b.expectedVersion);
      await db.query(
        "UPDATE access_spaces SET minimum_approvals=$2 WHERE workspace_id=$1",
        [ctx.workspaceId, b.minimumApprovals],
      );
      await db.query("DELETE FROM access_reviewers WHERE workspace_id=$1", [
        ctx.workspaceId,
      ]);
      for (const id of new Set(b.reviewerIds))
        await db.query("INSERT INTO access_reviewers VALUES($1,$2)", [
          ctx.workspaceId,
          id,
        ]);
      if (b.documentTypes !== undefined) {
        if (
          new Set(b.documentTypes.map((r) => r.documentType)).size !==
          b.documentTypes.length
        )
          throw Error("VALIDATION_FAILED");
        await db.query(
          "DELETE FROM access_review_rules WHERE workspace_id=$1",
          [ctx.workspaceId],
        );
        for (const r of b.documentTypes)
          await db.query(
            "INSERT INTO access_review_rules VALUES($1,$2,$3,$4)",
            [
              ctx.workspaceId,
              r.documentType,
              r.minimumApprovals,
              [...new Set(r.reviewerIds)],
            ],
          );
      }
      return { ...b, policyVersion: b.expectedVersion + 1 };
    });
  }
  async setVisibility(ctx: Context, input: unknown) {
    const b = z
      .object({
        visibility: z.enum(["private", "team"]),
        expectedVersion: z.number().int().positive(),
        confirmImpact: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.mutate(ctx, "space.admin", async (db, a) => {
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      await this.bump(db, ctx, b.expectedVersion);
      await db.query(
        "UPDATE access_spaces SET visibility=$2 WHERE workspace_id=$1",
        [ctx.workspaceId, b.visibility],
      );
      return {
        visibility: b.visibility,
        policyVersion: b.expectedVersion + 1,
        resourceRestrictionsPreserved: true,
      };
    });
  }
  async issueCredential(ctx: Context, input: unknown) {
    const b = z
      .object({
        actions: z
          .array(z.enum(Object.keys(actionRoles) as [Action, ...Action[]]))
          .min(1)
          .max(10),
        expiresAt: expiry,
      })
      .strict()
      .parse(input);
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.principal(db, ctx);
      await ctx.authorization?.assertSession(db);
      for (const action of b.actions) {
        if (!delegated.has(action)) throw Error("FORBIDDEN");
        await credentialCeiling(db, ctx, action);
      }
      const id = randomUUID(),
        secret = `akh_${randomBytes(32).toString("base64url")}`;
      await db.query(
        "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          hash(secret),
          ctx.principalId,
          ctx.workspaceId,
          [...new Set(b.actions)],
          b.expiresAt,
        ],
      );
      await recordAccessAudit(db, ctx, "credential.issue", id, {
        actions: b.actions,
        expiresAt: b.expiresAt,
      });
      return { id, secret, spaceId: ctx.workspaceId, ...b };
    });
  }
  async credentials(ctx: Context) {
    await this.principal(this.pool, ctx);
    return (
      await this.pool.query(
        'SELECT id,workspace_id AS "spaceId",actions,expires_at AS "expiresAt",revoked,last_used_at AS "lastUsedAt" FROM access_credentials WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at',
        [ctx.workspaceId, ctx.principalId],
      )
    ).rows;
  }
  async revokeCredential(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.principal(db, ctx);
      await ctx.authorization?.assertSession(db);
      await db.query(
        "UPDATE access_credentials SET revoked=true WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
        [ident.parse(id), ctx.workspaceId, ctx.principalId],
      );
      await recordAccessAudit(db, ctx, "credential.revoke", id);
      return { ok: true };
    });
  }
  async authenticateCredential(
    secret: string,
    spaceId?: string,
  ): Promise<Context> {
    const r = await this.pool.query(
      "SELECT id,workspace_id,principal_id FROM access_credentials WHERE hash=$1 AND NOT revoked AND expires_at>clock_timestamp()",
      [hash(secret)],
    );
    if (!r.rowCount) throw Error("UNAUTHENTICATED");
    const c = r.rows[0];
    if (spaceId && spaceId !== c.workspace_id) throw Error("NOT_FOUND");
    const ctx = {
      workspaceId: c.workspace_id,
      principalId: c.principal_id,
      credentialId: c.id,
    };
    const a = await this.effective(ctx);
    if (!a.role) throw Error("NOT_FOUND");
    await this.pool.query(
      "UPDATE access_credentials SET last_used_at=now() WHERE id=$1",
      [c.id],
    );
    return ctx;
  }
}
