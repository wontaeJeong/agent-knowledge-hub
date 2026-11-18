import { createHash, randomBytes, randomUUID } from "node:crypto";
import { propertyReferenceContext } from "./properties";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import type { WorkflowService } from "../workflows/service";
import type { RuntimeJobsBridge } from "../jobs/runtime";
import type { JobRun } from "../jobs/types";
import type { JobService } from "../jobs/service";
import { transaction } from "../database";
import { authorizeActionDb } from "../access";
import { loadState } from "../repository";
import { captureEnvelope, fingerprint } from "../provenance";
import { current, draftOf } from "../../src/domain/wiki";
import {
  currentMetadata,
  type RestorePlan,
} from "../workflows/versions/metadata";
import { propose } from "../publication";
import { assertProductWritesNotErased } from "../operations/product-erasure";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const input = z
  .object({
    pageIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((v) => new Set(v).size === v.length),
    operation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("tags"),
          tags: z.array(z.string().trim().min(1).max(100)).max(30),
        })
        .strict(),
      z.object({ kind: z.literal("move"), parentId: id.nullable() }).strict(),
      z.object({ kind: z.literal("archive") }).strict(),
    ]),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export const bulkPayload = z
  .object({ requestId: id, inputHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const denied = (e: unknown) =>
  e instanceof Error &&
  [
    "NOT_FOUND",
    "FORBIDDEN",
    "LEGAL_ERASURE",
    "ERASURE_PRODUCT_WRITES_FENCED",
    "SOURCE_SCOPE_CONFLICT",
  ].includes(e.message);
async function human(db: PoolClient, ctx: Context) {
  if (ctx.credentialId || ctx.agent || !ctx.authorization?.sessionId)
    throw Error("BULK_SESSION_REQUIRED");
  await ctx.authorization.assertSession(db);
  await authorizeActionDb(db, ctx, "knowledge.read");
  if (
    !(
      await db.query(
        "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
        [ctx.principalId],
      )
    ).rowCount
  )
    throw Error("UNAUTHENTICATED");
}
/** Hashes current canonical metadata, lineage, audience and complete parent chain. No source bodies retained. */
async function baseline(
  db: PoolClient,
  ctx: Context,
  pageId: string,
  patch: Record<string, unknown>,
  origin?: string,
) {
  await assertProductWritesNotErased(db, ctx.workspaceId, pageId);
  await authorizeActionDb(
    db,
    ctx,
    patch.state
      ? "lifecycle.manage"
      : patch.tags
        ? "changeset.propose"
        : "knowledge.protect",
    { kind: "page", id: pageId },
  );
  const references = patch.tags
    ? await propertyReferenceContext(db, ctx, pageId, origin)
    : null;
  const metadata =
    references?.metadata ?? (await currentMetadata(db, ctx, pageId));
  const parents: string[] = [];
  const seen = new Set([pageId]);
  for (const initial of [
    metadata.parentId,
    typeof patch.parentId === "string" ? patch.parentId : null,
  ]) {
    let next = initial;
    const chain = new Set([pageId]);
    while (next) {
      if (chain.has(next)) throw Error("VALIDATION_FAILED");
      chain.add(next);
      seen.add(next);
      parents.push(next);
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: next,
      });
      next = (await currentMetadata(db, ctx, next)).parentId;
    }
  }
  const state = references?.state ?? (await loadState(db, ctx.workspaceId)),
    envelope =
      references?.envelope ??
      (await captureEnvelope(db, ctx, state, [...seen]));
  const policy = (
    await db.query(
      "SELECT policy_version FROM access_spaces WHERE workspace_id=$1 AND active",
      [ctx.workspaceId],
    )
  ).rows[0]?.policy_version;
  const parentMetadata = await Promise.all(
    [...new Set(parents)].map((p) => currentMetadata(db, ctx, p)),
  );
  return {
    hash: fingerprint({
      metadata,
      envelope,
      policy,
      parentMetadata,
      ...(references?.relations.length
        ? { parentIds: references.parentIds }
        : {}),
    }),
    references,
    metadata,
    envelope,
    state,
    policy,
  };
}
type Item = {
  page_id: string;
  patch: Record<string, unknown>;
  baseline_hash: string | null;
  status: string;
  result: Record<string, unknown>;
  ordinal: number;
  page_ids: string[];
  source_ids: string[];
};
export class BulkDocumentService {
  constructor(
    readonly workflows: WorkflowService,
    readonly bridge?: RuntimeJobsBridge,
  ) {}
  async preview(ctx: Context, raw: unknown) {
    const d = input.parse(raw);
    await ctx.authorization?.revalidate();
    const result = await transaction(
      this.workflows.pool,
      ctx.workspaceId,
      async (db) => {
        await human(db, ctx);
        await assertProductWritesNotErased(db, ctx.workspaceId, "");
        const requestId = randomUUID(),
          token = randomBytes(32).toString("base64url"),
          expires = new Date(Date.now() + 600000);
        const patch: Record<string, unknown> =
          d.operation.kind === "tags"
            ? { tags: [...new Set(d.operation.tags)] }
            : d.operation.kind === "move"
              ? { parentId: d.operation.parentId }
              : { state: "archived" };
        const rows = [];
        for (const pageId of d.pageIds) {
          try {
            const b = await baseline(
              db,
              ctx,
              pageId,
              patch,
              this.workflows.origin,
            );
            rows.push({
              id: pageId,
              status: "ready",
              expectedRevision: b.metadata.settingsRevision,
              before:
                d.operation.kind === "tags"
                  ? { tags: b.metadata.tags }
                  : d.operation.kind === "move"
                    ? { parentId: b.metadata.parentId }
                    : { state: b.metadata.lifecycle },
              patch,
              baseline: b.hash,
              sources: b.envelope.sourceIds,
              pages: b.envelope.pageIds,
            });
          } catch (e) {
            if (
              !denied(e) &&
              !(
                e instanceof Error &&
                ["VALIDATION_FAILED", "STALE_VERSION"].includes(e.message)
              )
            )
              throw e;
            rows.push({
              id: pageId,
              status: "unavailable",
              baseline: null,
              sources: [],
              pages: [],
            });
          }
        }
        const digest = fingerprint({
          reason: d.reason,
          items: rows.map((r, ordinal) => ({
            page_id: r.id,
            ordinal,
            patch: r.patch ?? {},
            baseline_hash: r.baseline,
            source_ids: r.sources,
            page_ids: r.pages,
          })),
        });
        await db.query(
          "INSERT INTO workflow_bulk_requests(workspace_id,id,principal_id,session_id,token_hash,input_hash,reason,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ctx.workspaceId,
            requestId,
            ctx.principalId,
            ctx.authorization!.sessionId,
            hash(token),
            digest,
            d.reason,
            expires,
          ],
        );
        for (const [ordinal, r] of rows.entries())
          await db.query(
            "INSERT INTO workflow_bulk_items(workspace_id,request_id,page_id,ordinal,patch,baseline_hash,source_ids,page_ids,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              ctx.workspaceId,
              requestId,
              r.id,
              ordinal,
              r.patch ?? {},
              r.baseline,
              r.sources,
              r.pages,
              r.status === "ready" ? "pending" : "denied",
            ],
          );
        return {
          previewToken: requestId + "." + token,
          token: requestId + "." + token,
          expiresAt: expires.toISOString(),
          items: rows.map(
            ({ baseline: _, sources: __, pages: ___, ...r }) => r,
          ),
        };
      },
    );
    await ctx.authorization?.revalidate();
    return transaction(this.workflows.pool, ctx.workspaceId, async (db) => {
      await human(db, ctx);
      const items = [];
      for (const item of result.items) {
        try {
          await authorizeActionDb(db, ctx, "knowledge.read", {
            kind: "page",
            id: item.id,
          });
          if (item.status === "ready" && d.operation.kind === "tags") {
            await propertyReferenceContext(
              db,
              ctx,
              item.id,
              this.workflows.origin,
            );
          }
          items.push(item);
        } catch (e) {
          if (
            !denied(e) &&
            !(e instanceof Error && e.message === "STALE_VERSION")
          )
            throw e;
          items.push({ id: item.id, status: "unavailable" });
        }
      }
      return { ...result, items };
    });
  }
  async execute(ctx: Context, raw: unknown) {
    if (!this.bridge) throw Error("BULK_WORKER_NOT_CONFIGURED");
    const d = z
      .object({
        previewToken: z.string().max(1000).optional(),
        token: z.string().max(1000).optional(),
        mutationId: z.string().uuid().optional(),
      })
      .strict()
      .parse(raw);
    const token = d.previewToken ?? d.token;
    if (!token || (d.previewToken && d.token && d.token !== d.previewToken))
      throw Error("INVALID_BULK_PREVIEW");
    const [requestId, secret, ...extra] = token.split(".");
    if (extra.length) throw Error("INVALID_BULK_PREVIEW");
    const mutationId = d.mutationId ?? requestId;
    await ctx.authorization?.revalidate();
    const request = await transaction(
      this.workflows.pool,
      ctx.workspaceId,
      async (db) => {
        await human(db, ctx);
        const replay = (
          await db.query(
            "SELECT id FROM workflow_bulk_requests WHERE workspace_id=$1 AND principal_id=$2 AND mutation_id=$3",
            [ctx.workspaceId, ctx.principalId, mutationId],
          )
        ).rows[0];
        if (replay && replay.id !== requestId)
          throw Error("IDEMPOTENCY_CONFLICT");
        const r = (
          await db.query(
            "SELECT * FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
            [ctx.workspaceId, requestId, ctx.principalId],
          )
        ).rows[0];
        if (
          !r ||
          r.session_id !== ctx.authorization!.sessionId ||
          r.token_hash !== hash(secret ?? "")
        )
          throw Error("INVALID_BULK_PREVIEW");
        if (r.mutation_id && r.mutation_id !== mutationId)
          throw Error("IDEMPOTENCY_CONFLICT");
        if (+new Date(r.expires_at) < Date.now()) {
          const admitted =
            r.mutation_id &&
            (
              await db.query(
                "SELECT 1 FROM durable_jobs WHERE workspace_id=$1 AND principal_id=$2 AND idempotency_key=$3 AND kind='bulk' AND input->'payload'->>'requestId'=$4 AND input->'payload'->>'inputHash'=$5",
                [
                  ctx.workspaceId,
                  ctx.principalId,
                  "bulk:" + mutationId,
                  requestId,
                  r.input_hash,
                ],
              )
            ).rowCount;
          if (!admitted) throw Error("INVALID_BULK_PREVIEW");
        }
        await assertProductWritesNotErased(db, ctx.workspaceId, "");
        await db.query(
          "UPDATE workflow_bulk_requests SET mutation_id=$3 WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, requestId, mutationId],
        );
        return r;
      },
    );
    const job = await this.bridge.submitBulk(
      ctx,
      { requestId, inputHash: request.input_hash },
      "bulk:" + mutationId,
    );
    await transaction(this.workflows.pool, ctx.workspaceId, async (db) => {
      await human(db, ctx);
      await db.query(
        "UPDATE workflow_bulk_requests SET job_id=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, requestId, job.id],
      );
    });
    return { id: requestId, status: job.status };
  }
  async read(ctx: Context, requestId: string) {
    id.parse(requestId);
    await ctx.authorization?.revalidate();
    const read = () =>
      transaction(this.workflows.pool, ctx.workspaceId, async (db) => {
        await human(db, ctx);
        const r = (
          await db.query(
            `SELECT r.session_id,j.status AS job_status,j.error_code
               FROM workflow_bulk_requests r
               JOIN durable_jobs j ON j.workspace_id=r.workspace_id AND j.principal_id=r.principal_id
                 AND j.kind='bulk' AND j.idempotency_key='bulk:'||r.mutation_id
                 AND j.input->'payload'->>'requestId'=r.id AND j.input->'payload'->>'inputHash'=r.input_hash
                 AND (r.job_id IS NULL OR r.job_id=j.id)
               JOIN runtime_execution_grants g ON g.credential_id=j.credential_id
                 AND g.workspace_id=r.workspace_id AND g.principal_id=r.principal_id
                 AND g.parent_session_id=r.session_id AND g.operation='bulk' AND g.request_key=j.idempotency_key
               WHERE r.workspace_id=$1 AND r.id=$2 AND r.principal_id=$3 AND r.session_id=$4`,
            [
              ctx.workspaceId,
              requestId,
              ctx.principalId,
              ctx.authorization!.sessionId,
            ],
          )
        ).rows[0];
        if (!r || r.session_id !== ctx.authorization!.sessionId)
          throw Error("NOT_FOUND");
        const items = [];
        for (const item of (
          await db.query(
            "SELECT * FROM workflow_bulk_items WHERE workspace_id=$1 AND request_id=$2 ORDER BY ordinal",
            [ctx.workspaceId, requestId],
          )
        ).rows as Item[]) {
          try {
            await authorizeActionDb(db, ctx, "knowledge.read", {
              kind: "page",
              id: item.page_id,
            });
            await captureEnvelope(
              db,
              ctx,
              await loadState(db, ctx.workspaceId),
              [...new Set([item.page_id, ...item.page_ids])],
              item.source_ids,
            );
            items.push({
              id: item.page_id,
              status: item.status,
              ...item.result,
            });
          } catch (e) {
            if (
              !denied(e) &&
              !(e instanceof Error && e.message === "STALE_VERSION")
            )
              throw e; /* No IDs, titles or counts of currently hidden targets. */
          }
        }
        return {
          id: requestId,
          status: r.job_status,
          error: r.error_code ?? null,
          items,
        };
      });
    await read();
    await ctx.authorization?.revalidate();
    return read();
  }
}
/** Called only by runtime's bulk handler. The same-human context never escapes this executor. */
export async function executeBulk(
  workflows: WorkflowService,
  jobs: JobService,
  run: JobRun,
) {
  const payload = bulkPayload.parse(run.lease.input.payload);
  const scoped: Context = {
    workspaceId: run.ctx.workspaceId,
    principalId: run.ctx.principalId,
    authorization: {
      revalidate: run.ready,
      assertSession: async (db) => {
        await jobs.assertIdentityInTransaction(db, run.lease);
      },
    },
  };
  const check = async (db: PoolClient) => {
    await jobs.assertReadyInTransaction(db, run.lease);
    const g = (
      await db.query(
        "SELECT g.* FROM runtime_execution_grants g JOIN durable_jobs j ON j.credential_id=g.credential_id WHERE j.id=$1 AND g.operation='bulk' AND g.parent_credential_id IS NULL AND g.parent_session_id IS NOT NULL AND NOT g.revoked AND g.expires_at>clock_timestamp()",
        [run.lease.id],
      )
    ).rows[0];
    const r = (
      await db.query(
        "SELECT * FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
        [scoped.workspaceId, payload.requestId, scoped.principalId],
      )
    ).rows[0];
    if (
      !g ||
      !r ||
      g.principal_id !== scoped.principalId ||
      g.workspace_id !== scoped.workspaceId ||
      g.parent_session_id !== r.session_id ||
      r.input_hash !== payload.inputHash ||
      run.lease.input.key !== "bulk:" + r.mutation_id
    )
      throw Error("EXECUTION_SCOPE_CONFLICT");
    const frozen = (
      await db.query(
        "SELECT page_id,ordinal,patch,baseline_hash,source_ids,page_ids FROM workflow_bulk_items WHERE workspace_id=$1 AND request_id=$2 ORDER BY ordinal",
        [scoped.workspaceId, payload.requestId],
      )
    ).rows;
    if (fingerprint({ reason: r.reason, items: frozen }) !== payload.inputHash)
      throw Error("EXECUTION_SCOPE_CONFLICT");
    return r;
  };
  const items = (
    await workflows.pool.query(
      "SELECT * FROM workflow_bulk_items WHERE workspace_id=$1 AND request_id=$2 ORDER BY ordinal",
      [scoped.workspaceId, payload.requestId],
    )
  ).rows as Item[];
  for (const item of items) {
    await run.ready();
    run.signal.throwIfAborted();
    if (item.status !== "pending") continue;
    const stage = "item-" + item.ordinal;
    const save = async (
      db: PoolClient,
      status: string,
      result: Record<string, unknown>,
    ) =>
      jobs.commitEffect(db, run.lease, stage, async () => {
        await check(db);
        await assertProductWritesNotErased(
          db,
          scoped.workspaceId,
          item.page_id,
        );
        await db.query(
          "UPDATE workflow_bulk_items SET status=$4,result=$5 WHERE workspace_id=$1 AND request_id=$2 AND page_id=$3 AND status='pending'",
          [scoped.workspaceId, payload.requestId, item.page_id, status, result],
        );
        return { status };
      });
    try {
      if (item.patch.tags) {
        const prepared = await transaction(
          workflows.pool,
          scoped.workspaceId,
          async (db) => {
            const r = await check(db);
            const b = await baseline(
              db,
              scoped,
              item.page_id,
              item.patch,
              workflows.origin,
            );
            if (b.hash !== item.baseline_hash) throw Error("STALE_VERSION");
            return { r, b };
          },
        );
        const { r, b } = prepared,
          p = b.state.pages.find((p) => p.id === item.page_id)!,
          v = current(p);
        const plan: RestorePlan = {
          pageId: p.id,
          targetVersion: v.number,
          baseVersion: v.number,
          settingsRevision: b.metadata.settingsRevision,
          policyVersion: b.policy,
          fields: ["tags"],
          ...(b.references!.relationChanges && {
            relationChanges: b.references!.relationChanges,
          }),
          next: {
            ...b.metadata,
            relations: b.references!.relations,
            versions: b.references!.versions,
            tags: item.patch.tags as string[],
          },
          currentHash: fingerprint(b.metadata),
          content: v.content,
          sourceIds: v.sourceIds,
          dependencies: b.envelope.pageIds,
        };
        await propose(
          workflows.pool,
          scoped,
          [{ ...draftOf(p), links: plan.next.relations }],
          v.sourceIds,
          {
            referenceOrigin: workflows.origin,
            evolutionReason: r.reason,
            inputEnvelope: b.envelope,
            versionMetadataPlans: [plan],
            dependencyIds: b.envelope.pageIds,
            onBeforeCreate: async (db) => {
              await check(db);
              const existing = (
                await db.query(
                  "SELECT status,result FROM workflow_bulk_items WHERE workspace_id=$1 AND request_id=$2 AND page_id=$3",
                  [scoped.workspaceId, payload.requestId, item.page_id],
                )
              ).rows[0];
              if (existing?.status === "needs-review")
                return {
                  id: existing.result.batchId,
                  hash: existing.result.hash,
                };
              if (
                (
                  await baseline(
                    db,
                    scoped,
                    item.page_id,
                    item.patch,
                    workflows.origin,
                  )
                ).hash !== item.baseline_hash
              )
                throw Error("STALE_VERSION");
            },
            onCreated: async (db, result) => {
              await save(db, "needs-review", {
                batchId: result.id,
                hash: result.hash,
              });
            },
          },
        );
      } else
        await transaction(workflows.pool, scoped.workspaceId, async (db) =>
          jobs.commitEffect(db, run.lease, stage, async () => {
            const r = await check(db),
              b = await baseline(db, scoped, item.page_id, item.patch);
            if (b.hash !== item.baseline_hash) throw Error("STALE_VERSION");
            const result = await workflows.applyBulkState(
              db,
              scoped,
              item.page_id,
              {
                ...item.patch,
                expectedRevision: b.metadata.settingsRevision,
                reason: r.reason,
              },
              "bulk-" + run.lease.id + "-" + item.ordinal,
            );
            await db.query(
              "UPDATE workflow_bulk_items SET status='applied',result=$4 WHERE workspace_id=$1 AND request_id=$2 AND page_id=$3",
              [
                scoped.workspaceId,
                payload.requestId,
                item.page_id,
                { revision: result.revision },
              ],
            );
            return { status: "applied" };
          }),
        );
    } catch (e) {
      const code = e instanceof Error ? e.message : "EXECUTION_FAILED";
      if (
        !denied(e) &&
        ![
          "STALE_VERSION",
          "VALIDATION_FAILED",
          "PROPERTY_REQUIRED",
          "OFFICIAL_REVIEW_REQUIRED",
        ].includes(code)
      )
        throw e;
      await transaction(workflows.pool, scoped.workspaceId, (db) =>
        save(
          db,
          denied(e) ? "denied" : code === "STALE_VERSION" ? "stale" : "failed",
          { code: denied(e) ? "UNAVAILABLE" : code },
        ),
      );
    }
  }
  return { value: { receiptId: payload.requestId }, noModelCalls: true };
}
