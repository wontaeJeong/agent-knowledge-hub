import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { MUTATION_GATE } from "../operations/gate";
import { authorizeActionDb } from "../access/index";
import type { Context } from "../service";
import type { WorkflowAuthorizer } from "../workflows/service";
import { membership } from "../repository";
import { fingerprint } from "../provenance";
import { appendOperationalAudit } from "../operations/service";
import { selectErasureRows } from "../operations/erasure";
import { contains, inventory, unknownPrivateReference } from "./inventory";
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
    trashGraceDays: period.optional().default(null),
    draftOwners: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(100).nullable().optional().default(null),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof policySchema>;
type Kind = Exclude<keyof RetentionPolicy, "enabled" | "trashGraceDays" | "draftOwners">;
interface RecordPreview {
  kind: Kind;
  id: string;
  ownerId?: string;
  revision?: number;
  pageId?: string;
  version?: number;
  sourceId?: string;
  blobId?: string;
  contentHash?: string;
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
  trashGraceDays: null,
  draftOwners: null,
};
/** Lock the exclusive mutation gate before workspace rows, so preview and
 * effect observe a stable graph against every supported writer. */
async function retentionTransaction<T>(pool: Pool, workspaceId: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='15s'");
    await db.query("SELECT pg_advisory_xact_lock($1)",[MUTATION_GATE]);
    if (!(await db.query("SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE",[workspaceId])).rowCount) throw Error("NOT_FOUND");
    const result=await work(db); await db.query("COMMIT"); return result;
  } catch (error) {await db.query("ROLLBACK");throw error;} finally {db.release();}
}
export class ContentRetentionService {
  readonly clock: () => number;
  constructor(
    readonly pool: Pool,
    readonly authorize: WorkflowAuthorizer,
    readonly options: {
      clock?: () => number;
      /** Trusted host service guard: checks current directory/service admission and operational enablement. Never a browser identity. */
      workerGuard?: (db: PoolClient, workspaceId: string, ctx?: Context) => Promise<boolean>;
      serviceName?: string;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await retentionTransaction(this.pool, ctx.workspaceId, async (db) => {
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
    const shares = (await db.query("SELECT page_id,version FROM access_shares WHERE workspace_id=$1",[workspaceId])).rows;
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
      } else if (row.table === "storage_snapshots") {
        kind = "sourceVersions";
        at = row.data.created_at;
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
      if (kind === "drafts" && current.policy.draftOwners && !current.policy.draftOwners.includes(String(row.data.owner_id))) reasons.push("OWNER_OUTSIDE_POLICY");
      if (days === null) reasons.push("RETAIN_FOREVER");
      else if (!Number.isFinite(age)) reasons.push("AGE_UNAVAILABLE");
      else if (age < days * 86400000) reasons.push("NOT_DUE");
      const resource =
        kind === "sourceVersions"
          ? { kind: "source" as const, id: row.table === "storage_snapshots" ? String(row.data.source_id) : id }
          : kind === "publishedVersions"
            ? { kind: "page" as const, id: String(row.data.page_id) }
            : undefined;
      const dependencies = row.table === "storage_snapshots" ? rows.filter(r => {
        if (r === row || (r.table === "sources" && r.data.id === row.data.source_id) || (r.table === "storage_snapshots" && r.data.source_id === row.data.source_id) || (r.table === "storage_blobs" && r.data.parent_kind === "source" && r.data.parent_id === row.data.source_id && (r.data.id === row.data.blob_id || r.data.sha256 !== row.data.content_hash))) return false;
        return contains(r.data, String(row.data.source_id)) || contains(r.data, String(row.data.blob_id)) || contains(r.data, String(row.data.content_hash));
      }) : kind === "publishedVersions" ? rows.filter((r) => {
        if (r === row) return false;
        if (r.table === "pages" && r.data.id === row.data.page_id) return false;
        if (r.table === "versions" && r.data.page_id === row.data.page_id) return contains(r.data.data, String(row.data.page_id));
        return contains(r.data, String(row.data.page_id));
      }) : resource
        ? selectErasureRows(rows, resource).filter((r) => r !== row)
        : rows.filter((r) => {
            if (r === row) return false;
            if (kind === "drafts" && unknownPrivateReference(r)) return true;
            if (kind === "drafts" && ["board_posts","board_comments","question_turns","question_feedback","agent_outcomes","agent_personal_pages","agent_personal_revisions","agent_requests","imports"].includes(r.table)) return true;
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
      if (kind === "publishedVersions") {
        const pageId = String(row.data.page_id), version = Number(row.data.number);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(pageId) || !Number.isSafeInteger(version)) reasons.push("UNKNOWN_IDENTITY");
        if (rows.some(r => r.table === "versions" && r.data.page_id === pageId && Number(r.data.number) > version) === false) reasons.push("CURRENT_VERSION");
        if (shares.some(s => s.page_id === pageId && s.version === version)) reasons.push("RETAINED_REFERENCE");
        if (rows.some(r => unknownPrivateReference(r) || r.table === "board_posts" || r.table === "board_comments" || (["question_turns","question_feedback","agent_outcomes","agent_personal_pages","agent_personal_revisions","agent_requests"].includes(r.table) && !contains(r.data, pageId)))) reasons.push("UNKNOWN_REFERENCE");
      } else if (row.table === "storage_snapshots") {
        const sourceId=String(row.data.source_id), blobId=String(row.data.blob_id), hash=String(row.data.content_hash);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(hash)) reasons.push("UNKNOWN_IDENTITY");
        const newer=rows.some(r => r.table === "storage_snapshots" && r.data.source_id === sourceId && (new Date(String(r.data.created_at)).getTime() > new Date(String(row.data.created_at)).getTime() || (r.data.created_at === row.data.created_at && String(r.data.id) > String(row.data.id))));
        if (!newer) reasons.push("CURRENT_VERSION");
        const blob=(await db.query("SELECT parent_kind,parent_id,sha256 FROM storage_blobs WHERE workspace_id=$1 AND id=$2",[workspaceId,blobId])).rows[0];
        if (!blob || blob.parent_kind !== "source" || blob.parent_id !== sourceId || blob.sha256 !== hash) reasons.push("UNKNOWN_REFERENCE");
        const live=(await db.query(`SELECT 1 FROM storage_attachment_slots WHERE workspace_id=$1 AND head_id=$2 UNION ALL SELECT 1 FROM storage_attachment_versions WHERE workspace_id=$1 AND blob_id=$2 UNION ALL SELECT 1 FROM storage_attachment_links WHERE workspace_id=$1 AND blob_id=$2 UNION ALL SELECT 1 FROM storage_tickets WHERE workspace_id=$1 AND blob_id=$2 AND NOT revoked UNION ALL SELECT 1 FROM storage_snapshots WHERE workspace_id=$1 AND blob_id=$2 AND id<>$3 LIMIT 1`,[workspaceId,blobId,id])).rowCount;
        if (live || storage.some((ref: {sha256:string;owner_id:string}) => ref.sha256===hash && ref.owner_id!==sourceId)) reasons.push("RETAINED_REFERENCE");
        if (rows.some(r => unknownPrivateReference(r) || r.table === "board_posts" || r.table === "board_comments" || (["question_turns","question_feedback","agent_outcomes","agent_personal_pages","agent_personal_revisions","agent_requests"].includes(r.table) && !contains(r.data,sourceId)))) reasons.push("UNKNOWN_REFERENCE");
      } else if (kind !== "drafts") reasons.push("IMMUTABLE_HISTORY_REQUIRES_REVIEWED_PRUNING");
      records.push({
        kind,
        id,
        ...(kind === "publishedVersions" ? { pageId: String(row.data.page_id), version: Number(row.data.number) } : {}),
        ...(row.table === "storage_snapshots" ? {sourceId:String(row.data.source_id),blobId:String(row.data.blob_id),contentHash:String(row.data.content_hash)} : {}),
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
      shares,
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
  private async assertCandidateAccess(db: PoolClient, ctx: Context | undefined, preview: Awaited<ReturnType<ContentRetentionService["preview"]>>) {
    const eligible = preview.records.filter(r=>r.eligible);
    if (!ctx && eligible.length) throw Error("RETENTION_RESOURCE_IDENTITY_REQUIRED");
    const rows = eligible.some(r=>r.kind === "drafts") ? await inventory(db, ctx!.workspaceId) : [];
    for (const r of eligible) {
      if (r.kind === "drafts") {
        if (!ctx) throw Error("RETENTION_RESOURCE_IDENTITY_REQUIRED");
        const copies = rows.filter(x => x.data.owner_id === r.ownerId && ((x.table === "workflow_drafts" && x.data.id === r.id) || (["workflow_draft_revision_history", "workflow_draft_save_mutations"].includes(x.table) && x.data.draft_id === r.id) || (x.table === "workflow_draft_recovery_grants" && (x.data.binding as {id?:string})?.id === r.id)));
        const pending: string[] = [], sources = new Set<string>();
        for (const copy of copies) {
          const data = (copy.data.data ?? copy.data.result ?? copy.data.binding) as {pageId?:string;sourceIds?:string[];dependencyVersions?:Record<string,number>};
          if (data?.pageId) pending.push(data.pageId);
          for (const id of data?.sourceIds ?? []) sources.add(id);
          pending.push(...Object.keys(data?.dependencyVersions ?? {}));
        }
        const seen = new Set<string>();
        while (pending.length) {
          const id = pending.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id});
          const versions=rows.filter(x=>x.table==="versions" && x.data.page_id===id);
          if (!versions.length) throw Error("NOT_FOUND");
          for (const version of versions) {
            await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id,version:Number(version.data.number)});
            const data=version.data.data as {sourceIds?:string[];pageIds?:string[];provenance?:{sourceIds?:string[];pageIds?:string[]};dependencyVersions?:Record<string,number>};
            for (const source of [...(data.sourceIds ?? []),...(data.provenance?.sourceIds ?? [])]) sources.add(source);
            pending.push(...(data.pageIds ?? []),...(data.provenance?.pageIds ?? []),...Object.keys(data.dependencyVersions ?? {}));
          }
        }
        for (const id of sources) await authorizeActionDb(db,ctx,"knowledge.read",{kind:"source",id});
      }
      if (r.kind === "publishedVersions" && r.pageId && r.version) {
        if (!ctx) throw Error("RETENTION_RESOURCE_IDENTITY_REQUIRED");
        await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id:r.pageId,version:r.version});
      }
      if (r.kind === "sourceVersions" && r.sourceId) {
        if (!ctx) throw Error("RETENTION_RESOURCE_IDENTITY_REQUIRED");
        await authorizeActionDb(db,ctx,"knowledge.read",{kind:"source",id:r.sourceId});
      }
    }
  }
  private async execute(
    db: PoolClient,
    workspaceId: string,
    actor: string,
    preview: Awaited<ReturnType<ContentRetentionService["preview"]>>,
  ) {
    let deleted = 0, physicalPurgePending = 0;
    for (const r of preview.records.filter((r) => r.eligible)) {
      if (r.kind === "sourceVersions" && r.sourceId && r.blobId && r.contentHash) {
        await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'source-snapshot',$2,$3,$4,$5) ON CONFLICT DO NOTHING",[workspaceId,`${r.sourceId}/${r.contentHash}`,JSON.stringify([r.contentHash]),preview.hash,actor]);
        const removed=await db.query("DELETE FROM storage_snapshots WHERE workspace_id=$1 AND id=$2 AND blob_id=$3 RETURNING id",[workspaceId,r.id,r.blobId]);
        if (!removed.rowCount) throw Error("RETENTION_PREVIEW_STALE");
        await db.query("DELETE FROM storage_tickets WHERE workspace_id=$1 AND blob_id=$2 AND revoked",[workspaceId,r.blobId]);
        if (!(await db.query("DELETE FROM storage_blobs WHERE workspace_id=$1 AND id=$2 RETURNING id",[workspaceId,r.blobId])).rowCount) throw Error("RETENTION_PREVIEW_STALE");
        deleted++; physicalPurgePending++; continue;
      }
      if (r.kind === "publishedVersions") {
        const artifactId = `${r.pageId}/${r.version}`;
        await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'published-version',$2,'[]',$3,$4) ON CONFLICT DO NOTHING", [workspaceId,artifactId,preview.hash,actor]);
        const removed = await db.query("DELETE FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3 RETURNING number",[workspaceId,r.pageId,r.version]);
        if (!removed.rowCount) throw Error("RETENTION_PREVIEW_STALE");
        deleted++;
        continue;
      }
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
      status: deleted && !physicalPurgePending ? ("completed" as const) : ("blocked" as const),
      deleted,
      physicalPurgePending,
      allCopiesErased: false,
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
        await this.assertCandidateAccess(db,ctx,preview);
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
  /** Only a host-configured service guard may call this on the worker's already
   * fenced transaction. No network, second client or nested transaction. */
  async executeDurable(db: PoolClient, ctx: Context, expectedPolicyRevision: number) {
    if (!ctx.credentialId || !this.options.workerGuard || !(await this.options.workerGuard(db,ctx.workspaceId,ctx)))
      throw Error("RETENTION_WORKER_NOT_AUTHORIZED");
    const current=await this.current(db,ctx.workspaceId);
    if (!current.policy.enabled || current.revision!==expectedPolicyRevision) throw Error("RETENTION_POLICY_CHANGED");
    const gate=(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=0 AND objid=$1 AND mode='ExclusiveLock'",[MUTATION_GATE])).rowCount;
    if (!gate) throw Error("RETENTION_EXCLUSIVE_GATE_REQUIRED");
    const preview=await this.preview(db,ctx.workspaceId);
    await this.assertCandidateAccess(db,ctx,preview);
    return this.execute(db,ctx.workspaceId,ctx.principalId,preview);
  }
  /** Host's existing periodic coordinator calls this; no daemon, OS service or fake privileged user. */
  async retentionTick(workspaceId: string) {
    let authorized = false,
      policyRevision = 0,
      previewHash = "0".repeat(64);
    try {
      return await retentionTransaction(this.pool, workspaceId, async (db) => {
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
        await this.assertCandidateAccess(db,undefined,preview);
        return this.execute(db, workspaceId, this.options.serviceName, preview);
      });
    } catch (e) {
      if (authorized)
        await retentionTransaction(this.pool, workspaceId, async (db) => {
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
