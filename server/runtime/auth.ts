import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import * as oidc from "openid-client";
import type { Role } from "../../src/domain/types";
import type { Context } from "../service";
import { registerPrincipal, personalSpace } from "../access";
import type { SpaceRole } from "../../src/domain/access";

export const sessionHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export const cookie = (req: IncomingMessage, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
export type Session = Context & {
  role: Role;
  csrfToken: string;
  spaceRole?: SpaceRole | null;
  canReviewKnowledge?: boolean;
  personalSpace?: boolean;
};
export class OidcAuth {
  requestGuard(req: IncomingMessage, expected: Session) {
    const raw = cookie(req, "akh_session");
    const check = async (db: Pick<PoolClient, "query">) => {
      if (!raw) throw Error("UNAUTHENTICATED");
      const result = await db.query(
        `SELECT s.id FROM runtime_sessions s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.principal_id=s.principal_id WHERE s.id=$1 AND s.workspace_id=$2 AND s.principal_id=$3 AND s.csrf=$4 AND s.expires_at>clock_timestamp() AND effective_membership(m.workspace_id,m.principal_id)=$5 FOR SHARE OF s,m`,
        [
          sessionHash(raw),
          expected.workspaceId,
          expected.principalId,
          expected.csrfToken,
          expected.role,
        ],
      );
      if (!result.rowCount) throw Error("UNAUTHENTICATED");
    };
    return {
      sessionId: raw ? sessionHash(raw) : undefined,
      assertSession: (db: PoolClient) => check(db),
      revalidate: async () => {
        const fresh = await this.authenticate(req);
        if (
          !fresh ||
          fresh.workspaceId !== expected.workspaceId ||
          fresh.principalId !== expected.principalId ||
          fresh.role !== expected.role ||
          fresh.csrfToken !== expected.csrfToken
        )
          throw Error("UNAUTHENTICATED");
        await check(this.pool);
      },
    };
  }
  constructor(
    readonly pool: Pool,
    readonly config: oidc.Configuration,
    readonly origin: string,
    readonly workspaceId: string,
    readonly roles: Record<string, Role>,
  ) {}
  async backgroundContext(input: {
    workspace_id: string;
    principal_id: string;
    session_id: string | null;
    grant_role: string;
    grant_expires_at: Date | string;
  }): Promise<Context> {
    const check = async (db: Pick<PoolClient, "query">) => {
      if (
        !input.session_id ||
        new Date(input.grant_expires_at).getTime() <= Date.now()
      )
        throw Error("AUTHORIZATION_REQUIRED");
      const r = await db.query(
        `SELECT s.subject,s.access_token FROM runtime_sessions s JOIN memberships m ON m.workspace_id=s.workspace_id AND m.principal_id=s.principal_id WHERE s.id=$1 AND s.workspace_id=$2 AND s.principal_id=$3 AND s.expires_at>clock_timestamp() AND effective_membership(m.workspace_id,m.principal_id)=$4 FOR SHARE OF s,m`,
        [
          input.session_id,
          input.workspace_id,
          input.principal_id,
          input.grant_role,
        ],
      );
      if (!r.rowCount) throw Error("AUTHORIZATION_REQUIRED");
      return r.rows[0];
    };
    const revalidate = async () => {
      const s = await check(this.pool);
      try {
        const info = await oidc.fetchUserInfo(
          this.config,
          s.access_token,
          s.subject,
        );
        const admission = this.role(info);
        const managed = await this.pool.query(
          "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
          [input.workspace_id],
        );
        if (!managed.rowCount && admission !== input.grant_role) throw Error();
      } catch {
        throw Error("AUTHORIZATION_REQUIRED");
      }
      await check(this.pool);
    };
    await revalidate();
    return {
      workspaceId: input.workspace_id,
      principalId: input.principal_id,
      authorization: {
        sessionId: input.session_id!,
        revalidate,
        assertSession: async (db) => {
          await check(db);
        },
      },
    };
  }
  static async create(pool: Pool) {
    const {
      APP_ORIGIN,
      OIDC_ISSUER,
      OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET,
      WORKSPACE_ID = "default",
    } = process.env;
    if (!APP_ORIGIN || !OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET)
      throw Error("OIDC_CONFIGURATION_REQUIRED");
    const origin = new URL(APP_ORIGIN);
    const issuer = new URL(OIDC_ISSUER);
    const local =
      process.env.NODE_ENV !== "production" &&
      process.env.OIDC_ALLOW_HTTP === "true";
    if (
      (origin.protocol !== "https:" || issuer.protocol !== "https:") &&
      !local
    )
      throw Error("HTTPS_REQUIRED");
    const roles = JSON.parse(process.env.OIDC_GROUP_ROLES || "{}") as Record<
      string,
      Role
    >;
    if (
      !Object.keys(roles).length ||
      Object.values(roles).some(
        (r) => !["editor", "reviewer", "reader"].includes(r),
      )
    )
      throw Error("OIDC_GROUP_ROLES_REQUIRED");
    const internal = process.env.OIDC_INTERNAL_URL
      ? new URL(process.env.OIDC_INTERNAL_URL)
      : null;
    if (internal && process.env.NODE_ENV === "production")
      throw Error("INTERNAL_OIDC_LOCAL_ONLY");
    const transport: NonNullable<
      oidc.DiscoveryRequestOptions[typeof oidc.customFetch]
    > = async (input, init) => {
      const url = new URL(input);
      if (internal && url.origin === issuer.origin) {
        url.protocol = internal.protocol;
        url.host = internal.host;
      }
      return fetch(url, {
        ...init,
        body: init.body as BodyInit,
        redirect: "error",
      });
    };
    const config = await oidc.discovery(
      issuer,
      OIDC_CLIENT_ID,
      OIDC_CLIENT_SECRET,
      undefined,
      {
        execute: local ? [oidc.allowInsecureRequests] : undefined,
        [oidc.customFetch]: transport,
      },
    );
    oidc.enableNonRepudiationChecks(config);
    return new OidcAuth(pool, config, origin.origin, WORKSPACE_ID, roles);
  }
  setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
    res.setHeader(
      "Set-Cookie",
      `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${this.origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  role(claims: Record<string, unknown>): Role {
    const groups = claims.groups;
    if (!Array.isArray(groups)) throw Error("FORBIDDEN");
    const mapped = groups
      .filter((g): g is string => typeof g === "string")
      .map((g) => this.roles[g]);
    for (const role of ["reviewer", "editor", "reader"] as const)
      if (mapped.includes(role)) return role;
    throw Error("FORBIDDEN");
  }
  async login(res: ServerResponse) {
    const id = token(),
      verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    await this.pool.query(
      "INSERT INTO oidc_logins VALUES($1,$2,now()+interval '5 minutes')",
      [sessionHash(id), { verifier, state, nonce }],
    );
    const url = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: this.origin + "/auth/callback",
      scope: "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    this.setCookie(res, "akh_login", id, 300);
    res.writeHead(302, { Location: url.href });
    res.end();
  }
  async callback(req: IncomingMessage, res: ServerResponse) {
    const id = cookie(req, "akh_login");
    if (!id) throw Error("UNAUTHENTICATED");
    const login = await this.pool.query(
      "DELETE FROM oidc_logins WHERE id=$1 AND expires_at>now() RETURNING data",
      [sessionHash(id)],
    );
    if (!login.rowCount) throw Error("UNAUTHENTICATED");
    const { verifier, state, nonce } = login.rows[0].data;
    const tokens = await oidc.authorizationCodeGrant(
      this.config,
      new URL(req.url!, this.origin),
      {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (!claims?.sub) throw Error("UNAUTHENTICATED");
    const info = await oidc.fetchUserInfo(
      this.config,
      tokens.access_token,
      claims.sub,
    );
    const admissionRole = this.role(info),
      principalId = sessionHash(
        this.config.serverMetadata().issuer + "\0" + claims.sub,
      );
    const session = token(),
      csrf = token();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await registerPrincipal(
        db,
        principalId,
        typeof info.name === "string" ? info.name : principalId,
      );
      let workspaceId = this.workspaceId,
        role = admissionRole;
      const managed = await db.query(
        "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
        [workspaceId],
      );
      if (managed.rowCount) {
        const effective = await db.query(
          "SELECT effective_membership($1,$2) AS role",
          [workspaceId, principalId],
        );
        if (effective.rows[0]?.role) role = effective.rows[0].role;
        else {
          workspaceId = await personalSpace(db, principalId);
          role = "reviewer";
        }
      }
      await db.query(
        "INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING",
        [workspaceId],
      );
      await db.query(
        "INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET role=excluded.role",
        [workspaceId, principalId, role],
      );
      await db.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          sessionHash(session),
          workspaceId,
          principalId,
          csrf,
          new Date(
            Date.now() + Math.min(tokens.expires_in || 300, 3600) * 1000,
          ),
          claims.sub,
          tokens.access_token,
        ],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    this.setCookie(
      res,
      "akh_session",
      session,
      Math.min(tokens.expires_in || 300, 3600),
    );
    res.writeHead(302, { Location: "/" });
    res.end();
  }
  async authenticate(req: IncomingMessage): Promise<Session | null> {
    const raw = cookie(req, "akh_session");
    if (!raw) return null;
    const row = await this.pool.query(
      "SELECT * FROM runtime_sessions WHERE id=$1 AND expires_at>now()",
      [sessionHash(raw)],
    );
    if (!row.rowCount) return null;
    const s = row.rows[0];
    try {
      // Live UserInfo makes IdP outages, disabled accounts and group removal fail closed.
      const info = await oidc.fetchUserInfo(
        this.config,
        s.access_token,
        s.subject,
      );
      const admissionRole = this.role(info);
      await registerPrincipal(
        this.pool,
        s.principal_id,
        typeof info.name === "string" ? info.name : s.principal_id,
      );
      const managed = await this.pool.query(
        "SELECT access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",
        [s.workspace_id, s.principal_id],
      );
      let role = admissionRole;
      if (managed.rowCount) {
        const effective = await this.pool.query(
          "SELECT effective_membership($1,$2) AS role",
          [s.workspace_id, s.principal_id],
        );
        role = effective.rows[0]?.role;
        if (!role) throw Error("FORBIDDEN");
      } else
        await this.pool.query(
          "UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND principal_id=$2",
          [s.workspace_id, s.principal_id, role],
        );
      return {
        workspaceId: s.workspace_id,
        principalId: s.principal_id,
        role,
        csrfToken: s.csrf,
        ...(managed.rowCount
          ? {
              spaceRole: managed.rows[0].role,
              personalSpace:
                (
                  await this.pool.query(
                    "SELECT 1 FROM access_spaces WHERE workspace_id=$1 AND owner_id=$2",
                    [s.workspace_id, s.principal_id],
                  )
                ).rowCount === 1,
              canReviewKnowledge:
                role === "reviewer" &&
                (
                  await this.pool.query(
                    "SELECT 1 FROM access_spaces s WHERE s.workspace_id=$1 AND (s.owner_id=$2 OR EXISTS(SELECT 1 FROM access_reviewers r WHERE r.workspace_id=s.workspace_id AND r.principal_id=$2))",
                    [s.workspace_id, s.principal_id],
                  )
                ).rowCount === 1,
            }
          : {}),
      };
    } catch {
      await this.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
        sessionHash(raw),
      ]);
      return null;
    }
  }
  async switchSpace(req: IncomingMessage, session: Session, id: string) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await this.requestGuard(req, session).assertSession(db);
      const r = await db.query("SELECT access_role($1,$2) AS role", [
        id,
        session.principalId,
      ]);
      if (!r.rows[0]?.role) throw Error("NOT_FOUND");
      const csrf = token();
      await db.query(
        "UPDATE runtime_sessions SET workspace_id=$2,csrf=$3 WHERE id=$1",
        [sessionHash(cookie(req, "akh_session")!), id, csrf],
      );
      await db.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async logout(req: IncomingMessage, res: ServerResponse) {
    const raw = cookie(req, "akh_session");
    if (raw)
      await this.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
        sessionHash(raw),
      ]);
    this.setCookie(res, "akh_session", "", 0);
  }
}
