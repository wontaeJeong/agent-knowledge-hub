import { afterEach, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { fixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeHandler } from "../runtime/http";
import { hash } from "./parser";
import { AccessService } from "../access";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.ACCESS_BOOTSTRAP_OWNERS;
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("managed organization permissions survive real OIDC admission checks without resurrecting a revoked role", async () => {
  const a = await app();
  process.env.ACCESS_BOOTSTRAP_OWNERS = "editor";
  const access = new AccessService(a.pool);
  expect(
    (
      await a.post("/api/v1/access/bootstrap", {
        name: "Platform",
        confirm: "adopt-existing-members-and-preserve-source-acls",
      })
    ).status,
  ).toBe(201);
  const state = await (
    await fetch(a.base + "/api/v1/access", { headers: a.headers })
  ).json();
  expect(state.space.role).toBe("Admin");
  expect(
    (
      await a.post("/api/v1/access/visibility", {
        visibility: "company",
        revision: state.space.revision,
        confirm: "source-acls-remain-restricted",
      })
    ).status,
  ).toBe(400);
  const invitation = await access.invite(a.editor, {
    principalId: "reviewer",
    role: "owner",
  });
  await access.invitation(a.ctx, invitation.id, "accept");
  await access.member(a.ctx, "editor", null);
  expect(
    (await fetch(a.base + "/api/v1/pages", { headers: a.headers })).status,
  ).toBe(401);
  const replacement = randomUUID();
  await a.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','csrf','editor','unused',now()+interval '1 hour')",
    [sessionHash(replacement), a.workspaceId],
  );
  expect(
    (
      await fetch(a.base + "/api/v1/me", {
        headers: { ...a.headers, Cookie: "akh_session=" + replacement },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await a.pool.query("SELECT access_role($1,'editor') AS role", [
        a.workspaceId,
      ])
    ).rows[0].role,
  ).toBeNull();
});
async function app() {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  let groups = ["writers"];
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => provider.close(() => r())));
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "test-client",
    "test-secret",
  );
  oidc.allowInsecureRequests(config);
  const session = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','csrf','editor','unused',now()+interval '1 hour')",
    [sessionHash(session), f.workspaceId],
  );
  const runtime = new RuntimeService(f.pool, async (_operation, raw) => {
    const records = (raw as { records: { id: string; text: string }[] })
      .records;
    return {
      topics: [
        {
          key: "test",
          title: "자동 정리",
          summary: "검토 후보",
          content: "# 검토 후보",
          targetPageId: null,
          relatedPageIds: [],
          statements: records.map((record) => ({
            kind: "proposal",
            text: record.text,
            context: "검증되지 않은 대화 진술",
            recordId: record.id,
            quote: record.text,
          })),
        },
      ],
      excluded: [],
    };
  });
  let handler: ReturnType<typeof createRuntimeHandler>;
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = new OidcAuth(f.pool, config, base, f.workspaceId, {
    writers: "editor",
    readers: "reader",
  });
  handler = createRuntimeHandler({
    pool: f.pool,
    service: runtime,
    auth,
    origin: base,
    workspaceId: f.workspaceId,
  });
  const headers = {
    Cookie: `akh_session=${session}`,
    Origin: base,
    "Content-Type": "application/json",
    "X-CSRF-Token": "csrf",
  };
  const post = (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
  return {
    ...f,
    runtime,
    base,
    post,
    headers,
    setGroups: (value: string[]) => (groups = value),
  };
}
test("real HTTP upload shares the guarded DB pipeline, rejects CSRF/identity spoofing and keeps imports private", async () => {
  const a = await app(),
    bytes = Buffer.from("[2026-10-19 10:00] A: 운영 TTL은 60초입니다 😀");
  const body = {
    title: "대화",
    files: [
      { id: "f", name: "chat.txt", size: bytes.length, sha256: hash(bytes) },
    ],
  };
  expect((await fetch(a.base + "/api/v1/imports")).status).toBe(401);
  expect(
    (
      await fetch(a.base + "/api/v1/imports", {
        method: "POST",
        headers: {
          Cookie: a.headers.Cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await a.post(
        "/api/v1/imports",
        { ...body, principalId: "reviewer" },
        { "Idempotency-Key": "spoof" },
      )
    ).status,
  ).toBe(400);
  const created = await a.post("/api/v1/imports", body, {
    "Idempotency-Key": "create",
  });
  expect(created.status).toBe(201);
  const { id } = await created.json();
  expect(
    (
      await a.post(`/api/v1/imports/${id}/files/f/parts/0`, {
        data: bytes.toString("base64"),
        sha256: hash(bytes),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await a.post(
        `/api/v1/imports/${id}/finalize`,
        {},
        { "Idempotency-Key": "finalize" },
      )
    ).status,
  ).toBe(202);
  await a.runtime.imports.tick();
  const preview = await fetch(a.base + `/api/v1/imports/${id}`, {
    headers: a.headers,
  });
  expect(preview.status).toBe(200);
  const parsed = await preview.json();
  expect(parsed.parsed.records[0].text).toContain("😀");
  expect(await a.runtime.imports.list(a.ctx)).toEqual([]);
  await a.post("/auth/logout", {});
  expect(
    (await fetch(a.base + `/api/v1/imports/${id}`, { headers: a.headers }))
      .status,
  ).toBe(401);
});
test("MCP text/selection/start/status use the same private import, never approval tools", async () => {
  const a = await app();
  let request = 0;
  const tool = async (name: string, args: unknown) => {
    const response = await a.post(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: ++request,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { Accept: "application/json, text/event-stream" },
    );
    expect(response.status).toBe(200);
    const rpc = await response.json();
    if (rpc.result.isError) throw Error(JSON.stringify(rpc));
    return JSON.parse(rpc.result.content[0].text);
  };
  const created = await tool("knowledge_import_text", {
    title: "MCP 입력",
    text: "[2026-10-19 10:00] A: 이것은 제안입니다",
    requestKey: "mcp-text",
  });
  await a.runtime.imports.tick();
  const preview = await tool("knowledge_import_preview", {
    importId: created.importId,
  });
  const selected = await tool("knowledge_import_selection", {
    importId: created.importId,
    revision: preview.revision,
    selection: { acknowledgeWarnings: true },
  });
  const run = await tool("knowledge_import_start", {
    importId: created.importId,
    revision: selected.revision,
    mode: "model",
    requestKey: "mcp-run",
  });
  await a.runtime.imports.tick();
  const result = await tool("knowledge_import_status", { runId: run.id });
  expect(result.status).toBe("review_ready");
  expect(result.result.topics[0].statements[0].kind).toBe("proposal");
  expect(await a.runtime.changesets(a.editor)).toEqual([]);
});
test("logout after server acceptance revokes its execution grant; no model output escapes", async () => {
  const a = await app(),
    bytes = Buffer.from("hello"),
    created = await a.post(
      "/api/v1/imports",
      {
        title: "test",
        files: [{ id: "f", name: "x.txt", size: 5, sha256: hash(bytes) }],
      },
      { "Idempotency-Key": "test" },
    ),
    { id } = await created.json();
  await a.post(`/api/v1/imports/${id}/files/f/parts/0`, {
    data: bytes.toString("base64"),
    sha256: hash(bytes),
  });
  const response = await a.post(
    `/api/v1/imports/${id}/finalize`,
    {},
    { "Idempotency-Key": "final" },
  );
  const run = await response.json();
  await a.post("/auth/logout", {});
  await a.runtime.imports.tick();
  const row = await a.pool.query(
    "SELECT status,result FROM import_runs WHERE workspace_id=$1 AND id=$2",
    [a.workspaceId, run.id],
  );
  expect(row.rows[0]).toEqual({
    status: "authorization_required",
    result: null,
  });
});
