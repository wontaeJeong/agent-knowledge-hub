import { test, expect } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";

test("authenticated native navigation, completion and personal lists remove revoked source titles", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "reviewer", groups: ["reviewers"] }));
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
    reviewers: "reviewer",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",
    [sessionHash("reviewer"), f.workspaceId],
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/workflows`;
  const call = (path: string, body?: object, csrf = "csrf") =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: "akh_session=reviewer",
        Origin: "http://localhost",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    expect((await fetch(base + "/pages/topic/navigation")).status).toBe(401);
    expect(
      (await call("/links/search", { query: "주제" }, "wrong")).status,
    ).toBe(403);
    let response = await call("/pages/topic/navigation");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pageId: "topic",
      version: 1,
      links: [],
      backlinks: [],
    });
    response = await call("/links/search", { query: "주제" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: "topic", title: "주제", version: 1 }],
    });
    expect(
      (await call("/pages/topic/favorite", { enabled: true })).status,
    ).toBe(200);
    expect((await call("/pages/topic")).status).toBe(200);
    for (const path of ["/favorites", "/recent"])
      expect(await (await call(path)).json()).toMatchObject({
        items: [{ id: "topic", title: "주제" }],
      });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect((await call("/pages/topic/navigation")).status).toBe(404);
    for (const path of ["/favorites", "/recent"])
      expect(await (await call(path)).json()).toEqual({ items: [] });
    expect(
      await (await call("/links/search", { query: "주제" })).json(),
    ).toMatchObject({ items: [] });
  } finally {
    server.closeAllConnections();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await f.pool.end();
  }
});
