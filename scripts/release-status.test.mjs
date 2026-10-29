import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReleaseStatus } from "./release-status.mjs";
test("all 251 original acceptance rows remain visible and unproven rows never pass", () => {
  const baseline = JSON.parse(
    readFileSync("docs/requirements/requirements.json"),
  ).requirements;
  const core = JSON.parse(
    readFileSync("docs/requirements/core-requirements.json"),
  ).requirements;
  const result = buildReleaseStatus([...baseline, ...core], {
    "CORE-002": {
      implementation: ["server/service.ts"],
      tests: ["server/service.test.ts"],
      limitations: ["site acceptance pending"],
    },
  });
  assert.equal(result.items.length, 251);
  assert.equal(result.summary.productionAccepted, 0);
  assert.equal(
    result.items.find((r) => r.id === "CORE-002").implementationStatus,
    "부분 구현 근거 있음",
  );
  assert.equal(
    result.items.find((r) => r.id === "IAM-001").implementationStatus,
    "개별 구현·검증 근거 확인 필요",
  );
  for (let i = 0; i < baseline.length; i++)
    assert.equal(result.items[i].acceptance, baseline[i].acceptance);
});
