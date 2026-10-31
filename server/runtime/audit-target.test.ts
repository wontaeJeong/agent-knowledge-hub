import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createFileAuditTarget, FileAuditTarget } from "./audit-target";
import { sealExport } from "../operations/service";
import {
  withAuditHeadStoreFence,
  type AuditHead,
} from "../operations/audit-protocol";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
const realFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const temporary = realpathSync(tmpdir());
const files: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockImplementation(realFs.open);
  vi.mocked(fs.rename).mockImplementation(realFs.rename);
  for (const file of files.splice(0).reverse())
    await unlink(file).catch(() => {});
  // Only explicitly tracked fixture directories, never a recursive deletion.
  const { rmdir } = await import("node:fs/promises");
  for (const dir of dirs.splice(0).reverse()) await rmdir(dir);
});
async function setup(
  pool = {
    connect: () => {
      throw Error("UNEXPECTED_POOL_CONNECTION");
    },
  } as unknown as Pool,
) {
  const base = await mkdtemp(join(temporary, "audit-target-"));
  dirs.push(base);
  const root = join(base, "audit"),
    contentRoot = join(base, "content");
  await mkdir(root, { mode: 0o700 });
  await mkdir(contentRoot);
  dirs.push(root, contentRoot);
  const encryptionKey = randomBytes(32).toString("hex"),
    signingKey = randomBytes(32).toString("hex");
  const options = { pool, root, contentRoot, encryptionKey, signingKey };
  const store = new FileAuditTarget(options);
  const name = (space = "space") =>
    `audit-${space}-${Date.now()}-${randomUUID()}.akh-backup`;
  const head = (sequence: string, letter = "a"): AuditHead => ({
    sequence,
    hash: letter.repeat(64),
  });
  const body = (
    sequence: string,
    previousHead: AuditHead | null = null,
    letter = "a",
    workspaceId = "space",
  ) =>
    sealExport(
      {
        version: 2,
        type: "audit-head",
        workspaceId,
        checkpoint: { sequence: "0", hash: "0".repeat(64) },
        head: head(sequence, letter),
        previousHead,
      },
      encryptionKey,
      signingKey,
    );
  const fence = async <T>(work: () => Promise<T>) => work();
  const cleanup = async () => {
    for (const file of await readdir(root)) files.push(join(root, file));
  };
  return {
    store,
    root,
    base,
    contentRoot,
    options,
    name,
    head,
    body,
    fence,
    cleanup,
  };
}

describe("FileAuditTarget filesystem contract", () => {
  it("commits private immutable ciphertext before authenticated HEAD and reopens only committed state", async () => {
    const f = await setup();
    try {
      expect(await f.store.readAnchor("space")).toBeNull();
      const name = f.name(),
        encrypted = f.body("1");
      await f.store.anchor(name, encrypted, f.fence);
      expect(await createFileAuditTarget(f.options).readAnchor("space")).toBe(
        encrypted,
      );
      expect(await f.store.get(name)).toBe(encrypted);
      for (const file of await readdir(f.root))
        expect((await stat(join(f.root, file))).mode & 0o777).toBe(0o600);
      await f.store.put(name, encrypted);
      await expect(f.store.put(name, f.body("2"))).rejects.toThrow(/COLLISION/);
      expect(await f.store.list()).toEqual([{ name }]);
    } finally {
      await f.cleanup();
    }
  });
  it("CAS rejects stale previous heads, lower sequence and equal-sequence forks; exact replay is safe", async () => {
    const f = await setup();
    try {
      const first = f.body("1"),
        n = f.name();
      await f.store.anchor(n, first, f.fence);
      await f.store.anchor(n, first, f.fence);
      await f.store.anchor(f.name(), f.body("2", f.head("1")), f.fence);
      await expect(
        f.store.anchor(f.name(), f.body("3", f.head("1")), f.fence),
      ).rejects.toThrow(/CAS/);
      await expect(
        f.store.anchor(f.name(), f.body("1", f.head("2")), f.fence),
      ).rejects.toThrow(/STALE/);
      await expect(
        f.store.anchor(f.name(), f.body("2", f.head("2"), "b"), f.fence),
      ).rejects.toThrow(/FORK/);
      expect(await f.store.readAnchor("space")).not.toBe(first);
    } finally {
      await f.cleanup();
    }
  });
  it("never selects an uncommitted file by list order or mtime and rejects tampered HEAD", async () => {
    const f = await setup();
    try {
      const first = f.body("1");
      await f.store.anchor(f.name(), first, f.fence);
      const orphan = f.name();
      await f.store.put(orphan, f.body("999"));
      await utimes(
        join(f.root, orphan),
        new Date("2099-01-01"),
        new Date("2099-01-01"),
      );
      expect(await f.store.readAnchor("space")).toBe(first);
      const pointer = (await readdir(f.root)).find(
        (n) => !n.endsWith(".akh-backup"),
      )!;
      const raw = await readFile(join(f.root, pointer), "utf8");
      await writeFile(
        join(f.root, pointer),
        raw.replace(/"mac":"[a-f0-9]+"/, '"mac":"' + "0".repeat(64) + '"'),
      );
      await expect(f.store.readAnchor("space")).rejects.toThrow(/HEAD/);
    } finally {
      await f.cleanup();
    }
  });
  it("rejects signature tampering, wrong workspace filename, unsafe paths and symlinks", async () => {
    const f = await setup();
    try {
      await expect(
        f.store.anchor(f.name("other"), f.body("1"), f.fence),
      ).rejects.toThrow();
      const envelope = JSON.parse(f.body("1"));
      envelope.signature = "0".repeat(64);
      await expect(
        f.store.anchor(f.name(), JSON.stringify(envelope), f.fence),
      ).rejects.toThrow(/SIGNATURE/);
      await expect(f.store.get("../outside.akh-backup")).rejects.toThrow(
        /NAME/,
      );
      const n = f.name(),
        outside = join(f.contentRoot, "private-ciphertext");
      await writeFile(outside, f.body("1"), { mode: 0o600 });
      files.push(outside);
      await symlink(outside, join(f.root, n));
      await expect(f.store.get(n)).rejects.toThrow();
      const alias = join(f.base, "alias");
      await symlink(f.root, alias);
      files.push(alias);
      expect(() => new FileAuditTarget({ ...f.options, root: alias })).toThrow(
        /ROOT/,
      );
      expect(
        () => new FileAuditTarget({ ...f.options, root: f.contentRoot }),
      ).toThrow(/ROOT/);
    } finally {
      await f.cleanup();
    }
  });
  it("bounds ciphertext reads/writes at 64 MiB and invokes provided fence without connecting", async () => {
    const f = await setup();
    try {
      let calls = 0;
      await f.store.anchor(f.name(), f.body("1"), async (work) => {
        calls++;
        return work();
      });
      expect(calls).toBe(1);
      await expect(
        f.store.put(f.name(), "x".repeat(64 * 1024 * 1024 + 1)),
      ).rejects.toThrow(/LIMIT/);
      const n = f.name();
      const { open } = await import("node:fs/promises");
      const handle = await open(
        join(f.root, n),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.truncate(64 * 1024 * 1024 + 1);
      await handle.close();
      await expect(f.store.get(n)).rejects.toThrow(/LIMIT/);
    } finally {
      await f.cleanup();
    }
  });
  it("syncs archive, directory, private temp, then renames and syncs directory in that order", async () => {
    const f = await setup();
    const events: string[] = [];
    const realOpen = realFs.open,
      realRename = realFs.rename;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const realSync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        await realSync();
        const path = String(args[0]);
        events.push(
          path === f.root
            ? "directory"
            : path.endsWith(".tmp")
              ? "temp"
              : "archive",
        );
      });
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      events.push("rename");
      return realRename(...args);
    });
    try {
      await f.store.anchor(f.name(), f.body("1"), f.fence);
      expect(events).toEqual([
        "archive",
        "directory",
        "temp",
        "rename",
        "directory",
      ]);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  });
  it("a failed HEAD replacement leaves a durable orphan but does not select it or delete archives", async () => {
    const f = await setup();
    try {
      const old = f.body("1");
      await f.store.anchor(f.name(), old, f.fence);
      const name = f.name(),
        proposed = f.body("2", f.head("1"));
      vi.spyOn(fs, "rename").mockRejectedValueOnce(
        Object.assign(Error("DISK_FAILURE"), { code: "EIO" }),
      );
      await expect(f.store.anchor(name, proposed, f.fence)).rejects.toThrow(
        "DISK_FAILURE",
      );
      expect(await f.store.get(name)).toBe(proposed);
      expect(await f.store.readAnchor("space")).toBe(old);
      expect((await readdir(f.root)).some((n) => n.endsWith(".tmp"))).toBe(
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
  it("rejects a missing referenced ciphertext rather than treating a damaged HEAD as fresh", async () => {
    const f = await setup();
    try {
      const name = f.name();
      await f.store.anchor(name, f.body("1"), f.fence);
      await unlink(join(f.root, name));
      await expect(f.store.readAnchor("space")).rejects.toThrow(/HEAD/);
    } finally {
      await f.cleanup();
    }
  });
  it("fails explicitly rather than truncating a directory with more than 10000 entries", async () => {
    const f = await setup();
    try {
      for (let start = 0; start < 10001; start += 128) {
        await Promise.all(
          Array.from({ length: Math.min(128, 10001 - start) }, (_, i) =>
            writeFile(join(f.root, `.orphan-${start + i}`), "", {
              mode: 0o600,
              flag: "wx",
            }),
          ),
        );
      }
      await expect(f.store.list()).rejects.toThrow("AUDIT_LIST_LIMIT");
    } finally {
      await f.cleanup();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "FileAuditTarget real PostgreSQL fence",
  () => {
    it("serializes independent writers and rejects a stale proposal after the newer committed head", async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 2,
      });
      const f = await setup(pool);
      try {
        await f.store.anchor(f.name(), f.body("1"));
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const wait = new Promise<void>((r) => {
          release = r;
        });
        const newer = withAuditHeadStoreFence(pool, "space", async () => {
          entered();
          await wait;
          await f.store.anchor(f.name(), f.body("3", f.head("1")), f.fence);
        });
        await started;
        const stale = new FileAuditTarget(f.options).anchor(
          f.name(),
          f.body("2", f.head("1")),
        );
        const assertion = expect(stale).rejects.toThrow(/STALE|CAS/);
        release();
        await newer;
        await assertion;
        const current = await f.store.readAnchor("space");
        expect(current).not.toBeNull();
      } finally {
        await pool.end();
        await f.cleanup();
      }
    });
    it("uses the provided transaction client fence on a single-connection pool without nesting", async () => {
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 500,
      });
      const f = await setup(pool),
        db = await pool.connect();
      try {
        await db.query("BEGIN");
        let calls = 0;
        const encrypted = f.body("1");
        await f.store.anchor(f.name(), encrypted, async (work) => {
          calls++;
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,$2))",
            ["space", 822028],
          );
          return work();
        });
        expect(calls).toBe(1);
        expect(await f.store.readAnchor("space")).toBe(encrypted);
        await db.query("COMMIT");
      } finally {
        await db.query("ROLLBACK");
        db.release();
        await pool.end();
        await f.cleanup();
      }
    });
  },
);
