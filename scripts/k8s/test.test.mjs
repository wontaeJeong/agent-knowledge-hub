import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { nativeKindSuites, staticSuites } from "./test.mjs";

test("static runner excludes only the explicit native Kind gate, not operations suites", () => {
  const names = readdirSync(new URL("./", import.meta.url));
  assert.deepEqual(nativeKindSuites, ["operations-backup-db.test.mjs"]);
  assert.deepEqual(staticSuites(names), names.filter((n) => n.endsWith(".test.mjs") &&
    n !== "operations-backup-db.test.mjs").sort());
  assert.ok(staticSuites(names).includes("operations-alert.test.mjs"));
  assert.ok(staticSuites(names).includes("release.test.mjs"));
});
