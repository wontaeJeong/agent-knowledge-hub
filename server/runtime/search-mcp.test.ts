import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, adoptFixture, page } from "../test-support";
import { RuntimeService } from "./knowledge";
import { readJsonBody } from "./body";
import { handleMcp } from "./mcp";
test("cookie MCP shares strict filters, actual historical versions, signed cursor replay and current source ACL", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool);
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    {
      ...page.versions[0],
      id: "v2",
      number: 2,
      content: "기존 두번째",
      at: "2026-11-01T00:00:00Z",
    },
  ]);
  const server = createServer(async (req, res) => {
    try {
      await handleMcp(
        req,
        res,
        req.method === "POST" ? await readJsonBody(req, 1048576) : undefined,
        runtime,
        f.reader,
      );
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "search-fixture", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
        ),
      ),
    );
    const tools = await client.listTools();
    expect(
      tools.tools.find((t) => t.name === "knowledge_search")?.inputSchema
        .properties,
    ).toHaveProperty("historical");
    const search = async (args: Record<string, unknown>) => {
      const r = await client.callTool({
        name: "knowledge_search",
        arguments: args,
      });
      return JSON.parse((r.content as { text: string }[])[0].text);
    };
    expect((await search({ question: "기존" })).items[0]).toMatchObject({
      id: "topic",
      summary: "시험 주제",
      scope: "team",
      lifecycle: "active",
      reviewOverdue: false,
    });
    const first = await search({
      question: "기존",
      historical: true,
      limit: 1,
    });
    expect(first.items[0]).toMatchObject({
      pageId: "topic",
      version: 2,
      historical: true,
      currentRecommendation: false,
    });
    const second = await search({
      question: "기존",
      historical: true,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]).toMatchObject({
      version: 1,
      content: "기존 내용",
      title: null,
    });
    expect(
      (await search({ question: "기존", project: "unregistered" })).items,
    ).toEqual([]);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    expect(
      (await search({ question: "기존", historical: true })).items,
    ).toEqual([]);
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
