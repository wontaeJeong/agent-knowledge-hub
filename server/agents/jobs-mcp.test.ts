import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, adoptFixture } from "../test-support";
import { AccessService, authorizeInTransaction } from "../access";
import { createRuntimeJobs } from "../jobs/runtime";
import { RuntimeService } from "../runtime/knowledge";
import { readJsonBody } from "../runtime/body";
import { AgentService } from "./service";
import { handleAgentMcp } from "./mcp";
test("SDK can inspect and cancel a scoped durable job without gaining approval or publication tools", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool),
    issued = await access.issueCredential(f.editor, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    ctx = await access.authenticateCredential(issued.secret, f.workspaceId),
    runtime = new RuntimeService(f.pool),
    agents = new AgentService(f.pool, runtime, authorizeInTransaction),
    jobs = createRuntimeJobs(f.pool, runtime);
  const queued = await jobs.submitInteractive(
    ctx,
    "query",
    { question: "기존", mode: "offline" },
    "mcp-job-fixture",
  );
  const server = createServer(async (req, res) => {
    try {
      const actual = await access.authenticateCredential(
        String(req.headers.authorization).slice(7),
        f.workspaceId,
      );
      await handleAgentMcp(
        req,
        res,
        req.method === "POST" ? await readJsonBody(req, 1048576) : undefined,
        agents,
        actual,
        jobs,
      );
    } catch {
      if (!res.headersSent) res.writeHead(401).end();
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "durable-agent", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/agent/mcp`,
        ),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${issued.secret}` },
          },
        },
      ),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("wiki_job_status");
    expect(tools).toContain("wiki_cancel_job");
    expect(tools.some((t) => /approve|publish/.test(t))).toBe(false);
    expect(
      (
        await client.callTool({
          name: "wiki_job_status",
          arguments: { job_id: queued.id },
        })
      ).structuredContent,
    ).toMatchObject({ id: queued.id, status: "queued" });
    expect(
      (
        await client.callTool({
          name: "wiki_cancel_job",
          arguments: { job_id: queued.id },
        })
      ).isError,
    ).not.toBe(true);
    expect((await jobs.read(ctx, queued.id)).status).toBe("cancelled");
  } finally {
    await client.close();
    await jobs.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
