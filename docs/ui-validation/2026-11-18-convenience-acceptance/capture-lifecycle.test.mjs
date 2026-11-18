import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { validateBaseUrl } from "../../../scripts/test-server.mjs";
import {
  cleanResources,
  dropOwnedDatabase,
  images,
  publishRun,
  requiredSteps,
  requiredCleanup,
} from "./capture-support.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const base = validateBaseUrl(process.env.TEST_DATABASE_URL);
assert(
  process.env.AKH_C12_SYNTHETIC === "1" &&
    ["localhost", "127.0.0.1"].includes(base.hostname),
);
async function snapshot() {
  const all = {};
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), key + "/");
      else if (entry.isFile())
        all[key] = createHash("sha256")
          .update(await readFile(join(dir, entry.name)))
          .digest("hex");
    }
  }
  await walk(root);
  return all;
}
for (const mode of ["fixture-failure", "partial-capture"]) {
  test(
    "a failed " +
      mode +
      " closes its UUID database and leaves published bytes intact",
    async () => {
      const before = await snapshot();
      const child = promisify(execFile)(
        process.execPath,
        ["--import", "tsx", join(root, "capture.ts"), "--test-" + mode],
        { timeout: 120000 },
      );
      let stderr;
      await assert.rejects(child, (error) => {
        stderr = error.stderr;
        return error.code === 1;
      });
      const path = stderr.match(/^FAILED_RECORD (.+)$/m)?.[1];
      assert(path);
      const record = JSON.parse(await readFile(path, "utf8"));
      assert.match(record.database, /^akh_c12_test_[a-f0-9]{32}$/);
      assert.equal(record.ownedDatabaseDropped, true);
      assert(record.cleanup.every((entry) => entry.ok));
      const observer = new Pool({ connectionString: base.href });
      try {
        assert.equal(
          (
            await observer.query(
              "SELECT datname FROM pg_database WHERE datname=$1",
              [record.database],
            )
          ).rowCount,
          0,
        );
      } finally {
        await observer.end();
      }
      if (mode === "fixture-failure") {
        assert.match(
          record.errors[0].message,
          /Fixture subprocess initialization failed/,
        );
        assert.match(record.errors[0].message, /column ".*" does not exist/);
        assert.equal(record.results.length, 0);
        assert.deepEqual(
          record.cleanup.map((x) => x.resource),
          ["app", "issuer", "model", "pool", "database", "admin"],
        );
      } else {
        assert.match(
          record.errors[0].message,
          /after staged recovery screenshot/,
        );
        assert((await readFile(join(dirname(path), images[0]))).length > 1000);
        assert.deepEqual(
          record.cleanup.map((x) => x.resource),
          [
            "browser",
            "jobs",
            "app",
            "issuer",
            "model",
            "pool",
            "database",
            "admin",
          ],
        );
      }
      assert.deepEqual(await snapshot(), before);
      console.log(
        "Failure record",
        mode,
        path,
        "database removed; published bytes intact",
      );
    },
  );
}

test("a cleanup error and an occupied owned database still close later resources and identify the exact failed DROP", async () => {
  const observer = new Pool({ connectionString: base.href }),
    admin = new Pool({ connectionString: base.href });
  const name = "akh_c12_test_" + randomUUID().replaceAll("-", "");
  let blocker,
    created = false;
  const server = createServer();
  try {
    await observer.query('CREATE DATABASE "' + name + '"');
    created = true;
    const url = new URL(base.href);
    url.pathname = "/" + name;
    blocker = new Pool({ connectionString: url.href });
    await blocker.query("SELECT 1");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const records = await cleanResources([
      [
        "first",
        () => {
          throw new Error("injected");
        },
      ],
      [
        "server",
        () =>
          new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      ],
      ["database", () => dropOwnedDatabase(admin, name)],
      ["admin", () => admin.end()],
    ]);
    assert.equal(server.listening, false);
    assert.deepEqual(
      records.map((x) => [x.resource, x.ok]),
      [
        ["first", false],
        ["server", true],
        ["database", false],
        ["admin", true],
      ],
    );
    assert(records[2].error.includes(name));
    assert.match(records[2].error, /being accessed by other users/);
    assert.equal(
      (
        await observer.query(
          "SELECT datname FROM pg_database WHERE datname=$1",
          [name],
        )
      ).rowCount,
      1,
    );
    console.log("Observed owned DROP refusal", records[2].error);
  } finally {
    if (server.listening) server.close();
    await blocker?.end();
    if (created) await dropOwnedDatabase(observer, name);
    if (!admin.ended) await admin.end();
    await observer.end();
  }
});

test("a generation collision preserves the previous selected generation and index", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "akh-c12-index-test-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a97sAAAAASUVORK5CYII=",
    "base64",
  );
  const id = randomUUID(),
    report = {
      results: requiredSteps.map((step) => ({ step })),
      ownedDatabaseDropped: true,
      exitCode: 0,
      cleanup: requiredCleanup.map((resource) => ({ resource, ok: true })),
    };
  try {
    async function stage() {
      const dir = await mkdtemp(join(baseDir, "staged-"));
      for (const f of images) await writeFile(join(dir, f), png);
      return dir;
    }
    await publishRun(await stage(), baseDir, id, report);
    const prior = await readFile(join(baseDir, "latest.md"), "utf8");
    await assert.rejects(
      publishRun(await stage(), baseDir, randomUUID(), {
        ...report,
        results: report.results.slice(0, -1),
      }),
      /Incomplete journey/,
    );
    await assert.rejects(
      publishRun(await stage(), baseDir, randomUUID(), {
        ...report,
        cleanup: [
          ...report.cleanup.slice(0, -1),
          { resource: "admin", ok: false },
        ],
      }),
      /Incomplete cleanup/,
    );
    assert.deepEqual(await readdir(join(baseDir, "runs")), [id]);
    const saved = await readFile(
      join(baseDir, "runs", id, "journey.json"),
      "utf8",
    );
    await assert.rejects(publishRun(await stage(), baseDir, id, report), {
      code: "EEXIST",
    });
    assert.equal(await readFile(join(baseDir, "latest.md"), "utf8"), prior);
    assert.equal(
      await readFile(join(baseDir, "runs", id, "journey.json"), "utf8"),
      saved,
    );
    assert.deepEqual(
      (await readdir(join(baseDir, "runs", id))).sort(),
      [...images, "journey.json"].sort(),
    );
  } finally {
    await rm(baseDir, { recursive: true });
  }
});
