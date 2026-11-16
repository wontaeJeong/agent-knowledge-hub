import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oidc from "openid-client";
import sharp from "sharp";
import { fixture, adoptFixture, source } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { StorageService } from "./service";
import { FileBlobStore } from "./content";
test("authenticated runtime checks image format, CSRF, current source ACL and revocation for immutable preview", async () => {
  const f = await fixture();
  const root = await realpath(await mkdtemp(join(tmpdir(), "akh-image-http-")));
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups: ["editor"] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  await adoptFixture(f.pool, f.workspaceId);
  const token = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','unused')",
    [sessionHash(token), f.workspaceId],
  );
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    editor: "editor",
  });
  const storage = new StorageService(
    f.pool,
    new FileBlobStore(root),
    authorizeInTransaction,
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      storage,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Cookie: `akh_session=${token}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
    "content-type": "image/png",
    "x-parent-kind": "source",
    "x-parent-id": source.id,
    "x-filename": "image.png",
  };
  try {
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    expect(
      (
        await fetch(base + "/api/v1/storage/blobs", {
          method: "PUT",
          headers: { ...headers, "X-CSRF-Token": "wrong" },
          body: bytes,
        })
      ).status,
    ).toBe(403);
    const invalid = await fetch(base + "/api/v1/storage/blobs", {
      method: "PUT",
      headers,
      body: Buffer.from("not image bytes"),
    });
    expect(await invalid.json()).toMatchObject({ code: "INVALID_IMAGE" });
    expect(invalid.status).toBe(415);
    const animated = await readFile(
      new URL("./fixtures/animated-two-frame.png", import.meta.url),
    );
    const before = (
      await f.pool.query(
        "SELECT count(*)::int n FROM storage_blobs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n;
    const animatedUpload = await fetch(base + "/api/v1/storage/blobs", {
      method: "PUT",
      headers,
      body: animated,
    });
    expect(animatedUpload.status).toBe(415);
    expect(await animatedUpload.json()).toMatchObject({
      code: "INVALID_IMAGE",
    });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM storage_blobs WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(before);
    const upload = await fetch(base + "/api/v1/storage/blobs", {
      method: "PUT",
      headers,
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const image = (await upload.json()) as { id: string };
    expect(
      (await fetch(base + `/api/v1/storage/blobs/${image.id}/preview`)).status,
    ).toBe(401);
    const preview = await fetch(
      base + `/api/v1/storage/blobs/${image.id}/preview`,
      { headers: { Cookie: headers.Cookie } },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toContain("no-store");
    expect(await preview.json()).toMatchObject({
      render: "raster-image",
      width: 4,
      height: 3,
    });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
      [f.workspaceId, source.id],
    );
    expect(
      (
        await fetch(base + `/api/v1/storage/blobs/${image.id}/preview`, {
          headers: { Cookie: headers.Cookie },
        })
      ).status,
    ).toBe(404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => provider.close(() => r()));
    await f.pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
