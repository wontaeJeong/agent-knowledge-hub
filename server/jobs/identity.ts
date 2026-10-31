import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { authorizeActionDb } from "../access/index";
import { fingerprint } from "../provenance";
import type { ExecutionIdentity } from "./types";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const snapshotSchema = z
  .object({
    role: z.enum(["reader", "editor", "reviewer"]),
    identityRole: z.enum(["reader", "editor", "reviewer"]),
    csrfHash: z.string().regex(/^[a-f0-9]{64}$/),
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type InteractiveSessionSnapshot = z.infer<typeof snapshotSchema>;
export interface InteractiveSessionBinding {
  sessionId: string;
  workspaceId: string;
  principalId: string;
  snapshot?: InteractiveSessionSnapshot;
}
export interface DirectorySubject {
  principalId: string;
  issuer: string | null;
  subject: string | null;
}
export interface DirectoryStatus extends DirectorySubject {
  active: boolean | null;
  verifiedAt: string;
  validUntil: string;
}
export interface RuntimeIdentityOptions {
  revalidateInteractiveGrant?: (
    binding: InteractiveSessionBinding,
    options?: { signal: AbortSignal },
  ) => Promise<InteractiveSessionSnapshot>;
  assertInteractiveGrant?: (
    db: PoolClient,
    binding: InteractiveSessionBinding,
  ) => Promise<void>;
  directoryStatus?: (
    subject: DirectorySubject,
    options?: { signal: AbortSignal },
  ) => Promise<DirectoryStatus>;
  directoryProviderId?: string;
  maxDirectoryAgeMs?: number;
  identityTimeoutMs?: number;
}
/** All network refreshes happen BEFORE transactions. DB assertions never call
 * an IdP and never repair/re-enable product principals, grants or sessions. */
export class RuntimeIdentityAuthority {
  readonly maxAge: number;
  readonly timeoutMs: number;
  private pending = new Map<string, Promise<void>>();
  constructor(
    readonly pool: Pool,
    readonly options: RuntimeIdentityOptions,
  ) {
    if (
      Boolean(options.revalidateInteractiveGrant) !==
      Boolean(options.assertInteractiveGrant)
    )
      throw Error("INTERACTIVE_GUARD_REQUIRED");
    this.maxAge = options.maxDirectoryAgeMs ?? 30000;
    this.timeoutMs = options.identityTimeoutMs ?? 5000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 30000
    )
      throw Error("IDENTITY_CONFIGURATION_REQUIRED");
    if (
      !Number.isInteger(this.maxAge) ||
      this.maxAge < 100 ||
      this.maxAge > 300000
    )
      throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
    if (options.directoryStatus && !options.directoryProviderId)
      throw Error("DIRECTORY_CONFIGURATION_REQUIRED");
  }
  private async bounded<T>(
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(Error("IDENTITY_UNAVAILABLE"));
            reject(Error("IDENTITY_UNAVAILABLE"));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async parent(
    db: Pick<PoolClient, "query">,
    binding: InteractiveSessionBinding,
    lock = false,
  ) {
    const row = (
      await db.query(
        `SELECT s.* FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human' WHERE s.id=$1 AND s.principal_id=$2 AND s.expires_at>clock_timestamp()${lock ? " FOR SHARE OF s,p" : ""}`,
        [binding.sessionId, binding.principalId],
      )
    ).rows[0];
    if (!row) throw Error("UNAUTHENTICATED");
    if (
      binding.snapshot &&
      (hash(row.csrf) !== binding.snapshot.csrfHash ||
        hash(row.subject) !== binding.snapshot.subjectHash)
    )
      throw Error("UNAUTHENTICATED");
    return row;
  }
  private async verifySession(binding: InteractiveSessionBinding) {
    if (
      !this.options.revalidateInteractiveGrant ||
      !this.options.assertInteractiveGrant
    )
      throw Error("INTERACTIVE_GUARD_REQUIRED");
    await this.parent(this.pool, binding);
    try {
      const snapshot = snapshotSchema.parse(
        await this.bounded((signal) =>
          this.options.revalidateInteractiveGrant!(
            Object.freeze({
              ...binding,
              ...(binding.snapshot
                ? { snapshot: Object.freeze({ ...binding.snapshot }) }
                : {}),
            }),
            { signal },
          ),
        ),
      );
      if (
        binding.snapshot &&
        fingerprint(snapshot) !== fingerprint(binding.snapshot)
      )
        throw Error("UNAUTHENTICATED");
      await this.parent(this.pool, { ...binding, snapshot });
      return snapshot;
    } catch {
      // Same fail-closed semantics as authenticate: never resurrect this session.
      await this.pool.query(
        "DELETE FROM runtime_sessions WHERE id=$1 AND principal_id=$2",
        [binding.sessionId, binding.principalId],
      );
      throw Error("UNAUTHENTICATED");
    }
  }
  async prepareSession(ctx: Context) {
    const id = (
      ctx.authorization as
        | (NonNullable<Context["authorization"]> & { sessionId?: string })
        | undefined
    )?.sessionId;
    if (!id || !/^[a-f0-9]{64}$/.test(id) || ctx.credentialId)
      throw Error("UNAUTHENTICATED");
    const binding = {
      sessionId: id,
      principalId: ctx.principalId,
      workspaceId: ctx.workspaceId,
    };
    const snapshot = await this.verifySession(binding),
      row = await this.parent(this.pool, { ...binding, snapshot });
    return { ...binding, snapshot, expiresAt: new Date(row.expires_at) };
  }
  async assertParent(db: PoolClient, binding: InteractiveSessionBinding) {
    if (
      !this.options.assertInteractiveGrant ||
      !this.options.revalidateInteractiveGrant
    )
      throw Error("INTERACTIVE_GUARD_REQUIRED");
    await this.parent(db, binding, true);
    await this.options.assertInteractiveGrant(db, binding);
  }
  async grant(db: PoolClient, ctx: Context) {
    if (!ctx.credentialId) return null;
    const g = (
      await db.query(
        "SELECT * FROM runtime_execution_grants WHERE credential_id=$1",
        [ctx.credentialId],
      )
    ).rows[0];
    if (!g) return null;
    if (
      g.revoked ||
      g.workspace_id !== ctx.workspaceId ||
      g.principal_id !== ctx.principalId ||
      +new Date(g.expires_at) <= Date.now()
    )
      throw Error("CREDENTIAL_REVOKED");
    const op =
      g.operation === "query"
        ? "knowledge.read"
        : g.operation === "lint"
          ? "lint.run"
          : "changeset.propose";
    if (g.parent_credential_id) {
      const p = (
        await db.query(
          "SELECT actions FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked AND expires_at>clock_timestamp()",
          [g.parent_credential_id, ctx.principalId, ctx.workspaceId],
        )
      ).rows[0];
      if (
        !p ||
        !p.actions.includes("knowledge.read") ||
        !p.actions.includes(op)
      )
        throw Error("CREDENTIAL_REVOKED");
    } else if (g.parent_session_id) {
      const binding = this.binding(g);
      await this.assertParent(db, binding);
    } else throw Error("UNAUTHENTICATED");
    return g;
  }
  private binding(g: Record<string, any>): InteractiveSessionBinding {
    return {
      sessionId: g.parent_session_id,
      workspaceId: g.workspace_id,
      principalId: g.principal_id,
      snapshot: snapshotSchema.parse(g.parent_session_snapshot),
    };
  }
  private async serviceDescriptor(
    db: Pick<PoolClient, "query">,
    identity: ExecutionIdentity,
  ) {
    const row = (
      await db.query(
        "SELECT sponsor.id,sponsor.issuer,sponsor.subject FROM access_credentials c JOIN access_principals p ON p.id=c.principal_id AND p.kind='service' AND p.active JOIN access_service_accounts sa ON sa.principal_id=p.id JOIN access_principals sponsor ON sponsor.id=sa.sponsor_id AND sponsor.kind='human' AND sponsor.active JOIN access_spaces s ON s.workspace_id=c.workspace_id AND s.namespace_id=sa.namespace_id AND s.active JOIN access_team_members tm ON tm.team_id=sa.namespace_id AND tm.principal_id=sponsor.id AND tm.active WHERE c.id=$1 AND c.principal_id=$2 AND c.workspace_id=$3 AND NOT c.revoked AND c.expires_at>clock_timestamp() AND sa.expires_at>clock_timestamp()",
        [identity.credentialId, identity.principalId, identity.workspaceId],
      )
    ).rows[0];
    if (!row) throw Error("SCOPED_SERVICE_IDENTITY_REQUIRED");
    return {
      principalId: row.id as string,
      issuer: row.issuer as string | null,
      subject: row.subject as string | null,
    };
  }
  async service(db: PoolClient, identity: ExecutionIdentity) {
    const subject = await this.serviceDescriptor(db, identity);
    if (!this.options.directoryStatus || !this.options.directoryProviderId)
      throw Error("DIRECTORY_STATUS_UNKNOWN");
    const proof = (
      await db.query(
        "SELECT * FROM runtime_directory_status WHERE principal_id=$1 AND provider_id=$2 AND identity_hash=$3 AND valid_until>clock_timestamp() AND verified_at>=clock_timestamp()-$4::int*interval '1 millisecond'",
        [
          subject.principalId,
          this.options.directoryProviderId,
          fingerprint(subject),
          this.maxAge,
        ],
      )
    ).rows[0];
    if (proof?.active === false) throw Error("UNAUTHENTICATED");
    if (!proof || proof.active !== true)
      throw Error("DIRECTORY_STATUS_UNKNOWN");
    const ctx = { ...identity };
    await authorizeActionDb(db, ctx, "knowledge.read");
    return ctx;
  }
  async resolve(db: PoolClient, identity: ExecutionIdentity): Promise<Context> {
    const ctx = { ...identity },
      g = await this.grant(db, ctx);
    if (!g) return this.service(db, identity);
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [ctx.principalId],
        )
      ).rowCount
    )
      throw Error("CREDENTIAL_REVOKED");
    await authorizeActionDb(db, ctx, "knowledge.read");
    if (g.parent_session_id) {
      const b = this.binding(g);
      return {
        ...ctx,
        authorization: {
          revalidate: () => this.refresh(identity),
          assertSession: (db) => this.assertParent(db, b),
        },
      };
    }
    return ctx;
  }
  async refresh(identity: ExecutionIdentity): Promise<void> {
    const g = (
      await this.pool.query(
        "SELECT * FROM runtime_execution_grants WHERE credential_id=$1 AND principal_id=$2 AND workspace_id=$3",
        [identity.credentialId, identity.principalId, identity.workspaceId],
      )
    ).rows[0];
    if (g) {
      if (g.revoked || +new Date(g.expires_at) <= Date.now())
        throw Error("CREDENTIAL_REVOKED");
      if (!g.parent_session_id) return; // Parent PAT is intersected again in every DB assertion.
      const binding = this.binding(g),
        key =
          "session:" +
          binding.sessionId +
          ":" +
          binding.workspaceId +
          ":" +
          binding.principalId +
          ":" +
          fingerprint(binding.snapshot);
      const pending = this.pending.get(key);
      if (pending) return pending;
      const work = this.verifySession(binding).then(() => {});
      this.pending.set(key, work);
      try {
        await work;
      } finally {
        this.pending.delete(key);
      }
      return;
    }
    const subject = await this.serviceDescriptor(this.pool, identity);
    if (!this.options.directoryStatus || !this.options.directoryProviderId)
      throw Error("DIRECTORY_STATUS_UNKNOWN");
    const key =
        "directory:" +
        subject.principalId +
        ":" +
        fingerprint(subject) +
        ":" +
        this.options.directoryProviderId,
      pending = this.pending.get(key);
    if (pending) return pending;
    const work = (async () => {
      try {
        const proof = await this.bounded((signal) =>
            this.options.directoryStatus!(Object.freeze({ ...subject }), {
              signal,
            }),
          ),
          now = Date.now(),
          at = Date.parse(proof.verifiedAt),
          until = Date.parse(proof.validUntil);
        if (
          proof.principalId !== subject.principalId ||
          proof.issuer !== subject.issuer ||
          proof.subject !== subject.subject ||
          !Number.isFinite(at) ||
          !Number.isFinite(until) ||
          at > now + 5000 ||
          at < now - this.maxAge ||
          until <= now ||
          until > at + this.maxAge ||
          !([true, false, null] as unknown[]).includes(proof.active)
        )
          throw Error("DIRECTORY_STATUS_UNKNOWN");
        await this.pool.query(
          "INSERT INTO runtime_directory_status(principal_id,provider_id,identity_hash,active,verified_at,valid_until) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(principal_id) DO UPDATE SET provider_id=excluded.provider_id,identity_hash=excluded.identity_hash,active=excluded.active,verified_at=excluded.verified_at,valid_until=excluded.valid_until WHERE excluded.verified_at>=runtime_directory_status.verified_at",
          [
            subject.principalId,
            this.options.directoryProviderId,
            fingerprint(subject),
            proof.active,
            new Date(at),
            new Date(until),
          ],
        );
        if (proof.active === false) throw Error("UNAUTHENTICATED");
        if (proof.active !== true) throw Error("DIRECTORY_STATUS_UNKNOWN");
      } catch (error) {
        if (error instanceof Error && error.message === "UNAUTHENTICATED")
          throw error;
        await this.pool.query(
          "UPDATE runtime_directory_status SET active=CASE WHEN active IS FALSE THEN FALSE ELSE NULL END,valid_until=greatest(verified_at,least(valid_until,clock_timestamp())) WHERE principal_id=$1",
          [subject.principalId],
        );
        throw Error("DIRECTORY_STATUS_UNKNOWN");
      }
    })();
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
  }
}
