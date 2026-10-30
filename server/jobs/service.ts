import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { loadState } from "../repository";
import { captureEnvelope, assertEnvelope, fingerprint } from "../provenance";
import type {
  Completion,
  ExecutionIdentity,
  JobHooks,
  JobInput,
  Lease,
  ModelTelemetry,
  ModelReservation,
  ScheduleInput,
} from "./types";
import { localDate, nextOccurrence } from "./schedule";

const identifier = z.string().min(1).max(200);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const jobSchema = z
  .object({
    kind: z.enum(["ingest", "query", "lint", "daily", "weekly", "index"]),
    key: identifier,
    payload: z.record(z.string(), z.unknown()),
    pageIds: z.array(identifier).max(200),
    sourceIds: z.array(identifier).max(200),
    reservation: z.object({ tokens: integer, costMicros: integer }).strict(),
    timeoutMs: z.number().int().min(10).max(3600000),
    maxAttempts: z.number().int().min(1).max(10),
    limits: z
      .object({
        documents: z.number().int().min(1).max(200),
        changes: z.number().int().min(0).max(200),
      })
      .strict()
      .optional(),
    ruleId: identifier.optional(),
    model: identifier.optional(),
  })
  .strict();
const identitySchema = z
  .object({
    workspaceId: identifier,
    principalId: identifier,
    credentialId: identifier,
  })
  .strict();
const scheduleSchema = z
  .object({
    key: identifier,
    expectedRevision: z.number().int().min(0).optional(),
    cadence: z.enum(["daily", "weekly"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().min(1).max(100),
    weekday: z.number().int().min(0).max(6).optional(),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(366),
    catchup: z.enum(["skip", "latest", "bounded"]),
    catchupLimit: z.number().int().min(1).max(10).optional(),
    job: jobSchema.omit({ key: true }),
    identity: identitySchema,
    approvedPageIds: z.array(identifier).max(200),
    approvedSourceIds: z.array(identifier).max(200),
    enabled: z.boolean().optional(),
  })
  .strict();
const telemetrySchema = z
  .object({
    callId: identifier,
    provider: identifier,
    model: identifier,
    inputTokens: integer.nullable(),
    outputTokens: integer.nullable(),
    costMicros: integer.nullable(),
    error: z
      .string()
      .regex(/^[A-Z0-9_]{1,80}$/)
      .nullable(),
  })
  .strict();
const terminal = new Set(["succeeded", "dead", "cancelled"]);
const permanent =
  /FORBIDDEN|REVOKED|EXPIRED|STALE|POLICY|SCOPE|PROTECTED|VALIDATION|INVALID|NOT_FOUND|BUDGET|TIMEOUT|CANCELLED|EMERGENCY|NOT_CONFIGURED|OUTPUT_LIMIT/;
const safeError = (code: string) =>
  /^[A-Z0-9_]{1,80}$/.test(code) ? code : "EXECUTION_FAILED";
type Row = Record<string, any>; // PostgreSQL row DTO; never trusted as an authorization context.
export interface JobOptions {
  clock?: () => Date;
  leaseMs?: number;
  globalConcurrency?: number;
  workspaceConcurrency?: number;
  principalConcurrency?: number;
  maxQueued?: number;
  maxWorkspaceQueued?: number;
}

export class JobService {
  readonly clock: () => Date;
  readonly leaseMs: number;
  readonly options: Required<Omit<JobOptions, "clock" | "leaseMs">>;
  constructor(
    readonly pool: Pool,
    readonly hooks: JobHooks,
    options: JobOptions = {},
  ) {
    if (
      !hooks?.authorize ||
      !hooks.resolveIdentity ||
      !hooks.policyFingerprint ||
      !hooks.validateScope
    )
      throw Error("JOB_AUTHORIZATION_REQUIRED");
    this.clock = options.clock ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30000;
    this.options = {
      globalConcurrency: options.globalConcurrency ?? 10,
      workspaceConcurrency: options.workspaceConcurrency ?? 2,
      principalConcurrency: options.principalConcurrency ?? 1,
      maxQueued: options.maxQueued ?? 1000,
      maxWorkspaceQueued: options.maxWorkspaceQueued ?? 100,
    };
    for (const n of [this.leaseMs, ...Object.values(this.options)])
      if (!Number.isSafeInteger(n) || n < 1) throw Error("INVALID_JOB_OPTIONS");
    if (this.options.globalConcurrency > 10) throw Error("CONCURRENCY_LIMIT");
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      const value = await work(db);
      await db.query("COMMIT");
      return value;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async mutex(db: PoolClient) {
    await db.query("SELECT pg_advisory_xact_lock(822022)");
  }
  private async check(db: PoolClient, ctx: Context, action: string) {
    await ctx.authorization?.assertSession(db);
    await this.hooks.authorize(db, ctx, action);
  }
  private async request<T>(
    ctx: Context,
    action: string,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    Object.freeze(ctx);
    await ctx.authorization?.revalidate();
    const result = await this.tx(async (db) => {
      await this.mutex(db);
      await this.check(db, ctx, action);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private identity(ctx: Context): ExecutionIdentity {
    return identitySchema.parse({
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
      credentialId: ctx.credentialId,
    });
  }
  private async resolve(
    db: PoolClient,
    identity: ExecutionIdentity,
  ): Promise<Context> {
    const resolved = await this.hooks.resolveIdentity(
      db,
      Object.freeze({ ...identity }),
    );
    if (
      resolved.workspaceId !== identity.workspaceId ||
      resolved.principalId !== identity.principalId ||
      resolved.credentialId !== identity.credentialId
    )
      throw Error("EXECUTION_IDENTITY_MISMATCH");
    await resolved.authorization?.assertSession(db);
    return Object.freeze({ ...resolved });
  }
  private async lockWorkspace(db: PoolClient, workspaceId: string) {
    if (
      !(
        await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          workspaceId,
        ])
      ).rowCount
    )
      throw Error("NOT_FOUND");
  }
  private async stopped(db: PoolClient, job: Row): Promise<boolean> {
    return Boolean(
      (
        await db.query(
          "SELECT 1 FROM durable_job_stops WHERE stopped AND ((scope='global' AND key='*') OR (scope='workspace' AND key=$1) OR (scope='kind' AND key=$2) OR (scope='model' AND key=$3) OR (scope='rule' AND key=$4))",
          [
            job.workspace_id,
            job.kind,
            job.input?.model ?? "",
            job.input?.ruleId ?? "",
          ],
        )
      ).rowCount,
    );
  }
  private async validate(db: PoolClient, ctx: Context, input: JobInput) {
    await this.check(db, ctx, "jobs.run");
    await this.hooks.validateScope(db, ctx, input);
    if (
      input.limits &&
      input.pageIds.length + input.sourceIds.length > input.limits.documents
    )
      throw Error("DOCUMENT_LIMIT");
    for (const id of input.pageIds)
      await this.hooks.authorize(db, ctx, "jobs.run", { kind: "page", id });
    for (const id of input.sourceIds)
      await this.hooks.authorize(db, ctx, "jobs.run", { kind: "source", id });
    if (input.pageIds.length) {
      const protectedPages = await db.query(
        "SELECT 1 FROM workflow_document_state WHERE workspace_id=$1 AND page_id=ANY($2::text[]) AND (state<>'active' OR data->>'protected'='true') LIMIT 1",
        [ctx.workspaceId, input.pageIds],
      );
      if (protectedPages.rowCount) throw Error("DOCUMENT_PROTECTED");
    }
  }
  async enqueue(ctx: Context, input: unknown) {
    const serialized = JSON.stringify(input);
    if (!serialized || Buffer.byteLength(serialized) > 500000)
      throw Error("INPUT_LIMIT");
    const parsed = jobSchema.parse(JSON.parse(serialized));
    return this.request(ctx, "jobs.run", (db) =>
      this.enqueueIn(db, ctx, parsed),
    );
  }
  private async enqueueIn(db: PoolClient, ctx: Context, input: JobInput) {
    const hash = fingerprint(input),
      now = this.clock();
    const prior = (
      await db.query(
        "SELECT * FROM durable_jobs WHERE workspace_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE",
        [ctx.workspaceId, ctx.principalId, input.key],
      )
    ).rows[0];
    if (prior) {
      if (prior.body_hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
      await this.validate(db, ctx, input);
      await this.readable(db, ctx, prior);
      return this.dto(prior);
    }
    const identity = this.identity(ctx);
    const execution = await this.resolve(db, identity);
    await this.lockWorkspace(db, ctx.workspaceId);
    await this.validate(db, execution, input);
    if (
      await this.stopped(db, {
        workspace_id: ctx.workspaceId,
        kind: input.kind,
        input,
      })
    )
      throw Error("EMERGENCY_STOP");
    const counts = (
      await db.query(
        "SELECT count(*)::int n,count(*) FILTER(WHERE workspace_id=$1)::int own FROM durable_jobs WHERE status IN ('queued','running','paused','cancel_requested')",
        [ctx.workspaceId],
      )
    ).rows[0];
    if (
      counts.n >= this.options.maxQueued ||
      counts.own >= this.options.maxWorkspaceQueued
    )
      throw Error("QUEUE_FULL");
    const envelope = await captureEnvelope(
      db,
      execution,
      await loadState(db, ctx.workspaceId),
      input.pageIds,
      input.sourceIds,
    );
    const policy = await this.hooks.policyFingerprint(db, execution);
    if (!policy) throw Error("POLICY_UNAVAILABLE");
    const day = now.toISOString().slice(0, 10);
    await this.reserve(db, ctx, day, input.reservation);
    const id = randomUUID();
    const lane = input.kind === "query" ? "interactive" : "maintenance";
    const row = (
      await db.query(
        "INSERT INTO durable_jobs(id,workspace_id,principal_id,credential_id,kind,lane,idempotency_key,body_hash,input,envelope,policy_hash,max_attempts,timeout_ms,available_at,created_at,updated_at,budget_day,reserved_tokens,reserved_cost_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$14,$15,$16,$17) RETURNING *",
        [
          id,
          ctx.workspaceId,
          ctx.principalId,
          identity.credentialId,
          input.kind,
          lane,
          input.key,
          hash,
          input,
          envelope,
          policy,
          input.maxAttempts,
          input.timeoutMs,
          now,
          day,
          input.reservation.tokens,
          input.reservation.costMicros,
        ],
      )
    ).rows[0];
    return this.dto(row);
  }
  private async reserve(
    db: PoolClient,
    ctx: Context,
    day: string,
    amount: { tokens: number; costMicros: number },
  ) {
    for (const principal of ["*", ctx.principalId]) {
      await db.query(
        "INSERT INTO durable_budget_days(workspace_id,principal_id,day) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [ctx.workspaceId, principal, day],
      );
      const usage = (
        await db.query(
          "SELECT * FROM durable_budget_days WHERE workspace_id=$1 AND principal_id=$2 AND day=$3 FOR UPDATE",
          [ctx.workspaceId, principal, day],
        )
      ).rows[0];
      const limit = (
        await db.query(
          "SELECT * FROM durable_budget_limits WHERE workspace_id=$1 AND principal_id=$2",
          [ctx.workspaceId, principal],
        )
      ).rows[0] ?? { tokens: 100000, cost_micros: 1000000 };
      if (
        Number(usage.tokens_reserved) +
          Number(usage.tokens_charged) +
          amount.tokens >
          Number(limit.tokens) ||
        Number(usage.cost_reserved) +
          Number(usage.cost_charged) +
          amount.costMicros >
          Number(limit.cost_micros)
      )
        throw Error("BUDGET_EXCEEDED");
      await db.query(
        "UPDATE durable_budget_days SET tokens_reserved=tokens_reserved+$4,cost_reserved=cost_reserved+$5 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
        [ctx.workspaceId, principal, day, amount.tokens, amount.costMicros],
      );
    }
  }
  private dto(row: Row) {
    return {
      id: row.id,
      principalId: row.principal_id,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      leaseUntil: row.lease_until,
      heartbeatAt: row.heartbeat_at,
      result: row.result,
      checkpoint: row.checkpoint,
      error: row.error_code,
    };
  }
  private async owned(db: PoolClient, ctx: Context, id: string): Promise<Row> {
    identifier.parse(id);
    const row = (
      await db.query(
        "SELECT * FROM durable_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, ctx.workspaceId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    if (row.principal_id !== ctx.principalId)
      await this.check(db, ctx, "jobs.manage");
    return row;
  }
  private async readable(db: PoolClient, ctx: Context, row: Row) {
    await this.hooks.validateScope(db, ctx, row.input);
    // Do not disclose old output after any input ACL/content changes.
    await assertEnvelope(
      db,
      ctx,
      await loadState(db, ctx.workspaceId),
      row.envelope,
    );
  }
  async get(ctx: Context, id: string) {
    return this.request(ctx, "jobs.read", async (db) => {
      const row = await this.owned(db, ctx, id);
      await this.readable(db, ctx, row);
      return this.dto(row);
    });
  }
  async list(ctx: Context, offset = 0, scope: "own" | "workspace" = "own") {
    z.number().int().min(0).max(1000000).parse(offset);
    z.enum(["own", "workspace"]).parse(scope);
    return this.request(
      ctx,
      scope === "workspace" ? "jobs.manage" : "jobs.read",
      async (db) => {
        const rows = (
          await db.query(
            "SELECT * FROM durable_jobs WHERE workspace_id=$1 AND (principal_id=$2 OR $4::boolean) ORDER BY created_at DESC,id LIMIT 25 OFFSET $3",
            [ctx.workspaceId, ctx.principalId, offset, scope === "workspace"],
          )
        ).rows;
        const items = [];
        for (const row of rows) {
          try {
            await this.readable(db, ctx, row);
            items.push(this.dto(row));
          } catch (e) {
            if (!(
              e instanceof Error &&
              ["STALE_VERSION", "NOT_FOUND", "DOCUMENT_PROTECTED"].includes(
                e.message,
              )
            ))
              throw e;
          }
        }
        return { items, nextOffset: rows.length === 25 ? offset + 25 : null };
      },
    );
  }
  async cancel(ctx: Context, id: string) {
    return this.request(ctx, "jobs.run", async (db) => {
      const row = await this.owned(db, ctx, id);
      if (terminal.has(row.status)) throw Error("ALREADY_COMPLETED");
      const status =
        row.status === "running" || row.status === "cancel_requested"
          ? "cancel_requested"
          : "cancelled";
      await db.query(
        "UPDATE durable_jobs SET status=$2,updated_at=$3 WHERE id=$1",
        [id, status, this.clock()],
      );
      if (status === "cancelled") {
        row.status = status;
        await this.reconcile(db, row);
        await this.event(db, row, "job.cancelled", { id });
      }
      return { id, status };
    });
  }
  async pause(ctx: Context, id: string, paused: boolean) {
    return this.request(ctx, "jobs.manage", async (db) => {
      const row = await this.owned(db, ctx, id);
      if (!["queued", "paused"].includes(row.status))
        throw Error("JOB_NOT_PAUSABLE");
      if (!paused) {
        const resolved = await this.resolve(db, this.rowIdentity(row));
        await this.assertCurrent(db, row, resolved);
      }
      const status = paused ? "paused" : "queued";
      await db.query(
        "UPDATE durable_jobs SET status=$2,updated_at=$3 WHERE id=$1",
        [id, status, this.clock()],
      );
      return { id, status };
    });
  }
  async retry(ctx: Context, id: string) {
    return this.request(ctx, "jobs.manage", async (db) => {
      const row = await this.owned(db, ctx, id);
      if (row.status !== "dead" || row.attempts >= 10)
        throw Error("JOB_NOT_RETRYABLE");
      const execution = await this.resolve(db, this.rowIdentity(row));
      await this.assertCurrent(db, row, execution);
      const t = await this.totals(db, row.id);
      if (t.unknown_tokens || t.unknown_cost)
        throw Error("MODEL_USAGE_UNKNOWN");
      const day = this.clock().toISOString().slice(0, 10);
      await this.reserve(db, execution, day, {
        tokens: Number(row.reserved_tokens),
        costMicros: Number(row.reserved_cost_micros),
      });
      // Keep completed effect stages, but subsequent budget accounting starts at
      // the next monotonically increasing attempt (max10 over the job lifetime).
      await db.query(
        "UPDATE durable_jobs SET status='queued',max_attempts=$2,reconciled=false,budget_day=$3,started_at=NULL,worker_id=NULL,lease_until=NULL,error_code=NULL,available_at=$4,updated_at=$4,checkpoint=jsonb_set(coalesce(checkpoint,'{}'::jsonb),'{budgetStartAttempt}',$5) WHERE id=$1",
        [
          id,
          Math.min(10, row.attempts + row.input.maxAttempts),
          day,
          this.clock(),
          JSON.stringify(row.attempts + 1),
        ],
      );
      return { id, status: "queued" };
    });
  }
  private rowIdentity(row: Row): ExecutionIdentity {
    return {
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      credentialId: row.credential_id,
    };
  }
  private lease(row: Row): Lease {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      credentialId: row.credential_id,
      workerId: row.worker_id,
      fence: row.fence,
      attempt: row.attempts,
      input: row.input,
      envelope: row.envelope,
      policyHash: row.policy_hash,
      checkpoint: row.checkpoint,
    };
  }
  private async assertCurrent(db: PoolClient, row: Row, ctx: Context) {
    await this.lockWorkspace(db, row.workspace_id);
    await this.validate(db, ctx, row.input);
    if (await this.stopped(db, row)) throw Error("EMERGENCY_STOP");
    if (row.policy_hash !== (await this.hooks.policyFingerprint(db, ctx)))
      throw Error("POLICY_CHANGED");
    await assertEnvelope(
      db,
      ctx,
      await loadState(db, row.workspace_id),
      row.envelope,
    );
    if (!row.reconciled) await this.assertDailyBudget(db, row);
  }
  private async assertDailyBudget(db: PoolClient, row: Row) {
    const entries = (
      await db.query(
        "SELECT d.*,l.tokens token_limit,l.cost_micros cost_limit FROM durable_budget_days d LEFT JOIN durable_budget_limits l USING(workspace_id,principal_id) WHERE d.workspace_id=$1 AND d.day=$2 AND d.principal_id=ANY($3::text[])",
        [row.workspace_id, row.budget_day, ["*", row.principal_id]],
      )
    ).rows;
    for (const entry of entries)
      if (
        Number(entry.tokens_reserved) + Number(entry.tokens_charged) >
          Number(entry.token_limit ?? 100000) ||
        Number(entry.cost_reserved) + Number(entry.cost_charged) >
          Number(entry.cost_limit ?? 1000000)
      )
        throw Error("BUDGET_EXCEEDED");
  }
  private async rollover(db: PoolClient, row: Row, ctx: Context) {
    const day = this.clock().toISOString().slice(0, 10),
      previous =
        row.budget_day instanceof Date
          ? `${row.budget_day.getFullYear()}-${String(row.budget_day.getMonth() + 1).padStart(2, "0")}-${String(row.budget_day.getDate()).padStart(2, "0")}`
          : String(row.budget_day).slice(0, 10);
    if (previous === day || row.started_at) return;
    await this.reserve(db, ctx, day, {
      tokens: Number(row.reserved_tokens),
      costMicros: Number(row.reserved_cost_micros),
    });
    for (const principal of ["*", row.principal_id])
      await db.query(
        "UPDATE durable_budget_days SET tokens_reserved=tokens_reserved-$4,cost_reserved=cost_reserved-$5 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
        [
          row.workspace_id,
          principal,
          row.budget_day,
          row.reserved_tokens,
          row.reserved_cost_micros,
        ],
      );
    await db.query("UPDATE durable_jobs SET budget_day=$2 WHERE id=$1", [
      row.id,
      day,
    ]);
    row.budget_day = day;
  }
  async claim(
    workerId: string,
    lane?: "interactive" | "maintenance",
  ): Promise<Lease | null> {
    identifier.parse(workerId);
    return this.tx(async (db) => {
      await this.mutex(db);
      const now = this.clock();
      // Expired cancellation/attempt/time limits are finalized even without a worker.
      const expired = (
        await db.query(
          "SELECT * FROM durable_jobs WHERE status IN ('running','cancel_requested') AND lease_until<=$1 FOR UPDATE SKIP LOCKED",
          [now],
        )
      ).rows;
      for (const row of expired) {
        if (
          row.status === "cancel_requested" ||
          row.attempts >= row.max_attempts ||
          +now >= +new Date(row.started_at) + row.timeout_ms
        ) {
          const code =
            row.status === "cancel_requested"
              ? "CANCELLED"
              : row.attempts >= row.max_attempts
                ? "ATTEMPTS_EXHAUSTED"
                : "TIMEOUT";
          await this.finalizeFailure(db, row, code);
        }
      }
      const active = (
        await db.query(
          "SELECT workspace_id,principal_id,count(*)::int n FROM durable_jobs WHERE status IN ('running','cancel_requested') AND lease_until>$1 GROUP BY workspace_id,principal_id",
          [now],
        )
      ).rows;
      if (active.reduce((n, r) => n + r.n, 0) >= this.options.globalConcurrency)
        return null;
      const maintenance = (
        await db.query(
          "SELECT count(*)::int n FROM durable_jobs WHERE status IN ('running','cancel_requested') AND lease_until>$1 AND lane='maintenance'",
          [now],
        )
      ).rows[0].n;
      // Sort by least recently served workspace, then principal. interactive and
      // maintenance have separate workers/lanes but share hard global quotas.
      const candidates = (
        await db.query(
          "SELECT j.* FROM durable_jobs j LEFT JOIN durable_job_fairness w ON w.scope='w:'||j.workspace_id LEFT JOIN durable_job_fairness p ON p.scope='p:'||j.workspace_id||':'||j.principal_id WHERE ((j.status='queued' AND j.available_at<=$1) OR (j.status='running' AND j.lease_until<=$1)) AND ($2::text IS NULL OR j.lane=$2) ORDER BY coalesce(w.turn,0),coalesce(p.turn,0),j.created_at,j.id FOR UPDATE OF j SKIP LOCKED",
          [now, lane ?? null],
        )
      ).rows;
      for (const row of candidates) {
        if (
          row.lane === "maintenance" &&
          maintenance >= Math.max(1, this.options.globalConcurrency - 2)
        )
          continue;
        const workspace = active
          .filter((a) => a.workspace_id === row.workspace_id)
          .reduce((n, r) => n + r.n, 0);
        const own =
          active.find(
            (a) =>
              a.workspace_id === row.workspace_id &&
              a.principal_id === row.principal_id,
          )?.n ?? 0;
        if (
          workspace >= this.options.workspaceConcurrency ||
          own >= this.options.principalConcurrency ||
          (await this.stopped(db, row))
        )
          continue;
        await db.query("SAVEPOINT claim_validation");
        try {
          const ctx = await this.resolve(db, this.rowIdentity(row));
          await this.rollover(db, row, ctx);
          await this.assertCurrent(db, row, ctx);
          await db.query("RELEASE SAVEPOINT claim_validation");
        } catch (e) {
          await db.query("ROLLBACK TO SAVEPOINT claim_validation");
          if (e && typeof e === "object" && "code" in e) throw e;
          const original = (
            await db.query("SELECT * FROM durable_jobs WHERE id=$1", [row.id])
          ).rows[0];
          await this.finalizeFailure(
            db,
            original,
            safeError(e instanceof Error ? e.message : "POLICY_UNAVAILABLE"),
          );
          continue;
        }
        const updated = (
          await db.query(
            "UPDATE durable_jobs SET status='running',worker_id=$2,fence=fence+1,attempts=attempts+1,lease_until=$3,heartbeat_at=$4,started_at=coalesce(started_at,$4),updated_at=$4 WHERE id=$1 RETURNING *",
            [row.id, workerId, new Date(+now + this.leaseMs), now],
          )
        ).rows[0];
        for (const scope of [
          "w:" + row.workspace_id,
          "p:" + row.workspace_id + ":" + row.principal_id,
        ])
          await db.query(
            "INSERT INTO durable_job_fairness VALUES($1,nextval('durable_job_turn')) ON CONFLICT(scope) DO UPDATE SET turn=excluded.turn",
            [scope],
          );
        return this.lease(updated);
      }
      return null;
    });
  }
  private async locked(
    db: PoolClient,
    lease: Lease,
    allowCancelled = false,
  ): Promise<Row> {
    const row = (
        await db.query("SELECT * FROM durable_jobs WHERE id=$1 FOR UPDATE", [
          lease.id,
        ])
      ).rows[0],
      now = this.clock();
    if (
      !row ||
      row.worker_id !== lease.workerId ||
      row.fence !== lease.fence ||
      !["running", "cancel_requested"].includes(row.status) ||
      +new Date(row.lease_until) <= +now
    )
      throw Error("LEASE_LOST");
    if (!allowCancelled && row.status === "cancel_requested")
      throw Error("CANCELLED");
    return row;
  }
  async ready(lease: Lease): Promise<Context> {
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease);
      if (+this.clock() >= +new Date(row.started_at) + row.timeout_ms)
        throw Error("TIMEOUT");
      const ctx = await this.resolve(db, this.rowIdentity(row));
      await this.assertCurrent(db, row, ctx);
      return ctx;
    });
  }
  /** Hook for RuntimeService's OWN transaction, including offline writes. A
   * try-lock avoids lock inversion when runtime already holds its workspace
   * lock. QUEUE_BUSY is transient: roll back and retry the complete transaction. */
  async assertReadyInTransaction(
    db: PoolClient,
    lease: Lease,
  ): Promise<Context> {
    const locked = (
      await db.query("SELECT pg_try_advisory_xact_lock(822022) ok")
    ).rows[0].ok;
    if (!locked) throw Error("QUEUE_BUSY");
    const row = await this.locked(db, lease),
      ctx = await this.resolve(db, this.rowIdentity(row));
    if (+this.clock() >= +new Date(row.started_at) + row.timeout_ms)
      throw Error("TIMEOUT");
    await this.assertCurrent(db, row, ctx);
    return ctx;
  }
  /** Call with the actual complete influencing runtime context BEFORE model
   * transmission. Unlisted inputs cannot silently expand the persisted scope. */
  async captureInputs(
    db: PoolClient,
    lease: Lease,
    pageIds: string[],
    sourceIds: string[],
  ) {
    await this.assertReadyInTransaction(db, lease);
    if (
      pageIds.some((id) => !lease.envelope.pageIds.includes(id)) ||
      sourceIds.some((id) => !lease.envelope.sourceIds.includes(id))
    )
      throw Error("INPUT_SCOPE_MISMATCH");
    return structuredClone(lease.envelope);
  }
  /** Atomically checkpoint a runtime proposal/answer/index stage in the SAME
   * transaction as its DB effect. Stable across attempts and process restarts.
   * Host must begin/commit/rollback; never invoke opaque pool-based runtime
   * methods inside this callback, nor call a model while holding its locks. */
  async commitEffect<T>(
    db: PoolClient,
    lease: Lease,
    stage: string,
    effect: (db: PoolClient, ctx: Context, key: string) => Promise<T>,
  ): Promise<T> {
    z.string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .parse(stage);
    const ctx = await this.assertReadyInTransaction(db, lease);
    const row = await this.locked(db, lease),
      effects = row.checkpoint?.effects ?? {};
    if (Object.hasOwn(effects, stage)) return effects[stage] as T;
    const value = await effect(db, ctx, `durable-job:${row.id}:${stage}`);
    if (Buffer.byteLength(JSON.stringify(value) ?? "null") > 500000)
      throw Error("CHECKPOINT_LIMIT");
    if (
      +this.clock() >= +new Date(row.lease_until) ||
      +this.clock() >= +new Date(row.started_at) + row.timeout_ms
    )
      throw Error("LEASE_LOST");
    await db.query(
      "UPDATE durable_jobs SET checkpoint=jsonb_set(coalesce(checkpoint,'{}'::jsonb),'{effects}',$2),updated_at=$3 WHERE id=$1",
      [
        row.id,
        JSON.stringify({ ...effects, [stage]: value ?? null }),
        this.clock(),
      ],
    );
    return value;
  }
  async heartbeat(lease: Lease) {
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease);
      const ctx = await this.resolve(db, this.rowIdentity(row));
      await this.assertCurrent(db, row, ctx);
      if (+this.clock() >= +new Date(row.started_at) + row.timeout_ms)
        throw Error("TIMEOUT");
      await db.query(
        "UPDATE durable_jobs SET lease_until=$2,heartbeat_at=$3,updated_at=$3 WHERE id=$1",
        [lease.id, new Date(+this.clock() + this.leaseMs), this.clock()],
      );
    });
  }
  async checkpoint(lease: Lease, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > 500000)
      throw Error("CHECKPOINT_LIMIT");
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease);
      await this.assertCurrent(
        db,
        row,
        await this.resolve(db, this.rowIdentity(row)),
      );
      await db.query(
        "UPDATE durable_jobs SET checkpoint=jsonb_set(coalesce(checkpoint,'{}'::jsonb),'{progress}',$2),updated_at=$3 WHERE id=$1",
        [lease.id, JSON.stringify(value), this.clock()],
      );
    });
  }
  async complete(lease: Lease, completion: Completion) {
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease);
      const ctx = await this.resolve(db, this.rowIdentity(row));
      await this.assertCurrent(db, row, ctx);
      if (+this.clock() >= +new Date(row.started_at) + row.timeout_ms)
        throw Error("TIMEOUT");
      if (
        Buffer.byteLength(JSON.stringify(completion.value) ?? "null") > 1000000
      )
        throw Error("RESULT_LIMIT");
      await this.assertModelBudget(db, row);
      // The stable key is the only publication/outbox idempotency key, not attempt/fence.
      await completion.commit?.(db, ctx, "durable-job:" + row.id);
      // Catch a lease/deadline expiring while a slow DB effect was executing; rollback all.
      if (
        +this.clock() >= +new Date(row.lease_until) ||
        +this.clock() >= +new Date(row.started_at) + row.timeout_ms
      )
        throw Error("LEASE_LOST");
      await db.query(
        "UPDATE durable_jobs SET status='succeeded',result=$2,lease_until=NULL,updated_at=$3 WHERE id=$1",
        [row.id, JSON.stringify(completion.value ?? null), this.clock()],
      );
      await this.reconcile(db, row);
      await this.event(db, row, "job.succeeded", {
        id: row.id,
        result: completion.value ?? null,
      });
    });
  }
  async fail(lease: Lease, error: string, transient = false) {
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease, true);
      const code =
        row.status === "cancel_requested" ? "CANCELLED" : safeError(error);
      if (
        transient &&
        !permanent.test(code) &&
        row.attempts < row.max_attempts &&
        +this.clock() < +new Date(row.started_at) + row.timeout_ms
      ) {
        const backoff = Math.min(60000, 1000 * 2 ** (row.attempts - 1));
        await db.query(
          "UPDATE durable_jobs SET status='queued',error_code=$2,available_at=$3,worker_id=NULL,lease_until=NULL,updated_at=$4 WHERE id=$1",
          [row.id, code, new Date(+this.clock() + backoff), this.clock()],
        );
      } else await this.finalizeFailure(db, row, code);
    });
  }
  private async finalizeFailure(db: PoolClient, row: Row, code: string) {
    const status = code === "CANCELLED" ? "cancelled" : "dead";
    await db.query(
      "UPDATE durable_jobs SET status=$2,error_code=$3,lease_until=NULL,updated_at=$4 WHERE id=$1",
      [row.id, status, code, this.clock()],
    );
    await this.reconcile(db, row);
    await this.event(db, row, "job." + status, { id: row.id, error: code });
  }
  async beginModel(lease: Lease, input: ModelReservation) {
    const call = z
      .object({
        callId: identifier,
        provider: identifier,
        model: identifier,
        maxTokens: integer,
        maxCostMicros: integer,
      })
      .strict()
      .parse(input);
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = await this.locked(db, lease);
      await this.assertCurrent(
        db,
        row,
        await this.resolve(db, this.rowIdentity(row)),
      );
      if (row.input.model && row.input.model !== call.model)
        throw Error("MODEL_SCOPE_CONFLICT");
      const t = await this.totals(db, row.id);
      if (t.unknown_tokens || t.unknown_cost)
        throw Error("MODEL_USAGE_UNKNOWN");
      if (
        Number(t.tokens) + call.maxTokens > Number(row.reserved_tokens) ||
        Number(t.cost) + call.maxCostMicros > Number(row.reserved_cost_micros)
      )
        throw Error("BUDGET_EXCEEDED");
      if (
        (
          await db.query(
            "SELECT 1 FROM durable_model_calls WHERE job_id=$1 AND call_id=$2",
            [row.id, call.callId],
          )
        ).rowCount
      )
        throw Error("MODEL_CALL_ALREADY_STARTED");
      const pending = {
        callId: call.callId,
        provider: call.provider,
        model: call.model,
        inputTokens: null,
        outputTokens: null,
        costMicros: null,
        error: "MODEL_IN_FLIGHT",
      };
      await db.query(
        "INSERT INTO durable_model_calls(job_id,call_id,attempt,provider,model,error_code,body_hash,created_at) VALUES($1,$2,$3,$4,$5,'MODEL_IN_FLIGHT',$6,$7)",
        [
          row.id,
          call.callId,
          row.attempts,
          call.provider,
          call.model,
          fingerprint(pending),
          this.clock(),
        ],
      );
    });
  }
  async recordModel(lease: Lease, input: ModelTelemetry) {
    const usage = telemetrySchema.parse(input);
    return this.tx(async (db) => {
      await this.mutex(db);
      const row = (
        await db.query("SELECT * FROM durable_jobs WHERE id=$1 FOR UPDATE", [
          lease.id,
        ])
      ).rows[0];
      if (
        !row ||
        row.workspace_id !== lease.workspaceId ||
        row.principal_id !== lease.principalId
      )
        throw Error("LEASE_LOST");
      const previous = (
        await db.query(
          "SELECT * FROM durable_model_calls WHERE job_id=$1 AND call_id=$2 FOR UPDATE",
          [row.id, usage.callId],
        )
      ).rows[0];
      const hash = fingerprint(usage);
      if (previous) {
        if (previous.body_hash === hash) return;
        // A delayed worker may report actual usage for its own pre-reserved
        // call after loss of lease; it gains NO execution/publication rights.
        if (
          previous.error_code !== "MODEL_IN_FLIGHT" ||
          previous.attempt !== lease.attempt ||
          previous.provider !== usage.provider ||
          previous.model !== usage.model
        )
          throw Error("TELEMETRY_CONFLICT");
        const before = row.reconciled
          ? this.charges(row, await this.totals(db, row.id))
          : null;
        await db.query(
          "UPDATE durable_model_calls SET input_tokens=$3,output_tokens=$4,cost_micros=$5,error_code=$6,body_hash=$7 WHERE job_id=$1 AND call_id=$2",
          [
            row.id,
            usage.callId,
            usage.inputTokens,
            usage.outputTokens,
            usage.costMicros,
            usage.error,
            hash,
          ],
        );
        if (before) {
          const after = this.charges(row, await this.totals(db, row.id));
          for (const principal of ["*", row.principal_id])
            await db.query(
              "UPDATE durable_budget_days SET tokens_charged=tokens_charged+$4,cost_charged=cost_charged+$5 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
              [
                row.workspace_id,
                principal,
                row.budget_day,
                after.tokens - before.tokens,
                after.cost - before.cost,
              ],
            );
        }
        return;
      }
      await this.locked(db, lease, true);
      await db.query(
        "INSERT INTO durable_model_calls(job_id,call_id,attempt,provider,model,input_tokens,output_tokens,cost_micros,error_code,body_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          row.id,
          usage.callId,
          row.attempts,
          usage.provider,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.costMicros,
          usage.error,
          hash,
          this.clock(),
        ],
      );
    });
  }
  private async totals(db: PoolClient, id: string) {
    return (
      await db.query(
        "SELECT count(*)::int calls,coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0)::text tokens,coalesce(sum(cost_micros),0)::text cost,count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::int unknown_tokens,count(*) FILTER(WHERE cost_micros IS NULL)::int unknown_cost FROM durable_model_calls WHERE job_id=$1 AND attempt>=coalesce((SELECT (checkpoint->>'budgetStartAttempt')::int FROM durable_jobs WHERE id=$1),0)",
        [id],
      )
    ).rows[0];
  }
  private async assertModelBudget(db: PoolClient, row: Row) {
    const t = await this.totals(db, row.id);
    if (
      Number(t.tokens) > Number(row.reserved_tokens) ||
      Number(t.cost) > Number(row.reserved_cost_micros)
    )
      throw Error("BUDGET_EXCEEDED");
  }
  private charges(row: Row, t: Row) {
    const failedUnknown =
      row.attempts >= (row.checkpoint?.budgetStartAttempt ?? 1) &&
      t.calls === 0 &&
      row.input.model;
    return {
      tokens:
        t.unknown_tokens || failedUnknown
          ? Math.max(Number(t.tokens), Number(row.reserved_tokens))
          : Number(t.tokens),
      cost:
        t.unknown_cost || failedUnknown
          ? Math.max(Number(t.cost), Number(row.reserved_cost_micros))
          : Number(t.cost),
    };
  }
  private async reconcile(db: PoolClient, row: Row) {
    if (row.reconciled) return;
    const t = await this.totals(db, row.id);
    // An unreported/crashed model call cannot be claimed free. On a failed
    // attempt retain reservations conservatively even when no telemetry arrived.
    const { tokens, cost } = this.charges(row, t);
    for (const principal of ["*", row.principal_id])
      await db.query(
        "UPDATE durable_budget_days SET tokens_reserved=tokens_reserved-$4,cost_reserved=cost_reserved-$5,tokens_charged=tokens_charged+$6,cost_charged=cost_charged+$7 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
        [
          row.workspace_id,
          principal,
          row.budget_day,
          row.reserved_tokens,
          row.reserved_cost_micros,
          tokens,
          cost,
        ],
      );
    await db.query("UPDATE durable_jobs SET reconciled=true WHERE id=$1", [
      row.id,
    ]);
  }
  async telemetry(ctx: Context, id: string) {
    return this.request(ctx, "jobs.read", async (db) => {
      const row = await this.owned(db, ctx, id);
      await this.readable(db, ctx, row);
      return {
        items: (
          await db.query(
            "SELECT call_id,attempt,provider,model,input_tokens,output_tokens,cost_micros,error_code,created_at FROM durable_model_calls WHERE job_id=$1 ORDER BY created_at,call_id",
            [id],
          )
        ).rows,
      };
    });
  }
  async setBudget(ctx: Context, input: unknown) {
    const value = z
      .object({ principalId: identifier, tokens: integer, costMicros: integer })
      .strict()
      .parse(input);
    return this.request(ctx, "jobs.manage", async (db) => {
      await db.query(
        "INSERT INTO durable_budget_limits VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET tokens=excluded.tokens,cost_micros=excluded.cost_micros",
        [ctx.workspaceId, value.principalId, value.tokens, value.costMicros],
      );
      return value;
    });
  }
  async budgets(ctx: Context) {
    return this.request(ctx, "jobs.manage", async (db) => ({
      items: (
        await db.query(
          "SELECT d.principal_id,d.day,d.tokens_reserved::float8,d.cost_reserved::float8,d.tokens_charged::float8,d.cost_charged::float8,l.tokens::float8 token_limit,l.cost_micros::float8 cost_limit FROM durable_budget_days d LEFT JOIN durable_budget_limits l USING(workspace_id,principal_id) WHERE d.workspace_id=$1 AND d.day=$2 ORDER BY d.principal_id",
          [ctx.workspaceId, this.clock().toISOString().slice(0, 10)],
        )
      ).rows,
    }));
  }
  async setStop(ctx: Context, input: unknown) {
    const stop = z
      .object({
        scope: z.enum(["global", "workspace", "kind", "model", "rule"]),
        key: identifier,
        stopped: z.boolean(),
      })
      .strict()
      .parse(input);
    return this.request(ctx, "jobs.manage", async (db) => {
      if (stop.scope !== "workspace") await this.check(db, ctx, "jobs.global");
      if (stop.scope === "workspace" && stop.key !== ctx.workspaceId)
        throw Error("FORBIDDEN");
      if (stop.scope === "global" && stop.key !== "*")
        throw Error("VALIDATION_FAILED");
      await db.query(
        "INSERT INTO durable_job_stops VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope,key) DO UPDATE SET stopped=excluded.stopped,changed_by=excluded.changed_by,changed_at=excluded.changed_at",
        [stop.scope, stop.key, stop.stopped, ctx.principalId, this.clock()],
      );
      return stop;
    });
  }
  async stops(ctx: Context) {
    return this.request(ctx, "jobs.manage", async (db) => ({
      items: (
        await db.query(
          "SELECT * FROM durable_job_stops WHERE scope<>'workspace' OR key=$1",
          [ctx.workspaceId],
        )
      ).rows,
    }));
  }
  private async event(
    db: PoolClient,
    row: Row,
    topic: string,
    payload: unknown,
  ) {
    await db.query(
      "INSERT INTO durable_job_outbox(id,job_id,topic,payload,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id,topic) DO NOTHING",
      [randomUUID(), row.id, topic, JSON.stringify(payload), this.clock()],
    );
  }
  async claimEvent(workerId: string) {
    identifier.parse(workerId);
    return this.tx(async (db) => {
      await this.mutex(db);
      const rows = (
        await db.query(
          "SELECT * FROM durable_job_outbox WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until<=$1) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
          [this.clock()],
        )
      ).rows;
      for (const row of rows) {
        const job = (
          await db.query("SELECT * FROM durable_jobs WHERE id=$1", [row.job_id])
        ).rows[0];
        try {
          await this.assertCurrent(
            db,
            job,
            await this.resolve(db, this.rowIdentity(job)),
          );
        } catch (e) {
          if (e && typeof e === "object" && "code" in e) throw e;
          // Retain withheld events for recovery, but exclude this bounded batch
          // briefly so a revoked actor cannot starve later authorized events.
          await db.query(
            "UPDATE durable_job_outbox SET lease_until=$2,worker_id=NULL WHERE id=$1",
            [row.id, new Date(+this.clock() + 60000)],
          );
          continue;
        }
        return (
          await db.query(
            "UPDATE durable_job_outbox SET worker_id=$2,fence=fence+1,lease_until=$3 WHERE id=$1 RETURNING *",
            [row.id, workerId, new Date(+this.clock() + this.leaseMs)],
          )
        ).rows[0];
      }
      return null;
    });
  }
  async ackEvent(event: { id: string; worker_id: string; fence: number }) {
    return this.tx(async (db) => {
      const r = await db.query(
        "UPDATE durable_job_outbox SET delivered_at=$4,lease_until=NULL WHERE id=$1 AND worker_id=$2 AND fence=$3 AND lease_until>$4 AND delivered_at IS NULL",
        [event.id, event.worker_id, event.fence, this.clock()],
      );
      if (!r.rowCount) throw Error("LEASE_LOST");
    });
  }

  async saveSchedule(ctx: Context, input: unknown) {
    const serialized = JSON.stringify(input);
    if (!serialized || Buffer.byteLength(serialized) > 500000)
      throw Error("INPUT_LIMIT");
    const spec = scheduleSchema.parse(JSON.parse(serialized));
    nextOccurrence(spec, this.clock());
    if (!["daily", "weekly", "lint", "ingest", "index"].includes(spec.job.kind))
      throw Error("INVALID_SCHEDULE_KIND");
    if (spec.identity.workspaceId !== ctx.workspaceId)
      throw Error("SCOPE_CONFLICT");
    if (
      spec.job.pageIds.some((id) => !spec.approvedPageIds.includes(id)) ||
      spec.job.sourceIds.some((id) => !spec.approvedSourceIds.includes(id))
    )
      throw Error("SCOPE_CONFLICT");
    return this.request(ctx, "jobs.manage", async (db) => {
      const execution = await this.resolve(db, spec.identity);
      await this.validate(db, execution, {
        ...spec.job,
        key: "schedule-preview",
      });
      const previous = (
        await db.query(
          "SELECT * FROM durable_schedules WHERE workspace_id=$1 AND schedule_key=$2 FOR UPDATE",
          [ctx.workspaceId, spec.key],
        )
      ).rows[0];
      if ((previous?.revision ?? 0) !== (spec.expectedRevision ?? 0))
        throw Error("STALE_VERSION");
      const id = previous?.id ?? randomUUID(),
        revision = (previous?.revision ?? 0) + 1;
      const { identity, expectedRevision: _, enabled, ...config } = spec;
      await db.query(
        "INSERT INTO durable_schedules(id,workspace_id,schedule_key,revision,approved_by,identity,config,enabled,next_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,approved_by=excluded.approved_by,identity=excluded.identity,config=excluded.config,enabled=excluded.enabled,next_at=excluded.next_at,updated_at=excluded.updated_at,last_error=NULL",
        [
          id,
          ctx.workspaceId,
          spec.key,
          revision,
          ctx.principalId,
          identity,
          config,
          enabled ?? true,
          nextOccurrence(spec, this.clock()),
          this.clock(),
        ],
      );
      await db.query(
        "INSERT INTO durable_schedule_versions VALUES($1,$2,$3,$4,$5,$6)",
        [id, revision, ctx.principalId, config, identity, this.clock()],
      );
      return { id, revision };
    });
  }
  async schedules(ctx: Context) {
    return this.request(ctx, "jobs.manage", async (db) => ({
      items: (
        await db.query(
          "SELECT id,schedule_key,revision,approved_by,config,enabled,next_at,last_at,last_error FROM durable_schedules WHERE workspace_id=$1 ORDER BY schedule_key LIMIT 100",
          [ctx.workspaceId],
        )
      ).rows,
    }));
  }
  async previewSchedule(ctx: Context, id: string) {
    return this.request(ctx, "jobs.manage", async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM durable_schedules WHERE id=$1 AND workspace_id=$2",
          [id, ctx.workspaceId],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      const execution = await this.resolve(db, row.identity);
      await this.validate(db, execution, { ...row.config.job, key: "preview" });
      let at = this.clock();
      const occurrences = [];
      for (let i = 0; i < 5; i++) {
        at = nextOccurrence(row.config, at);
        occurrences.push(at.toISOString());
      }
      return {
        id,
        revision: row.revision,
        occurrences,
        pageIds: row.config.job.pageIds,
        sourceIds: row.config.job.sourceIds,
        reservation: row.config.job.reservation,
        estimateOnly: true,
        humanReviewRequired: true,
      };
    });
  }
  async enableSchedule(ctx: Context, id: string, enabled: boolean) {
    z.boolean().parse(enabled);
    return this.request(ctx, "jobs.manage", async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM durable_schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [id, ctx.workspaceId],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      if (enabled)
        await this.validate(db, await this.resolve(db, row.identity), {
          ...row.config.job,
          key: "resume",
        });
      await db.query(
        "UPDATE durable_schedules SET enabled=$2,updated_at=$3 WHERE id=$1",
        [id, enabled, this.clock()],
      );
      return { id, enabled };
    });
  }
  async runSchedule(ctx: Context, id: string, key: string) {
    z.string().min(1).max(100).parse(key);
    return this.request(ctx, "jobs.manage", async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM durable_schedules WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [id, ctx.workspaceId],
        )
      ).rows[0];
      if (!row) throw Error("NOT_FOUND");
      return this.enqueueIn(
        db,
        await this.resolve(db, row.identity),
        this.scheduledInput(row, "manual:" + id + ":" + key),
      );
    });
  }
  private scheduledInput(row: Row, key: string): JobInput {
    return {
      ...row.config.job,
      key,
      ruleId: row.config.job.ruleId ?? row.id,
      payload: {
        ...row.config.job.payload,
        manager: {
          scheduleId: row.id,
          revision: row.revision,
          approvedBy: row.approved_by,
        },
      },
    };
  }
  /** A bounded scheduler transaction per schedule. Errors disable no work
   * silently: last_error remains visible and the next tick may recover. */
  async scheduleTick(): Promise<number> {
    const ids = (
      await this.pool.query(
        "SELECT id FROM durable_schedules WHERE enabled AND next_at<=$1 ORDER BY next_at LIMIT 25",
        [this.clock()],
      )
    ).rows;
    let total = 0;
    for (const { id } of ids) {
      try {
        total += await this.tx(async (db) => {
          await this.mutex(db);
          const row = (
            await db.query(
              "SELECT * FROM durable_schedules WHERE id=$1 AND enabled AND next_at<=$2 FOR UPDATE SKIP LOCKED",
              [id, this.clock()],
            )
          ).rows[0];
          if (!row) return 0;
          const spec = row.config as ScheduleInput,
            now = this.clock();
          let at = new Date(row.next_at),
            due: Date[] = [],
            scanned = 0;
          while (+at <= +now && scanned < 32) {
            due.push(at);
            at = nextOccurrence(spec, at);
            scanned++;
          }
          // Bounded catch-up: never scan years of downtime or run unlimited model calls.
          if (+at <= +now) {
            at = nextOccurrence(spec, now);
            due = [];
            if (spec.catchup !== "skip") {
              let recent = nextOccurrence(spec, new Date(+now - 8 * 86400000));
              for (let i = 0; i < 10 && +recent <= +now; i++) {
                due.push(recent);
                recent = nextOccurrence(spec, recent);
              }
            }
          }
          if (spec.catchup === "skip")
            due = due.filter((d) => +now - +d < 60000);
          if (spec.catchup === "latest") due = due.slice(-1);
          if (spec.catchup === "bounded")
            due = due.slice(-(spec.catchupLimit ?? 3));
          const execution = await this.resolve(db, row.identity);
          let count = 0;
          for (const occurrence of due) {
            const date = localDate(spec.timezone, occurrence);
            if (
              (
                await db.query(
                  "SELECT 1 FROM durable_schedule_runs WHERE schedule_id=$1 AND local_date=$2",
                  [id, date],
                )
              ).rowCount
            )
              continue;
            const job = await this.enqueueIn(
              db,
              execution,
              this.scheduledInput(row, `schedule:${id}:${date}`),
            );
            await db.query(
              "INSERT INTO durable_schedule_runs VALUES($1,$2,$3,$4)",
              [id, date, occurrence, job.id],
            );
            count++;
          }
          await db.query(
            "UPDATE durable_schedules SET next_at=$2,last_at=$3,last_error=NULL,updated_at=$3 WHERE id=$1",
            [id, at, now],
          );
          return count;
        });
      } catch (e) {
        await this.pool.query(
          "UPDATE durable_schedules SET last_error=$2,updated_at=$3 WHERE id=$1",
          [
            id,
            safeError(e instanceof Error ? e.message : "SCHEDULER_FAILED"),
            this.clock(),
          ],
        );
      }
    }
    return total;
  }
}
