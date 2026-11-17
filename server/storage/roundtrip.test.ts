import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, adoptLegacyFixture, page, source } from "../test-support";
import { StorageService, type StorageManifest } from "./service";
import { FileBlobStore, sha256 } from "./content";
import { KnowledgeService } from "../service";
import { transaction } from "../database";
import { capturePublishedVersionMetadata } from "../workflows/versions/metadata";
import { authorizeInTransaction } from "../access/index";

async function setup() {
  const f = await fixture();
  await adoptLegacyFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='reviewer'",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,export_allowed,local_copy_allowed) VALUES($1,'source-a',true,true) ON CONFLICT(workspace_id,source_id) DO UPDATE SET export_allowed=true,local_copy_allowed=true",
    [f.workspaceId],
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), "akh-roundtrip-")));
  const storage = new StorageService(
      f.pool,
      new FileBlobStore(root),
      authorizeInTransaction,
    ),
    core = new KnowledgeService(f.pool);
  return {
    ...f,
    storage,
    core,
    close: async () => {
      await f.pool.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function tree(f: Awaited<ReturnType<typeof setup>>) {
  await transaction(f.pool, f.workspaceId, async (db) => {
    await db.query("INSERT INTO resources VALUES($1,'page','child')", [
      f.workspaceId,
    ]);
    await db.query(
      "INSERT INTO resource_readers SELECT workspace_id,kind,'child',principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic'",
      [f.workspaceId],
    );
    const { versions, ...data } = page;
    await db.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,'child',$2)",
      [
        f.workspaceId,
        {
          ...data,
          id: "child",
          title: "Child",
          tags: ["child-tag"],
          facts: [
            {
              key: "retry",
              context: "fixture",
              value: "yes",
              sourceId: "source-a",
              quote: "실패 시 재시도한다.",
            },
          ],
        },
      ],
    );
    await db.query("INSERT INTO versions VALUES($1,'child',1,$2)", [
      f.workspaceId,
      { ...versions[0], content: "Child original" },
    ]);
    for (const [id, parent] of [
      ["topic", null],
      ["child", "topic"],
    ]) {
      await db.query(
        "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id,data) VALUES($1,$2,$3,$4)",
        [
          f.workspaceId,
          id,
          parent,
          {
            properties: { owner: "Historical owner" },
            environment: { cluster: "test" },
            protected: true,
            reviewDue: "2026-12-01",
          },
        ],
      );
      await db.query("INSERT INTO versions VALUES($1,$2,2,$3)", [
        f.workspaceId,
        id,
        {
          ...versions[0],
          number: 2,
          content: id === "child" ? "Child current" : "Parent current",
        },
      ]);
      await capturePublishedVersionMetadata(db, f.editor, id!, 2);
    }
  });
}

test("v2 archive restores reviewed actual tree/properties/facts and reexports historical evidence without importing authority", async () => {
  const f = await setup();
  try {
    await tree(f);
    await f.storage.snapshot(f.editor, "source-a");
    const archive = await f.storage.export(f.editor, { pageIds: ["child"] });
    expect(archive.version).toBe(2);
    const exported = archive.pages.find((p) => p.id === "child")!;
    expect(exported.history?.snapshots).toEqual([
      expect.objectContaining({
        number: 2,
        snapshot: expect.objectContaining({
          parentId: "topic",
          properties: { owner: "Historical owner" },
        }),
      }),
    ]);
    await f.pool.query(
      'UPDATE workflow_document_state SET parent_id=NULL,data=\' {"properties":{"owner":"Current owner"},"protected":true,"reviewDue":"2027-01-01"}\',revision=revision+1 WHERE workspace_id=$1 AND page_id=\'child\'',
      [f.workspaceId],
    );
    await f.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{tags}','[\"current-tag\"]') WHERE workspace_id=$1 AND id='child'",
      [f.workspaceId],
    );
    const acl = (
      await f.pool.query(
        "SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",
        [f.workspaceId],
      )
    ).rows;
    const staged = await f.storage.import(f.editor, archive),
      input = {
        baseVersions: { child: 2, topic: 2 },
        reason: "Review tree and properties",
      };
    const b = await f.storage.proposeImport(f.editor, staged.id, input);
    expect((await f.storage.proposeImport(f.editor, staged.id, input)).id).toBe(
      b.id,
    );
    expect(
      (
        await f.pool.query(
          "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id='child'",
          [f.workspaceId],
        )
      ).rows[0].parent_id,
    ).toBeNull();
    await expect(f.core.approve(f.editor, b.id, b.hash)).rejects.toThrow();
    await f.core.approve(f.ctx, b.id, b.hash);
    await f.core.publish(f.ctx, b.id, b.hash, "roundtrip");
    expect(
      (
        await f.pool.query(
          "SELECT parent_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id='child'",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({
      parent_id: "topic",
      data: {
        properties: { owner: "Historical owner" },
        environment: { cluster: "test" },
        protected: true,
        reviewDue: "2027-01-01",
      },
    });
    expect(
      (
        await f.pool.query(
          "SELECT data FROM pages WHERE workspace_id=$1 AND id='child'",
          [f.workspaceId],
        )
      ).rows[0].data,
    ).toMatchObject({
      tags: ["child-tag"],
      facts: [
        {
          key: "retry",
          context: "fixture",
          value: "yes",
          sourceId: "source-a",
          quote: "실패 시 재시도한다.",
        },
      ],
    });
    expect(
      (
        await f.pool.query(
          "SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual(acl);
    const again = await f.storage.export(f.editor, { pageIds: ["child"] }),
      child = again.pages.find((p) => p.id === "child")!;
    expect(child.history?.importedEvidence).toEqual([
      expect.objectContaining({
        trust: "unverified-import",
        page: expect.objectContaining({
          id: "child",
          versions: exported.versions,
          history: exported.history,
        }),
      }),
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM version_metadata WHERE workspace_id=$1 AND page_id='child' AND number=1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      await f.core.publish(f.ctx, b.id, b.hash, "roundtrip-retry"),
    ).toMatchObject({ versions: { child: 3, topic: 3 } });
  } finally {
    await f.close();
  }
});

test("approved import blocks metadata drift and source revocation without partial version publication", async () => {
  const f = await setup();
  try {
    await tree(f);
    const archive = await f.storage.export(f.editor, { pageIds: ["child"] });
    archive.pages.find((p) => p.id === "child")!.operational!.data = {
      properties: { owner: "Restored" },
    };
    const staged = await f.storage.import(f.editor, archive),
      b = await f.storage.proposeImport(f.editor, staged.id, {
        baseVersions: { child: 2, topic: 2 },
        reason: "Review",
      });
    await f.core.approve(f.ctx, b.id, b.hash);
    await f.pool.query(
      "UPDATE workflow_document_state SET revision=revision+1 WHERE workspace_id=$1 AND page_id='child'",
      [f.workspaceId],
    );
    await expect(
      f.core.publish(f.ctx, b.id, b.hash, "stale"),
    ).rejects.toThrow();
    expect(
      (
        await f.pool.query(
          "SELECT max(number)::int n FROM versions WHERE workspace_id=$1 AND page_id='child'",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(2);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    await expect(f.storage.importProposal(f.editor, staged.id)).rejects.toThrow(
      "NOT_FOUND",
    );
  } finally {
    await f.close();
  }
});

test("new personal v2 pages publish their actual tree and safe properties with only current personal authority", async () => {
  const f = await setup();
  try {
    await f.pool.query(
      "UPDATE access_namespaces SET kind='personal',owner_id='editor' WHERE id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
      [f.workspaceId],
    );
    const archive: StorageManifest = {
      format: "akh-export",
      version: 2,
      workspaceId: f.workspaceId,
      exportedAt: new Date().toISOString(),
      sources: [
        {
          id: "new-source",
          data: {
            ...source,
            id: "new-source",
            content: "new source",
            scope: "company",
            verification: "검증",
          },
          readers: ["editor", "intruder"],
        },
      ],
      pages: ["new-child", "new-parent"].map((id) => ({
        id,
        data: {
          id,
          title: id,
          category: "Imported",
          tags: ["restored"],
          links: [],
          owner: "intruder",
          status: "공식 기준",
        },
        versions: [{ number: 12, content: id, sourceIds: ["new-source"] }],
        readers: ["editor", "intruder"],
        operational: {
          parent_id: id === "new-child" ? "new-parent" : null,
          data: {
            properties: { owner: "Product owner" },
            environment: { cluster: "test" },
            protected: false,
          },
        },
        history: { snapshots: [], events: [], importedEvidence: [] },
      })),
      blobs: [],
    };
    archive.blobs.push(
      ...["new-file", "new-file-head"].map((id, i) => ({
        id,
        parent: { kind: "page" as const, id: "new-child" },
        sha256: sha256("Attachment" + i),
        mime: "text/plain",
        filename: "new.txt",
        base64: Buffer.from("Attachment" + i).toString("base64"),
        scanState: "clean" as const,
        attachment: {
          slotId: "new-slot",
          revision: i + 1,
          headId: "new-file-head",
          headRevision: 2,
        },
      })),
    );
    const staged = await f.storage.import(f.editor, archive),
      b = await f.storage.proposeImport(f.editor, staged.id, {
        baseVersions: { "new-child": 0, "new-parent": 0 },
        reason: "Personal restore",
      });
    await f.core.approve(f.editor, b.id, b.hash);
    await f.core.publish(f.editor, b.id, b.hash, "new-personal");
    expect(
      (
        await f.pool.query(
          "SELECT parent_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id='new-child'",
          [f.workspaceId],
        )
      ).rows[0],
    ).toEqual({
      parent_id: "new-parent",
      data: {
        properties: { owner: "Product owner" },
        environment: { cluster: "test" },
      },
    });
    expect(
      (
        await f.pool.query(
          "SELECT data FROM pages WHERE workspace_id=$1 AND id='new-child'",
          [f.workspaceId],
        )
      ).rows[0].data,
    ).toMatchObject({
      scope: "private",
      owner: "editor",
      status: "미검증",
      tags: ["restored"],
      category: "Imported",
    });
    expect(
      (
        await f.pool.query(
          "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='new-child'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ principal_id: "editor" }]);
    expect(
      (
        await f.pool.query(
          "SELECT number FROM versions WHERE workspace_id=$1 AND page_id='new-child'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ number: 1 }]);
    expect(
      (
        await f.pool.query(
          "SELECT parent_kind,parent_id FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, b.blobMap["new-file"]],
        )
      ).rows[0],
    ).toEqual({ parent_kind: "page", parent_id: "new-child" });
    await f.pool.query(
      "INSERT INTO access_source_policy(workspace_id,source_id,export_allowed,local_copy_allowed) VALUES($1,'new-source',true,true)",
      [f.workspaceId],
    );
    const out = await f.storage.export(f.editor, { pageIds: ["new-child"] });
    const evidence = out.pages.find((p) => p.id === "new-child")!.history!
      .importedEvidence[0];
    expect(evidence.blobMap).toMatchObject({
      "new-file": b.blobMap["new-file"],
      "new-file-head": b.blobMap["new-file-head"],
    });
    expect(evidence.blobs).toEqual(
      archive.blobs.map(({ base64: _bytes, ...metadata }) => metadata),
    );
  } finally {
    await f.close();
  }
});

test("v2 default personal parent remains a valid absent parent dependency and published evidence keeps original source metadata", async () => {
  const f = await setup();
  try {
    await f.pool.query(
      "UPDATE access_namespaces SET kind='personal',owner_id='editor' WHERE id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
      [f.workspaceId],
    );
    const archive: StorageManifest = {
      format: "akh-export",
      version: 2,
      workspaceId: f.workspaceId,
      exportedAt: new Date().toISOString(),
      sources: [
        {
          id: "personal-raw",
          data: {
            ...source,
            id: "personal-raw",
            content: "raw",
            license: "Original license",
          },
          readers: ["editor"],
        },
      ],
      pages: ["bare-parent", "bare-child"].map((id) => ({
        id,
        data: { id, title: id, links: [] },
        versions: [{ number: 7, content: "body", sourceIds: ["personal-raw"] }],
        readers: ["editor"],
        operational: { parent_id: id === "bare-child" ? "bare-parent" : null },
        history: { snapshots: [], events: [], importedEvidence: [] },
      })),
      blobs: [],
    };
    const staged = await f.storage.import(f.editor, archive),
      b = await f.storage.proposeImport(f.editor, staged.id, {
        baseVersions: { "bare-parent": 0, "bare-child": 0 },
        reason: "Default metadata",
      });
    await f.core.approve(f.editor, b.id, b.hash);
    await f.core.publish(f.editor, b.id, b.hash, "defaults");
    await expect(
      f.storage.export(f.editor, { pageIds: ["bare-child"] }),
    ).rejects.toThrow("FORBIDDEN");
    await f.pool.query(
      "INSERT INTO access_source_policy(workspace_id,source_id,export_allowed,local_copy_allowed) VALUES($1,'personal-raw',true,true)",
      [f.workspaceId],
    );
    const out = await f.storage.export(f.editor, { pageIds: ["bare-child"] });
    expect(
      out.pages.find((p) => p.id === "bare-child")!.history!.importedEvidence[0]
        .sources,
    ).toEqual(archive.sources);
  } finally {
    await f.close();
  }
});

test("export refuses inaccessible historical parents even when the current tree is detached", async () => {
  const f = await setup();
  try {
    await tree(f);
    await f.pool.query(
      "UPDATE workflow_document_state SET parent_id=NULL WHERE workspace_id=$1 AND page_id='child'",
      [f.workspaceId],
    );
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='editor'",
      [f.workspaceId],
    );
    await expect(
      f.storage.export(f.editor, { pageIds: ["child"] }),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.close();
  }
});

test("published selective review retains imported historical evidence across the derived batch", async () => {
  const f = await setup();
  try {
    const archive = await f.storage.export(f.editor, { pageIds: ["topic"] });
    const staged = await f.storage.import(f.editor, archive),
      b = await f.storage.proposeImport(f.editor, staged.id, {
        baseVersions: { topic: 1 },
        reason: "History import",
      });
    const { VersionService } = await import("../workflows/versions/service");
    const versions = new VersionService(f.pool, authorizeInTransaction);
    const selected = await versions.decideSelection(f.ctx, {
      batchId: b.id,
      expectedHash: b.hash,
      pageIds: ["topic"],
      decision: "approve",
      reasons: { topic: "Independent selection" },
    });
    await f.core.approve(f.ctx, selected.batchId!, selected.hash!);
    await f.core.publish(
      f.ctx,
      selected.batchId!,
      selected.hash!,
      "derived-import",
    );
    const out = await f.storage.export(f.editor, { pageIds: ["topic"] });
    expect(out.pages[0].history?.importedEvidence).toEqual([
      expect.objectContaining({
        importId: staged.id,
        trust: "unverified-import",
      }),
    ]);
  } finally {
    await f.close();
  }
});

test("v2 import freezes unchanged metadata too, so edits between proposal and review require a fresh proposal", async () => {
  const f = await setup();
  try {
    const archive = await f.storage.export(f.editor, { pageIds: ["topic"] });
    const staged = await f.storage.import(f.editor, archive),
      b = await f.storage.proposeImport(f.editor, staged.id, {
        baseVersions: { topic: 1 },
        reason: "Same metadata import",
      });
    await f.pool.query(
      'INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,\'topic\',\'{"properties":{"owner":"Changed later"}}\')',
      [f.workspaceId],
    );
    await expect(f.core.approve(f.ctx, b.id, b.hash)).rejects.toThrow(
      "STALE_VERSION",
    );
  } finally {
    await f.close();
  }
});

test("native authenticated HTTP/PG export → stage → independent review → atomic publish restores tree/properties with historical attachment bytes", async () => {
  const f = await setup();
  const provider = createServer((req, res) => {
    const sub = req.headers.authorization?.replace("Bearer ", "") ?? "";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub, groups: [sub] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    editor: "editor",
    reviewer: "reviewer",
    reader: "reader",
  });
  const cookies: Record<string, string> = {};
  for (const principal of ["editor", "reviewer", "reader"]) {
    cookies[principal] = randomUUID();
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,'csrf',now()+interval '1 hour',$3,$3)",
      [sessionHash(cookies[principal]), f.workspaceId, principal],
    );
  }
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      storage: f.storage,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = (principal: string) => ({
    Cookie: `akh_session=${cookies[principal] ?? "missing"}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
    "X-CSRF-Token": "csrf",
  });
  const request = async (
    path: string,
    principal = "editor",
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(base + "/api/v1/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers(principal), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await tree(f);
    expect(
      (await request("storage/export", "missing", { pageIds: ["child"] }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(
          "storage/export",
          "editor",
          { pageIds: ["child"] },
          { "X-CSRF-Token": "bad" },
        )
      ).status,
    ).toBe(403);
    const upload = async (text: string, extra: Record<string, string> = {}) => {
      const r = await fetch(base + "/api/v1/storage/blobs", {
        method: "PUT",
        headers: {
          ...headers("editor"),
          "Content-Type": "text/plain",
          "x-parent-kind": "page",
          "x-parent-id": "child",
          "x-filename": "roundtrip.txt",
          ...extra,
        },
        body: text,
      });
      expect(r.status).toBe(201);
      return r.json();
    };
    const first = await upload("Attachment original");
    const second = await upload("Attachment current", {
      "x-attachment-slot": first.slotId,
      "x-expected-head": first.id,
      "x-expected-revision": "1",
    });
    const exported = await request("storage/export", "editor", {
      pageIds: ["child"],
    });
    expect(exported.status).toBe(200);
    const archive = exported.body as StorageManifest;
    expect(archive.version).toBe(2);
    expect(archive.blobs).toHaveLength(2);
    expect(archive.sources[0].data.content).toBe(source.content);
    await f.pool.query(
      "UPDATE workflow_document_state SET parent_id=NULL,data='{}',revision=revision+1 WHERE workspace_id=$1 AND page_id='child'",
      [f.workspaceId],
    );
    const staged = await request("storage/import", "editor", archive);
    expect(staged.status).toBe(201);
    const proposed = await request(
      `storage/imports/${staged.body.id}/propose`,
      "editor",
      { baseVersions: { child: 2, topic: 2 }, reason: "Native round trip" },
    );
    expect(proposed.status).toBe(201);
    const b = proposed.body;
    expect(
      (await request(`changesets/${b.id}/approve`, "editor", { hash: b.hash }))
        .status,
    ).toBe(403);
    expect(
      (
        await request(`changesets/${b.id}/approve`, "reviewer", {
          hash: b.hash,
        })
      ).status,
    ).toBe(200);
    const published = await request(
      `changesets/${b.id}/publish`,
      "reviewer",
      { hash: b.hash },
      { "Idempotency-Key": "native-roundtrip" },
    );
    expect(published.status).toBe(200);
    expect(published.body.versions).toEqual({ child: 3, topic: 3 });
    expect(
      (
        await request(
          `changesets/${b.id}/publish`,
          "reviewer",
          { hash: b.hash },
          { "Idempotency-Key": "native-roundtrip-retry" },
        )
      ).body,
    ).toMatchObject({ versions: { child: 3, topic: 3 } });
    const out = await request("storage/export", "editor", {
      pageIds: ["child"],
    });
    expect(out.status).toBe(200);
    expect(
      out.body.pages.find((p: { id: string }) => p.id === "child"),
    ).toMatchObject({
      operational: {
        parent_id: "topic",
        data: {
          properties: { owner: "Historical owner" },
          environment: { cluster: "test" },
        },
      },
      history: {
        importedEvidence: [
          expect.objectContaining({ trust: "unverified-import" }),
        ],
      },
    });
    const original = await fetch(
      base + `/api/v1/storage/attachments/${first.slotId}/versions/1`,
      { headers: headers("reader") },
    );
    expect(original.status).toBe(200);
    expect(await original.text()).toBe("Attachment original");
    const latest = await fetch(base + `/api/v1/storage/blobs/${second.id}`, {
      headers: headers("reader"),
    });
    expect(latest.status).toBe(200);
    expect(await latest.text()).toBe("Attachment current");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    expect((await request(`storage/imports/${staged.body.id}`)).status).toBe(
      404,
    );
    expect(
      (await request("storage/export", "editor", { pageIds: ["child"] }))
        .status,
    ).toBe(404);
  } finally {
    for (const s of [server, provider])
      await new Promise<void>((resolve) => s.close(() => resolve()));
    await f.close();
  }
}, 20000);

test.each(["scan", "head"] as const)(
  "publication rejects changed imported attachment %s without partially publishing page versions",
  async (kind) => {
    const f = await setup();
    try {
      await tree(f);
      const uploaded = await f.storage.upload(
        f.editor,
        {
          parent: { kind: "page", id: "child" },
          filename: "file.txt",
          mime: "text/plain",
        },
        (async function* () {
          yield Buffer.from("original");
        })(),
      );
      const archive = await f.storage.export(f.editor, { pageIds: ["child"] });
      const staged = await f.storage.import(f.editor, archive),
        b = await f.storage.proposeImport(f.editor, staged.id, {
          baseVersions: { child: 2, topic: 2 },
          reason: "Attachment review",
        });
      await f.core.approve(f.ctx, b.id, b.hash);
      if (kind === "scan")
        await f.pool.query(
          "UPDATE storage_blobs SET scan_state='pending' WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, uploaded.id],
        );
      else
        await f.storage.upload(
          f.editor,
          {
            parent: { kind: "page", id: "child" },
            filename: "file.txt",
            mime: "text/plain",
            slotId: uploaded.slotId,
            expectedHead: uploaded.id,
            expectedRevision: 1,
          },
          (async function* () {
            yield Buffer.from("new head");
          })(),
        );
      await expect(
        f.core.publish(f.ctx, b.id, b.hash, "stale-attachment-" + kind),
      ).rejects.toThrow(kind === "scan" ? "SCAN_REQUIRED" : "STALE_VERSION");
      expect(
        (
          await f.pool.query(
            "SELECT max(number)::int n FROM versions WHERE workspace_id=$1 AND page_id='child'",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await f.close();
    }
  },
);
