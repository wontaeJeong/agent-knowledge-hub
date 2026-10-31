/** Released Organization/Team REST contract over the canonical access engine.
 * Organization = namespace(kind=team); legacy Team = non-nested access group.
 * Never reads legacy_v1_* tables or memberships as authorization authority.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import {
  AccessService as CanonicalAccessService,
  authorizeActionDb,
  bootstrapAccess,
  effectiveAccess,
  recordAccessAudit,
  validateAccessBootstrap,
  type EffectiveAccess,
  type SpaceRole as CanonicalRole,
} from "./index";

type DB = Pick<PoolClient, "query">;
export const spaceRoles = [
  "Read",
  "Triage",
  "Write",
  "Maintain",
  "Admin",
] as const;
export type SpaceRole = (typeof spaceRoles)[number];
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  name = z.string().trim().min(1).max(100);
const upper = (role: CanonicalRole): SpaceRole =>
  (role[0].toUpperCase() + role.slice(1)) as SpaceRole;
const lower = (role: SpaceRole) => role.toLowerCase() as CanonicalRole;
export interface AccessSpace {
  id: string;
  name: string;
  ownerId: string | null;
  orgId: string | null;
  organization: string | null;
  visibility: "private" | "team";
  role: SpaceRole;
  revision: number;
}
export interface AccessInvitation {
  id: string;
  orgId: string;
  organization: string;
  workspaceId: string | null;
  space: string | null;
  principalId: string;
  role: string;
  expiresAt: string;
  status: string;
}
export interface AccessState {
  managed: boolean;
  bootstrapAllowed: boolean;
  space: AccessSpace | null;
  capabilities: {
    manageSpace: boolean;
    manageOrganization: boolean;
    triage: boolean;
  };
  members: {
    principalId: string;
    name: string;
    role: SpaceRole | null;
    organizationRole: string | null;
    paths: string[];
  }[];
  teams: { id: string; name: string; members: string[] }[];
  grants: {
    id: string;
    principalId: string | null;
    teamId: string | null;
    role: SpaceRole;
    expiresAt: string | null;
  }[];
  reviewers: string[];
  invitations: AccessInvitation[];
  audit: {
    actorId: string;
    operation: string;
    resourceId: string;
    details: Record<string, unknown>;
    at: string;
  }[];
}

const digest = (issuer: string, subject: string) =>
  createHash("sha256")
    .update(issuer + "\0" + subject)
    .digest("hex");
const operatorBound = (who: string) =>
  (process.env.ACCESS_BOOTSTRAP_OWNERS ?? "")
    .split(",")
    .map((v) => v.trim())
    .includes(who);
async function label(db: DB, kind: string, target: string, fallback: string) {
  const row = await db.query(
    "SELECT data->>'name' AS name FROM access_audit WHERE operation=$1 AND target_id=$2 ORDER BY id DESC LIMIT 1",
    [`legacy.${kind}.name`, target],
  );
  return row.rows[0]?.name ?? fallback;
}
async function rememberName(
  db: DB,
  ctx: Context,
  kind: string,
  target: string,
  value: string,
) {
  await recordAccessAudit(db, ctx, `legacy.${kind}.name`, target, {
    name: value,
  });
}

/** Identity metadata only. Verified issuer+subject binding remains syncIdentity's job. */
export async function registerPrincipal(
  db: DB,
  principalId: string,
  displayName: string,
) {
  id.parse(principalId);
  await db.query(
    "INSERT INTO access_principals(id) VALUES($1) ON CONFLICT DO NOTHING",
    [principalId],
  );
  const p = await db.query(
    "SELECT p.active,p.kind,coalesce((SELECT a.data->>'name' FROM access_audit a WHERE a.operation='legacy.principal.name' AND a.target_id=p.id ORDER BY a.id DESC LIMIT 1),to_jsonb(p)->>'display_name',p.id) AS name FROM access_principals p WHERE p.id=$1",
    [principalId],
  );
  if (!p.rows[0]?.active || p.rows[0].kind !== "human")
    throw Error("FORBIDDEN");
  const boundedName = displayName.slice(0, 160) || principalId;
  if (p.rows[0].name === boundedName) return;
  await db.query(
    "INSERT INTO access_audit(principal_id,operation,target_id,data) VALUES($1,'legacy.principal.name',$1,$2)",
    [principalId, { name: boundedName }],
  );
}

/** Caller owns transaction; this can create only the active human's OWN private space. */
export async function personalSpace(db: DB, who: string) {
  const p = await db.query(
    "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
    [id.parse(who)],
  );
  if (!p.rowCount) throw Error("FORBIDDEN");
  const existing = await db.query(
    "SELECT s.workspace_id FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id WHERE n.kind='personal' AND n.owner_id=$1 AND s.active ORDER BY (s.workspace_id=$2) DESC,s.workspace_id LIMIT 1",
    [who, "personal-" + who],
  );
  if (existing.rowCount) return existing.rows[0].workspace_id as string;
  const ns = await db.query(
    "SELECT id FROM access_namespaces WHERE kind='personal' AND owner_id=$1",
    [who],
  );
  const namespaceId = ns.rows[0]?.id ?? randomUUID();
  if (!ns.rowCount)
    await db.query(
      "INSERT INTO access_namespaces(id,kind,slug,name,owner_id) VALUES($1,'personal',$2,'개인',$3)",
      [
        namespaceId,
        "user-" + createHash("sha256").update(who).digest("hex").slice(0, 32),
        who,
      ],
    );
  const workspaceId = "personal-" + who;
  await db.query("INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING", [
    workspaceId,
  ]);
  // Existing unowned workspace with this ID is NOT silently adopted.
  const occupied = await db.query(
    "SELECT 1 FROM resources WHERE workspace_id=$1 UNION ALL SELECT 1 FROM memberships WHERE workspace_id=$1 LIMIT 1",
    [workspaceId],
  );
  if (occupied.rowCount) throw Error("MIGRATION_REQUIRED");
  await db.query(
    "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES($1,$2,'personal')",
    [workspaceId, namespaceId],
  );
  await db.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
    workspaceId,
    who,
  ]);
  return workspaceId;
}

export class LegacyAccessService {
  readonly canonical: CanonicalAccessService;
  constructor(readonly pool: Pool) {
    this.canonical = new CanonicalAccessService(pool);
  }
  async human(db: DB, ctx: Context) {
    await this.canonical.principal(db, ctx);
    await ctx.authorization?.assertSession(db as PoolClient);
  }
  async organizations(ctx: Context) {
    await this.human(this.pool, ctx);
    return (await this.canonical.teams(ctx)).map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
    }));
  }
  async spaces(
    ctx: Context,
    db: DB = this.pool,
    selectedOnly?: string,
  ): Promise<AccessSpace[]> {
    if (ctx.credentialId) throw Error("FORBIDDEN");
    await this.canonical.principal(db, ctx);
    const rows = await db.query(
      "SELECT s.workspace_id,coalesce(to_jsonb(s)->>'name',s.slug) AS name,n.name AS organization,n.owner_id FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id WHERE s.active AND ($2::text IS NULL OR s.workspace_id=$2) AND (n.owner_id=$1 OR EXISTS(SELECT 1 FROM access_team_members m WHERE m.team_id=n.id AND m.principal_id=$1 AND m.active) OR s.visibility='company') ORDER BY s.workspace_id",
      [ctx.principalId, selectedOnly ?? null],
    );
    const result: AccessSpace[] = [];
    for (const s of rows.rows)
      try {
        const a = await effectiveAccess(db, {
          workspaceId: s.workspace_id,
          principalId: ctx.principalId,
        });
        if (!a.role) continue;
        result.push({
          id: s.workspace_id,
          name: await label(db, "space", s.workspace_id, s.name),
          ownerId: a.space.namespaceKind === "personal" ? s.owner_id : null,
          orgId: a.space.namespaceKind === "team" ? a.space.namespaceId : null,
          organization:
            a.space.namespaceKind === "team" ? s.organization : null,
          visibility: a.space.visibility === "private" ? "private" : "team",
          role: upper(a.role),
          revision: a.space.policyVersion,
        });
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
      }
    return result;
  }
  async invitationRows(
    db: DB,
    where: string,
    params: unknown[],
  ): Promise<AccessInvitation[]> {
    const rows = await db.query(
      `SELECT i.*,n.name AS organization,m.data AS metadata FROM access_invitations i JOIN access_namespaces n ON n.id=i.team_id LEFT JOIN LATERAL (SELECT data FROM access_audit WHERE operation='legacy.invitation' AND target_id=i.id ORDER BY id DESC LIMIT 1) m ON true WHERE ${where} ORDER BY i.expires_at`,
      params,
    );
    const result: AccessInvitation[] = [];
    for (const i of rows.rows) {
      const meta = i.metadata ?? {},
        workspaceId =
          typeof meta.workspaceId === "string" ? meta.workspaceId : null;
      let space: string | null = null;
      if (workspaceId) {
        const s = await db.query(
          "SELECT coalesce(to_jsonb(s)->>'name',s.slug) AS name FROM access_spaces s WHERE workspace_id=$1",
          [workspaceId],
        );
        space = s.rowCount
          ? await label(db, "space", workspaceId, s.rows[0].name)
          : null;
      }
      result.push({
        id: i.id,
        orgId: i.team_id,
        organization: i.organization,
        workspaceId,
        space,
        principalId: i.principal_id,
        role: meta.role ?? (i.kind === "owner-transfer" ? "owner" : "member"),
        expiresAt: new Date(i.expires_at).toISOString(),
        status: i.status === "revoked" ? "cancelled" : i.status,
      });
    }
    return result;
  }
  async invitations(ctx: Context) {
    await this.human(this.pool, ctx);
    return this.invitationRows(
      this.pool,
      "i.principal_id=$1 AND i.status='pending' AND i.expires_at>clock_timestamp()",
      [ctx.principalId],
    );
  }
  async state(ctx: Context): Promise<AccessState> {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      if (ctx.credentialId) throw Error("FORBIDDEN");
      const managed = (
        await db.query("SELECT 1 FROM access_spaces WHERE workspace_id=$1", [
          ctx.workspaceId,
        ])
      ).rowCount;
      const empty: AccessState = {
        managed: false,
        bootstrapAllowed: false,
        space: null,
        capabilities: {
          manageSpace: false,
          manageOrganization: false,
          triage: false,
        },
        members: [],
        teams: [],
        grants: [],
        reviewers: [],
        invitations: [],
        audit: [],
      };
      if (!managed) {
        const p = await db.query(
          "SELECT issuer,subject FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [ctx.principalId],
        );
        empty.bootstrapAllowed = !!(
          operatorBound(ctx.principalId) &&
          p.rows[0]?.issuer &&
          digest(p.rows[0].issuer, p.rows[0].subject) === ctx.principalId &&
          process.env.ACCESS_LEGACY_ADOPTION_JSON
        );
        return empty;
      }
      await this.human(db, ctx);
      const a = await authorizeActionDb(db, ctx, "knowledge.read");
      const space =
        (await this.spaces(ctx, db, ctx.workspaceId)).find(
          (s) => s.id === ctx.workspaceId,
        ) ?? null;
      if (!space) throw Error("NOT_FOUND");
      const manage = a.capabilities.includes("space.admin"),
        orgOwner = a.space.namespaceKind === "team" && a.space.owner;
      const state: AccessState = {
        ...empty,
        managed: true,
        space,
        capabilities: {
          manageSpace: manage,
          manageOrganization: orgOwner,
          triage: a.capabilities.includes("queue.triage"),
        },
      };
      if (!manage) return state;
      const groups = space.orgId
        ? (
            await db.query(
              "SELECT g.id,g.name,coalesce(array_agg(m.principal_id) FILTER(WHERE m.principal_id IS NOT NULL),ARRAY[]::text[]) AS members FROM access_groups g LEFT JOIN access_group_members m ON m.group_id=g.id WHERE g.team_id=$1 GROUP BY g.id ORDER BY g.name",
              [space.orgId],
            )
          ).rows
        : [];
      state.teams = groups;
      state.grants = (
        await db.query(
          'SELECT id,principal_id AS "principalId",group_id AS "teamId",role,expires_at AS "expiresAt" FROM access_grants WHERE workspace_id=$1 AND NOT revoked ORDER BY id',
          [ctx.workspaceId],
        )
      ).rows.map((g) => ({
        ...g,
        role: upper(g.role),
        expiresAt: g.expiresAt ? new Date(g.expiresAt).toISOString() : null,
      }));
      state.reviewers = (
        await db.query(
          "SELECT principal_id FROM access_reviewers WHERE workspace_id=$1 ORDER BY principal_id",
          [ctx.workspaceId],
        )
      ).rows.map((r) => r.principal_id);
      const members = await db.query(
        "SELECT p.id,coalesce(to_jsonb(p)->>'display_name',p.id) AS name,m.role FROM access_principals p LEFT JOIN access_team_members m ON m.principal_id=p.id AND m.team_id=$1 AND m.active WHERE (m.team_id=$1 OR p.id=$2) ORDER BY p.id",
        [space.orgId, space.ownerId],
      );
      for (const p of members.rows) {
        let own: Pick<EffectiveAccess, "role" | "paths"> = {
          role: null,
          paths: [],
        };
        try {
          own = await effectiveAccess(db, {
            workspaceId: ctx.workspaceId,
            principalId: p.id,
          });
        } catch (e) {
          if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
        }
        state.members.push({
          principalId: p.id,
          name: await label(db, "principal", p.id, p.name),
          role: own.role ? upper(own.role) : null,
          organizationRole: p.role ?? null,
          paths: own.paths.map((path) =>
            path.via === "owner"
              ? "Owner → Admin"
              : `${path.via.startsWith("group:") ? (groups.find((g) => g.id === path.via.slice(6))?.name ?? "Team") : path.via === "direct" ? "직접" : "조직 공개"} → ${upper(path.role)}`,
          ),
        });
      }
      state.invitations = (
        await this.invitationRows(
          db,
          "i.status='pending' AND i.expires_at>clock_timestamp() AND (i.team_id=$1)",
          [space.orgId],
        )
      ).filter((i) => orgOwner || i.workspaceId === ctx.workspaceId);
      state.audit = (
        await db.query(
          'SELECT principal_id AS "actorId",operation,target_id AS "resourceId",data AS details,at FROM access_audit WHERE workspace_id=$1 OR ($3 AND target_id=$2) ORDER BY id DESC LIMIT 50',
          [ctx.workspaceId, space.orgId, orgOwner],
        )
      ).rows;
      return state;
    });
  }
  async bootstrap(ctx: Context, organizationName: string) {
    name.parse(organizationName);
    if (ctx.credentialId || !operatorBound(ctx.principalId))
      throw Error("FORBIDDEN");
    await this.human(this.pool, ctx);
    const p = await this.pool.query(
      "SELECT issuer,subject FROM access_principals WHERE id=$1",
      [ctx.principalId],
    );
    if (
      !p.rows[0]?.issuer ||
      digest(p.rows[0].issuer, p.rows[0].subject) !== ctx.principalId
    )
      throw Error("FORBIDDEN");
    if (
      (
        await this.pool.query(
          "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rowCount
    )
      throw Error("ALREADY_MANAGED");
    if (!process.env.ACCESS_LEGACY_ADOPTION_JSON)
      throw Error("MIGRATION_REQUIRED");
    const config = validateAccessBootstrap(
        JSON.parse(process.env.ACCESS_LEGACY_ADOPTION_JSON),
      ),
      entry = config.spaces.find((s) => s.workspaceId === ctx.workspaceId);
    if (
      !entry ||
      !entry.owners.some(
        (o) =>
          ("principalId" in o ? o.principalId : digest(o.issuer, o.subject)) ===
          ctx.principalId,
      )
    )
      throw Error("FORBIDDEN");
    await bootstrapAccess(this.pool, {
      spaces: [{ ...entry, team: { ...entry.team, name: organizationName } }],
    });
    return {
      organizationId: (await this.canonical.effective(ctx)).space.namespaceId,
    };
  }
  async createOrganization(ctx: Context, value: string) {
    if (process.env.ACCESS_ALLOW_ORG_CREATE !== "true")
      throw Error("FORBIDDEN");
    const team = await this.canonical.createTeam(ctx, {
      slug: "org-" + randomUUID(),
      name: name.parse(value),
    });
    return { id: team.id };
  }
  async createSpace(ctx: Context, value: string, organizationId?: string) {
    name.parse(value);
    return this.canonical.globalTransaction(
      ctx,
      "legacy.space.create",
      async (db) => {
        await this.human(db, ctx);
        let workspaceId: string;
        if (!organizationId)
          workspaceId = await personalSpace(db, ctx.principalId);
        else {
          await this.canonical.teamOwner(db, ctx, id.parse(organizationId));
          const count = await db.query(
            "SELECT count(*)::integer AS n FROM access_spaces WHERE namespace_id=$1",
            [organizationId],
          );
          if (count.rows[0].n >= 100) throw Error("RATE_LIMITED");
          workspaceId = randomUUID();
          await db.query("INSERT INTO workspaces VALUES($1)", [workspaceId]);
          await db.query(
            "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES($1,$2,$3)",
            [workspaceId, organizationId, "space-" + workspaceId],
          );
          await db.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
            workspaceId,
            ctx.principalId,
          ]);
          await this.canonical.ensureCompatibilityMembers(
            db,
            organizationId,
            workspaceId,
          );
        }
        await rememberName(
          db,
          { ...ctx, workspaceId },
          "space",
          workspaceId,
          value,
        );
        return { id: workspaceId };
      },
      (result) => ({ workspaceId: result.id }),
    );
  }
  async adminTx<T>(
    ctx: Context,
    level: "org" | "space",
    operation: string,
    run: (db: PoolClient, a: EffectiveAccess) => Promise<T>,
  ) {
    return this.canonical.globalTransaction(ctx, operation, async (db) => {
      await this.human(db, ctx);
      const a = await authorizeActionDb(
        db,
        ctx,
        level === "space" ? "space.admin" : "knowledge.read",
      );
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      if (level === "org")
        await this.canonical.teamOwner(db, ctx, a.space.namespaceId);
      await this.canonical.lockTeamSpaces(db, a.space.namespaceId);
      await authorizeActionDb(
        db,
        ctx,
        level === "space" ? "space.admin" : "knowledge.read",
      );
      return run(db, a);
    });
  }
  async invalidate(db: DB, namespaceId: string, workspaceId?: string) {
    if (workspaceId)
      await db.query(
        "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
        [workspaceId],
      );
    else await this.canonical.invalidateTeam(db, namespaceId);
    const spaces = workspaceId
      ? [workspaceId]
      : (
          await db.query(
            "SELECT workspace_id FROM access_spaces WHERE namespace_id=$1",
            [namespaceId],
          )
        ).rows.map((r) => r.workspace_id);
    await this.canonical.retireApprovals(db, spaces);
  }
  async invite(
    ctx: Context,
    input: { principalId: string; role: string; workspaceId?: string },
  ) {
    const b = z
      .object({
        principalId: id,
        role: z.enum(["owner", "member", ...spaceRoles]),
        workspaceId: id.optional(),
      })
      .strict()
      .refine((b) =>
        b.workspaceId
          ? !["owner", "member"].includes(b.role)
          : ["owner", "member"].includes(b.role),
      )
      .parse(input);
    return this.adminTx(
      ctx,
      b.workspaceId ? "space" : "org",
      "legacy.invitation.create",
      async (db, a) => {
        if (b.workspaceId && b.workspaceId !== ctx.workspaceId)
          throw Error("FORBIDDEN");
        if (b.principalId === ctx.principalId) throw Error("FORBIDDEN");
        const p = await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [b.principalId],
        );
        if (!p.rowCount) throw Error("NOT_FOUND");
        if (b.workspaceId)
          try {
            await this.canonical.activeMember(
              db,
              a.space.namespaceId,
              b.principalId,
            );
          } catch {
            throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
          }
        const key = randomUUID();
        await db.query(
          "INSERT INTO access_invitations(id,team_id,principal_id,kind,from_id,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '7 days')",
          [
            key,
            a.space.namespaceId,
            b.principalId,
            b.role === "owner" ? "owner-transfer" : "member",
            ctx.principalId,
          ],
        );
        await recordAccessAudit(db, ctx, "legacy.invitation", key, {
          role: b.role,
          workspaceId: b.workspaceId ?? null,
          retainPreviousOwner: b.role === "owner",
        });
        return { id: key };
      },
    );
  }
  async invitation(
    ctx: Context,
    invitationId: string,
    action: "accept" | "cancel",
  ) {
    if (action === "accept") {
      await this.canonical.acceptInvite(ctx, id.parse(invitationId));
      return { ok: true };
    }
    return this.canonical.globalTransaction(
      ctx,
      "legacy.invitation." + action,
      async (db) => {
        await this.human(db, ctx);
        const r = await db.query(
          "SELECT * FROM access_invitations WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE",
          [id.parse(invitationId)],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        const i = r.rows[0];
        const meta = (
          await db.query(
            "SELECT data FROM access_audit WHERE operation='legacy.invitation' AND target_id=$1 ORDER BY id DESC LIMIT 1",
            [i.id],
          )
        ).rows[0]?.data ?? {
          role: i.kind === "owner-transfer" ? "owner" : "member",
          workspaceId: null,
        };
        const workspaceId =
          typeof meta.workspaceId === "string" ? meta.workspaceId : null;
        if (action === "cancel") {
          if (i.principal_id !== ctx.principalId) {
            if (workspaceId) {
              if (workspaceId !== ctx.workspaceId) throw Error("NOT_FOUND");
              await authorizeActionDb(db, ctx, "space.admin");
            } else await this.canonical.teamOwner(db, ctx, i.team_id);
          }
          await db.query(
            "UPDATE access_invitations SET status='revoked' WHERE id=$1",
            [i.id],
          );
          return { ok: true };
        }
        throw Error("VALIDATION_FAILED");
      },
    );
  }
  async member(
    ctx: Context,
    principalId: string,
    role: "owner" | "member" | null,
  ) {
    if (role === null) {
      const a = await this.canonical.effective(ctx);
      if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
      return this.canonical.removeMember(
        ctx,
        a.space.namespaceId,
        id.parse(principalId),
      );
    }
    return this.adminTx(
      ctx,
      "org",
      "legacy.organization.member",
      async (db, a) => {
        const r = await db.query(
          "SELECT role FROM access_team_members WHERE team_id=$1 AND principal_id=$2 AND active",
          [a.space.namespaceId, id.parse(principalId)],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        if (role === "owner" && r.rows[0].role !== "owner")
          throw Error("INVITATION_REQUIRED");
        if (r.rows[0].role === "owner" && role !== "owner") {
          const n = await db.query(
            "SELECT count(*)::int AS n FROM access_team_members WHERE team_id=$1 AND role='owner' AND active",
            [a.space.namespaceId],
          );
          if (n.rows[0].n <= 1) throw Error("LAST_OWNER");
        }
        await db.query(
          "UPDATE access_team_members SET role=$3 WHERE team_id=$1 AND principal_id=$2",
          [a.space.namespaceId, principalId, role],
        );
        await this.invalidate(db, a.space.namespaceId);
        return { ok: true };
      },
    );
  }
  async createTeam(ctx: Context, value: string) {
    const a = await this.canonical.effective(ctx);
    if (a.space.namespaceKind !== "team") throw Error("FORBIDDEN");
    const group = await this.canonical.createGroup(ctx, {
      teamId: a.space.namespaceId,
      name: name.parse(value),
    });
    return { id: group.id };
  }
  async teamMember(
    ctx: Context,
    teamId: string,
    principalId: string,
    add: boolean,
  ) {
    return this.adminTx(ctx, "org", "legacy.team.member", async (db, a) => {
      const group = await db.query(
        "SELECT 1 FROM access_groups WHERE id=$1 AND team_id=$2",
        [id.parse(teamId), a.space.namespaceId],
      );
      if (!group.rowCount) throw Error("NOT_FOUND");
      if (add) {
        try {
          await this.canonical.activeMember(
            db,
            a.space.namespaceId,
            id.parse(principalId),
          );
        } catch {
          throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
        }
        await db.query(
          "INSERT INTO access_group_members VALUES($1,$2) ON CONFLICT DO NOTHING",
          [teamId, principalId],
        );
      } else
        await db.query(
          "DELETE FROM access_group_members WHERE group_id=$1 AND principal_id=$2",
          [teamId, id.parse(principalId)],
        );
      await this.invalidate(db, a.space.namespaceId);
      return { ok: true };
    });
  }
  async grant(
    ctx: Context,
    input: {
      principalId?: string;
      teamId?: string;
      role: SpaceRole;
      expiresAt?: string;
    },
  ) {
    const b = z
      .object({
        principalId: id.optional(),
        teamId: id.optional(),
        role: z.enum(spaceRoles),
        expiresAt: z.iso.datetime().optional(),
      })
      .strict()
      .refine((b) => !!b.principalId !== !!b.teamId)
      .parse(input);
    const a = await this.canonical.effective(ctx);
    await this.canonical.principal(this.pool, ctx);
    if (!a.capabilities.includes("space.admin")) throw Error("FORBIDDEN");
    if (
      b.principalId &&
      !(
        await this.pool.query(
          "SELECT 1 FROM access_grants WHERE workspace_id=$1 AND principal_id=$2 AND NOT revoked",
          [ctx.workspaceId, b.principalId],
        )
      ).rowCount
    )
      throw Error("INVITATION_REQUIRED");
    const g = await this.canonical.setGrant(ctx, {
      principalId: b.principalId,
      groupId: b.teamId,
      role: lower(b.role),
      expiresAt: b.expiresAt,
      expectedVersion: a.space.policyVersion,
    });
    return { id: g.id };
  }
  async revoke(ctx: Context, grantId: string) {
    const a = await this.canonical.effective(ctx);
    if (!a.capabilities.includes("space.admin")) throw Error("FORBIDDEN");
    if (
      !(
        await this.pool.query(
          "SELECT 1 FROM access_grants WHERE id=$1 AND workspace_id=$2 AND NOT revoked",
          [id.parse(grantId), ctx.workspaceId],
        )
      ).rowCount
    )
      throw Error("NOT_FOUND");
    return this.canonical.removeGrant(ctx, grantId, a.space.policyVersion);
  }
  async visibility(ctx: Context, value: "private" | "team", revision: number) {
    try {
      await this.canonical.setVisibility(ctx, {
        visibility: value,
        expectedVersion: revision,
        confirmImpact: true,
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof Error && e.message === "STALE_VERSION")
        throw Error("INPUT_CHANGED");
      throw e;
    }
  }
  async reviewer(ctx: Context, principalId: string, enabled: boolean) {
    const a = await this.canonical.effective(ctx);
    if (!a.capabilities.includes("space.admin")) throw Error("FORBIDDEN");
    if (enabled) {
      const p = await effectiveAccess(this.pool, {
        workspaceId: ctx.workspaceId,
        principalId: id.parse(principalId),
      });
      if (!p.capabilities.includes("changeset.approve"))
        throw Error("FORBIDDEN");
    }
    const policy = await this.canonical.reviewPolicy(ctx),
      ids = new Set<string>(policy.reviewerIds);
    if (enabled) ids.add(principalId);
    else ids.delete(principalId);
    await this.canonical.setReviewPolicy(ctx, {
      minimumApprovals: policy.minimumApprovals,
      reviewerIds: [...ids],
      expectedVersion: policy.policyVersion,
    });
    return { ok: true };
  }
  async directory(ctx: Context, q: string) {
    return this.adminTx(ctx, "org", "legacy.directory.read", async (db) => {
      const rows = await db.query(
        "SELECT p.id,coalesce((SELECT a.data->>'name' FROM access_audit a WHERE a.operation='legacy.principal.name' AND a.target_id=p.id ORDER BY a.id DESC LIMIT 1),to_jsonb(p)->>'display_name',p.id) AS name FROM access_principals p WHERE p.active AND p.kind='human' ORDER BY p.id",
      );
      const text = z.string().trim().min(2).max(160).parse(q).toLowerCase();
      return rows.rows
        .filter((p) => p.id === q || p.name.toLowerCase().includes(text))
        .slice(0, 20);
    });
  }
}
