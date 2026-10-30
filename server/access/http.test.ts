import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeHandler } from "../runtime/http";
import { RuntimeService } from "../runtime/knowledge";

let f: Awaited<ReturnType<typeof fixture>>,
  app: Server,
  provider: Server,
  base: string;
const cookies: Record<string, string> = {};
const headers = (who: string, space?: string) => ({
  Cookie: `akh_session=${cookies[who]}`,
  Origin: "http://localhost",
  "X-CSRF-Token": "csrf",
  "Content-Type": "application/json",
  ...(space ? { "X-Space-Id": space } : {}),
});
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  for (const who of ["fixture-owner", "editor", "reviewer", "reader"]) {
    const token = randomUUID();
    cookies[who] = token;
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf',$3,$3,now()+interval '1 hour')",
      [sessionHash(token), f.workspaceId, who],
    );
  }
  provider = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        sub: req.headers.authorization?.slice(7),
        groups: ["eligible"],
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
    config = new oidc.Configuration(
      { issuer, userinfo_endpoint: issuer },
      "client",
      "secret",
    );
  oidc.allowInsecureRequests(config);
  app = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      auth: new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
        eligible: "reviewer",
      }),
    }),
  );
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => app?.close(() => r()));
  await new Promise<void>((r) => provider?.close(() => r()));
  await f?.pool.end();
});

test("HTTP selected personal spaces, authoritative capabilities, no reviewer admin, forged principal and current rights after OIDC revalidation", async () => {
  const reviewer = await fetch(base + "/api/v1/me", {
    headers: headers("reviewer"),
  });
  expect(reviewer.status).toBe(200);
  const dto = await reviewer.json();
  expect(dto.role).toBe("reviewer");
  expect(dto.capabilities).toContain("changeset.approve");
  expect(dto.capabilities).not.toContain("space.admin");
  expect(
    (
      await fetch(base + "/api/v1/grants", {
        method: "POST",
        headers: headers("reviewer"),
        body: JSON.stringify({
          principalId: "reviewer",
          role: "admin",
          expectedVersion: 1,
        }),
      })
    ).status,
  ).toBe(403);
  const personal = await fetch(base + "/api/v1/spaces", {
    method: "POST",
    headers: headers("editor"),
    body: JSON.stringify({ slug: f.workspaceId }),
  });
  expect(personal.status).toBe(201);
  const s = await personal.json();
  expect(
    (await fetch(base + "/api/v1/pages", { headers: headers("reader", s.id) }))
      .status,
  ).toBe(404);
  const me = await fetch(base + "/api/v1/me", {
    headers: headers("editor", s.id),
  });
  expect(me.status).toBe(200);
  expect((await me.json()).space.namespaceKind).toBe("personal");
  expect(
    (
      await fetch(base + "/api/v1/me", {
        headers: { "X-Principal-Id": "fixture-owner" },
      })
    ).status,
  ).toBe(401);
  const version = (
    await (
      await fetch(base + "/api/v1/access", {
        headers: headers("fixture-owner"),
      })
    ).json()
  ).space.policyVersion;
  expect(
    (
      await fetch(base + "/api/v1/grants/editor", {
        method: "DELETE",
        headers: headers("fixture-owner"),
        body: JSON.stringify({ expectedVersion: version }),
      })
    ).status,
  ).toBe(200);
  expect(
    (await fetch(base + "/api/v1/pages", { headers: headers("editor") }))
      .status,
  ).toBe(404);
  // Every request still performs live UserInfo, but directory eligibility never restores product grants.
  expect(
    (await fetch(base + "/api/v1/pages", { headers: headers("editor") }))
      .status,
  ).toBe(404);
});

test("HTTP scoped bearer REST and MCP enforce the same ceiling and revoke instantly", async () => {
  const issued = await fetch(base + "/api/v1/credentials", {
    method: "POST",
    headers: headers("reader"),
    body: JSON.stringify({
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  expect(issued.status).toBe(201);
  const c = await issued.json();
  const h = {
    Authorization: `Bearer ${c.secret}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  expect((await fetch(base + "/api/v1/pages", { headers: h })).status).toBe(
    200,
  );
  expect((await fetch(base + "/api/v1/teams", { headers: h })).status).toBe(
    403,
  );
  expect((await fetch(base + "/api/v1/groups", { headers: h })).status).toBe(
    403,
  );
  const spaces = await (
    await fetch(base + "/api/v1/spaces", { headers: h })
  ).json();
  expect(spaces.items.map((s: { id: string }) => s.id)).toEqual([
    f.workspaceId,
  ]);
  expect(
    (
      await fetch(base + "/api/v1/ingest", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ sourceIds: ["source-a"], mode: "offline" }),
      })
    ).status,
  ).toBe(403);
  const mcp = await fetch(base + "/mcp", {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "knowledge_ingest",
        arguments: { sourceIds: ["source-a"], mode: "offline" },
      },
    }),
  });
  const raw = await mcp.text();
  expect(raw).toContain("FORBIDDEN");
  expect(raw).not.toContain('"hash"');
  expect(
    (
      await fetch(base + `/api/v1/credentials/${c.id}`, {
        method: "DELETE",
        headers: headers("reader"),
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect((await fetch(base + "/api/v1/pages", { headers: h })).status).toBe(
    401,
  );
});
