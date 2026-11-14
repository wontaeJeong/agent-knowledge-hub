import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageReader } from "./usage.mjs";
test("actual usage separates maintenance, query and unknown cost", async () => {
  const rows = [
    {
      operation: "ingest",
      cost_usd: "0.25",
      input_tokens: "10",
      output_tokens: "5",
    },
    {
      operation: "query",
      cost_usd: "0.10",
      input_tokens: "4",
      output_tokens: "2",
    },
  ];
  const pool = {
    query: async (q) =>
      q.startsWith("SELECT coalesce") ? { rows: [{ id: "10" }] } : { rows },
  };
  const usage = createUsageReader({
    pool,
    workspaceId: "w",
    principalId: "p",
    exclusiveWorkspace: true,
  });
  assert.equal(await usage.mark(), "10");
  const r = await usage.since("10");
  assert.equal(r.maintenanceCost, 0.25);
  assert.equal(r.queryCost, 0.1);
  assert.equal(r.totalCost, 0.35);
  assert.equal(r.calls, 2);
  rows[0].cost_usd = null;
  assert.equal((await usage.since("10")).maintenanceCost, null);
  assert.equal((await usage.since("10")).totalCost, null);
});
test("usage attribution requires an explicitly isolated evaluation workspace", () => {
  assert.throws(
    () =>
      createUsageReader({
        pool: { query: async () => ({ rows: [] }) },
        workspaceId: "w",
        principalId: "p",
      }),
    /EVALUATION_ISOLATION_REQUIRED/,
  );
});
