// Isolated database per invocation: never shares mutable migration state with other workers.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import YAML from "yaml";
const compose = YAML.parse(
  await readFile(new URL("../../compose.test.yaml", import.meta.url), "utf8"),
);
const e = compose.services["postgres-test"].environment;
const root = new pg.Client({
  host: "127.0.0.1",
  port: 55439,
  user: e.POSTGRES_USER,
  password: e.POSTGRES_PASSWORD,
  database: e.POSTGRES_DB,
});
await root.connect();
const name = "questions_" + randomUUID().replaceAll("-", "");
await root.query(`CREATE DATABASE "${name}"`);
try {
  const url = new URL(`postgresql://127.0.0.1:55439/${name}`);
  url.username = e.POSTGRES_USER;
  url.password = e.POSTGRES_PASSWORD;
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      ...(process.argv.slice(2).length
        ? process.argv.slice(2)
        : ["server/questions/service.test.ts"]),
      "--maxWorkers=1",
    ],
    { stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: url.href } },
  );
  process.exitCode = await new Promise((resolve) =>
    child.on("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  await root.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await root.end();
}
