import { createHash } from "node:crypto";
/** Read-only comparison of real, independently captured published snapshots. */
export const EVOLUTION_CONDITIONS = Object.freeze([
  "raw",
  "static",
  "maintained",
]);
export function validateIsolation(stages, heldout, expected) {
  if (
    !Array.isArray(stages) ||
    !Array.isArray(heldout) ||
    !expected?.withheldMarker
  )
    throw Error("EVALUATION_DATASET_INVALID");
  if (typeof expected.withheldMarker !== "string")
    throw Error("EVALUATION_DATASET_INVALID");
  const prompts = heldout.map((task) => {
    if (typeof task.prompt !== "string" || !task.prompt.trim())
      throw Error("HELDOUT_LEAKAGE");
    return task.prompt;
  });
  const contains = (value, needles, inspectLabels = true) => {
    if (typeof value === "string")
      return needles.some((needle) => value.includes(needle));
    if (Array.isArray(value))
      return value.some((item) => contains(item, needles, inspectLabels));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, item]) =>
        (inspectLabels &&
          /^(answer|answers|label|labels|groundTruth|correctAnswer|expectedAnswer|expectedAbstained|alternatives|withheldMarker|solution)$/i.test(
            key,
          )) ||
        needles.some((needle) => key.includes(needle)) ||
        contains(item, needles, inspectLabels),
    );
  };
  if (
    contains(stages, [expected.withheldMarker, ...prompts]) ||
    contains(heldout, [expected.withheldMarker])
  )
    throw Error("HELDOUT_LEAKAGE");
}
/** Explicit human start/end events only; malformed or duplicate events remain unmeasured. */
export function measureReview(events) {
  if (
    !Array.isArray(events) ||
    events.length !== 2 ||
    events[0]?.kind !== "start" ||
    events[1]?.kind !== "end" ||
    events.some(
      (e) => e.actor !== "human" || typeof e.actorId !== "string" || !e.actorId,
    ) ||
    events[0].actorId !== events[1].actorId
  )
    return { workMs: null };
  const start = Date.parse(events[0].at),
    end = Date.parse(events[1].at);
  return {
    workMs:
      Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? end - start
        : null,
  };
}
const costOf = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const sum = (values) =>
  values.every((v) => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = (s) =>
  String(s)
    .trim()
    .replace(/[.!。]+$/, "");
export function validatePlan(snapshots, heldout, expected, config) {
  validateIsolation(snapshots, heldout, expected);
  if (
    !Array.isArray(snapshots) ||
    snapshots.length < 3 ||
    snapshots.length > 100 ||
    !Array.isArray(expected.answers) ||
    !heldout.length ||
    heldout.length > 1000 ||
    !config?.model ||
    !config.provider ||
    !Number.isInteger(config.repeats) ||
    config.repeats < 1 ||
    config.repeats > 100 ||
    !Number.isInteger(config.seed) ||
    !Number.isInteger(config.budget?.calls) ||
    config.budget.calls < 1 ||
    config.budget.calls > 20 ||
    !Number.isInteger(config.budget.maxTokens) ||
    config.budget.maxTokens < 1 ||
    config.budget.maxTokens > 100000 ||
    !Number.isFinite(config.budget.timeoutMs) ||
    config.budget.timeoutMs < 1 ||
    config.budget.timeoutMs > 300000
  )
    throw Error("EVALUATION_CONFIG_INVALID");
  if (
    snapshots.some(
      (s, i) =>
        !Number.isInteger(s.stage) ||
        s.stage < 0 ||
        (i > 0 && s.stage <= snapshots[i - 1].stage),
    )
  )
    throw Error("EVALUATION_DATASET_INVALID");
  if (
    heldout.some(
      (t) =>
        typeof t.id !== "string" ||
        !t.id.trim() ||
        typeof t.prompt !== "string" ||
        !t.prompt.trim() ||
        t.prompt.length > 2000,
    ) ||
    expected.answers.some(
      (a) =>
        typeof a.taskId !== "string" ||
        typeof a.expectedAnswer !== "string" ||
        !Array.isArray(a.alternatives) ||
        a.alternatives.some((v) => typeof v !== "string") ||
        typeof a.requiresCitation !== "boolean" ||
        typeof a.expectedAbstained !== "boolean",
    ) ||
    new Set(heldout.map((t) => t.id)).size !== heldout.length ||
    expected.answers.length !== heldout.length ||
    new Set(expected.answers.map((a) => a.taskId)).size !== heldout.length ||
    heldout.some(
      (t) =>
        !snapshots.some((s) => s.stage === t.stage) ||
        !expected.answers.some((a) => a.taskId === t.id),
    )
  )
    throw Error("EVALUATION_LABELS_INVALID");
}
export async function evaluateEvolution({
  snapshots,
  heldout,
  expected,
  config,
  agent,
  signal,
}) {
  validatePlan(snapshots, heldout, expected, config);
  if (typeof agent !== "function") throw Error("EVALUATION_CONFIG_INVALID");
  const startedAt = new Date().toISOString();
  const first = snapshots[0];
  const results = [];
  for (let repeat = 0; repeat < config.repeats; repeat++)
    for (const [index, task] of heldout.entries()) {
      const snap = snapshots.find((s) => s.stage === task.stage);
      const label = expected.answers.find((a) => a.taskId === task.id);
      const offset = (((config.seed + repeat + index) % 3) + 3) % 3;
      for (let i = 0; i < 3; i++) {
        const condition = EVOLUTION_CONDITIONS[(i + offset) % 3];
        const base = {
          taskId: task.id,
          scenario: task.scenario ?? null,
          stage: task.stage,
          repeat,
          condition,
          expectedAbstained: label.expectedAbstained,
          success: false,
          cost: null,
          tokens: null,
          durationMs: null,
        };
        if (signal?.aborted || !snap?.sources || !snap?.wiki || !first?.wiki) {
          results.push({ ...base, status: "unexecuted" });
          continue;
        }
        const sources = structuredClone(snap.sources),
          wiki = structuredClone(
            condition === "raw"
              ? []
              : condition === "static"
                ? first.wiki
                : snap.wiki,
          );
        const input = {
          task: structuredClone(task),
          condition,
          model: config.model,
          seed: config.seed,
          budget: structuredClone(config.budget),
          tools: ["raw_lookup"],
          sources,
          wiki,
          context: [...sources, ...wiki],
          availableSourceIds: sources.map((s) => s.id),
          promptVersion: config.promptVersion ?? "evolution/1",
          rulesVersion: config.rulesVersion ?? "agent-knowledge-hub/2",
          policy: "Read only; evaluation answers cannot be filed.",
        };
        const started = performance.now();
        const inputVersions = {
          sources: sources.map((s) => ({ id: s.id, version: s.version })),
          pages: wiki.map((w) => ({ id: w.id, version: w.version })),
        };
        let partialUsage = {
          knownCost: 0,
          knownTokens: 0,
          pricedCalls: 0,
          tokenCalls: 0,
        };
        const onUsage = (usage) => {
          if (
            usage &&
            Number.isFinite(usage.knownCost) &&
            usage.knownCost >= 0 &&
            Number.isSafeInteger(usage.knownTokens) &&
            usage.knownTokens >= 0 &&
            Number.isSafeInteger(usage.pricedCalls) &&
            usage.pricedCalls >= 0 &&
            Number.isSafeInteger(usage.tokenCalls) &&
            usage.tokenCalls >= 0
          )
            partialUsage = { ...usage };
        };
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.budget.timeoutMs);
        try {
          const aborted = new Promise((_, reject) =>
            controller.signal.addEventListener(
              "abort",
              () => reject(Error("ABORTED")),
              { once: true },
            ),
          );
          const output = await Promise.race([
            agent(
              structuredClone(input),
              {
                raw_lookup: async (id) => {
                  const source = sources.find((s) => s.id === id);
                  if (!source) throw Error("NOT_FOUND");
                  return structuredClone(source);
                },
              },
              controller.signal,
              onUsage,
            ),
            aborted,
          ]);
          if (
            !output ||
            typeof output.answer !== "string" ||
            typeof output.abstained !== "boolean" ||
            !Array.isArray(output.citations)
          )
            throw Error("OUTPUT_INVALID");
          const uniqueCitations = [
            ...new Map(
              output.citations.map((c) => [
                JSON.stringify([c.sourceId, c.version, c.quote]),
                c,
              ]),
            ).values(),
          ];
          const validCitation = (c) =>
            sources.some(
              (s) =>
                s.id === c.sourceId &&
                s.version === c.version &&
                typeof c.quote === "string" &&
                c.quote.length > 0 &&
                s.content.includes(c.quote),
            );
          const citationIntegrity = {
            total: uniqueCitations.length,
            valid: uniqueCitations.filter(validCitation).length,
            semanticSupport: null,
          };
          const safetyFailure =
            citationIntegrity.total !== citationIntegrity.valid;
          const success =
            !safetyFailure &&
            output.abstained === label.expectedAbstained &&
            [label.expectedAnswer, ...(label.alternatives ?? [])]
              .map(normalize)
              .includes(normalize(output.answer)) &&
            (!label.requiresCitation || output.citations.length > 0);
          const roots = new Set(
            output.citations.flatMap((c) => {
              const source = sources.find(
                (s) =>
                  s.id === c.sourceId &&
                  s.version === c.version &&
                  typeof c.quote === "string" &&
                  c.quote.length > 0 &&
                  s.content.includes(c.quote),
              );
              return source
                ? [createHash("sha256").update(source.content).digest("hex")]
                : [];
            }),
          );
          results.push({
            ...base,
            status: "completed",
            answer: output.answer,
            abstained: output.abstained,
            expectedAbstained: label.expectedAbstained,
            abstentionCorrect: output.abstained === label.expectedAbstained,
            citations: output.citations,
            safetyFailure,
            citationIntegrity,
            citedSourceRoots: roots.size,
            independentSupport: null,
            knownCost: partialUsage.pricedCalls
              ? partialUsage.knownCost
              : costOf(output.usage?.cost),
            knownTokens: partialUsage.tokenCalls
              ? partialUsage.knownTokens
              : Number.isSafeInteger(output.usage?.tokens) &&
                  output.usage.tokens >= 0
                ? output.usage.tokens
                : null,
            pricedCalls:
              partialUsage.pricedCalls ||
              (costOf(output.usage?.cost) !== null ? 1 : 0),
            tokenCalls:
              partialUsage.tokenCalls ||
              (Number.isSafeInteger(output.usage?.tokens) &&
              output.usage.tokens >= 0
                ? 1
                : 0),
            inputVersions,
            durationMs: performance.now() - started,
            success,
            cost: costOf(output.usage?.cost),
            tokens:
              Number.isSafeInteger(output.usage?.tokens) &&
              output.usage.tokens >= 0
                ? output.usage.tokens
                : null,
          });
        } catch (error) {
          const code =
            error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
              ? error.message
              : "EXECUTION_FAILED";
          results.push({
            ...base,
            knownCost: partialUsage.pricedCalls ? partialUsage.knownCost : null,
            knownTokens: partialUsage.tokenCalls
              ? partialUsage.knownTokens
              : null,
            pricedCalls: partialUsage.pricedCalls,
            tokenCalls: partialUsage.tokenCalls,
            inputVersions,
            durationMs: performance.now() - started,
            status: timedOut
              ? "timed-out"
              : controller.signal.aborted
                ? "aborted"
                : "failed",
            errorCode: timedOut
              ? "TIMEOUT"
              : controller.signal.aborted
                ? "ABORTED"
                : code,
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
  const conditions = Object.fromEntries(
    EVOLUTION_CONDITIONS.map((condition) => {
      const rows = results.filter((r) => r.condition === condition);
      let regressionDenominator = 0,
        regressions = 0;
      for (let repeat = 0; repeat < config.repeats; repeat++)
        for (const family of new Set(
          heldout.map((t) => t.family).filter(Boolean),
        )) {
          const tasks = heldout
            .filter((t) => t.family === family)
            .sort((a, b) => a.stage - b.stage);
          for (let i = 1; i < tasks.length; i++) {
            const before = rows.find(
                (r) => r.repeat === repeat && r.taskId === tasks[i - 1].id,
              ),
              after = rows.find(
                (r) => r.repeat === repeat && r.taskId === tasks[i].id,
              );
            if (before?.success) {
              regressionDenominator++;
              if (!after?.success) regressions++;
            }
          }
        }
      return [
        condition,
        {
          assigned: rows.length,
          completed: rows.filter((r) => r.status === "completed").length,
          succeeded: rows.filter((r) => r.success).length,
          abstained: rows.filter((r) => r.abstained === true).length,
          expectedAbstentions: rows.filter((r) => r.expectedAbstained === true)
            .length,
          abstentionMismatches: rows.filter(
            (r) => r.abstentionCorrect === false,
          ).length,
          safetyFailures: rows.filter((r) => r.safetyFailure).length,
          regressionDenominator,
          regressions,
        },
      ];
    }),
  );
  const scenarios = Object.fromEntries(
    [...new Set(heldout.map((t) => t.scenario).filter(Boolean))].map(
      (scenario) => [
        scenario,
        Object.fromEntries(
          EVOLUTION_CONDITIONS.map((condition) => {
            const rows = results.filter(
              (r) => r.scenario === scenario && r.condition === condition,
            );
            return [
              condition,
              {
                assigned: rows.length,
                completed: rows.filter((r) => r.status === "completed").length,
                succeeded: rows.filter((r) => r.success).length,
              },
            ];
          }),
        ),
      ],
    ),
  );
  const evaluationCost = sum(results.map((r) => r.cost)),
    maintenanceCost = sum(snapshots.map((s) => costOf(s.maintenance?.cost))),
    operationalQueryCost = sum(
      snapshots.map((s) => costOf(s.maintenance?.queryCost)),
    );
  return {
    kind: "synthetic-or-unvalidated",
    startedAt: startedAt,
    finishedAt: new Date().toISOString(),
    labelApproval:
      typeof expected.approval === "string" ? expected.approval : "unapproved",
    snapshotHash: fingerprint(snapshots),
    heldoutHash: fingerprint(heldout),
    expectedHash: fingerprint(expected),
    config: {
      appCommit: config.appCommit ?? null,
      datasetVersion: config.datasetVersion ?? null,
      model: config.model,
      provider: config.provider,
      seed: config.seed,
      repeats: config.repeats,
      budget: structuredClone(config.budget),
      promptVersion: config.promptVersion ?? "evolution/1",
      rulesVersion: config.rulesVersion ?? "agent-knowledge-hub/2",
    },
    status: completed === assigned ? "completed" : "incomplete",
    assigned,
    completed,
    succeeded,
    failed: results.filter((r) => r.status === "failed").length,
    timedOut: results.filter((r) => r.status === "timed-out").length,
    aborted: results.filter((r) => r.status === "aborted").length,
    unexecuted: results.filter((r) => r.status === "unexecuted").length,
    successRate: succeeded / assigned,
    completedSuccessRate: completed ? succeeded / completed : null,
    safetyFailures: results.filter((r) => r.safetyFailure).length,
    abstained: results.filter((r) => r.abstained === true).length,
    expectedAbstentions: results.filter((r) => r.expectedAbstained === true)
      .length,
    abstentionMismatches: results.filter((r) => r.abstentionCorrect === false)
      .length,
    knownEvaluationCost: results.reduce((n, r) => n + (r.knownCost ?? 0), 0),
    knownEvaluationTokens: results.reduce(
      (n, r) => n + (r.knownTokens ?? 0),
      0,
    ),
    pricedEvaluationCalls: results.reduce(
      (n, r) => n + (r.pricedCalls ?? 0),
      0,
    ),
    measuredTokenCalls: results.reduce((n, r) => n + (r.tokenCalls ?? 0), 0),
    pricedEvaluationCases: results.filter((r) => r.cost !== null).length,
    evaluationCost,
    maintenanceCost,
    operationalQueryCost,
    totalCost: sum([evaluationCost, maintenanceCost, operationalQueryCost]),
    conditions,
    scenarios,
    benefit: "미확인",
    limits: [
      "합성 회귀는 실제 모델 품질이나 업무 개선의 증거가 아닙니다.",
      "정답과 평가 답변은 유지 지식에 재편입하지 않습니다.",
    ],
    results,
  };
}
