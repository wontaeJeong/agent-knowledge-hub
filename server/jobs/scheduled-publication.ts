import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { audit, membership, requireRead } from "../repository";
import { authorizeActionDb } from "../access";
import {
  digest,
  publishInTransaction,
  preparePublicationDb,
} from "../publication";
import { assertFeature } from "../policy/features";
import { defaultSessionPolicy, type SessionPolicy } from "../identity/sessions";

const input = z
  .object({ hash: z.string().regex(/^[a-f0-9]{64}$/), dueAt: z.iso.datetime() })
  .strict();
const consent = input.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal("SCHEDULE_APPROVED_PUBLICATION"),
});
export type ScheduledPublicationRow = {
  id: string;
  workspace_id: string;
  batch_id: string;
  hash: string;
  principal_id: string;
  session_id: string | null;
  grant_role: string;
  grant_expires_at: Date | string;
  due_at: Date | string;
  status: string;
  created_at: Date | string;
  finished_at: Date | string | null;
  result: { batchId: string; versions: Record<string, number> } | null;
  error_code: string | null;
};
/** Human consent authorizes one fixed reviewed batch, bound to its current session.
 * This worker has no independent publisher identity and cannot extend session lifetime. */
export class ScheduledPublicationService {
  constructor(
    readonly pool: Pool,
    readonly authorizer: (row: ScheduledPublicationRow) => Promise<Context>,
    readonly sessionPolicy: SessionPolicy = defaultSessionPolicy,
  ) {}
  private async human(db: PoolClient, ctx: Context) {
    if (
      ctx.credentialId ||
      ctx.agent ||
      !ctx.authorization?.sessionId ||
      !/^[a-f0-9]{64}$/.test(ctx.authorization.sessionId)
    )
      throw Error("FORBIDDEN");
    await ctx.authorization.assertSession(db);
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [ctx.principalId],
        )
      ).rowCount
    )
      throw Error("FORBIDDEN");
    await membership(db, ctx);
  }
  private async inspect(
    db: PoolClient,
    ctx: Context,
    batchId: string,
    d: z.infer<typeof input>,
  ) {
    await this.human(db, ctx);
    await assertFeature(
      db,
      ctx,
      "scheduledPublication",
      undefined,
      "changeset.publish",
    );
    const session = (
      await db.query(
        `SELECT LEAST(s.expires_at,a.created_at+$3*interval '1 second',a.last_seen_at+$4*interval '1 second') AS expiry FROM runtime_sessions s JOIN identity_session_activity a ON a.session_id=s.id WHERE s.id=$1 AND s.principal_id=$2 FOR SHARE OF s`,
        [
          ctx.authorization!.sessionId,
          ctx.principalId,
          this.sessionPolicy.absoluteSeconds,
          this.sessionPolicy.idleSeconds,
        ],
      )
    ).rows[0];
    const dueAt = new Date(d.dueAt).toISOString(),
      now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
    if (new Date(dueAt).getTime() <= new Date(now).getTime())
      throw Error("SCHEDULE_TIME_INVALID");
    if (
      !session ||
      new Date(dueAt).getTime() >= new Date(session.expiry).getTime()
    )
      throw Error("SCHEDULE_AUTHORIZATION_EXPIRES");
    const b = (
      await db.query(
        "SELECT data->>'status' AS status FROM batches WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, batchId],
      )
    ).rows[0];
    if (b?.status !== "approved") throw Error("APPROVAL_STALE");
    const prepared = await preparePublicationDb(
      db,
      ctx,
      batchId,
      d.hash,
      `schedule-preview:${randomUUID()}`,
    );
    if ("replay" in prepared) throw Error("APPROVAL_STALE");
    const versions = Object.fromEntries(
      prepared.batch.updates.map((d) => [
        d.id,
        prepared.next.pages.find((p) => p.id === d.id)!.versions.at(-1)!.number,
      ]),
    );
    const expiresAt = new Date(session.expiry).toISOString();
    return {
      batchId,
      hash: d.hash,
      dueAt,
      authorizationExpiresAt: expiresAt,
      versions,
      previewHash: digest([
        ctx.workspaceId,
        ctx.principalId,
        ctx.authorization!.sessionId,
        batchId,
        d.hash,
        dueAt,
        expiresAt,
        prepared.permissionSnapshot.hash,
        prepared.qualification?.policy_version ?? null,
      ]),
    };
  }
  async preview(ctx: Context, batchId: string, raw: unknown) {
    const d = input.parse(raw);
    await ctx.authorization?.revalidate();
    return transaction(this.pool, ctx.workspaceId, (db) =>
      this.inspect(db, ctx, batchId, d),
    );
  }
  async create(ctx: Context, batchId: string, raw: unknown, key: string) {
    const d = consent.parse(raw);
    if (!key?.trim() || key.length > 200) throw Error("VALIDATION_FAILED");
    await ctx.authorization?.revalidate();
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.human(db, ctx);
      const requestHash = digest([
        batchId,
        d.hash,
        new Date(d.dueAt).toISOString(),
        d.previewHash,
      ]);
      const replay = (
        await db.query(
          "SELECT * FROM scheduled_publications WHERE workspace_id=$1 AND principal_id=$2 AND request_key=$3",
          [ctx.workspaceId, ctx.principalId, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return this.dto(replay);
      }
      const preview = await this.inspect(db, ctx, batchId, d);
      if (preview.previewHash !== d.previewHash)
        throw Error("SCHEDULE_PREVIEW_STALE");
      if (
        (
          await db.query(
            "SELECT 1 FROM scheduled_publications WHERE workspace_id=$1 AND batch_id=$2 AND status='scheduled'",
            [ctx.workspaceId, batchId],
          )
        ).rowCount
      )
        throw Error("SCHEDULE_ALREADY_EXISTS");
      const id = randomUUID();
      const row = (
        await db.query(
          `INSERT INTO scheduled_publications(workspace_id,id,batch_id,hash,principal_id,session_id,grant_role,grant_expires_at,due_at,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,'reviewer',$7,$8,$9,$10) RETURNING *`,
          [
            ctx.workspaceId,
            id,
            batchId,
            d.hash,
            ctx.principalId,
            ctx.authorization!.sessionId,
            preview.authorizationExpiresAt,
            preview.dueAt,
            key,
            requestHash,
          ],
        )
      ).rows[0];
      await audit(db, ctx, "batch.schedule", batchId);
      return this.dto(row);
    });
  }
  private dto(row: ScheduledPublicationRow) {
    return {
      id: row.id,
      batchId: row.batch_id,
      hash: row.hash,
      status: row.status,
      dueAt: new Date(row.due_at).toISOString(),
      authorizationExpiresAt: new Date(row.grant_expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      finishedAt: row.finished_at
        ? new Date(row.finished_at).toISOString()
        : null,
      result: row.result,
      errorCode: row.error_code,
    };
  }
  private async own(db: PoolClient, ctx: Context, id: string) {
    await this.human(db, ctx);
    const row = (
      await db.query(
        "SELECT * FROM scheduled_publications WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 FOR UPDATE",
        [ctx.workspaceId, id, ctx.principalId],
      )
    ).rows[0] as ScheduledPublicationRow | undefined;
    if (!row) throw Error("NOT_FOUND");
    return row;
  }
  async read(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id);
      if (row.result)
        for (const pageId of Object.keys(row.result.versions))
          await requireRead(db, ctx, "page", pageId);
      return this.dto(row);
    });
  }
  async list(ctx: Context, batchId: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.human(db, ctx);
      const rows = (
        await db.query(
          "SELECT * FROM scheduled_publications WHERE workspace_id=$1 AND principal_id=$2 AND batch_id=$3 ORDER BY created_at DESC LIMIT 25",
          [ctx.workspaceId, ctx.principalId, batchId],
        )
      ).rows as ScheduledPublicationRow[];
      return { items: rows.map((r) => this.dto({ ...r, result: null })) };
    });
  }
  async cancel(ctx: Context, id: string) {
    await ctx.authorization?.revalidate();
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id);
      if (row.status === "scheduled") {
        await db.query(
          "UPDATE scheduled_publications SET status='cancelled',finished_at=clock_timestamp(),session_id=NULL WHERE id=$1",
          [id],
        );
        await audit(db, ctx, "batch.schedule.cancel", row.batch_id);
        row.status = "cancelled";
        row.finished_at = new Date();
      } else if (row.status !== "cancelled") throw Error("SCHEDULE_FINISHED");
      return this.dto(row);
    });
  }
  /** Network proof is obtained before the workspace transaction. The exact human
   * session and authority are asserted again inside it immediately before publish. */
  async runDue() {
    const rows = (
      await this.pool.query(
        "SELECT * FROM scheduled_publications WHERE status='scheduled' AND due_at<=clock_timestamp() ORDER BY due_at LIMIT 25",
      )
    ).rows as ScheduledPublicationRow[];
    for (const candidate of rows) {
      let ctx: Context | undefined,
        authFailed = false;
      try {
        ctx = await this.authorizer(candidate);
        if (
          ctx.workspaceId !== candidate.workspace_id ||
          ctx.principalId !== candidate.principal_id ||
          ctx.authorization?.sessionId !== candidate.session_id
        )
          throw Error("AUTHORIZATION_REQUIRED");
      } catch {
        authFailed = true;
      }
      try {
        await transaction(this.pool, candidate.workspace_id, async (db) => {
          const row = (
            await db.query(
              "SELECT * FROM scheduled_publications WHERE id=$1 FOR UPDATE",
              [candidate.id],
            )
          ).rows[0] as ScheduledPublicationRow | undefined;
          if (!row || row.status !== "scheduled") return;
          if (authFailed || !ctx) throw Error("AUTHORIZATION_REQUIRED");
          if (new Date(row.grant_expires_at).getTime() <= Date.now())
            throw Error("AUTHORIZATION_REQUIRED");
          await this.human(db, ctx);
          await authorizeActionDb(db, ctx, "changeset.publish");
          await assertFeature(
            db,
            ctx,
            "scheduledPublication",
            undefined,
            "changeset.publish",
          );
          const result = await publishInTransaction(
            this.pool,
            db,
            ctx,
            row.batch_id,
            row.hash,
            `scheduled-publication:${row.id}`,
          );
          await db.query(
            "UPDATE scheduled_publications SET status='published',finished_at=clock_timestamp(),result=$2,session_id=NULL WHERE id=$1",
            [row.id, result],
          );
        });
      } catch (e) {
        const code =
          e instanceof Error && /^[A-Z_]{1,80}$/.test(e.message)
            ? e.message
            : "PUBLICATION_FAILED";
        // Failed publication rolled back in full. A concurrent cancellation or a
        // successful duplicate worker cannot be overwritten by this failure receipt.
        await transaction(this.pool, candidate.workspace_id, async (db) => {
          await db.query(
            "UPDATE scheduled_publications SET status='failed',finished_at=clock_timestamp(),error_code=$2,session_id=NULL WHERE id=$1 AND status='scheduled'",
            [candidate.id, code],
          );
        });
      }
    }
    return { examined: rows.length };
  }
}
