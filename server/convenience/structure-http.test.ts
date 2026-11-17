import { expect, test } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as oidc from "openid-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { handleMcp } from "../runtime/mcp";
import { readJsonBody } from "../runtime/body";
import { AgentService } from "../agents/service";
import { handleAgentMcp } from "../agents/mcp";
import { authorizeInTransaction } from "../access";
import type { Context } from "../service";
test("authenticated native HTTP uses CSRF/current policy and rejects spoofed or repeated queries", async () => {
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
    [sessionHash("c7-http"), f.workspaceId],
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
  const call = (path: string, body?: unknown, csrf = "csrf") =>
    fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: "akh_session=c7-http",
        Origin: "http://localhost",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    expect((await fetch(base + "/convenience/tree")).status).toBe(401);
    const list = await call("/convenience/tree");
    expect(list.status).toBe(200);
    expect((await list.json()).items[0]).toMatchObject({
      id: "topic",
      title: "주제",
    });
    expect((await call("/convenience/tree?limit=2&limit=3")).status).toBe(400);
    expect((await call("/convenience/tree?principalId=editor")).status).toBe(
      400,
    );
    const input = {
      pageId: "topic",
      parentId: null,
      expectedRevision: 0,
      mutationId: randomUUID(),
      reason: "HTTP 이동",
    };
    expect((await call("/convenience/pages/move", input, "wrong")).status).toBe(
      403,
    );
    expect((await call("/convenience/pages/move", input)).status).toBe(200);
    expect((await call("/workflows/pages/topic")).status).toBe(200);
    expect(
      (
        await call("/convenience/pages/duplicate", {
          pageId: "topic",
          version: 1,
          parentId: null,
          mutationId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect((await (await call("/convenience/tree")).json()).items).toEqual([]);
    expect((await call("/convenience/pages/topic/path")).status).toBe(404);
    expect((await call("/convenience/pages/move", input)).status).not.toBe(200);
  } finally {
    server.closeAllConnections();
    provider.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => provider.close(() => r())),
    ]);
    await f.pool.end();
  }
}, 30000);

test("real MCP SDK permits cookie capabilities and denies new tools to existing scoped transports", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool),
    agents = new AgentService(f.pool, runtime, authorizeInTransaction);
  let ctx: Context = f.ctx,
    agentTransport = false;
  const server = createServer(async (req, res) => {
    try {
      const body =
        req.method === "POST" ? await readJsonBody(req, 1048576) : undefined;
      if (agentTransport) await handleAgentMcp(req, res, body, agents, ctx);
      else await handleMcp(req, res, body, runtime, ctx);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "c7-structure", version: "1" });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      return r.isError
        ? { error: JSON.stringify(r) }
        : JSON.parse((r.content as any)[0].text);
    } catch (e) {
      return { error: String(e) };
    }
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp`),
      ),
    );
    expect(
      (await client.listTools()).tools.some((t) => t.name === "knowledge_move"),
    ).toBe(true);
    expect(
      (await invoke("knowledge_path", { pageId: "topic" })).items[0].id,
    ).toBe("topic");
    expect(
      await invoke("knowledge_move", {
        pageId: "topic",
        parentId: null,
        expectedRevision: 0,
        reason: "MCP 이동",
        mutationId: randomUUID(),
      }),
    ).toMatchObject({ id: "topic", revision: 1 });
    ctx = f.reader;
    expect(
      await invoke("knowledge_move", {
        pageId: "topic",
        parentId: null,
        expectedRevision: 1,
        reason: "denied",
        mutationId: randomUUID(),
      }),
    ).toHaveProperty("error");
    for (const scope of ["read", "write"] as const) {
      ctx = { ...f.ctx, agent: { keyId: "test-only", scope } };
      expect(
        (await client.listTools()).tools.some(
          (t) => t.name === "knowledge_tree",
        ),
      ).toBe(false);
      expect(await invoke("knowledge_tree", {})).toHaveProperty("error");
    }
    agentTransport = true;
    ctx = f.ctx;
    expect(
      (await client.listTools()).tools.some((t) => t.name === "knowledge_move"),
    ).toBe(false);
    expect(await invoke("knowledge_move", { pageId: "topic" })).toHaveProperty(
      "error",
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
}, 30000);
