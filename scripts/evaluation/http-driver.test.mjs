import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHttpDriver } from "./http-driver.mjs";
test("driver requires distinct explicit reviewer and exact model identity", async () => {
  const driver = createRuntimeHttpDriver({
    baseUrl: "http://localhost",
    editorHeaders: {},
    reviewerHeaders: {},
    review: async () => ({ decision: "approve" }),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "actual",
          provider: "litellm",
          configured: true,
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(driver.verifyModel("other"), /MODEL_MISMATCH/);
  await assert.rejects(
    driver.verifyModel("actual", "openai"),
    /MODEL_MISMATCH/,
  );
  await driver.verifyModel("actual", "litellm");
});
