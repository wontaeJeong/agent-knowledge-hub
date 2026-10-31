import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import * as oidc from "openid-client";
import type { Role } from "../../src/domain/types";
import type { Context } from "../service";
import { registerPrincipal, personalSpace } from "../access";
import type { SpaceRole } from "../../src/domain/access";
import { workspaceHref } from "../../src/entry";
import { effectiveAccess, syncIdentity } from "../access/index";
import type {
  InteractiveSessionBinding,
  InteractiveSessionSnapshot,
} from "../jobs/identity";
import {
  assertSessionPolicy,
  defaultSessionPolicy,
  identityTransaction,
  initializeSessionPolicy,
  invalidateSessionBindings,
  recoverVerifiedSessionPolicy,
  sessionPolicyFromEnvironment,
  touchSession,
  type SessionPolicy,
} from "../identity/sessions";
import {
  syncDirectoryMemberships,
  type GroupProof,
} from "../identity/directory";
import { createVerifiedOidcDirectoryAdapter } from "../identity/adapters";
import { registerEmergencyGuard } from "../identity/authority";
import type { EmergencyAccess } from "../identity/emergency";

export interface OidcIdentityOptions {
  sessionPolicy?: SessionPolicy;
  directoryProof?: (
    subject: string,
    verifiedUserInfo: Readonly<Record<string, unknown>>,
    issuer: string,
  ) => Promise<GroupProof | undefined>;
  directoryGroupClaim?: string;
  directoryFreshnessSeconds?: number;
  emergency?: EmergencyAccess;
}

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
  spaceRole?: SpaceRole | null;
  canReviewKnowledge?: boolean;
  personalSpace?: boolean;
};
export class OidcAuth {
  readonly sessionPolicy: SessionPolicy;
  private readonly defaultDirectoryProof?: ReturnType<
    typeof createVerifiedOidcDirectoryAdapter
  >;
  private async directoryProof(
    subject: string,
    info: Readonly<Record<string, unknown>>,
  ) {
    const issuer = this.config.serverMetadata().issuer;
    if (this.identityOptions.directoryProof)
      return this.identityOptions.directoryProof(subject, info, issuer);
    return this.defaultDirectoryProof?.(subject, info);
  }
  private async acceptVerifiedIdentity(
    db: PoolClient,
    binding: InteractiveSessionBinding,
    subject: string,
    proof: GroupProof | undefined,
  ) {
    const issuer = this.config.serverMetadata().issuer;
    const actor = await db.query(
      "SELECT id,issuer,subject FROM access_principals WHERE id=$1 AND active AND kind='human' FOR SHARE",
      [binding.principalId],
    );
    const p = actor.rows[0];
    if (
      !p ||
      (p.issuer !== null && (p.issuer !== issuer || p.subject !== subject))
    )
      throw Error("UNAUTHENTICATED");
    if (
      p.issuer === null &&
      binding.principalId === sessionHash(issuer + "\0" + subject)
    ) {
      await syncIdentity(db, { issuer, subject });
      p.issuer = issuer;
      p.subject = subject;
    }
    await recoverVerifiedSessionPolicy(
      db,
      binding,
      { issuer, subject },
      this.sessionPolicy,
    );
    await assertSessionPolicy(db, binding, this.sessionPolicy);
    // Legacy unbound principals keep only their explicitly established manual
    // product paths. We never attach a new issuer to an arbitrary fixture ID.
    if (proof && p.issuer !== null) {
      if (proof.subject !== subject || proof.issuer !== issuer)
        throw Error("DIRECTORY_IDENTITY_MISMATCH");
      await syncDirectoryMemberships(db, proof);
    }
  }
  private async discardSession(id: string, principalId?: string) {
    await identityTransaction(this.pool, async (db) => {
      const row = (
        await db.query(
          "SELECT principal_id FROM runtime_sessions WHERE id=$1 AND ($2::text IS NULL OR principal_id=$2) FOR UPDATE",
          [id, principalId ?? null],
        )
      ).rows[0];
      if (row) await invalidateSessionBindings(db, row.principal_id, [id]);
    });
  }
  requestGuard(req: IncomingMessage, expected: Session) {
    const raw = cookie(req, "akh_session");
    const check = async (db: Pick<PoolClient, "query">) => {
      if (!raw) throw Error("UNAUTHENTICATED");
      await assertSessionPolicy(
        db,
        {
          sessionId: sessionHash(raw),
          principalId: expected.principalId,
          workspaceId: expected.workspaceId,
        },
        this.sessionPolicy,
      );
      const result = await db.query(
        `SELECT s.id FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active WHERE s.id=$1 AND s.principal_id=$2 AND s.csrf=$3 AND s.expires_at>clock_timestamp() FOR SHARE OF s,p`,
        [sessionHash(raw), expected.principalId, expected.csrfToken],
      );
      if (!result.rowCount) throw Error("UNAUTHENTICATED");
      try {
        const access = await effectiveAccess(db, {
          workspaceId: expected.workspaceId,
          principalId: expected.principalId,
        });
        const role: Role = access.capabilities.includes("changeset.approve")
          ? "reviewer"
          : access.capabilities.includes("changeset.propose")
            ? "editor"
            : "reader";
        if (role !== expected.role) throw Error("UNAUTHENTICATED");
        const spaceRole = access.role
          ? (
              {
                read: "Read",
                triage: "Triage",
                write: "Write",
                maintain: "Maintain",
                admin: "Admin",
              } as const
            )[access.role]
          : null;
        if (
          expected.spaceRole !== undefined &&
          spaceRole !== expected.spaceRole
        )
          throw Error("UNAUTHENTICATED");
      } catch (e) {
        // Authenticated roleless accounts can resolve a pinned share/emergency
        // separately. This admits no workspace action or unknown source reader.
        if (
          !(e instanceof Error) ||
          e.message !== "NOT_FOUND" ||
          expected.role !== "reader" ||
          expected.spaceRole != null
        )
          throw e;
      }
    };
    const guard = {
      sessionId: raw ? sessionHash(raw) : undefined,
      assertSession: (db: PoolClient) => check(db),
      revalidate: async () => {
        const fresh = await this.authenticate(req, false);
        if (
          !fresh ||
          fresh.workspaceId !== expected.workspaceId ||
          fresh.principalId !== expected.principalId ||
          fresh.role !== expected.role ||
          fresh.identityRole !== expected.identityRole ||
          (expected.spaceRole !== undefined &&
            fresh.spaceRole !== expected.spaceRole) ||
          fresh.csrfToken !== expected.csrfToken
        )
          throw Error("UNAUTHENTICATED");
        await check(this.pool);
      },
    };
    return this.identityOptions.emergency
      ? registerEmergencyGuard(guard, this.identityOptions.emergency)
      : guard;
  }
  private async executionSession(
    db: Pick<PoolClient, "query">,
    binding: InteractiveSessionBinding,
    lock = false,
  ) {
    if (!/^[a-f0-9]{64}$/.test(binding.sessionId))
      throw Error("UNAUTHENTICATED");
    await assertSessionPolicy(db, binding, this.sessionPolicy);
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
      // Fetching UserInfo is not authority. Only the subsequent transactional
      // policy assertion can restore a compatibility row or authorize a job.
      const row = (
        await this.pool.query(
          `SELECT s.* FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human' WHERE s.id=$1 AND s.principal_id=$2 AND s.expires_at>clock_timestamp()`,
          [binding.sessionId, binding.principalId],
        )
      ).rows[0];
      if (!row) throw Error("UNAUTHENTICATED");
      const info = await oidc.fetchUserInfo(
          this.config,
          row.access_token,
          row.subject,
        ),
        identityRole = this.role(info);
      const proof = await this.directoryProof(row.subject, info);
      const current = await identityTransaction(this.pool, async (db) => {
        await this.acceptVerifiedIdentity(db, binding, row.subject, proof);
        return this.executionSession(db, binding, true);
      });
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
      await this.discardSession(binding.sessionId, binding.principalId);
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
    readonly identityOptions: OidcIdentityOptions = {},
  ) {
    const input = identityOptions.sessionPolicy ?? defaultSessionPolicy;
    this.sessionPolicy = sessionPolicyFromEnvironment({
      SESSION_ABSOLUTE_SECONDS: String(input.absoluteSeconds),
      SESSION_IDLE_SECONDS: String(input.idleSeconds),
      SESSION_TOUCH_SECONDS: String(input.touchSeconds),
    });
    const issuer = new URL(config.serverMetadata().issuer);
    const loopback =
      process.env.NODE_ENV !== "production" &&
      issuer.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
    if (issuer.protocol === "https:" || loopback)
      this.defaultDirectoryProof = createVerifiedOidcDirectoryAdapter({
        issuer: config.serverMetadata().issuer,
        maxAgeSeconds: identityOptions.directoryFreshnessSeconds ?? 60,
        groupClaim: identityOptions.directoryGroupClaim,
        allowLoopbackHttp: loopback,
      });
  }
  async backgroundContext(input: {
    workspace_id: string;
    principal_id: string;
    session_id: string | null;
    grant_role: string;
    grant_expires_at: Date | string;
  }): Promise<Context> {
    const binding: InteractiveSessionBinding = {
      sessionId: input.session_id ?? "",
      workspaceId: input.workspace_id,
      principalId: input.principal_id,
    };
    const checkExpiry = () => {
      if (
        !input.session_id ||
        new Date(input.grant_expires_at).getTime() <= Date.now()
      )
        throw Error("AUTHORIZATION_REQUIRED");
    };
    const revalidate = async () => {
      checkExpiry();
      try {
        const snapshot = await this.revalidateInteractiveGrant(binding);
        if (snapshot.role !== input.grant_role || snapshot.role === "reader")
          throw Error("AUTHORIZATION_REQUIRED");
        binding.snapshot = snapshot;
      } catch {
        throw Error("AUTHORIZATION_REQUIRED");
      }
    };
    await revalidate();
    return {
      workspaceId: input.workspace_id,
      principalId: input.principal_id,
      authorization: {
        sessionId: input.session_id!,
        revalidate,
        assertSession: async (db) => {
          checkExpiry();
          try {
            await this.assertInteractiveGrant(db, binding);
          } catch {
            throw Error("AUTHORIZATION_REQUIRED");
          }
        },
      },
    };
  }
  static async create(pool: Pool, identityOptions: OidcIdentityOptions = {}) {
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
    return new OidcAuth(pool, config, origin.origin, WORKSPACE_ID, roles, {
      ...identityOptions,
      sessionPolicy:
        identityOptions.sessionPolicy ??
        sessionPolicyFromEnvironment(process.env),
    });
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
    const proof = await this.directoryProof(claims.sub, info);
    const principalId = sessionHash(
      this.config.serverMetadata().issuer + "\0" + claims.sub,
    );
    const session = token(),
      csrf = token();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await syncIdentity(db, {
        issuer: this.config.serverMetadata().issuer,
        subject: claims.sub,
      });
      await registerPrincipal(
        db,
        principalId,
        typeof info.name === "string" ? info.name : principalId,
      );
      if (proof) await syncDirectoryMemberships(db, proof);
      let workspaceId = this.workspaceId;
      try {
        const a = await effectiveAccess(db, { workspaceId, principalId });
        if (!a.role) workspaceId = await personalSpace(db, principalId);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
        workspaceId = await personalSpace(db, principalId);
      }
      await db.query(
        "INSERT INTO workspaces VALUES($1) ON CONFLICT DO NOTHING",
        [workspaceId],
      );
      await db.query(
        "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT(workspace_id,principal_id) DO NOTHING",
        [workspaceId, principalId],
      );
      await db.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          sessionHash(session),
          workspaceId,
          principalId,
          csrf,
          new Date(
            Date.now() +
              Math.min(
                tokens.expires_in || 300,
                this.sessionPolicy.absoluteSeconds,
              ) *
                1000,
          ),
          claims.sub,
          tokens.access_token,
        ],
      );
      await initializeSessionPolicy(db, {
        sessionId: sessionHash(session),
        principalId,
        workspaceId,
      });
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
      Math.min(tokens.expires_in || 300, this.sessionPolicy.absoluteSeconds),
    );
    res.writeHead(302, { Location: workspaceHref });
    res.end();
  }
  async authenticate(
    req: IncomingMessage,
    interactive = true,
  ): Promise<Session | null> {
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
      const proof = await this.directoryProof(s.subject, info);
      const selected = req.headers["x-space-id"];
      if (
        selected !== undefined &&
        (typeof selected !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(selected))
      )
        throw Error("UNAUTHENTICATED");
      const workspaceId = selected ?? s.workspace_id;
      const binding = {
        sessionId: sessionHash(raw),
        workspaceId,
        principalId: s.principal_id,
      };
      return await identityTransaction(this.pool, async (db) => {
        await this.acceptVerifiedIdentity(db, binding, s.subject, proof);
        let role: Role = "reader";
        let spaceRole: SpaceRole | null = null,
          personal = false,
          canReviewKnowledge = false;
        try {
          const a = await effectiveAccess(db, {
            workspaceId,
            principalId: s.principal_id,
          });
          role = a.capabilities.includes("changeset.approve")
            ? "reviewer"
            : a.capabilities.includes("changeset.propose")
              ? "editor"
              : "reader";
          spaceRole = a.role
            ? (
                {
                  read: "Read",
                  triage: "Triage",
                  write: "Write",
                  maintain: "Maintain",
                  admin: "Admin",
                } as const
              )[a.role]
            : null;
          personal = a.space.namespaceKind === "personal";
          canReviewKnowledge =
            personal ||
            (a.capabilities.includes("changeset.approve") &&
              (
                await db.query(
                  "SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
                  [workspaceId, s.principal_id],
                )
              ).rowCount === 1);
        } catch (e) {
          if (!(e instanceof Error) || e.message !== "NOT_FOUND") throw e;
        }
        await registerPrincipal(
          db,
          s.principal_id,
          typeof info.name === "string" ? info.name : s.principal_id,
        );
        const poll = /^\/api\/v1\/(?:jobs|notifications|events)(?:[/?]|$)/.test(
          req.url ?? "",
        );
        if (interactive && !poll)
          await touchSession(db, binding, this.sessionPolicy);
        return {
          workspaceId,
          principalId: s.principal_id,
          role,
          identityRole,
          csrfToken: s.csrf,
          spaceRole,
          personalSpace: personal,
          canReviewKnowledge,
        };
      });
    } catch {
      await this.discardSession(sessionHash(raw), s.principal_id);
      return null;
    }
  }
  async switchSpace(req: IncomingMessage, session: Session, id: string) {
    const guard = this.requestGuard(req, session);
    await guard.revalidate();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE", [
        sessionHash(cookie(req, "akh_session")!),
      ]);
      await guard.assertSession(db);
      const a = await effectiveAccess(db, {
        workspaceId: id,
        principalId: session.principalId,
      });
      if (!a.role) throw Error("NOT_FOUND");
      const csrf = token();
      await touchSession(
        db,
        {
          sessionId: guard.sessionId!,
          workspaceId: session.workspaceId,
          principalId: session.principalId,
        },
        this.sessionPolicy,
      );
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
    if (raw) await this.discardSession(sessionHash(raw));
    this.setCookie(res, "akh_session", "", 0);
  }
}
