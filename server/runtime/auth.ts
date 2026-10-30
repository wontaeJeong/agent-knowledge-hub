import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import * as oidc from "openid-client";
import type { Role } from "../../src/domain/types";
import type { Context } from "../service";
import { workspaceHref } from "../../src/entry";
import { effectiveAccess, syncIdentity } from "../access";
import type {
  InteractiveSessionBinding,
  InteractiveSessionSnapshot,
} from "../jobs/identity";

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
  identityRole?: Role;
};
export class OidcAuth {
  requestGuard(req: IncomingMessage, expected: Session) {
    const raw = cookie(req, "akh_session");
    const check = async (db: Pick<PoolClient, "query">) => {
      if (!raw) throw Error("UNAUTHENTICATED");
      const result = await db.query(
        `SELECT s.id FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active WHERE s.id=$1 AND s.principal_id=$2 AND s.csrf=$3 AND s.expires_at>clock_timestamp() FOR SHARE OF s,p`,
        [sessionHash(raw), expected.principalId, expected.csrfToken],
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
          fresh.identityRole !== expected.identityRole ||
          fresh.csrfToken !== expected.csrfToken
        )
          throw Error("UNAUTHENTICATED");
        await check(this.pool);
      },
    };
  }
  private async executionSession(
    db: Pick<PoolClient, "query">,
    binding: InteractiveSessionBinding,
    lock = false,
  ) {
    if (!/^[a-f0-9]{64}$/.test(binding.sessionId))
      throw Error("UNAUTHENTICATED");
    const found = await db.query(
      `SELECT s.* FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human' WHERE s.id=$1 AND s.principal_id=$2 AND s.expires_at>clock_timestamp()${lock ? " FOR SHARE OF s,p" : ""}`,
      [binding.sessionId, binding.principalId],
    );
    const row = found.rows[0];
    if (!row) throw Error("UNAUTHENTICATED");
    const access = await effectiveAccess(db, {
      workspaceId: binding.workspaceId,
      principalId: binding.principalId,
    });
    if (!access.role) throw Error("UNAUTHENTICATED");
    const role: Role = access.capabilities.includes("changeset.approve")
      ? "reviewer"
      : access.capabilities.includes("changeset.propose")
        ? "editor"
        : "reader";
    return { row, role };
  }
  /** Hashed parent pointer only. Network identity proof remains outside write transactions. */
  async revalidateInteractiveGrant(
    binding: InteractiveSessionBinding,
  ): Promise<InteractiveSessionSnapshot> {
    try {
      const { row } = await this.executionSession(this.pool, binding);
      const info = await oidc.fetchUserInfo(
          this.config,
          row.access_token,
          row.subject,
        ),
        identityRole = this.role(info);
      const current = await this.executionSession(this.pool, binding);
      const snapshot = {
        role: current.role,
        identityRole,
        csrfHash: sessionHash(current.row.csrf),
        subjectHash: sessionHash(current.row.subject),
      };
      if (
        binding.snapshot &&
        Object.keys(snapshot).some(
          (key) =>
            snapshot[key as keyof typeof snapshot] !==
            binding.snapshot![key as keyof InteractiveSessionSnapshot],
        )
      )
        throw Error("UNAUTHENTICATED");
      return snapshot;
    } catch {
      await this.pool.query(
        "DELETE FROM runtime_sessions WHERE id=$1 AND principal_id=$2",
        [binding.sessionId, binding.principalId],
      );
      throw Error("UNAUTHENTICATED");
    }
  }
  /** DB-only final assertion; selecting a space never changes the origin session's authority. */
  async assertInteractiveGrant(
    db: PoolClient,
    binding: InteractiveSessionBinding,
  ): Promise<void> {
    const { row, role } = await this.executionSession(db, binding, true),
      expected = binding.snapshot;
    if (
      !expected ||
      expected.role !== role ||
      expected.csrfHash !== sessionHash(row.csrf) ||
      expected.subjectHash !== sessionHash(row.subject)
    )
      throw Error("UNAUTHENTICATED");
  }
  constructor(
    readonly pool: Pool,
    readonly config: oidc.Configuration,
    readonly origin: string,
    readonly workspaceId: string,
    readonly roles: Record<string, Role>,
  ) {}
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
    this.role(info); // Directory eligibility is not a product role binding.
    const principalId = sessionHash(
      this.config.serverMetadata().issuer + "\0" + claims.sub,
    );
    const session = token(),
      csrf = token();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING",
        [this.workspaceId],
      );
      await syncIdentity(db, {
        issuer: this.config.serverMetadata().issuer,
        subject: claims.sub,
      });
      await db.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          sessionHash(session),
          this.workspaceId,
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
    res.writeHead(302, { Location: workspaceHref });
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
      const identityRole = this.role(info);
      const active = await this.pool.query(
        "SELECT 1 FROM access_principals WHERE id=$1 AND active",
        [s.principal_id],
      );
      if (!active.rowCount) throw Error("UNAUTHENTICATED");
      const selected = req.headers["x-space-id"];
      if (
        selected !== undefined &&
        (typeof selected !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(selected))
      )
        throw Error("UNAUTHENTICATED");
      const workspaceId = selected ?? s.workspace_id;
      let role: Role = "reader";
      try {
        const a = await effectiveAccess(this.pool, {
          workspaceId,
          principalId: s.principal_id,
        });
        role = a.capabilities.includes("changeset.approve")
          ? "reviewer"
          : a.capabilities.includes("changeset.propose")
            ? "editor"
            : "reader";
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
      }
      return {
        workspaceId,
        principalId: s.principal_id,
        role,
        identityRole,
        csrfToken: s.csrf,
      };
    } catch {
      await this.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
        sessionHash(raw),
      ]);
      return null;
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
