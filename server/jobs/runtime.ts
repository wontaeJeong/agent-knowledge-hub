import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  authorizeActionDb,
  effectiveAccess,
  authorizeInTransaction,
  type Action,
} from "../access/index";
import { transaction } from "../database";
import { fingerprint } from "../provenance";
import type { Context } from "../service";
import { assertJobFeatures } from "../policy/features";
import { sourcePolicyHash } from "../policy/model";
import { RuntimeService, type RuntimeExecution } from "../runtime/knowledge";
import { modelConfig, MODEL_CONTRACT_VERSION } from "../runtime/model";
import { ingestInput, queryInput } from "../runtime/schema";
import { JobService, parseJobInput, type JobOptions } from "./service";
import { JobWorker } from "./worker";
import type { JobInput, JobHooks, JobRun, ExecutionIdentity } from "./types";
import {
  RuntimeIdentityAuthority,
  type RuntimeIdentityOptions,
} from "./identity";

export interface RuntimeJobsOptions extends RuntimeIdentityOptions {
  /** Trusted DB-only sealed conversation preparation; not caller-selected source scope. */
  questions?: {
    prepare: (
      db: PoolClient,
      ctx: Context,
      input: unknown,
    ) => Promise<{
      payload: Record<string, unknown>;
      pageIds: string[];
      sourceIds: string[];
    }>;
    execute: (
      ctx: Context,
      payload: Record<string, unknown>,
      execution: RuntimeExecution,
    ) => Promise<unknown>;
  };
  semanticLint?: {
    prepare: (
      db: PoolClient,
      ctx: Context,
      input: unknown,
    ) => Promise<{
      payload: Record<string, unknown>;
      pageIds: string[];
      sourceIds: string[];
    }>;
    execute: (
      ctx: Context,
      payload: Record<string, unknown>,
      execution: RuntimeExecution,
    ) => Promise<unknown>;
  };
  workerCount?: number;
  queue?: JobOptions;
  timeoutMs?: number;
  maxChanges?: number;
  modelReservation?: { tokens: number; costMicros: number };
  maxContextBytes?: number;
  maxOutputTokens?: number;
  platformOperatorIds?: readonly string[];
}
export function runtimeCapabilities(
  canonical: readonly string[],
  principalId: string,
  platformOperatorIds: readonly string[] = [],
): string[] {
  const result = new Set(canonical.filter((c) => !c.startsWith("jobs.")));
  if (result.has("knowledge.read")) {
    result.add("jobs.read");
    result.add("jobs.run");
    if (platformOperatorIds.includes(principalId)) result.add("jobs.global");
  }
  if (result.has("knowledge.protect")) result.add("jobs.manage");
  return [...result];
}
const actionFor = (kind: string): Action =>
  kind === "query"
    ? "knowledge.read"
    : kind === "lint"
      ? "lint.run"
      : "changeset.propose";
const grantPayloadHash = (input: JobInput) =>
  fingerprint({
    kind: input.kind,
    payload: input.payload,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    reservation: input.reservation,
    limits: input.limits ?? null,
    model: input.model ?? null,
    ruleId: input.ruleId ?? null,
  });
function payloadFor(
  kind: string,
  payload: unknown,
  internal = false,
): Record<string, unknown> {
  if (kind === "query") {
    if (payload && typeof payload === "object" && "threadId" in payload) {
      const base = z
        .object({
          threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          turnId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        })
        .strict();
      return (
        internal
          ? base
              .extend({
                mode: z.enum(["offline", "model"]),
                prepared: z.record(z.string(), z.unknown()),
              })
              .strict()
          : base
      ).parse(payload);
    }
    return queryInput.parse(payload);
  }
  if (kind === "ingest") return ingestInput.parse(payload);
  if (
    kind === "lint" &&
    payload &&
    typeof payload === "object" &&
    "semantic" in payload &&
    payload.semantic === true
  ) {
    return (
      internal
        ? z
            .object({
              semantic: z.literal(true),
              context: z.unknown(),
              prepared: z.record(z.string(), z.unknown()),
            })
            .strict()
        : z.object({ semantic: z.literal(true), context: z.unknown() }).strict()
    ).parse(payload);
  }
  if (kind === "lint" && internal)
    return z
      .object({ manager: z.unknown().optional() })
      .strict()
      .parse(payload);
  if (kind === "lint") return z.object({}).strict().parse(payload);
  if (kind === "daily" || kind === "weekly")
    return z
      .object({
        mode: z.enum(["offline", "model"]).default("offline"),
        sourceIds: z.array(z.string().min(1).max(100)).max(20).optional(),
        manager: z.unknown().optional(),
      })
      .strict()
      .parse(payload);
  throw Error("JOB_KIND_NOT_SUPPORTED");
}
/** Production bridge: canonical access policy applies to every actor, grant,
 * operation and input. Human one-shot consent never becomes a service identity. */
export function createRuntimeJobs(
  pool: Pool,
  service: RuntimeService = new RuntimeService(pool),
  options: RuntimeJobsOptions = {},
) {
  const timeout = Math.min(options.timeoutMs ?? 120000, 3600000),
    maxChanges = options.maxChanges ?? 20;
  const reservation = options.modelReservation ?? {
    tokens: 70000,
    costMicros: 100000,
  };
  const maxContextBytes = options.maxContextBytes ?? 64000,
    maxOutputTokens = options.maxOutputTokens ?? 6000;
  if (
    !Number.isSafeInteger(reservation.tokens) ||
    !Number.isSafeInteger(reservation.costMicros) ||
    reservation.tokens < maxContextBytes + maxOutputTokens ||
    reservation.costMicros < 0
  )
    throw Error("INVALID_JOB_OPTIONS");
  if (
    !Number.isInteger(timeout) ||
    timeout < 10 ||
    !Number.isInteger(maxChanges) ||
    maxChanges < 0 ||
    maxChanges > 20 ||
    maxContextBytes < 1 ||
    maxContextBytes > 300000 ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 6000
  )
    throw Error("INVALID_JOB_OPTIONS");
  const operators = new Set(options.platformOperatorIds ?? []);
  const authority = new RuntimeIdentityAuthority(pool, options);
  const runtimeRules = readFileSync(
    new URL("../../wiki/SCHEMA.md", import.meta.url),
    "utf8",
  );
  const modelPolicy = () => ({
    config: modelConfig(),
    baseURL: process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL ?? null,
    provider: process.env.AGENT_KNOWLEDGE_HUB_LLM_PROVIDER ?? null,
    transmission:
      process.env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION === "true",
    thinking: process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING ?? null,
    keyVersion: fingerprint(
      process.env.AGENT_KNOWLEDGE_HUB_LLM_API_KEY ?? null,
    ),
    rulesHash: fingerprint(runtimeRules),
    contractVersion: MODEL_CONTRACT_VERSION,
    reservation,
    maxContextBytes,
    maxOutputTokens,
  });
  const grant = authority.grant.bind(authority),
    serviceIdentity = authority.service.bind(authority);
  const needsModel = (payload: Record<string, unknown>) =>
    payload.mode === "model" || payload.semantic === true;
  const prepareSemantic = async (
    db: PoolClient,
    ctx: Context,
    context: unknown,
  ) => {
    if (!options.semanticLint) throw Error("SEMANTIC_LINT_NOT_CONFIGURED");
    const raw = await options.semanticLint.prepare(db, ctx, context),
      json = JSON.stringify(raw);
    if (Buffer.byteLength(json) > 450000) throw Error("INPUT_LIMIT");
    return z
      .object({
        payload: z.record(z.string(), z.unknown()),
        pageIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(200),
        sourceIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(200),
      })
      .strict()
      .parse(JSON.parse(json));
  };
  const hooks: JobHooks = {
    inputsAreReadOnly: true,
    revalidateIdentity: (identity) => authority.refresh(identity),
    authorize: async (db, ctx, action, resource) => {
      if (action === "jobs.global") {
        if (ctx.credentialId || !operators.has(ctx.principalId))
          throw Error("FORBIDDEN");
        await authorizeActionDb(db, ctx, "knowledge.read");
        return;
      }
      const mapped =
        action === "jobs.manage"
          ? "knowledge.protect"
          : action === "jobs.run" || action === "jobs.read"
            ? "knowledge.read"
            : null;
      if (!mapped) throw Error("FORBIDDEN");
      await authorizeInTransaction(db, ctx, mapped, resource);
    },
    resolveIdentity: (db, identity) => authority.resolve(db, identity),
    policyFingerprint: async (db, ctx) => {
      const access = (
        await db.query(
          "SELECT policy_version,active,namespace_id FROM access_spaces WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows;
      const flags = (
        await db.query(
          "SELECT page_id,state,revision,data FROM workflow_document_state WHERE workspace_id=$1 ORDER BY page_id",
          [ctx.workspaceId],
        )
      ).rows;
      const service = (
        await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND kind='service'",
          [ctx.principalId],
        )
      ).rowCount;
      return fingerprint({
        access,
        transmissionPolicy: await sourcePolicyHash(db, ctx, {
          pageIds: [],
          sourceIds: [],
        }),
        flags: flags.map((f) => ({
          ...f,
          currentRecommendation:
            f.state === "active" &&
            !f.data.replacementId &&
            (!f.data.effectiveFrom ||
              (Number.isFinite(Date.parse(f.data.effectiveFrom)) &&
                Date.parse(f.data.effectiveFrom) <= Date.now())),
          reviewOverdue:
            !!f.data.reviewDue && Date.parse(f.data.reviewDue) < Date.now(),
        })),
        model: modelPolicy(),
        ...(service
          ? {
              directory: {
                providerId: options.directoryProviderId ?? null,
                maxAge: authority.maxAge,
              },
            }
          : {}),
      });
    },
    validateScope: async (db, ctx, input, purpose = "execute") => {
      if (
        purpose === "schedule" &&
        input.kind === "lint" &&
        input.payload.semantic === true
      )
        throw Error("SEMANTIC_SCHEDULE_NOT_SUPPORTED");
      const payload = payloadFor(input.kind, input.payload, true);
      if (purpose !== "read") await assertJobFeatures(db, ctx, input.kind);
      await authorizeActionDb(db, ctx, actionFor(input.kind));
      if (input.kind === "query" && typeof payload.threadId === "string") {
        if (!options.questions) throw Error("QUESTION_JOBS_NOT_CONFIGURED");
        const fresh = await options.questions.prepare(
          db,
          ctx,
          payload.prepared,
        );
        if (
          fingerprint(fresh.payload) !== fingerprint(payload.prepared) ||
          fresh.payload.mode !== payload.mode ||
          fingerprint([...fresh.pageIds].sort()) !==
            fingerprint([...input.pageIds].sort()) ||
          fingerprint([...fresh.sourceIds].sort()) !==
            fingerprint([...input.sourceIds].sort())
        )
          throw Error("STALE_VERSION");
      }
      if (payload.semantic === true) {
        const sealed = await prepareSemantic(db, ctx, payload.prepared);
        if (
          fingerprint(sealed.payload) !== fingerprint(payload.prepared) ||
          fingerprint([...sealed.pageIds].sort()) !==
            fingerprint([...input.pageIds].sort()) ||
          fingerprint([...sealed.sourceIds].sort()) !==
            fingerprint([...input.sourceIds].sort())
        )
          throw Error("STALE_VERSION");
      }
      const g = await grant(db, ctx);
      if (
        g &&
        (g.operation !== input.kind ||
          g.request_key !== input.key ||
          g.payload_hash !== grantPayloadHash(input) ||
          fingerprint(g.page_ids) !== fingerprint(input.pageIds) ||
          fingerprint(g.source_ids) !== fingerprint(input.sourceIds))
      )
        throw Error("EXECUTION_SCOPE_CONFLICT");
      if (
        (input.kind === "daily" || input.kind === "weekly") &&
        ctx.credentialId
      )
        await serviceIdentity(db, {
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          credentialId: ctx.credentialId,
        });
      const actor = (
        await db.query("SELECT kind FROM access_principals WHERE id=$1", [
          ctx.principalId,
        ])
      ).rows[0];
      if (payload.manager !== undefined) {
        if (purpose === "schedule") throw Error("EXECUTION_SCOPE_CONFLICT");
        const manager = z
          .object({
            scheduleId: z.string(),
            revision: z.number().int().positive(),
            approvedBy: z.string(),
          })
          .strict()
          .parse(payload.manager);
        const version = (
          await db.query(
            "SELECT v.* FROM durable_schedule_versions v JOIN durable_schedules s ON s.id=v.schedule_id WHERE v.schedule_id=$1 AND v.revision=$2 AND s.workspace_id=$3",
            [manager.scheduleId, manager.revision, ctx.workspaceId],
          )
        ).rows[0];
        if (
          !version ||
          version.approved_by !== manager.approvedBy ||
          version.config.job.kind !== input.kind ||
          fingerprint(version.config.job.pageIds) !==
            fingerprint(input.pageIds) ||
          fingerprint(version.config.job.sourceIds) !==
            fingerprint(input.sourceIds) ||
          input.ruleId !== (version.config.job.ruleId ?? manager.scheduleId) ||
          (!input.key.startsWith(`schedule:${manager.scheduleId}:`) &&
            !input.key.startsWith(`manual:${manager.scheduleId}:`))
        )
          throw Error("EXECUTION_SCOPE_CONFLICT");
        if (
          actor?.kind === "service" &&
          (version.identity.principalId !== ctx.principalId ||
            version.identity.credentialId !== ctx.credentialId)
        )
          throw Error("EXECUTION_SCOPE_CONFLICT");
        const { manager: _, ...operationPayload } = payload;
        if (
          fingerprint(operationPayload) !==
          fingerprint(payloadFor(input.kind, version.config.job.payload))
        )
          throw Error("EXECUTION_SCOPE_CONFLICT");
      } else if (
        actor?.kind === "service" &&
        purpose === "execute" &&
        payload.semantic !== true &&
        typeof payload.threadId !== "string"
      ) {
        const state = (await service.view(db, ctx)).state;
        if (
          fingerprint([...input.pageIds].sort()) !==
            fingerprint(state.pages.map((p) => p.id).sort()) ||
          fingerprint([...input.sourceIds].sort()) !==
            fingerprint(state.sources.map((s) => s.id).sort())
        )
          throw Error("EXECUTION_SCOPE_CONFLICT");
      }
      if (needsModel(payload)) {
        if (!modelConfig().configured || input.model !== modelConfig().model)
          throw Error("MODEL_POLICY_CHANGED");
        if (
          input.reservation.tokens !== reservation.tokens ||
          input.reservation.costMicros !== reservation.costMicros
        )
          throw Error("BUDGET_SCOPE_CONFLICT");
      }
      if (
        input.timeoutMs > timeout ||
        (input.limits?.changes ?? maxChanges) > maxChanges
      )
        throw Error("EXECUTION_SCOPE_CONFLICT");
      for (const id of input.pageIds)
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "page",
          id,
        });
      for (const id of input.sourceIds)
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "source",
          id,
        });
    },
    validateScheduleIdentity: serviceIdentity,
  };
  const jobs = new JobService(pool, hooks, options.queue);
  const settings = (
    kind: string,
    payload: Record<string, unknown>,
    key: string,
    requested?: JobInput,
  ): JobInput => {
    if (requested?.ruleId) throw Error("EXECUTION_SCOPE_CONFLICT");
    if (
      requested?.model &&
      requested.model !==
        (needsModel(payload) ? modelConfig().model : undefined)
    )
      throw Error("MODEL_SCOPE_CONFLICT");
    if (
      needsModel(payload) &&
      requested &&
      (requested.reservation.tokens < reservation.tokens ||
        requested.reservation.costMicros < reservation.costMicros)
    )
      throw Error("BUDGET_SCOPE_CONFLICT");
    return {
      kind,
      key,
      payload,
      pageIds: [],
      sourceIds: [],
      reservation: needsModel(payload)
        ? { ...reservation }
        : { tokens: 0, costMicros: 0 },
      timeoutMs: Math.min(requested?.timeoutMs ?? timeout, timeout),
      maxAttempts: Math.min(requested?.maxAttempts ?? 3, 3),
      limits: {
        documents: Math.min(requested?.limits?.documents ?? 200, 200),
        changes: Math.min(requested?.limits?.changes ?? maxChanges, maxChanges),
      },
      ...(needsModel(payload)
        ? { model: modelConfig().model ?? undefined }
        : {}),
    };
  };
  const derive = async (
    db: PoolClient,
    ctx: Context,
    kind: string,
    payload: Record<string, unknown>,
    key: string,
    requested?: JobInput,
  ): Promise<JobInput> => {
    await authorizeInTransaction(db, ctx, actionFor(kind));
    await authorizeActionDb(db, ctx, "knowledge.read");
    if (kind === "query" && typeof payload.threadId === "string") {
      if (!options.questions) throw Error("QUESTION_JOBS_NOT_CONFIGURED");
      const prepared = await options.questions.prepare(db, ctx, payload);
      if (
        Buffer.byteLength(JSON.stringify(prepared)) > 450000 ||
        prepared.pageIds.length + prepared.sourceIds.length > 200
      )
        throw Error("INPUT_LIMIT");
      const mode = z.enum(["offline", "model"]).parse(prepared.payload.mode);
      return {
        ...settings(
          kind,
          {
            threadId: payload.threadId,
            turnId: payload.turnId,
            mode,
            prepared: prepared.payload,
          },
          key,
          requested,
        ),
        pageIds: [...new Set(prepared.pageIds)].sort(),
        sourceIds: [...new Set(prepared.sourceIds)].sort(),
      };
    }
    if (kind === "lint" && payload.semantic === true) {
      const prepared = await prepareSemantic(db, ctx, payload);
      return {
        ...settings(
          kind,
          {
            semantic: true,
            context: payload.context,
            prepared: prepared.payload,
          },
          key,
          requested,
        ),
        pageIds: [...new Set(prepared.pageIds)].sort(),
        sourceIds: [...new Set(prepared.sourceIds)].sort(),
      };
    }
    const { state } = await service.view(db, ctx);
    if (kind === "ingest")
      for (const id of payload.sourceIds as string[])
        if (!state.sources.some((s) => s.id === id)) throw Error("NOT_FOUND");
    return {
      ...settings(kind, payload, key, requested),
      pageIds: state.pages.map((p) => p.id).sort(),
      sourceIds: state.sources.map((s) => s.id).sort(),
    };
  };
  const submitInteractive = async (
    ctx: Context,
    kind: "ingest" | "query" | "lint",
    raw: unknown,
    key: string,
    requested?: JobInput,
  ) => {
    Object.freeze(ctx);
    z.string().min(1).max(200).parse(key);
    const payload = payloadFor(kind, raw);
    if (payload.semantic === true && !options.semanticLint)
      throw Error("SEMANTIC_LINT_NOT_CONFIGURED");
    if (
      kind === "query" &&
      typeof payload.threadId === "string" &&
      !options.questions
    )
      throw Error("QUESTION_JOBS_NOT_CONFIGURED");
    await ctx.authorization?.revalidate();
    const parentSession = ctx.authorization
      ? await authority.prepareSession(ctx)
      : null;
    if (!ctx.credentialId && !parentSession) throw Error("UNAUTHENTICATED");
    if (
      ctx.credentialId &&
      (
        await pool.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND kind='service'",
          [ctx.principalId],
        )
      ).rowCount
    )
      await authority.refresh({
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
        credentialId: ctx.credentialId,
      });
    const admission = await transaction(pool, ctx.workspaceId, async (db) => {
      await ctx.authorization?.assertSession(db);
      await authorizeActionDb(db, ctx, actionFor(kind));
      await authorizeActionDb(db, ctx, "knowledge.read");
      const existing = (
        await db.query(
          "SELECT id,input FROM durable_jobs WHERE workspace_id=$1 AND principal_id=$2 AND idempotency_key=$3",
          [ctx.workspaceId, ctx.principalId, key],
        )
      ).rows[0];
      if (existing) {
        const replayPayload =
          payload.semantic === true
            ? { ...payload, prepared: existing.input.payload.prepared }
            : payload;
        if (
          grantPayloadHash(existing.input) !==
          grantPayloadHash(settings(kind, replayPayload, key, requested))
        )
          throw Error("IDEMPOTENCY_CONFLICT");
        return { existing: existing.id } as const;
      }
      const input = await derive(db, ctx, kind, payload, key, requested);
      const principal = (
        await db.query(
          "SELECT kind FROM access_principals WHERE id=$1 AND active",
          [ctx.principalId],
        )
      ).rows[0];
      if (!principal) throw Error("UNAUTHENTICATED");
      if (principal.kind === "service") {
        if (!ctx.credentialId) throw Error("SCOPED_SERVICE_IDENTITY_REQUIRED");
        await serviceIdentity(db, {
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          credentialId: ctx.credentialId,
        });
        return {
          input,
          identity: {
            workspaceId: ctx.workspaceId,
            principalId: ctx.principalId,
            credentialId: ctx.credentialId,
          },
        } as const;
      }
      let g = (
        await db.query(
          "SELECT * FROM runtime_execution_grants WHERE workspace_id=$1 AND principal_id=$2 AND request_key=$3",
          [ctx.workspaceId, ctx.principalId, key],
        )
      ).rows[0];
      if (g) {
        if (
          g.operation !== kind ||
          g.payload_hash !== grantPayloadHash(input) ||
          (g.parent_credential_id ?? null) !== (ctx.credentialId ?? null) ||
          (g.parent_session_id ?? null) !== (parentSession?.sessionId ?? null)
        )
          throw Error("IDEMPOTENCY_CONFLICT");
        input.pageIds = g.page_ids;
        input.sourceIds = g.source_ids;
      } else {
        const id = randomUUID(),
          created = (await db.query("SELECT clock_timestamp() AS at")).rows[0]
            .at as Date;
        let expires = new Date(+created + input.timeoutMs);
        if (parentSession)
          expires = new Date(Math.min(+expires, +parentSession.expiresAt));
        if (ctx.credentialId) {
          const parent = (
            await db.query(
              "SELECT expires_at FROM access_credentials WHERE id=$1 AND principal_id=$2 AND workspace_id=$3 AND NOT revoked",
              [ctx.credentialId, ctx.principalId, ctx.workspaceId],
            )
          ).rows[0];
          if (!parent) throw Error("CREDENTIAL_REVOKED");
          expires = new Date(Math.min(+expires, +new Date(parent.expires_at)));
        }
        const actions = [
          ...new Set<Action>(["knowledge.read", actionFor(kind)]),
        ];
        for (const a of actions) await authorizeActionDb(db, ctx, a);
        // No usable secret is retained or returned; canonical credential policy
        // still intersects current principal rights and these minimal actions.
        const secretHash = createHash("sha256")
          .update(randomBytes(32))
          .digest("hex");
        await db.query(
          "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
          [id, secretHash, ctx.principalId, ctx.workspaceId, actions, expires],
        );
        await db.query(
          "INSERT INTO runtime_execution_grants(credential_id,workspace_id,principal_id,operation,payload_hash,page_ids,source_ids,parent_credential_id,request_key,timeout_ms,created_at,expires_at,parent_session_id,parent_session_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            id,
            ctx.workspaceId,
            ctx.principalId,
            kind,
            grantPayloadHash(input),
            input.pageIds,
            input.sourceIds,
            ctx.credentialId ?? null,
            key,
            input.timeoutMs,
            created,
            expires,
            parentSession?.sessionId ?? null,
            parentSession?.snapshot ?? null,
          ],
        );
        g = { credential_id: id };
        await db.query(
          "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,$2,'job.interactive-consent',$3)",
          [ctx.workspaceId, ctx.principalId, id],
        );
      }
      return {
        input,
        identity: {
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          credentialId: g.credential_id as string,
        },
      } as const;
    });
    await ctx.authorization?.revalidate();
    if ("existing" in admission) return jobs.get(ctx, admission.existing!);
    const result = await jobs.enqueue(admission.identity, admission.input);
    await pool.query(
      "UPDATE runtime_execution_grants SET job_id=$2 WHERE credential_id=$1",
      [admission.identity.credentialId, result.id],
    );
    return result;
  };
  const execution = (run: JobRun): RuntimeExecution => {
    let modelUsed = false;
    return {
      modelWasUsed: () => modelUsed,
      producer: async (mode, db) => {
        if (mode === "offline") return { kind: "structural" };
        const call = (
          await (db ?? pool).query(
            "SELECT provider,model FROM durable_model_calls WHERE job_id=$1 ORDER BY created_at DESC,call_id DESC LIMIT 1",
            [run.lease.id],
          )
        ).rows[0];
        return {
          kind: "model",
          provider: call?.provider ?? null,
          model: call?.model ?? null,
        };
      },
      modelResult: async (operation, call) => {
        modelUsed = true;
        await run.ready();
        const row = (
          await pool.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
            run.lease.id,
          ])
        ).rows[0];
        const previous = row?.checkpoint?.effects?.["model-" + operation];
        if (previous !== undefined) return previous;
        const result = await call();
        run.signal.throwIfAborted();
        return jobs.savePrepared(run.lease, "model-" + operation, result);
      },
      selectState: (state) => ({
        ...state,
        pages: state.pages.filter((p) =>
          run.lease.envelope.pageIds.includes(p.id),
        ),
        sources: state.sources.filter((s) =>
          run.lease.envelope.sourceIds.includes(s.id),
        ),
      }),
      captureInputs: async (db, pages, sources) => {
        run.signal.throwIfAborted();
        await jobs.captureInputs(db, run.lease, pages, sources);
      },
      beforeWrite: async (db) => {
        run.signal.throwIfAborted();
        await jobs.assertReadyInTransaction(db, run.lease);
      },
      completed: async (stage) => {
        await run.ready();
        const row = (
          await pool.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
            run.lease.id,
          ])
        ).rows[0];
        return row?.checkpoint?.effects?.[stage];
      },
      persist: async (db, stage, write) => {
        run.signal.throwIfAborted();
        return jobs.commitEffect(db, run.lease, stage, write);
      },
      proposalCreated: async (db, result, updates) => {
        run.signal.throwIfAborted();
        await jobs.assertReadyInTransaction(db, run.lease);
        if (
          updates.length >
          Math.min(run.lease.input.limits?.changes ?? maxChanges, maxChanges)
        )
          throw Error("CHANGE_LIMIT");
        for (const update of updates) {
          if (
            update.baseVersion > 0 &&
            !run.lease.envelope.pageIds.includes(update.id)
          )
            throw Error("EXECUTION_SCOPE_CONFLICT");
          if (
            update.sourceIds.some(
              (id) => !run.lease.envelope.sourceIds.includes(id),
            )
          )
            throw Error("EXECUTION_SCOPE_CONFLICT");
          for (const link of update.links)
            if (
              !run.lease.envelope.pageIds.includes(link) &&
              !updates.some((d) => d.id === link)
            )
              throw Error("EXECUTION_SCOPE_CONFLICT");
          const flag = (
            await db.query(
              "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
              [run.ctx.workspaceId, update.id],
            )
          ).rows[0];
          if (
            flag &&
            (flag.state !== "active" ||
              flag.data.protected ||
              flag.data.replacementId ||
              (flag.data.effectiveFrom &&
                (!Number.isFinite(Date.parse(flag.data.effectiveFrom)) ||
                  Date.parse(flag.data.effectiveFrom) > Date.now())))
          )
            throw Error("DOCUMENT_PROTECTED");
        }
        const row = (
          await db.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
            run.lease.id,
          ])
        ).rows[0];
        if (row.checkpoint?.effects?.ingest !== undefined)
          throw Error("RUNTIME_EFFECT_EXISTS");
        await jobs.commitEffect(db, run.lease, "ingest", async () => result);
      },
      maxChanges: Math.min(
        run.lease.input.limits?.changes ?? maxChanges,
        maxChanges,
      ),
      modelOptions: {
        signal: run.signal,
        rules: runtimeRules,
        maxContextBytes,
        maxOutputTokens,
        beforeCall: async (provider, model) => {
          modelUsed = true;
          await run.ready();
          await run.beginModel({
            callId: `${run.lease.input.kind}-${run.lease.attempt}`,
            provider,
            model,
            maxTokens: run.lease.input.reservation.tokens,
            maxCostMicros: run.lease.input.reservation.costMicros,
          });
        },
        onUsage: (usage) =>
          run.recordModel({
            callId: `${run.lease.input.kind}-${run.lease.attempt}`,
            ...usage,
          }),
      },
    };
  };
  const handler = async (run: JobRun) => {
    const e = execution(run),
      ctx: Context = Object.freeze({
        ...run.ctx,
        authorization: {
          revalidate: run.ready,
          assertSession: async (db: PoolClient) => {
            run.signal.throwIfAborted();
            await jobs.assertIdentityInTransaction(db, run.lease);
          },
        },
      });
    const input = run.lease.input,
      payload = payloadFor(input.kind, input.payload, true);
    let value: unknown;
    if (input.kind === "query" && typeof payload.threadId === "string") {
      if (!options.questions) throw Error("QUESTION_JOBS_NOT_CONFIGURED");
      value = await options.questions.execute(
        ctx,
        payload.prepared as Record<string, unknown>,
        e,
      );
    } else if (input.kind === "query")
      value = await service.query(
        ctx,
        payload.question as string,
        payload.mode as "offline" | "model",
        e,
      );
    else if (input.kind === "lint" && payload.semantic === true) {
      if (!options.semanticLint) throw Error("SEMANTIC_LINT_NOT_CONFIGURED");
      value = await options.semanticLint.execute(
        ctx,
        payload.prepared as Record<string, unknown>,
        e,
      );
    } else if (input.kind === "lint") value = await service.lint(ctx, e);
    else if (input.kind === "ingest")
      value = await service.ingest(
        ctx,
        payload.sourceIds as string[],
        payload.mode as "offline" | "model",
        e,
      );
    else {
      const state = (await service.snapshot(ctx)).state;
      const candidates =
        (payload.sourceIds as string[] | undefined) ??
        state.sources
          .filter((s) => !s.processed && input.sourceIds.includes(s.id))
          .map((s) => s.id)
          .slice(0, 20);
      const contextFingerprint = fingerprint(run.lease.envelope.pages);
      const rulesFingerprint = fingerprint({
        rules: runtimeRules,
        contractVersion: MODEL_CONTRACT_VERSION,
        policyHash: run.lease.policyHash,
        manager: payload.manager ?? null,
        mode: payload.mode,
        model: input.model ?? null,
      });
      const prior = (
        await pool.query(
          "SELECT result,envelope,policy_hash FROM durable_jobs WHERE workspace_id=$1 AND principal_id=$2 AND kind IN ('daily','weekly') AND status='succeeded' ORDER BY created_at DESC LIMIT 100",
          [ctx.workspaceId, ctx.principalId],
        )
      ).rows;
      const sourceIds = candidates.filter(
        (id) =>
          !prior.some(
            (p) =>
              p.result?.sourceIds?.includes(id) &&
              p.result?.processing?.rulesFingerprint === rulesFingerprint &&
              p.policy_hash === run.lease.policyHash &&
              p.envelope.sources[id] === run.lease.envelope.sources[id] &&
              fingerprint(p.envelope.pages) ===
                fingerprint(run.lease.envelope.pages) &&
              Object.entries(p.envelope.acl).every(
                ([key, acl]) =>
                  fingerprint(acl) === fingerprint(run.lease.envelope.acl[key]),
              ),
          ),
      );
      const lint = await service.lint(ctx, e);
      const ingestion = sourceIds.length
        ? await service.ingest(
            ctx,
            sourceIds,
            payload.mode as "offline" | "model",
            e,
          )
        : null;
      const noChanges =
        !ingestion || ("noChanges" in ingestion && ingestion.noChanges);
      const proposal = ingestion && "id" in ingestion ? ingestion : null;
      // Publication receipts, not rawSource.processed or a model success badge,
      // are the only evidence that a source previously reached published pages.
      const receipts = (
        await pool.query(
          "SELECT p.batch_id,p.result,b.data,j.policy_hash AS originating_policy_hash FROM publications p JOIN batches b ON b.workspace_id=p.workspace_id AND b.id=p.batch_id LEFT JOIN durable_jobs j ON j.workspace_id=p.workspace_id AND j.checkpoint#>>'{effects,ingest,id}'=p.batch_id LEFT JOIN audit a ON a.workspace_id=p.workspace_id AND a.resource_id=p.batch_id AND a.operation='batch.publish' WHERE p.workspace_id=$1 ORDER BY a.at DESC NULLS LAST,p.batch_id DESC",
          [ctx.workspaceId],
        )
      ).rows;
      const sourceAttempts = candidates.map((sourceId) => {
        const sourceFingerprint = run.lease.envelope.sources[sourceId];
        const receipt = receipts.find(
          (r) =>
            r.data.snapshots?.some(
              (s: { id: string }) =>
                s.id === sourceId && fingerprint(s) === sourceFingerprint,
            ) &&
            r.data.snapshots.every((s: { id: string }) =>
              run.lease.envelope.sourceIds.includes(s.id),
            ) &&
            r.data.updates.every((d: { id: string }) =>
              run.lease.envelope.pageIds.includes(d.id),
            ),
        );
        return {
          sourceId,
          sourceFingerprint,
          contextFingerprint,
          rulesFingerprint,
          outcome: !sourceIds.includes(sourceId)
            ? "unchanged-inputs"
            : noChanges
              ? "checked-no-change"
              : "proposal-created",
          lastPublishedContext: receipt
            ? {
                batchId: receipt.batch_id,
                versions: receipt.result.versions,
                fingerprint: fingerprint({
                  versions: receipt.result.versions,
                  updates: receipt.data.updates,
                }),
                domainRuleVersion: receipt.data.policyVersion ?? null,
                runtimePolicyHash: receipt.originating_policy_hash ?? null,
              }
            : null,
        };
      });
      value = {
        lint,
        proposal,
        sourceIds,
        attemptedSourceIds: candidates,
        processedSourceIds: [],
        proposedSourceIds: proposal ? sourceIds : [],
        sourceAttempts,
        processing: {
          contextFingerprint,
          rulesFingerprint,
          sourceFingerprints: sourceAttempts.map((a) => ({
            sourceId: a.sourceId,
            fingerprint: a.sourceFingerprint,
          })),
          lastPublishedContexts: sourceAttempts
            .filter((a) => a.lastPublishedContext !== null)
            .map((a) => ({ sourceId: a.sourceId, ...a.lastPublishedContext })),
        },
        noChanges,
        outcome: noChanges ? "no-changes" : "proposal-created",
        humanReviewRequired: true,
        noNewEvidence: sourceIds.length === 0,
      };
    }
    return { value, noModelCalls: !e.modelWasUsed() };
  };
  const count = options.workerCount ?? 2;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw Error("CONCURRENCY_LIMIT");
  const workers = Array.from(
    { length: count },
    (_, i) =>
      new JobWorker(
        jobs,
        {
          ingest: handler,
          query: handler,
          lint: handler,
          daily: handler,
          weekly: handler,
        },
        {
          workerId: `runtime-${randomUUID()}`,
          lane:
            count === 1 ? undefined : i === 0 ? "interactive" : "maintenance",
        },
      ),
  );
  return {
    jobs,
    workers,
    worker: workers[0],
    start: () => workers.forEach((w) => w.start()),
    stop: async () => {
      await Promise.all(workers.map((w) => w.stop()));
    },
    submitInteractive: (
      ctx: Context,
      kind: "ingest" | "query" | "lint",
      payload: unknown,
      key: string,
    ) => submitInteractive(ctx, kind, payload, key),
    submitDelegated: async (ctx: Context, raw: unknown) => {
      const input = parseJobInput(raw);
      if (["query", "ingest", "lint"].includes(input.kind))
        return submitInteractive(
          ctx,
          input.kind as "query" | "ingest" | "lint",
          input.payload,
          input.key,
          input,
        );
      if (!ctx.credentialId) throw Error("SCOPED_SERVICE_IDENTITY_REQUIRED");
      await authority.refresh({
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
        credentialId: ctx.credentialId,
      });
      const derived = await transaction(pool, ctx.workspaceId, async (db) => {
        await serviceIdentity(db, {
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          credentialId: ctx.credentialId!,
        });
        return derive(
          db,
          ctx,
          input.kind,
          payloadFor(input.kind, input.payload),
          input.key,
          input,
        );
      });
      return jobs.enqueue(ctx, derived);
    },
    read: (ctx: Context, id: string) => jobs.get(ctx, id),
    cancel: (ctx: Context, id: string) => jobs.cancel(ctx, id),
    list: (ctx: Context, offset = 0, scope: "own" | "workspace" = "own") =>
      jobs.list(ctx, offset, scope),
    runtimeCapabilities: (canonical: readonly string[], principalId: string) =>
      runtimeCapabilities(canonical, principalId, [...operators]),
    readiness: () => ({
      interactiveSessionConfigured:
        !!options.revalidateInteractiveGrant &&
        !!options.assertInteractiveGrant,
      serviceDirectoryConfigured:
        !!options.directoryStatus && !!options.directoryProviderId,
      directoryProviderId: options.directoryProviderId ?? null,
      semanticLintConfigured: !!options.semanticLint,
    }),
    revalidateCredential: async (ctx: Context): Promise<void> => {
      Object.freeze(ctx);
      if (!ctx.credentialId) throw Error("UNAUTHENTICATED");
      const actor = (
        await pool.query(
          "SELECT kind FROM access_principals WHERE id=$1 AND active",
          [ctx.principalId],
        )
      ).rows[0];
      if (!actor) throw Error("UNAUTHENTICATED");
      const identity = {
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
        credentialId: ctx.credentialId,
      };
      const internal = Boolean(
        (
          await pool.query(
            "SELECT 1 FROM runtime_execution_grants WHERE credential_id=$1",
            [ctx.credentialId],
          )
        ).rowCount,
      );
      if (actor.kind === "service" || internal)
        await authority.refresh(identity);
      await transaction(pool, ctx.workspaceId, async (db) => {
        if (actor.kind === "service" || internal)
          await authority.resolve(db, identity);
        else {
          const access = await effectiveAccess(db, ctx);
          if (!access.role) throw Error("UNAUTHENTICATED");
        }
      });
    },
  };
}
export type RuntimeJobsBridge = ReturnType<typeof createRuntimeJobs>;
