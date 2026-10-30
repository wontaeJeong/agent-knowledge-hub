import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  stat,
  readdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  createArchive,
  verifyArchive,
  promoteVerifiedArchive,
} from "./operations-stream.mjs";
import { FileTarget } from "./operations-backup.mjs";
import {
  rotateTargetArchive,
  verifyTargetArchive,
} from "./operations-stream-retention.mjs";
const key = "streaming-backup-key".repeat(4);
test("stream >256MiB through authenticated bounded frames, verify before promotion, refuse tampering", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "akh-stream-")),
    file = join(root, "large.akh3");
  const chunk = Buffer.alloc(65536, 0x61),
    count = 4352; //272MiB, generated without whole-dump allocation.
  const digest = createHash("sha256");
  for (let i = 0; i < count; i++) digest.update(chunk);
  const before = process.memoryUsage().external;
  const beforePeakRss = process.resourceUsage().maxRSS * 1024;
  await createArchive({
    file,
    key,
    keyId: "v3",
    contentDirectory: root,
    refs: [],
    dumpDatabase: async () =>
      Readable.from(
        (async function* () {
          for (let i = 0; i < count; i++) yield chunk;
        })(),
      ),
    timeoutMs: 30000,
    maxStagingBytes: 400 * 1024 * 1024,
  });
  assert.ok((await stat(file)).size > 256 * 1024 * 1024);
  assert.ok(
    process.memoryUsage().external - before < 100 * 1024 * 1024,
    "must not buffer whole dump",
  );
  assert.ok(
    process.resourceUsage().maxRSS * 1024 - beforePeakRss < 160 * 1024 * 1024,
    "kernel peak RSS must stay below whole-dump buffering",
  );
  const verified = await verifyArchive({
    file,
    keys: { v3: key },
    stagingRoot: root,
    maxStagingBytes: 400 * 1024 * 1024,
  });
  assert.equal(verified.manifest.entries[0].sha256, digest.digest("hex"));
  assert.equal((await stat(verified.databaseFile)).size, chunk.length * count);
  const destination = join(root, "promoted");
  await promoteVerifiedArchive(verified, destination, []);
  assert.equal(
    (await stat(join(destination, "database.dump"))).size,
    chunk.length * count,
  );
  const f = await open(file, "r+");
  const original = Buffer.alloc(1);
  await f.read(original, 0, 1, 100);
  original[0] ^= 255;
  await f.write(original, 0, 1, 100);
  await f.close();
  await assert.rejects(
    verifyArchive({
      file,
      keys: { v3: key },
      stagingRoot: root,
      maxStagingBytes: 400 * 1024 * 1024,
    }),
  );
  assert.equal(
    (await readdir(root)).filter((n) => n.startsWith(".akh-verify-")).length,
    0,
    "unauthenticated staging cleaned",
  );
});
test("streaming key rotation verifies new ciphertext independently and preserves the original until approved retention", async () => {
  const root = await mkdtemp(
      join(await realpath(tmpdir()), "akh-stream-rotate-"),
    ),
    live = join(root, "live"),
    targetRoot = join(root, "target");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(live);
  const target = new FileTarget(targetRoot, live);
  await target.list();
  await createArchive({
    file: target.name("original.akh-backup"),
    key,
    keyId: "old",
    contentDirectory: live,
    refs: [],
    dumpDatabase: async () => Readable.from([Buffer.alloc(65536, 1)]),
    maxStagingBytes: 1048576,
  });
  const next = "new-key".repeat(10),
    name = await rotateTargetArchive(
      target,
      "original.akh-backup",
      { old: key },
      next,
      "new",
      1048576,
    );
  await verifyTargetArchive(target, name, { new: next }, 1048576);
  await verifyTargetArchive(
    target,
    "original.akh-backup",
    { old: key },
    1048576,
  );
  await assert.rejects(
    verifyTargetArchive(target, name, { old: key }, 1048576),
  );
});
test("real blobs, key rejection, bounds, timeout and no unsafe destinations", async () => {
  const root = await mkdtemp(
      join(await realpath(tmpdir()), "akh-stream-small-"),
    ),
    bytes = Buffer.from("private blob"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    file = join(root, "small.akh3");
  await writeFile(join(root, sha), bytes);
  await createArchive({
    file,
    key,
    keyId: "current",
    contentDirectory: root,
    refs: [{ sha256: sha, size: bytes.length }],
    dumpDatabase: async () => Readable.from([Buffer.from("database")]),
    timeoutMs: 1000,
    maxStagingBytes: 1048576,
  });
  await assert.rejects(
    verifyArchive({
      file,
      keys: { current: "wrong".repeat(10) },
      stagingRoot: root,
      maxStagingBytes: 1048576,
    }),
  );
  await assert.rejects(
    verifyArchive({
      file,
      keys: { current: key },
      stagingRoot: root,
      maxStagingBytes: 1,
    }),
    /BOUND/,
  );
  const verified = await verifyArchive({
    file,
    keys: { current: key },
    stagingRoot: root,
    maxStagingBytes: 1048576,
  });
  await promoteVerifiedArchive(verified, join(root, "deleted"), [sha]);
  await assert.rejects(readFile(join(root, "deleted", sha)));
  await assert.rejects(
    createArchive({
      file: join(root, "hung"),
      key,
      keyId: "current",
      contentDirectory: root,
      refs: [],
      dumpDatabase: () => new Promise(() => {}),
      timeoutMs: 10,
      maxStagingBytes: 1048576,
    }),
    /TIMEOUT/,
  );
  await assert.rejects(stat(join(root, "hung")));
  assert.equal(
    (await readdir(root)).filter((n) => n.startsWith(".akh-verify-")).length,
    0,
  );
});
