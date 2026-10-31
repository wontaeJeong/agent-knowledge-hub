import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  databaseName,
  validateBaseUrl,
  databaseUrl,
  redact,
  discoverTests,
  runServerTests,
  childInvocation,
} from "./test-server.mjs";

async function tree(run) {
  const root = await mkdtemp(join(tmpdir(), "akh-server-runner-"));
  try {
    await mkdir(join(root, "server", "access"), { recursive: true });
    for (const file of [
      "server/z.test.ts",
      "server/access/a.test.ts",
      "server/access/not-a-test.ts",
    ])
      await writeFile(join(root, file), "// fixture");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const base =
  "postgres://fixture:fixture-password@127.0.0.1:5432/knowledge_test?sslmode=disable";
const uuid = "12345678-1234-1234-1234-123456789abc";

test("generated identifiers accept only the exact owned UUID database namespace", () => {
  assert.equal(
    databaseName(uuid),
    "akh_server_test_12345678123412341234123456789abc",
  );
  for (const value of [
    "old_database",
    "x;DROP DATABASE main",
    "1234",
    "../test",
    uuid + "suffix",
  ])
    assert.throws(() => databaseName(value), /INVALID_DATABASE_UUID/);
});
test("base database must explicitly be a PostgreSQL test database; invalid configuration is credential-safe", () => {
  assert.equal(validateBaseUrl(base).pathname, "/knowledge_test");
  for (const value of [
    undefined,
    "",
    "not a url fixture-password",
    "https://host/test",
    "postgres://fixture:fixture-password@host/production",
    "postgres://host/",
    "postgres://host/test/other",
    "postgres://host/knowledge_test?database=production",
    "postgres://host/knowledge_test?dbname=production",
  ]) {
    assert.throws(
      () => validateBaseUrl(value),
      (error) =>
        !error.message.includes("fixture-password") &&
        /TEST_DATABASE_URL/.test(error.message),
    );
  }
});
test("child URL replaces only database path in memory and rejects arbitrary identifiers", () => {
  const name = databaseName(uuid),
    url = new URL(databaseUrl(validateBaseUrl(base), name));
  assert.equal(url.pathname, "/" + name);
  assert.equal(url.password, "fixture-password");
  assert.equal(url.search, "?sslmode=disable");
  assert.throws(
    () => databaseUrl(validateBaseUrl(base), "test; DROP DATABASE other"),
    /INVALID_OWNED_DATABASE_NAME/,
  );
});
test("redaction removes base/child URLs, encoded and decoded passwords and PostgreSQL credentials", () => {
  const encoded =
      "postgres://fixture:fixture%2Bpassword%40host@localhost/knowledge_test",
    child = databaseUrl(validateBaseUrl(encoded), databaseName(uuid));
  const output = redact(
    `${encoded}\n${child}\nfixture+password@host\nfixture%2Bpassword%40host\npostgresql://someone:other-secret@db/test`,
    [encoded, child],
  );
  for (const secret of [
    encoded,
    child,
    "fixture+password@host",
    "fixture%2Bpassword%40host",
    "other-secret",
  ])
    assert.ok(!output.includes(secret));
});
test("discovery selects actual server test files deterministically, deduplicates and supports directories", () =>
  tree(async (root) => {
    assert.deepEqual(await discoverTests(root, []), [
      "server/access/a.test.ts",
      "server/z.test.ts",
    ]);
    assert.deepEqual(
      await discoverTests(root, ["server/access", "server/access/a.test.ts"]),
      ["server/access/a.test.ts"],
    );
    assert.deepEqual(
      await discoverTests(root, [join(root, "server", "z.test.ts")]),
      ["server/z.test.ts"],
    );
  }));
test("filters reject traversal, flags, URLs, non-tests, outside paths and symlink escapes", () =>
  tree(async (root) => {
    await symlink(join(root, ".."), join(root, "server", "escape"));
    for (const filter of [
      "server/../server",
      "../server",
      "--config=evil",
      "postgres://host/test",
      "package.json",
      "server/access/not-a-test.ts",
      "/etc",
      "server/escape",
    ])
      await assert.rejects(discoverTests(root, [filter]));
  }));
test("child arguments contain only Node/Vitest and the selected file, never the database URL or password", () => {
  const call = childInvocation("/repo", "server/access/a.test.ts", {
    TEST_DATABASE_URL: base,
  });
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [
    "/repo/node_modules/vitest/vitest.mjs",
    "run",
    "server/access/a.test.ts",
    "--maxWorkers=1",
  ]);
  assert.equal(call.options.env.TEST_DATABASE_URL, base);
  assert.ok(!JSON.stringify(call.args).includes("fixture-password"));
});
test("module import has no DB side effects; missing URL fails before constructing a pool", async () => {
  let constructed = false,
    errors = "";
  const code = await runServerTests({
    env: {},
    createPool: () => {
      constructed = true;
      throw Error("MUST_NOT_CONNECT");
    },
    stderr: (s) => {
      errors += s;
    },
  });
  assert.equal(code, 1);
  assert.equal(constructed, false);
  assert.match(errors, /TEST_DATABASE_URL_REQUIRED/);
});
test("each file has its own created DB; child completes before exact owned DROP and pool closes", () =>
  tree(async (root) => {
    const actions = [],
      urls = [],
      names = [],
      outputs = [];
    let index = 0;
    const code = await runServerTests({
      root,
      env: { TEST_DATABASE_URL: base },
      uuid: () =>
        [
          "12345678-1234-1234-1234-123456789abc",
          "22345678-1234-1234-1234-123456789abc",
        ][index++],
      stdout: (s) => outputs.push(s),
      stderr: (s) => outputs.push(s),
      createPool: () => ({
        query: async (sql) => {
          actions.push(sql);
          if (sql.startsWith("CREATE")) names.push(sql);
        },
        end: async () => actions.push("END"),
      }),
      executeFile: async ({ file, env }) => {
        urls.push(env.TEST_DATABASE_URL);
        actions.push("CHILD_CLOSED " + file);
        return {
          code: 0,
          stdout: env.TEST_DATABASE_URL + " fixture-password",
          stderr: "",
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(new Set(urls).size, 2);
    assert.equal(names.length, 2);
    assert.match(
      actions[0],
      /^CREATE DATABASE "akh_server_test_[a-f0-9]{32}"$/,
    );
    assert.match(actions[1], /^CHILD_CLOSED /);
    assert.equal(actions[2], actions[0].replace("CREATE", "DROP"));
    assert.equal(actions.at(-1), "END");
    assert.ok(!outputs.join("").includes("fixture-password"));
    assert.ok(!outputs.join("").includes(base));
  }));
test("creation permission failure stops immediately, never drops an unowned candidate or falls back to shared DB", () =>
  tree(async (root) => {
    const actions = [];
    let executed = false,
      errors = "";
    const code = await runServerTests({
      root,
      env: { TEST_DATABASE_URL: base },
      uuid: () => uuid,
      stdout: () => {},
      stderr: (s) => {
        errors += s;
      },
      createPool: () => ({
        query: async (sql) => {
          actions.push(sql);
          throw Object.assign(Error(base), { code: "42501" });
        },
        end: async () => actions.push("END"),
      }),
      executeFile: async () => {
        executed = true;
        return { code: 0 };
      },
    });
    assert.equal(code, 1);
    assert.equal(executed, false);
    assert.equal(actions.length, 2);
    assert.match(errors, /CREATE_DATABASE_FAILED.*42501/);
    assert.ok(!errors.includes("fixture-password"));
  }));
test("failed test child is still cleaned up and later independent files run", () =>
  tree(async (root) => {
    const actions = [];
    let count = 0;
    const code = await runServerTests({
      root,
      env: { TEST_DATABASE_URL: base },
      uuid: () => [uuid, "22345678-1234-1234-1234-123456789abc"][count],
      stdout: () => {},
      stderr: () => {},
      createPool: () => ({
        query: async (sql) => actions.push(sql),
        end: async () => actions.push("END"),
      }),
      executeFile: async () => ({
        code: ++count === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });
    assert.equal(code, 1);
    assert.equal(count, 2);
    assert.equal(
      actions.filter((s) => s.startsWith("DROP DATABASE")).length,
      2,
    );
  }));
test("active connections prevent cleanup: preserve the owned DB, report it explicitly and stop without FORCE", () =>
  tree(async (root) => {
    const actions = [];
    let children = 0,
      errors = "";
    const code = await runServerTests({
      root,
      env: { TEST_DATABASE_URL: base },
      uuid: () => uuid,
      stdout: () => {},
      stderr: (s) => {
        errors += s;
      },
      createPool: () => ({
        query: async (sql) => {
          actions.push(sql);
          if (sql.startsWith("DROP"))
            throw Object.assign(Error(base), { code: "55006" });
        },
        end: async () => actions.push("END"),
      }),
      executeFile: async () => {
        children++;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(code, 1);
    assert.equal(children, 1);
    assert.match(
      errors,
      /CLEANUP_FAILED.*akh_server_test_[a-f0-9]{32}.*preserved/i,
    );
    assert.ok(
      actions.every(
        (sql) => !/FORCE|TRUNCATE|pg_terminate_backend|DELETE FROM/.test(sql),
      ),
    );
    assert.ok(!errors.includes("fixture-password"));
  }));
test("real Node/Vitest subprocess closes before cleanup and split output is redacted without DB access", () =>
  tree(async (root) => {
    await mkdir(join(root, "node_modules", "vitest"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "vitest", "vitest.mjs"),
      `process.stdout.write(process.env.TEST_DATABASE_URL.slice(0,18));process.stdout.write(process.env.TEST_DATABASE_URL.slice(18));process.stderr.write('fixture-password');`,
    );
    const events = [],
      output = [];
    let index = 0;
    const code = await runServerTests({
      root,
      env: { TEST_DATABASE_URL: base },
      uuid: () => [uuid, "22345678-1234-1234-1234-123456789abc"][index++],
      stdout: (text) => {
        events.push("OUTPUT");
        output.push(text);
      },
      stderr: (text) => output.push(text),
      createPool: () => ({
        query: async (sql) => {
          if (sql.startsWith("DROP")) assert.equal(events.at(-1), "OUTPUT");
          events.push(sql);
        },
        end: async () => events.push("END"),
      }),
    });
    assert.equal(code, 0);
    assert.equal(index, 2);
    assert.equal(
      events.filter((event) => event.startsWith("DROP DATABASE")).length,
      2,
    );
    assert.ok(!output.join("").includes("fixture-password"));
    assert.ok(!output.join("").includes("postgres://fixture:"));
    assert.equal(events.at(-1), "END");
  }));
