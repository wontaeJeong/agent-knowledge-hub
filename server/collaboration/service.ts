import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { loadState } from "../repository";
import { captureEnvelope, fingerprint } from "../provenance";
import { current } from "../../src/domain/wiki";
import { nextDigest, afterQuietHours, inQuietHours } from "./time";
import type {
  Cadence,
  CollaborationHooks,
  DeliveryLease,
  DeliveryReceipt,
  DigestGateway,
  DigestPayload,
  Preferences,
  RecipientProof,
  Responsibility,
} from "./types";
type Row = Record<string, any>;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  id = z.string().min(1).max(200);
const fields = z
  .object({
    mentions: z.boolean(),
    subscriptions: z.boolean(),
    dailyDigest: z.boolean(),
    weeklyDigest: z.boolean(),
    timezone: z.string().min(1).max(100),
    dailyAt: time,
    weeklyAt: time,
    weeklyDay: z.number().int().min(0).max(6),
    quietHours: z
      .object({ enabled: z.boolean(), start: time, end: time })
      .strict(),
  })
  .strict();
const defaults: Preferences = {
  mentions: true,
  subscriptions: true,
  dailyDigest: false,
  weeklyDigest: false,
  timezone: "UTC",
  dailyAt: "09:00",
  weeklyAt: "09:00",
  weeklyDay: 1,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};
const code = (e: unknown) =>
  e instanceof Error && /^[A-Z0-9_]{1,80}$/.test(e.message)
    ? e.message
    : "COLLABORATION_UNAVAILABLE";
const denied = (e: unknown) =>
  e instanceof Error &&
  [
    "NOT_FOUND",
    "FORBIDDEN",
    "STALE_VERSION",
    "DOCUMENT_PROTECTED",
    "UNAUTHENTICATED",
  ].includes(e.message);
const date = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v) : null;
export interface CollaborationOptions {
  clock?: () => Date;
  applicationOrigin: string;
  gateway?: DigestGateway;
  leaseMs?: number;
  maxAttempts?: number;
  identityTimeoutMs?: number;
  maxEvents?: number;
}
function preferences(data: Row): Preferences {
  const p = fields.parse({
    ...defaults,
    ...Object.fromEntries(
      Object.keys(defaults)
        .filter((k) => data[k] !== undefined)
        .map((k) => [k, data[k]]),
    ),
  });
  new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
  if (p.quietHours.enabled && p.quietHours.start === p.quietHours.end)
    throw Error("INVALID_QUIET_HOURS");
  return p;
}
const prefHash = (r: Row | undefined) =>
  fingerprint({ revision: r?.revision ?? 0, data: r?.data ?? defaults });
async function hasTable(db: PoolClient, name: string) {
  return Boolean(
    (
      await db.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=$1",
        [name],
      )
    ).rowCount,
  );
}
/** Real governance102 adapter; missing table/assignment stays unassigned, never
 * substitutes namespace Owner, proposer or reviewer for business responsibility. */
export async function resolveGovernanceResponsibility(
  db: PoolClient,
  input: { workspaceId: string; pageId: string; documentType: string },
): Promise<Responsibility> {
  if (!(await hasTable(db, "governance_business_owners")))
    return { ownerId: null, backupId: null, revision: "unassigned" };
  const r = (
    await db.query(
      "SELECT owner_id,backup_id,revision FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2",
      [input.workspaceId, input.pageId],
    )
  ).rows[0];
  return r
    ? {
        ownerId: r.owner_id,
        backupId: r.backup_id,
        revision: String(r.revision),
      }
    : { ownerId: null, backupId: null, revision: "unassigned" };
}
export class CollaborationService {
  readonly clock: () => Date;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly origin: string;
  constructor(
    readonly pool: Pool,
    readonly hooks: CollaborationHooks,
    readonly options: CollaborationOptions,
  ) {
    if (
      !hooks?.authorize ||
      !hooks.assertDispatcher ||
      !hooks.verifyRecipient ||
      !hooks.resolveReviewResponsibility
    )
      throw Error("COLLABORATION_AUTHORIZATION_REQUIRED");
    const app = new URL(options.applicationOrigin);
    if (
      app.protocol !== "https:" ||
      app.username ||
      app.password ||
      app.search ||
      app.hash ||
      app.pathname !== "/"
    )
      throw Error("APPLICATION_ORIGIN_NOT_APPROVED");
    this.origin = app.origin;
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30000;
    this.maxAttempts = options.maxAttempts ?? 6;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 100 ||
      this.leaseMs > 300000 ||
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 10
    )
      throw Error("COLLABORATION_CONFIGURATION");
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      await db.query("SELECT pg_advisory_xact_lock(822025)");
      const r = await work(db);
      await db.query("COMMIT");
      return r;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async request<T>(
    ctx: Context,
    action: string,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    Object.freeze(ctx);
    await ctx.authorization?.revalidate();
    const result = await this.tx(async (db) => {
      await ctx.authorization?.assertSession(db);
      await this.hooks.authorize(db, ctx, action);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async active(
    db: PoolClient,
    workspaceId: string,
    principalId: string,
  ) {
    if (
      !(
        await db.query(
          "SELECT issuer,subject FROM access_principals WHERE id=$1 AND active AND kind='human' FOR SHARE",
          [principalId],
        )
      ).rowCount
    )
      throw Error("RECIPIENT_DISABLED");
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_spaces WHERE workspace_id=$1 AND active",
          [workspaceId],
        )
      ).rowCount
    )
      throw Error("NOT_FOUND");
    return (
      await db.query(
        "SELECT issuer,subject FROM access_principals WHERE id=$1",
        [principalId],
      )
    ).rows[0];
  }
  private async verify(
    workspaceId: string,
    principalId: string,
  ): Promise<RecipientProof> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const p = await Promise.race([
        this.hooks.verifyRecipient(
          Object.freeze({ workspaceId, principalId }),
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("RECIPIENT_STATUS_UNKNOWN"));
          }, this.options.identityTimeoutMs ?? 5000);
        }),
      ]);
      if (
        p.ctx.workspaceId !== workspaceId ||
        p.ctx.principalId !== principalId ||
        typeof p.assertCurrent !== "function" ||
        !p.issuer ||
        !p.subject ||
        !date(p.verifiedAt) ||
        !date(p.validUntil) ||
        +new Date(p.verifiedAt) > +this.clock() + 5000 ||
        +new Date(p.validUntil) <= +this.clock() ||
        +new Date(p.validUntil) - +new Date(p.verifiedAt) > 30000
      )
        throw Error("RECIPIENT_STATUS_UNKNOWN");
      if (
        p.address !== null &&
        !/^[^\s@\r\n]{1,100}@[^\s@\r\n]{1,150}\.[^\s@\r\n]{1,60}$/.test(
          p.address,
        )
      )
        throw Error("RECIPIENT_ADDRESS_INVALID");
      return p;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async assertProof(db: PoolClient, p: RecipientProof) {
    if (+new Date(p.validUntil) <= +this.clock())
      throw Error("RECIPIENT_STATUS_UNKNOWN");
    const person = await this.active(db, p.ctx.workspaceId, p.ctx.principalId);
    if (
      (person.issuer && person.issuer !== p.issuer) ||
      (person.subject && person.subject !== p.subject)
    )
      throw Error("RECIPIENT_BINDING_CHANGED");
    await p.assertCurrent(db);
    await this.hooks.authorize(db, p.ctx, "knowledge.read");
  }
  private async prefRow(
    db: PoolClient,
    workspaceId: string,
    principalId: string,
  ) {
    return (
      await db.query(
        "SELECT revision,data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
        [workspaceId, principalId],
      )
    ).rows[0];
  }
  async preferences(ctx: Context, input?: unknown) {
    const result = await this.request(ctx, "knowledge.read", async (db) => {
      const old = await this.prefRow(db, ctx.workspaceId, ctx.principalId);
      if (input === undefined)
        return {
          ...preferences(old?.data ?? {}),
          revision: old?.revision ?? 0,
        };
      const patch = fields
        .partial()
        .extend({ expectedRevision: z.number().int().min(0) })
        .strict()
        .parse(input);
      if ((old?.revision ?? 0) !== patch.expectedRevision)
        throw Error("STALE_VERSION");
      const { expectedRevision, ...changes } = patch,
        data = { ...(old?.data ?? {}), ...changes };
      preferences(data);
      const revision = expectedRevision + 1;
      await db.query(
        "INSERT INTO workflow_preferences VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
        [ctx.workspaceId, ctx.principalId, revision, data],
      );
      return { ...preferences(data), revision };
    });
    if (input !== undefined) await this.syncPlans();
    return result;
  }
  async syncPlans() {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const rows = (
        await db.query(
          "SELECT workspace_id,principal_id,revision,data FROM workflow_preferences",
        )
      ).rows;
      let changed = 0;
      for (const r of rows) {
        let p: Preferences;
        try {
          p = preferences(r.data);
        } catch {
          continue;
        }
        const h = prefHash(r);
        const old = (
          await db.query(
            "SELECT * FROM collaboration_digest_plans WHERE workspace_id=$1 AND principal_id=$2 AND status='active'",
            [r.workspace_id, r.principal_id],
          )
        ).rows;
        for (const plan of old)
          if (
            plan.preference_hash !== h ||
            !(plan.cadence === "daily" ? p.dailyDigest : p.weeklyDigest)
          ) {
            await db.query(
              "UPDATE collaboration_digest_plans SET status='superseded',updated_at=$2 WHERE id=$1",
              [plan.id, this.clock()],
            );
            await db.query(
              "UPDATE collaboration_digest_outbox SET status=CASE WHEN dispatch_started_at IS NULL THEN 'superseded' ELSE 'needs-reconciliation' END,error_code='PREFERENCES_CHANGED',updated_at=$2 WHERE plan_id=$1 AND status IN ('queued','retry','running','unconfigured')",
              [plan.id, this.clock()],
            );
          }
        for (const cadence of ["daily", "weekly"] as Cadence[])
          if (cadence === "daily" ? p.dailyDigest : p.weeklyDigest) {
            if (
              (
                await db.query(
                  "SELECT 1 FROM collaboration_digest_plans WHERE workspace_id=$1 AND principal_id=$2 AND cadence=$3 AND preference_hash=$4",
                  [r.workspace_id, r.principal_id, cadence, h],
                )
              ).rowCount
            )
              continue;
            const prior = (
              await db.query(
                "SELECT cursor_at FROM collaboration_digest_plans WHERE workspace_id=$1 AND principal_id=$2 AND cadence=$3 ORDER BY cursor_at DESC LIMIT 1",
                [r.workspace_id, r.principal_id, cadence],
              )
            ).rows[0];
            let cursor = new Date(
                +this.clock() - (cadence === "daily" ? 2 : 15) * 86400000,
              ),
              next = nextDigest(p, cadence, cursor);
            for (let i = 0; i < 32 && +next <= +this.clock(); i++) {
              cursor = next;
              next = nextDigest(p, cadence, next);
            }
            if (prior) cursor = new Date(prior.cursor_at);
            await db.query(
              "INSERT INTO collaboration_digest_plans VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$10)",
              [
                randomUUID(),
                r.workspace_id,
                r.principal_id,
                cadence,
                r.revision,
                h,
                p,
                cursor,
                nextDigest(p, cadence, this.clock()),
                this.clock(),
              ],
            );
            changed++;
          }
      }
      return changed;
    });
  }
  async planDigests() {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const plans = (
        await db.query(
          "SELECT * FROM collaboration_digest_plans WHERE status='active' AND next_at<=$1 ORDER BY next_at,id LIMIT 100 FOR UPDATE SKIP LOCKED",
          [this.clock()],
        )
      ).rows;
      let count = 0;
      for (const p of plans) {
        if (
          (
            await db.query(
              "SELECT 1 FROM collaboration_digest_outbox WHERE plan_id=$1 AND status NOT IN ('delivered','no-delivery','superseded')",
              [p.id],
            )
          ).rowCount
        )
          continue;
        const rows = (
          await db.query(
            "SELECT n.id FROM workflow_notifications n WHERE n.workspace_id=$1 AND n.principal_id=$2 AND n.created_at>$3 AND n.created_at<=$4 AND NOT EXISTS(SELECT 1 FROM collaboration_digest_outbox old WHERE old.workspace_id=n.workspace_id AND old.principal_id=n.principal_id AND old.cadence=$5 AND old.dispatch_started_at IS NOT NULL AND n.id=ANY(old.event_ids)) ORDER BY n.created_at,n.id",
            [p.workspace_id, p.principal_id, p.cursor_at, p.next_at, p.cadence],
          )
        ).rows;
        const eventIds = rows.map((r) => r.id),
          deliveryId =
            "digest_" + fingerprint([p.id, new Date(p.next_at).toISOString()]);
        await db.query(
          "INSERT INTO collaboration_digest_outbox(id,plan_id,workspace_id,principal_id,cadence,preference_hash,event_ids,window_start,window_end,available_at,status,max_attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,$10) ON CONFLICT(plan_id,window_end) DO NOTHING",
          [
            deliveryId,
            p.id,
            p.workspace_id,
            p.principal_id,
            p.cadence,
            p.preference_hash,
            eventIds,
            p.cursor_at,
            p.next_at,
            this.clock(),
            eventIds.length ? "queued" : "no-delivery",
            this.maxAttempts,
          ],
        );
        if (!eventIds.length)
          await db.query(
            "UPDATE collaboration_digest_plans SET cursor_at=$2 WHERE id=$1",
            [p.id, p.next_at],
          );
        await db.query(
          "UPDATE collaboration_digest_plans SET next_at=$2,updated_at=$3 WHERE id=$1",
          [
            p.id,
            nextDigest(p.preferences, p.cadence, new Date(p.next_at)),
            this.clock(),
          ],
        );
        count++;
      }
      return count;
    });
  }
  private async eligible(
    db: PoolClient,
    ctx: Context,
    p: Preferences,
    events: Row[],
  ) {
    const state = await loadState(db, ctx.workspaceId),
      groups = new Map<
        string,
        { pageId: string; title: string; url: string; eventIds: string[] }
      >();
    const fingerprints: unknown[] = [];
    for (const n of events) {
      try {
        if (n.kind === "comment") {
          const c = (
            await db.query(
              "SELECT data,deleted FROM workflow_comments WHERE workspace_id=$1 AND id=$2",
              [ctx.workspaceId, n.data.commentId],
            )
          ).rows[0];
          if (!c || c.deleted) continue;
          const mention = c.data.mentions?.includes(ctx.principalId),
            subscription = Boolean(
              (
                await db.query(
                  "SELECT 1 FROM workflow_subscriptions WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3",
                  [ctx.workspaceId, ctx.principalId, n.page_id],
                )
              ).rowCount,
            );
          if (!((mention && p.mentions) || (subscription && p.subscriptions)))
            continue;
        } else if (!n.kind.startsWith("review-") && !p.subscriptions) continue;
        await this.hooks.authorize(db, ctx, "knowledge.read", {
          kind: "page",
          id: n.page_id,
          ...(n.version ? { version: n.version } : {}),
        });
        const page = state.pages.find((page) => page.id === n.page_id);
        if (!page) continue;
        const version = n.version
          ? page.versions.find((v) => v.number === n.version)
          : current(page);
        if (!version) continue;
        for (const sid of version.sourceIds)
          await this.hooks.authorize(db, ctx, "knowledge.read", {
            kind: "source",
            id: sid,
          });
        const envelope = await captureEnvelope(
          db,
          ctx,
          state,
          [page.id],
          version.sourceIds,
        );
        fingerprints.push([
          n.id,
          n.page_id,
          n.version,
          n.kind,
          n.data,
          envelope,
        ]);
        let group = groups.get(page.id);
        if (!group) {
          group = {
            pageId: page.id,
            title: page.title.replace(/[\u0000-\u001f]/g, " ").slice(0, 300),
            url: `${this.origin}/?app=1#/wiki/${encodeURIComponent(page.id)}`,
            eventIds: [],
          };
          groups.set(page.id, group);
        }
        group.eventIds.push(n.id);
      } catch (e) {
        if (!denied(e)) throw e;
      }
    }
    return {
      items: [...groups.values()],
      inputHash: fingerprint(fingerprints),
    };
  }
  private async currentPlan(db: PoolClient, row: Row) {
    const plan = (
        await db.query("SELECT * FROM collaboration_digest_plans WHERE id=$1", [
          row.plan_id,
        ])
      ).rows[0],
      pref = await this.prefRow(db, row.workspace_id, row.principal_id);
    if (
      !plan ||
      plan.status !== "active" ||
      prefHash(pref) !== row.preference_hash
    )
      throw Error("PREFERENCES_CHANGED");
    return plan;
  }
  private async events(db: PoolClient, row: Row) {
    return (
      await db.query(
        "SELECT * FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 AND id=ANY($3::text[]) ORDER BY created_at,id",
        [row.workspace_id, row.principal_id, row.event_ids],
      )
    ).rows;
  }
  private async owned(db: PoolClient, ctx: Context, deliveryId: string) {
    const row = (
      await db.query(
        "SELECT * FROM collaboration_digest_outbox WHERE id=$1 AND workspace_id=$2 AND principal_id=$3",
        [deliveryId, ctx.workspaceId, ctx.principalId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    return row;
  }
  private dto(row: Row) {
    return {
      id: row.id,
      cadence: row.cadence,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      from: row.window_start,
      to: row.window_end,
      retryAt: row.available_at,
      error: row.error_code,
      receiptId: row.receipt_id,
      deliveredAt: row.delivered_at,
    };
  }
  async deliveries(ctx: Context, offset = 0) {
    z.number().int().min(0).parse(offset);
    return this.request(ctx, "knowledge.read", async (db) => ({
      items: (
        await db.query(
          "SELECT * FROM collaboration_digest_outbox WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC,id LIMIT 25 OFFSET $3",
          [ctx.workspaceId, ctx.principalId, offset],
        )
      ).rows.map((r) => this.dto(r)),
      nextOffset: offset + 25,
    }));
  }
  async notifications(ctx: Context, offset = 0) {
    return this.request(ctx, "knowledge.read", async (db) => {
      const p = preferences(
          (await this.prefRow(db, ctx.workspaceId, ctx.principalId))?.data ??
            {},
        ),
        rows = (
          await db.query(
            "SELECT * FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC,id LIMIT 25 OFFSET $3",
            [ctx.workspaceId, ctx.principalId, offset],
          )
        ).rows;
      const result = await this.eligible(db, ctx, p, rows);
      return {
        items: result.items,
        nextOffset: rows.length === 25 ? offset + 25 : null,
      };
    });
  }
  async ackNotification(ctx: Context, notificationId: string) {
    return this.request(ctx, "knowledge.read", async (db) => {
      const n = (
        await db.query(
          "SELECT * FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, id.parse(notificationId)],
        )
      ).rows[0];
      if (!n) throw Error("NOT_FOUND");
      const p = preferences(
        (await this.prefRow(db, ctx.workspaceId, ctx.principalId))?.data ?? {},
      );
      if (
        !(
          await this.eligible(
            db,
            ctx,
            { ...p, mentions: true, subscriptions: true },
            [n],
          )
        ).items.length
      )
        throw Error("NOT_FOUND");
      await db.query(
        "UPDATE workflow_notifications SET read_at=$4 WHERE workspace_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.principalId, n.id, this.clock()],
      );
      return { id: n.id, read: true };
    });
  }
  async previewDigest(ctx: Context, cadence: Cadence) {
    z.enum(["daily", "weekly"]).parse(cadence);
    return this.request(ctx, "knowledge.read", async (db) => {
      const row = await this.prefRow(db, ctx.workspaceId, ctx.principalId),
        p = preferences(row?.data ?? {}),
        at = new Date(Math.floor(+this.clock() / 60000) * 60000),
        events = (
          await db.query(
            "SELECT * FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 AND created_at>$3 AND created_at<=$4 ORDER BY created_at,id",
            [
              ctx.workspaceId,
              ctx.principalId,
              new Date(+at - (cadence === "daily" ? 1 : 7) * 86400000),
              at,
            ],
          )
        ).rows,
        result = await this.eligible(db, ctx, p, events);
      return {
        cadence,
        preferenceRevision: row?.revision ?? 0,
        timezone: p.timezone,
        nextAt: nextDigest(p, cadence, this.clock()).toISOString(),
        configured: !!this.options.gateway,
        items: result.items,
        previewOnly: true,
        previewHash: fingerprint([
          ctx.workspaceId,
          ctx.principalId,
          cadence,
          prefHash(row),
          result,
        ]),
      };
    });
  }
  async confirmPreview(ctx: Context, previewHash: string) {
    for (const cadence of ["daily", "weekly"] as Cadence[])
      if ((await this.previewDigest(ctx, cadence)).previewHash === previewHash)
        return { confirmed: true, previewOnly: true };
    throw Error("STALE_VERSION");
  }
  async claim(workerId: string): Promise<DeliveryLease | null> {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const rows = (
        await db.query(
          "SELECT * FROM collaboration_digest_outbox WHERE ((status IN ('queued','retry','accepted','unconfigured') AND available_at<=$1) OR (status='running' AND lease_until<=$1)) ORDER BY available_at,id FOR UPDATE SKIP LOCKED",
          [this.clock()],
        )
      ).rows;
      for (const row of rows) {
        if (!this.options.gateway && row.status !== "accepted") {
          await db.query(
            "UPDATE collaboration_digest_outbox SET status='unconfigured',error_code='DELIVERY_UNCONFIGURED',updated_at=$2 WHERE id=$1",
            [row.id, this.clock()],
          );
          continue;
        }
        if (row.attempts >= row.max_attempts) {
          await db.query(
            "UPDATE collaboration_digest_outbox SET status=$2,error_code='ATTEMPTS_EXHAUSTED',updated_at=$3 WHERE id=$1",
            [
              row.id,
              row.dispatch_started_at ? "needs-reconciliation" : "failed",
              this.clock(),
            ],
          );
          continue;
        }
        const updated = (
          await db.query(
            "UPDATE collaboration_digest_outbox SET status='running',worker_id=$2,fence=fence+1,attempts=attempts+1,lease_until=$3,updated_at=$4 WHERE id=$1 RETURNING fence",
            [
              row.id,
              workerId,
              new Date(+this.clock() + this.leaseMs),
              this.clock(),
            ],
          )
        ).rows[0];
        return { id: row.id, workerId, fence: updated.fence };
      }
      return null;
    });
  }
  private async locked(db: PoolClient, lease: DeliveryLease) {
    const row = (
      await db.query(
        "SELECT * FROM collaboration_digest_outbox WHERE id=$1 FOR UPDATE",
        [lease.id],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== "running" ||
      row.worker_id !== lease.workerId ||
      row.fence !== lease.fence ||
      +new Date(row.lease_until) <= +this.clock()
    )
      throw Error("LEASE_LOST");
    return row;
  }
  async heartbeat(lease: DeliveryLease) {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      await this.locked(db, lease);
      await db.query(
        "UPDATE collaboration_digest_outbox SET lease_until=$2 WHERE id=$1",
        [lease.id, new Date(+this.clock() + this.leaseMs)],
      );
    });
  }
  private async finishWindow(
    db: PoolClient,
    row: Row,
    status: string,
    reason: string | null,
  ) {
    await db.query(
      "UPDATE collaboration_digest_outbox SET status=$2,error_code=$3,lease_until=NULL,updated_at=$4 WHERE id=$1",
      [row.id, status, reason, this.clock()],
    );
    if (["delivered", "no-delivery"].includes(status))
      await db.query(
        "UPDATE collaboration_digest_plans SET cursor_at=greatest(cursor_at,$2),updated_at=$3 WHERE id=$1",
        [row.plan_id, row.window_end, this.clock()],
      );
  }
  private async finalize(
    lease: DeliveryLease,
    commit = true,
  ): Promise<DigestPayload | null> {
    const identity = (
      await this.pool.query(
        "SELECT workspace_id,principal_id FROM collaboration_digest_outbox WHERE id=$1",
        [lease.id],
      )
    ).rows[0];
    if (!identity) throw Error("NOT_FOUND");
    const proof = await this.verify(
      identity.workspace_id,
      identity.principal_id,
    );
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const row = await this.locked(db, lease),
        plan = await this.currentPlan(db, row);
      await this.assertProof(db, proof);
      if (!proof.address) throw Error("RECIPIENT_DELIVERY_UNCONFIGURED");
      const p = preferences(plan.preferences);
      if (inQuietHours(p, this.clock())) {
        await db.query(
          "UPDATE collaboration_digest_outbox SET status='queued',available_at=$2,attempts=greatest(attempts-1,0),lease_until=NULL,error_code='QUIET_HOURS',updated_at=$3 WHERE id=$1",
          [row.id, afterQuietHours(p, this.clock()), this.clock()],
        );
        return null;
      }
      const result = await this.eligible(
        db,
        proof.ctx,
        p,
        await this.events(db, row),
      );
      if (!result.items.length) {
        await this.finishWindow(
          db,
          row,
          "no-delivery",
          "NO_AUTHORIZED_CHANGES",
        );
        return null;
      }
      if (
        row.event_ids.length > (this.options.maxEvents ?? 5000) ||
        result.items.length > 100
      )
        throw Error("DIGEST_EVENT_LIMIT");
      const payload: DigestPayload = {
        deliveryId: row.id,
        recipient: {
          principalId: row.principal_id,
          issuer: proof.issuer,
          subject: proof.subject,
          address: proof.address,
        },
        cadence: row.cadence,
        window: {
          from: new Date(row.window_start).toISOString(),
          to: new Date(row.window_end).toISOString(),
        },
        format: "text/plain",
        subject: row.cadence === "daily" ? "일일 지식 알림" : "주간 지식 알림",
        items: result.items,
      };
      const h = fingerprint(payload),
        binding = fingerprint(payload.recipient);
      if (row.payload_hash && row.payload_hash !== h)
        throw Error("DELIVERY_INPUT_CHANGED");
      if (commit)
        await db.query(
          "UPDATE collaboration_digest_outbox SET payload_hash=$2,recipient_binding_hash=$3,input_hash=$4,dispatch_started_at=coalesce(dispatch_started_at,$5),updated_at=$5 WHERE id=$1",
          [row.id, h, binding, result.inputHash, this.clock()],
        );
      return payload;
    });
  }
  private async receipt(lease: DeliveryLease, receipt: DeliveryReceipt) {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const row = await this.locked(db, lease);
      if (receipt.deliveryId !== row.id || !row.payload_hash)
        throw Error("GATEWAY_RECEIPT_INVALID");
      await db.query(
        "INSERT INTO collaboration_delivery_receipts VALUES($1,$2,$3,$4,$5) ON CONFLICT(delivery_id) DO UPDATE SET receipt_id=excluded.receipt_id,status=excluded.status,recorded_at=excluded.recorded_at",
        [
          row.id,
          receipt.receiptId,
          receipt.status,
          row.payload_hash,
          this.clock(),
        ],
      );
      await db.query(
        "UPDATE collaboration_digest_outbox SET receipt_id=$2,delivered_at=$3 WHERE id=$1",
        [
          row.id,
          receipt.receiptId,
          receipt.status === "delivered" ? this.clock() : null,
        ],
      );
      await this.finishWindow(db, row, receipt.status, null);
      if (receipt.status === "accepted")
        await db.query(
          "UPDATE collaboration_digest_outbox SET available_at=$2 WHERE id=$1",
          [row.id, new Date(+this.clock() + 5000)],
        );
    });
  }
  private async fail(lease: DeliveryLease, error: unknown) {
    return this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      const row = await this.locked(db, lease),
        c = code(error);
      const permanent = [
        "PREFERENCES_CHANGED",
        "DELIVERY_INPUT_CHANGED",
        "GATEWAY_REJECTED",
        "GATEWAY_REDIRECT_DENIED",
        "DIGEST_EVENT_LIMIT",
      ].includes(c);
      const status = permanent
        ? row.dispatch_started_at
          ? "needs-reconciliation"
          : "superseded"
        : row.attempts >= row.max_attempts
          ? row.dispatch_started_at
            ? "needs-reconciliation"
            : "failed"
          : "retry";
      await db.query(
        "UPDATE collaboration_digest_outbox SET status=$2,error_code=$3,available_at=$4,lease_until=NULL,updated_at=$5 WHERE id=$1",
        [
          row.id,
          status,
          c,
          new Date(
            +this.clock() + Math.min(60000, 1000 * 2 ** (row.attempts - 1)),
          ),
          this.clock(),
        ],
      );
      await db.query(
        "INSERT INTO collaboration_delivery_events(delivery_id,kind,code,at) VALUES($1,$2,$3,$4)",
        [row.id, status, c, this.clock()],
      );
    });
  }
  async runDigest(lease: DeliveryLease, signal: AbortSignal) {
    try {
      const row = (
        await this.pool.query(
          "SELECT receipt_id FROM collaboration_digest_outbox WHERE id=$1",
          [lease.id],
        )
      ).rows[0];
      if (!this.options.gateway) throw Error("DELIVERY_UNCONFIGURED");
      // One initial proof/read gate and the adapter's mandatory final gate. A source
      // revoke between them cannot leak the previously prepared title/address.
      if (row.receipt_id) {
        const receipt = await this.options.gateway.status({
          deliveryId: lease.id,
          signal,
        });
        if (receipt) await this.receipt(lease, receipt);
        else throw Error("GATEWAY_RECEIPT_UNKNOWN");
        return;
      }
      const first = await this.finalize(lease, false);
      if (!first) return;
      const receipt = await this.options.gateway.send({
        deliveryId: lease.id,
        signal,
        finalize: () => this.finalize(lease),
      });
      if (receipt) await this.receipt(lease, receipt);
    } catch (e) {
      if (e instanceof Error && e.message === "LEASE_LOST") return;
      try {
        await this.fail(lease, e);
      } catch (f) {
        if (!(f instanceof Error && f.message === "LEASE_LOST")) throw f;
      }
    }
  }
  async retryDelivery(ctx: Context, deliveryId: string) {
    return this.request(ctx, "knowledge.read", async (db) => {
      const row = await this.owned(db, ctx, deliveryId);
      await this.currentPlan(db, row);
      if (
        !["failed", "needs-reconciliation", "retry", "unconfigured"].includes(
          row.status,
        )
      )
        throw Error("DELIVERY_NOT_RETRYABLE");
      if (row.attempts >= 10) throw Error("ATTEMPTS_EXHAUSTED");
      await db.query(
        "UPDATE collaboration_digest_outbox SET status='queued',available_at=$2,max_attempts=least(10,attempts+3),updated_at=$2 WHERE id=$1",
        [row.id, this.clock()],
      );
      return { id: row.id, status: "queued" };
    });
  }

  async configureReviewCadence(ctx: Context, input: unknown) {
    const p = z
      .object({
        documentType: z.string().trim().min(1).max(200),
        expectedRevision: z.number().int().min(0),
        days: z.number().int().min(1).max(3650),
      })
      .strict()
      .parse(input);
    return this.request(ctx, "knowledge.protect", async (db) => {
      const old = (
        await db.query(
          "SELECT revision FROM collaboration_review_cadence WHERE workspace_id=$1 AND document_type=$2",
          [ctx.workspaceId, p.documentType],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== p.expectedRevision)
        throw Error("STALE_VERSION");
      await db.query(
        "INSERT INTO collaboration_review_cadence VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,document_type) DO UPDATE SET revision=excluded.revision,days=excluded.days,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
        [
          ctx.workspaceId,
          p.documentType,
          p.expectedRevision + 1,
          p.days,
          ctx.principalId,
          this.clock(),
        ],
      );
      return { ...p, revision: p.expectedRevision + 1 };
    });
  }
  private async reviewSnapshot(
    db: PoolClient,
    workspaceId: string,
    pageId: string,
  ) {
    const row = (
      await db.query(
        "SELECT p.data,w.data workflow,w.revision workflow_revision,w.state,(SELECT max(number) FROM versions v WHERE v.workspace_id=p.workspace_id AND v.page_id=p.id) page_version FROM pages p LEFT JOIN workflow_document_state w ON w.workspace_id=p.workspace_id AND w.page_id=p.id WHERE p.workspace_id=$1 AND p.id=$2",
        [workspaceId, pageId],
      )
    ).rows[0];
    if (!row) return null;
    const data = row.workflow ?? {};
    if (
      (row.state && row.state !== "active") ||
      data.replacementId ||
      (data.effectiveFrom &&
        (!date(data.effectiveFrom) ||
          +new Date(data.effectiveFrom) > +this.clock()))
    )
      return null;
    const documentType = row.data.category ?? "연결된 지식";
    let policy = (
      await db.query(
        "SELECT document_type,revision,days FROM collaboration_review_cadence WHERE workspace_id=$1 AND document_type=ANY($2::text[]) ORDER BY (document_type='*') LIMIT 1",
        [workspaceId, [documentType, "*"]],
      )
    ).rows[0];
    if (!policy && (await hasTable(db, "governance_type_policies"))) {
      const p = (
        await db.query(
          "SELECT document_type,revision,cadence_days days FROM governance_type_policies WHERE workspace_id=$1 AND document_type=ANY($2::text[]) AND cadence_days IS NOT NULL ORDER BY (document_type='*') LIMIT 1",
          [workspaceId, [documentType, "*"]],
        )
      ).rows[0];
      if (p) policy = p;
    }
    const explicit = date(data.reviewDue),
      baseline = date(data.lastReviewedAt ?? data.properties?.lastReviewedAt);
    if (!policy && !explicit) return null;
    const due =
      explicit ??
      (baseline && policy
        ? new Date(+baseline + Number(policy.days) * 86400000)
        : null);
    if (due && +due > +this.clock())
      return { future: true, row, documentType, due, policy };
    const responsibility = await this.hooks.resolveReviewResponsibility(db, {
      workspaceId,
      pageId,
      documentType,
    });
    const inputHash = fingerprint({
      row,
      responsibility,
      policy: policy ?? null,
      due: due?.toISOString() ?? null,
    });
    return {
      future: false,
      row,
      documentType,
      due,
      policy,
      responsibility,
      inputHash,
      policyHash: fingerprint(policy ?? { explicit: true }),
    };
  }
  async scanReviews() {
    const ids = await this.tx(async (db) => {
      await this.hooks.assertDispatcher(db);
      return (
        await db.query(
          "SELECT workspace_id,id FROM pages ORDER BY workspace_id,id",
        )
      ).rows;
    });
    let count = 0;
    for (const { workspace_id: workspaceId, id: pageId } of ids) {
      const snapshot = await this.tx(async (db) => {
        await this.hooks.assertDispatcher(db);
        return this.reviewSnapshot(db, workspaceId, pageId);
      });
      if (!snapshot || snapshot.future) {
        await this.tx(async (db) => {
          await this.hooks.assertDispatcher(db);
          await db.query(
            "UPDATE collaboration_review_due_work SET status='resolved',updated_at=$3 WHERE workspace_id=$1 AND page_id=$2 AND status IN ('needs-review','needs-assignment','acknowledged')",
            [workspaceId, pageId, this.clock()],
          );
        });
        continue;
      }
      const responsibility = snapshot.responsibility!;
      let chosen: RecipientProof | undefined,
        reason = snapshot.due ? "OWNER_CURRENT" : "REVIEW_BASELINE_UNKNOWN";
      for (const pid of [responsibility.ownerId, responsibility.backupId]) {
        if (!pid) continue;
        try {
          const proof = await this.verify(workspaceId, pid);
          await this.tx(async (db) => {
            await this.hooks.assertDispatcher(db);
            await this.assertProof(db, proof);
            await this.hooks.authorize(db, proof.ctx, "knowledge.read", {
              kind: "page",
              id: pageId,
              version: Number(snapshot.row.page_version),
            });
            await captureEnvelope(
              db,
              proof.ctx,
              await loadState(db, workspaceId),
              [pageId],
            );
          });
          chosen = proof;
          if (snapshot.due && pid !== responsibility.ownerId)
            reason = "OWNER_UNAVAILABLE_BACKUP";
          break;
        } catch (e) {
          if (e && typeof e === "object" && "code" in e) throw e;
        }
      }
      count += await this.tx(async (db) => {
        await this.hooks.assertDispatcher(db);
        const fresh = await this.reviewSnapshot(db, workspaceId, pageId);
        if (!fresh || fresh.future || fresh.inputHash !== snapshot.inputHash)
          return 0;
        if (chosen) await this.assertProof(db, chosen);
        const cycle = fingerprint([
            pageId,
            snapshot.due?.toISOString() ?? "unknown",
            snapshot.row.page_version,
            responsibility.revision,
            snapshot.policyHash,
            snapshot.inputHash,
          ]),
          workId = "review_" + cycle;
        await db.query(
          "UPDATE collaboration_review_due_work SET status='superseded',updated_at=$3 WHERE workspace_id=$1 AND page_id=$2 AND due_cycle<>$4 AND status IN ('needs-review','needs-assignment','acknowledged')",
          [workspaceId, pageId, this.clock(), cycle],
        );
        const status =
          snapshot.due && chosen ? "needs-review" : "needs-assignment";
        if (!chosen && snapshot.due)
          reason = "RESPONSIBLE_RECIPIENT_UNAVAILABLE";
        const inserted = await db.query(
          "INSERT INTO collaboration_review_due_work(id,workspace_id,page_id,page_version,due_cycle,document_type,due_at,input_hash,policy_hash,assignment_revision,owner_id,backup_id,assigned_id,status,reason_code,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) ON CONFLICT(workspace_id,page_id,due_cycle) DO NOTHING",
          [
            workId,
            workspaceId,
            pageId,
            snapshot.row.page_version,
            cycle,
            snapshot.documentType,
            snapshot.due,
            snapshot.inputHash,
            snapshot.policyHash,
            responsibility.revision,
            responsibility.ownerId,
            responsibility.backupId,
            chosen?.ctx.principalId ?? null,
            status,
            reason,
            this.clock(),
          ],
        );
        if (inserted.rowCount && chosen)
          await db.query(
            "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,id) DO NOTHING",
            [
              workspaceId,
              "collab_" + cycle,
              chosen.ctx.principalId,
              pageId,
              snapshot.row.page_version,
              snapshot.due ? "review-due" : "review-assignment",
              { reviewWorkId: workId },
              this.clock(),
            ],
          );
        return inserted.rowCount ?? 0;
      });
    }
    return count;
  }
  async reviewInbox(
    ctx: Context,
    options: { all?: boolean; offset?: number } = {},
  ) {
    return this.request(
      ctx,
      options.all ? "knowledge.protect" : "knowledge.read",
      async (db) => {
        const rows = (
            await db.query(
              "SELECT * FROM collaboration_review_due_work WHERE workspace_id=$1 AND ($2::boolean OR assigned_id=$3) AND status IN ('needs-review','needs-assignment','acknowledged') ORDER BY due_at NULLS FIRST,id LIMIT 25 OFFSET $4",
              [
                ctx.workspaceId,
                !!options.all,
                ctx.principalId,
                options.offset ?? 0,
              ],
            )
          ).rows,
          items = [];
        for (const r of rows) {
          try {
            await this.hooks.authorize(db, ctx, "knowledge.read", {
              kind: "page",
              id: r.page_id,
              version: r.page_version,
            });
            const snapshot = await this.reviewSnapshot(
              db,
              ctx.workspaceId,
              r.page_id,
            );
            if (
              !snapshot ||
              snapshot.future ||
              snapshot.inputHash !== r.input_hash
            )
              continue;
            const state = await loadState(db, ctx.workspaceId);
            await captureEnvelope(db, ctx, state, [r.page_id]);
            items.push({
              id: r.id,
              pageId: r.page_id,
              title: state.pages.find((p) => p.id === r.page_id)?.title,
              revision: r.revision,
              status: r.status,
              assignedId: r.assigned_id,
              dueAt: r.due_at,
              reason: r.reason_code,
              documentType: r.document_type,
            });
          } catch (e) {
            if (!denied(e)) throw e;
          }
        }
        return {
          items,
          nextOffset: rows.length === 25 ? (options.offset ?? 0) + 25 : null,
        };
      },
    );
  }
  async acknowledgeReview(
    ctx: Context,
    workId: string,
    expectedRevision: number,
  ) {
    return this.request(ctx, "knowledge.read", async (db) => {
      const r = (
        await db.query(
          "SELECT * FROM collaboration_review_due_work WHERE workspace_id=$1 AND id=$2 AND assigned_id=$3 FOR UPDATE",
          [ctx.workspaceId, workId, ctx.principalId],
        )
      ).rows[0];
      if (!r) throw Error("NOT_FOUND");
      if (r.revision !== expectedRevision) throw Error("STALE_VERSION");
      await this.hooks.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: r.page_id,
        version: r.page_version,
      });
      const snap = await this.reviewSnapshot(db, ctx.workspaceId, r.page_id);
      if (!snap || snap.future || snap.inputHash !== r.input_hash)
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE collaboration_review_due_work SET status='acknowledged',revision=revision+1,acknowledged_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, workId, this.clock()],
      );
      return {
        id: workId,
        status: "acknowledged",
        revision: expectedRevision + 1,
        verificationCreated: false,
      };
    });
  }
}
