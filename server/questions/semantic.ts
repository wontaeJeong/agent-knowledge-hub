import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { ScopedSearch, searchFilters } from "./search";
import { authorizeInTransaction } from "../access/index";
import { captureEnvelope, fingerprint } from "../provenance";
import { bindModelTransmission } from "../policy/binding";
import { modelConfig, type ModelUsage } from "../runtime/model";
import type { RuntimeExecution, RuntimeService } from "../runtime/knowledge";
const { cursor: _cursor, ...shape } = searchFilters.shape;
export const semanticSearchInput = z
  .object({ ...shape, query: z.string().trim().min(1).max(2000) })
  .strict();
export const semanticSearchRequest = z
  .object({
    filters: semanticSearchInput,
    idempotency_key: z.string().min(1).max(200),
  })
  .strict();
export const semanticSearchSeal = z
  .object({
    filters: semanticSearchInput,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const output = z
  .object({
    matches: z
      .array(
        z
          .object({
            pageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            version: z.number().int().positive(),
            quote: z.string().min(1).max(2000),
            reason: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export class SemanticSearchService {
  readonly searcher: ScopedSearch;
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
  ) {
    this.searcher = new ScopedSearch(pool, {
      runtime,
      authorize: authorizeInTransaction,
    });
  }
  async prepare(db: PoolClient, ctx: Context, raw: unknown) {
    const sealed =
      raw !== null && typeof raw === "object" && "snapshotHash" in raw
        ? semanticSearchSeal.parse(raw)
        : null;
    const filters = sealed?.filters ?? semanticSearchInput.parse(raw);
    // Include every authorized metadata-filtered candidate, including those with no literal query match.
    // Never silently truncate a corpus and call the subset a semantic search of the whole space.
    const found = await this.searcher.searchDb(db, ctx, {
      ...filters,
      query: "",
      limit: 100,
    });
    if (found.nextCursor) throw Error("SEMANTIC_CORPUS_LIMIT");
    const { state } = await this.runtime.view(db, ctx);
    const pageIds = new Set(found.items.map((i) => i.pageId)),
      sourceIds = new Set<string>();
    if (filters.historical) {
      const snapshots = (
        await db.query(
          "SELECT page_id,number,snapshot FROM version_metadata WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows;
      for (const item of found.items) {
        const snap = snapshots.find(
          (s) => s.page_id === item.pageId && s.number === item.version,
        )?.snapshot;
        if (snap) {
          for (const p of [
            ...Object.keys(snap.versions ?? {}),
            ...(snap.relations ?? []),
            ...(snap.parentId ? [snap.parentId] : []),
          ])
            pageIds.add(p);
          for (const s of snap.sources ?? []) sourceIds.add(s.id);
        }
      }
    }
    const envelope = await captureEnvelope(
      db,
      ctx,
      state,
      [...pageIds],
      [...sourceIds],
    );
    for (const id of envelope.pageIds)
      await authorizeInTransaction(db, ctx, "knowledge.read", {
        kind: "page",
        id,
      });
    for (const id of envelope.sourceIds)
      await authorizeInTransaction(db, ctx, "knowledge.read", {
        kind: "source",
        id,
      });
    const snapshotHash = fingerprint({ filters, items: found.items, envelope });
    if (sealed && sealed.snapshotHash !== snapshotHash)
      throw Error("STALE_VERSION");
    return {
      payload: { filters, snapshotHash },
      pageIds: envelope.pageIds,
      sourceIds: envelope.sourceIds,
      found,
      envelope,
    };
  }
  async execute(ctx: Context, raw: unknown, execution: RuntimeExecution) {
    if (!modelConfig().configured)
      throw Error("SEMANTIC_SEARCH_NOT_CONFIGURED");
    const prepared = await transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        await execution.beforeWrite(db);
        const p = await this.prepare(db, ctx, raw);
        await execution.captureInputs(db, p.pageIds, p.sourceIds);
        return p;
      },
    );
    if (!prepared.found.items.length)
      return {
        ...prepared.found,
        retrieval: {
          kind: "semantic-model-selection",
          invoked: false,
          provider: null,
          model: null,
          reason: "empty-authorized-corpus",
        },
      };
    const recheck = async (db: PoolClient) => {
      await execution.beforeWrite(db);
      await this.prepare(db, ctx, prepared.payload);
    };
    const binding = await bindModelTransmission(
      this.pool,
      ctx,
      "query",
      prepared.envelope,
      {
        ...execution.modelOptions,
        pool: this.pool,
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
        beforeTransmission: async (endpoint) => {
          await execution.modelOptions.beforeTransmission?.(endpoint);
          await transaction(this.pool, ctx.workspaceId, recheck);
        },
      },
    );
    const captured = (await execution.modelResult("query", async () => {
      let usage: ModelUsage | null = null;
      const raw = await this.runtime.model(
        "query",
        {
          semanticSearch: true,
          question: prepared.payload.filters.query,
          pages: prepared.found.items.map((i) => ({
            id: i.pageId,
            version: i.version,
            title: i.title,
            content: i.content,
            metadata: i.metadata,
            historical: i.historical,
          })),
        },
        {
          ...binding.options,
          onUsage: async (u) => {
            usage = u;
            await execution.modelOptions.onUsage?.(u);
          },
        },
      );
      if (!usage) throw Error("MODEL_USAGE_MISSING");
      return { raw, usage };
    })) as { raw: unknown; usage: ModelUsage };
    const parsed = output.safeParse(captured.raw);
    if (!parsed.success) throw Error("MODEL_INVALID");
    const result = parsed.data,
      seen = new Set<string>();
    const items = result.matches
      .map((match) => {
        const key = `${match.pageId}:${match.version}`;
        const item = prepared.found.items.find(
          (i) => i.pageId === match.pageId && i.version === match.version,
        );
        if (!item || seen.has(key)) throw Error("MODEL_SCOPE_INVALID");
        if (!item.content.includes(match.quote))
          throw Error("MODEL_CITATION_INVALID");
        seen.add(key);
        return {
          ...item,
          match: {
            quote: match.quote,
            reason: match.reason,
            status: "model-relevance-proposal",
          },
        };
      })
      .slice(0, prepared.payload.filters.limit);
    await ctx.authorization?.revalidate();
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await recheck(db);
      await binding.recheck(db);
    });
    return {
      items,
      nextCursor: null,
      asof: prepared.found.asof,
      corpus: {
        documents: prepared.found.items.length,
        completeWithinFilters: true,
      },
      retrieval: {
        kind: "semantic-model-selection",
        invoked: true,
        provider: captured.usage.provider,
        model: captured.usage.model,
        inputTokens: captured.usage.inputTokens,
        outputTokens: captured.usage.outputTokens,
        costMicros: captured.usage.costMicros,
      },
    };
  }
}
