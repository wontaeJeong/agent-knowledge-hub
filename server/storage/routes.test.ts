import { it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, source } from "../test-support";
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
