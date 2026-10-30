import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { fixture, source, adoptFixture } from "../test-support";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";
import * as oidc from "openid-client";
import { sourceInput, drafts } from "./schema";
test("filed answers retain citation snapshots through approval", async () => {
  const fresh = await fixture();
  try {
    const runtime = new RuntimeService(fresh.pool);
    const answer = await runtime.query(fresh.editor, "기존", "offline");
    const b = await runtime.file(fresh.editor, answer.id);
    await fresh.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{title}','\"changed\"') WHERE workspace_id=$1 AND id='topic'",
      [fresh.workspaceId],
    );
    await expect(
      runtime.core.approve(fresh.ctx, b.id, b.hash),
    ).rejects.toThrow();
  } finally {
    await fresh.pool.end();
  }
});
import { randomUUID } from "node:crypto";
const sessionToken = randomUUID();

let f: Awaited<ReturnType<typeof fixture>>;
let server: Server;
let base: string;
let service: RuntimeService;
let provider: Server;
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  service = new RuntimeService(f.pool);
  await f.pool.query(
    `INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','unused')`,
    [sessionHash(sessionToken), f.workspaceId],
  );
  provider = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer unused") {
      res.writeHead(401);
      res.end();
      return;
    }
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
  server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      auth,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (provider) await new Promise<void>((r) => provider.close(() => r()));
  await f?.pool.end();
});
test("real HTTP rejects unauthenticated identities and aggregate/model caller payloads", async () => {
  expect((await fetch(base + "/missing-asset.js")).status).toBe(404);
  expect(
    (
      await fetch(base + "/api/v1/me", {
        headers: { "X-Principal-Id": "editor" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await fetch(base + "/api/model/complete", { method: "POST" })).status,
  ).toBe(404);
});
test("database session revalidates IdP and CSRF; bounded DTOs reject malformed draft scopes", async () => {
  const me = await fetch(base + "/api/v1/me", {
    headers: { Cookie: `akh_session=${sessionToken}` },
  });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({
    principalId: "editor",
    workspaceId: f.workspaceId,
    role: "editor",
    csrfToken: "csrf",
  });
  expect(
    (
      await fetch(base + "/api/v1/lint", {
        method: "POST",
        headers: {
          Cookie: `akh_session=${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(base + "/api/v1/lint", {
        method: "POST",
        headers: {
          Cookie: `akh_session=${sessionToken}`,
          "Content-Type": "application/json",
          Origin: "http://localhost",
          "X-CSRF-Token": "csrf",
        },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(
    sourceInput.safeParse({
      ...source,
      processed: undefined,
      readers: ["editor"],
      scope: "public",
    }).success,
  ).toBe(false);
  expect(
    drafts.safeParse([{ id: "x", title: "x", content: "x", scope: "public" }])
      .success,
  ).toBe(false);
});
test("empty workspace first source compiles a reviewable topic and concept, not direct publish", async () => {
  const empty = await fixture();
  try {
    await empty.pool.query("DELETE FROM batches WHERE workspace_id=$1", [
      empty.workspaceId,
    ]);
    await empty.pool.query("DELETE FROM versions WHERE workspace_id=$1", [
      empty.workspaceId,
    ]);
    await empty.pool.query("DELETE FROM pages WHERE workspace_id=$1", [
      empty.workspaceId,
    ]);
    await empty.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page'",
      [empty.workspaceId],
    );
    await empty.pool.query(
      "DELETE FROM resources WHERE workspace_id=$1 AND kind='page'",
      [empty.workspaceId],
    );
    const runtime = new RuntimeService(empty.pool);
    const b = await runtime.ingest(empty.editor, [source.id], "offline");
    expect((await runtime.changesets(empty.ctx))[0].updates).toHaveLength(2);
    expect(await runtime.pages(empty.ctx)).toEqual([]);
    await runtime.core.approve(empty.ctx, b.id, b.hash);
    await runtime.core.publish(empty.ctx, b.id, b.hash, "first");
    expect(await runtime.pages(empty.editor)).toHaveLength(2);
  } finally {
    await empty.pool.end();
  }
});
test("ACL filtered sources and publication/query/file/lint persist across service restart", async () => {
  const sources = await service.sources(f.editor);
  expect(sources).toHaveLength(1);
  const batch = await service.ingest(f.editor, [source.id], "offline");
  await service.core.approve(f.ctx, batch.id, batch.hash);
  const publication = await service.core.publish(
    f.ctx,
    batch.id,
    batch.hash,
    "publish-once",
  );
  expect(
    await service.core.publish(f.ctx, batch.id, batch.hash, "publish-once"),
  ).toEqual(publication);
  const answer = await service.query(f.editor, "재시도", "offline");
  expect(answer.citations.length).toBeGreaterThan(0);
  const restarted = new RuntimeService(f.pool);
  expect((await restarted.file(f.editor, answer.id)).hash).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect((await restarted.lint(f.editor)).issues.length).toBeGreaterThan(0);
  await f.pool.query(
    `DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'`,
    [f.workspaceId],
  );
  expect(await restarted.sources(f.editor)).toEqual([]);
  expect(await restarted.pages(f.editor)).toEqual([]);
  await expect(restarted.file(f.editor, answer.id)).rejects.toThrow();
});
test("model failure is persisted as failed, not offline success", async () => {
  await expect(service.query(f.reader, "재시도", "model")).rejects.toThrow(
    "MODEL_NOT_CONFIGURED",
  );
  const jobs = await service.jobs(f.reader);
  expect(jobs.at(-1)?.status).toBe("failed");
});
test("MCP uses same authenticated filtered views and never exposes approval tools", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      Cookie: `akh_session=${sessionToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Origin: "http://localhost",
      "X-CSRF-Token": "csrf",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  expect(res.status).toBe(200);
  const rpc = await res.json();
  expect(rpc.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "knowledge_search",
    "knowledge_query",
    "knowledge_ingest",
    "knowledge_lint",
    "knowledge_jobs",
  ]);
});
test("reject fails with stale approval and never publishes rejected content", async () => {
  const fresh = await fixture();
  try {
    const runtime = new RuntimeService(fresh.pool);
    const b = await runtime.ingest(fresh.editor, [source.id], "offline");
    await expect(
      runtime.reject(fresh.ctx, b.id, "0".repeat(64)),
    ).rejects.toThrow("APPROVAL_STALE");
    await runtime.reject(fresh.ctx, b.id, b.hash);
    await expect(
      runtime.core.publish(fresh.ctx, b.id, b.hash, "reject-publication"),
    ).rejects.toThrow();
  } finally {
    await fresh.pool.end();
  }
});
test("revoked linked evidence cannot leak copied title through a still-readable parent", async () => {
  const fresh = await fixture();
  try {
    const runtime = new RuntimeService(fresh.pool);
    const extra = {
      ...source,
      id: "linked-source",
      targetPageId: "linked-page",
      title: "secret-title",
    };
    await runtime.core.registerSource(fresh.editor, extra, [
      "editor",
      "reviewer",
    ]);
    const d = {
      id: "linked-page",
      title: "secret-title",
      summary: "secret",
      content: "secret content",
      scope: "team" as const,
      baseVersion: 0,
      sourceIds: ["linked-source"],
      links: [],
      facts: [],
    };
    const b = await runtime.core.propose(fresh.editor, [d], ["linked-source"]);
    await runtime.core.approve(fresh.ctx, b.id, b.hash);
    await runtime.core.publish(fresh.ctx, b.id, b.hash, "linked");
    await fresh.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{links}','[\"linked-page\"]') WHERE workspace_id=$1 AND id='topic'",
      [fresh.workspaceId],
    );
    await fresh.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND resource_id='linked-source' AND principal_id='editor'",
      [fresh.workspaceId],
    );
    expect(await runtime.pages(fresh.editor)).toEqual([]);
    await expect(runtime.core.readPage(fresh.editor, "topic")).rejects.toThrow(
      "NOT_FOUND",
    );
  } finally {
    await fresh.pool.end();
  }
});
test("delayed model cannot propose after ACL revocation and receives only server-approved context", async () => {
  const fresh = await fixture();
  try {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r));
    const runtime = new RuntimeService(
      fresh.pool,
      async (_operation, context) => {
        const data = context as { sources: { id: string }[] };
        expect(data.sources.map((s) => s.id)).toEqual([source.id]);
        started();
        return new Promise((r) => (finish = r));
      },
    );
    const pending = runtime.ingest(fresh.editor, [source.id], "model");
    await entered;
    await fresh.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [fresh.workspaceId],
    );
    finish({
      updates: [
        {
          id: "new-concept",
          title: "new",
          summary: "new",
          content: "content",
          scope: "team",
          baseVersion: 0,
          sourceIds: [source.id],
          links: [],
          facts: [],
        },
      ],
    });
    await expect(pending).rejects.toThrow("NOT_FOUND");
    expect(await runtime.changesets(fresh.ctx)).toEqual([]);
    expect((await runtime.jobs(fresh.editor)).at(-1)?.status).toBe("failed");
  } finally {
    await fresh.pool.end();
  }
});
test("workspace bounds concurrent work instead of creating unlimited model calls", async () => {
  const fresh = await fixture();
  try {
    const runtime = new RuntimeService(fresh.pool);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const block = new Promise<void>((r) => (release = r));
    const one = runtime.job(fresh.ctx, "query", async () => {
      entered();
      await block;
    });
    await started;
    let secondEntered!: () => void;
    const secondStarted = new Promise<void>((r) => (secondEntered = r));
    const two = runtime.job(fresh.editor, "query", () => {
      secondEntered();
      return block;
    });
    // The workspace row lock serializes acceptance, ensuring the third is bounded.
    await secondStarted;
    try {
      await expect(
        runtime.job(fresh.reader, "query", async () => {}),
      ).rejects.toThrow("JOB_CAPACITY");
    } finally {
      release();
      await Promise.all([one, two]);
    }
  } finally {
    await fresh.pool.end();
  }
});
