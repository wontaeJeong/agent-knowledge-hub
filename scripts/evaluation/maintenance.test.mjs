import { test } from "node:test";
import assert from "node:assert/strict";
import { runMaintenance } from "./maintenance.mjs";
const sources = [0, 1, 2].map((i) => ({
  id: `s${i}`,
  version: "v1",
  content: `source ${i}`,
}));
const stages = sources.map((s, i) => ({
  stage: i,
  sourceIds: [s.id],
  operationalQuestion: "maintenance only",
}));
const heldout = [{ id: "h", stage: 2, prompt: "private heldout question" }],
  expected = { withheldMarker: "secret-marker", answers: [] };
test("runs three actual maintenance stages and freezes the first snapshot", async () => {
  let version = 0;
  const calls = [];
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    sources: async () => sources,
    usageMark: async () => 0,
    usageSince: async () => ({ cost: 0.3 }),
    ingest: async (ids) => {
      calls.push(["ingest", ids]);
      return { id: `b${version}`, hash: "hash" };
    },
    review: async () => ({ decision: "approve", events: [] }),
    approve: async () => calls.push(["approve"]),
    publish: async () => {
      version++;
      return { versions: { topic: version } };
    },
    query: async () => {
      calls.push(["query"]);
      return { id: "a" };
    },
    lint: async () => {
      calls.push(["lint"]);
      return { issues: [] };
    },
    pages: async () => [{ id: "topic", version, content: `v${version}` }],
    reject: async () => {
      throw Error("unexpected");
    },
  };
  const result = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.snapshots.map((s) => s.wiki[0].version),
    [1, 2, 3],
  );
  assert.equal(calls.filter((x) => x[0] === "ingest").length, 3);
  assert.equal(calls.filter((x) => x[0] === "query").length, 3);
  assert.equal(calls.filter((x) => x[0] === "lint").length, 3);
  assert.equal(result.cycles[0].reviewWorkMs, null);
});
test("leaked holdout stops before ingestion and failed stage remains incomplete", async () => {
  let ingests = 0;
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    pages: async () => [],
    sources: async () => sources,
    usageMark: async () => 0,
    usageSince: async () => ({ cost: null }),
    ingest: async () => {
      ingests++;
      throw Error("MODEL_FAILED");
    },
  };
  await assert.rejects(
    runMaintenance({
      driver: d,
      stages: stages.map((s, i) =>
        i ? s : { ...s, operationalQuestion: heldout[0].prompt },
      ),
      heldout,
      expected,
      model: "fixture",
    }),
    /HELDOUT_LEAKAGE/,
  );
  assert.equal(ingests, 0);
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.status, "incomplete");
  assert.equal(r.cycles[0].status, "failed");
  assert.equal(r.cycles[1].status, "unexecuted");
  assert.equal(r.cycles.length, 3);
});
test("runtime model and actor verification precede any maintenance write", async () => {
  let count = 0;
  const d = {
    sources: async () => sources,
    pages: async () => [],
    verifyModel: async () => {
      throw Error("MODEL_MISMATCH");
    },
    verifyActors: async () => {},
    ingest: async () => {
      count++;
    },
  };
  await assert.rejects(
    runMaintenance({ driver: d, stages, heldout, expected, model: "expected" }),
    /MODEL_MISMATCH/,
  );
  assert.equal(count, 0);
});
test("maintenance timeout stops later cycles and remains incomplete", async () => {
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    sources: async () => sources,
    pages: async () => [],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: null, queryCost: null }),
    ingest: async () => new Promise(() => {}),
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
    modelTimeoutMs: 5,
  });
  assert.equal(r.cycles[0].status, "timed-out");
  assert.equal(r.cycles[0].reconciliationRequired, true);
  assert.equal(r.cycles[1].status, "unexecuted");
  assert.equal(r.status, "incomplete");
});
test("driver identity must match the policy-bound evaluation principal before writes", async () => {
  let writes = 0;
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({
      workspaceId: "other",
      editor: "e",
      reviewer: "r",
    }),
    sources: async () => sources,
    pages: async () => [],
    ingest: async () => {
      writes++;
    },
  };
  await assert.rejects(
    runMaintenance({
      driver: d,
      stages,
      heldout,
      expected,
      model: "fixture",
      expectedIdentity: { workspaceId: "w", principalId: "e" },
    }),
    /EVALUATION_IDENTITIES_INVALID/,
  );
  assert.equal(writes, 0);
});
test("records rejected, reproposed and rereviewed attempts with explicit reviewer events", async () => {
  let n = 0;
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({
      workspaceId: "w",
      editor: "e",
      reviewer: "r",
    }),
    sources: async () => sources,
    pages: async () => [{ id: "p", version: 1, content: "x" }],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: 0, queryCost: 0 }),
    ingest: async () => ({ id: `b${++n}`, hash: "h" }),
    review: async ({ attempt }) => {
      const at = new Date().toISOString();
      return {
        decision: attempt === 1 ? "reject" : "approve",
        events: [
          { kind: "start", actor: "human", actorId: "r", at },
          { kind: "end", actor: "human", actorId: "r", at },
        ],
      };
    },
    reject: async () => {},
    approve: async () => {},
    publish: async () => ({ versions: { p: 1 } }),
    query: async () => ({ id: "answer" }),
    lint: async () => ({ issues: [] }),
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.status, "completed");
  assert.deepEqual(
    r.cycles[0].attempts.map((a) => a.decision),
    ["reject", "approve"],
  );
  assert.equal(r.cycles[0].reviewWorkMs, 0);
  assert.equal(r.cycles[0].attempts.length, 2);
});
test("summary exposes review rejections and unknown work instead of inferred zero", async () => {
  let n = 0;
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({
      workspaceId: "w",
      editor: "e",
      reviewer: "r",
    }),
    sources: async () => sources,
    pages: async () => [{ id: "p", version: 1, content: "x" }],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: null, queryCost: null }),
    ingest: async () => ({ id: `b${++n}`, hash: "h" }),
    review: async ({ attempt }) => ({
      decision: attempt === 1 ? "reject" : "approve",
      events: [],
    }),
    reject: async () => {},
    approve: async () => {},
    publish: async () => ({ versions: { p: 1 } }),
    query: async () => ({ id: "answer" }),
    lint: async () => ({ issues: [] }),
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.reviewSummary.rejected, 3);
  assert.equal(r.reviewSummary.reproposed, 3);
  assert.equal(r.reviewSummary.reviewed, 6);
  assert.equal(r.reviewSummary.workMs, null);
  assert.equal(r.reviewSummary.measuredAttempts, 0);
});
test("future reviewer events are unmeasured even when paired", async () => {
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({ reviewer: "r" }),
    sources: async () => sources,
    pages: async () => [{ id: "p", version: 1, content: "x" }],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: null, queryCost: null }),
    ingest: async () => ({ id: "b", hash: "h" }),
    review: async () => ({
      decision: "approve",
      events: [
        {
          kind: "start",
          actor: "human",
          actorId: "r",
          at: "2999-01-01T00:00:00.000Z",
        },
        {
          kind: "end",
          actor: "human",
          actorId: "r",
          at: "2999-01-01T00:01:00.000Z",
        },
      ],
    }),
    approve: async () => {},
    publish: async () => ({ versions: { p: 1 } }),
    query: async () => ({ id: "answer" }),
    lint: async () => ({ issues: [] }),
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.reviewSummary.workMs, null);
  assert.equal(r.reviewSummary.waitMs, null);
});
test("pre-aborted experiment schedules no maintenance writes", async () => {
  let n = 0;
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    sources: async () => sources,
    pages: async () => [],
    ingest: async () => {
      n++;
    },
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
    signal: AbortSignal.abort(),
  });
  assert.equal(n, 0);
  assert.equal(r.cycles.filter((c) => c.status === "unexecuted").length, 3);
});
test("a post-publication query failure records completed writes and requires reconciliation", async () => {
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    sources: async () => sources,
    pages: async () => [],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: null, queryCost: null }),
    ingest: async () => ({ id: "b", hash: "h" }),
    review: async () => ({ decision: "approve", events: [] }),
    approve: async () => {},
    publish: async () => ({ versions: { p: 2 } }),
    query: async () => {
      throw Error("MODEL_FAILED");
    },
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.cycles[0].status, "failed");
  assert.deepEqual(r.cycles[0].versions, { p: 2 });
  assert.equal(r.cycles[0].reconciliationRequired, true);
  assert.equal(r.cycles[1].status, "unexecuted");
});
test("a failed review submission is not recorded as an accepted approval", async () => {
  const d = {
    verifyModel: async () => {},
    verifyActors: async () => ({}),
    sources: async () => sources,
    pages: async () => [],
    usageMark: async () => 0,
    usageSince: async () => ({ maintenanceCost: null, queryCost: null }),
    ingest: async () => ({ id: "b", hash: "h" }),
    review: async () => ({ decision: "approve", events: [] }),
    approve: async () => {
      throw Error("FORBIDDEN");
    },
  };
  const r = await runMaintenance({
    driver: d,
    stages,
    heldout,
    expected,
    model: "fixture",
  });
  assert.equal(r.cycles[0].attempts[0].actionStatus, "failed");
  assert.equal(r.reviewSummary.accepted, 0);
});
