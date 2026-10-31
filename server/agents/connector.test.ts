import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { membership } from "../repository";
import { readJsonBody } from "../runtime/body";
import { AgentService } from "./service";
import { handleAgentRoute } from "./http";
// @ts-expect-error Existing Node connector intentionally remains portable JavaScript.
import { openClient } from "../../scripts/wiki-connector/client.mjs";

test("existing on-connection local client syncs with PostgreSQL and fails closed on a real service error", async () => {
  const f = await fixture(),
    agents = new AgentService(
      f.pool,
      new RuntimeService(f.pool),
      async (db, ctx) => {
        await membership(db, ctx);
      },
    );
  const directory = await mkdtemp(join(tmpdir(), "akh-connector-"));
  let unavailable = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-editor") {
      res.writeHead(401).end(JSON.stringify({ code: "UNAUTHENTICATED" }));
      return;
    }
    if (unavailable) {
      res.writeHead(503).end(JSON.stringify({ code: "MODEL_UNAVAILABLE" }));
      return;
    }
    try {
      const handled = await handleAgentRoute(
        {
          method: req.method!,
          path: req.url!,
          body: await readJsonBody(req, 1048576),
          ctx: f.editor,
          send: (status, data) => {
            res.writeHead(status).end(JSON.stringify(data));
          },
        },
        agents,
      );
      if (!handled) res.writeHead(404).end("{}");
    } catch (e) {
      res.writeHead(400).end(
        JSON.stringify({
          code: e instanceof Error ? e.message : "REQUEST_FAILED",
        }),
      );
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = await openClient({
    directory,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/connector`,
    token: "fixture-editor",
  });
  try {
    await client.sync();
    const origin = await client.read("topic", f.workspaceId);
    await client.write({ ...origin.page, content: "로컬 개인 수정" });
    await client.sync();
    expect(await client.status()).toMatchObject({
      pending: 0,
      storage: "operational-server",
      mode: "connected-only",
    });
    expect((await client.read("topic")).page).toMatchObject({
      spaceId: "personal",
      version: 1,
      content: "로컬 개인 수정",
    });
    expect(
      await client.propose({
        id: "local-proposal",
        pageId: "topic",
        targetSpaceId: f.workspaceId,
        baseVersion: 1,
        personalVersion: 1,
      }),
    ).toMatchObject({ status: "pending", published: false });
    unavailable = true;
    await expect(client.read("topic")).rejects.toThrow("MODEL_UNAVAILABLE");
    unavailable = false;
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    await client.sync();
    await expect(client.read("topic")).rejects.toThrow("NOT_FOUND");
    expect(
      (await agents.read(f.reader, { page_id: "topic", version: 1 })).content,
    ).toBe("기존 내용");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
