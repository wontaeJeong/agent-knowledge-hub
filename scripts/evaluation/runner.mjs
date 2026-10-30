import { createHash } from "node:crypto";
export const CONDITIONS = Object.freeze([
  "no-wiki",
  "raw-retrieval",
  "persistent-wiki",
]);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stage = { S0: 0, S1: 1, S2: 2 };
const normalize = (value) =>
  String(value)
    .trim()
    .replace(/[.!。]+$/, "");
function validate(dataset, expected, config) {
  if (
    expected.datasetId !== dataset.id ||
    !Array.isArray(dataset.tasks) ||
    !dataset.tasks.length ||
    dataset.tasks.length > 1000
  )
    throw Error("EVALUATION_DATASET_INVALID");
  if (
    !Number.isInteger(config.repeats) ||
    config.repeats < 1 ||
    config.repeats > 100 ||
    !Number.isInteger(config.seed) ||
    !config.model ||
    !config.provider ||
    !config.appCommit ||
    !config.rulesVersion ||
    !config.promptVersion ||
    !config.wikiVersion
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  if (
    !["structural-fixture", "actual-model"].includes(config.kind) ||
    JSON.stringify(config.tools) !== '["raw_lookup"]' ||
    !Number.isInteger(config.budget.calls) ||
    config.budget.calls < 1 ||
    config.budget.calls > 20 ||
    !Number.isInteger(config.budget.maxTokens) ||
    config.budget.maxTokens < 1 ||
    config.budget.maxTokens > 100000 ||
    !Number.isFinite(config.budget.timeoutMs) ||
    config.budget.timeoutMs < 1 ||
    config.budget.timeoutMs > 300000
  )
    throw Error("EVALUATION_BUDGET_INVALID");
  if (
    new Set(dataset.tasks.map((t) => t.id)).size !== dataset.tasks.length ||
    expected.answers.length !== dataset.tasks.length ||
    new Set(expected.answers.map((e) => e.taskId)).size !== dataset.tasks.length
  )
    throw Error("EVALUATION_LABELS_INVALID");
  for (const task of dataset.tasks)
    if (
      !expected.answers.some((e) => e.taskId === task.id) ||
      task.split !== "heldout" ||
      !(task.stage in stage)
    )
      throw Error("EVALUATION_LABELS_INVALID");
  if (
    JSON.stringify(dataset).includes(expected.withheldMarker) ||
    dataset.tasks.some((t) =>
      Object.keys(t).some((k) => /answer|solution|expected/i.test(k)),
    )
  )
    throw Error("HELDOUT_LEAKAGE");
}
/** Agent input and read tools never receive independent evaluator labels or previous run outputs. */
export async function runEvaluation({
  dataset,
  expected,
  config,
  agent,
  signal,
}) {
  validate(dataset, expected, config);
  const startedAt = new Date().toISOString(),
    results = [];
  for (let repeat = 0; repeat < config.repeats; repeat++)
    for (let taskIndex = 0; taskIndex < dataset.tasks.length; taskIndex++) {
      const task = dataset.tasks[taskIndex];
      // Counterbalanced seeded cyclic ordering; each call gets a fresh input, tools, and model conversation.
      const offset = (((config.seed + repeat + taskIndex) % 3) + 3) % 3;
      const ordered = CONDITIONS.map((_, i) => CONDITIONS[(i + offset) % 3]);
      for (const condition of ordered) {
        const base = {
          taskId: task.id,
          scenario: task.scenario,
          stage: task.stage,
          repeat,
          condition,
          model: config.model,
          seed: config.seed,
          answer: null,
          cost: null,
          tokens: null,
          durationMs: null,
          citations: [],
          accessLog: [],
          success: false,
          safetyFailure: false,
        };
        if (signal?.aborted) {
          results.push({ ...base, status: "unexecuted" });
          continue;
        }
        const available = dataset.sources.filter(
          (s) => stage[s.stage] <= stage[task.stage],
        );
        const raw = structuredClone(available);
        const wiki = dataset.wiki.filter((w) => w.stage === task.stage);
        const context =
          condition === "no-wiki"
            ? []
            : condition === "raw-retrieval"
              ? raw
              : [...raw, ...wiki];
        const input = {
          task: structuredClone(task),
          condition,
          model: config.model,
          seed: config.seed,
          budget: structuredClone(config.budget),
          tools: [...config.tools],
          context: structuredClone(context),
          availableSourceIds: available.map((s) => s.id),
          promptVersion: config.promptVersion,
          rulesVersion: config.rulesVersion,
          policy:
            "All source access must use raw_lookup; no write or publish tools. Do not infer validation from approval. Return short answer, abstained boolean, exact source-version citations. No hidden answers or previous task state are available.",
        };
        const accessLog = context.map((s) => ({
          id: s.id,
          version: s.version,
          via: "context",
        }));
        const started = performance.now();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(
          () => controller.abort(),
          config.budget.timeoutMs,
        );
        try {
          const tools = {
            raw_lookup: async (id) => {
              const s = available.find((s) => s.id === id);
              if (!s) throw Error("NOT_FOUND");
              accessLog.push({
                id: s.id,
                version: s.version,
                via: "raw_lookup",
              });
              return structuredClone(s);
            },
          };
          const aborted = new Promise((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(Error("TIMEOUT")),
              { once: true },
            ),
          );
          const output = await Promise.race([
            agent(input, tools, controller.signal),
            aborted,
          ]);
          if (
            !output ||
            typeof output.answer !== "string" ||
            output.answer.length > 20000 ||
            typeof output.abstained !== "boolean" ||
            !Array.isArray(output.citations) ||
            output.citations.length > 100
          )
            throw Error("OUTPUT_INVALID");
          const safetyFailure = output.citations.some(
            (c) =>
              !available.some(
                (s) =>
                  s.id === c.sourceId &&
                  s.version === c.version &&
                  typeof c.quote === "string" &&
                  c.quote.length > 0 &&
                  s.content.includes(c.quote),
              ),
          );
          const label = expected.answers.find((e) => e.taskId === task.id);
          const success =
            !safetyFailure &&
            [label.expectedAnswer, ...label.alternatives]
              .map(normalize)
              .includes(normalize(output.answer)) &&
            (!label.requiresCitation || output.citations.length > 0);
          const cost =
            typeof output.usage?.cost === "number" &&
            Number.isFinite(output.usage.cost) &&
            output.usage.cost >= 0
              ? output.usage.cost
              : null;
          const tokens =
            Number.isInteger(output.usage?.tokens) && output.usage.tokens >= 0
              ? output.usage.tokens
              : null;
          results.push({
            ...base,
            status: "completed",
            answer: output.answer,
            abstained: output.abstained,
            citations: output.citations,
            success,
            safetyFailure,
            cost,
            tokens,
            durationMs: performance.now() - started,
            accessLog,
          });
        } catch (error) {
          results.push({
            ...base,
            status: controller.signal.aborted ? "aborted" : "failed",
            errorCode: controller.signal.aborted
              ? "TIMEOUT_OR_ABORT"
              : "EXECUTION_FAILED",
            durationMs: performance.now() - started,
            accessLog,
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          controller.abort();
        }
      }
    }
  const assigned = results.length,
    completed = results.filter((r) => r.status === "completed").length,
    succeeded = results.filter((r) => r.success).length;
  const sumKnown = (key) =>
    results.every((r) => r[key] !== null)
      ? results.reduce((sum, r) => sum + r[key], 0)
      : null;
  const counts = (items) => ({
    assigned: items.length,
    completed: items.filter((r) => r.status === "completed").length,
    succeeded: items.filter((r) => r.success).length,
    successRate: items.filter((r) => r.success).length / items.length,
    safetyFailures: items.filter((r) => r.safetyFailure).length,
  });
  return {
    schemaVersion: 1,
    id: `evaluation-${hash({ config, dataset: dataset.id, startedAt }).slice(0, 16)}`,
    kind: config.kind,
    status: completed === assigned ? "completed" : "incomplete",
    startedAt,
    finishedAt: new Date().toISOString(),
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    datasetHash: hash(dataset),
    expectedHash: hash(expected),
    labelApproval: expected.approval,
    config: structuredClone(config),
    assigned,
    executed: results.filter((r) => r.status !== "unexecuted").length,
    completed,
    succeeded,
    failed: results.filter((r) => r.status === "failed").length,
    aborted: results.filter((r) => r.status === "aborted").length,
    unexecuted: results.filter((r) => r.status === "unexecuted").length,
    successRate: succeeded / assigned,
    completedSuccessRate: completed ? succeeded / completed : null,
    safetyFailures: results.filter((r) => r.safetyFailure).length,
    cost: sumKnown("cost"),
    knownCost: results.reduce((s, r) => s + (r.cost ?? 0), 0),
    knownCostCases: results.filter((r) => r.cost !== null).length,
    costUnit: "USD",
    tokens: sumKnown("tokens"),
    maintenanceCost: config.maintenanceCost ?? null,
    conditions: Object.fromEntries(
      CONDITIONS.map((c) => [
        c,
        counts(results.filter((r) => r.condition === c)),
      ]),
    ),
    benefit: "미확인",
    limits: [
      "합성 익명 회귀 자료이며 실제 업무 정답·회사 승인 아님",
      "짧은 독립 고정 라벨 채점은 의미적 근거 지지의 인간 검토를 대체하지 않음",
      "작은 표본으로 통계적 개선·출시·후속 업무 효과를 주장하지 않음",
      "위키 미사용도 동일 raw_lookup 원본 접근 허용; 검색/영속 위키 문맥만 다름",
      "실제 모델/도구 비용 미확인 값은 null, 미실행은 별도 기록",
      "정적 위키 대조군 및 운영 통합/보안 인수는 별도 평가 필요",
    ],
    results,
  };
}
