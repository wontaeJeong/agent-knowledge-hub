import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Pool } from "pg";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ownedName = /^akh_server_test_[a-f0-9]{32}$/;
export function databaseName(uuid = randomUUID()) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)
  )
    throw Error("INVALID_DATABASE_UUID");
  return "akh_server_test_" + uuid.replaceAll("-", "");
}
export function validateBaseUrl(value) {
  if (!value) throw Error("TEST_DATABASE_URL_REQUIRED");
  try {
    const url = new URL(value),
      name = decodeURIComponent(url.pathname.slice(1));
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !name.toLowerCase().includes("test") ||
      /[/\\\0]/.test(name) ||
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        [
          "database",
          "dbname",
          "user",
          "username",
          "password",
          "host",
          "hostaddr",
          "port",
          "connectionstring",
        ].includes(key.toLowerCase()),
      )
    )
      throw Error();
    return url;
  } catch {
    throw Error("TEST_DATABASE_URL_MUST_NAME_A_TEST_DATABASE");
  }
}
export function databaseUrl(base, name) {
  if (!ownedName.test(name)) throw Error("INVALID_OWNED_DATABASE_NAME");
  const url = validateBaseUrl(String(base));
  url.pathname = "/" + name;
  return url.href;
}
export function redact(value, urls = []) {
  const secrets = new Set();
  for (const value of urls) {
    if (!value) continue;
    secrets.add(String(value));
    try {
      const password = new URL(value).password;
      if (password) {
        secrets.add(password);
        secrets.add(decodeURIComponent(password));
      }
    } catch {
      /* Never echo invalid configuration. */
    }
  }
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(
    /postgres(?:ql)?:\/\/[^\s/]*@/gi,
    "postgres://[REDACTED]@",
  );
}
function inside(parent, target) {
  const path = relative(parent, target);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
}
export async function discoverTests(root = repositoryRoot, filters = []) {
  try {
    const canonicalRoot = await realpath(root),
      server = await realpath(join(canonicalRoot, "server")),
      files = [];
    if (!inside(canonicalRoot, server)) throw Error();
    async function walk(directory) {
      for (const entry of (
        await readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".test.ts"))
          files.push(path);
        // Do not follow symlinks, including fixtures pointing outside the repo.
      }
    }
    await walk(server);
    const selected = new Set();
    for (const filter of filters.length ? filters : ["server"]) {
      if (
        typeof filter !== "string" ||
        !filter.trim() ||
        filter.startsWith("-") ||
        filter.includes("\0") ||
        filter.includes("\\") ||
        filter.split("/").includes("..")
      )
        throw Error();
      const lexical = resolve(canonicalRoot, filter);
      if (!inside(server, lexical) && !inside(resolve(root, "server"), lexical))
        throw Error();
      const path = await realpath(lexical);
      if (!inside(server, path)) throw Error();
      const metadata = await stat(path);
      if (
        !metadata.isDirectory() &&
        !(metadata.isFile() && path.endsWith(".test.ts"))
      )
        throw Error();
      const matching = files.filter((file) =>
        metadata.isDirectory() ? inside(path, file) : file === path,
      );
      if (!matching.length) throw Error();
      for (const file of matching)
        selected.add(relative(canonicalRoot, file).split(sep).join("/"));
    }
    return [...selected].sort();
  } catch {
    throw Error("INVALID_SERVER_TEST_FILTER");
  }
}
export function childInvocation(root, file, env) {
  if (
    !file.startsWith("server/") ||
    !file.endsWith(".test.ts") ||
    file.split("/").includes("..") ||
    file.includes("\\") ||
    file.includes("\0")
  )
    throw Error("INVALID_SERVER_TEST_FILTER");
  return {
    command: process.execPath,
    args: [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      file,
      "--maxWorkers=1",
    ],
    options: { cwd: root, env, stdio: ["inherit", "pipe", "pipe"] },
  };
}
async function executeVitest({ root, file, env, signal }) {
  if (signal?.aborted) return { code: 130, stdout: "", stderr: "" };
  const call = childInvocation(root, file, env);
  return new Promise((resolveResult) => {
    const child = spawn(call.command, call.args, { ...call.options, signal });
    let stdout = [],
      stderr = [],
      bytes = 0,
      overflow = false,
      failed = false;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        overflow = true;
        stdout = [];
        stderr = [];
        return;
      }
      if (!overflow) (target === "out" ? stdout : stderr).push(chunk);
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) =>
      resolveResult({
        code: signal?.aborted ? 130 : failed || overflow ? 1 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: overflow
          ? "SERVER_TEST_OUTPUT_LIMIT_EXCEEDED\n"
          : Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}
function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
    ? error.code
    : "OPERATION_FAILED";
}

/** No DB connection occurs at import. Every successfully-created name belongs
 * to this invocation only; the base DB is never migrated, reset or dropped.
 * Child output is buffered per file then redacted, including chunk boundaries.
 * Creation/cleanup failure stops; ordinary test failures still run later files. */
export async function runServerTests({
  root = repositoryRoot,
  filters = [],
  env = process.env,
  uuid = randomUUID,
  createPool = (connectionString) =>
    new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
    }),
  executeFile = executeVitest,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  signal,
} = {}) {
  let base, files;
  try {
    base = validateBaseUrl(env.TEST_DATABASE_URL);
    files = await discoverTests(root, filters);
  } catch (error) {
    stderr(
      (/^TEST_DATABASE_URL_[A-Z_]+$/.test(error.message)
        ? error.message
        : "INVALID_SERVER_TEST_FILTER") + "\n",
    );
    return 1;
  }
  let admin;
  try {
    admin = createPool(base.href);
  } catch (error) {
    stderr(`TEST_DATABASE_ADMIN_CONNECTION_FAILED ${safeCode(error)}\n`);
    return 1;
  }
  let status = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (signal?.aborted) {
        status = 130;
        break;
      }
      let name;
      try {
        name = databaseName(uuid());
      } catch {
        stderr("INVALID_DATABASE_UUID\n");
        status = 1;
        break;
      }
      // The strict generated identifier is the ONLY interpolated SQL value.
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
      } catch (error) {
        stderr(
          `CREATE_DATABASE_FAILED ${safeCode(error)} ${name}; stopped, no shared-database fallback\n`,
        );
        status = 1;
        break;
      }
      const url = databaseUrl(base, name);
      try {
        stdout(`[${index + 1}/${files.length}] ${file}\n`);
        const result = await executeFile({
          root,
          file,
          env: { ...env, TEST_DATABASE_URL: url },
          signal,
        });
        stdout(redact(result.stdout ?? "", [env.TEST_DATABASE_URL, url]));
        stderr(redact(result.stderr ?? "", [env.TEST_DATABASE_URL, url]));
        if (result.code !== 0) status = signal?.aborted ? 130 : 1;
      } catch {
        stderr(`SERVER_TEST_CHILD_FAILED ${file}\n`);
        status = 1;
      }
      // executeFile resolves only AFTER the child closes: its DB sockets have
      // closed before DROP. Never FORCE or terminate remaining connections.
      try {
        await admin.query(`DROP DATABASE "${name}"`);
      } catch (error) {
        stderr(
          `CLEANUP_FAILED ${safeCode(error)} ${name}; owned database preserved for inspection, stopped\n`,
        );
        status = 1;
        break;
      }
      if (signal?.aborted) {
        status = 130;
        break;
      }
    }
  } finally {
    try {
      await admin.end();
    } catch (error) {
      stderr(`TEST_DATABASE_ADMIN_CLOSE_FAILED ${safeCode(error)}\n`);
      status = 1;
    }
  }
  return status;
}
export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController(),
    interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await runServerTests({ filters: args, signal: controller.signal });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await main();
