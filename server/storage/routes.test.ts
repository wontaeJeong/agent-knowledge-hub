import { it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, source, page } from "../test-support";
import { StorageService } from "./service";
import { FileBlobStore, MAX_BYTES, bounded } from "./content";
import { storageRoutes } from "./routes";
let server: ReturnType<typeof createServer>,
  base: string,
  f: Awaited<ReturnType<typeof fixture>>,
  root: string;
beforeAll(async () => {
  f = await fixture();
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-storage-http-")));
  const service = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async (_db, ctx, action) => {
      if (ctx.principalId === "reader" && action === "source.create")
        throw Error("FORBIDDEN");
    },
  );
  const route = storageRoutes(service);
  server = createServer(async (req, res) => {
    try {
      // This fixture host uses a fixed authenticated identity, never a caller-supplied Context DTO.
      const handled = await route({
        method: req.method!,
        path: req.url!,
        body:
          req.method === "POST"
            ? JSON.parse((await bounded(req)).toString())
            : {},
        ctx: f.editor,
        req,
        res,
        send: (status, body) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
      });
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    } catch (e) {
      res.statusCode = (e as Error).message === "PAYLOAD_TOO_LARGE" ? 413 : 400;
      res.end((e as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await f?.pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("raw HTTP stream upload and attachment download persist original bytes safely", async () => {
  const response = await fetch(base + "/api/v1/storage/blobs", {
    method: "PUT",
    headers: {
      "content-type": "text/plain",
      "x-parent-kind": "source",
      "x-parent-id": source.id,
      "x-filename": "fixture.txt",
    },
    body: "실제 업로드",
  });
  expect(response.status).toBe(201);
  const blob = (await response.json()) as { id: string };
  const download = await fetch(base + "/api/v1/storage/blobs/" + blob.id);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(download.headers.get("cache-control")).toBe("no-store");
  expect(await download.text()).toBe("실제 업로드");
});
it("rejects oversized raw HTTP body without broken attachment metadata", async () => {
  const before = await f.pool.query(
    "SELECT count(*) AS n FROM storage_blobs WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const response = await fetch(base + "/api/v1/storage/blobs", {
    method: "PUT",
    headers: {
      "content-type": "text/plain",
      "x-parent-kind": "source",
      "x-parent-id": source.id,
      "x-filename": "large.txt",
    },
    body: Buffer.alloc(MAX_BYTES + 1, 65),
  });
  expect(response.status).toBe(413);
  expect(
    (
      await f.pool.query(
        "SELECT count(*) AS n FROM storage_blobs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual(before.rows);
});
it("registers a selected actual tool artifact through HTTP without granting execution verification", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("./fixtures/opencode-2.2.2-assistant.json", import.meta.url),
      "utf8",
    ),
  );
  const response = await fetch(base + "/api/v1/storage/collect-artifact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifact,
      tool: "opencode",
      version: "2.2.2",
      format: "api.assistant-message",
      sessionId: "ses_redactedFixture",
      selectedIds: [artifact.data.id],
      selectedToolIds: ["call_redacted1"],
      excludedSessionIds: [],
      title: "실제 형식 시험",
      project: "fixture",
    }),
  });
  expect(response.status).toBe(201);
  const registered = (await response.json()) as { id: string; blobId: string };
  const row = (
    await f.pool.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, registered.id],
    )
  ).rows[0].data;
  expect(row.collection.kind).toBe("tool-output");
  expect(row.collection.omitted.reasoning).toBe(1);
  expect(row.collection.omitted.unselectedToolOutputs).toBe(3);
  expect(row.verification).toBe("미검증");
  expect(row.projectVerified).toBe(false);
  expect(row.content).not.toContain("redacted reasoning");
  expect(
    (await fetch(base + "/api/v1/storage/blobs/" + registered.blobId)).status,
  ).toBe(200);
});
it("consumes an archived import through HTTP into an actual non-published core changeset", async () => {
  const json = (path: string, body: unknown) =>
    fetch(base + "/api/v1/storage/" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const exported = await json("export", { pageIds: [page.id] }),
    manifest = await exported.json();
  manifest.pages[0].versions[0].content = "HTTP 가져오기 검토";
  const staged = await json("import", manifest);
  expect(staged.status).toBe(201);
  const archive = await staged.json();
  const submitted = await json(`imports/${archive.id}/propose`, {
    baseVersions: { [page.id]: 1 },
    reason: "HTTP 검토 경로",
  });
  expect(submitted.status).toBe(201);
  const result = await submitted.json();
  const batch = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, result.id],
    )
  ).rows[0].data;
  expect(batch.status).toBe("pending");
  expect(batch.updates[0].content).toBe("HTTP 가져오기 검토");
  expect(
    (await fetch(base + `/api/v1/storage/imports/${archive.id}`)).status,
  ).toBe(200);
  await f.pool.query(
    "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, result.id],
  );
});
it("serves raw replacement headers, immutable version previews and reviewed editor association over real HTTP", async () => {
  const put = (text: string, extra: Record<string, string> = {}) =>
    fetch(base + "/api/v1/storage/blobs", {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "x-parent-kind": "page",
        "x-parent-id": page.id,
        "x-filename": "version.txt",
        ...extra,
      },
      body: text,
    });
  const initial = await (await put("HTTP 버전 1")).json(),
    replacement = await put("HTTP 버전 2", {
      "x-attachment-slot": initial.slotId,
      "x-expected-head": initial.id,
      "x-expected-revision": "1",
    });
  expect(replacement.status).toBe(201);
  const current = await replacement.json();
  expect(
    await (
      await fetch(base + `/api/v1/storage/attachments/${initial.slotId}`)
    ).text(),
  ).toBe("HTTP 버전 2");
  const preview = await fetch(
    base + `/api/v1/storage/attachments/${initial.slotId}/versions/1/preview`,
  );
  expect(preview.status).toBe(200);
  expect((await preview.json()).text).toBe("HTTP 버전 1");
  const association = await fetch(
    base + `/api/v1/storage/attachments/${initial.slotId}/propose-link`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: 1,
        expectedHead: current.id,
        reason: "HTTP 편집 연결",
      }),
    },
  );
  expect(association.status).toBe(201);
  const withdrawal = await fetch(
    base + `/api/v1/storage/attachments/${initial.slotId}/withdraw`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2, reason: "HTTP 철회 확인" }),
    },
  );
  expect(withdrawal.status).toBe(200);
  expect(
    (await fetch(base + `/api/v1/storage/blobs/${initial.id}`)).status,
  ).toBe(400);
});
