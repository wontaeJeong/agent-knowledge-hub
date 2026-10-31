import { it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, source, page, adoptFixture } from "../test-support";
import { authorizeActionDb, type Action } from "../access/index";
import { FileBlobStore } from "./content";
import { StorageService, type StorageAuthorizer } from "./service";
let f: Awaited<ReturnType<typeof fixture>>, root: string, s: StorageService;
const authorize: StorageAuthorizer = async (_db, ctx, action) => {
  if (action === "scan.manage" && ctx.principalId !== "reviewer")
    throw Error("FORBIDDEN");
  if (
    ["source.create", "changeset.propose", "data.export"].includes(action) &&
    ctx.principalId === "reader"
  )
    throw Error("FORBIDDEN");
};
const stream = (text: string) =>
  (async function* () {
    yield Buffer.from(text);
  })();
beforeAll(async () => {
  f = await fixture();
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-storage-db-")));
  s = new StorageService(f.pool, new FileBlobStore(root), authorize);
});
afterAll(async () => {
  await f?.pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("requires authorizer and denies unauthorized upload/export", async () => {
  expect(
    () =>
      new StorageService(f.pool, new FileBlobStore(root), undefined as never),
  ).toThrow("AUTHORIZER_REQUIRED");
  await expect(
    s.upload(
      f.reader,
      {
        parent: { kind: "source", id: source.id },
        filename: "a.txt",
        mime: "text/plain",
      },
      stream("abc"),
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(s.export(f.reader, { pageIds: [page.id] })).rejects.toThrow(
    "FORBIDDEN",
  );
});
it("immutable source snapshots deduplicate and survive adapter restart", async () => {
  const a = await s.snapshot(f.editor, source.id),
    b = await s.snapshot(f.editor, source.id);
  expect(a.id).toBe(b.id);
  const bytes = await new StorageService(
    f.pool,
    new FileBlobStore(root),
    authorize,
  ).download(f.editor, a.blob_id);
  expect(JSON.parse(bytes.bytes.toString())).toEqual(source);
});
it("PDF remains denied until trusted scan and is never fake extracted", async () => {
  const b = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "a.pdf",
      mime: "application/pdf",
    },
    stream("%PDF-1.7\n%%EOF"),
  );
  await expect(s.download(f.editor, b.id)).rejects.toThrow("SCAN_REQUIRED");
  await expect(s.recordScan(f.editor, b.id, b.sha256, "clean")).rejects.toThrow(
    "FORBIDDEN",
  );
  await s.recordScan(f.ctx, b.id, b.sha256, "clean");
  await expect(s.extract(f.editor, b.id)).rejects.toThrow(
    "UNSUPPORTED_CONVERSION",
  );
});
it("download/tickets/local copy honor current full page ancestry and revocation", async () => {
  const b = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "a.md",
      mime: "text/markdown",
    },
    stream("# 한글"),
  );
  const ticket = await s.ticket(f.reader, b.id);
  expect((await s.redeem(f.reader, ticket.token)).bytes.toString()).toBe(
    "# 한글",
  );
  await expect(s.redeem(f.editor, ticket.token)).rejects.toThrow("NOT_FOUND");
  await s.revokeTicket(f.reader, ticket.token);
  await expect(s.redeem(f.reader, ticket.token)).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
    [f.workspaceId, source.id],
  );
  await expect(s.download(f.reader, b.id)).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'reader')",
    [f.workspaceId, source.id],
  );
});
it("export/import preserves history/ACL and import is idempotent proposal, never publication", async () => {
  const manifest = await s.export(f.editor, { pageIds: [page.id] });
  expect(manifest.sources[0].id).toBe(source.id);
  expect(manifest.pages[0].versions[0].number).toBe(1);
  const first = await s.import(f.editor, manifest),
    second = await s.import(f.editor, manifest);
  expect(second.id).toBe(first.id);
  expect(second.duplicate).toBe(true);
  const staged = await s.importProposal(f.editor, first.id);
  expect(staged.effectiveReaders).toEqual(["editor"]);
  expect(staged.scanApprovalTrusted).toBe(false);
  await expect(s.importProposal(f.reader, first.id)).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM versions WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  const bad = structuredClone(manifest);
  bad.blobs[0].filename = "../escape.json";
  await expect(s.import(f.editor, bad)).rejects.toThrow();
  const wider = structuredClone(manifest);
  wider.sources[0].readers.push("intruder");
  await expect(s.import(f.editor, wider)).rejects.toThrow(
    "SOURCE_SCOPE_CONFLICT",
  );
  const cross = structuredClone(manifest);
  cross.workspaceId = "other";
  await expect(s.import(f.editor, cross)).rejects.toThrow(
    "SOURCE_SCOPE_CONFLICT",
  );
});
it("new IDs remain quarantined with ACL/history preserved and no automatic grant or overwrite", async () => {
  const manifest = await s.export(f.editor, { sourceIds: [source.id] });
  manifest.sources[0].id = "restored-source";
  manifest.sources[0].data.id = "restored-source";
  for (const b of manifest.blobs) b.parent.id = "restored-source";
  const proposal = await s.import(f.editor, manifest);
  expect(
    (await s.importProposal(f.editor, proposal.id)).manifest.sources[0].id,
  ).toBe("restored-source");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM resources WHERE workspace_id=$1 AND id='restored-source'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("rechecks access after filesystem I/O before returning content", async () => {
  const b = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "race.txt",
      mime: "text/plain",
    },
    stream("race"),
  );
  const files = new FileBlobStore(root),
    get = files.get.bind(files);
  files.get = async (hash) => {
    const bytes = await get(hash);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    return bytes;
  };
  await expect(
    new StorageService(f.pool, files, authorize).download(f.reader, b.id),
  ).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'reader')",
    [f.workspaceId, source.id],
  );
});
it("selected tool event ingestion is private, idempotent, monotonic and never execution approval", async () => {
  const input = {
    title: "수집 시험",
    content: "한글 실행 결과라고 주장함",
    tool: "opencode@2.2.2",
    project: "fixture",
    external: { id: "msg_fixture", sessionId: "ses_fixture", version: 2 },
  };
  const a = await s.ingestText(f.editor, input),
    b = await s.ingestText(f.editor, input);
  expect(b.id).toBe(a.id);
  expect(b.duplicate).toBe(true);
  const older = await s.ingestText(f.editor, {
    ...input,
    content: "오래된 버전",
    external: { ...input.external, version: 1 },
  });
  expect(older.id).toBe(a.id);
  expect(older.stale).toBe(true);
  await expect(
    s.ingestText(f.editor, { ...input, content: "다른 본문" }),
  ).rejects.toThrow("EVENT_CONFLICT");
  const saved = await f.pool.query(
    "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, a.id],
  );
  expect(saved.rows[0].data.scope).toBe("private");
  expect(saved.rows[0].data.verification).toBe("미검증");
  expect(saved.rows[0].data.authorPrincipalId).toBe("editor");
  await expect(
    s.download(f.reader, (a as { blobId: string }).blobId),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM versions WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("withdrawn source denies old snapshot, attachment ticket and derived page access", async () => {
  const snapshot = await s.snapshot(f.editor, source.id);
  const ticket = await s.ticket(f.editor, snapshot.blob_id);
  await f.pool.query(
    "INSERT INTO workflow_source_state(workspace_id,source_id,state) VALUES($1,$2,'withdrawn')",
    [f.workspaceId, source.id],
  );
  await expect(s.download(f.editor, snapshot.blob_id)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(s.redeem(f.editor, ticket.token)).rejects.toThrow("NOT_FOUND");
  await expect(s.export(f.editor, { pageIds: [page.id] })).rejects.toThrow(
    "NOT_FOUND",
  );
  await f.pool.query(
    "DELETE FROM workflow_source_state WHERE workspace_id=$1 AND source_id=$2",
    [f.workspaceId, source.id],
  );
});
it("expired ticket and revoked session fail on next request", async () => {
  const snapshot = await s.snapshot(f.editor, source.id);
  const ticket = await s.ticket(f.editor, snapshot.blob_id);
  await f.pool.query(
    "UPDATE storage_tickets SET expires_at=now()-interval '1 second' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(s.redeem(f.editor, ticket.token)).rejects.toThrow("NOT_FOUND");
  const ctx = {
    ...f.editor,
    authorization: {
      revalidate: async () => {
        throw Error("UNAUTHENTICATED");
      },
      assertSession: async () => {},
    },
  };
  await expect(s.download(ctx, snapshot.blob_id)).rejects.toThrow(
    "UNAUTHENTICATED",
  );
});
it("all historical input export/local-copy limits are checked, not only latest inputs", async () => {
  const snapshot = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "history.txt",
      mime: "text/plain",
    },
    stream("historical attachment"),
  );
  let checked = false;
  const restricted = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (_db, _ctx, action, resource) => {
      if (
        action === "local.copy" &&
        resource?.kind === "source" &&
        resource.id === source.id
      ) {
        checked = true;
        throw Error("FORBIDDEN");
      }
    },
  );
  await expect(
    restricted.download(f.editor, snapshot.id, "local.copy"),
  ).rejects.toThrow("FORBIDDEN");
  expect(checked).toBe(true);
});
it("integrates real Task1 policy: reading is not implicit export or local-copy permission", async () => {
  const modern = await fixture();
  try {
    await adoptFixture(modern.pool, modern.workspaceId);
    const service = new StorageService(
      modern.pool,
      new FileBlobStore(root),
      async (db, ctx, action, p) => {
        await authorizeActionDb(db, ctx, action as Action, p);
      },
    );
    const snapshot = await service.snapshot(modern.editor, source.id);
    expect(
      (await service.download(modern.reader, snapshot.blob_id)).bytes.length,
    ).toBeGreaterThan(0);
    await expect(
      service.export(modern.editor, { pageIds: [page.id] }),
    ).rejects.toThrow("FORBIDDEN");
    await modern.pool.query(
      "INSERT INTO access_source_policy(workspace_id,source_id,export_allowed,local_copy_allowed) VALUES($1,$2,true,false)",
      [modern.workspaceId, source.id],
    );
    expect(
      (await service.export(modern.editor, { pageIds: [page.id] })).sources[0]
        .id,
    ).toBe(source.id);
    await expect(
      service.download(modern.reader, snapshot.blob_id, "local.copy"),
    ).rejects.toThrow("FORBIDDEN");
    await modern.pool.query(
      "UPDATE access_source_policy SET local_copy_allowed=true WHERE workspace_id=$1 AND source_id=$2",
      [modern.workspaceId, source.id],
    );
    expect(
      (await service.download(modern.reader, snapshot.blob_id, "local.copy"))
        .bytes.length,
    ).toBeGreaterThan(0);
  } finally {
    await modern.pool.end();
  }
});
it("paginates attachment metadata without dropping rows", async () => {
  const b = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "pagination.txt",
      mime: "text/plain",
    },
    stream("pagination"),
  );
  await f.pool.query(
    "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) SELECT $1,'pagination-'||n,'source',$2,$3,10,'text/plain','pagination.txt','clean','editor' FROM generate_series(1,26) n",
    [f.workspaceId, source.id, b.sha256],
  );
  const first = await s.list(f.editor, { kind: "source", id: source.id }),
    second = await s.list(f.editor, { kind: "source", id: source.id }, 25);
  expect(first.items.length).toBe(25);
  expect(second.items.length).toBe(first.total - 25);
  expect(new Set([...first.items, ...second.items].map((b) => b.id)).size).toBe(
    first.total,
  );
});
it("refuses stale exported ACL lists even when the actor retains access after filesystem I/O", async () => {
  const files = new FileBlobStore(root),
    get = files.get.bind(files);
  files.get = async (hash) => {
    const bytes = await get(hash);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    return bytes;
  };
  try {
    await expect(
      new StorageService(f.pool, files, authorize).export(f.editor, {
        sourceIds: [source.id],
      }),
    ).rejects.toThrow("STALE_VERSION");
  } finally {
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source',$2,'reader') ON CONFLICT DO NOTHING",
      [f.workspaceId, source.id],
    );
  }
});
