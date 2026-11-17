import { expect, test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
test("backlink HTTP rejects unauthenticated, spoofed, repeated and oversized requests; current source loss is indistinguishable from absent", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "reviewer", groups: ["reviewers"] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as any).port}`,
    config = new oidc.Configuration(
      { issuer, userinfo_endpoint: issuer + "/userinfo" },
      "client",
      "secret",
    );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    reviewers: "reviewer",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",
    [sessionHash("c8-http"), f.workspaceId],
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  const call = (
    path: string,
    body?: unknown,
    csrf = "csrf",
    cookieName = "c8-http",
  ) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: `akh_session=${cookieName}`,
        Origin: "http://localhost",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const path = "/convenience/pages/topic/backlinks";
    expect((await fetch(base + path)).status).toBe(401);
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pageId: "topic",
      version: 1,
      items: [],
      nextCursor: null,
    });
    for (const query of [
      "?limit=26",
      "?limit=0",
      "?limit=1&limit=2",
      "?principalId=editor",
    ])
      expect((await call(path + query)).status).toBe(400);
    expect((await call(path + "?cursor=invalid")).status).toBe(409);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    const hidden = await call(path),
      absent = await call("/convenience/pages/missing/backlinks");
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: "NOT_FOUND" });
  } finally {
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => provider.close(() => r())),
    ]);
    await f.pool.end();
  }
});
