import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, opendir, rename, unlink } from "node:fs/promises";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Pool } from "pg";
import {
  decodeAuditAnchor,
  withAuditHeadStoreFence,
  type AuditHead,
  type AuditHeadStore,
} from "../operations/audit-protocol";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const NAME = new RegExp(
  `^audit-([a-zA-Z0-9_-]{1,100})-(?:[0-9]{1,20}-${UUID}|[0-9]{1,19}-[0-9]{1,19}-[a-f0-9]{16})\\.akh-backup$`,
);
const space = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error("INVALID_SPACE_ID");
  return value;
};
const filename = (value: string) => {
  const match = NAME.exec(value);
  if (!match) throw Error("AUDIT_INVALID_NAME");
  return match[1];
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: AuditHead | null, b: AuditHead | null) =>
  a === null || b === null
    ? a === b
    : a.sequence === b.sequence && a.hash === b.hash;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
interface Pointer {
  version: 1;
  workspaceId: string;
  name: string;
  encryptedHash: string;
  mac: string;
}
export interface FileAuditTargetOptions {
  pool: Pool;
  root: string;
  contentRoot: string;
  encryptionKey: string;
  signingKey: string;
}

/**
 * Server-only filesystem adapter, NOT an authorizer or a WORM service.
 * Configure an existing canonical directory with separate write permissions from
 * live blobs. All HEAD writers must share the PG fence and server-only keys.
 * HMAC detects an unsigned pointer rewrite, not replay of a previously signed
 * pointer or compromise of the app/key owner. Independent monotonic storage,
 * retention/WORM and administrative separation require site approval.
 * Private directory ownership is required: Node path APIs are not openat-based
 * protection against a privileged concurrent directory replacement attacker.
 */
export class FileAuditTarget implements AuditHeadStore {
  readonly target = this;
  readonly #pool: Pool;
  readonly #root: string;
  readonly #dev: number;
  readonly #ino: number;
  readonly #encryptionKey: string;
  readonly #signingKey: string;
  // Non-enumerable prototype getters keep secrets out of accidental JSON output.
  get key() {
    return this.#encryptionKey;
  }
  get signingKey() {
    return this.#signingKey;
  }

  constructor(options: FileAuditTargetOptions) {
    if (
      options.encryptionKey.length < 32 ||
      options.signingKey.length < 32 ||
      options.encryptionKey === options.signingKey
    )
      throw Error("INDEPENDENT_STRONG_KEYS_REQUIRED");
    const canonical = (path: string) => {
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        realpathSync(path) !== path ||
        !lstatSync(path).isDirectory()
      )
        throw Error("AUDIT_INVALID_ROOT");
      return path;
    };
    this.#root = canonical(options.root);
    const content = canonical(options.contentRoot);
    const nested = (parent: string, child: string) => {
      const r = relative(parent, child);
      return r === "" || (!r.startsWith("../") && r !== ".." && !isAbsolute(r));
    };
    if (nested(content, this.#root) || nested(this.#root, content))
      throw Error("AUDIT_ROOT_NOT_INDEPENDENT");
    const info = lstatSync(this.#root);
    if (info.mode & 0o022) throw Error("AUDIT_ROOT_UNSAFE_PERMISSIONS");
    this.#dev = info.dev;
    this.#ino = info.ino;
    this.#pool = options.pool;
    this.#encryptionKey = options.encryptionKey;
    this.#signingKey = options.signingKey;
  }

  async #checkRoot() {
    const info = await lstat(this.#root);
    if (
      !info.isDirectory() ||
      info.dev !== this.#dev ||
      info.ino !== this.#ino ||
      info.mode & 0o022 ||
      realpathSync(this.#root) !== this.#root
    )
      throw Error("AUDIT_ROOT_CHANGED");
  }
  async #syncDirectory() {
    const directory = await open(
      this.#root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async #read(name: string, limit = MAX_BYTES) {
    await this.#checkRoot();
    const file = await open(
      join(this.#root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077)
        throw Error("AUDIT_UNSAFE_FILE");
      if (info.size > limit) throw Error("AUDIT_SIZE_LIMIT");
      const chunks: Buffer[] = [];
      let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, limit + 1 - length));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > limit) throw Error("AUDIT_SIZE_LIMIT");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const bytes = Buffer.concat(chunks, length),
        text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) throw Error("AUDIT_INVALID_UTF8");
      return text;
    } finally {
      await file.close();
    }
  }
  async put(name: string, encrypted: string): Promise<void> {
    filename(name);
    if (
      typeof encrypted !== "string" ||
      Buffer.byteLength(encrypted) > MAX_BYTES
    )
      throw Error("AUDIT_SIZE_LIMIT");
    await this.#checkRoot();
    let file;
    try {
      file = await open(
        join(this.#root, name),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await this.get(name)) !== encrypted)
        throw Error("AUDIT_IMMUTABLE_COLLISION");
      // A previous writer may have completed write but not its durability ack.
      const existing = await open(
        join(this.#root, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await existing.sync();
      } finally {
        await existing.close();
      }
      await this.#syncDirectory();
      return;
    }
    try {
      await file.writeFile(encrypted, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await this.#syncDirectory();
  }
  async get(name: string): Promise<string> {
    filename(name);
    return this.#read(name);
  }
  async list(): Promise<{ name: string }[]> {
    await this.#checkRoot();
    const directory = await opendir(this.#root),
      result: { name: string }[] = [];
    let count = 0;
    for await (const entry of directory) {
      // Bound the whole directory, including orphan temps/unrecognized files.
      if (++count > MAX_FILES) throw Error("AUDIT_LIST_LIMIT");
      if (!NAME.test(entry.name)) continue;
      if (!entry.isFile()) throw Error("AUDIT_UNSAFE_FILE");
      result.push({ name: entry.name });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  #pointerMac(pointer: Omit<Pointer, "mac">) {
    return createHmac("sha256", this.#signingKey)
      .update("agent-knowledge-hub/audit-filesystem-head/v1\0")
      .update(
        JSON.stringify([
          pointer.version,
          pointer.workspaceId,
          pointer.name,
          pointer.encryptedHash,
        ]),
      )
      .digest("hex");
  }
  async readAnchor(workspaceId: string): Promise<string | null> {
    space(workspaceId);
    let raw: string;
    try {
      raw = await this.#read(`HEAD-${workspaceId}.json`, 4096);
    } catch (error) {
      if (missing(error)) {
        // A dangling symlink is NOT a fresh store. Missing archive targets below
        // likewise fail closed rather than turning a corrupt HEAD into null.
        await this.#checkRoot();
        try {
          await lstat(join(this.#root, `HEAD-${workspaceId}.json`));
        } catch (e) {
          if (missing(e)) return null;
          throw e;
        }
      }
      throw error;
    }
    try {
      const pointer = JSON.parse(raw) as Pointer;
      if (
        pointer.version !== 1 ||
        pointer.workspaceId !== workspaceId ||
        filename(pointer.name) !== workspaceId ||
        typeof pointer.encryptedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(pointer.encryptedHash) ||
        typeof pointer.mac !== "string" ||
        !/^[a-f0-9]{64}$/.test(pointer.mac) ||
        !timingSafeEqual(
          Buffer.from(pointer.mac, "hex"),
          Buffer.from(this.#pointerMac(pointer), "hex"),
        )
      )
        throw Error("AUDIT_HEAD_INVALID");
      const encrypted = await this.get(pointer.name);
      if (hash(encrypted) !== pointer.encryptedHash)
        throw Error("AUDIT_HEAD_HASH_MISMATCH");
      decodeAuditAnchor(
        encrypted,
        this.#encryptionKey,
        this.#signingKey,
        workspaceId,
      );
      return encrypted;
    } catch (cause) {
      throw new Error("AUDIT_HEAD_INVALID", { cause });
    }
  }
  async anchor(
    name: string,
    encrypted: string,
    fence?: <T>(work: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    const workspaceId = filename(name);
    if (
      typeof encrypted !== "string" ||
      Buffer.byteLength(encrypted) > MAX_BYTES
    )
      throw Error("AUDIT_SIZE_LIMIT");
    const candidate = decodeAuditAnchor(
      encrypted,
      this.#encryptionKey,
      this.#signingKey,
      workspaceId,
    );
    const work = async () => {
      const stored = await this.readAnchor(workspaceId);
      const current =
        stored === null
          ? null
          : decodeAuditAnchor(
              stored,
              this.#encryptionKey,
              this.#signingKey,
              workspaceId,
            );
      if (current) {
        if (BigInt(candidate.head.sequence) < BigInt(current.head.sequence))
          throw Error("AUDIT_ANCHOR_STALE");
        if (
          candidate.head.sequence === current.head.sequence &&
          candidate.head.hash !== current.head.hash
        )
          throw Error("AUDIT_ANCHOR_FORK");
        if (stored === encrypted) {
          // Validate an existing-name collision even on an exact replay.
          await this.put(name, encrypted);
          return;
        }
      }
      if (!equal(candidate.previousHead, current?.head ?? null))
        throw Error("AUDIT_HEAD_CAS_MISMATCH");
      await this.put(name, encrypted); // immutable + file/directory fsync FIRST
      const pointer = {
        version: 1 as const,
        workspaceId,
        name,
        encryptedHash: hash(encrypted),
      };
      const temp = join(this.#root, `.HEAD-${workspaceId}-${randomUUID()}.tmp`);
      let created = false;
      try {
        await this.#checkRoot();
        const file = await open(
          temp,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        try {
          await file.writeFile(
            JSON.stringify({ ...pointer, mac: this.#pointerMac(pointer) }),
            "utf8",
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, join(this.#root, `HEAD-${workspaceId}.json`));
        created = false;
        await this.#syncDirectory();
      } finally {
        if (created) await unlink(temp);
      }
    };
    // NEVER acquire another connection before invoking a caller's existing-client
    // fence: it may already hold the workspace transaction on a max=1 pool.
    if (fence) await fence(work);
    else await withAuditHeadStoreFence(this.#pool, workspaceId, work);
  }
}

export function createFileAuditTarget(
  options: FileAuditTargetOptions,
): FileAuditTarget {
  return new FileAuditTarget(options);
}
