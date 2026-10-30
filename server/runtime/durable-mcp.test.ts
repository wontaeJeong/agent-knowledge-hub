import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, adoptFixture } from "../test-support";
import { AccessService } from "../access";
import { RuntimeService } from "./knowledge";
import { createRuntimeHandler } from "./http";
import { createRuntimeJobs } from "../jobs/runtime";
test("legacy MCP production query also uses durable admission instead of bypassing queue and budgets", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool),
    issued = await access.issueCredential(f.editor, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    runtime = new RuntimeService(f.pool),
    jobs = createRuntimeJobs(f.pool, runtime),
    server = createServer(
      createRuntimeHandler({
        pool: f.pool,
        service: runtime,
        origin: "http://localhost",
        workspaceId: f.workspaceId,
        jobs,
      }),
    ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({
    name: "legacy-durable-client",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
        ),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${issued.secret}` },
          },
        },
      ),
    );
    const first = await client.callTool({
        name: "knowledge_query",
        arguments: {
          question: "기존 내용",
          mode: "offline",
          idempotency_key: "legacy-query-once",
        },
      }),
      receipt = JSON.parse(
        (first.content as { type: string; text: string }[])[0].text,
      );
    expect(receipt).toMatchObject({ status: "queued" });
    const replay = await client.callTool({
      name: "knowledge_query",
      arguments: {
        question: "기존 내용",
        mode: "offline",
        idempotency_key: "legacy-query-once",
      },
    });
    expect(JSON.parse((replay.content as { text: string }[])[0].text).id).toBe(
      receipt.id,
    );
    expect(await jobs.worker.tick()).toBe(true);
    const ctx = await access.authenticateCredential(
      issued.secret,
      f.workspaceId,
    );
    expect((await jobs.read(ctx, receipt.id)).status).toBe("succeeded");
  } finally {
    await client.close();
    await jobs.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await f.pool.end();
  }
});
