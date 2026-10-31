import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, source, page, adoptFixture } from "../test-support";
import { StorageService } from "./service";
import { FileBlobStore, MAX_BYTES, sha256 } from "./content";
let f: Awaited<ReturnType<typeof fixture>>, root: string, s: StorageService;
const stream = (text: string) =>
  (async function* () {
    yield Buffer.from(text);
  })();
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-storage-gate-")));
});
beforeEach(async () => {
  f = await fixture();
  s = new StorageService(f.pool, new FileBlobStore(root), async () => {});
});
afterEach(async () => {
  await f?.pool.end();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
it("capacity full/unknown rejects every new CAS reference path while authenticated downloads remain available", async () => {
  const existing = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "readable.txt",
      mime: "text/plain",
    },
    stream("readable"),
  );
  const manifest = await s.export(f.editor, { pageIds: [page.id] });
  manifest.pages[0].versions[0].content = "capacity candidate";
  const staged = await s.import(f.editor, manifest);
  let puts = 0;
  const files = new FileBlobStore(root),
    put = files.put.bind(files);
  files.put = async (bytes) => {
    puts++;
    return put(bytes);
  };
  const full = new StorageService(f.pool, files, async () => {}, {
    minimumAvailableBytes: MAX_BYTES,
    capacityProbe: async () => 0n,
  });
  await expect(
    full.upload(
      f.editor,
      {
        parent: { kind: "source", id: source.id },
        filename: "full.txt",
        mime: "text/plain",
      },
      stream("new"),
    ),
  ).rejects.toThrow("STORAGE_CAPACITY_LOW");
  await expect(full.snapshot(f.editor, source.id)).rejects.toThrow(
    "STORAGE_CAPACITY_LOW",
  );
  await expect(
    full.ingestText(f.editor, {
      title: "new",
      content: "new source",
      project: "fixture",
      tool: "manual",
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_LOW");
  await expect(
    full.import(f.editor, {
      ...manifest,
      exportedAt: new Date(Date.now() + 1000).toISOString(),
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_LOW");
  await expect(
    full.proposeImport(f.editor, staged.id, {
      baseVersions: { [page.id]: 1 },
      reason: "capacity denied",
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_LOW");
  expect(puts).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await full.download(f.reader, existing.id)).bytes.toString()).toBe(
    "readable",
  );
  const unknown = new StorageService(f.pool, files, async () => {}, {
    capacityProbe: async () => {
      throw Error("secret probe diagnostics");
    },
  });
  await expect(
    unknown.upload(
      f.editor,
      {
        parent: { kind: "source", id: source.id },
        filename: "unknown.txt",
        mime: "text/plain",
      },
      stream("unknown"),
    ),
  ).rejects.toThrow("STORAGE_CAPACITY_UNKNOWN");
  expect(
    () =>
      new StorageService(f.pool, files, async () => {}, {
        minimumAvailableBytes: -1,
      }),
  ).toThrow("INVALID_STORAGE_RESERVE");
});
it("a shared writer protects deduplicated bytes until its reference commits, then exclusive purge sees the committed protection", async () => {
  const files = new FileBlobStore(root),
    preexisting = await files.put(stream("deduplicated race bytes")),
    put = files.put.bind(files);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve)),
    continueWrite = new Promise<void>((resolve) => (release = resolve));
  files.put = async (bytes) => {
    const saved = await put(bytes);
    entered();
    await continueWrite;
    return saved;
  };
  const writer = new StorageService(f.pool, files, async () => {}),
    pending = writer.upload(
      f.editor,
      {
        parent: { kind: "source", id: source.id },
        filename: "race.txt",
        mime: "text/plain",
      },
      stream("deduplicated race bytes"),
    );
  const purge = await f.pool.connect();
  try {
    await ready;
    await purge.query("BEGIN");
    expect(
      (
        await purge.query(
          "SELECT pg_try_advisory_xact_lock(822025) AS acquired",
        )
      ).rows[0].acquired,
    ).toBe(false);
    const exclusive = purge.query("SELECT pg_advisory_xact_lock(822025)");
    release();
    const saved = await pending;
    await exclusive;
    const protectedRows = await purge.query(
      "SELECT sha256 FROM storage_blobs WHERE sha256=$1 UNION SELECT staged->>'sha256' FROM storage_imports i CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.manifest->'stagedBlobs','[]'::jsonb)) staged WHERE staged->>'sha256'=$1",
      [preexisting.sha256],
    );
    if (!protectedRows.rowCount) await unlink(join(root, preexisting.sha256));
    expect(protectedRows.rowCount).toBeGreaterThan(0);
    await purge.query("COMMIT");
    expect((await writer.download(f.editor, saved.id)).bytes.toString()).toBe(
      "deduplicated race bytes",
    );
  } finally {
    release();
    await purge.query("ROLLBACK");
    purge.release();
  }
});
it("an exclusive purge gate prevents new CAS creation and workspace acquisition until released", async () => {
  const purge = await f.pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await purge.query("BEGIN");
    await purge.query("SELECT pg_advisory_xact_lock(822025)");
    let calls = 0;
    const files = new FileBlobStore(root),
      put = files.put.bind(files);
    files.put = async (bytes) => {
      calls++;
      return put(bytes);
    };
    const writer = new StorageService(f.pool, files, async () => {});
    pending = writer.upload(
      f.editor,
      {
        parent: { kind: "source", id: source.id },
        filename: "blocked.txt",
        mime: "text/plain",
      },
      stream("blocked writer"),
    );
    // The exclusive holder can acquire the workspace: writers must queue on the gate first.
    await purge.query(
      "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT",
      [f.workspaceId],
    );
    expect(calls).toBe(0);
    await purge.query("COMMIT");
    await pending;
    expect(calls).toBe(1);
  } finally {
    await purge.query("ROLLBACK");
    purge.release();
    if (pending) await pending;
  }
});
it("capacity failure in core source-registration callback rolls back private imported source and mapping atomically", async () => {
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_namespaces SET kind='personal',owner_id='editor' WHERE id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
    [f.workspaceId],
  );
  const service = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async () => {},
    { capacityProbe: async () => 0n },
  );
  const archive = {
    format: "akh-export",
    version: 1,
    workspaceId: f.workspaceId,
    exportedAt: new Date().toISOString(),
    sources: [
      {
        id: "capacity-private-raw",
        data: { ...source, id: "capacity-private-raw", content: "원본" },
        readers: ["editor"],
      },
    ],
    pages: [
      {
        id: "capacity-private-page",
        data: { id: "capacity-private-page", title: "개인 후보", links: [] },
        versions: [
          {
            number: 1,
            content: "개인 후보",
            sourceIds: ["capacity-private-raw"],
          },
        ],
        readers: ["editor"],
      },
    ],
    blobs: [],
  };
  const staged = await service.import(f.editor, archive);
  await expect(
    service.proposeImport(f.editor, staged.id, {
      baseVersions: { "capacity-private-page": 0 },
      reason: "용량 부족 원자성",
    }),
  ).rejects.toThrow("STORAGE_CAPACITY_LOW");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM resources WHERE workspace_id=$1 AND id='capacity-private-raw'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM storage_import_sources WHERE workspace_id=$1 AND import_id=$2",
        [f.workspaceId, staged.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("staged-only import hashes remain protected after the shared writer releases to exclusive purge", async () => {
  const manifest = await s.export(f.editor, { pageIds: [page.id] }),
    bytes = Buffer.from("staged only retained bytes"),
    hash = sha256(bytes);
  manifest.blobs.push({
    id: "staged-only",
    parent: { kind: "page", id: page.id },
    sha256: hash,
    mime: "text/plain",
    filename: "staged.txt",
    base64: bytes.toString("base64"),
    scanState: "clean",
    attachment: null,
  });
  const files = new FileBlobStore(root),
    put = files.put.bind(files);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve)),
    resume = new Promise<void>((resolve) => (release = resolve));
  files.put = async (input) => {
    const result = await put(input);
    entered();
    await resume;
    return result;
  };
  const service = new StorageService(f.pool, files, async () => {}),
    pending = service.import(f.editor, manifest),
    purge = await f.pool.connect();
  try {
    await ready;
    await purge.query("BEGIN");
    expect(
      (await purge.query("SELECT pg_try_advisory_xact_lock(822025) acquired"))
        .rows[0].acquired,
    ).toBe(false);
    const exclusive = purge.query("SELECT pg_advisory_xact_lock(822025)");
    release();
    const staged = await pending;
    await exclusive;
    expect(
      (
        await purge.query(
          "SELECT count(*)::int n FROM storage_blobs WHERE sha256=$1",
          [hash],
        )
      ).rows[0].n,
    ).toBe(0);
    const protectedHash = await purge.query(
      "SELECT staged->>'sha256' AS hash FROM storage_imports i CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.manifest->'stagedBlobs','[]'::jsonb)) staged WHERE i.workspace_id=$1 AND i.id=$2 AND staged->>'sha256'=$3",
      [f.workspaceId, staged.id, hash],
    );
    expect(protectedHash.rows).toEqual([{ hash }]);
    await purge.query("COMMIT");
    expect((await files.get(hash)).toString()).toBe(bytes.toString());
  } finally {
    release();
    await purge.query("ROLLBACK");
    purge.release();
  }
});
it("rechecks current write authority after bounded filesystem I/O before committing any attachment reference", async () => {
  let valid = true;
  const files = new FileBlobStore(root),
    put = files.put.bind(files);
  files.put = async (input) => {
    const result = await put(input);
    valid = false;
    return result;
  };
  const guarded = new StorageService(
    f.pool,
    files,
    async (_db, _ctx, action) => {
      if (!valid && action === "source.create") throw Error("ACL_REVOKED");
    },
  );
  await expect(
    guarded.upload(
      f.editor,
      {
        parent: { kind: "source", id: source.id },
        filename: "recheck.txt",
        mime: "text/plain",
      },
      stream("recheck role marker"),
    ),
  ).rejects.toThrow("ACL_REVOKED");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM storage_blobs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM storage_attachment_slots WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
