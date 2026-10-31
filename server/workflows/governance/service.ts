import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { Context } from "../../service";
import {
  authorizeActionDb,
  effectiveAccess,
  type Action,
} from "../../access/index";
import type { PoolClient } from "pg";
import { transaction } from "../../database";
import { audit, loadState, membership, requireRead } from "../../repository";
import {
  captureEnvelope,
  inheritedProvenance,
  visiblePageIds,
} from "../../provenance";
import { current } from "../../../src/domain/wiki";
import { dueReviewWork } from "./due-work";
import { publicationRequirements } from "./requirements";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const reason = z.string().trim().min(1).max(2000);
const revision = z.number().int().min(0);
const ownerInput = z
  .object({ expectedRevision: revision, ownerId: id, backupId: id, reason })
  .strict()
  .refine((d) => d.ownerId !== d.backupId);
const reviewInput = z
  .object({
    expectedRevision: revision,
    assigneeIds: z.array(id).min(1).max(20),
    backupId: id,
    deadline: z.iso.datetime(),
    absentIds: z.array(id).max(20),
    reason,
  })
  .strict()
  .refine(
    (d) =>
      new Set(d.assigneeIds).size === d.assigneeIds.length &&
      !d.assigneeIds.includes(d.backupId) &&
      d.absentIds.every((i) => [...d.assigneeIds, d.backupId].includes(i)),
  );
const propertyKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((k) => !["constructor", "prototype", "__proto__"].includes(k));
function deniedOnly(error: unknown) {
  if (!(
    error instanceof Error &&
    [
      "NOT_FOUND",
      "FORBIDDEN",
      "STALE_VERSION",
      "APPROVAL_STALE",
      "LEGAL_ERASURE",
    ].includes(error.message)
  ))
    throw error;
}
const typeInput = z
  .object({
    expectedRevision: revision,
    documentType: z.string().trim().min(1).max(100),
    requiredKeys: z.array(propertyKey).max(30),
    mode: z.enum(["warn", "block"]).default("warn"),
    cadenceDays: z.number().int().min(1).max(3650).nullable().default(null),
    reason,
  })
  .strict();
export type GovernanceAuthorizer = (
  db: PoolClient,
  ctx: Context,
  action: Action,
  resource?: { kind: "page" | "source"; id: string },
) => Promise<void>;
export class GovernanceService {
  constructor(
    readonly pool: Pool,
    readonly authorize: GovernanceAuthorizer,
  ) {}
  private async run<T>(
    ctx: Context,
    action: Action,
    work: (db: PoolClient) => Promise<T>,
  ) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.human(db, ctx);
      // The injected authorizer may narrow policy, never replace canonical admission.
      await authorizeActionDb(db, ctx, action);
      await this.authorize(db, ctx, action);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async human(db: PoolClient, ctx: Context) {
    if (
      ctx.credentialId ||
      !(
        await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [ctx.principalId],
        )
      ).rowCount
    )
      throw Error("FORBIDDEN");
    const a = await effectiveAccess(db, ctx);
    if (!a.role) throw Error("NOT_FOUND");
    if (
      a.space.namespaceKind === "team" &&
      !(
        await db.query(
          "SELECT 1 FROM access_team_members WHERE team_id=$1 AND principal_id=$2 AND active",
          [a.space.namespaceId, ctx.principalId],
        )
      ).rowCount
    )
      throw Error("NOT_FOUND");
  }
  private async page(db: PoolClient, ctx: Context, pageId: string) {
    id.parse(pageId);
    await authorizeActionDb(db, ctx, "knowledge.read", {
      kind: "page",
      id: pageId,
    });
    await this.authorize(db, ctx, "knowledge.read", {
      kind: "page",
      id: pageId,
    });
    const state = await loadState(db, ctx.workspaceId);
    const visible = await visiblePageIds(db, ctx, state);
    if (!visible.has(pageId)) throw Error("NOT_FOUND");
    const seen = new Set([pageId]);
    let ancestor = pageId;
    for (;;) {
      const row = (
        await db.query(
          "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, ancestor],
        )
      ).rows[0];
      if (!row?.parent_id) break;
      ancestor = row.parent_id;
      if (seen.has(ancestor) || !visible.has(ancestor))
        throw Error("NOT_FOUND");
      seen.add(ancestor);
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: ancestor,
      });
      await this.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: ancestor,
      });
    }
    return state.pages.find((p) => p.id === pageId)!;
  }
  private async event(
    db: PoolClient,
    ctx: Context,
    kind: string,
    resourceId: string,
    rev: number,
    why: string,
    data: unknown,
  ) {
    await db.query(
      "INSERT INTO governance_events(workspace_id,kind,resource_id,revision,actor_id,reason,data) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [ctx.workspaceId, kind, resourceId, rev, ctx.principalId, why, data],
    );
    await audit(db, ctx, kind, resourceId);
  }
  async assignBusinessOwner(ctx: Context, pageId: string, input: unknown) {
    const d = ownerInput.parse(input);
    return this.run(ctx, "space.admin", async (db) => {
      await this.page(db, ctx, pageId);
      const old = (
        await db.query(
          "SELECT * FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, pageId],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== d.expectedRevision)
        throw Error("STALE_VERSION");
      for (const principalId of [d.ownerId, d.backupId]) {
        const subject = { workspaceId: ctx.workspaceId, principalId };
        await this.human(db, subject);
        await this.page(db, subject, pageId);
      }
      const next = d.expectedRevision + 1;
      await db.query(
        "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,page_id) DO UPDATE SET revision=excluded.revision,owner_id=excluded.owner_id,backup_id=excluded.backup_id,updated_at=clock_timestamp()",
        [ctx.workspaceId, pageId, next, d.ownerId, d.backupId],
      );
      await db.query(
        "UPDATE governance_handoffs SET status='resolved' WHERE workspace_id=$1 AND page_id=$2 AND status='pending'",
        [ctx.workspaceId, pageId],
      );
      await this.event(
        db,
        ctx,
        "business-owner.assign",
        pageId,
        next,
        d.reason,
        { before: old ?? null, ownerId: d.ownerId, backupId: d.backupId },
      );
      return {
        pageId,
        revision: next,
        ownerId: d.ownerId,
        backupId: d.backupId,
      };
    });
  }
  async setTypePolicy(ctx: Context, input: unknown) {
    const d = typeInput.parse(input);
    return this.run(ctx, "space.admin", async (db) => {
      const old = (
        await db.query(
          "SELECT * FROM governance_type_policies WHERE workspace_id=$1 AND document_type=$2",
          [ctx.workspaceId, d.documentType],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== d.expectedRevision)
        throw Error("STALE_VERSION");
      const next = d.expectedRevision + 1;
      await db.query(
        "INSERT INTO governance_type_policies VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,document_type) DO UPDATE SET revision=excluded.revision,required_keys=excluded.required_keys,mode=excluded.mode,cadence_days=excluded.cadence_days",
        [
          ctx.workspaceId,
          d.documentType,
          next,
          [...new Set(d.requiredKeys)],
          d.mode,
          d.cadenceDays,
        ],
      );
      await this.invalidate(db, ctx);
      await this.event(
        db,
        ctx,
        "properties.policy",
        d.documentType,
        next,
        d.reason,
        { before: old ?? null, ...d },
      );
      return { revision: next };
    });
  }
  private async invalidate(db: PoolClient, ctx: Context) {
    await db.query(
      "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
      [ctx.workspaceId],
    );
    await db.query("DELETE FROM approvals WHERE workspace_id=$1", [
      ctx.workspaceId,
    ]);
  }
  async history(ctx: Context, pageId: string) {
    return this.run(ctx, "knowledge.read", async (db) => {
      await this.page(db, ctx, pageId);
      return {
        items: (
          await db.query(
            "SELECT kind,revision,actor_id,reason,data,at FROM governance_events WHERE workspace_id=$1 AND resource_id=$2 ORDER BY id DESC",
            [ctx.workspaceId, pageId],
          )
        ).rows,
      };
    });
  }
  async workbench(ctx: Context) {
    return this.run(ctx, "knowledge.read", async (db) => {
      const a = await effectiveAccess(db, ctx);
      const state = await loadState(db, ctx.workspaceId),
        visible = await visiblePageIds(db, ctx, state);
      const pages: {
        id: string;
        title: string;
        category: string;
        version: number;
      }[] = [];
      for (const p of state.pages) {
        if (!visible.has(p.id)) continue;
        try {
          await this.page(db, ctx, p.id);
          pages.push({
            id: p.id,
            title: p.title,
            category: p.category,
            version: current(p).number,
          });
        } catch (error) {
          deniedOnly(error);
          /* Narrow current authorizer. */
        }
      }
      const owners = (
        await db.query(
          "SELECT page_id,revision,owner_id,backup_id FROM governance_business_owners WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows.filter((r) => pages.some((p) => p.id === r.page_id));
      const proposals = [];
      if (a.capabilities.includes("space.admin"))
        for (const r of (
          await db.query(
            "SELECT b.id,a.revision,a.assignee_ids,a.backup_id,a.deadline,a.absent_ids FROM batches b LEFT JOIN governance_review_assignments a ON a.workspace_id=b.workspace_id AND a.batch_id=b.id WHERE b.workspace_id=$1 AND b.data->>'status' IN ('pending','approved') ORDER BY b.id",
            [ctx.workspaceId],
          )
        ).rows) {
          try {
            const batch = await this.batch(db, ctx, r.id);
            const requirements = await publicationRequirements(
              db,
              ctx,
              batch.data.updates,
            );
            proposals.push({
              ...r,
              propertyWarnings: [
                ...requirements.warnings,
                ...requirements.blockers,
              ],
            });
          } catch (error) {
            deniedOnly(error);
            /* Private imports are not administrator content. */
          }
        }
      return {
        pages,
        owners,
        proposals,
        canManage: a.capabilities.includes("space.admin"),
        policies: a.capabilities.includes("space.admin")
          ? (
              await db.query(
                "SELECT * FROM governance_type_policies WHERE workspace_id=$1 ORDER BY document_type",
                [ctx.workspaceId],
              )
            ).rows
          : [],
      };
    });
  }
  async eligibleOwners(ctx: Context, pageId: string) {
    return this.run(ctx, "space.admin", async (db) => {
      await this.page(db, ctx, pageId);
      const a = await effectiveAccess(db, ctx);
      const candidates = (
        await db.query(
          "SELECT p.id FROM access_principals p WHERE p.active AND p.kind='human' AND (p.id=$2 OR EXISTS(SELECT 1 FROM access_team_members m WHERE m.team_id=$1 AND m.principal_id=p.id AND m.active)) ORDER BY p.id",
          [
            a.space.namespaceId,
            a.space.namespaceKind === "personal" ? ctx.principalId : "",
          ],
        )
      ).rows;
      const items = [];
      for (const c of candidates) {
        try {
          await this.page(
            db,
            { workspaceId: ctx.workspaceId, principalId: c.id },
            pageId,
          );
          items.push({ id: c.id });
        } catch (error) {
          deniedOnly(error);
          /* No implicit rights. */
        }
      }
      return { items };
    });
  }
  /** May also be invoked by the host's scheduled current-identity scan. Idempotent durable work. */
  async handoffInbox(ctx: Context) {
    return this.run(ctx, "space.admin", async (db) => {
      const due = await dueReviewWork(db, ctx);
      const rows = (
        await db.query(
          "SELECT * FROM governance_business_owners WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows;
      for (const r of rows) {
        let eligible = true;
        try {
          await this.human(db, {
            workspaceId: ctx.workspaceId,
            principalId: r.owner_id,
          });
          await this.page(
            db,
            { workspaceId: ctx.workspaceId, principalId: r.owner_id },
            r.page_id,
          );
        } catch (error) {
          deniedOnly(error);
          eligible = false;
        }
        if (eligible) continue;
        const proposals = (
          await db.query(
            "SELECT id FROM batches WHERE workspace_id=$1 AND data->>'status' IN ('pending','approved') AND EXISTS(SELECT 1 FROM jsonb_array_elements(data->'updates') u WHERE u->>'id'=$2)",
            [ctx.workspaceId, r.page_id],
          )
        ).rows.map((b) => b.id);
        const reviews = (
          await db.query(
            "SELECT batch_id FROM governance_review_assignments WHERE workspace_id=$1 AND batch_id=ANY($2::text[])",
            [ctx.workspaceId, proposals],
          )
        ).rows.map((b) => b.batch_id);
        const doc = (
          await db.query(
            "SELECT data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
            [ctx.workspaceId, r.page_id],
          )
        ).rows[0];
        const work = {
          proposalIds: proposals,
          reviewBatchIds: reviews,
          reviewDue:
            doc?.data?.reviewDue ??
            due.find((d) => d.pageId === r.page_id)?.dueAt ??
            null,
        };
        const inserted = await db.query(
          "INSERT INTO governance_handoffs(workspace_id,page_id,owner_revision,owner_id,backup_id,work) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,page_id,owner_revision) DO UPDATE SET work=excluded.work RETURNING (xmax=0) AS inserted",
          [
            ctx.workspaceId,
            r.page_id,
            r.revision,
            r.owner_id,
            r.backup_id,
            work,
          ],
        );
        if (inserted.rows[0].inserted)
          await this.event(
            db,
            ctx,
            "business-owner.handoff",
            r.page_id,
            r.revision,
            "담당자 비활성화 또는 현재 접근 해제",
            { ownerId: r.owner_id, backupId: r.backup_id },
          );
      }
      const items = [];
      for (const r of (
        await db.query(
          "SELECT * FROM governance_handoffs WHERE workspace_id=$1 AND status='pending' ORDER BY created_at",
          [ctx.workspaceId],
        )
      ).rows) {
        try {
          await this.page(db, ctx, r.page_id);
          const proposalIds: string[] = [];
          for (const batchId of r.work.proposalIds ?? []) {
            try {
              await this.batch(db, ctx, batchId);
              proposalIds.push(batchId);
            } catch (error) {
              deniedOnly(error);
              /* Never reveal a private import's existence. */
            }
          }
          items.push({
            ...r,
            work: {
              ...r.work,
              proposalIds,
              reviewBatchIds: (r.work.reviewBatchIds ?? []).filter(
                (i: string) => proposalIds.includes(i),
              ),
            },
          });
        } catch (error) {
          deniedOnly(error);
          /* Hidden pages stay hidden even to administrators. */
        }
      }
      return { items };
    });
  }
  async requestAccess(ctx: Context, input: unknown) {
    const d = z
      .object({
        resourceId: id,
        resourceType: z.literal("page").default("page"),
        reason,
      })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.read", async (db) => {
      const requestId = randomUUID();
      await db.query(
        "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,reason,resource_type) SELECT $1,$2,$3,$4,$5,$6 WHERE NOT EXISTS(SELECT 1 FROM workflow_access_requests WHERE workspace_id=$2 AND principal_id=$3 AND resource_id=$4 AND resource_type=$6 AND status='pending')",
        [
          requestId,
          ctx.workspaceId,
          ctx.principalId,
          d.resourceId,
          d.reason,
          d.resourceType,
        ],
      );
      await this.event(db, ctx, "access.request", requestId, 1, d.reason, {
        resourceType: d.resourceType,
      });
      return { accepted: true };
    });
  }
  async accessInbox(ctx: Context) {
    return this.run(ctx, "space.admin", async (db) => {
      const items = [];
      for (const r of (
        await db.query(
          "SELECT id,principal_id,resource_id,resource_type,reason,status,revision,created_at FROM workflow_access_requests WHERE workspace_id=$1 ORDER BY created_at DESC",
          [ctx.workspaceId],
        )
      ).rows) {
        if (r.resource_type !== "page") continue;
        try {
          const p = await this.page(db, ctx, r.resource_id);
          items.push({ ...r, version: current(p).number });
        } catch (error) {
          deniedOnly(error);
          /* Unknown and hidden resources have identical readback. */
        }
      }
      return { items };
    });
  }
  async decideAccess(ctx: Context, requestId: string, input: unknown) {
    id.parse(requestId);
    const d = z
      .object({
        expectedRevision: revision,
        expectedVersion: z.number().int().positive(),
        decision: z.enum(["approve", "reject"]),
        reason,
      })
      .strict()
      .parse(input);
    return this.run(ctx, "space.admin", async (db) => {
      const r = (
        await db.query(
          "SELECT * FROM workflow_access_requests WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, requestId],
        )
      ).rows[0];
      if (!r || r.resource_type !== "page") throw Error("NOT_FOUND");
      const p = await this.page(db, ctx, r.resource_id);
      if (
        r.revision !== d.expectedRevision ||
        r.status !== "pending" ||
        current(p).number !== d.expectedVersion
      )
        throw Error("STALE_VERSION");
      if (d.decision === "approve") {
        const subject = {
          workspaceId: ctx.workspaceId,
          principalId: r.principal_id,
        };
        await this.human(db, subject);
        const a = await effectiveAccess(db, subject);
        const member = await db.query(
          "SELECT 1 FROM access_team_members WHERE team_id=$1 AND principal_id=$2 AND active",
          [a.space.namespaceId, subject.principalId],
        );
        if (
          a.space.namespaceKind !== "team" ||
          !member.rowCount ||
          !a.capabilities.includes("knowledge.read")
        )
          throw Error("FORBIDDEN");
        // Actor captures complete current AND retained provenance; recipient already needs all inputs.
        const state = await loadState(db, ctx.workspaceId);
        const env = await captureEnvelope(db, ctx, state, [p.id]);
        try {
          for (const sid of env.sourceIds)
            await authorizeActionDb(db, subject, "knowledge.read", {
              kind: "source",
              id: sid,
            });
          for (const pid of env.pageIds.filter((pid) => pid !== p.id))
            await this.page(db, subject, pid);
          const ancestors = await db.query(
            "WITH RECURSIVE c AS (SELECT page_id,parent_id,ARRAY[page_id] AS visited FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2 UNION ALL SELECT w.page_id,w.parent_id,c.visited||w.page_id FROM workflow_document_state w JOIN c ON w.page_id=c.parent_id WHERE w.workspace_id=$1 AND NOT w.page_id=ANY(c.visited)) SELECT * FROM c",
            [ctx.workspaceId, p.id],
          );
          for (const row of ancestors.rows)
            if (row.parent_id) {
              if (row.visited.includes(row.parent_id)) throw Error("NOT_FOUND");
              await this.page(db, subject, row.parent_id);
            }
          for (const sid of inheritedProvenance(p).sourceIds)
            await requireRead(db, subject, "source", sid);
        } catch (error) {
          deniedOnly(error);
          throw Error("SOURCE_SCOPE_CONFLICT");
        }
        await db.query(
          "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'page',$2,$3) ON CONFLICT DO NOTHING",
          [ctx.workspaceId, p.id, r.principal_id],
        );
        await this.page(db, subject, p.id);
        await this.invalidate(db, ctx);
      }
      const policy = (
        await db.query(
          "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows[0].policy_version;
      await db.query(
        "UPDATE workflow_access_requests SET status=$3,revision=revision+1,decision_by=$4,decision_reason=$5,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
        [
          ctx.workspaceId,
          requestId,
          d.decision === "approve" ? "approved" : "rejected",
          ctx.principalId,
          d.reason,
        ],
      );
      await this.event(
        db,
        ctx,
        "access.decision",
        p.id,
        r.revision + 1,
        d.reason,
        {
          requestId,
          decision: d.decision,
          principalId: r.principal_id,
          version: d.expectedVersion,
          policyVersion: policy,
        },
      );
      return {
        id: requestId,
        revision: r.revision + 1,
        status: d.decision === "approve" ? "approved" : "rejected",
      };
    });
  }
  private async batch(db: PoolClient, ctx: Context, batchId: string) {
    id.parse(batchId);
    const row = (
      await db.query(
        "SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, batchId],
      )
    ).rows[0];
    if (
      !row ||
      !["pending", "approved"].includes(row.data.status) ||
      row.data.requestAuthorizationPending
    )
      throw Error("NOT_FOUND");
    const b = row.data;
    if (b.importRunId && b.importAuthorId !== ctx.principalId) {
      const disclosure = (
        await db.query(
          "SELECT reviewer_id FROM import_disclosures WHERE workspace_id=$1 AND run_id=$2 AND status='approved'",
          [ctx.workspaceId, b.importRunId],
        )
      ).rows[0];
      if (disclosure?.reviewer_id !== ctx.principalId) throw Error("NOT_FOUND");
    }
    const state = await loadState(db, ctx.workspaceId);
    for (const u of b.updates) {
      if (u.baseVersion > 0) await this.page(db, ctx, u.id);
      for (const sid of u.sourceIds)
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "source",
          id: sid,
        });
      const deps = u.links.filter((i: string) =>
        state.pages.some((p) => p.id === i),
      );
      await captureEnvelope(db, ctx, state, deps, u.sourceIds);
    }
    for (const snap of b.snapshots)
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "source",
        id: snap.id,
      });
    for (const dep of b.contextDependencyIds ?? [])
      await this.page(db, ctx, dep);
    return row;
  }
  private async reviewer(db: PoolClient, ctx: Context, batchId: string) {
    await this.human(db, ctx);
    await authorizeActionDb(db, ctx, "changeset.approve");
    const row = await this.batch(db, ctx, batchId),
      b = row.data;
    const author = (
      await db.query(
        "SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, batchId],
      )
    ).rows[0]?.principal_id;
    if (
      !author ||
      author === ctx.principalId ||
      b.proposedBy === ctx.principalId ||
      b.importAuthorId === ctx.principalId
    )
      throw Error("FORBIDDEN");
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
          [ctx.workspaceId, ctx.principalId],
        )
      ).rowCount
    )
      throw Error("FORBIDDEN");
    const types = (
      await db.query(
        "SELECT coalesce(p.data->>'category','연결된 지식') AS type,p.data->>'status' AS status FROM batches b CROSS JOIN LATERAL jsonb_array_elements(b.data->'updates') u LEFT JOIN pages p ON p.workspace_id=b.workspace_id AND p.id=u->>'id' WHERE b.workspace_id=$1 AND b.id=$2",
        [ctx.workspaceId, batchId],
      )
    ).rows;
    const rules = (
      await db.query(
        "SELECT reviewer_ids FROM access_review_rules WHERE workspace_id=$1 AND document_type=ANY($2::text[])",
        [
          ctx.workspaceId,
          [
            ...types.map((t) => t.type),
            ...(types.some((t) => t.status === "공식 기준")
              ? ["official-standard"]
              : []),
          ],
        ],
      )
    ).rows;
    if (rules.some((r) => !r.reviewer_ids.includes(ctx.principalId)))
      throw Error("FORBIDDEN");
  }
  async eligibleReviewers(ctx: Context, batchId: string) {
    return this.run(ctx, "space.admin", async (db) => {
      await this.batch(db, ctx, batchId);
      const items = [];
      for (const r of (
        await db.query(
          "SELECT principal_id FROM access_reviewers WHERE workspace_id=$1 ORDER BY principal_id",
          [ctx.workspaceId],
        )
      ).rows) {
        try {
          await this.reviewer(
            db,
            { workspaceId: ctx.workspaceId, principalId: r.principal_id },
            batchId,
          );
          items.push({ id: r.principal_id });
        } catch (error) {
          deniedOnly(error);
          /* Assignment never qualifies a reviewer. */
        }
      }
      return { items };
    });
  }
  async reviewHistory(ctx: Context, batchId: string) {
    return this.run(ctx, "space.admin", async (db) => {
      await this.batch(db, ctx, batchId);
      return {
        items: (
          await db.query(
            "SELECT kind,revision,actor_id,reason,at FROM governance_events WHERE workspace_id=$1 AND resource_id=$2 AND kind='review.assign' ORDER BY id DESC",
            [ctx.workspaceId, batchId],
          )
        ).rows,
      };
    });
  }
  async assignReview(ctx: Context, batchId: string, input: unknown) {
    const d = reviewInput.parse(input);
    return this.run(ctx, "space.admin", async (db) => {
      const batch = await this.batch(db, ctx, batchId);
      const old = (
        await db.query(
          "SELECT * FROM governance_review_assignments WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, batchId],
        )
      ).rows[0];
      if ((old?.revision ?? 0) !== d.expectedRevision)
        throw Error("STALE_VERSION");
      for (const principalId of [...d.assigneeIds, d.backupId])
        await this.reviewer(
          db,
          { workspaceId: ctx.workspaceId, principalId },
          batchId,
        );
      const next = d.expectedRevision + 1;
      await db.query(
        "INSERT INTO governance_review_assignments(workspace_id,batch_id,revision,batch_hash,assignee_ids,backup_id,deadline,absent_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,batch_id) DO UPDATE SET revision=excluded.revision,batch_hash=excluded.batch_hash,assignee_ids=excluded.assignee_ids,backup_id=excluded.backup_id,deadline=excluded.deadline,absent_ids=excluded.absent_ids,updated_at=clock_timestamp()",
        [
          ctx.workspaceId,
          batchId,
          next,
          batch.hash,
          d.assigneeIds,
          d.backupId,
          d.deadline,
          d.absentIds,
        ],
      );
      await db.query(
        "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, batchId],
      );
      await this.event(db, ctx, "review.assign", batchId, next, d.reason, {
        before: old ?? null,
        ...d,
      });
      return { batchId, revision: next };
    });
  }
  async reviewInbox(ctx: Context) {
    return this.run(ctx, "knowledge.read", async (db) => {
      const items = [];
      for (const r of (
        await db.query(
          "SELECT b.id,b.hash,b.data->>'status' AS status,a.revision,a.assignee_ids,a.backup_id,a.deadline,a.absent_ids,a.batch_hash FROM batches b LEFT JOIN governance_review_assignments a ON a.workspace_id=b.workspace_id AND a.batch_id=b.id WHERE b.workspace_id=$1 AND b.data->>'status' IN ('pending','approved') ORDER BY b.id",
          [ctx.workspaceId],
        )
      ).rows) {
        try {
          await this.reviewer(db, ctx, r.id);
          const batch = await this.batch(db, ctx, r.id);
          const requirements = await publicationRequirements(
            db,
            ctx,
            batch.data.updates,
          );
          items.push({
            ...r,
            propertyWarnings: [
              ...requirements.warnings,
              ...requirements.blockers,
            ],
            late: !!r.deadline && new Date(r.deadline).getTime() < Date.now(),
            absent: (r.absent_ids ?? []).includes(ctx.principalId),
            assigned: (r.assignee_ids ?? []).includes(ctx.principalId),
            stale: r.batch_hash != null && r.batch_hash !== r.hash,
          });
        } catch (error) {
          deniedOnly(error);
          /* Never expose inaccessible batch IDs, titles, or private imports. */
        }
      }
      return { items };
    });
  }
}
