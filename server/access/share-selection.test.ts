import { test, expect } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { AccessService } from "./index";
test("share preview fixes visible descendants and versions; creation is atomic and excludes future children", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const a = new AccessService(f.pool);
    await f.pool.query(
      "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    const version = (await a.effective(f.editor)).space.policyVersion;
    const p = await a.previewShareSelection(f.editor, {
      rootPageId: "topic",
      includeDescendants: true,
      principalId: "reader",
    });
    expect(p.items.map((x) => x.pageId)).toEqual(["topic"]);
    expect(p.items[0].audienceChange).toBe("unchanged");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM access_shares WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    const result = await a.createShareSelection(f.editor, {
      token: p.token,
      pageIds: ["topic"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(result.items).toHaveLength(1);
    expect((await a.effective(f.editor)).space.policyVersion).toBe(version + 1);
    await expect(
      a.createShareSelection(f.editor, {
        token: p.token,
        pageIds: ["topic"],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    ).rejects.toThrow("STALE_VERSION");
  } finally {
    await f.pool.end();
  }
});
test("share selection rejects forged preview, unlisted page and recipient source revocation", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const a = new AccessService(f.pool);
    await f.pool.query(
      "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    const p = await a.previewShareSelection(f.editor, {
      rootPageId: "topic",
      includeDescendants: true,
      principalId: "reader",
    });
    const raw = {
      token: p.token,
      pageIds: ["topic"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    await expect(
      a.createShareSelection(f.editor, { ...raw, token: p.token + "x" }),
    ).rejects.toThrow("INVALID_SHARE_PREVIEW");
    await expect(
      a.createShareSelection(f.editor, { ...raw, pageIds: ["unlisted"] }),
    ).rejects.toThrow("INVALID_SHARE_PREVIEW");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    await expect(a.createShareSelection(f.editor, raw)).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM access_shares WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await f.pool.end();
  }
});

test("descendant preview excludes later children and changes are rechecked before atomic creation", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await f.pool.query(
      "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    const a = new AccessService(f.pool);
    async function child(id: string) {
      await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
        f.workspaceId,
        id,
      ]);
      await f.pool.query(
        "INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,$2,data||jsonb_build_object('id',$2::text) FROM pages WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO versions SELECT workspace_id,$2,number,data FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO resource_readers SELECT workspace_id,kind,$2,principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic'",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id,state,revision,data) VALUES($1,$2,'topic','active',1,'{}')",
        [f.workspaceId, id],
      );
    }
    await child("child");
    const p = await a.previewShareSelection(f.editor, {
      rootPageId: "topic",
      includeDescendants: true,
      principalId: "reader",
    });
    expect(p.items.map((x) => x.pageId)).toEqual(["topic", "child"]);
    await child("future");
    const result = await a.createShareSelection(f.editor, {
      token: p.token,
      pageIds: ["topic", "child"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(result.items.map((x) => x.pageId)).toEqual(["topic", "child"]);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM access_shares WHERE workspace_id=$1 AND page_id='future'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.end();
  }
});
test("native sharing preview and selection keep OIDC, CSRF and current source ceilings", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const oidc = await import("openid-client");
  const { OidcAuth, sessionHash } = await import("../runtime/auth");
  const { createRuntimeHandler } = await import("../runtime/http");
  const { RuntimeService } = await import("../runtime/knowledge");
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  const provider = createServer((req, res) => {
    const sub = req.headers.authorization?.replace("Bearer ", "") ?? "";
    res.setHeader("content-type", "application/json");
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
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','editor')",
    [sessionHash("share-test"), f.workspaceId],
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
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, body: unknown, csrf = "csrf") => {
    const r = await fetch(base + "/api/v1/shares/" + path, {
      method: "POST",
      headers: {
        Cookie: "akh_session=share-test",
        Origin: "http://localhost",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    const raw = {
      rootPageId: "topic",
      includeDescendants: true,
      principalId: "reader",
    };
    expect((await request("preview", raw, "bad")).status).toBe(403);
    const p = await request("preview", raw);
    expect(p.status).toBe(200);
    expect(p.body.items[0].version).toBe(1);
    const created = await request("selection", {
      token: p.body.token,
      pageIds: ["topic"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.items[0].pageId).toBe("topic");
    expect(
      (
        await request("selection", {
          token: p.body.token + "x",
          pageIds: ["topic"],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        })
      ).status,
    ).toBe(409);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => provider.close(() => r()));
    await f.pool.end();
  }
});
test("unshareable hidden descendants do not reveal a count threshold or block root sharing", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await f.pool.query(
      "UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    for (let n = 0; n < 50; n++) {
      const id = "hidden-" + n;
      await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
        f.workspaceId,
        id,
      ]);
      await f.pool.query(
        "INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,$2,data||jsonb_build_object('id',$2::text) FROM pages WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO versions SELECT workspace_id,$2,number,data FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO resource_readers VALUES($1,'page',$2,'editor')",
        [f.workspaceId, id],
      );
      await f.pool.query(
        "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id,state,revision,data) VALUES($1,$2,'topic','active',1,'{}')",
        [f.workspaceId, id],
      );
    }
    const a = new AccessService(f.pool);
    const p = await a.previewShareSelection(f.editor, {
      rootPageId: "topic",
      includeDescendants: true,
      principalId: "reader",
    });
    expect(p.items.map((i) => i.pageId)).toEqual(["topic"]);
    expect(JSON.stringify(p)).not.toContain("hidden-");
  } finally {
    await f.pool.end();
  }
});
