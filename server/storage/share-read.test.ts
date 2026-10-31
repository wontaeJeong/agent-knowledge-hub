import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fixture, adoptFixture, source, page } from "../test-support";
import {
  AccessService,
  authorizeInTransaction,
  effectiveAccess,
} from "../access/index";
import { transaction } from "../database";
import { StorageService } from "./service";
import { FileBlobStore, bounded } from "./content";
import { storageRoutes } from "./routes";
let root: string,
  f: Awaited<ReturnType<typeof fixture>>,
  s: StorageService,
  access: AccessService,
  owner: { workspaceId: string; principalId: string };
const stream = (text: string) =>
  (async function* () {
    yield Buffer.from(text);
  })();
const policy = async () =>
  (
    await f.pool.query(
      "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0].policy_version as number;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-share-read-")));
});
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  owner = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  await f.pool.query(
    "INSERT INTO memberships VALUES($1,'fixture-owner','reader') ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  for (const kind of ["page", "source"])
    await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
      f.workspaceId,
      kind,
      kind === "page" ? page.id : source.id,
      owner.principalId,
    ]);
  s = new StorageService(
    f.pool,
    new FileBlobStore(root),
    authorizeInTransaction,
  );
  access = new AccessService(f.pool);
});
afterEach(async () => {
  await f?.pool.end();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function sharedFixture(extra = "") {
  const old = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "old.txt",
      mime: "text/plain",
    },
    stream("shared immutable bytes"),
  );
  const raw = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "raw.txt",
      mime: "text/plain",
    },
    stream("shared source file"),
  );
  const hidden = await s.upload(
    f.editor,
    {
      parent: { kind: "source", id: source.id },
      filename: "hidden.txt",
      mime: "text/plain",
    },
    stream("unreferenced private filename"),
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($3::text)) WHERE workspace_id=$1 AND page_id=$2 AND number=1",
    [
      f.workspaceId,
      page.id,
      `[old](/api/v1/storage/blobs/${old.id})\n[raw](/api/v1/storage/blobs/${raw.id})\n\`[not a link](/api/v1/storage/blobs/${hidden.id})\`\n${extra}`,
    ],
  );
  const newer = await s.upload(
    f.editor,
    {
      parent: { kind: "page", id: page.id },
      filename: "future.txt",
      mime: "text/plain",
      slotId: old.slotId,
      expectedHead: old.id,
      expectedRevision: 1,
    },
    stream("future head bytes"),
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,2,$3)", [
    f.workspaceId,
    page.id,
    {
      ...page.versions[0],
      number: 2,
      id: "v2",
      content: `[future](/api/v1/storage/blobs/${newer.id})`,
    },
  ]);
  const share = await access.createShare(owner, {
    pageId: page.id,
    version: 1,
    principalId: f.reader.principalId,
    actions: ["knowledge.read"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    expectedVersion: await policy(),
  });
  const futureTicket = await s.ticket(f.reader, newer.id);
  await access.removeGrant(owner, f.reader.principalId, await policy());
  expect(
    (
      await transaction(f.pool, f.workspaceId, (db) =>
        effectiveAccess(db, f.reader),
      )
    ).role,
  ).toBeNull();
  expect((await access.readShare(f.reader, share.id)).version).toBe(1);
  return { old, raw, hidden, newer, share, futureTicket };
}
it("allows exact shared immutable page/source files without creating general membership authority", async () => {
  const { old, raw } = await sharedFixture();
  const seen: number[] = [];
  const service = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (db, ctx, action, resource) => {
      if (resource?.version) seen.push(resource.version);
      await authorizeInTransaction(db, ctx, action, resource);
    },
  );
  expect((await service.download(f.reader, old.id)).bytes.toString()).toBe(
    "shared immutable bytes",
  );
  expect((await service.download(f.reader, raw.id)).bytes.toString()).toBe(
    "shared source file",
  );
  expect((await service.previewAttachment(f.reader, old.slotId, 1)).text).toBe(
    "shared immutable bytes",
  );
  expect(seen).toContain(1);
  expect(
    (
      await transaction(f.pool, f.workspaceId, (db) =>
        effectiveAccess(db, f.reader),
      )
    ).role,
  ).toBeNull();
  await expect(
    service.list(f.reader, { kind: "page", id: page.id }),
  ).rejects.toThrow();
  await expect(
    service.attachmentHistory(f.reader, old.slotId),
  ).rejects.toThrow();
  await expect(
    service.export(f.reader, { pageIds: [page.id] }),
  ).rejects.toThrow();
  await expect(
    service.download(f.reader, old.id, "local.copy"),
  ).rejects.toThrow();
  await expect(
    transaction(f.pool, f.workspaceId, (db) =>
      authorizeInTransaction(db, f.reader, "knowledge.read", {
        kind: "source",
        id: source.id,
      }),
    ),
  ).rejects.toThrow();
});
it("does not infer future head, guessed file or code-span reference rights from a pinned share", async () => {
  const { old, hidden, newer, futureTicket } = await sharedFixture();
  await expect(s.download(f.reader, newer.id)).rejects.toThrow("NOT_FOUND");
  await expect(s.redeem(f.reader, futureTicket.token)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(s.download(f.reader, hidden.id)).rejects.toThrow("NOT_FOUND");
  await expect(s.downloadAttachment(f.reader, old.slotId)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(s.previewAttachment(f.reader, old.slotId)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(
    (await s.downloadAttachment(f.reader, old.slotId, 1)).bytes.toString(),
  ).toBe("shared immutable bytes");
});
it("rechecks source upper ACL and active share/ticket authority after filesystem I/O", async () => {
  const { old, share } = await sharedFixture();
  const ticket = await s.ticket(f.reader, old.id);
  expect((await s.redeem(f.reader, ticket.token)).bytes.length).toBeGreaterThan(
    0,
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
    new StorageService(f.pool, files, authorizeInTransaction).download(
      f.reader,
      old.id,
    ),
  ).rejects.toThrow("NOT_FOUND");
  await expect(s.redeem(f.reader, ticket.token)).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'reader')",
    [f.workspaceId, source.id],
  );
  await access.revokeShare(owner, share.id, await policy());
  await expect(s.download(f.reader, old.id)).rejects.toThrow("NOT_FOUND");
  await expect(s.redeem(f.reader, ticket.token)).rejects.toThrow("NOT_FOUND");
});
it("rejects cross-page and non-lineage source files even when exactly linked and raw ACLs are known", async () => {
  for (const [kind, key] of [
    ["page", "other-page"],
    ["source", "other-source"],
  ] as const) {
    await f.pool.query("INSERT INTO resources VALUES($1,$2,$3)", [
      f.workspaceId,
      kind,
      key,
    ]);
    for (const who of ["editor", "reader", "fixture-owner"])
      await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
        f.workspaceId,
        kind,
        key,
        who,
      ]);
  }
  const { versions, ...metadata } = page;
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, "other-page", { ...metadata, id: "other-page" }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    "other-page",
    versions[0],
  ]);
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, "other-source", { ...source, id: "other-source" }],
  );
  const wrongPage = await s.upload(
      f.editor,
      {
        parent: { kind: "page", id: "other-page" },
        filename: "other.txt",
        mime: "text/plain",
      },
      stream("not granted page"),
    ),
    wrongSource = await s.upload(
      f.editor,
      {
        parent: { kind: "source", id: "other-source" },
        filename: "lineage.txt",
        mime: "text/plain",
      },
      stream("not in shared lineage"),
    );
  await sharedFixture(
    `[wrong](/api/v1/storage/blobs/${wrongPage.id})\n[lineage](/api/v1/storage/blobs/${wrongSource.id})`,
  );
  await expect(s.download(f.reader, wrongPage.id)).rejects.toThrow("NOT_FOUND");
  await expect(s.download(f.reader, wrongSource.id)).rejects.toThrow(
    "NOT_FOUND",
  );
});
it("keeps member reads, version forwarding, bounded text preview and binary scan protection distinct", async () => {
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,export_allowed,local_copy_allowed) VALUES($1,$2,false,false) ON CONFLICT(workspace_id,source_id) DO UPDATE SET export_allowed=false,local_copy_allowed=false",
    [f.workspaceId, source.id],
  );
  const text = await s.upload(
      f.editor,
      {
        parent: { kind: "page", id: page.id },
        filename: "large.txt",
        mime: "text/plain",
      },
      stream("x".repeat(100005)),
    ),
    pdf = await s.upload(
      f.editor,
      {
        parent: { kind: "page", id: page.id },
        filename: "pending.pdf",
        mime: "application/pdf",
      },
      stream("%PDF-1.7\n%%EOF"),
    );
  expect((await s.download(f.reader, text.id)).bytes.length).toBe(100005);
  await expect(s.download(f.reader, text.id, "local.copy")).rejects.toThrow(
    "FORBIDDEN",
  );
  const { old } = await sharedFixture(
    `[text](/api/v1/storage/blobs/${text.id})\n[pdf](/api/v1/storage/blobs/${pdf.id})`,
  );
  const preview = await s.previewAttachment(f.reader, text.slotId, 1);
  expect(preview.text.length).toBe(100000);
  expect(preview.omittedCharacters).toBe(5);
  expect(preview.complete).toBe(false);
  await expect(s.download(f.reader, pdf.id)).rejects.toThrow("SCAN_REQUIRED");
  await expect(
    s.recordScan(f.reader, pdf.id, pdf.sha256, "clean"),
  ).rejects.toThrow();
  const dropping = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (db, ctx, action, p) =>
      authorizeInTransaction(
        db,
        ctx,
        action,
        p ? { kind: p.kind, id: p.id } : undefined,
      ),
  );
  await expect(dropping.download(f.reader, old.id)).rejects.toThrow(
    "NOT_FOUND",
  );
});
it("checks session validity before returning buffered share bytes", async () => {
  const { old } = await sharedFixture();
  let valid = true;
  const ctx = {
    ...f.reader,
    authorization: {
      revalidate: async () => {
        if (!valid) throw Error("UNAUTHENTICATED");
      },
      assertSession: async () => {
        if (!valid) throw Error("UNAUTHENTICATED");
      },
    },
  };
  const files = new FileBlobStore(root),
    get = files.get.bind(files);
  files.get = async (hash) => {
    const bytes = await get(hash);
    valid = false;
    return bytes;
  };
  await expect(
    new StorageService(f.pool, files, authorizeInTransaction).download(
      ctx,
      old.id,
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
});
it("does not retain a share read after current team membership or human identity is deactivated", async () => {
  const { old } = await sharedFixture();
  await f.pool.query(
    "UPDATE access_team_members SET active=false WHERE principal_id='reader' AND team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
    [f.workspaceId],
  );
  await expect(s.download(f.reader, old.id)).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "UPDATE access_team_members SET active=true WHERE principal_id='reader' AND team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
    [f.workspaceId],
  );
  try {
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id='reader'",
    );
    await expect(s.download(f.reader, old.id)).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.query(
      "UPDATE access_principals SET active=true WHERE id='reader'",
    );
  }
});
it("delivers exact shared files and tickets through real HTTP but denies expired shares, aliases and metadata enumeration", async () => {
  const { old, newer, share } = await sharedFixture();
  const route = storageRoutes(s);
  const server: Server = createServer(async (req, res) => {
    try {
      const body =
        req.method === "POST"
          ? JSON.parse((await bounded(req)).toString())
          : {};
      if (
        !(await route({
          method: req.method!,
          path: req.url!,
          body,
          ctx: f.reader,
          req,
          res,
          send: (status, data) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(data));
          },
        }))
      ) {
        res.statusCode = 404;
        res.end();
      }
    } catch (error) {
      res.statusCode = (error as Error).message === "FORBIDDEN" ? 403 : 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/storage`,
    post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
  try {
    const read = await fetch(base + `/blobs/${old.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.text()).toBe("shared immutable bytes");
    expect((await fetch(base + `/blobs/${newer.id}`)).status).toBe(404);
    expect(
      (await fetch(base + `/attachments/${old.slotId}/versions/1/preview`))
        .status,
    ).toBe(200);
    expect(
      (await fetch(base + `/attachments/${old.slotId}/history`)).status,
    ).toBe(404);
    expect((await post("/list", { kind: "page", id: page.id })).status).toBe(
      404,
    );
    expect((await fetch(base + `/blobs/${old.id}/local-copy`)).status).toBe(
      404,
    );
    const ticketResponse = await post(`/blobs/${old.id}/ticket`, {
      seconds: 60,
    });
    expect(ticketResponse.status).toBe(201);
    const ticket = await ticketResponse.json();
    expect((await post("/tickets/redeem", ticket)).status).toBe(404); // strict DTO rejects expiresIn rather than accepting extra fields
    expect(
      (await post("/tickets/redeem", { token: ticket.token })).status,
    ).toBe(200);
    await f.pool.query(
      "UPDATE access_shares SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [share.id],
    );
    expect((await fetch(base + `/blobs/${old.id}`)).status).toBe(404);
    expect(
      (await post("/tickets/redeem", { token: ticket.token })).status,
    ).toBe(404);
    await expect(s.ticket(f.reader, old.id)).rejects.toThrow("NOT_FOUND");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
