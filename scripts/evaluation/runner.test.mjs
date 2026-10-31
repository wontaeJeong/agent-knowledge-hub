import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runEvaluation } from "./runner.mjs";
import { renderReport } from "./report.mjs";
const dataset = JSON.parse(
  await readFile(
    new URL("./fixtures/knowledge-evolution.v1.json", import.meta.url),
  ),
);
const expected = JSON.parse(
  await readFile(new URL("./fixtures/expected.v1.json", import.meta.url)),
);
const config = {
  model: "fixture-not-real",
  provider: "injected-fixture",
  seed: 7,
  repeats: 1,
  budget: { calls: 2, maxTokens: 2000, timeoutMs: 1000 },
  tools: ["raw_lookup"],
  appCommit: "fixture",
  rulesVersion: "agent-knowledge-hub/2",
  promptVersion: "eval/1",
  wikiVersion: "fixture-v1",
  kind: "structural-fixture",
};
test("heldout expected answers never reach agent; paired conditions use identical budgets/tools/model", async () => {
  const seen = [];
  const report = await runEvaluation({
    dataset,
    expected,
    config,
    agent: async (input, tools) => {
      seen.push(input);
      assert.equal(JSON.stringify(input).includes("expectedAnswer"), false);
      assert.equal(JSON.stringify(input).includes("evaluator-secret"), false);
      assert.deepEqual(input.budget, config.budget);
      assert.deepEqual(input.tools, config.tools);
      const raw = await tools.raw_lookup("s1");
      assert.equal(raw.id, "s1");
      return {
        answer: "보류",
        abstained: true,
        citations: [],
        usage: { cost: null, tokens: null },
      };
    },
  });
  assert.equal(seen.length, dataset.tasks.length * 3);
  assert.equal(report.assigned, dataset.tasks.length * 3);
  assert.equal(report.cost, null);
  assert.equal(report.benefit, "미확인");
  assert.equal(report.completed, report.assigned);
  assert.equal(new Set(seen.map((s) => s.condition)).size, 3);
  assert.equal(
    seen
      .filter((s) => s.condition === "no-wiki")
      .every((s) => s.context.length === 0),
    true,
  );
  assert.equal(
    seen
      .filter((s) => s.condition === "persistent-wiki")
      .every((s) => s.context.some((c) => c.kind === "wiki")),
    true,
  );
  assert.equal(JSON.stringify(report).includes("evaluator-secret"), false);
});
test("failed/unexecuted tasks stay in denominator; unknown cost stays unknown", async () => {
  let calls = 0;
  const report = await runEvaluation({
    dataset,
    expected,
    config,
    agent: async () => {
      calls++;
      throw Error("private-key-do-not-log");
    },
    signal: AbortSignal.abort(),
  });
  assert.equal(calls, 0);
  assert.equal(report.unexecuted, report.assigned);
  assert.equal(report.successRate, 0);
  assert.equal(report.status, "incomplete");
  assert.equal(report.cost, null);
  const failed = await runEvaluation({
    dataset,
    expected,
    config,
    agent: async () => {
      throw Error("private-key-do-not-log");
    },
  });
  assert.equal(failed.failed, failed.assigned);
  assert.equal(JSON.stringify(failed).includes("private-key"), false);
});
test("independent withheld labels score output, fake citations are safety failures", async () => {
  const report = await runEvaluation({
    dataset,
    expected,
    config,
    agent: async (input) => ({
      answer: expected.answers.find((e) => e.taskId === input.task.id)
        .expectedAnswer,
      abstained: false,
      citations: [{ sourceId: "hidden", version: "v1", quote: "fake" }],
    }),
  });
  assert.equal(report.succeeded, 0);
  assert.equal(report.safetyFailures, report.assigned);
  assert.equal(expected.answers.length, dataset.tasks.length);
  for (let i = 1; i <= 8; i++)
    assert.ok(dataset.tasks.some((t) => t.scenario === `KE-0${i}`));
});
test("report uses Korean limits, explicit denominators, accessible tables and escapes data", async () => {
  const report = await runEvaluation({
    dataset,
    expected,
    config,
    agent: async () => ({
      answer: "<script>alert(1)</script>",
      abstained: true,
      citations: [],
    }),
  });
  const html = renderReport(report);
  assert.ok(html.includes('lang="ko"'));
  assert.ok(html.includes("실제 효과 미확인"));
  assert.ok(html.includes('scope="col"'));
  assert.ok(html.includes('tabindex="0"'));
  assert.ok(!html.includes("<script>"));
});
test("timeouts and unavailable raw sources cannot produce success or hide incomplete assignments", async () => {
  const fast = { ...config, budget: { ...config.budget, timeoutMs: 5 } };
  const report = await runEvaluation({
    dataset,
    expected,
    config: fast,
    agent: async (_input, tools) => {
      await assert.rejects(
        tools.raw_lookup("future-or-revoked-source"),
        /NOT_FOUND/,
      );
      return new Promise(() => {});
    },
  });
  assert.equal(report.aborted, report.assigned);
  assert.equal(report.succeeded, 0);
  assert.equal(report.status, "incomplete");
});
