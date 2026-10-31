import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import { acquireSharedMutationGate } from "../operations/gate";

export type DB = Pick<PoolClient, "query">;
export type SessionBinding = {
  sessionId: string;
  principalId: string;
  workspaceId: string;
};
export type SessionPolicy = {
  absoluteSeconds: number;
  idleSeconds: number;
  touchSeconds: number;
};
export const defaultSessionPolicy: Readonly<SessionPolicy> = Object.freeze({
  absoluteSeconds: 3600,
  idleSeconds: 1800,
  touchSeconds: 30,
});
export function sessionPolicyFromEnvironment(
  env: Record<string, string | undefined>,
): SessionPolicy {
  return Object.freeze(
    policy({
      absoluteSeconds: Number(env.SESSION_ABSOLUTE_SECONDS ?? 3600),
      idleSeconds: Number(env.SESSION_IDLE_SECONDS ?? 1800),
      touchSeconds: Number(env.SESSION_TOUCH_SECONDS ?? 30),
    }),
  );
}
function policy(input: SessionPolicy) {
  if (
    ![input.absoluteSeconds, input.idleSeconds, input.touchSeconds].every(
      Number.isSafeInteger,
    ) ||
    input.absoluteSeconds < 60 ||
    input.absoluteSeconds > 86400 ||
    input.idleSeconds < 1 ||
    input.idleSeconds > input.absoluteSeconds ||
    input.touchSeconds < 1 ||
    input.touchSeconds >= input.idleSeconds
  )
    throw Error("INVALID_SESSION_POLICY");
  return input;
}
export function sessionBinding(ctx: Context): SessionBinding {
  const sessionId = ctx.authorization?.sessionId;
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId))
    throw Error("UNAUTHENTICATED");
  return {
    sessionId,
    principalId: ctx.principalId,
    workspaceId: ctx.workspaceId,
  };
}
export async function identityEvent(
  db: DB,
  actor: string,
  operation: string,
  target: string,
  data: unknown = {},
) {
  await db.query(
    "INSERT INTO identity_events(actor_id,operation,target_id,data) VALUES($1,$2,$3,$4)",
    [actor, operation, target, data],
  );
}
/** Caller must hold a transaction through the protected effect. Origin-session
 * workspace can differ from selected workspace, but principal and hash cannot. */
export async function assertSessionPolicy(
  db: DB,
  binding: SessionBinding,
  input: SessionPolicy = defaultSessionPolicy,
): Promise<void> {
  const p = policy(input);
  if (!/^[a-f0-9]{64}$/.test(binding.sessionId)) throw Error("UNAUTHENTICATED");
  const result = await db.query(
    `SELECT s.id FROM runtime_sessions s
 JOIN identity_session_activity a ON a.session_id=s.id
 JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
 WHERE s.id=$1 AND s.principal_id=$2 AND s.expires_at>clock_timestamp()
 AND a.created_at+$3*interval '1 second'>clock_timestamp()
 AND a.last_seen_at+$4*interval '1 second'>clock_timestamp() FOR SHARE OF s,p`,
    [binding.sessionId, binding.principalId, p.absoluteSeconds, p.idleSeconds],
  );
  if (!result.rowCount) throw Error("UNAUTHENTICATED");
}
/** Call once in the login transaction, immediately after runtime_sessions INSERT.
 * No user timestamps and no lazy creation that could revive an expired session. */
export async function initializeSessionPolicy(
  db: DB,
  binding: SessionBinding,
): Promise<void> {
  const result = await db.query(
    `INSERT INTO identity_session_activity(session_id)
 SELECT id FROM runtime_sessions WHERE id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
 ON CONFLICT DO NOTHING RETURNING session_id`,
    [binding.sessionId, binding.principalId],
  );
  if (!result.rowCount) throw Error("SESSION_ALREADY_INITIALIZED_OR_INVALID");
}
/** Compatibility for an existing session whose activity row is absent. ONLY
 * after a fresh successful UserInfo call matching this subject/current actor.
 * Infer the earliest possible issuance under the supported session ceiling,
 * not a new login at now. Unknown old idle history therefore expires safely. */
export async function recoverVerifiedSessionPolicy(
  db: DB,
  binding: SessionBinding,
  identity: { issuer: string; subject: string },
  input: SessionPolicy = defaultSessionPolicy,
): Promise<void> {
  const p = policy(input);
  await db.query(
    `INSERT INTO identity_session_activity(session_id,created_at,last_seen_at)
  SELECT s.id,LEAST(clock_timestamp(),s.expires_at-$5*interval '1 second'),LEAST(clock_timestamp(),s.expires_at-$5*interval '1 second')
  FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
  WHERE s.id=$1 AND s.principal_id=$2 AND s.subject=$3 AND s.expires_at>clock_timestamp()
  AND (p.issuer IS NULL OR (p.issuer=$4 AND p.subject=$3))
  ON CONFLICT(session_id) DO NOTHING`,
    [
      binding.sessionId,
      binding.principalId,
      identity.subject,
      identity.issuer,
      Math.max(3600, p.absoluteSeconds),
    ],
  );
}
export async function invalidateSessionBindings(
  db: DB,
  principalId: string,
  ids: string[],
): Promise<void> {
  await db.query(
    `UPDATE access_credentials SET revoked=true WHERE id IN
  (SELECT credential_id FROM runtime_execution_grants WHERE principal_id=$1 AND parent_session_id=ANY($2::text[]))`,
    [principalId, ids],
  );
  await db.query(
    "UPDATE runtime_execution_grants SET revoked=true WHERE principal_id=$1 AND parent_session_id=ANY($2::text[])",
    [principalId, ids],
  );
  await db.query(
    "DELETE FROM runtime_sessions WHERE principal_id=$1 AND id=ANY($2::text[])",
    [principalId, ids],
  );
}
/** Interactive requests only: queue polling/background execution must not keep a
 * human session alive. Perform after assertion in the same transaction. */
export async function touchSession(
  db: DB,
  binding: SessionBinding,
  input: SessionPolicy = defaultSessionPolicy,
): Promise<void> {
  // Serialize activity updates before acquiring the shared effect locks. Two
  // interactive requests must not deadlock while upgrading an activity lock.
  await db.query(
    "SELECT id FROM runtime_sessions WHERE id=$1 AND principal_id=$2 FOR SHARE",
    [binding.sessionId, binding.principalId],
  );
  await db.query(
    "SELECT session_id FROM identity_session_activity WHERE session_id=$1 FOR UPDATE",
    [binding.sessionId],
  );
  await assertSessionPolicy(db, binding, input);
  await db.query(
    `UPDATE identity_session_activity SET last_seen_at=GREATEST(last_seen_at,clock_timestamp())
 WHERE session_id=$1 AND last_seen_at<=clock_timestamp()-$2*interval '1 second'`,
    [binding.sessionId, policy(input).touchSeconds],
  );
}
export async function identityTransaction<T>(
  pool: Pool,
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await acquireSharedMutationGate(db);
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
/** Optional trusted, server-configured IdP adapter. Product logout is committed
 * before invoking it and never reported as a successful global IdP logout when
 * absent/failing. Adapter receives subject/issuer, never a new token copy. */
export interface GlobalLogoutAdapter {
  logout(identity: { issuer: string; subject: string }): Promise<void>;
}
export class IdentityOperations {
  constructor(
    readonly pool: Pool,
    readonly sessionPolicy: SessionPolicy = defaultSessionPolicy,
    readonly globalLogout?: GlobalLogoutAdapter,
  ) {
    policy(sessionPolicy);
  }
  async sessions(ctx: Context, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw Error("INVALID_PAGE");
    return identityTransaction(this.pool, async (db) => {
      const binding = sessionBinding(ctx);
      await assertSessionPolicy(db, binding, this.sessionPolicy);
      const result = await db.query(
        `SELECT s.id,a.created_at,a.last_seen_at,LEAST(s.expires_at,a.created_at+$2*interval '1 second') AS expires_at,
    (s.expires_at>clock_timestamp() AND a.created_at+$2*interval '1 second'>clock_timestamp() AND a.last_seen_at+$3*interval '1 second'>clock_timestamp()) AS active,
    count(*) OVER()::integer AS total
    FROM runtime_sessions s JOIN identity_session_activity a ON a.session_id=s.id
    WHERE s.principal_id=$1 ORDER BY a.created_at DESC,s.id LIMIT 25 OFFSET $4`,
        [
          ctx.principalId,
          this.sessionPolicy.absoluteSeconds,
          this.sessionPolicy.idleSeconds,
          offset,
        ],
      );
      return {
        items: result.rows.map((r) => ({
          id: r.id,
          label: r.id.slice(0, 12),
          current: r.id === binding.sessionId,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          expiresAt: r.expires_at,
          active: r.active,
        })),
        total: result.rows[0]?.total ?? 0,
        offset,
        limit: 25,
      };
    });
  }
  private async invalidate(db: DB, principalId: string, ids: string[]) {
    await invalidateSessionBindings(db, principalId, ids);
  }
  async revokeSession(ctx: Context, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("NOT_FOUND");
    return identityTransaction(this.pool, async (db) => {
      // Lock session rows in one deterministic order to serialize own-session
      // revocations and wait for an in-progress final effect assertion to finish.
      await db.query(
        "SELECT id FROM runtime_sessions WHERE principal_id=$1 ORDER BY id FOR UPDATE",
        [ctx.principalId],
      );
      await assertSessionPolicy(db, sessionBinding(ctx), this.sessionPolicy);
      const found = await db.query(
        "SELECT id FROM runtime_sessions WHERE id=$1 AND principal_id=$2",
        [id, ctx.principalId],
      );
      if (!found.rowCount) throw Error("NOT_FOUND");
      await this.invalidate(db, ctx.principalId, [id]);
      await identityEvent(db, ctx.principalId, "session.revoke", id);
      return { revoked: true, current: id === ctx.authorization?.sessionId };
    });
  }
  async logoutAll(ctx: Context) {
    const identity = await identityTransaction(this.pool, async (db) => {
      const own = await db.query(
        "SELECT id FROM runtime_sessions WHERE principal_id=$1 ORDER BY id FOR UPDATE",
        [ctx.principalId],
      );
      await assertSessionPolicy(db, sessionBinding(ctx), this.sessionPolicy);
      const principal = (
        await db.query(
          "SELECT issuer,subject FROM access_principals WHERE id=$1",
          [ctx.principalId],
        )
      ).rows[0];
      await this.invalidate(
        db,
        ctx.principalId,
        own.rows.map((r) => r.id),
      );
      // Also retire outstanding execution grants whose parent session was already
      // removed. Do not touch another actor or ordinary long-lived agent tokens.
      await db.query(
        "UPDATE access_credentials SET revoked=true WHERE id IN (SELECT credential_id FROM runtime_execution_grants WHERE principal_id=$1)",
        [ctx.principalId],
      );
      await db.query(
        "UPDATE runtime_execution_grants SET revoked=true WHERE principal_id=$1",
        [ctx.principalId],
      );
      await identityEvent(
        db,
        ctx.principalId,
        "session.logout-all",
        ctx.principalId,
        { count: own.rowCount },
      );
      return principal;
    });
    let idpLogout: "not_configured" | "completed" | "failed" = "not_configured";
    if (this.globalLogout && identity?.issuer && identity?.subject) {
      try {
        await this.globalLogout.logout(identity);
        idpLogout = "completed";
      } catch {
        idpLogout = "failed";
      }
    }
    return { productSessionsRevoked: true, idpLogout };
  }
}
