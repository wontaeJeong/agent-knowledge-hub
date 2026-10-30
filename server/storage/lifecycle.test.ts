import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, source, page, adoptFixture } from "../test-support";
import { StorageService, type StorageManifest } from "./service";
import { KnowledgeService } from "../service";
import { randomUUID } from "node:crypto";
import { FileBlobStore, sha256 } from "./content";
let f: Awaited<ReturnType<typeof fixture>>, s: StorageService, root: string;
const stream = (text: string) =>
  (async function* () {
    yield Buffer.from(text);
  })();
beforeAll(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "akh-storage-lifecycle-")),
  );
});
beforeEach(async () => {
  f = await fixture();
  s = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (_db, ctx, action) => {
      if (ctx.principalId === "reader" && action !== "knowledge.read")
        throw Error("FORBIDDEN");
    },
  );
});
afterEach(async () => {
  await f?.pool.end();
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("creates actual reviewed import batch with CAS and durable exactly-once result, never publishes", async () => {
  const archive = await s.export(f.editor, { pageIds: [page.id] });
  archive.pages[0].versions[0].content = "검토할 가져온 내용";
  const staged = await s.import(f.editor, archive);
  const input = {
    baseVersions: { [page.id]: 1 },
    reason: "기존 문서 검토 제안",
    sourceMap: {},
  };
  const result = await s.proposeImport(f.editor, staged.id, input);
  const again = await s.proposeImport(f.editor, staged.id, input);
  expect(again.id).toBe(result.id);
  const batch = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, result.id],
    )
  ).rows[0].data;
  expect(batch.status).toBe("pending");
  expect(batch.updates[0].content).toBe("검토할 가져온 내용");
  expect(batch.updates[0].baseVersion).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2",
        [f.workspaceId, page.id],
      )
    ).rows[0].data.content,
  ).toBe("기존 내용");
  await expect(
    s.proposeImport(f.editor, staged.id, {
      ...input,
      baseVersions: { [page.id]: 2 },
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await f.pool.query(
    "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
});
it("rejects forged/new team raw sources and stale page CAS before creating effects", async () => {
  const archive = await s.export(f.editor, { pageIds: [page.id] });
  archive.pages[0].versions[0].content = "정책 오류 시험";
  archive.sources[0].data.content = "원본 위조";
  let staged = await s.import(f.editor, archive);
  await expect(
    s.proposeImport(f.editor, staged.id, {
      baseVersions: { [page.id]: 1 },
      reason: "정책 시험",
    }),
  ).rejects.toThrow("IMMUTABLE_SOURCE_MISMATCH");
  archive.sources[0].id = "unknown-raw";
  archive.sources[0].data.id = "unknown-raw";
  archive.pages[0].versions[0].sourceIds = ["unknown-raw"];
  archive.blobs = [];
  staged = await s.import(f.editor, archive);
  await expect(
    s.proposeImport(f.editor, staged.id, {
      baseVersions: { [page.id]: 1 },
      reason: "정책 시험",
    }),
  ).rejects.toThrow("IMPORT_SOURCE_REGISTRATION_REQUIRED");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM sources WHERE workspace_id=$1 AND id='unknown-raw'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  const clean = await s.export(f.editor, { pageIds: [page.id] });
  clean.pages[0].versions[0].content = "CAS 오류 시험";
  const cas = await s.import(f.editor, clean);
  await expect(
    s.proposeImport(f.editor, cas.id, {
      baseVersions: { [page.id]: 99 },
      reason: "CAS 시험",
    }),
  ).rejects.toThrow("STALE_VERSION");
  const newPage = await s.export(f.editor, { pageIds: [page.id] });
  newPage.pages[0].id = "team-new-page";
  newPage.pages[0].data.id = "team-new-page";
  newPage.blobs = [];
  const denied = await s.import(f.editor, newPage);
  await expect(
    s.proposeImport(f.editor, denied.id, {
      baseVersions: { "team-new-page": 0 },
      reason: "팀 새 ID 금지",
    }),
  ).rejects.toThrow("NEW_ID_IMPORT_PERSONAL_ONLY");
});
it("rolls back actual batch/effect together when current authorization fails in the trusted creation hook", async () => {
  const archive = await s.export(f.editor, { pageIds: [page.id] });
  archive.pages[0].versions[0].content = "rollback-marker";
  const staged = await s.import(f.editor, archive);
  const restricted = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (db, _ctx, action) => {
      if (action === "source.create") {
        const r = await db.query(
          "SELECT 1 FROM batches WHERE workspace_id=$1 AND data->'updates' @> '[{\"content\":\"rollback-marker\"}]'::jsonb",
          [f.workspaceId],
        );
        if (r.rowCount) throw Error("ACL_REVOKED");
      }
    },
  );
  await expect(
    restricted.proposeImport(f.editor, staged.id, {
      baseVersions: { [page.id]: 1 },
      reason: "원자성 시험",
    }),
  ).rejects.toThrow("ACL_REVOKED");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM storage_import_effects WHERE workspace_id=$1 AND import_id=$2",
        [f.workspaceId, staged.id],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1 AND data->'updates' @> '[{\"content\":\"rollback-marker\"}]'::jsonb",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("concurrent import retries create only one durable real changeset", async () => {
  const archive = await s.export(f.editor, { pageIds: [page.id] });
  archive.pages[0].versions[0].content = "concurrent-import";
  const staged = await s.import(f.editor, archive),
    input = { baseVersions: { [page.id]: 1 }, reason: "중복 시험" };
  const results = await Promise.all([
    s.proposeImport(f.editor, staged.id, input),
    s.proposeImport(f.editor, staged.id, input),
  ]);
  expect(results[0].id).toBe(results[1].id);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1 AND data->'updates' @> '[{\"content\":\"concurrent-import\"}]'::jsonb",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("permits new IDs only in the owning personal namespace, forcing private unverified raw staging and real proposal", async () => {
  const personal = await fixture();
  try {
    await adoptFixture(personal.pool, personal.workspaceId);
    await personal.pool.query(
      "UPDATE access_namespaces SET kind='personal',owner_id='editor' WHERE id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
      [personal.workspaceId],
    );
    const service = new StorageService(
        personal.pool,
        new FileBlobStore(root),
        async () => {},
      ),
      bytes = Buffer.from("개인 첨부 원문");
    const archive: StorageManifest = {
      format: "akh-export",
      version: 1,
      workspaceId: personal.workspaceId,
      exportedAt: new Date().toISOString(),
      sources: [
        {
          id: "personal-raw",
          data: {
            ...source,
            id: "personal-raw",
            content: "개인 원본",
            scope: "company",
            verification: "검증",
            license: "원문 제한 보존",
          },
          readers: ["editor", "intruder"],
        },
      ],
      pages: [
        {
          id: "personal-import",
          data: {
            id: "personal-import",
            title: "개인 가져오기",
            summary: "",
            links: [],
            scope: "company",
            owner: "intruder",
          },
          versions: [
            {
              number: 1,
              content: "[첨부](/api/v1/storage/blobs/imported-file)",
              sourceIds: ["personal-raw"],
            },
          ],
          readers: ["editor", "intruder"],
          operational: { parent_id: null },
        },
      ],
      blobs: [
        {
          id: "imported-file",
          parent: { kind: "page", id: "personal-import" },
          sha256: sha256(bytes),
          mime: "text/plain",
          filename: "private.txt",
          base64: bytes.toString("base64"),
          scanState: "clean",
          attachment: {
            slotId: "original-slot",
            revision: 2,
            headId: "imported-file",
            headRevision: 2,
          },
        },
      ],
    };
    const oldBytes = Buffer.from("이전 파일 버전");
    archive.blobs.push({
      id: "previous-file",
      parent: { kind: "page", id: "personal-import" },
      sha256: sha256(oldBytes),
      mime: "text/plain",
      filename: "old.txt",
      base64: oldBytes.toString("base64"),
      scanState: "clean",
      attachment: {
        slotId: "original-slot",
        revision: 1,
        headId: "imported-file",
        headRevision: 2,
      },
    });
    archive.pages[0].versions[0].content =
      "[첨부](/api/v1/storage/attachments/original-slot)";
    const staged = await service.import(personal.editor, archive);
    const result = await service.proposeImport(personal.editor, staged.id, {
      baseVersions: { "personal-import": 0 },
      reason: "개인 지식 검토",
    });
    const raw = (
      await personal.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id='personal-raw'",
        [personal.workspaceId],
      )
    ).rows[0].data;
    expect(raw.scope).toBe("private");
    expect(raw.verification).toBe("미검증");
    expect(raw.processed).toBe(false);
    expect(
      (
        await personal.pool.query(
          "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='personal-raw'",
          [personal.workspaceId],
        )
      ).rows,
    ).toEqual([{ principal_id: "editor" }]);
    expect(
      (
        await personal.pool.query(
          "SELECT 1 FROM pages WHERE workspace_id=$1 AND id='personal-import'",
          [personal.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    const batch = (
      await personal.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [personal.workspaceId, result.id],
      )
    ).rows[0].data;
    expect(batch.updates[0].scope).toBe("private");
    expect(batch.updates[0].content).toContain(result.blobMap["imported-file"]);
    expect(batch.updates[0].content).not.toContain("/blobs/imported-file");
    expect(
      (
        await service.download(personal.editor, result.blobMap["imported-file"])
      ).bytes.toString(),
    ).toBe("개인 첨부 원문");
    const restored = await service.attachmentHistory(
      personal.editor,
      result.slotMap["original-slot"],
    );
    expect(restored.items.map((v) => v.revision)).toEqual([2, 1]);
    expect(
      (
        await service.downloadAttachment(
          personal.editor,
          result.slotMap["original-slot"],
          1,
        )
      ).bytes.toString(),
    ).toBe("이전 파일 버전");
    expect(
      (await service.importProposal(personal.editor, staged.id)).manifest
        .sources[0].data.license,
    ).toBe("원문 제한 보존");
  } finally {
    await personal.pool.end();
  }
});
it("attachment replacement races preserve exactly one head, reject cross-parent replacement, and deny unsupported binary preview", async () => {
  const first = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "race.txt",
      mime: "text/plain",
    },
    stream("first"),
  );
  const replace = {
    parent: { kind: "source" as const, id: source.id },
    filename: "race.txt",
    mime: "text/plain",
    slotId: first.slotId,
    expectedHead: first.id,
    expectedRevision: 1,
  };
  const results = await Promise.allSettled([
    s.upload(f.editor, replace, stream("winner-a")),
    s.upload(f.editor, replace, stream("winner-b")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const history = await s.attachmentHistory(f.reader, first.slotId);
  expect(history.items).toHaveLength(2);
  expect(history.revision).toBe(2);
  await expect(
    s.upload(
      f.editor,
      {
        ...replace,
        parent: { kind: "page", id: page.id },
        expectedHead: history.headId,
        expectedRevision: 2,
      },
      stream("cross-parent"),
    ),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  const pdf = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "binary.pdf",
      mime: "application/pdf",
    },
    stream("%PDF-1.7\n%%EOF"),
  );
  await s.recordScan(f.ctx, pdf.id, pdf.sha256, "clean");
  await expect(s.previewAttachment(f.reader, pdf.slotId)).rejects.toThrow(
    "UNSUPPORTED_PREVIEW",
  );
});
it("requires registered correction provenance and original reader upper bounds for explicit source replacements", async () => {
  const manifest = await s.export(f.editor, { pageIds: [page.id] });
  manifest.pages[0].versions[0].content = "정정 원본 기반 제안";
  const archive = await s.import(f.editor, manifest);
  const core = new KnowledgeService(f.pool),
    replacement = {
      ...source,
      id: "registered-correction",
      content: "정정 원본 본문",
      verification: "미검증" as const,
    };
  await core.registerSource(f.editor, replacement, [
    "editor",
    "reviewer",
    "reader",
  ]);
  const input = {
    baseVersions: { [page.id]: 1 },
    sourceMap: { [source.id]: replacement.id },
    reason: "명시 정정 매핑",
  };
  await expect(s.proposeImport(f.editor, archive.id, input)).rejects.toThrow(
    "SOURCE_SCOPE_CONFLICT",
  );
  await f.pool.query(
    "INSERT INTO workflow_events VALUES($1,$2,'editor','source.correct',$3,$4,now())",
    [
      f.workspaceId,
      randomUUID(),
      source.id,
      { replacementId: replacement.id, reason: "등록된 원본 정정" },
    ],
  );
  const result = await s.proposeImport(f.editor, archive.id, input);
  const batch = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, result.id],
    )
  ).rows[0].data;
  expect(batch.updates[0].sourceIds).toEqual(
    expect.arrayContaining([source.id, replacement.id]),
  );
  expect(
    (
      await f.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, source.id],
      )
    ).rows[0].data.content,
  ).toBe(source.content);
});
it("never trusts an imported binary clean label or serves its unapproved bytes through the archive route", async () => {
  const manifest = await s.export(f.editor, { pageIds: [page.id] }),
    bytes = Buffer.from("%PDF-1.7\n%%EOF");
  manifest.blobs.push({
    id: "unapproved-import",
    parent: { kind: "page", id: page.id },
    sha256: sha256(bytes),
    mime: "application/pdf",
    filename: "unapproved.pdf",
    base64: bytes.toString("base64"),
    scanState: "clean",
    attachment: null,
  });
  const staged = await s.import(f.editor, manifest),
    view = await s.importProposal(f.editor, staged.id);
  expect(view.manifest.blobs[0].base64).toBe("");
  expect(view.manifest.blobs[0].contentOmitted).toBe(true);
  expect(view.manifest.blobs[0].effectiveScanState).toBe("pending");
  await expect(
    s.proposeImport(f.editor, staged.id, {
      baseVersions: { [page.id]: 1 },
      reason: "미승인 바이너리 차단",
    }),
  ).rejects.toThrow("IMPORTED_BINARY_SCAN_REQUIRED");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("restores imported tree narrowing through reviewed parent dependencies without trusting imported histories or roles", async () => {
  const personal = await fixture();
  try {
    await adoptFixture(personal.pool, personal.workspaceId);
    await personal.pool.query(
      "UPDATE access_namespaces SET kind='personal',owner_id='editor' WHERE id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
      [personal.workspaceId],
    );
    const service = new StorageService(
      personal.pool,
      new FileBlobStore(root),
      async () => {},
    );
    const manifest: StorageManifest = {
      format: "akh-export",
      version: 1,
      workspaceId: personal.workspaceId,
      exportedAt: new Date().toISOString(),
      sources: ["child-source", "parent-source"].map((id) => ({
        id,
        data: { ...source, id, content: "원본 " + id },
        readers: ["editor"],
      })),
      pages: [
        {
          id: "child-import",
          data: { id: "child-import", title: "하위", links: [], role: "owner" },
          versions: [
            { number: 1, content: "하위 내용", sourceIds: ["child-source"] },
          ],
          readers: ["editor"],
          operational: {
            parent_id: "parent-import",
            data: { protected: true },
          },
        },
        {
          id: "parent-import",
          data: { id: "parent-import", title: "상위", links: [] },
          versions: [
            { number: 1, content: "과거 상위", sourceIds: ["parent-source"] },
            { number: 2, content: "현재 상위", sourceIds: ["parent-source"] },
          ],
          readers: ["editor"],
          operational: { parent_id: null },
        },
      ],
      blobs: [],
    };
    const staged = await service.import(personal.editor, manifest),
      result = await service.proposeImport(personal.editor, staged.id, {
        baseVersions: { "child-import": 0, "parent-import": 0 },
        reason: "트리 복원 검토",
      });
    const batch = (
        await personal.pool.query(
          "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
          [personal.workspaceId, result.id],
        )
      ).rows[0].data,
      child = batch.updates.find(
        (d: { id: string }) => d.id === "child-import",
      );
    expect(child.links).toContain("parent-import");
    expect(child.sourceIds).toEqual(
      expect.arrayContaining(["child-source", "parent-source"]),
    );
    expect(
      batch.updates.every((d: { scope: string }) => d.scope === "private"),
    ).toBe(true);
    const archive = await service.importProposal(personal.editor, staged.id);
    expect(archive.manifest.pages[1].versions).toHaveLength(2);
    expect(archive.manifest.pages[0].operational?.data).toEqual({
      protected: true,
    });
    expect(
      (
        await personal.pool.query(
          "SELECT 1 FROM pages WHERE workspace_id=$1 AND id IN ('parent-import','child-import')",
          [personal.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await personal.pool.end();
  }
});
it("implements authenticated logical attachment head replacement CAS and immutable text preview", async () => {
  const first = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "first.md",
      mime: "text/markdown",
    },
    stream("# 최초"),
  );
  expect(first.slotId).toBeTruthy();
  const second = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "second.md",
      mime: "text/markdown",
      slotId: first.slotId,
      expectedHead: first.id,
      expectedRevision: 1,
    },
    stream("# 교체"),
  );
  expect(second.revision).toBe(2);
  expect(
    (await s.downloadAttachment(f.reader, first.slotId)).bytes.toString(),
  ).toBe("# 교체");
  expect((await s.download(f.reader, first.id)).bytes.toString()).toBe(
    "# 최초",
  );
  expect((await s.previewAttachment(f.reader, first.slotId)).text).toBe(
    "# 교체",
  );
  await expect(
    s.upload(
      f.editor,
      {
        parent: { kind: "page", id: page.id },
        filename: "stale.md",
        mime: "text/markdown",
        slotId: first.slotId,
        expectedHead: first.id,
        expectedRevision: 1,
      },
      stream("stale"),
    ),
  ).rejects.toThrow("STALE_VERSION");
  const link = await s.proposeAttachmentLink(f.editor, first.slotId, {
    baseVersion: 1,
    expectedHead: second.id,
    reason: "첨부 연결",
  });
  expect(link.id).toBeTruthy();
  const batch = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, link.id],
    )
  ).rows[0].data;
  expect(batch.updates[0].content).toContain(
    "/api/v1/storage/blobs/" + second.id,
  );
  expect(batch.updates[0].content).not.toContain(
    "/attachments/" + first.slotId,
  );
  await s.withdrawAttachment(f.editor, first.slotId, {
    expectedRevision: 2,
    reason: "첨부 철회",
  });
  expect(
    (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, link.id],
      )
    ).rows[0].data.status,
  ).toBe("conflict");
  await expect(s.downloadAttachment(f.reader, first.slotId)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(s.download(f.reader, first.id)).rejects.toThrow("NOT_FOUND");
});
