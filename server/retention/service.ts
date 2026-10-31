import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../database";
import type { Context } from "../service";
import type { WorkflowAuthorizer } from "../workflows/service";
import { membership } from "../repository";
import { fingerprint } from "../provenance";
import { appendOperationalAudit } from "../operations/service";
import { selectErasureRows, type ProductRow } from "../operations/erasure";
import {
  releasedImportTables,
  releasedImportProjection,
} from "../operations/released-imports";
import { allContentReferences } from "../../scripts/k8s/operations-storage-graph.mjs";
import { draftRetirementId, replayRetentionTombstones } from "./drafts";

const period = z.number().int().min(1).max(36500).nullable();
const policySchema = z
  .object({
    enabled: z.boolean(),
    drafts: period,
    publishedVersions: period,
    sourceVersions: period,
    runtimeResults: period,
  })
  .strict();
export type RetentionPolicy = z.infer<typeof policySchema>;
type Kind = Exclude<keyof RetentionPolicy, "enabled">;
interface RecordPreview {
  kind: Kind;
  id: string;
  ownerId?: string;
  revision?: number;
  eligible: boolean;
  reasons: string[];
  retainedBy: { table: string; id: string }[];
}
const defaultPolicy: RetentionPolicy = {
  enabled: false,
  drafts: null,
  publishedVersions: null,
  sourceVersions: null,
  runtimeResults: null,
};
// The same storage/product graph classes as operations erasure, including immutable
// histories and released private imports. Unknown/new classes are never deleted.
const productTable =
  /^(sources|pages|versions|batches|requests|publications|approvals|workflow_[a-z_]+|runtime_(answers|lints|jobs)|agent_[a-z_]+|refinement_[a-z_]+|durable_(jobs|job_outbox|model_calls)|storage_(imports|import_sources|import_effects|snapshots|attachment_links)|question_[a-z_]+|version_[a-z_]+|versions_decisions|collaboration_[a-z_]+|governance_[a-z_]+)$/;
function contains(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((v) => contains(v, target));
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(([k, v]) => k === target || contains(v, target))
  );
}
async function inventory(
  db: PoolClient,
  workspaceId: string,
): Promise<ProductRow[]> {
  const columns = (
    await db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name",
    )
  ).rows;
  const tables = [...new Set<string>(columns.map((c) => c.table_name))].filter(
    (t) => productTable.test(t) || releasedImportTables.has(t),
  );
  const rows: ProductRow[] = [];
  for (const table of tables) {
    const scoped = columns.some(
      (c) => c.table_name === table && c.column_name === "workspace_id",
    );
    const jobScoped = columns.some(
      (c) => c.table_name === table && c.column_name === "job_id",
    );
    const deliveryScoped =
      table.startsWith("collaboration_") &&
      columns.some(
        (c) => c.table_name === table && c.column_name === "delivery_id",
      );
    const keyScoped = table === "agent_key_requests" && columns.some(
      (c) => c.table_name === table && c.column_name === "key_id",
    );
    if (!scoped && !jobScoped && !deliveryScoped && !keyScoped)
      throw Error("RETENTION_GRAPH_UNSUPPORTED");
    const scope = scoped
      ? "workspace_id=$1"
      : jobScoped
        ? "job_id IN(SELECT id FROM durable_jobs WHERE workspace_id=$1)"
        : deliveryScoped
          ? "delivery_id IN(SELECT id FROM collaboration_digest_outbox WHERE workspace_id=$1)"
          : "key_id IN(SELECT id FROM agent_api_keys WHERE workspace_id=$1)";
    const r = await db.query(
      `SELECT t.ctid::text AS locator,${releasedImportProjection(table) ?? "to_jsonb(t)"} AS data FROM "${table}" t WHERE ${scope} ORDER BY t.ctid LIMIT 10001`,
      [workspaceId],
    );
    rows.push(...r.rows.map((row) => ({ table, ...row })));
    if (rows.length > 10000) throw Error("RETENTION_GRAPH_BOUND");
  }
  return rows;
}
export class ContentRetentionService {
  readonly clock: () => number;
  constructor(
    readonly pool: Pool,
    readonly authorize: WorkflowAuthorizer,
    readonly options: {
      clock?: () => number;
      /** Trusted host service guard: checks current directory/service admission and operational enablement. Never a browser identity. */
      workerGuard?: (db: PoolClient, workspaceId: string) => Promise<boolean>;
      serviceName?: string;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, "space.admin");
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async current(db: PoolClient, workspaceId: string) {
    const row = (
      await db.query(
        "SELECT revision,policy FROM content_retention_policies WHERE workspace_id=$1",
        [workspaceId],
      )
    ).rows[0];
    return {
      revision: row?.revision ?? 0,
      policy: row ? policySchema.parse(row.policy) : defaultPolicy,
    };
  }
  async policy(ctx: Context) {
    return this.run(ctx, (db) => this.current(db, ctx.workspaceId));
  }
  async setPolicy(ctx: Context, input: unknown) {
    const d = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        policy: policySchema,
      })
      .strict()
      .parse(input);
    return this.run(ctx, async (db) => {
      if (
        (await this.current(db, ctx.workspaceId)).revision !==
        d.expectedRevision
      )
        throw Error("STALE_VERSION");
      await db.query(
        "INSERT INTO content_retention_policies(workspace_id,revision,policy,approved_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,policy=excluded.policy,approved_by=excluded.approved_by,updated_at=now()",
        [ctx.workspaceId, d.expectedRevision + 1, d.policy, ctx.principalId],
      );
      await appendOperationalAudit(db, ctx, { operation: "retention.policy" });
      return { revision: d.expectedRevision + 1, policy: d.policy };
    });
  }
  private async preview(db: PoolClient, workspaceId: string) {
    const current = await this.current(db, workspaceId);
    const rows = await inventory(db, workspaceId);
    const storage = (await allContentReferences(db)).filter(
      (r: { workspace_id: string }) => r.workspace_id === workspaceId,
    );
    const holds = (
      await db.query(
        "SELECT * FROM operations_legal_holds WHERE workspace_id=$1 AND active ORDER BY id",
        [workspaceId],
      )
    ).rows;
    const classHolds = (
      await db.query(
        "SELECT content_class FROM content_retention_holds WHERE workspace_id=$1 ORDER BY content_class",
        [workspaceId],
      )
    ).rows;
    const records: RecordPreview[] = [];
    const cutoff = this.clock();
    for (const row of rows) {
      let kind: Kind, at: unknown;
      if (row.table === "workflow_drafts") {
        kind = "drafts";
        at = row.data.updated_at;
      } else if (row.table === "versions") {
        kind = "publishedVersions";
        at = (row.data.data as { at?: string })?.at;
      } else if (row.table === "sources") {
        kind = "sourceVersions";
        at = (row.data.data as { createdAt?: string })?.createdAt;
      } else if (
        ["runtime_answers", "runtime_lints", "runtime_jobs"].includes(row.table)
      ) {
        kind = "runtimeResults";
        at = row.data.created_at;
      } else continue;
      const id = String(
        row.data.id ?? `${row.data.page_id}:${row.data.number}`,
      );
      const age = cutoff - new Date(String(at)).getTime();
      const days = current.policy[kind];
      const reasons: string[] = [];
      if (!current.policy.enabled) reasons.push("POLICY_DISABLED");
      if (days === null) reasons.push("RETAIN_FOREVER");
      else if (!Number.isFinite(age)) reasons.push("AGE_UNAVAILABLE");
      else if (age < days * 86400000) reasons.push("NOT_DUE");
      const resource =
        kind === "sourceVersions"
          ? { kind: "source" as const, id }
          : kind === "publishedVersions"
            ? { kind: "page" as const, id: String(row.data.page_id) }
            : undefined;
      const dependencies = resource
        ? selectErasureRows(rows, resource).filter((r) => r !== row)
        : rows.filter((r) => {
            if (r === row) return false;
            // These copies belong to this exact private draft and are retired in the
            // same transaction, not independent retained consumers. Keep them in the
            // graph for source/history protection and lawful erasure discovery.
            if (
              kind === "drafts" &&
              r.data.owner_id === row.data.owner_id &&
              (([
                "workflow_draft_revision_history",
                "workflow_draft_save_mutations",
              ].includes(r.table) &&
                r.data.draft_id === id) ||
                (r.table === "workflow_draft_recovery_grants" &&
                  (r.data.binding as { id?: string })?.id === id))
            )
              return false;
            return contains(r.data, id);
          });
      const legal =
        classHolds.some((h) => h.content_class === kind) ||
        holds.some((h) =>
          h.resource_kind === "workspace"
            ? !String(h.id).startsWith("retention-class-") ||
              h.id === `retention-class-${kind}`
            : selectErasureRows(rows, {
                kind: h.resource_kind,
                id: h.resource_id,
              }).includes(row),
        );
      if (legal) reasons.push("LEGAL_HOLD");
      if (dependencies.length) reasons.push("RETAINED_REFERENCE");
      // Immutable publication/source/refinement histories are deliberately never
      // TTL-redacted. A configured period is not a claim that they were deleted.
      if (kind !== "drafts")
        reasons.push("IMMUTABLE_HISTORY_REQUIRES_REVIEWED_PRUNING");
      records.push({
        kind,
        id,
        ...(kind === "drafts"
          ? {
              ownerId: String(row.data.owner_id),
              revision: Number(row.data.revision),
            }
          : {}),
        eligible: reasons.length === 0,
        reasons,
        retainedBy: dependencies.map((r) => ({
          table: r.table,
          id: String(r.data.id ?? r.data.page_id ?? r.locator),
        })),
      });
    }
    const counts = {
      eligible: records.filter((r) => r.eligible).length,
      blocked: records.filter((r) => !r.eligible).length,
      drafts: records.filter((r) => r.kind === "drafts").length,
      publishedVersions: records.filter((r) => r.kind === "publishedVersions")
        .length,
      sourceVersions: records.filter((r) => r.kind === "sourceVersions").length,
      runtimeResults: records.filter((r) => r.kind === "runtimeResults").length,
      storageReferences: storage.length,
    };
    // Includes actual reference rows, including newly arrived/out-of-order jobs.
    // Excludes wall-clock milliseconds: only eligibility boundary transitions matter.
    const hash = fingerprint({
      current,
      rows,
      storage,
      holds,
      classHolds,
      records,
    });
    return {
      hash,
      policyRevision: current.revision,
      policy: current.policy,
      counts,
      records,
    };
  }
  async previewRetention(ctx: Context) {
    return this.run(ctx, (db) => this.preview(db, ctx.workspaceId));
  }
  private async execute(
    db: PoolClient,
    workspaceId: string,
    actor: string,
    preview: Awaited<ReturnType<ContentRetentionService["preview"]>>,
  ) {
    let deleted = 0;
    for (const r of preview.records.filter((r) => r.eligible)) {
      const removed = await db.query(
        "DELETE FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3 AND revision=$4 RETURNING id",
        [workspaceId, r.ownerId, r.id, r.revision],
      );
      if (!removed.rowCount) throw Error("RETENTION_PREVIEW_STALE");
      await db.query(
        "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'draft',$2,'[]',$3,$4) ON CONFLICT DO NOTHING",
        [workspaceId, draftRetirementId(r.ownerId!, r.id), preview.hash, actor],
      );
      await db.query(
        "DELETE FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [workspaceId, r.ownerId, r.id],
      );
      await db.query(
        "DELETE FROM workflow_draft_save_mutations WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [workspaceId, r.ownerId, r.id],
      );
      await db.query(
        "DELETE FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2 AND binding->>'id'=$3",
        [workspaceId, r.ownerId, r.id],
      );
      deleted++;
    }
    const receipt = {
      id: randomUUID(),
      status: deleted ? ("completed" as const) : ("blocked" as const),
      deleted,
      blocked: preview.counts.blocked,
      previewHash: preview.hash,
      policyRevision: preview.policyRevision,
    };
    await db.query(
      "INSERT INTO content_retention_receipts(workspace_id,id,preview_hash,policy_revision,status,actor,details) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        workspaceId,
        receipt.id,
        preview.hash,
        preview.policyRevision,
        receipt.status,
        actor,
        receipt,
      ],
    );
    await appendOperationalAudit(
      db,
      { workspaceId, principalId: actor },
      { operation: "retention.execute" },
    );
    return receipt;
  }
  async executeRetention(ctx: Context, input: unknown) {
    const d = z
      .object({
        previewHash: z.string().regex(/^[a-f0-9]{64}$/),
        policyRevision: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    let authorized = false;
    try {
      return await this.run(ctx, async (db) => {
        authorized = true;
        const preview = await this.preview(db, ctx.workspaceId);
        if (preview.policyRevision !== d.policyRevision)
          throw Error("STALE_VERSION");
        if (preview.hash !== d.previewHash)
          throw Error("RETENTION_PREVIEW_STALE");
        return this.execute(db, ctx.workspaceId, ctx.principalId, preview);
      });
    } catch (e) {
      // Business changes and tombstones roll back together. Record the failed
      // attempt separately only after fresh authorization; never log raw content.
      if (authorized)
        await this.run(ctx, async (db) => {
          await db.query(
            "INSERT INTO content_retention_receipts(workspace_id,id,preview_hash,policy_revision,status,actor,details) VALUES($1,$2,$3,$4,'failed',$5,$6)",
            [
              ctx.workspaceId,
              randomUUID(),
              d.previewHash,
              d.policyRevision,
              ctx.principalId,
              {
                code:
                  e instanceof Error &&
                  [
                    "STALE_VERSION",
                    "RETENTION_PREVIEW_STALE",
                    "RETENTION_GRAPH_BOUND",
                  ].includes(e.message)
                    ? e.message
                    : "RETENTION_EXECUTION_FAILED",
              },
            ],
          );
        });
      throw e;
    }
  }
  async setHold(ctx: Context, input: unknown) {
    const d = z
      .object({
        contentClass: z.enum([
          "drafts",
          "publishedVersions",
          "sourceVersions",
          "runtimeResults",
        ]),
        enabled: z.boolean(),
        reason: z.string().trim().min(1).max(2000),
        expectedPolicyRevision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    return this.run(ctx, async (db) => {
      if (
        (await this.current(db, ctx.workspaceId)).revision !==
        d.expectedPolicyRevision
      )
        throw Error("STALE_VERSION");
      if (d.enabled)
        await db.query(
          "INSERT INTO content_retention_holds(workspace_id,content_class,reason,placed_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,content_class) DO UPDATE SET reason=excluded.reason,placed_by=excluded.placed_by",
          [ctx.workspaceId, d.contentClass, d.reason, ctx.principalId],
        );
      else
        await db.query(
          "DELETE FROM content_retention_holds WHERE workspace_id=$1 AND content_class=$2",
          [ctx.workspaceId, d.contentClass],
        );
      // Existing signed off-database recovery ledger already carries operational
      // holds. Mirror a conservative workspace hold so an older restored class
      // table cannot silently lose a newly placed legal obligation. Releasing
      // this mirror never releases independently placed source/page holds.
      if (d.enabled)
        await db.query(
          "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,active,placed_by) VALUES($1,$2,'workspace',$1,true,$3) ON CONFLICT(workspace_id,id) DO UPDATE SET active=true,placed_by=excluded.placed_by",
          [
            ctx.workspaceId,
            `retention-class-${d.contentClass}`,
            ctx.principalId,
          ],
        );
      else
        await db.query(
          "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, `retention-class-${d.contentClass}`],
        );
      await appendOperationalAudit(db, ctx, {
        operation: d.enabled
          ? "retention.hold.place"
          : "retention.hold.release",
      });
      return { contentClass: d.contentClass, enabled: d.enabled };
    });
  }
  /** Host's existing periodic coordinator calls this; no daemon, OS service or fake privileged user. */
  async retentionTick(workspaceId: string) {
    let authorized = false,
      policyRevision = 0,
      previewHash = "0".repeat(64);
    try {
      return await transaction(this.pool, workspaceId, async (db) => {
        const current = await this.current(db, workspaceId);
        if (!current.policy.enabled) return { status: "disabled" as const };
        if (
          !this.options.serviceName ||
          !this.options.workerGuard ||
          !(await this.options.workerGuard(db, workspaceId))
        )
          throw Error("RETENTION_WORKER_NOT_AUTHORIZED");
        authorized = true;
        policyRevision = current.revision;
        const preview = await this.preview(db, workspaceId);
        previewHash = preview.hash;
        return this.execute(db, workspaceId, this.options.serviceName, preview);
      });
    } catch (e) {
      if (authorized)
        await transaction(this.pool, workspaceId, async (db) => {
          if (
            !this.options.workerGuard ||
            !(await this.options.workerGuard(db, workspaceId))
          )
            throw Error("RETENTION_WORKER_NOT_AUTHORIZED");
          await db.query(
            "INSERT INTO content_retention_receipts(workspace_id,id,preview_hash,policy_revision,status,actor,details) VALUES($1,$2,$3,$4,'failed',$5,$6)",
            [
              workspaceId,
              randomUUID(),
              previewHash,
              policyRevision,
              this.options.serviceName,
              {
                code: "RETENTION_EXECUTION_FAILED",
                previewAvailable: previewHash !== "0".repeat(64),
              },
            ],
          );
        });
      throw e;
    }
  }
  async receipts(ctx: Context) {
    return this.run(ctx, async (db) => ({
      items: (
        await db.query(
          "SELECT id,preview_hash,policy_revision,status,actor,details,created_at FROM content_retention_receipts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 500",
          [ctx.workspaceId],
        )
      ).rows,
    }));
  }
  async replayRetirements(db: PoolClient, workspaceId: string) {
    return replayRetentionTombstones(db, workspaceId);
  }
}
