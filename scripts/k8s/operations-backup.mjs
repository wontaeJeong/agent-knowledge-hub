import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  realpath,
  lstat,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { sealBackup, openBackup } from "./backup-format.mjs";
export const MUTATION_GATE = 822025;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const validHash = (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
async function safeRoot(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
    throw Error("UNSAFE_DIRECTORY");
  return root;
}
async function readSafe(path, max = 512 * 1024 * 1024) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.size > max) throw Error("FILE_BOUND_EXCEEDED");
    return await f.readFile();
  } finally {
    await f.close();
  }
}
export async function createBundle({
  dump,
  contentDirectory,
  refs,
  key,
  keyId,
  metadata = {},
}) {
  if (!Buffer.isBuffer(dump) || !dump.length || dump.length > 256 * 1024 * 1024)
    throw Error("DUMP_BOUND_EXCEEDED");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) throw Error("INVALID_KEY_ID");
  const root = await safeRoot(contentDirectory),
    files = [],
    seen = new Map();
  let total = dump.length;
  for (const ref of refs) {
    if (
      !validHash(ref.sha256) ||
      !Number.isSafeInteger(ref.size) ||
      ref.size < 1 ||
      ref.size > 5242880
    )
      throw Error("INVALID_BLOB_REFERENCE");
    if (seen.has(ref.sha256)) {
      if (seen.get(ref.sha256) !== ref.size)
        throw Error("BLOB_REFERENCE_SIZE_CONFLICT");
      continue;
    }
    seen.set(ref.sha256, ref.size);
    const bytes = await readSafe(join(root, ref.sha256), 5242880);
    if (sha(bytes) !== ref.sha256 || bytes.length !== ref.size)
      throw Error("BLOB_CHECKSUM_MISMATCH");
    total += bytes.length;
    if (total > 256 * 1024 * 1024) throw Error("BUNDLE_BOUND_EXCEEDED");
    files.push({
      sha256: ref.sha256,
      size: bytes.length,
      bytes: bytes.toString("base64"),
    });
  }
  const manifest = {
    version: 2,
    at: new Date().toISOString(),
    database: { sha256: sha(dump), size: dump.length },
    files: files.map(({ bytes, ...m }) => m),
    metadata,
  };
  return JSON.stringify({
    version: 2,
    keyId,
    sealed: sealBackup(
      Buffer.from(
        JSON.stringify({ manifest, dump: dump.toString("base64"), files }),
      ),
      key,
    ),
  });
}
export function openBundle(encrypted, keys) {
  const outer = JSON.parse(encrypted);
  if (outer.version !== 2 || !Object.hasOwn(keys, outer.keyId))
    throw Error("UNKNOWN_BACKUP_KEY");
  const d = JSON.parse(openBackup(outer.sealed, keys[outer.keyId]).toString());
  if (
    d.manifest?.version !== 2 ||
    !Array.isArray(d.files) ||
    !Array.isArray(d.manifest.files)
  )
    throw Error("INVALID_MANIFEST");
  const dump = Buffer.from(d.dump, "base64");
  if (
    sha(dump) !== d.manifest.database.sha256 ||
    dump.length !== d.manifest.database.size
  )
    throw Error("DUMP_CHECKSUM_MISMATCH");
  const seen = new Set();
  if (d.files.length !== d.manifest.files.length)
    throw Error("INVALID_MANIFEST");
  const files = d.files.map((f, i) => {
    const bytes = Buffer.from(f.bytes, "base64"),
      m = d.manifest.files[i];
    if (
      !validHash(f.sha256) ||
      seen.has(f.sha256) ||
      sha(bytes) !== f.sha256 ||
      bytes.length !== f.size ||
      m.sha256 !== f.sha256 ||
      m.size !== f.size
    )
      throw Error("BLOB_CHECKSUM_MISMATCH");
    seen.add(f.sha256);
    return { ...f, bytes };
  });
  return { manifest: d.manifest, dump, files };
}
export function rotateBundle(encrypted, keys, newKey, newKeyId) {
  openBundle(encrypted, keys);
  const d = JSON.parse(encrypted);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(newKeyId)) throw Error("INVALID_KEY_ID");
  return JSON.stringify({
    version: 2,
    keyId: newKeyId,
    sealed: sealBackup(openBackup(d.sealed, keys[d.keyId]), newKey),
  });
}
export async function restoreFiles(bundle, directory, deletedHashes) {
  const root = await safeRoot(directory),
    deleted = new Set(deletedHashes);
  for (const f of bundle.files) {
    if (deleted.has(f.sha256)) continue;
    const path = join(root, f.sha256),
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    try {
      await handle.writeFile(f.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
/** A separately provisioned mount is required; this adapter does not claim offsite durability. */
export class FileTarget {
  constructor(directory, contentDirectory) {
    this.root = resolve(directory);
    const live = resolve(contentDirectory);
    if (
      this.root === live ||
      this.root.startsWith(live + sep) ||
      live.startsWith(this.root + sep)
    )
      throw Error("INDEPENDENT_TARGET_REQUIRED");
  }
  name(name) {
    if (!/^[a-zA-Z0-9_-]+\.akh-backup$/.test(name))
      throw Error("INVALID_TARGET_NAME");
    return join(this.root, name);
  }
  async put(name, body) {
    const path = this.name(name);
    await safeRoot(this.root);
    const f = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await f.writeFile(body);
      await f.sync();
    } finally {
      await f.close();
    }
    const dir = await open(this.root, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return { name, checksum: sha(body) };
  }
  async get(name) {
    await safeRoot(this.root);
    return (await readSafe(this.name(name))).toString();
  }
  async remove(name) {
    await safeRoot(this.root);
    await unlink(this.name(name));
  }
  async list() {
    await safeRoot(this.root);
    const rows = [];
    for (const name of await readdir(this.root)) {
      if (!/^[a-zA-Z0-9_-]+\.akh-backup$/.test(name)) continue;
      const s = await lstat(this.name(name));
      if (!s.isFile() || s.isSymbolicLink()) throw Error("UNSAFE_TARGET");
      rows.push({ name, at: s.mtime });
    }
    return rows.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  }
}
export async function retainBackups(target, days, now = new Date()) {
  if (!Number.isInteger(days) || days < 0 || days > 3650)
    throw Error("INVALID_RETENTION");
  const rows = await target.list(),
    removed = [];
  for (const row of rows.slice(1))
    if (row.at.getTime() < now.getTime() - days * 86400000) {
      await target.remove(row.name);
      removed.push(row.name);
    }
  return removed;
}
/** ALL mutations, including blob put/delete, must take this gate shared. */
export async function coordinatedBackup({
  pool,
  dumpDatabase,
  contentDirectory,
  target,
  key,
  keyId,
  gateConfirmed = false,
}) {
  if (!gateConfirmed) throw Error("MUTATION_GATE_NOT_CONFIRMED");
  const db = await pool.connect(),
    id = randomUUID();
  let locked = false;
  try {
    await db.query("SET lock_timeout='30s'");
    await db.query("SELECT pg_advisory_lock($1)", [MUTATION_GATE]);
    locked = true;
    await db.query(
      "INSERT INTO operations_backups(id,target,key_id,status) VALUES($1,$2,$3,'running')",
      [id, target.root ?? "configured-adapter", keyId],
    );
    const refs = (
      await db.query(
        "SELECT DISTINCT b.sha256,b.size FROM storage_blobs b WHERE NOT EXISTS(SELECT 1 FROM operations_tombstones t WHERE t.workspace_id=b.workspace_id AND t.resource_kind=b.parent_kind AND t.resource_id=b.parent_id AND t.delete_content AND t.blob_hashes ? b.sha256) ORDER BY b.sha256",
      )
    ).rows;
    const dump = await dumpDatabase();
    const encrypted = await createBundle({
      dump,
      contentDirectory,
      refs,
      key,
      keyId,
      metadata: { backupId: id, coordination: "global-advisory-gate" },
    });
    const name = `knowledge-${id}.akh-backup`,
      result = await target.put(name, encrypted);
    const returned = await target.get(name);
    if (sha(returned) !== sha(encrypted))
      throw Error("TARGET_CHECKSUM_MISMATCH");
    openBundle(returned, { [keyId]: key });
    await db.query(
      "UPDATE operations_backups SET status='complete',completed_at=now(),checksum=$2 WHERE id=$1",
      [id, result.checksum ?? sha(encrypted)],
    );
    return { id, name, checksum: sha(encrypted), blobCount: refs.length };
  } catch (error) {
    try {
      await db.query(
        "UPDATE operations_backups SET status='failed' WHERE id=$1",
        [id],
      );
    } catch {}
    throw error;
  } finally {
    if (locked)
      await db.query("SELECT pg_advisory_unlock($1)", [MUTATION_GATE]);
    db.release();
  }
}
