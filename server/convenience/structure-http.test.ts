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
  const call = (
    path: string,
    body?: unknown,
    csrf = "csrf",
    cookieName = "c7-http",
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
    const duplicateInput = {
      pageId: "topic",
      version: 1,
      parentId: null,
      mutationId: randomUUID(),
    };
    const issue = async (
      operation: string,
      input: unknown,
      cookieName = "c7-http",
    ) => {
      const response = await call(
        "/convenience/credentials",
        {
          operation,
          input,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
        "csrf",
        cookieName,
      );
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string; secret: string }>;
    };
    const machine = (
      secret: string,
      path: string,
      input?: unknown,
      space = f.workspaceId,
    ) =>
      fetch(base + path, {
        method: input ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          "X-Space-Id": space,
          "Content-Type": "application/json",
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
    const copyGrant = await issue("duplicate", duplicateInput);
    const firstCopy = await machine(
      copyGrant.secret,
      "/convenience/pages/duplicate",
      duplicateInput,
    );
    expect(firstCopy.status).toBe(200);
    const originalCopy = await firstCopy.json();
    expect(
      await (
        await machine(
          copyGrant.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).json(),
    ).toEqual(originalCopy);
    const mcpClient = new Client({ name: "c7-issued", version: "1" });
    await mcpClient.connect(
      new StreamableHTTPClientTransport(
        new URL(base.replace("/api/v1", "") + "/mcp"),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${copyGrant.secret}`,
              "X-Space-Id": f.workspaceId,
            },
          },
        },
      ),
    );
    expect((await mcpClient.listTools()).tools.map(t=>t.name)).toEqual(["knowledge_duplicate"]);
    const mcpCopy = await mcpClient.callTool({
      name: "knowledge_duplicate",
      arguments: duplicateInput,
    });
    expect(mcpCopy.isError).not.toBe(true);
    expect(JSON.parse((mcpCopy.content as any)[0].text)).toEqual(originalCopy);
    await expect(
      mcpClient.callTool({ name: "knowledge_move", arguments: input }),
    ).rejects.toThrow();
    await mcpClient.close();
    expect(
      (
        await machine(copyGrant.secret, "/convenience/pages/duplicate", {
          ...duplicateInput,
          mutationId: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await machine(copyGrant.secret, "/convenience/pages/duplicate", {
          ...duplicateInput,
          pageId: "other",
        })
      ).status,
    ).toBe(403);
    expect(
      (await machine(copyGrant.secret, "/convenience/pages/move", input))
        .status,
    ).toBe(403);
    expect(
      (
        await machine(copyGrant.secret, "/workflows/drafts", {
          id: "illegal",
          title: "no",
          content: "no",
          expectedRevision: 0,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await machine(copyGrant.secret, "/convenience/credentials", {
          operation: "duplicate",
          input: duplicateInput,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await machine(
          copyGrant.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
          "another-space",
        )
      ).status,
    ).not.toBe(200);
    const moveInput = {
      ...input,
      expectedRevision: 1,
      mutationId: randomUUID(),
    };
    const moveGrant = await issue("move", moveInput);
    expect(
      (await machine(moveGrant.secret, "/convenience/pages/move", moveInput))
        .status,
    ).toBe(200);
    expect(
      (await machine(moveGrant.secret, "/convenience/pages/move", moveInput))
        .status,
    ).toBe(200);
    const moveClient=new Client({name:"c7-issued-move",version:"1"});
    await moveClient.connect(new StreamableHTTPClientTransport(new URL(base.replace('/api/v1','')+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${moveGrant.secret}`,"X-Space-Id":f.workspaceId}}}));
    expect((await moveClient.listTools()).tools.map(t=>t.name)).toEqual(["knowledge_move"]);
    const movedViaMcp=await moveClient.callTool({name:"knowledge_move",arguments:moveInput});
    expect(movedViaMcp.isError).not.toBe(true);
    expect(JSON.parse((movedViaMcp.content as any)[0].text)).toMatchObject({id:"topic",revision:2,parentId:null});
    await moveClient.close();
    expect((await machine(copyGrant.secret,"/me")).status).toBe(403);
    const oldResponse = await call("/credentials", {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    expect(oldResponse.status).toBe(201);
    const oldKey = await oldResponse.json();
    expect(
      (
        await machine(
          oldKey.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).toBe(403);
    const revoked = await issue("duplicate", duplicateInput);
    const revokeResponse = await fetch(base + "/credentials/" + revoked.id, {
      method: "DELETE",
      headers: {
        Cookie: "akh_session=c7-http",
        Origin: "http://localhost",
        "X-CSRF-Token": "csrf",
        "Content-Type": "application/json",
      },
    });
    expect(revokeResponse.status).toBe(200);
    expect(
      (
        await machine(
          revoked.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    const expired = await issue("duplicate", duplicateInput);
    await f.pool.query(
      "UPDATE access_credentials SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    expect(
      (
        await machine(
          expired.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    const sessionFor = async (raw: string) =>
      f.pool.query(
        "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",
        [sessionHash(raw), f.workspaceId],
      );
    await sessionFor("c7-capability");
    const capability = await issue(
      "duplicate",
      duplicateInput,
      "c7-capability",
    );
    await f.pool.query(
      "UPDATE access_grants SET role='read' WHERE workspace_id=$1 AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect(
      (
        await machine(
          capability.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    await f.pool.query(
      "UPDATE access_grants SET role='maintain' WHERE workspace_id=$1 AND principal_id='reviewer'",
      [f.workspaceId],
    );
    await sessionFor("c7-ended");
    const ended = await issue("duplicate", duplicateInput, "c7-ended");
    await f.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
      sessionHash("c7-ended"),
    ]);
    expect(
      (
        await machine(
          ended.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    await f.pool.query(
      "UPDATE workflow_document_state SET state='trash' WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId],
    );
    expect(
      (
        await machine(
          copyGrant.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    await f.pool.query(
      "UPDATE workflow_document_state SET state='active' WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,delete_content,approved_by) VALUES($1,'c7-fence','page','topic',true,'reviewer')",
      [f.workspaceId],
    );
    expect(
      (
        await machine(
          copyGrant.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
    await f.pool.query(
      "DELETE FROM operations_tombstones WHERE workspace_id=$1 AND id='c7-fence'",
      [f.workspaceId],
    );
    for (const kind of ["session", "capability"] as const) {
      const raw="c7-queued-"+kind;
      await sessionFor(raw);
      const raceInput={...duplicateInput,mutationId:randomUUID()};
      const grant=await issue("duplicate",raceInput,raw);
      const locked=await f.pool.connect();
      await locked.query("BEGIN");
      await locked.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",[f.workspaceId]);
      const waitingCall=machine(grant.secret,"/convenience/pages/duplicate",raceInput);
      try {
        let waiting=false;
        for(let attempt=0;attempt<100;attempt++){
          waiting=Boolean((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces%' ")).rowCount);
          if(waiting)break;
          await new Promise(r=>setTimeout(r,10));
        }
        expect(waiting).toBe(true);
        if(kind==="session")await locked.query("DELETE FROM runtime_sessions WHERE id=$1",[sessionHash(raw)]);
        else await locked.query("UPDATE access_grants SET role='read' WHERE workspace_id=$1 AND principal_id='reviewer'",[f.workspaceId]);
        await locked.query("COMMIT");
        expect((await waitingCall).status).not.toBe(200);
        expect((await f.pool.query("SELECT 1 FROM workflow_drafts WHERE workspace_id=$1 AND id=$2",[f.workspaceId,"copy-"+raceInput.mutationId])).rowCount).toBe(0);
        expect((await f.pool.query("SELECT 1 FROM workflow_draft_save_mutations WHERE workspace_id=$1 AND mutation_id=$2",[f.workspaceId,raceInput.mutationId])).rowCount).toBe(0);
      } finally {
        await locked.query("ROLLBACK");locked.release();
        if(kind==="capability")await f.pool.query("UPDATE access_grants SET role='maintain' WHERE workspace_id=$1 AND principal_id='reviewer'",[f.workspaceId]);
      }
    }
    // Canonical workspace lock serializes revocation with a queued C7 execution.
    const queued = await issue("duplicate", duplicateInput);
    const lock = await f.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      f.workspaceId,
    ]);
    const pending = machine(
      queued.secret,
      "/convenience/pages/duplicate",
      duplicateInput,
    );
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = Boolean(
        (
          await f.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM workspaces%' ",
          )
        ).rowCount,
      );
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!waiting) {
      await lock.query("ROLLBACK");
      lock.release();
      throw Error("C7 execution never reached canonical workspace lock");
    }
    await lock.query("UPDATE access_credentials SET revoked=true WHERE id=$1", [
      queued.id,
    ]);
    await lock.query("COMMIT");
    lock.release();
    expect((await pending).status).not.toBe(200);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect(
      (
        await machine(
          copyGrant.secret,
          "/convenience/pages/duplicate",
          duplicateInput,
        )
      ).status,
    ).not.toBe(200);
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
