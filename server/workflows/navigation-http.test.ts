import { test, expect } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture, page, source } from "../test-support";
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
  const call = (
    path: string,
    body?: object,
    csrf = "csrf",
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: "akh_session=reviewer",
        Origin: "http://localhost",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        ...extraHeaders,
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
    // The authenticated completion → draft → submit boundary retains target lineage
    // even when a caller omits metadata and later removes the rendered link.
    await f.pool.query(
      "INSERT INTO resources VALUES($1,'page','target'),($1,'source','target-source')",
      [f.workspaceId],
    );
    for (const principal of ["editor", "reviewer"])
      await f.pool.query(
        "INSERT INTO resource_readers VALUES($1,'page','target',$2),($1,'source','target-source',$2)",
        [f.workspaceId, principal],
      );
    await f.pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES($1,'target-source',$2)",
      [f.workspaceId, { ...source, id: "target-source" }],
    );
    await f.pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES($1,'target',$2)",
      [f.workspaceId, { ...page, id: "target", title: "Restricted B" }],
    );
    await f.pool.query("INSERT INTO versions VALUES($1,'target',1,$2)", [
      f.workspaceId,
      { ...page.versions[0], sourceIds: ["target-source"] },
    ]);
    expect(
      await (await call("/links/search", { query: "Restricted B" })).json(),
    ).toMatchObject({ items: [{ id: "target", version: 1 }] });
    const draft = {
      id: "completion-draft",
      expectedRevision: 0,
      title: "Broad A",
      pageId: "topic",
      baseVersion: 1,
      content: `[Restricted B](/?app=1&space=${f.workspaceId}&document=target)`,
    };
    response = await call("/drafts", draft);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      dependencyVersions: { target: 1 },
    });
    response = await call("/drafts", {
      ...draft,
      expectedRevision: 1,
      content: "Copied title",
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      dependencyVersions: { target: 1 },
    });
    response = await call("/drafts/completion-draft/submit", {
      expectedRevision: 2,
      reason: "review completion",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "SOURCE_SCOPE_CONFLICT",
    });
    response = await call("/pages/topic/edit", {
      baseVersion: 1,
      content: draft.content,
      reason: "direct caller",
    });
    expect(response.status).toBe(409);
    for (const [id, content] of [
      ["query-draft", `[B](?app=1&space=${f.workspaceId}&document=target)`],
      [
        "html-draft",
        `<a href="/?app=1&amp;space=${f.workspaceId}&amp;document=target">B</a>`,
      ],
      [
        "absolute-md",
        `[B](http://localhost/?app=1&space=${f.workspaceId}&document=target)`,
      ],
      [
        "network-md",
        `[B](//localhost/?app=1&space=${f.workspaceId}&document=target)`,
      ],
      [
        "absolute-html",
        `<a href="http://localhost/?app=1&space=${f.workspaceId}&document=target">B</a>`,
      ],
      [
        "network-html",
        `<a href="//localhost/?app=1&space=${f.workspaceId}&document=target">B</a>`,
      ],
    ]) {
      response = await call("/drafts", { ...draft, id, content });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        dependencyVersions: { target: 1 },
      });
      expect(
        (
          await call(`/drafts/${id}/submit`, {
            expectedRevision: 1,
            reason: "rendered link",
          })
        ).status,
      ).toBe(409);
    }
    response = await call(
      "/drafts",
      {
        ...draft,
        id: "untrusted-host",
        content: `[B](http://untrusted.example/?app=1&space=${f.workspaceId}&document=target)`,
      },
      "csrf",
      { Host: "untrusted.example" },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("dependencyVersions");
    expect(
      (
        await call("/templates", {
          id: "bound-template",
          expectedRevision: 0,
          title: "Derived",
          content: "Copied title",
          originPageId: "topic",
          sourceDraftId: "completion-draft",
          sourceDraftRevision: 2,
        })
      ).status,
    ).toBe(409);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='target-source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect(
      (await call("/drafts", { ...draft, id: "after-revocation" })).status,
    ).toBe(404);
    expect(
      (
        await call("/drafts/completion-draft/submit", {
          expectedRevision: 2,
          reason: "revoked target",
        })
      ).status,
    ).toBe(404);
    expect(
      await (await call("/links/search", { query: "Restricted B" })).json(),
    ).toMatchObject({ items: [] });
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
