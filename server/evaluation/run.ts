import type { RuntimeService } from "../runtime/knowledge";
import type { Context } from "../service";
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
  const maintenance = await runMaintenance({
    driver,
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
