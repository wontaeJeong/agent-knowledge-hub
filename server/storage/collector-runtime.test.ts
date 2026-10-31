import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { StorageService } from "./service";
import { FileBlobStore } from "./content";

let f: Awaited<ReturnType<typeof fixture>>,
  provider: Server,
  app: Server,
  base: string,
  root: string;
const token = randomUUID();
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','unused')",
    [sessionHash(token), f.workspaceId],
  );
  provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups: ["writers"] }));
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    writers: "editor",
  });
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-collector-runtime-")));
  const storage = new StorageService(
    f.pool,
    new FileBlobStore(root),
    async () => {},
  );
  app = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      auth,
      storage,
    }),
  );
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (app) await new Promise<void>((resolve) => app.close(() => resolve()));
  if (provider)
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  await f?.pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
it("returns a stable Korean security error for both collector formats through authenticated runtime HTTP", async () => {
  const sql =
    "SELECT (SELECT count(*) FROM sources WHERE workspace_id=$1) AS sources, (SELECT coalesce(sum(size),0) FROM storage_blobs WHERE workspace_id=$1) AS bytes";
  const before = (await f.pool.query(sql, [f.workspaceId])).rows;
  for (const kind of ["synthetic", "assistant"]) {
    const artifact = JSON.parse(
      await readFile(
        new URL(`./fixtures/opencode-2.2.2-${kind}.json`, import.meta.url),
        "utf8",
      ),
    );
    const response = await fetch(base + "/api/v1/storage/collect-artifact", {
      method: "POST",
      headers: {
        Cookie: `akh_session=${token}`,
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf",
      },
      body: JSON.stringify({
        artifact,
        tool: "opencode",
        version: "2.2.2",
        format: `api.${kind}-message`,
        sessionId: "ses_forged",
        selectedIds: [artifact.data.id],
        excludedSessionIds: [],
        title: "fixture",
        project: "fixture",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ARTIFACT_SESSION_UNVERIFIED",
      message: expect.stringContaining("수집"),
    });
  }
  expect((await f.pool.query(sql, [f.workspaceId])).rows).toEqual(before);
});

it("rejects an impersonated tool and stores manual input without collector provenance through runtime HTTP", async () => {
  const sql = "SELECT count(*) AS n FROM sources WHERE workspace_id=$1";
  const before = (await f.pool.query(sql, [f.workspaceId])).rows;
  const body = {
    title: "수동 입력",
    content: "수동으로 제출한 내용",
    tool: "manual",
    project: "fixture",
  };
  const post = (input: unknown) =>
    fetch(base + "/api/v1/storage/sources", {
      method: "POST",
      headers: {
        Cookie: `akh_session=${token}`,
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf",
      },
      body: JSON.stringify(input),
    });
  const rejected = await post({ ...body, tool: "opencode@2.2.2" });
  expect(rejected.status).toBe(400);
  expect((await f.pool.query(sql, [f.workspaceId])).rows).toEqual(before);
  const accepted = await post(body);
  expect(accepted.status).toBe(201);
  const result = await accepted.json();
  const source = (
    await f.pool.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, result.id],
    )
  ).rows[0].data;
  expect(source).toMatchObject({
    tool: "manual",
    scope: "private",
    verification: "미검증",
    projectVerified: false,
    collection: null,
    external: null,
  });
});
