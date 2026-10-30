import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const context = "kind-knowledge-hub-dev",
  namespace = "agent-knowledge-hub-local";
const encoded = execFileSync(
  "kubectl",
  [
    "--context",
    context,
    "-n",
    namespace,
    "get",
    "secret",
    "knowledge-db-secret",
    "-o",
    "jsonpath={.data.password}",
  ],
  { encoding: "utf8" },
);
const password = Buffer.from(encoded, "base64").toString();
const database = `akh_operations_test_${randomBytes(8).toString("hex")}`;
const admin = new pg.Pool({
  host: "127.0.0.1",
  port: 55459,
  user: "knowledge",
  password,
  database: "postgres",
});
let created = false;
try {
  // New run-owned UUID database. Never drop/reset a pre-existing fixture or any live database.
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const url = new URL(`postgresql://127.0.0.1:55459/${database}`);
  url.username = "knowledge";
  url.password = password;
  const blobRoot = await mkdtemp(
    join(await realpath(tmpdir()), "akh-operations-all-blobs-"),
  );
  const testEnv = {
    ...process.env,
    TEST_DATABASE_URL: url.href,
    OPERATIONS_TEST_BLOB_ROOT: blobRoot,
  };
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "server/operations",
      "--maxWorkers=1",
    ],
    { env: testEnv, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const backup = spawnSync(
      process.execPath,
      ["--test", "scripts/k8s/operations-backup-db.test.mjs"],
      {
        env: testEnv,
        stdio: "inherit",
      },
    );
    process.exitCode = backup.status ?? 1;
  }
} finally {
  if (created && process.env.OPERATIONS_KEEP_TEST_DB !== "true")
    await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
}
