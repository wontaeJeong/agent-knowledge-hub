import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEvolution,
  measureReview,
  validateIsolation,
} from "./evolution.mjs";

const snapshots = [0, 1, 2].map((i) => ({
  stage: i,
  sources: Array.from({ length: i + 1 }, (_, j) => ({
    id: `s${j}`,
    version: "v1",
    content: `source ${j}`,
  })),
  wiki: [{ id: "topic", version: i + 1, content: `knowledge ${i}` }],
  maintenance: { cost: i === 1 ? null : 0.1 },
}));
const heldout = [0, 1, 2].map((i) => ({
  id: `h${i}`,
  stage: i,
  prompt: `heldout question ${i}`,
}));
const expected = {
  withheldMarker: "PRIVATE_LABEL_MARKER",
  answers: heldout.map((t) => ({
    taskId: t.id,
    expectedAnswer: "yes",
    alternatives: [],
    requiresCitation: false,
  })),
};
const config = {
  model: "fixture",
  provider: "fixture",
  budget: { calls: 2, maxTokens: 100, timeoutMs: 20 },
  seed: 1,
  repeats: 1,
};
test("all arms receive same authorized raw and budget while static wiki stays at stage zero", async () => {
  const seen = [];
  const result = await evaluateEvolution({
    snapshots,
    heldout,
    expected,
    config,
    agent: async (input) => {
      seen.push(input);
      return {
        answer: "yes",
        abstained: false,
        citations: [],
        usage: { cost: 0.02, tokens: 3 },
      };
    },
  });
  assert.equal(result.assigned, 9);
  assert.equal(result.succeeded, 9);
  assert.equal(result.benefit, "미확인");
  for (let i = 0; i < 3; i++) {
    const group = seen.filter((x) => x.task.stage === i);
    assert.equal(group.length, 3);
    assert.ok(
      group.every(
        (x) =>
          JSON.stringify(x.sources) === JSON.stringify(snapshots[i].sources),
      ),
    );
    assert.ok(
      group.every(
        (x) => JSON.stringify(x.budget) === JSON.stringify(config.budget),
      ),
    );
    assert.equal(group.find((x) => x.condition === "raw").wiki.length, 0);
    assert.deepEqual(
      group.find((x) => x.condition === "static").wiki,
      snapshots[0].wiki,
    );
    assert.deepEqual(
      group.find((x) => x.condition === "maintained").wiki,
      snapshots[i].wiki,
    );
  }
  assert.equal(JSON.stringify(seen).includes("PRIVATE_LABEL_MARKER"), false);
  assert.equal(JSON.stringify(seen).includes("expectedAnswer"), false);
  assert.equal(result.maintenanceCost, null);
  assert.ok(Math.abs(result.evaluationCost - 0.18) < 1e-9);
});
test("failed and timed-out assignments remain in denominators and unknown cost is not zero", async () => {
  let n = 0;
  const result = await evaluateEvolution({
    snapshots,
    heldout,
    expected,
    config,
    agent: async () => {
      n++;
      if (n === 1) throw Error("broken");
      if (n === 2) return new Promise(() => {});
      return {
        answer: "yes",
        abstained: false,
        citations: [],
        usage: { cost: null, tokens: null },
      };
    },
  });
  assert.equal(result.assigned, 9);
  assert.equal(result.completed, 7);
  assert.equal(result.failed, 1);
  assert.equal(result.timedOut, 1);
  assert.equal(result.successRate, 7 / 9);
  assert.equal(result.evaluationCost, null);
  assert.equal(result.status, "incomplete");
});
test("heldout task or secret labels in maintenance material fail before use", () => {
  assert.throws(
    () =>
      validateIsolation(
        [{ sourceIds: ["s"], material: "heldout question 0" }],
        heldout,
        expected,
      ),
    /HELDOUT_LEAKAGE/,
  );
  assert.throws(
    () =>
      validateIsolation(
        [{ sourceIds: ["s"], material: "PRIVATE_LABEL_MARKER" }],
        heldout,
        expected,
      ),
    /HELDOUT_LEAKAGE/,
  );
});
test("human work requires exactly one explicit ordered start/end and rejects duplicate events", () => {
  const start = {
    kind: "start",
    at: "2026-01-01T00:00:01.000Z",
    actor: "human",
    actorId: "reviewer",
  };
  const end = {
    kind: "end",
    at: "2026-01-01T00:00:03.000Z",
    actor: "human",
    actorId: "reviewer",
  };
  assert.equal(measureReview([start, end]).workMs, 2000);
  assert.equal(measureReview([start]).workMs, null);
  assert.equal(measureReview([start, start, end]).workMs, null);
  assert.equal(measureReview([end, start]).workMs, null);
  assert.equal(
    measureReview([{ ...start, actor: "system" }, end]).workMs,
    null,
  );
});
test("repeated citations from one raw origin count as one evidence root and preserve old-answer regression", async () => {
  const tasks = [
    { id: "old", stage: 0, family: "f", prompt: "old question" },
    { id: "later", stage: 2, family: "f", prompt: "later question" },
  ];
  const labels = {
    withheldMarker: "PRIVATE_LABEL_MARKER",
    answers: tasks.map((t) => ({
      taskId: t.id,
      expectedAnswer: "yes",
      alternatives: [],
      requiresCitation: true,
    })),
  };
  const r = await evaluateEvolution({
    snapshots,
    heldout: tasks,
    expected: labels,
    config,
    agent: async (input) => ({
      answer: input.task.id === "old" ? "yes" : "no",
      abstained: false,
      citations: [
        { sourceId: "s0", version: "v1", quote: "source 0" },
        { sourceId: "s0", version: "v1", quote: "source 0" },
      ],
      usage: { cost: 0, tokens: 2 },
    }),
  });
  assert.equal(r.results[0].citedSourceRoots, 1);
  assert.equal(r.results[0].citationIntegrity.total, 1);
  assert.equal(r.results[0].citationIntegrity.valid, 1);
  assert.equal(r.results[0].independentSupport, null);
  assert.equal(r.conditions.raw.regressions, 1);
  assert.equal(r.conditions.static.regressions, 1);
  assert.equal(r.conditions.maintained.regressions, 1);
});
test("start and end from different human identities cannot produce work time", () => {
  assert.equal(
    measureReview([
      {
        kind: "start",
        at: "2026-01-01T00:00:01.000Z",
        actor: "human",
        actorId: "one",
      },
      {
        kind: "end",
        at: "2026-01-01T00:00:03.000Z",
        actor: "human",
        actorId: "two",
      },
    ]).workMs,
    null,
  );
});
test("label-shaped fields cannot enter maintenance input", () => {
  assert.throws(
    () =>
      validateIsolation(
        [{ sourceIds: ["s"], metadata: { expectedAnswer: "secret" } }],
        heldout,
        expected,
      ),
    /HELDOUT_LEAKAGE/,
  );
});
test("heldout task records cannot smuggle labels into model inputs", async () => {
  const contaminated = heldout.map((t, i) =>
    i === 0 ? { ...t, expectedAnswer: "yes" } : t,
  );
  await assert.rejects(
    evaluateEvolution({
      snapshots,
      heldout: contaminated,
      expected,
      config,
      agent: async () => {
        throw Error("must not call");
      },
    }),
    /HELDOUT_LEAKAGE/,
  );
});
test("invalid holdout labels or unbounded budget fail preflight", async () => {
  const { validatePlan } = await import("./evolution.mjs");
  assert.throws(
    () =>
      validatePlan(snapshots, heldout, { ...expected, answers: [] }, config),
    /EVALUATION_LABELS_INVALID/,
  );
  assert.throws(
    () =>
      validatePlan(
        snapshots,
        heldout,
        {
          ...expected,
          answers: expected.answers.map((a, i) =>
            i ? a : { ...a, alternatives: "invalid" },
          ),
        },
        config,
      ),
    /EVALUATION_LABELS_INVALID/,
  );
  assert.throws(
    () =>
      validatePlan(snapshots, heldout, expected, {
        ...config,
        budget: { ...config.budget, calls: 1000000 },
      }),
    /EVALUATION_CONFIG_INVALID/,
  );
});
test("an agent cannot alter sealed raw sources to validate a fabricated citation", async () => {
  const r = await evaluateEvolution({
    snapshots,
    heldout,
    expected,
    config,
    agent: async (input) => {
      input.sources[0].content = "forged";
      return {
        answer: "yes",
        abstained: false,
        citations: [{ sourceId: "s0", version: "v1", quote: "forged" }],
        usage: { cost: 0, tokens: 1 },
      };
    },
  });
  assert.equal(r.succeeded, 0);
  assert.equal(r.results.filter((x) => x.safetyFailure).length, r.assigned);
});
test("duplicate or out-of-order stage assignments are rejected", async () => {
  const { validatePlan } = await import("./evolution.mjs");
  assert.throws(
    () =>
      validatePlan(
        [snapshots[0], snapshots[2], snapshots[1]],
        heldout,
        expected,
        config,
      ),
    /EVALUATION_DATASET_INVALID/,
  );
  assert.throws(
    () =>
      validatePlan(
        [snapshots[0], snapshots[1], snapshots[1]],
        heldout,
        expected,
        config,
      ),
    /EVALUATION_DATASET_INVALID/,
  );
});
