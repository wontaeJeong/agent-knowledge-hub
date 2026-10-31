import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createBundle,
  openBundle,
  rotateBundle,
  restoreFiles,
  FileTarget,
  retainBackups,
} from "./operations-backup.mjs";
const key = "old-secret-".repeat(5),
  next = "new-secret-".repeat(5);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const temp = await realpath(tmpdir());
test("encrypted DB + real content manifest, checksums, key rotation and safe restore", async () => {
  const root = await mkdtemp(join(temp, "akh-ops-")),
    bytes = Buffer.from("sensitive content"),
    sha = hash(bytes);
  await writeFile(join(root, sha), bytes);
  const encrypted = await createBundle({
    dump: Buffer.from("real dump bytes"),
    contentDirectory: root,
    refs: [{ sha256: sha, size: bytes.length }],
    key,
    keyId: "old",
  });
  assert.ok(!encrypted.includes("sensitive content"));
  const bundle = openBundle(encrypted, { old: key });
  assert.equal(bundle.dump.toString(), "real dump bytes");
  assert.equal(bundle.manifest.files[0].sha256, sha);
  assert.throws(() => openBundle(encrypted, { old: next }));
  assert.throws(() => openBundle(encrypted.slice(0, -8), { old: key }));
  const rotated = rotateBundle(encrypted, { old: key }, next, "new");
  assert.throws(() => openBundle(rotated, { old: key }));
  const opened = openBundle(rotated, { new: next });
  const dest = await mkdtemp(join(temp, "akh-restored-"));
  await restoreFiles(opened, dest, []);
  assert.equal(
    (await readFile(join(dest, sha))).toString(),
    "sensitive content",
  );
  const deleted = await mkdtemp(join(temp, "akh-deleted-"));
  await restoreFiles(opened, deleted, [sha]);
  await assert.rejects(readFile(join(deleted, sha)));
  await writeFile(join(root, sha), "corrupt");
  await assert.rejects(
    createBundle({
      dump: Buffer.from("db"),
      contentDirectory: root,
      refs: [{ sha256: sha, size: bytes.length }],
      key,
      keyId: "old",
    }),
    /CHECKSUM/,
  );
});
test("target rejects nesting in live content, symlinks, traversal and retains newest backup", async () => {
  const root = await mkdtemp(join(temp, "akh-target-")),
    content = join(root, "live");
  await mkdir(content);
  assert.throws(
    () => new FileTarget(join(content, "backup"), content),
    /INDEPENDENT/,
  );
  const target = new FileTarget(join(root, "target"), content);
  await target.put("a.akh-backup", "one");
  await target.put("b.akh-backup", "two");
  await assert.rejects(target.put("../escape", "x"));
  await retainBackups(target, 0, new Date(Date.now() + 1000));
  assert.equal((await target.list()).length, 1);
  const unsafe = join(root, "unsafe");
  await symlink(content, unsafe);
  await assert.rejects(
    new FileTarget(unsafe, content).put("x.akh-backup", "x"),
  );
});
