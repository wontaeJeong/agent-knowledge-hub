import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseGate, rollbackGate } from "./operations-release.mjs";
const image = "registry.example/akh@sha256:" + "a".repeat(64);
test("release checks existing production validator before schema inspection; no backup no promotion", async () => {
  let checks = 0;
  const request = {
    resources: [],
    image,
    backup: { verifiedAt: new Date().toISOString(), checksum: "a".repeat(64) },
    pool: {
      query: async () => {
        checks++;
        throw Error("database unavailable");
      },
    },
  };
  await assert.rejects(releaseGate(request), /PRODUCTION/);
  assert.equal(checks, 0);
  await assert.rejects(
    releaseGate({ ...request, image: "latest" }),
    /IMMUTABLE/,
  );
});
test("rollback rejects incompatible migrations and never performs inferred down migration", () => {
  assert.throws(
    () =>
      rollbackGate({
        image,
        current: [{ version: 25, hash: "a" }],
        compatible: [{ version: 24, hash: "b" }],
      }),
    /INCOMPATIBLE/,
  );
  assert.equal(
    rollbackGate({
      image,
      current: [{ version: 25, hash: "a" }],
      compatible: [{ version: 25, hash: "a" }],
    }).databaseRollback,
    false,
  );
});
