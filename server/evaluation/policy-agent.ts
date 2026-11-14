import type { PoolClient } from "pg";
import { transaction } from "../database";
import { loadState } from "../repository";
import { authorizeManaged } from "../access/index";
import { captureEnvelope, assertEnvelope } from "../provenance";
import { bindModelTransmission } from "../policy/binding";
import { digest } from "../publication";
import {
  currentRecommendation,
  type RuntimeService,
} from "../runtime/knowledge";
import type { Context } from "../service";
// @ts-expect-error Existing evaluation provider is server-only JavaScript.
import { createEvaluationAgent } from "../../scripts/evaluation/provider.mjs";

type Item = {
  id: string;
  version: string | number;
  content: string;
  kind?: string;
};
type Input = {
  task: { id: string; stage: number; prompt: string };
  condition: string;
  model: string;
  seed: number;
  budget: { calls: number; maxTokens: number; timeoutMs: number };
  sources: Item[];
  wiki: Item[];
  promptVersion: string;
  rulesVersion: string;
};
async function sealProjection(
  runtime: RuntimeService,
  ctx: Context,
  sources: Item[],
  wiki: Item[],
  purpose: "query" | "ingest" = "query",
) {
  const checkProjection = async (db: PoolClient) => {
    await ctx.authorization?.assertSession(db);
    await authorizeManaged(db, ctx, "knowledge.read");
    const state = await loadState(db, ctx.workspaceId);
    for (const item of sources) {
      const source = state.sources.find((s) => s.id === item.id);
      if (
        !source ||
        digest(source) !== item.version ||
        source.content !== item.content
      )
        throw Error("STALE_VERSION");
    }
    for (const item of wiki) {
      const page = state.pages.find((p) => p.id === item.id);
      const version = page?.versions.find((v) => v.number === item.version);
      if (
        !version ||
        version.content !== item.content ||
        !(await currentRecommendation(db, ctx, item.id))
      )
        throw Error("STALE_VERSION");
    }
    return state;
  };
  await ctx.authorization?.revalidate();
  const envelope = await transaction(
    runtime.pool,
    ctx.workspaceId,
    async (db) =>
      captureEnvelope(
        db,
        ctx,
        await checkProjection(db),
        wiki.map((p) => p.id),
        sources.map((s) => s.id),
      ),
  );
  const binding = await bindModelTransmission(
    runtime.pool,
    ctx,
    purpose,
    envelope,
    {
      pool: runtime.pool,
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
    },
  );
  return { checkProjection, envelope, binding };
}
/** Recheck every retained result snapshot before returning it to the originating principal. */
export async function assertEvaluationSnapshots({
  runtime,
  ctx,
  snapshots,
  purpose = "query",
}: {
  runtime: RuntimeService;
  ctx: Context;
  snapshots: { sources: Item[]; wiki: Item[] | null }[];
  purpose?: "query" | "ingest";
}) {
  for (const snapshot of snapshots) {
    if (!snapshot.sources.length) continue;
    const { checkProjection, envelope, binding } = await sealProjection(
      runtime,
      ctx,
      snapshot.sources,
      snapshot.wiki ?? [],
      purpose,
    );
    await ctx.authorization?.revalidate();
    await transaction(runtime.pool, ctx.workspaceId, async (db) => {
      await binding.recheck(db);
      const state = await checkProjection(db);
      await assertEnvelope(db, ctx, state, envelope);
    });
  }
}
/** Trusted offline evaluator entry: source and historical page bytes must match currently readable state.
 * No HTTP endpoint, caller-selected destination, writes, labels or result persistence are exposed here. */
export function createPolicyEvaluationAgent({
  runtime,
  ctx,
}: {
  runtime: RuntimeService;
  ctx: Context;
}) {
  return async (
    input: Input,
    tools: { raw_lookup: (id: string) => Promise<unknown> },
    signal?: AbortSignal,
  ) => {
    const model = process.env.AGENT_KNOWLEDGE_HUB_LLM_MODEL;
    if (
      !model ||
      input.model !== model ||
      !Array.isArray(input.sources) ||
      !input.sources.length ||
      input.sources.length > 100 ||
      !Array.isArray(input.wiki) ||
      input.wiki.length > 100 ||
      !["raw", "static", "maintained"].includes(input.condition)
    )
      throw Error("EVALUATION_CONFIG_INVALID");
    if (
      new Set(input.sources.map((s) => s.id)).size !== input.sources.length ||
      new Set(input.wiki.map((p) => p.id)).size !== input.wiki.length
    )
      throw Error("EVALUATION_CONFIG_INVALID");
    const { checkProjection, envelope, binding } = await sealProjection(
      runtime,
      ctx,
      input.sources,
      input.wiki,
    );
    const sources = input.sources.map((s) => ({
      id: s.id,
      version: s.version,
      content: s.content,
    }));
    const wiki = input.wiki.map((p) => ({
      id: p.id,
      version: p.version,
      content: p.content,
      kind: "wiki",
    }));
    const safeInput = {
      task: {
        id: input.task.id,
        stage: input.task.stage,
        prompt: input.task.prompt,
      },
      model,
      seed: input.seed,
      budget: input.budget,
      tools: ["raw_lookup"],
      sources,
      wiki,
      context: [...sources, ...wiki],
      availableSourceIds: sources.map((s) => s.id),
      promptVersion: input.promptVersion,
      rulesVersion: input.rulesVersion,
      policy: "Evaluation is read-only; outputs cannot be filed.",
    };
    const provider = createEvaluationAgent({
      baseUrl: process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL,
      model,
      apiKey: process.env.AGENT_KNOWLEDGE_HUB_LLM_API_KEY,
      allowTransmission:
        process.env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION === "true",
      thinking: process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING,
      beforeTransmission: async (_input: unknown, endpoint: string) => {
        await transaction(runtime.pool, ctx.workspaceId, async (db) => {
          const state = await checkProjection(db);
          await assertEnvelope(db, ctx, state, envelope);
        });
        await binding.options.beforeTransmission?.(endpoint);
      },
    });
    // Never trust a caller-supplied lookup tool with a wider scope than the sealed sources.
    const safeTools = {
      raw_lookup: async (id: string) => {
        const source = sources.find((s) => s.id === id);
        if (!source) throw Error("NOT_FOUND");
        return structuredClone(source);
      },
    };
    void tools;
    const result = await provider(safeInput, safeTools, signal);
    await ctx.authorization?.revalidate();
    await transaction(runtime.pool, ctx.workspaceId, async (db) => {
      await binding.recheck(db);
      const state = await checkProjection(db);
      await assertEnvelope(db, ctx, state, envelope);
    });
    return result;
  };
}
