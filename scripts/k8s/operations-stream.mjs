import {
  createHash,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { createReadStream, createWriteStream, constants } from "node:fs";
import {
  open,
  mkdir,
  lstat,
  realpath,
  stat,
  mkdtemp,
  rm,
  rename,
  copyFile,
  unlink,
  statfs,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const MAGIC = Buffer.from("AKH3\r\n"),
  CHUNK = 65536,
  MAX_MANIFEST = 16 * 1024 * 1024,
  verifiedArchives = new WeakMap();
const digest = (b) => createHash("sha256").update(b).digest("hex");
function derive(key, salt) {
  if (typeof key !== "string" || key.length < 32)
    throw Error("STRONG_BACKUP_KEY_REQUIRED");
  return scryptSync(key, salt, 32);
}
async function safeRoot(directory) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    throw Error("UNSAFE_ROOT");
  return root;
}
function frame(type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
    h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}
async function writeAll(f, bytes) {
  let n = 0;
  while (n < bytes.length) {
    const r = await f.write(bytes, n, bytes.length - n);
    if (!r.bytesWritten) throw Error("WRITE_FAILED");
    n += r.bytesWritten;
  }
}
async function space(root, max) {
  if (!Number.isSafeInteger(max) || max < 1)
    throw Error("INVALID_STAGING_BOUND");
  if (max > 60 * 1024 ** 3) throw Error("ARCHIVE_BOUND_EXCEEDS_GCM_LIMIT");
  const s = await statfs(root, { bigint: true });
  if (s.bavail * s.bsize < BigInt(max) + 1048576n)
    throw Error("INSUFFICIENT_STAGING_SPACE");
}
/** Stream framing + whole-archive AES-GCM. Headers and final manifest are authenticated. No dump/blob aggregate buffer. */
export async function createArchive({
  file,
  key,
  keyId,
  contentDirectory,
  refs,
  dumpDatabase,
  timeoutMs = 300000,
  maxStagingBytes = 16 * 1024 ** 3,
  metadata = {},
}) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 3600000
  )
    throw Error("INVALID_ARCHIVE_CONFIG");
  const root = await safeRoot(contentDirectory),
    parent = await safeRoot(resolve(file, ".."));
  await space(parent, maxStagingBytes);
  const salt = randomBytes(16),
    iv = randomBytes(12),
    header = Buffer.from(
      JSON.stringify({
        version: 3,
        keyId,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
      }),
    ),
    length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const prefix = Buffer.concat([MAGIC, length, header]),
    cipher = createCipheriv("aes-256-gcm", derive(key, salt), iv);
  cipher.setAAD(prefix);
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(Error("DUMP_ARCHIVE_TIMEOUT")),
      timeoutMs,
    );
  timer.unref();
  let stream,
    created = false,
    total = 0;
  const untilAbort = new Promise((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => {
        stream?.destroy?.();
        reject(Error("DUMP_ARCHIVE_TIMEOUT"));
      },
      { once: true },
    ),
  );
  const entries = [],
    seen = new Set();
  async function* entry(kind, name, input, expectedSize) {
    yield frame(1, { kind, name, size: expectedSize ?? null });
    const hash = createHash("sha256");
    let size = 0;
    for await (const raw of input) {
      if (controller.signal.aborted) throw Error("DUMP_ARCHIVE_TIMEOUT");
      const bytes = Buffer.from(raw);
      for (let at = 0; at < bytes.length; at += CHUNK) {
        const part = bytes.subarray(at, at + CHUNK);
        size += part.length;
        total += part.length;
        if (total > maxStagingBytes || (kind === "blob" && size > 5242880))
          throw Error("ARCHIVE_BOUND_EXCEEDED");
        hash.update(part);
        yield frame(2, part);
      }
    }
    const sha256 = hash.digest("hex");
    if (
      expectedSize !== undefined &&
      (size !== expectedSize || sha256 !== name)
    )
      throw Error("BLOB_CHECKSUM_MISMATCH");
    const end = { kind, name, size, sha256 };
    entries.push(end);
    yield frame(3, end);
  }
  async function* plaintext() {
    stream = await Promise.race([
      Promise.resolve().then(() => dumpDatabase(controller.signal)),
      untilAbort,
    ]);
    if (!stream?.[Symbol.asyncIterator]) throw Error("DUMP_STREAM_REQUIRED");
    yield* entry("database", "database.dump", stream);
    for await (const ref of refs) {
      if (entries.length >= 100000) throw Error("ARCHIVE_ENTRY_BOUND");
      if (
        !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        !Number.isSafeInteger(ref.size) ||
        ref.size < 1 ||
        ref.size > 5242880
      )
        throw Error("INVALID_BLOB_REFERENCE");
      if (seen.has(ref.sha256)) continue;
      seen.add(ref.sha256);
      const handle = await open(
        join(root, ref.sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isFile()) throw Error("UNSAFE_BLOB");
        yield* entry(
          "blob",
          ref.sha256,
          handle.createReadStream({ autoClose: false, highWaterMark: CHUNK }),
          ref.size,
        );
      } finally {
        await handle.close();
      }
    }
    const manifest = {
      version: 3,
      at: new Date().toISOString(),
      metadata,
      entries,
    };
    const body = Buffer.from(JSON.stringify(manifest));
    if (body.length > MAX_MANIFEST) throw Error("MANIFEST_BOUND");
    yield frame(4, body);
  }
  try {
    const f = await open(file, "wx", 0o600);
    created = true;
    try {
      await f.writeFile(prefix);
    } finally {
      await f.close();
    }
    await Promise.race([
      pipeline(
        Readable.from(plaintext()),
        cipher,
        createWriteStream(file, { flags: "a", mode: 0o600 }),
        { signal: controller.signal },
      ),
      untilAbort,
    ]);
    const out = await open(file, "a");
    try {
      await out.writeFile(cipher.getAuthTag());
      await out.sync();
    } finally {
      await out.close();
    }
    return { version: 3, file, entries: entries.length, plaintextBytes: total };
  } catch (e) {
    controller.abort();
    if (created) await unlink(file).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
    stream?.destroy?.();
  }
}
/** All decrypted data goes ONLY to a mode0700 private staging directory. No restore/promotion effect until GCM+frames+manifest verify. */
export async function verifyArchive({
  file,
  keys,
  stagingRoot,
  maxStagingBytes = 16 * 1024 ** 3,
}) {
  const root = await safeRoot(stagingRoot);
  await space(root, maxStagingBytes);
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let staging,
    active,
    promoted = false;
  try {
    const s = await input.stat();
    if (
      !s.isFile() ||
      s.size < 50 ||
      s.size > maxStagingBytes + MAX_MANIFEST + 16 * 1024 * 1024
    )
      throw Error("ARCHIVE_BOUND_EXCEEDED");
    const first = Buffer.alloc(10);
    if (
      (await input.read(first, 0, 10, 0)).bytesRead !== 10 ||
      !first.subarray(0, 6).equals(MAGIC)
    )
      throw Error("INVALID_ARCHIVE");
    const n = first.readUInt32BE(6);
    if (n < 1 || n > 4096) throw Error("HEADER_BOUND");
    const raw = Buffer.alloc(n);
    if ((await input.read(raw, 0, n, 10)).bytesRead !== n)
      throw Error("TRUNCATED_HEADER");
    const header = JSON.parse(raw),
      salt = Buffer.from(header.salt, "base64"),
      iv = Buffer.from(header.iv, "base64");
    if (
      header.version !== 3 ||
      !Object.hasOwn(keys, header.keyId) ||
      salt.length !== 16 ||
      iv.length !== 12
    )
      throw Error("UNKNOWN_ARCHIVE_KEY");
    const prefix = Buffer.concat([first, raw]);
    const tag = Buffer.alloc(16);
    await input.read(tag, 0, 16, s.size - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(keys[header.keyId], salt),
      iv,
    );
    decipher.setAAD(prefix);
    decipher.setAuthTag(tag);
    staging = await mkdtemp(join(root, ".akh-verify-"));
    const entries = [],
      seen = new Set();
    let pending = Buffer.alloc(0),
      total = 0,
      manifest;
    async function accept(type, body) {
      if (manifest) throw Error("TRAILING_ARCHIVE_DATA");
      if (type === 1) {
        if (active || entries.length >= 100000) throw Error("INVALID_ENTRY");
        const d = JSON.parse(body);
        if (
          d.kind === "database"
            ? entries.length !== 0 || d.name !== "database.dump"
            : d.kind !== "blob" ||
              !/^[a-f0-9]{64}$/.test(d.name) ||
              !Number.isSafeInteger(d.size) ||
              d.size < 1 ||
              d.size > 5242880
        )
          throw Error("INVALID_ENTRY");
        if (seen.has(d.name)) throw Error("DUPLICATE_ENTRY");
        seen.add(d.name);
        active = {
          ...d,
          file: join(staging, `entry-${entries.length}`),
          sizeRead: 0,
          hash: createHash("sha256"),
        };
        active.handle = await open(active.file, "wx", 0o600);
      } else if (type === 2) {
        if (!active || !body.length || body.length > CHUNK)
          throw Error("INVALID_DATA_FRAME");
        total += body.length;
        active.sizeRead += body.length;
        if (
          total > maxStagingBytes ||
          (active.kind === "blob" && active.sizeRead > 5242880)
        )
          throw Error("ARCHIVE_BOUND_EXCEEDED");
        active.hash.update(body);
        await writeAll(active.handle, body);
      } else if (type === 3) {
        if (!active) throw Error("INVALID_END_FRAME");
        const end = JSON.parse(body),
          actual = {
            kind: active.kind,
            name: active.name,
            size: active.sizeRead,
            sha256: active.hash.digest("hex"),
          };
        if (
          JSON.stringify(end) !== JSON.stringify(actual) ||
          (active.kind === "blob" &&
            (actual.sha256 !== active.name || actual.size !== active.size))
        )
          throw Error("ENTRY_CHECKSUM_MISMATCH");
        await active.handle.sync();
        await active.handle.close();
        entries.push({ ...actual, file: active.file });
        active = null;
      } else if (type === 4) {
        if (active || !entries.length || entries[0].kind !== "database")
          throw Error("INVALID_MANIFEST");
        manifest = JSON.parse(body);
        if (
          manifest.version !== 3 ||
          JSON.stringify(manifest.entries) !==
            JSON.stringify(entries.map(({ file, ...e }) => e))
        )
          throw Error("MANIFEST_CHECKSUM_MISMATCH");
      } else throw Error("UNKNOWN_FRAME");
    }
    async function feed(bytes) {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5) {
        const type = pending[0],
          length = pending.readUInt32BE(1),
          max = type === 4 ? MAX_MANIFEST : type === 2 ? CHUNK : 4096;
        if (length > max) throw Error("FRAME_BOUND");
        if (pending.length < 5 + length) return;
        const body = pending.subarray(5, 5 + length);
        await accept(type, body);
        pending = pending.subarray(5 + length);
      }
    }
    const source = input.createReadStream({
      start: prefix.length,
      end: s.size - 17,
      autoClose: false,
      highWaterMark: CHUNK,
    });
    for await (const bytes of source) await feed(decipher.update(bytes));
    await feed(decipher.final());
    if (pending.length || active || !manifest) throw Error("TRUNCATED_ARCHIVE");
    const verified = Object.freeze({
      manifest: JSON.parse(JSON.stringify(manifest)),
      databaseFile: entries[0].file,
      stagingDirectory: staging,
    });
    verifiedArchives.set(verified, { staging, entries });
    promoted = true;
    return verified;
  } finally {
    await active?.handle?.close().catch(() => {});
    await input.close();
    if (staging && !promoted)
      await rm(staging, { recursive: true, force: true });
  }
}
export async function discardVerifiedArchive(verified) {
  const internal = verifiedArchives.get(verified);
  if (!internal) throw Error("VERIFIED_ARCHIVE_REQUIRED");
  await rm(internal.staging, { recursive: true, force: true });
  verifiedArchives.delete(verified);
}
export async function promoteVerifiedArchive(
  verified,
  destination,
  deletedHashes = [],
) {
  const internal = verifiedArchives.get(verified);
  if (!internal) throw Error("VERIFIED_ARCHIVE_REQUIRED");
  const parent = await safeRoot(resolve(destination, "..")),
    target = join(parent, resolve(destination).split("/").at(-1));
  let created = false;
  try {
    await mkdir(target, { mode: 0o700 });
    created = true;
    for (const e of internal.entries) {
      if (e.kind === "blob" && deletedHashes.includes(e.name)) continue;
      const hash = createHash("sha256");
      for await (const b of createReadStream(e.file)) hash.update(b);
      if (hash.digest("hex") !== e.sha256)
        throw Error("STAGING_CHECKSUM_MISMATCH");
      const destination = join(target, e.name);
      try {
        await rename(e.file, destination);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        await copyFile(e.file, destination, constants.COPYFILE_EXCL);
        const copied = createHash("sha256");
        for await (const b of createReadStream(destination)) copied.update(b);
        if (copied.digest("hex") !== e.sha256)
          throw Error("PROMOTED_CHECKSUM_MISMATCH");
        const f = await open(destination, "r");
        try {
          await f.sync();
        } finally {
          await f.close();
        }
        await unlink(e.file);
      }
    }
    await discardVerifiedArchive(verified);
    return target;
  } catch (e) {
    if (created) await rm(target, { recursive: true, force: true });
    await discardVerifiedArchive(verified).catch(() => {});
    throw e;
  }
}
