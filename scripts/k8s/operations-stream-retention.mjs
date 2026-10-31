import { open, mkdtemp, rm, link, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  verifyArchive,
  discardVerifiedArchive,
  promoteVerifiedArchive,
  createArchive,
} from "./operations-stream.mjs";
export async function isStreamingArchive(file) {
  const f = await open(file, "r");
  try {
    const b = Buffer.alloc(6);
    await f.read(b, 0, 6, 0);
    return b.toString() === "AKH3\r\n";
  } finally {
    await f.close();
  }
}
export async function verifyTargetArchive(
  target,
  name,
  keys,
  maxStagingBytes = 16 * 1024 ** 3,
) {
  const verified = await verifyArchive({
    file: target.name(name),
    keys,
    stagingRoot: target.root,
    maxStagingBytes,
  });
  await discardVerifiedArchive(verified);
}
export async function rotateTargetArchive(
  target,
  name,
  keys,
  newKey,
  newKeyId,
  maxStagingBytes = 16 * 1024 ** 3,
) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(newKeyId)) throw Error("INVALID_KEY_ID");
  let verified = await verifyArchive({
    file: target.name(name),
    keys,
    stagingRoot: target.root,
    maxStagingBytes,
  });
  const root = await mkdtemp(join(target.root, ".rotate-")),
    content = join(root, "content"),
    partial = join(root, "encrypted"),
    newName = name.replace(".akh-backup", `-key-${newKeyId}.akh-backup`);
  try {
    const manifest = verified.manifest;
    await promoteVerifiedArchive(verified, content);
    verified = null;
    await createArchive({
      file: partial,
      key: newKey,
      keyId: newKeyId,
      contentDirectory: content,
      refs: manifest.entries
        .filter((e) => e.kind === "blob")
        .map((e) => ({ sha256: e.name, size: e.size })),
      dumpDatabase: async () =>
        createReadStream(join(content, "database.dump")),
      maxStagingBytes,
      metadata: manifest.metadata,
    });
    verified = await verifyArchive({
      file: partial,
      keys: { [newKeyId]: newKey },
      stagingRoot: root,
      maxStagingBytes,
    });
    await discardVerifiedArchive(verified);
    verified = null;
    await link(partial, target.name(newName));
    await unlink(partial);
    return newName;
  } finally {
    if (verified) await discardVerifiedArchive(verified).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
