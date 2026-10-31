import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Context } from "../service";
import { assertFreshDirectoryHuman } from "./directory";
import {
  assertSessionPolicy,
  defaultSessionPolicy,
  identityEvent,
  identityTransaction,
  sessionBinding,
  type DB,
  type SessionPolicy,
} from "./sessions";

export const emergencyActions = [
  "knowledge.read",
  "queue.triage",
  "triage.manage",
] as const;
export type EmergencyAction = (typeof emergencyActions)[number];
export type EmergencyRequest = {
  reason: string;
  pageIds: string[];
  actions: EmergencyAction[];
  minutes: number;
};
export interface EmergencyConfiguration {
  platformEmergencyApproverIds: readonly string[];
  sessionPolicy?: SessionPolicy;
  /** Re-fetch current IdP proof; never use cached login or a request assertion. */
  assertFreshHuman: (db: DB, ctx: Context) => Promise<void>;
  /** Mandatory original-source/provenance ceiling, including all ancestry, holds
   * and resource lifecycle. Cannot call emergency capabilities recursively. */
  assertSourceUpperBound: (
    db: DB,
    ctx: Context,
    pageIds: readonly string[],
  ) => Promise<void>;
}
export class EmergencyAccess {
  private readonly approvers: ReadonlySet<string>;
  constructor(
    readonly pool: Pool,
    private readonly config: EmergencyConfiguration,
  ) {
    if (
      !config.platformEmergencyApproverIds.length ||
      config.platformEmergencyApproverIds.some((id) => !id)
    )
      throw Error("EMERGENCY_APPROVERS_REQUIRED");
    this.approvers = new Set(config.platformEmergencyApproverIds);
  }
  private async human(db: DB, ctx: Context) {
    await assertSessionPolicy(
      db,
      sessionBinding(ctx),
      this.config.sessionPolicy ?? defaultSessionPolicy,
    );
    await this.config.assertFreshHuman(db, ctx);
    await assertFreshDirectoryHuman(db, ctx);
  }
  async request(ctx: Context, input: EmergencyRequest) {
    if (
      typeof input.reason !== "string" ||
      input.reason.trim().length < 10 ||
      input.reason.length > 2000 ||
      !Number.isSafeInteger(input.minutes) ||
      input.minutes < 1 ||
      input.minutes > 30 ||
      !Array.isArray(input.pageIds) ||
      input.pageIds.length < 1 ||
      input.pageIds.length > 100 ||
      input.pageIds.some(
        (id) => typeof id !== "string" || !id || id.length > 100,
      ) ||
      !Array.isArray(input.actions) ||
      !input.actions.length ||
      input.actions.some((a) => !emergencyActions.includes(a))
    )
      throw Error("INVALID_EMERGENCY_REQUEST");
    return identityTransaction(this.pool, async (db) => {
      await this.human(db, ctx);
      const id = randomUUID();
      const row = (
        await db.query(
          `INSERT INTO identity_emergencies(id,workspace_id,requester_id,reason,page_ids,actions,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 minute') RETURNING id,revision,expires_at AS "expiresAt",status`,
          [
            id,
            ctx.workspaceId,
            ctx.principalId,
            input.reason.trim(),
            [...new Set(input.pageIds)],
            [...new Set(input.actions)],
            input.minutes,
          ],
        )
      ).rows[0];
      await identityEvent(db, ctx.principalId, "emergency.request", id, {
        reason: input.reason.trim(),
        pageIds: input.pageIds,
        actions: input.actions,
        expiresAt: row.expiresAt,
      });
      return row as {
        id: string;
        revision: number;
        expiresAt: Date;
        status: string;
      };
    });
  }
  async decide(
    ctx: Context,
    id: string,
    expectedRevision: number,
    decision: "approved" | "rejected",
  ) {
    if (
      !this.approvers.has(ctx.principalId) ||
      !["approved", "rejected"].includes(decision)
    )
      throw Error("FORBIDDEN");
    return identityTransaction(this.pool, async (db) => {
      await this.human(db, ctx);
      const row = (
        await db.query(
          `SELECT e.*,p.active,p.kind FROM identity_emergencies e
    JOIN access_principals p ON p.id=e.requester_id WHERE e.id=$1 AND e.workspace_id=$2 FOR UPDATE OF e`,
          [id, ctx.workspaceId],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      if (row.requester_id === ctx.principalId) throw Error("FORBIDDEN");
      if (row.revision !== expectedRevision || row.status !== "pending")
        throw Error("STALE_VERSION");
      if (!row.active || row.kind !== "human") throw Error("FORBIDDEN");
      // DB time, not browser clock, decides the fixed non-renewing deadline.
      const live = await db.query(
        "SELECT 1 FROM identity_emergencies WHERE id=$1 AND expires_at>clock_timestamp()",
        [id],
      );
      if (!live.rowCount) throw Error("EMERGENCY_EXPIRED");
      if (decision === "approved") {
        const requester = {
          workspaceId: row.workspace_id,
          principalId: row.requester_id,
        };
        await this.config.assertFreshHuman(db, requester);
        await assertFreshDirectoryHuman(db, requester);
        await this.config.assertSourceUpperBound(db, requester, row.page_ids);
      }
      await db.query(
        "UPDATE identity_emergencies SET status=$2,approver_id=$3,revision=revision+1 WHERE id=$1",
        [id, decision, ctx.principalId],
      );
      await identityEvent(db, ctx.principalId, `emergency.${decision}`, id, {
        revision: expectedRevision + 1,
      });
      return { id, status: decision, revision: expectedRevision + 1 };
    });
  }
  async revoke(ctx: Context, id: string, expectedRevision: number) {
    return identityTransaction(this.pool, async (db) => {
      await this.human(db, ctx);
      const found = await db.query(
        `UPDATE identity_emergencies SET status='revoked',revision=revision+1
    WHERE id=$1 AND workspace_id=$2 AND revision=$3 AND status IN ('pending','approved')
    AND (requester_id=$4 OR $5) RETURNING revision`,
        [
          id,
          ctx.workspaceId,
          expectedRevision,
          ctx.principalId,
          this.approvers.has(ctx.principalId),
        ],
      );
      if (!found.rowCount) throw Error("STALE_VERSION");
      await identityEvent(db, ctx.principalId, "emergency.revoked", id);
      return { id, status: "revoked", revision: found.rows[0].revision };
    });
  }
  async list(ctx: Context, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw Error("INVALID_PAGE");
    return identityTransaction(this.pool, async (db) => {
      await this.human(db, ctx);
      const found = await db.query(
        `SELECT id,reason,page_ids AS "pageIds",actions,revision,expires_at AS "expiresAt",
    CASE WHEN status IN ('pending','approved') AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END AS status,
    requester_id=$3 AS own, requester_id<>$3 AND status='pending' AND expires_at>clock_timestamp() AND $4 AS "canDecide",
    count(*) OVER()::integer AS total
    FROM identity_emergencies WHERE workspace_id=$1 AND (requester_id=$3 OR $4)
    ORDER BY created_at DESC,id LIMIT 25 OFFSET $2`,
        [
          ctx.workspaceId,
          offset,
          ctx.principalId,
          this.approvers.has(ctx.principalId),
        ],
      );
      return {
        items: found.rows.map(({ total: _, ...r }) => r),
        total: found.rows[0]?.total ?? 0,
        offset,
        limit: 25,
      };
    });
  }
  /** HOST HOOK: within canonical effectiveAccess/authorize, combine these actions
   * for the exact page only, NOT an Admin role. canonicalConstraintActions is the
   * host's current non-role ceiling (raw ancestry, restrictions, lifecycle etc).
   * Retain all existing final read/provenance/egress/hold assertions afterward.
   * Never feed this result back as canonicalConstraintActions or a grant source. */
  async emergencyEffectiveCapabilities(
    db: DB,
    ctx: Context,
    pageId: string,
    canonicalConstraintActions: readonly string[],
  ): Promise<string[]> {
    await this.human(db, ctx);
    const rows = await db.query(
      `SELECT e.id,e.actions FROM identity_emergencies e
   JOIN access_principals a ON a.id=e.approver_id AND a.active AND a.kind='human'
   WHERE e.workspace_id=$1 AND e.requester_id=$2 AND e.status='approved' AND e.expires_at>clock_timestamp()
   AND $3=ANY(e.page_ids) AND e.approver_id=ANY($4::text[]) FOR SHARE OF e,a`,
      [ctx.workspaceId, ctx.principalId, pageId, [...this.approvers]],
    );
    if (!rows.rowCount) return [];
    await this.config.assertSourceUpperBound(db, ctx, [pageId]);
    const allowed = [
      ...new Set<string>(rows.rows.flatMap((r) => r.actions as string[])),
    ].filter(
      (a) =>
        emergencyActions.includes(a as EmergencyAction) &&
        canonicalConstraintActions.includes(a),
    );
    if (allowed.length)
      await identityEvent(db, ctx.principalId, "emergency.use", pageId, {
        grants: rows.rows.map((r) => r.id),
        actions: allowed,
      });
    return allowed;
  }
}
