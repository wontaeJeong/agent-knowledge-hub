import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../database";
import type { Context } from "../service";
import type { RuntimeService } from "../runtime/knowledge";
import type { Source, Page } from "../../src/domain/types";
import { current, draftOf } from "../../src/domain/wiki";
import { membership, requireRead, loadState, audit } from "../repository";
import {
  captureEnvelope,
  inheritedProvenance,
  fingerprint,
} from "../provenance";
import { propose, digest } from "../publication";
import { sourceInput, drafts as updatesSchema } from "../runtime/schema";
import type {
  WorkflowAuthorizer,
  WorkflowResource,
} from "../workflows/service";

const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const text = z.string().trim().min(1).max(100000);
const key = z.string().min(1).max(200);
const sourceRef = z
  .object({
    id,
    version: z.number().int().positive(),
    location: z.string().min(1).max(500),
  })
  .strict();
const sourceRefs = z.array(sourceRef).max(100);
const versionRef = z
  .object({ page_id: id, version: z.number().int().positive() })
  .strict();
const searchInput = z
  .object({
    query: z.string().trim().min(1).max(2000),
    project: z.string().max(200).optional(),
    environment: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(100000).default(0),
    include_history: z.boolean().default(false),
  })
  .strict();
const upstream = z
  .object({ spaceId: id, pageId: id, version: z.number().int().positive() })
  .strict();
const personalPage = z
  .object({
    id,
    title: z.string().trim().min(1).max(300),
    content: z.string().max(100000),
    spaceId: z.literal("personal"),
    version: z.number().int().min(0),
    localCopyAllowed: z.literal(true),
    links: z.array(id).max(100),
    sourceRefs,
    upstream: upstream.optional(),
  })
  .strict();
export const agentInputs = {
  wiki_search: searchInput,
  wiki_read: z
    .object({
      page_id: id,
      version: z.number().int().positive().optional(),
      section_id: z.string().max(200).optional(),
    })
    .strict(),
  wiki_get_context: z
    .object({
      task: z.string().trim().min(1).max(2000),
      project: z.string().max(200).optional(),
      environment: z.string().max(200).optional(),
      token_budget: z.number().int().min(64).max(16000),
    })
    .strict(),
  wiki_submit_artifact: z
    .object({ artifact: sourceInput, idempotency_key: key })
    .strict(),
  wiki_propose_change: z
    .object({
      updates: updatesSchema,
      source_refs: sourceRefs.min(1),
      idempotency_key: key,
    })
    .strict(),
  wiki_report_outcome: z
    .object({
      used_versions: z.array(versionRef).min(1).max(100),
      result: z.enum(["success", "failure", "unknown"]),
      observations: text,
      evidence: sourceRefs.default([]),
      idempotency_key: key,
    })
    .strict(),
} as const;
type PersonalPage = z.infer<typeof personalPage>;
type Binding = WorkflowResource;
type Complete = (
  db: PoolClient,
  result: unknown,
  resources: Binding[],
) => Promise<void>;

/** Same domain services as web. The injected authorizer is mandatory, including bearer scope. */
export class AgentService {
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
    readonly authorize: WorkflowAuthorizer,
    readonly importReviewSignals?: (
      ctx: Context,
      outcomeId: string,
    ) => Promise<{ imported: string[]; acknowledged?: string[] }>,
  ) {}
  private async run<T>(
    ctx: Context,
    action: string,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async binding(
    db: PoolClient,
    ctx: Context,
    b: Binding,
    action = "knowledge.read",
  ) {
    await this.authorize(db, ctx, action, b);
    if (b.kind === "source") return requireRead(db, ctx, "source", b.id);
    const { state } = await this.runtime.view(db, ctx);
    if (!state.pages.some((p) => p.id === b.id)) throw Error("NOT_FOUND");
  }
  private async refs(
    db: PoolClient,
    ctx: Context,
    refs: z.infer<typeof sourceRefs>,
  ) {
    for (const ref of refs) {
      await this.binding(db, ctx, { kind: "source", id: ref.id });
      const row = await db.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, ref.id],
      );
      if (!row.rowCount || ref.version !== 1) throw Error("EVIDENCE_MISSING");
      if (
        ref.location !== "content" &&
        !(
          ref.location.startsWith("quote:") &&
          ref.location.length > 6 &&
          row.rows[0].data.content.includes(ref.location.slice(6))
        )
      )
        throw Error("EVIDENCE_MISSING");
    }
  }
  private async cached<T>(
    ctx: Context,
    operation: string,
    requestKey: string,
    hash: string,
    action: string,
  ): Promise<{ found: false } | { found: true; result: T }> {
    return this.run(ctx, action, async (db) => {
      const row = await db.query(
        "SELECT fingerprint,result,resources FROM agent_requests WHERE workspace_id=$1 AND principal_id=$2 AND operation=$3 AND key=$4",
        [ctx.workspaceId, ctx.principalId, operation, requestKey],
      );
      if (!row.rowCount) return { found: false };
      if (row.rows[0].fingerprint !== hash) throw Error("IDEMPOTENCY_CONFLICT");
      for (const resource of row.rows[0].resources as Binding[])
        await this.binding(
          db,
          ctx,
          resource,
          operation === "personal.push" ? "local.copy" : "knowledge.read",
        );
      return { found: true, result: row.rows[0].result };
    });
  }
  private async mutation<T>(
    ctx: Context,
    operation: string,
    requestKey: string,
    input: unknown,
    action: string,
    work: (complete: Complete) => Promise<T>,
  ): Promise<T> {
    key.parse(requestKey);
    const hash = fingerprint(input);
    const existing = await this.cached<T>(
      ctx,
      operation,
      requestKey,
      hash,
      action,
    );
    if (existing.found) return existing.result;
    const complete: Complete = async (db, result, resources) => {
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action);
      for (const resource of resources) await this.binding(db, ctx, resource);
      await db.query(
        "INSERT INTO agent_requests(workspace_id,principal_id,operation,key,fingerprint,result,resources) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          ctx.workspaceId,
          ctx.principalId,
          operation,
          requestKey,
          hash,
          result,
          JSON.stringify(resources),
        ],
      );
    };
    try {
      const result = await work(complete);
      await ctx.authorization?.revalidate();
      return result;
    } catch (e) {
      const recovered = await this.cached<T>(
        ctx,
        operation,
        requestKey,
        hash,
        action,
      );
      if (recovered.found) return recovered.result;
      throw e;
    }
  }
  private async metadata(db: PoolClient, ctx: Context, p: Page) {
    const row = await db.query(
      "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
      [ctx.workspaceId, p.id],
    );
    const props = row.rows[0]?.data.properties ?? {};
    const lifecycle = row.rows[0]?.state ?? "active";
    const effectiveFrom = row.rows[0]?.data.effectiveFrom ?? null;
    return {
      project: typeof props.project === "string" ? props.project : null,
      environment:
        typeof props.environment === "string" ? props.environment : null,
      effectiveFrom: row.rows[0]?.data.effectiveFrom ?? null,
      reviewDue: row.rows[0]?.data.reviewDue ?? null,
      lifecycle,
      currentRecommendation:
        lifecycle === "active" &&
        (effectiveFrom === null ||
          (typeof effectiveFrom === "string" &&
            Number.isFinite(Date.parse(effectiveFrom)) &&
            Date.parse(effectiveFrom) <= Date.now())),
    };
  }
  async search(ctx: Context, input: unknown) {
    const q = searchInput.parse(input);
    return this.run(ctx, "knowledge.read", async (db) => {
      const { state } = await this.runtime.view(db, ctx),
        items = [];
      const terms = q.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      for (const p of state.pages) {
        const hay = (
          p.title +
          " " +
          p.summary +
          " " +
          current(p).content
        ).toLocaleLowerCase();
        const score = terms.filter((t) => hay.includes(t)).length;
        if (!score) continue;
        const conditions = await this.metadata(db, ctx, p);
        if (!q.include_history && !conditions.currentRecommendation) continue;
        if (q.project && conditions.project && conditions.project !== q.project)
          continue;
        if (
          q.environment &&
          conditions.environment &&
          conditions.environment !== q.environment
        )
          continue;
        items.push({
          id: p.id,
          title: p.title,
          summary: p.summary,
          version: current(p).number,
          conditions,
          verification: p.status,
          score,
        });
      }
      items.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const slice = items
        .slice(q.offset, q.offset + q.limit)
        .map(({ score: _, ...p }) => p);
      return {
        schemaVersion: "1.0",
        items: slice,
        nextOffset:
          q.offset + q.limit < items.length ? q.offset + q.limit : null,
      };
    });
  }
  async read(ctx: Context, input: unknown) {
    const q = agentInputs.wiki_read.parse(input);
    return this.run(ctx, "knowledge.read", async (db) => {
      const { state } = await this.runtime.view(db, ctx),
        p = state.pages.find((p) => p.id === q.page_id);
      if (!p) throw Error("NOT_FOUND");
      const v =
        q.version === undefined
          ? current(p)
          : p.versions.find((v) => v.number === q.version);
      if (!v) throw Error("NOT_FOUND");
      let content = v.content;
      if (q.section_id) {
        const lines = content.split("\n"),
          start = lines.findIndex(
            (line) =>
              /^#{1,6}\s/.test(line) &&
              line.replace(/^#{1,6}\s+/, "").trim() === q.section_id,
          );
        if (start < 0) throw Error("NOT_FOUND");
        const level = lines[start].match(/^#+/)![0].length;
        let end = start + 1;
        while (end < lines.length) {
          const heading = lines[end].match(/^(#{1,6})\s/);
          if (heading && heading[1].length <= level) break;
          end++;
        }
        content = lines.slice(start, end).join("\n");
      }
      const provenance = inheritedProvenance(p);
      await this.refs(
        db,
        ctx,
        provenance.sourceIds.map((id) => ({
          id,
          version: 1,
          location: "content",
        })),
      );
      return {
        schemaVersion: "1.0",
        page_id: p.id,
        title: p.title,
        version: v.number,
        content,
        source_refs: provenance.sourceIds.map((id) => ({
          id,
          version: 1,
          location: "content",
        })),
        conditions: await this.metadata(db, ctx, p),
        verification: p.status,
        verifiedAt:
          v.number === current(p).number ? (p.verifiedAt ?? null) : null,
        warning: "원본 주장·파생 추론·검토 승인은 독립 실행 증거와 다릅니다.",
      };
    });
  }
  async context(ctx: Context, input: unknown) {
    const q = agentInputs.wiki_get_context.parse(input);
    const candidates = await this.search(ctx, {
      query: q.task,
      project: q.project,
      environment: q.environment,
      limit: 100,
    });
    const items: Awaited<ReturnType<AgentService["read"]>>[] = [],
      omitted: {
        pageId: string;
        version: number;
        reason: string;
        readTool: string;
      }[] = [];
    for (const p of candidates.items) {
      const item = await this.read(ctx, { page_id: p.id, version: p.version });
      if (
        Buffer.byteLength(JSON.stringify([...items, item]), "utf8") >
        q.token_budget
      ) {
        omitted.push({
          pageId: p.id,
          version: p.version,
          reason: "budget",
          readTool: "wiki_read",
        });
        continue;
      }
      items.push(item);
    }
    // Recheck every selected/omitted page immediately before exposing even its identifier.
    await this.run(ctx, "knowledge.read", async (db) => {
      for (const p of candidates.items)
        await this.binding(db, ctx, { kind: "page", id: p.id });
    });
    return {
      schemaVersion: "1.0",
      items,
      omitted,
      insufficient: items.length === 0,
      budget: {
        requestedTokens: q.token_budget,
        evidenceUtf8Bytes: Buffer.byteLength(JSON.stringify(items)),
        accounting: "conservative-utf8-byte-bound",
        exactModelTokenCount: null,
        includesEnvelope: false,
      },
      warning:
        "적용 조건이 미등록이면 현재 업무에 적용된다고 확정하지 않습니다. 생략된 근거는 wiki_read로 추가 조회하세요.",
    };
  }
  async submitArtifact(ctx: Context, input: unknown) {
    const q = agentInputs.wiki_submit_artifact.parse(input);
    return this.mutation(
      ctx,
      "artifact",
      q.idempotency_key,
      q,
      "source.create",
      async (complete) => {
        const { readers: audience, ...artifact } = q.artifact;
        const source: Source = {
          ...artifact,
          id:
            artifact.id ??
            `artifact-${fingerprint([ctx.workspaceId, ctx.principalId, q.idempotency_key]).slice(0, 48)}`,
          verification: "미검증",
          createdAt: new Date().toISOString(),
          processed: false,
        };
        const result = {
          schemaVersion: "1.0",
          source_id: source.id,
          status: "registered",
          published: false,
        };
        await this.runtime.core.registerSource(ctx, source, audience, (db) =>
          complete(db, result, [{ kind: "source", id: source.id }]),
        );
        return result;
      },
    );
  }
  async proposeChange(
    ctx: Context,
    input: unknown,
    commitGuard?: (db: PoolClient) => Promise<void>,
  ) {
    const q = agentInputs.wiki_propose_change.parse(input);
    return this.mutation(
      ctx,
      "propose",
      q.idempotency_key,
      q,
      "changeset.propose",
      async (complete) => {
        const prepared = await this.run(
          ctx,
          "changeset.propose",
          async (db) => {
            await this.refs(db, ctx, q.source_refs);
            const state = await loadState(db, ctx.workspaceId),
              sources = [...new Set(q.source_refs.map((r) => r.id))];
            if (
              q.updates.some((u) =>
                u.sourceIds.some((id) => !sources.includes(id)),
              )
            )
              throw Error("EVIDENCE_MISSING");
            const pageIds = q.updates
              .filter((u) => u.baseVersion > 0)
              .map((u) => u.id);
            const envelope = await captureEnvelope(
              db,
              ctx,
              state,
              pageIds,
              sources,
            );
            return {
              envelope,
              fingerprint: digest(state),
              sources,
              resources: [
                ...envelope.pageIds.map((id) => ({
                  kind: "page" as const,
                  id,
                })),
                ...envelope.sourceIds.map((id) => ({
                  kind: "source" as const,
                  id,
                })),
              ],
            };
          },
        );
        let result:
          | { id: string; hash: string; status: string; published: boolean }
          | undefined;
        await propose(this.pool, ctx, q.updates, prepared.sources, {
          inputEnvelope: prepared.envelope,
          producer: { kind: "api-submission", principalId: ctx.principalId },
          expectedStateHash: prepared.fingerprint,
          dependencyIds: prepared.envelope.pageIds,
          onCreated: async (db, batch) => {
            await commitGuard?.(db);
            result = { ...batch, status: "pending", published: false };
            await complete(db, result, prepared.resources);
          },
        });
        if (!result) throw Error("TRANSACTION_INCOMPLETE");
        return result;
      },
    );
  }
  async reportOutcome(ctx: Context, input: unknown) {
    const q = agentInputs.wiki_report_outcome.parse(input);
    const result = await this.mutation(
      ctx,
      "outcome",
      q.idempotency_key,
      q,
      "changeset.propose",
      (complete) =>
        this.run(ctx, "changeset.propose", async (db) => {
          const { state } = await this.runtime.view(db, ctx);
          for (const used of q.used_versions) {
            const p = state.pages.find((p) => p.id === used.page_id);
            if (!p || !p.versions.some((v) => v.number === used.version))
              throw Error("NOT_FOUND");
          }
          await this.refs(db, ctx, q.evidence);
          const outcomeId = randomUUID(),
            result = {
              id: outcomeId,
              status: "needs_review",
              verified: false,
              published: false,
            };
          await db.query(
            "INSERT INTO agent_outcomes(workspace_id,id,principal_id,result,data) VALUES($1,$2,$3,$4,$5)",
            [
              ctx.workspaceId,
              outcomeId,
              ctx.principalId,
              q.result,
              {
                ...q,
                verified: false,
                evidenceKind: "agent-observation",
                independentExecution: false,
              },
            ],
          );
          for (const used of q.used_versions)
            await db.query(
              "INSERT INTO agent_review_signals(workspace_id,id,page_id,outcome_id) VALUES($1,$2,$3,$4)",
              [ctx.workspaceId, randomUUID(), used.page_id, outcomeId],
            );
          await audit(db, ctx, "agent.outcome", outcomeId);
          await complete(db, result, [
            ...q.used_versions.map((v) => ({
              kind: "page" as const,
              id: v.page_id,
            })),
            ...q.evidence.map((r) => ({ kind: "source" as const, id: r.id })),
          ]);
          return result;
        }),
    );
    if (!this.importReviewSignals) return result;
    try {
      const imported = await this.importReviewSignals(ctx, result.id),
        requestId = `agent_${result.id}`;
      return {
        ...result,
        reviewImport: {
          status: imported.imported.includes(requestId)
            ? "imported"
            : imported.acknowledged?.includes(requestId)
              ? "existing"
              : "pending",
          newRequestIds: imported.imported,
        },
      };
    } catch (e) {
      const code =
        e instanceof Error && /^[A-Z_]{3,60}$/.test(e.message)
          ? e.message
          : "REVIEW_IMPORT_FAILED";
      if (["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(code)) throw e;
      return { ...result, reviewImport: { status: "pending", code } };
    }
  }
  private async personalAccess(db: PoolClient, ctx: Context, p: PersonalPage) {
    await this.refs(db, ctx, p.sourceRefs);
    for (const ref of p.sourceRefs)
      await this.authorize(db, ctx, "local.copy", {
        kind: "source",
        id: ref.id,
      });
    if (p.upstream) {
      if (p.upstream.spaceId !== ctx.workspaceId)
        throw Error("SOURCE_SCOPE_CONFLICT");
      await this.binding(
        db,
        ctx,
        { kind: "page", id: p.upstream.pageId },
        "local.copy",
      );
    }
  }
  private async connectorSnapshot(ctx: Context, metadataOnly: boolean) {
    return this.run(ctx, "personal.sync", async (db) => {
      const { state } = await this.runtime.view(db, ctx);
      const shared = [];
      for (const p of state.pages) {
        try {
          await this.authorize(db, ctx, "local.copy", {
            kind: "page",
            id: p.id,
          });
        } catch (e) {
          if (
            e instanceof Error &&
            ["FORBIDDEN", "NOT_FOUND"].includes(e.message)
          )
            continue;
          throw e;
        }
        const sourceRefs = inheritedProvenance(p).sourceIds.map((id) => ({
          id,
          version: 1,
          location: "content",
        }));
        shared.push({
          id: p.id,
          title: p.title,
          content: current(p).content,
          links: p.links ?? [],
          sourceRefs,
          spaceId: ctx.workspaceId,
          version: current(p).number,
          localCopyAllowed: true as const,
        });
      }
      const rows = await db.query(
          "SELECT data FROM agent_personal_pages WHERE workspace_id=$1 AND owner_id=$2 ORDER BY id",
          [ctx.workspaceId, ctx.principalId],
        ),
        personal: PersonalPage[] = [];
      for (const r of rows.rows) {
        try {
          await this.personalAccess(db, ctx, r.data);
          personal.push(r.data);
        } catch (e) {
          if (
            e instanceof Error &&
            ["FORBIDDEN", "NOT_FOUND"].includes(e.message)
          )
            continue;
          throw e;
        }
      }
      if (metadataOnly) {
        const meta = (p: { id: string; spaceId: string; version: number }) => ({
          id: p.id,
          spaceId: p.spaceId,
          version: p.version,
        });
        return {
          shared: shared.map(meta),
          personal: personal.map(meta),
          backend: "operational-server",
        };
      }
      return { shared, personal, backend: "operational-server" };
    });
  }
  async connector(
    ctx: Context,
    action: string,
    input: unknown,
  ): Promise<unknown> {
    if (action === "snapshot" || action === "access") {
      z.object({}).strict().parse(input);
      return this.connectorSnapshot(ctx, action === "access");
    }
    if (action === "push") {
      const q = z
        .object({
          mutationId: id,
          baseVersion: z.number().int().min(0),
          page: personalPage,
        })
        .strict()
        .parse(input);
      return this.mutation(
        ctx,
        "personal.push",
        q.mutationId,
        q,
        "personal.sync",
        (complete) =>
          this.run(ctx, "personal.sync", async (db) => {
            await this.personalAccess(db, ctx, q.page);
            const row = await db.query(
              "SELECT revision,data FROM agent_personal_pages WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
              [ctx.workspaceId, ctx.principalId, q.page.id],
            );
            if ((row.rows[0]?.revision ?? 0) !== q.baseVersion)
              throw Error("STALE_VERSION");
            const old = row.rows[0]?.data as PersonalPage | undefined;
            if (old) {
              await this.personalAccess(db, ctx, old);
              if (
                fingerprint(old.upstream ?? null) !==
                  fingerprint(q.page.upstream ?? null) ||
                fingerprint(old.sourceRefs) !== fingerprint(q.page.sourceRefs)
              )
                throw Error("SOURCE_SCOPE_CONFLICT");
            }
            if (q.page.upstream) {
              const { state } = await this.runtime.view(db, ctx),
                origin = state.pages.find(
                  (p) => p.id === q.page.upstream!.pageId,
                );
              if (!origin) throw Error("NOT_FOUND");
              if (!old && current(origin).number !== q.page.upstream.version)
                throw Error("STALE_VERSION");
              const required = inheritedProvenance(origin).sourceIds.map(
                (id) => ({ id, version: 1, location: "content" }),
              );
              if (
                required.some(
                  (ref) =>
                    !q.page.sourceRefs.some(
                      (r) => r.id === ref.id && r.version === 1,
                    ),
                )
              )
                throw Error("EVIDENCE_MISSING");
            }
            for (const link of q.page.links)
              await this.binding(
                db,
                ctx,
                { kind: "page", id: link },
                "local.copy",
              );
            const result = { ...q.page, version: q.baseVersion + 1 };
            await db.query(
              "INSERT INTO agent_personal_pages(workspace_id,owner_id,id,revision,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=now()",
              [
                ctx.workspaceId,
                ctx.principalId,
                q.page.id,
                result.version,
                result,
              ],
            );
            await db.query(
              "INSERT INTO agent_personal_revisions(workspace_id,owner_id,page_id,revision,data) VALUES($1,$2,$3,$4,$5)",
              [
                ctx.workspaceId,
                ctx.principalId,
                q.page.id,
                result.version,
                result,
              ],
            );
            await complete(db, result, [
              ...(q.page.upstream
                ? [{ kind: "page" as const, id: q.page.upstream.pageId }]
                : []),
              ...q.page.sourceRefs.map((r) => ({
                kind: "source" as const,
                id: r.id,
              })),
            ]);
            return result;
          }),
      );
    }
    if (action === "propose") {
      const q = z
        .object({
          id,
          pageId: id,
          targetSpaceId: id,
          baseVersion: z.number().int().min(0),
          personalVersion: z.number().int().positive(),
        })
        .strict()
        .parse(input);
      if (q.targetSpaceId !== ctx.workspaceId)
        throw Error("SOURCE_SCOPE_CONFLICT");
      const prepared = await this.run(ctx, "changeset.propose", async (db) => {
        await this.authorize(db, ctx, "personal.sync");
        const row = await db.query(
          "SELECT revision,data FROM agent_personal_pages WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, q.pageId],
        );
        if (!row.rowCount) throw Error("NOT_FOUND");
        if (row.rows[0].revision !== q.personalVersion)
          throw Error("STALE_PERSONAL_VERSION");
        const personal = row.rows[0].data as PersonalPage;
        await this.personalAccess(db, ctx, personal);
        if (!personal.upstream) throw Error("SOURCE_REGISTRATION_REQUIRED");
        const { state } = await this.runtime.view(db, ctx),
          page = state.pages.find((p) => p.id === personal.upstream!.pageId);
        if (!page) throw Error("NOT_FOUND");
        if (
          current(page).number !== q.baseVersion ||
          personal.upstream.version !== q.baseVersion
        )
          throw Error("STALE_VERSION");
        return {
          updates: [
            {
              ...draftOf(page),
              content: personal.content,
              links: personal.links,
            },
          ],
          source_refs: personal.sourceRefs,
          idempotency_key: q.id,
        };
      });
      return this.proposeChange(ctx, prepared, async (db) => {
        const row = await db.query(
          "SELECT revision FROM agent_personal_pages WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, q.pageId],
        );
        if (row.rows[0]?.revision !== q.personalVersion)
          throw Error("STALE_PERSONAL_VERSION");
      });
    }
    if (action === "proposal") {
      const q = z.object({ id }).strict().parse(input);
      return this.run(ctx, "changeset.propose", async (db) => {
        const row = await db.query(
          "SELECT result,resources FROM agent_requests WHERE workspace_id=$1 AND principal_id=$2 AND operation='propose' AND key=$3",
          [ctx.workspaceId, ctx.principalId, q.id],
        );
        if (!row.rowCount) throw Error("NOT_FOUND");
        for (const r of row.rows[0].resources as Binding[])
          await this.binding(db, ctx, r);
        return row.rows[0].result;
      });
    }
    throw Error("UNKNOWN_OPERATION");
  }
}
