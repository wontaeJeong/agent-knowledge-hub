import type { RuntimeService } from "../runtime/knowledge";
import type { Context } from "../service";
import { transaction } from "../database";
import { readFile } from "node:fs/promises";
import { captureEnvelope } from "../provenance";
import { currentRecommendation } from "../runtime/knowledge";
import { digest } from "../publication";
import {
  createPolicyEvaluationAgent,
  assertEvaluationSnapshots,
} from "./policy-agent";
// @ts-expect-error trusted evaluation runner is server-side JavaScript
import { runMaintenance } from "../../scripts/evaluation/maintenance.mjs";
// @ts-expect-error trusted evaluator is server-side JavaScript
import * as evaluation from "../../scripts/evaluation/evolution.mjs";

/** Offline host entry point; caller supplies authenticated runtime driver and an explicit review callback.
 * Heldout labels are used only by the evaluator, never by maintenance or a model transmission. */
export async function runPolicyBoundExperiment({
  runtime,
  ctx,
  driver,
  stages,
  heldout,
  expected,
  config,
  signal,
}: {
  runtime: RuntimeService;
  ctx: Context;
  driver: {
    verifyModel: (model: string, provider: string) => Promise<void>;
    verifyActors: () => Promise<{
      workspaceId: string;
      editor: string;
      reviewer: string;
    }>;
    sources: () => Promise<{ id: string; version: string; content: string }[]>;
  };
  stages: { stage: number; sourceIds: string[]; operationalQuestion: string }[];
  heldout: unknown[];
  expected: unknown;
  config: {
    model: string;
    provider: string;
    seed: number;
    repeats: number;
    budget: { calls: number; maxTokens: number; timeoutMs: number };
  };
  signal?: AbortSignal;
}) {
  evaluation.validatePlan(stages, heldout, expected, config);
  if (
    config.provider !==
    (process.env.AGENT_KNOWLEDGE_HUB_LLM_PROVIDER || "openai")
  )
    throw Error("MODEL_MISMATCH");
  await driver.verifyModel(config.model, config.provider);
  const actor = await driver.verifyActors();
  if (actor.workspaceId !== ctx.workspaceId || actor.editor !== ctx.principalId)
    throw Error("EVALUATION_IDENTITIES_INVALID");
  const available = await driver.sources();
  const selectedIds = new Set(stages.flatMap((s) => s.sourceIds));
  const selected = available.filter((s) => selectedIds.has(s.id));
  if (!selectedIds.size || selected.length !== selectedIds.size)
    throw Error("EVALUATION_SOURCE_INVALID");
  // Inspect the exact full metadata projected into model ingest, not the reduced
  // public evaluation DTO. Include transitive and historical source lineage.
  const checkMaintenanceInputs = async (
    sourceIds: string[],
    allowedIds: string[],
  ) => {
    const rules = await readFile(
      new URL("../../wiki/SCHEMA.md", import.meta.url),
      "utf8",
    );
    return transaction(runtime.pool, ctx.workspaceId, async (db) => {
      const { state } = await runtime.view(db, ctx);
      const inputSources = sourceIds.map((id) =>
        state.sources.find((s) => s.id === id),
      );
      if (inputSources.some((source) => !source))
        throw Error("EVALUATION_SOURCE_INVALID");
      const pages = [];
      for (const page of state.pages)
        if (await currentRecommendation(db, ctx, page.id)) pages.push(page);
      const modelPages = pages.map(({ versions, ...page }) => ({
        ...page,
        content: versions.at(-1)!.content,
        baseVersion: versions.at(-1)!.number,
      }));
      evaluation.validateIsolation(
        [{ sources: inputSources, pages: modelPages, rules }],
        heldout,
        expected,
      );
      const envelope = await captureEnvelope(
        db,
        ctx,
        state,
        pages.map((page) => page.id),
      );
      const allowed = new Set(allowedIds);
      if (envelope.sourceIds.some((id) => !allowed.has(id)))
        throw Error("EVALUATION_SOURCE_CLOSURE");
      const scopes = new Set(inputSources.map((source) => source!.scope));
      const selectedPages = modelPages.filter((page) => scopes.has(page.scope));
      return {
        sourceHashes: new Map(
          inputSources.map((source) => [source!.id, digest(source)]),
        ),
        pageHashes: new Map(
          selectedPages.map((page) => [page.id, digest(page)]),
        ),
        queryPageHashes: new Map(
          modelPages.map((page) => [
            page.id,
            digest({
              id: page.id,
              title: page.title,
              version: page.baseVersion,
              content: page.content,
            }),
          ]),
        ),
        allowed,
        rules,
        rulesHash: digest(rules),
      };
    });
  };
  await checkMaintenanceInputs([...selectedIds], stages[0].sourceIds);
  const preflight = [{ sources: selected, wiki: [] }];
  await assertEvaluationSnapshots({
    runtime,
    ctx,
    snapshots: preflight,
    purpose: "ingest",
  });
  await assertEvaluationSnapshots({
    runtime,
    ctx,
    snapshots: preflight,
    purpose: "query",
  });
  let stageSeal: Awaited<ReturnType<typeof checkMaintenanceInputs>> | undefined;
  let querySeal: Awaited<ReturnType<typeof checkMaintenanceInputs>> | undefined;
  const maintenance = await runMaintenance({
    driver: {
      ...driver,
      beforeStage: async (
        stage: { sourceIds: string[] },
        allowed: string[],
      ) => {
        stageSeal = await checkMaintenanceInputs(stage.sourceIds, allowed);
        return {
          rulesHash: stageSeal.rulesHash,
          sourceHashes: Object.fromEntries(stageSeal.sourceHashes),
          pageHashes: Object.fromEntries(stageSeal.pageHashes),
        };
      },
      afterStage: async (stage: { sourceIds: string[] }, allowed: string[]) => {
        querySeal = await checkMaintenanceInputs(stage.sourceIds, allowed);
        return {
          rulesHash: querySeal.rulesHash,
          pageHashes: Object.fromEntries(querySeal.queryPageHashes),
        };
      },
      query: async (question: string, signal?: AbortSignal) => {
        if (!querySeal) throw Error("EVALUATION_CONFIG_INVALID");
        const seal = querySeal;
        return runtime.queryForEvaluation(ctx, question, {
          signal,
          rules: seal.rules,
          validate: (input, envelope, rules) => {
            if (digest(rules) !== seal.rulesHash) throw Error("STALE_VERSION");
            evaluation.validateIsolation([input, rules], heldout, expected);
            if (envelope.sourceIds.some((id) => !seal.allowed.has(id)))
              throw Error("EVALUATION_SOURCE_CLOSURE");
            if (
              input.pages.some(
                (page) => seal.queryPageHashes.get(page.id) !== digest(page),
              )
            )
              throw Error("STALE_VERSION");
          },
        });
      },
      ingest: async (sourceIds: string[], signal?: AbortSignal) => {
        if (!stageSeal) throw Error("EVALUATION_CONFIG_INVALID");
        const seal = stageSeal;
        return runtime.ingestForEvaluation(ctx, sourceIds, {
          signal,
          rules: seal.rules,
          validate: (input, envelope, rules) => {
            if (digest(rules) !== seal.rulesHash) throw Error("STALE_VERSION");
            evaluation.validateIsolation([input, rules], heldout, expected);
            if (envelope.sourceIds.some((id) => !seal.allowed.has(id)))
              throw Error("EVALUATION_SOURCE_CLOSURE");
            const sources = input.sources;
            const pages = input.pages as { id: string }[];
            if (
              sources.length !== seal.sourceHashes.size ||
              pages.length !== seal.pageHashes.size ||
              sources.some(
                (source) =>
                  !source ||
                  seal.sourceHashes.get(source.id) !== digest(source),
              ) ||
              pages.some(
                (page) => seal.pageHashes.get(page.id) !== digest(page),
              )
            )
              throw Error("STALE_VERSION");
          },
        });
      },
    },
    stages,
    heldout,
    expected,
    model: config.model,
    provider: config.provider,
    expectedIdentity: {
      workspaceId: ctx.workspaceId,
      principalId: ctx.principalId,
    },
    signal,
    modelTimeoutMs: config.budget.timeoutMs,
  });
  const agent = createPolicyEvaluationAgent({ runtime, ctx });
  const result = await evaluation.evaluateEvolution({
    snapshots: maintenance.snapshots,
    heldout,
    expected,
    config,
    agent,
    signal,
  });
  await assertEvaluationSnapshots({
    runtime,
    ctx,
    snapshots: maintenance.snapshots,
  });
  return {
    kind: "policy-bound-unvalidated",
    maintenance,
    evaluation: result,
    benefit: "미확인",
    limits: [
      "합성 회귀와 실제 업무 효과는 별도 검증이 필요합니다.",
      "평가 답변은 유지 위키에 재편입하지 않습니다.",
    ],
  };
}
