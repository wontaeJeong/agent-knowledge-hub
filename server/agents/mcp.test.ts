import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { membership } from "../repository";
import { readJsonBody } from "../runtime/body";
import { AgentService } from "./service";
import { handleAgentMcp } from "./mcp";

test("actual SDK lists versioned agent tools, rejects identity spoofing and rechecks revoked source access", async () => {
  const f = await fixture(),
    agents = new AgentService(
      f.pool,
      new RuntimeService(f.pool),
      async (db, ctx) => {
        await membership(db, ctx);
      },
    );
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer fixture-editor") {
      res.writeHead(401).end();
      return;
    }
    try {
      await handleAgentMcp(
        req,
        res,
        req.method === "POST" ? await readJsonBody(req, 1048576) : undefined,
        agents,
        f.editor,
      );
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({
    name: "agent-contract-fixture",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/agent/mcp`,
        ),
        {
          requestInit: { headers: { Authorization: "Bearer fixture-editor" } },
        },
      ),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([
      "wiki_search",
      "wiki_read",
      "wiki_get_context",
      "wiki_submit_artifact",
      "wiki_propose_change",
      "wiki_report_outcome",
    ]);
    const read = await client.callTool({
      name: "wiki_read",
      arguments: { page_id: "topic", version: 1 },
    });
    expect(read.structuredContent).toMatchObject({
      version: 1,
      content: "기존 내용",
    });
    const forged = await client.callTool({
      name: "wiki_read",
      arguments: { page_id: "topic", principalId: "reviewer" },
    });
    expect(forged.isError).toBe(true);
    expect(JSON.stringify(forged.content)).toContain("VALIDATION_FAILED");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    const revoked = await client.callTool({
      name: "wiki_read",
      arguments: { page_id: "topic", version: 1 },
    });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain("기존 내용");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pool.end();
  }
});
