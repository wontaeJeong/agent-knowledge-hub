import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createUsageHandler } from "./http";
import { fixture } from "./test-support";
import { KnowledgeService } from "./service";

let f: Awaited<ReturnType<typeof fixture>>;
let server: ReturnType<typeof createServer>;
let url: string;
beforeEach(async () => {
  f = await fixture();
  server = createServer(
    createUsageHandler({
      pool: f.pool,
      authenticate: async (req) =>
        req.headers.authorization === "Bearer fixture-only" ? f.ctx : null,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f.pool.end();
});

test("serves real persisted usage only after authentication with private no-store caching", async () => {
  await new KnowledgeService(f.pool).readPage(f.reader, "topic");
  const denied = await fetch(`${url}/api/v1/usage?days=7`);
  expect(denied.status).toBe(401);
  const response = await fetch(`${url}/api/v1/usage?days=7`, {
    headers: { Authorization: "Bearer fixture-only" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({
    total: 1,
    activeUsers: 1,
    scope: "workspace",
  });
});

test("rejects bad periods, unsupported methods and unknown routes without leaking internals", async () => {
  const headers = { Authorization: "Bearer fixture-only" };
  expect(
    (await fetch(`${url}/api/v1/usage?days=all`, { headers })).status,
  ).toBe(400);
  expect(
    (await fetch(`${url}/api/v1/usage?days=7`, { headers, method: "POST" }))
      .status,
  ).toBe(405);
  expect((await fetch(`${url}/missing`, { headers })).status).toBe(404);
});
