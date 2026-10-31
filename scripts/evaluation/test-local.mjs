// Local isolated fixture database only. Never prints the decoded credential.
import { execFileSync, spawnSync } from "node:child_process";
import pg from "pg";
const password = Buffer.from(
  execFileSync(
    "kubectl",
    [
      "--context",
      "kind-knowledge-hub-dev",
      "-n",
      "agent-knowledge-hub-local",
      "get",
      "secret",
      "knowledge-db-secret",
      "-o",
      "jsonpath={.data.password}",
    ],
    { encoding: "utf8" },
  ),
  "base64",
).toString();
const config = {
  host: "127.0.0.1",
  port: 55459,
  user: "knowledge",
  password,
  database: "postgres",
};
const admin = new pg.Client(config);
await admin.connect();
if (
  !(
    await admin.query(
      "SELECT 1 FROM pg_database WHERE datname='akh_refinement_test'",
    )
  ).rowCount
)
  await admin.query("CREATE DATABASE akh_refinement_test");
await admin.end();
const url = new URL("postgresql://127.0.0.1:55459/akh_refinement_test");
url.username = config.user;
url.password = password;
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "server/refinement",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url.href } },
);
process.exitCode = result.status ?? 1;
