import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";
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
const database = "akh_operations_test";
const admin = new pg.Pool({
  host: "127.0.0.1",
  port: 55459,
  user: "knowledge",
  password,
  database: "postgres",
});
try {
  // This exact database is the disposable operations fixture, never the live knowledge DB.
  if (
    (
      await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        database,
      ])
    ).rowCount
  )
    await admin.query(`DROP DATABASE ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(`postgresql://127.0.0.1:55459/${database}`);
  url.username = "knowledge";
  url.password = password;
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "server/operations",
      "--maxWorkers=1",
    ],
    { env: { ...process.env, TEST_DATABASE_URL: url.href }, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const backup = spawnSync(
      process.execPath,
      ["--test", "scripts/k8s/operations-backup-db.test.mjs"],
      {
        env: { ...process.env, TEST_DATABASE_URL: url.href },
        stdio: "inherit",
      },
    );
    process.exitCode = backup.status ?? 1;
  }
} finally {
  await admin.end();
}
