import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("migration CLI refuses to run without explicit database configuration", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/migrate.mts"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
});
