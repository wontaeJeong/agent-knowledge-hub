import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Context } from "./service";
import type {
  AccessState,
  AccessSpace,
  AccessInvitation,
  SpaceRole,
} from "../src/domain/access";

const allowedBootstrap = (who: string) =>
  (process.env.ACCESS_BOOTSTRAP_OWNERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(who);
export async function registerPrincipal(
  db: Pick<Pool, "query">,
  id: string,
  name: string,
) {
  await db.query(
    "INSERT INTO access_principals(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name",
    [id, name.slice(0, 160) || id],
  );
  const p = await db.query(
    "SELECT enabled FROM access_principals WHERE id=$1",
    [id],
  );
  if (!p.rows[0]?.enabled) throw Error("FORBIDDEN");
}
export async function personalSpace(
  db: Pick<PoolClient, "query">,
  who: string,
) {
  const id = "personal-" + who;
  await db.query("INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING", [
    id,
  ]);
  await db.query(
    "INSERT INTO access_spaces(workspace_id,name,owner_id) VALUES($1,'개인 지식',$2) ON CONFLICT DO NOTHING",
    [id, who],
  );
  await db.query(
    "INSERT INTO memberships VALUES($1,$2,'reviewer') ON CONFLICT(workspace_id,principal_id) DO NOTHING",
    [id, who],
  );
  return id;
}
const invitationsSql = `SELECT i.id,i.org_id AS "orgId",o.name AS organization,i.workspace_id AS "workspaceId",s.name AS space,i.principal_id AS "principalId",i.role,i.expires_at AS "expiresAt",i.status FROM access_invitations i JOIN access_orgs o ON o.id=i.org_id LEFT JOIN access_spaces s ON s.workspace_id=i.workspace_id`;
export class AccessService {
  constructor(readonly pool: Pool) {}
  async tx<T>(ctx: Context, fn: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SELECT pg_advisory_xact_lock(720292)");
      // Administration is infrequent in the initial App1/DB1 release. One stable
      // lock order serializes policy changes against all publication transactions.
      await db.query("SELECT id FROM workspaces ORDER BY id FOR UPDATE");
      await ctx.authorization?.assertSession(db);
      const member = await db.query(
        "SELECT effective_membership($1,$2) AS role",
        [ctx.workspaceId, ctx.principalId],
      );
      if (!member.rows[0]?.role) throw Error("NOT_FOUND");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async actor(db: PoolClient, ctx: Context, level: "space" | "org") {
    const r = await db.query(
      "SELECT *,access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",
      [ctx.workspaceId, ctx.principalId],
    );
    const s = r.rows[0];
    if (!s) throw Error("NOT_FOUND");
    if (level === "space" && s.role !== "Admin") throw Error("FORBIDDEN");
    if (
      level === "org" &&
      !(
        await db.query(
          "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2 AND role='owner'",
          [s.org_id, ctx.principalId],
        )
      ).rowCount
    )
      throw Error("FORBIDDEN");
    return s;
  }
  async owner(db: PoolClient, org: string, who: string) {
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2 AND role='owner'",
          [org, who],
        )
      ).rowCount
    )
      throw Error("NOT_FOUND");
  }
  async log(
    db: PoolClient,
    ctx: Context,
    operation: string,
    id: string,
    details: Record<string, unknown> = {},
  ) {
    await db.query(
      "INSERT INTO access_audit(actor_id,operation,resource_id,details) VALUES($1,$2,$3,$4)",
      [ctx.principalId, operation, id, details],
    );
  }
  async refresh(db: PoolClient, org: string | null, space?: string) {
    const rows = await db.query(
      "SELECT workspace_id FROM access_spaces WHERE ($1::text IS NOT NULL AND org_id=$1) OR workspace_id=$2",
      [org, space ?? null],
    );
    for (const { workspace_id: id } of rows.rows) {
      await db.query(
        "UPDATE access_spaces SET revision=revision+1 WHERE workspace_id=$1",
        [id],
      );
      await db.query(
        "INSERT INTO memberships(workspace_id,principal_id,role) SELECT $1,p.id,effective_membership($1,p.id) FROM access_principals p WHERE effective_membership($1,p.id) IS NOT NULL ON CONFLICT(workspace_id,principal_id) DO UPDATE SET role=excluded.role",
        [id],
      );
      await db.query("DELETE FROM approvals WHERE workspace_id=$1", [id]);
      await db.query(
        "UPDATE batches SET data=jsonb_set(data,'{status}','\"pending\"') WHERE workspace_id=$1 AND data->>'status'='approved'",
        [id],
      );
    }
  }
  async spaces(
    ctx: Context,
    db: Pick<PoolClient, "query"> = this.pool,
  ): Promise<AccessSpace[]> {
    const rows = await db.query(
      `SELECT s.workspace_id AS id,s.name,s.owner_id AS "ownerId",s.org_id AS "orgId",o.name AS organization,s.visibility,s.revision,access_role(s.workspace_id,$1) AS role FROM access_spaces s LEFT JOIN access_orgs o ON o.id=s.org_id WHERE access_role(s.workspace_id,$1) IS NOT NULL ORDER BY s.owner_id NULLS LAST,s.name`,
      [ctx.principalId],
    );
    return rows.rows;
  }
  async invitations(ctx: Context): Promise<AccessInvitation[]> {
    return (
      await this.pool.query(
        invitationsSql +
          " WHERE i.principal_id=$1 AND i.status='pending' AND i.expires_at>clock_timestamp() ORDER BY i.expires_at",
        [ctx.principalId],
      )
    ).rows;
  }
  async state(ctx: Context): Promise<AccessState> {
    return this.tx(ctx, async (db) => {
      const spaces = await this.spaces(ctx, db),
        space = spaces.find((s) => s.id === ctx.workspaceId) ?? null;
      const orgOwner =
        !!space?.orgId &&
        (
          await db.query(
            "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2 AND role='owner'",
            [space.orgId, ctx.principalId],
          )
        ).rowCount === 1;
      const manage = space?.role === "Admin";
      const result: AccessState = {
        managed: !!space,
        bootstrapAllowed: !space && allowedBootstrap(ctx.principalId),
        space,
        capabilities: {
          manageSpace: manage,
          manageOrganization: orgOwner,
          triage: !!space && space.role !== "Read",
        },
        members: [],
        teams: [],
        grants: [],
        reviewers: [],
        invitations: [],
        audit: [],
      };
      if (!space) return result;
      if (manage) {
        result.reviewers = (
          await db.query(
            "SELECT principal_id FROM access_reviewers WHERE workspace_id=$1 ORDER BY principal_id",
            [space.id],
          )
        ).rows.map((r) => r.principal_id);
        const members = await db.query(
          `SELECT p.id AS "principalId",p.display_name AS name,access_role($1,p.id) AS role,m.role AS "organizationRole" FROM access_principals p LEFT JOIN access_org_members m ON m.principal_id=p.id AND m.org_id=$2 WHERE m.org_id=$2 OR p.id=$3 ORDER BY p.display_name`,
          [space.id, space.orgId, space.ownerId],
        );
        const grants = await db.query(
          'SELECT id,principal_id AS "principalId",team_id AS "teamId",role,expires_at AS "expiresAt" FROM access_grants WHERE workspace_id=$1 ORDER BY id',
          [space.id],
        );
        result.grants = grants.rows;
        const teams = await db.query(
          "SELECT t.id,t.name,coalesce(array_agg(m.principal_id) FILTER(WHERE m.principal_id IS NOT NULL),ARRAY[]::text[]) AS members FROM access_teams t LEFT JOIN access_team_members m ON m.team_id=t.id WHERE t.org_id=$1 GROUP BY t.id ORDER BY t.name",
          [space.orgId],
        );
        result.teams = teams.rows;
        result.members = members.rows.map((m) => ({
          ...m,
          paths: [
            ...(m.organizationRole === "owner" ||
            space.ownerId === m.principalId
              ? ["Owner → Admin"]
              : []),
            ...result.grants
              .filter(
                (g) =>
                  g.principalId === m.principalId ||
                  result.teams.some(
                    (t) =>
                      t.id === g.teamId && t.members.includes(m.principalId),
                  ),
              )
              .filter((g) => !g.expiresAt || new Date(g.expiresAt) > new Date())
              .map(
                (g) =>
                  `${g.teamId ? result.teams.find((t) => t.id === g.teamId)?.name : "직접"} → ${g.role}`,
              ),
            ...(space.visibility === "team" && m.organizationRole
              ? ["조직 공개 → Read"]
              : []),
          ],
        }));
        result.invitations = (
          await db.query(
            invitationsSql +
              " WHERE i.status='pending' AND i.expires_at>clock_timestamp() AND (i.workspace_id=$1 OR ($3 AND i.org_id=$2))",
            [space.id, space.orgId, orgOwner],
          )
        ).rows;
        result.audit = (
          await db.query(
            'SELECT actor_id AS "actorId",operation,resource_id AS "resourceId",details,at FROM access_audit WHERE resource_id=$1 OR ($3 AND resource_id=$2) ORDER BY id DESC LIMIT 50',
            [space.id, space.orgId, orgOwner],
          )
        ).rows;
      }
      return result;
    });
  }
  async bootstrap(ctx: Context, name: string) {
    return this.tx(ctx, async (db) => {
      if (!allowedBootstrap(ctx.principalId)) throw Error("FORBIDDEN");
      if (
        (
          await db.query("SELECT 1 FROM access_spaces WHERE workspace_id=$1", [
            ctx.workspaceId,
          ])
        ).rowCount
      )
        throw Error("ALREADY_MANAGED");
      await db.query(
        "INSERT INTO access_principals(id,display_name) SELECT principal_id,principal_id FROM memberships WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
        [ctx.workspaceId],
      );
      const org = randomUUID();
      await db.query("INSERT INTO access_orgs VALUES($1,$2)", [org, name]);
      await db.query(
        "INSERT INTO access_org_members SELECT $1,principal_id,CASE WHEN principal_id=$2 THEN 'owner' ELSE 'member' END FROM memberships WHERE workspace_id=$3",
        [org, ctx.principalId, ctx.workspaceId],
      );
      await db.query(
        "INSERT INTO access_spaces(workspace_id,name,org_id) VALUES($1,$2,$3)",
        [ctx.workspaceId, "공유 지식", org],
      );
      const members = await db.query(
        "SELECT principal_id,role FROM memberships WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      for (const m of members.rows)
        await db.query(
          "INSERT INTO access_grants(id,workspace_id,principal_id,role,granted_by) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            ctx.workspaceId,
            m.principal_id,
            m.role === "reviewer"
              ? "Maintain"
              : m.role === "editor"
                ? "Write"
                : "Read",
            ctx.principalId,
          ],
        );
      await db.query(
        "INSERT INTO access_reviewers SELECT workspace_id,principal_id FROM memberships WHERE workspace_id=$1 AND role='reviewer'",
        [ctx.workspaceId],
      );
      await this.refresh(db, org);
      await this.log(db, ctx, "space.adopt", ctx.workspaceId, {
        organization: org,
        existingMembers: members.rowCount,
      });
      return { organizationId: org };
    });
  }
  async createOrganization(ctx: Context, name: string) {
    return this.tx(ctx, async (db) => {
      const count = await db.query(
        "SELECT count(*)::int AS n FROM access_org_members WHERE principal_id=$1 AND role='owner'",
        [ctx.principalId],
      );
      if (count.rows[0].n >= 20) throw Error("RATE_LIMITED");
      // Admission is controlled by OIDC_GROUP_ROLES; product organization creation
      // can additionally be disabled by deployment policy.
      if (process.env.ACCESS_ALLOW_ORG_CREATE !== "true")
        throw Error("FORBIDDEN");
      await db.query(
        "INSERT INTO access_principals(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING",
        [ctx.principalId],
      );
      const id = randomUUID();
      await db.query("INSERT INTO access_orgs VALUES($1,$2)", [id, name]);
      await db.query("INSERT INTO access_org_members VALUES($1,$2,'owner')", [
        id,
        ctx.principalId,
      ]);
      await this.log(db, ctx, "organization.create", id);
      return { id };
    });
  }
  async createSpace(ctx: Context, name: string, orgId?: string) {
    return this.tx(ctx, async (db) => {
      await db.query(
        "INSERT INTO access_principals(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING",
        [ctx.principalId],
      );
      if (orgId) await this.owner(db, orgId, ctx.principalId);
      else {
        const id = await personalSpace(db, ctx.principalId);
        await this.log(db, ctx, "personal.open", id);
        return { id };
      }
      const n = await db.query(
        "SELECT count(*)::int AS n FROM access_spaces WHERE org_id=$1",
        [orgId],
      );
      if (n.rows[0].n >= 100) throw Error("RATE_LIMITED");
      const id = randomUUID();
      await db.query("INSERT INTO workspaces VALUES($1)", [id]);
      await db.query(
        "INSERT INTO access_spaces(workspace_id,name,org_id) VALUES($1,$2,$3)",
        [id, name, orgId],
      );
      await this.refresh(db, orgId);
      await this.log(db, ctx, "space.create", id);
      return { id };
    });
  }
  async invite(
    ctx: Context,
    input: { principalId: string; role: string; workspaceId?: string },
  ) {
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, input.workspaceId ? "space" : "org");
      if (
        !s.org_id ||
        (input.workspaceId && input.workspaceId !== ctx.workspaceId)
      )
        throw Error("FORBIDDEN");
      if (
        !(
          await db.query(
            "SELECT 1 FROM access_principals WHERE id=$1 AND enabled",
            [input.principalId],
          )
        ).rowCount
      )
        throw Error("NOT_FOUND");
      if (
        input.workspaceId &&
        !(
          await db.query(
            "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
            [s.org_id, input.principalId],
          )
        ).rowCount
      )
        throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
      if (input.principalId === ctx.principalId) throw Error("FORBIDDEN");
      const n = await db.query(
        "SELECT count(*)::int AS n FROM access_invitations WHERE org_id=$1 AND status='pending' AND expires_at>clock_timestamp()",
        [s.org_id],
      );
      if (n.rows[0].n >= 200) throw Error("RATE_LIMITED");
      const id = randomUUID();
      await db.query(
        "INSERT INTO access_invitations(id,org_id,workspace_id,principal_id,role,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '7 days')",
        [
          id,
          s.org_id,
          input.workspaceId ?? null,
          input.principalId,
          input.role,
          ctx.principalId,
        ],
      );
      await this.log(
        db,
        ctx,
        "invitation.create",
        input.workspaceId ?? s.org_id,
        { id, principalId: input.principalId, role: input.role },
      );
      return { id };
    });
  }
  async invitation(ctx: Context, id: string, action: "accept" | "cancel") {
    return this.tx(ctx, async (db) => {
      const r = await db.query(
        "SELECT * FROM access_invitations WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE",
        [id],
      );
      const i = r.rows[0];
      if (!i) throw Error("NOT_FOUND");
      if (action === "cancel") {
        if (i.principal_id !== ctx.principalId) {
          if (i.workspace_id) {
            if (ctx.workspaceId !== i.workspace_id) throw Error("NOT_FOUND");
            await this.actor(db, ctx, "space");
          } else await this.owner(db, i.org_id, ctx.principalId);
        }
      } else {
        if (i.principal_id !== ctx.principalId) throw Error("NOT_FOUND");
        const inviter = await db.query(
          "SELECT role FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
          [i.org_id, i.invited_by],
        );
        if (i.workspace_id) {
          const role = await db.query("SELECT access_role($1,$2) AS role", [
            i.workspace_id,
            i.invited_by,
          ]);
          if (role.rows[0]?.role !== "Admin") throw Error("APPROVAL_STALE");
          if (
            !(
              await db.query(
                "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
                [i.org_id, ctx.principalId],
              )
            ).rowCount
          )
            throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
          await this.putGrant(
            db,
            { ...ctx, workspaceId: i.workspace_id },
            { principalId: ctx.principalId, role: i.role },
          );
        } else {
          if (inviter.rows[0]?.role !== "owner") throw Error("APPROVAL_STALE");
          await db.query(
            "INSERT INTO access_org_members VALUES($1,$2,$3) ON CONFLICT(org_id,principal_id) DO UPDATE SET role=CASE WHEN access_org_members.role='owner' THEN access_org_members.role ELSE excluded.role END",
            [i.org_id, ctx.principalId, i.role],
          );
        }
      }
      await db.query("UPDATE access_invitations SET status=$2 WHERE id=$1", [
        id,
        action === "accept" ? "accepted" : "cancelled",
      ]);
      await this.refresh(db, i.org_id);
      await this.log(
        db,
        ctx,
        "invitation." + action,
        i.workspace_id ?? i.org_id,
        { id },
      );
      return { ok: true };
    });
  }
  async member(
    ctx: Context,
    principalId: string,
    role: "owner" | "member" | null,
  ) {
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, "org");
      const r = await db.query(
        "SELECT role FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
        [s.org_id, principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      if (role === "owner" && r.rows[0].role !== "owner")
        throw Error("INVITATION_REQUIRED");
      if (r.rows[0].role === "owner" && role !== "owner") {
        const count = await db.query(
          "SELECT count(*)::int AS n FROM access_org_members WHERE org_id=$1 AND role='owner'",
          [s.org_id],
        );
        if (count.rows[0].n <= 1) throw Error("LAST_OWNER");
      }
      if (role)
        await db.query(
          "UPDATE access_org_members SET role=$3 WHERE org_id=$1 AND principal_id=$2",
          [s.org_id, principalId, role],
        );
      else {
        await db.query(
          "DELETE FROM access_reviewers WHERE principal_id=$1 AND workspace_id IN(SELECT workspace_id FROM access_spaces WHERE org_id=$2)",
          [principalId, s.org_id],
        );
        await db.query(
          "DELETE FROM access_grants WHERE principal_id=$1 AND workspace_id IN(SELECT workspace_id FROM access_spaces WHERE org_id=$2)",
          [principalId, s.org_id],
        );
        await db.query(
          "UPDATE access_invitations SET status='cancelled' WHERE org_id=$1 AND (principal_id=$2 OR invited_by=$2) AND status='pending'",
          [s.org_id, principalId],
        );
        await db.query(
          "DELETE FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
          [s.org_id, principalId],
        );
      }
      await this.refresh(db, s.org_id);
      await this.log(db, ctx, "organization.member", s.org_id, {
        principalId,
        role,
      });
      return { ok: true };
    });
  }
  async createTeam(ctx: Context, name: string) {
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, "org");
      const n = await db.query(
        "SELECT count(*)::int AS n FROM access_teams WHERE org_id=$1",
        [s.org_id],
      );
      if (n.rows[0].n >= 100) throw Error("RATE_LIMITED");
      const id = randomUUID();
      await db.query("INSERT INTO access_teams VALUES($1,$2,$3)", [
        id,
        s.org_id,
        name,
      ]);
      await this.log(db, ctx, "team.create", s.org_id, { id, name });
      return { id };
    });
  }
  async teamMember(
    ctx: Context,
    teamId: string,
    principalId: string,
    add: boolean,
  ) {
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, "org");
      if (
        !(
          await db.query(
            "SELECT 1 FROM access_teams WHERE id=$1 AND org_id=$2",
            [teamId, s.org_id],
          )
        ).rowCount
      )
        throw Error("NOT_FOUND");
      if (add) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
              [s.org_id, principalId],
            )
          ).rowCount
        )
          throw Error("ORGANIZATION_MEMBERSHIP_REQUIRED");
        await db.query(
          "INSERT INTO access_team_members VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [s.org_id, teamId, principalId],
        );
      } else
        await db.query(
          "DELETE FROM access_team_members WHERE team_id=$1 AND principal_id=$2",
          [teamId, principalId],
        );
      await this.refresh(db, s.org_id);
      await this.log(db, ctx, "team.member", s.org_id, {
        teamId,
        principalId,
        add,
      });
      return { ok: true };
    });
  }
  async putGrant(
    db: PoolClient,
    ctx: Context,
    input: {
      principalId?: string;
      teamId?: string;
      role: SpaceRole;
      expiresAt?: string;
    },
  ) {
    const column = input.principalId ? "principal_id" : "team_id",
      value = input.principalId ?? input.teamId;
    const existing = await db.query(
      `SELECT id FROM access_grants WHERE workspace_id=$1 AND ${column}=$2`,
      [ctx.workspaceId, value],
    );
    if (existing.rowCount) {
      await db.query(
        "UPDATE access_grants SET role=$2,expires_at=$3,granted_by=$4 WHERE id=$1",
        [
          existing.rows[0].id,
          input.role,
          input.expiresAt ?? null,
          ctx.principalId,
        ],
      );
      return existing.rows[0].id;
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO access_grants(id,workspace_id,${column},role,expires_at,granted_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        ctx.workspaceId,
        value,
        input.role,
        input.expiresAt ?? null,
        ctx.principalId,
      ],
    );
    return id;
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
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, "space");
      if (!s.org_id) throw Error("FORBIDDEN");
      if (input.principalId) {
        if (
          !(
            await db.query(
              "SELECT 1 FROM access_grants WHERE workspace_id=$1 AND principal_id=$2",
              [ctx.workspaceId, input.principalId],
            )
          ).rowCount
        )
          throw Error("INVITATION_REQUIRED");
        if (
          !(
            await db.query(
              "SELECT 1 FROM access_org_members WHERE org_id=$1 AND principal_id=$2",
              [s.org_id, input.principalId],
            )
          ).rowCount
        )
          throw Error("NOT_FOUND");
      } else if (
        !(
          await db.query(
            "SELECT 1 FROM access_teams WHERE id=$1 AND org_id=$2",
            [input.teamId, s.org_id],
          )
        ).rowCount
      )
        throw Error("NOT_FOUND");
      const id = await this.putGrant(db, ctx, input);
      await this.refresh(db, null, ctx.workspaceId);
      await this.log(db, ctx, "space.grant", ctx.workspaceId, { ...input, id });
      return { id };
    });
  }
  async revoke(ctx: Context, id: string) {
    return this.tx(ctx, async (db) => {
      await this.actor(db, ctx, "space");
      const r = await db.query(
        "DELETE FROM access_grants WHERE id=$1 AND workspace_id=$2 RETURNING id",
        [id, ctx.workspaceId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      await this.refresh(db, null, ctx.workspaceId);
      await this.log(db, ctx, "space.revoke", ctx.workspaceId, { id });
      return { ok: true };
    });
  }
  async visibility(ctx: Context, value: "private" | "team", revision: number) {
    return this.tx(ctx, async (db) => {
      const s = await this.actor(db, ctx, "space");
      if (!s.org_id && value !== "private") throw Error("FORBIDDEN");
      if (s.revision !== revision) throw Error("INPUT_CHANGED");
      // This grants space Read only; never inserts resource_readers. Every existing
      // source and derivative keeps its current, potentially narrower audience.
      await db.query(
        "UPDATE access_spaces SET visibility=$2 WHERE workspace_id=$1",
        [ctx.workspaceId, value],
      );
      await this.refresh(db, null, ctx.workspaceId);
      await this.log(db, ctx, "space.visibility", ctx.workspaceId, {
        before: s.visibility,
        after: value,
        sourceAclsExpanded: false,
      });
      return { ok: true };
    });
  }
  async directory(ctx: Context, q: string) {
    return this.tx(ctx, async (db) => {
      await this.actor(db, ctx, "org");
      return (
        await db.query(
          "SELECT id,display_name AS name FROM access_principals WHERE enabled AND (position(lower($1) in lower(display_name))>0 OR id=$1) ORDER BY display_name LIMIT 20",
          [q],
        )
      ).rows;
    });
  }
  async reviewer(ctx: Context, principalId: string, enabled: boolean) {
    return this.tx(ctx, async (db) => {
      await this.actor(db, ctx, "space");
      if (enabled) {
        const role = await db.query("SELECT access_role($1,$2) AS role", [
          ctx.workspaceId,
          principalId,
        ]);
        if (!["Maintain", "Admin"].includes(role.rows[0]?.role))
          throw Error("FORBIDDEN");
        await db.query(
          "INSERT INTO access_reviewers VALUES($1,$2) ON CONFLICT DO NOTHING",
          [ctx.workspaceId, principalId],
        );
      } else
        await db.query(
          "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
          [ctx.workspaceId, principalId],
        );
      await this.refresh(db, null, ctx.workspaceId);
      await this.log(db, ctx, "space.reviewer", ctx.workspaceId, {
        principalId,
        enabled,
      });
      return { ok: true };
    });
  }
  async organizations(ctx: Context) {
    return (
      await this.pool.query(
        "SELECT o.id,o.name,m.role FROM access_orgs o JOIN access_org_members m ON m.org_id=o.id WHERE m.principal_id=$1 ORDER BY o.name",
        [ctx.principalId],
      )
    ).rows;
  }
}
