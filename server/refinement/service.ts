import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type {
  WorkflowAuthorizer,
  WorkflowResource,
} from "../workflows/service";
import { transaction } from "../database";
import { audit, loadState, membership, requireRead } from "../repository";
import { visiblePageIds } from "../provenance";
import { digest } from "../publication";
import {
  claimInput,
  evidenceInput,
  id,
  conditions,
  compareClaims,
  lineageRoots,
  selectContext,
  type Claim,
  type Evidence,
} from "./logic";
import type { SemanticLintProvider } from "./semantic";
import { assertSafeModelInput, validateFindings } from "./semantic";

const contextInput = z
  .object({
    asOf: z.iso.datetime().optional(),
    environment: conditions,
    pageIds: z.array(id).max(100).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    includeHistory: z.boolean().default(false),
  })
  .strict();
const outcomeInput = z
  .object({
    id,
    claimIds: z.array(id).min(1).max(100),
    usedVersions: z
      .array(
        z.object({ pageId: id, version: z.number().int().positive() }).strict(),
      )
      .min(1)
      .max(100),
    result: z.enum(["success", "partial", "failure", "unknown"]),
    problem: z.string().min(1).max(5000),
    attempt: z.string().min(1).max(10000),
    observations: z.string().min(1).max(10000),
    conditions,
    evidenceIds: z.array(id).max(100),
    lesson: z.string().min(1).max(5000),
    limits: z.string().min(1).max(5000),
  })
  .strict();
type Outcome = z.infer<typeof outcomeInput> & {
  humanValidation: "unreviewed" | "confirmed" | "rejected";
  recordedAt: string;
  recordedBy: string;
};
type Request = {
  id: string;
  claimIds: string[];
  reason: string;
  status: "pending-review";
  recordedAt: string;
  recordedBy: string;
  agentOutcomeId?: string;
  outcomeId?: string;
  usedVersions?: { page_id: string; version: number }[];
  rootLineage?: { sourceId: string }[];
  [key: string]: unknown;
};
type ClaimReview = {
  id: string;
  kind: "review";
  claimIds: string[];
  evidenceIds: string[];
  status: "reviewed" | "execution-verified" | "rejected";
  verifiedAt: string;
  recordedAt: string;
  recordedBy: string;
};
const tables = {
  evidence: "refinement_evidence",
  claims: "refinement_claims",
  outcomes: "refinement_outcomes",
  requests: "refinement_requests",
  reviews: "refinement_reviews",
} as const;
type Table = keyof typeof tables;

/** No live wiki mutation: every refinement is an immutable observation + durable review request. */
export class RefinementService {
  constructor(
    readonly pool: Pool,
    readonly authorize: WorkflowAuthorizer,
    readonly provider?: SemanticLintProvider,
  ) {
    if (typeof authorize !== "function") throw Error("AUTHORIZER_REQUIRED");
  }
  private async run<T>(
    ctx: Context,
    action: string,
    resource: WorkflowResource | undefined,
    work: (db: PoolClient) => Promise<T>,
  ) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action, resource);
      const r = await work(db);
      await ctx.authorization?.assertSession(db);
      return r;
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async all<T>(
    db: PoolClient,
    ctx: Context,
    table: Table,
  ): Promise<T[]> {
    return (
      await db.query(
        `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 ORDER BY id`,
        [ctx.workspaceId],
      )
    ).rows.map((r) => r.data);
  }
  private async get<T>(
    db: PoolClient,
    ctx: Context,
    table: Table,
    key: string,
  ): Promise<T> {
    const r = await db.query(
      `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, id.parse(key)],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    return r.rows[0].data;
  }
  private async put<T extends { id: string }>(
    db: PoolClient,
    ctx: Context,
    table: Table,
    value: T,
  ): Promise<T> {
    const old = await db.query(
      `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, value.id],
    );
    if (old.rowCount) {
      const { recordedAt: _, recordedBy: __, ...prior } = old.rows[0].data;
      const {
        recordedAt: ___,
        recordedBy: ____,
        ...next
      } = value as T & { recordedAt?: string; recordedBy?: string };
      if (table === "reviews") {
        delete prior.verifiedAt;
        delete (next as Record<string, unknown>).verifiedAt;
      }
      if (digest(prior) !== digest(next)) throw Error("IDEMPOTENCY_CONFLICT");
      return old.rows[0].data;
    }
    await db.query(`INSERT INTO ${tables[table]} VALUES($1,$2,$3)`, [
      ctx.workspaceId,
      value.id,
      value,
    ]);
    await audit(db, ctx, `refinement.${table}.create`, value.id);
    return value;
  }
  private stamp(ctx: Context) {
    return {
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.principalId,
    };
  }
  async sourceSnapshot(ctx: Context, input: unknown) {
    const d = z.object({ sourceId: id }).strict().parse(input);
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "source", id: d.sourceId },
      async (db) => {
        const source = await this.source(db, ctx, d.sourceId);
        return {
          id: d.sourceId,
          title: source.title,
          content: source.content,
          sourceVersion: digest(source),
        };
      },
    );
  }
  private async page(
    db: PoolClient,
    ctx: Context,
    pageId: string,
    version: number,
  ) {
    await this.authorize(db, ctx, "knowledge.read", {
      kind: "page",
      id: pageId,
    });
    const state = await loadState(db, ctx.workspaceId);
    if (!(await visiblePageIds(db, ctx, state)).has(pageId))
      throw Error("NOT_FOUND");
    const page = state.pages.find((p) => p.id === pageId),
      v = page?.versions.find((v) => v.number === version);
    if (!v) throw Error("NOT_FOUND");
    for (const sourceId of v.sourceIds) await this.source(db, ctx, sourceId);
    return { page: page!, version: v };
  }
  private async source(db: PoolClient, ctx: Context, sourceId: string) {
    await this.authorize(db, ctx, "knowledge.read", {
      kind: "source",
      id: sourceId,
    });
    await requireRead(db, ctx, "source", sourceId);
    const r = await db.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, sourceId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    return r.rows[0].data;
  }
  private async evidence(
    db: PoolClient,
    ctx: Context,
    evidenceId: string,
    seen = new Set<string>(),
    checked = new Map<string, Evidence>(),
  ): Promise<Evidence> {
    if (seen.has(evidenceId)) throw Error("CIRCULAR_EVIDENCE");
    if (checked.has(evidenceId)) return checked.get(evidenceId)!;
    if (seen.size >= 256) throw Error("EVIDENCE_DEPTH_LIMIT");
    const e = await this.get<Evidence>(db, ctx, "evidence", evidenceId),
      next = new Set(seen).add(evidenceId);
    if (e.sourceId) await this.source(db, ctx, e.sourceId);
    for (const p of e.parentIds) await this.evidence(db, ctx, p, next, checked);
    checked.set(evidenceId, e);
    return e;
  }
  private async claim(
    db: PoolClient,
    ctx: Context,
    claimId: string,
    checked = new Map<string, Claim>(),
    seen = new Set<string>(),
  ): Promise<Claim> {
    if (seen.has(claimId)) throw Error("CIRCULAR_EVIDENCE");
    if (checked.has(claimId)) return checked.get(claimId)!;
    if (seen.size >= 256) throw Error("EVIDENCE_DEPTH_LIMIT");
    const next = new Set(seen).add(claimId);
    const c = await this.get<Claim>(db, ctx, "claims", claimId);
    await this.page(db, ctx, c.pageId, c.pageVersion);
    for (const eid of c.evidenceIds) await this.evidence(db, ctx, eid);
    for (const parent of c.supersedes) {
      // Claims only point to already-existing immutable ancestors.
      await this.claim(db, ctx, parent, checked, next);
    }
    checked.set(claimId, c);
    return c;
  }
  private async request(
    db: PoolClient,
    ctx: Context,
    claimIds: string[],
    reason: string,
    key: string,
    extra: Record<string, unknown> = {},
  ) {
    return this.put(db, ctx, "requests", {
      ...extra,
      id: key,
      claimIds,
      reason,
      status: "pending-review" as const,
      ...this.stamp(ctx),
    });
  }
  async addEvidence(ctx: Context, input: unknown) {
    const d = evidenceInput.parse(input);
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      if (d.parentIds.includes(d.id)) throw Error("CIRCULAR_EVIDENCE");
      if (d.verifiedAt !== null) throw Error("VERIFICATION_REQUIRES_REVIEW");
      if (d.kind === "review") throw Error("REVIEW_REQUIRES_HUMAN");
      if (
        d.kind === "independent-execution" &&
        (!d.executionId || d.parentIds.length || !d.sourceId)
      )
        throw Error("EVIDENCE_INVALID");
      if (
        (d.kind === "inference" || d.kind === "hypothesis") &&
        !d.parentIds.length
      )
        throw Error("EVIDENCE_MISSING");
      let root: string | null = null;
      if (d.sourceId) {
        const source = await this.source(db, ctx, d.sourceId),
          loc = d.location;
        if (
          d.sourceVersion !== digest(source) ||
          !loc ||
          loc.end <= loc.start ||
          source.content.slice(loc.start, loc.end) !== loc.quote
        )
          throw Error("EVIDENCE_INVALID");
        // Conservative content fingerprint: duplicate source imports are not independent support.
        if (!d.parentIds.length) root = `source:${digest(source.content)}`;
      } else if (d.sourceVersion || d.location) throw Error("EVIDENCE_INVALID");
      if (!root && !d.parentIds.length) throw Error("EVIDENCE_MISSING");
      for (const parent of d.parentIds) await this.evidence(db, ctx, parent);
      const e: Evidence = { ...d, root, ...this.stamp(ctx) };
      lineageRoots(
        [
          ...(await this.all<Evidence>(db, ctx, "evidence")).filter(
            (e) => e.id !== d.id,
          ),
          e,
        ],
        e.id,
      );
      return this.put(db, ctx, "evidence", e);
    });
  }
  async addClaim(ctx: Context, input: unknown) {
    const d = claimInput.parse(input);
    return this.run(
      ctx,
      "changeset.propose",
      { kind: "page", id: d.pageId },
      async (db) => {
        await this.page(db, ctx, d.pageId, d.pageVersion);
        if (d.verifiedAt !== null) throw Error("VERIFICATION_REQUIRES_REVIEW");
        if (d.supersedes.includes(d.id)) throw Error("CIRCULAR_EVIDENCE");
        if (d.protected) {
          if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
          await this.authorize(db, ctx, "knowledge.protect", {
            kind: "page",
            id: d.pageId,
          });
        }
        for (const oldId of d.supersedes) {
          const old = await this.claim(db, ctx, oldId);
          if (old.protected) {
            if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
            await this.authorize(db, ctx, "knowledge.protect", {
              kind: "page",
              id: old.pageId,
            });
          }
        }
        for (const eid of d.evidenceIds) await this.evidence(db, ctx, eid);
        const result = await this.put(db, ctx, "claims", {
          ...d,
          ...this.stamp(ctx),
        });
        await this.request(
          db,
          ctx,
          [d.id, ...d.supersedes],
          d.supersedes.length ? "supersession" : "new-evidence",
          `claim_${d.id}`,
        );
        return result;
      },
    );
  }
  async context(ctx: Context, input: unknown) {
    const d = contextInput.parse(input);
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const all = await this.all<Claim>(db, ctx, "claims"),
        visible: Claim[] = [];
      for (const c of all) {
        if (d.pageIds && !d.pageIds.includes(c.pageId)) continue;
        try {
          await this.claim(db, ctx, c.id);
          visible.push(c);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      const asOf = d.asOf ?? new Date().toISOString(),
        selected = selectContext(visible, asOf, d.environment);
      const candidates = d.includeHistory ? visible : selected.items;
      const items = [];
      const allEvidence = await this.all<Evidence>(db, ctx, "evidence");
      const reviews = await this.all<ClaimReview>(db, ctx, "reviews");
      for (const c of candidates.slice(0, d.limit)) {
        const lineage = new Map<string, Evidence>();
        const collect = async (eid: string): Promise<void> => {
          if (lineage.has(eid)) return;
          const e = await this.evidence(db, ctx, eid);
          lineage.set(eid, e);
          for (const parent of e.parentIds) await collect(parent);
        };
        for (const eid of c.evidenceIds) await collect(eid);
        const evidence = [...lineage.values()];
        const verificationReviews: ClaimReview[] = [];
        for (const r of reviews
          .filter((r) => r.claimIds?.includes(c.id))
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)))
          try {
            for (const cid of r.claimIds) await this.claim(db, ctx, cid);
            for (const e of r.evidenceIds) await this.evidence(db, ctx, e);
            verificationReviews.push(r);
          } catch (e) {
            if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
          }
        items.push({
          ...c,
          evidence,
          independentRoots: [
            ...new Set(
              c.evidenceIds.flatMap((e) => lineageRoots(allEvidence, e)),
            ),
          ],
          verificationReviews,
          validation: verificationReviews.at(-1)?.status ?? "unverified",
          authority: "review-candidate" as const,
          validAtRequestedTime: selected.items.some((s) => s.id === c.id),
          missingConditions: Object.keys(c.conditions).filter(
            (k) => d.environment[k] === undefined,
          ),
        });
      }
      const conflicts = [];
      for (let i = 0; i < items.length; i++)
        for (const b of items.slice(i + 1)) {
          const a = items[i],
            kind = compareClaims(a, b);
          if (kind !== "unrelated" && kind !== "agreement")
            conflicts.push({
              claimIds: [a.id, b.id],
              kind,
              resolution: "review-required",
            });
        }
      return {
        asOf,
        acl: "current" as const,
        temporalMode: d.includeHistory
          ? "history-not-current-recommendation"
          : "as-of",
        items,
        conflicts,
        unknownTime: selected.unknownTime,
        omitted: Math.max(0, candidates.length - items.length),
        more: "POST /api/v1/refinement/context with pageIds/limit; all evidence and exceptions stay intact",
      };
    });
  }
  async reportOutcome(ctx: Context, input: unknown) {
    const d = outcomeInput.parse(input);
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const claims = await Promise.all(
        d.claimIds.map((c) => this.claim(db, ctx, c)),
      );
      for (const v of d.usedVersions)
        await this.page(db, ctx, v.pageId, v.version);
      if (
        claims.some(
          (c) =>
            !d.usedVersions.some(
              (v) => v.pageId === c.pageId && v.version === c.pageVersion,
            ),
        )
      )
        throw Error("STALE_VERSION");
      for (const e of d.evidenceIds) await this.evidence(db, ctx, e);
      const result = await this.put(db, ctx, "outcomes", {
        ...d,
        humanValidation: "unreviewed" as const,
        ...this.stamp(ctx),
      });
      await this.request(db, ctx, d.claimIds, "outcome", `outcome_${d.id}`, {
        outcomeId: d.id,
        result: d.result,
        uncertainty: "단일 사례; 일반화 및 실제 성공은 별도 검증 필요",
      });
      return result;
    });
  }
  async reviewOutcome(ctx: Context, input: unknown) {
    const d = z
      .object({
        id,
        outcomeId: id,
        status: z.enum(["confirmed", "rejected"]),
        evidenceIds: z.array(id).min(1).max(100),
        reason: z.string().min(1).max(5000),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.protect", undefined, async (db) => {
      if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
      const o = await this.get<Outcome>(db, ctx, "outcomes", d.outcomeId);
      if (o.recordedBy === ctx.principalId)
        throw Error("INDEPENDENT_REVIEW_REQUIRED");
      for (const v of o.usedVersions)
        await this.page(db, ctx, v.pageId, v.version);
      for (const c of o.claimIds) await this.claim(db, ctx, c);
      for (const e of [...o.evidenceIds, ...d.evidenceIds])
        await this.evidence(db, ctx, e);
      return this.put(db, ctx, "reviews", {
        ...d,
        kind: "review",
        verifiedAt: new Date().toISOString(),
        ...this.stamp(ctx),
      });
    });
  }
  async reviewClaim(ctx: Context, input: unknown) {
    const d = z
      .object({
        id,
        claimIds: z.array(id).min(1).max(100),
        status: z.enum(["reviewed", "execution-verified", "rejected"]),
        evidenceIds: z.array(id).min(1).max(100),
        reason: z.string().min(1).max(5000),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.protect", undefined, async (db) => {
      if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
      for (const cid of d.claimIds) {
        const c = await this.claim(db, ctx, cid);
        await this.authorize(db, ctx, "knowledge.protect", {
          kind: "page",
          id: c.pageId,
        });
        if (c.recordedBy === ctx.principalId)
          throw Error("INDEPENDENT_REVIEW_REQUIRED");
      }
      const evidence = await Promise.all(
        d.evidenceIds.map((e) => this.evidence(db, ctx, e)),
      );
      if (
        d.status === "execution-verified" &&
        !evidence.some(
          (e) =>
            e.kind === "independent-execution" &&
            !e.parentIds.length &&
            e.executionId,
        )
      )
        throw Error("INDEPENDENT_EXECUTION_REQUIRED");
      return this.put(db, ctx, "reviews", {
        ...d,
        kind: "review" as const,
        verifiedAt: new Date().toISOString(),
        ...this.stamp(ctx),
      });
    });
  }
  async outcomes(ctx: Context) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await this.all<Outcome>(db, ctx, "outcomes"),
        reviews = await this.all<{
          outcomeId: string;
          status: "confirmed" | "rejected";
          evidenceIds: string[];
          recordedAt: string;
        }>(db, ctx, "reviews"),
        items = [];
      for (const o of rows)
        try {
          for (const c of o.claimIds) await this.claim(db, ctx, c);
          for (const e of o.evidenceIds) await this.evidence(db, ctx, e);
          for (const v of o.usedVersions)
            await this.page(db, ctx, v.pageId, v.version);
          const r = reviews
            .filter((r) => r.outcomeId === o.id)
            .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
          for (const review of r)
            for (const e of review.evidenceIds) await this.evidence(db, ctx, e);
          items.push({
            ...o,
            humanValidation: r.at(-1)?.status ?? "unreviewed",
            reviews: r,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return { items };
    });
  }
  async requests(ctx: Context) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await this.all<Request>(db, ctx, "requests"),
        items = [];
      for (const r of rows)
        try {
          const roots: Array<{
            sourceId: string;
            sourceVersion?: string;
            location?: unknown;
            root?: string | null;
          }> = [...(r.rootLineage ?? [])];
          const seen = new Set<string>();
          const collect = async (eid: string): Promise<void> => {
            if (seen.has(eid)) return;
            seen.add(eid);
            const e = await this.evidence(db, ctx, eid);
            if (e.sourceId)
              roots.push({
                sourceId: e.sourceId,
                sourceVersion: e.sourceVersion,
                location: e.location,
                root: e.root,
              });
            for (const p of e.parentIds) await collect(p);
          };
          for (const cid of r.claimIds) {
            const c = await this.claim(db, ctx, cid);
            for (const eid of c.evidenceIds) await collect(eid);
          }
          for (const v of r.usedVersions ?? [])
            await this.page(db, ctx, v.page_id, v.version);
          for (const root of r.rootLineage ?? [])
            await this.source(db, ctx, root.sourceId);
          if (r.agentOutcomeId)
            await this.agentOutcome(db, ctx, r.agentOutcomeId);
          if (r.outcomeId) {
            const o = await this.get<Outcome>(db, ctx, "outcomes", r.outcomeId);
            for (const c of o.claimIds) await this.claim(db, ctx, c);
            for (const e of o.evidenceIds) await collect(e);
            for (const v of o.usedVersions)
              await this.page(db, ctx, v.pageId, v.version);
          }
          items.push({
            ...r,
            rootLineage: [
              ...new Map(roots.map((root) => [digest(root), root])).values(),
            ],
          } as Request);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return { items };
    });
  }
  private async agentOutcome(db: PoolClient, ctx: Context, outcomeId: string) {
    const row = await db.query(
      "SELECT data,principal_id,result FROM agent_outcomes WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, id.parse(outcomeId)],
    );
    if (!row.rowCount) throw Error("NOT_FOUND");
    // Parse the common store's contract rather than trusting arbitrary historical JSON.
    const d = z
      .object({
        used_versions: z
          .array(
            z
              .object({ page_id: id, version: z.number().int().positive() })
              .strict(),
          )
          .min(1)
          .max(100),
        result: z.enum(["success", "failure", "unknown"]),
        observations: z.string().min(1).max(100000),
        evidence: z
          .array(
            z
              .object({
                id,
                version: z.literal(1),
                location: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(100),
        idempotency_key: z.string().max(200),
        verified: z.literal(false),
        evidenceKind: z.literal("agent-observation"),
        independentExecution: z.literal(false),
      })
      .strict()
      .parse(row.rows[0].data);
    if (row.rows[0].result !== d.result) throw Error("EVIDENCE_INVALID");
    const roots = new Map<
      string,
      {
        sourceId: string;
        version: 1;
        sourceVersion: string;
        location: string;
        root: string;
      }
    >();
    for (const v of d.used_versions) {
      const p = await this.page(db, ctx, v.page_id, v.version);
      for (const sid of p.version.sourceIds) {
        const s = await this.source(db, ctx, sid);
        roots.set(sid, {
          sourceId: sid,
          version: 1,
          sourceVersion: digest(s),
          location: "content",
          root: `source:${digest(s.content)}`,
        });
      }
    }
    for (const ref of d.evidence) {
      const s = await this.source(db, ctx, ref.id);
      if (
        ref.location !== "content" &&
        !(
          ref.location.startsWith("quote:") &&
          ref.location.length > 6 &&
          s.content.includes(ref.location.slice(6))
        )
      )
        throw Error("EVIDENCE_INVALID");
      roots.set(ref.id, {
        sourceId: ref.id,
        version: 1,
        sourceVersion: digest(s),
        location: ref.location,
        root: `source:${digest(s.content)}`,
      });
    }
    return {
      ...d,
      reportedBy: row.rows[0].principal_id,
      rootLineage: [...roots.values()].sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId),
      ),
    };
  }
  /** Task5 common outcome store -> durable, deduplicated, never auto-verified review proposals. */
  async importAgentSignals(ctx: Context) {
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const signals = await db.query(
        "SELECT id,page_id,outcome_id FROM agent_review_signals WHERE workspace_id=$1 AND state='pending' ORDER BY outcome_id,id LIMIT 1000",
        [ctx.workspaceId],
      );
      const imported: string[] = [];
      for (const outcomeId of [
        ...new Set<string>(signals.rows.map((r) => r.outcome_id)),
      ])
        try {
          const d = await this.agentOutcome(db, ctx, outcomeId),
            linked = signals.rows.filter((s) => s.outcome_id === outcomeId);
          if (
            linked.some(
              (s) => !d.used_versions.some((v) => v.page_id === s.page_id),
            )
          )
            throw Error("EVIDENCE_INVALID");
          const requestId = `agent_${outcomeId}`;
          const old = await db.query(
            "SELECT id FROM refinement_requests WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, requestId],
          );
          if (old.rowCount) continue;
          const claims = (await this.all<Claim>(db, ctx, "claims")).filter(
            (c) =>
              d.used_versions.some(
                (v) => v.page_id === c.pageId && v.version === c.pageVersion,
              ),
          );
          const claimIds = [];
          for (const c of claims)
            try {
              await this.claim(db, ctx, c.id);
              claimIds.push(c.id);
            } catch (e) {
              if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
            }
          await this.request(db, ctx, claimIds, "agent-outcome", requestId, {
            agentOutcomeId: outcomeId,
            signalIds: linked.map((s) => s.id),
            usedVersions: d.used_versions,
            rootLineage: d.rootLineage,
            result: d.result,
            observations: d.observations,
            reportedBy: d.reportedBy,
            verified: false,
            humanValidation: "unreviewed",
            evidenceKind: "agent-observation",
            independentExecution: false,
            uncertainty:
              "에이전트의 단일 사례 관찰; 성공/실패 주장과 독립 실행 증거·인간 검증은 별개",
            limits:
              "환경 및 유효/검증 시점 미등록; 보편 규칙으로 일반화하지 않음",
          });
          imported.push(requestId);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return { imported };
    });
  }
  async semanticLint(ctx: Context, input: unknown) {
    const d = contextInput.parse(input);
    // Always authorize even when no provider is configured.
    const context = await this.context(ctx, { ...d, includeHistory: true });
    const recheck = async (db: PoolClient) => {
      for (const c of context.items) {
        await this.claim(db, ctx, c.id);
        for (const r of c.verificationReviews) {
          for (const cid of r.claimIds) await this.claim(db, ctx, cid);
          for (const eid of r.evidenceIds) await this.evidence(db, ctx, eid);
        }
      }
    };
    await this.run(ctx, "lint.run", undefined, recheck);
    if (!this.provider)
      return { status: "unconfigured" as const, findings: [] };
    let findings;
    try {
      assertSafeModelInput({ claims: context.items });
      findings = validateFindings(
        await this.provider({ claims: context.items }),
        context.items,
      );
    } catch {
      return { status: "error" as const, code: "MODEL_FAILED", findings: [] };
    }
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      // Recheck all model input provenance after asynchronous transmission, not only output citations.
      await recheck(db);
      const requestIds = [];
      for (const f of findings) {
        const request = await this.request(
          db,
          ctx,
          f.claimIds,
          "semantic-lint",
          `lint_${randomUUID()}`,
          { finding: f },
        );
        requestIds.push(request.id);
      }
      return {
        status: "completed" as const,
        kind: "model-proposal" as const,
        findings,
        requestIds,
      };
    });
  }
}
