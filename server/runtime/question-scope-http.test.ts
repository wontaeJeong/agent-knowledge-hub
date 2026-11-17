import { expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import * as oidc from "openid-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture, source, page, adoptFixture } from "../test-support";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { RuntimeService } from "./knowledge";
import { callModel } from "./model";
import { RefinementService } from "../refinement/service";
import { authorizeInTransaction, AccessService } from "../access/index";
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";
import { digest } from "../publication";
import { createRuntimeJobs } from "../jobs/runtime";

test("native authenticated scoped queries reach exact provider prompts and both MCP paths while rechecking denied input", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const bodies: any[] = [],
    servers: Server[] = [],
    clients: Client[] = [];
  let beforeProvider: (() => Promise<void>) | undefined,
    afterProvider: (() => Promise<void>) | undefined;
  const listen = async (s: Server) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  };
  const provider = await listen(
    createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      bodies.push(body);
      const input = JSON.parse(body.messages[1].content),
        p = input.pages[0];
      await afterProvider?.();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "synthetic-scope",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  content: "합성 답변",
                  insufficient: !p,
                  citations: p
                    ? [
                        {
                          pageId: p.id,
                          title: p.title,
                          version: p.version,
                          quote: p.content,
                        },
                      ]
                    : [],
                }),
              },
            },
          ],
        }),
      );
    }),
  );
  const issuer = await listen(
    createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sub: "editor", groups: ["writers"] }));
    }),
  );
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", provider + "/v1");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "synthetic-scope");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "scope-local");
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    provider + "/v1/chat/completions",
    ["query"],
    "scope-local",
  );
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "synthetic-secret",
  );
  oidc.allowInsecureRequests(config);
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','csrf','editor','editor',now()+interval '1 hour')",
    [sessionHash("scope-session"), f.workspaceId],
  );
  const runtime = new RuntimeService(f.pool, async (op, input, options) => {
    await beforeProvider?.();
    return callModel(op, input, options);
  });
  const auth = (origin: string) =>
    new OidcAuth(f.pool, config, origin, f.workspaceId, { writers: "editor" });
  const handler = createRuntimeHandler({
    pool: f.pool,
    service: runtime,
    auth: auth("http://localhost"),
    origin: "http://localhost",
    workspaceId: f.workspaceId,
  });
  const base = await listen(createServer(handler));
  const headers = {
    Cookie: "akh_session=scope-session",
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
    "Content-Type": "application/json",
  };
  const post = (
    path: string,
    data: unknown,
    h: Record<string, string> = headers,
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: h,
      body: JSON.stringify(data),
    });
  const refinements = new RefinementService(f.pool, authorizeInTransaction);
  const revoke = () =>
    f.pool
      .query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
        [f.workspaceId],
      )
      .then(() => {});
  const restore = () =>
    f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a','editor') ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
  try {
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','active',$2)",
      [f.workspaceId, { reviewDue: "2026-12-01T00:00:00Z" }],
    );
    await refinements.addEvidence(f.editor, {
      id: "e",
      kind: "claim",
      sourceId: source.id,
      sourceVersion: digest(source),
      location: { start: 0, end: source.content.length, quote: source.content },
      parentIds: [],
      assertedAt: "2026-10-29T00:00:00Z",
      verifiedAt: null,
      conditions: { os: "linux" },
    });
    await refinements.addClaim(f.editor, {
      id: "c",
      pageId: "topic",
      pageVersion: 1,
      key: "retry",
      value: "retry",
      kind: "claim",
      conditions: { os: "linux" },
      exceptions: ["永続エラーは除外"],
      assertedAt: "2026-10-29T00:00:00Z",
      validFrom: "2026-10-29T00:00:00Z",
      validTo: null,
      verifiedAt: null,
      evidenceIds: ["e"],
      protected: false,
      uncertainty: "合成未検証",
      supersedes: [],
    });
    let r = await post("/api/v1/query", {
      question: "기존",
      mode: "model",
      scope: { topic: page.category, environment: { os: "linux" } },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const firstAnswer = await r.json();
    const reread = await fetch(base + "/api/v1/answers/" + firstAnswer.id, {
      headers,
    });
    expect(reread.status).toBe(200);
    expect(await reread.json()).toMatchObject({
      workspaceId: f.workspaceId,
      queryScope: { topic: page.category, historical: false },
      temporalMode: "current-recommendation",
      asOf: expect.any(String),
    });
    const prompt = JSON.parse(bodies[0].messages[1].content);
    expect(prompt.queryScope).toMatchObject({
      topic: page.category,
      historical: false,
    });
    expect(prompt.pages[0].claims.items[0]).toMatchObject({
      exceptions: ["永続エラーは除外"],
      conditions: { os: "linux" },
      validFrom: "2026-10-29T00:00:00Z",
      validation: "unverified",
    });
    expect(bodies[0].messages[0].content).toContain(
      "unknown dates, titles or conditions stay unknown",
    );
    const currentContext = await post("/api/v1/agent/context", {
      task: "기존",
      token_budget: 16000,
    });
    expect(currentContext.status, await currentContext.clone().text()).toBe(
      200,
    );
    expect((await currentContext.json()).items[0]).toMatchObject({
      source_refs: [{ id: source.id, version: 1, location: "content" }],
      conditions: {
        reviewDue: "2026-12-01T00:00:00Z",
        lifecycle: "active",
        project: null,
        environment: null,
      },
      metadata: { reviewDate: "2026-12-01T00:00:00Z", state: "active" },
    });
    await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
      f.workspaceId,
      {
        ...page.versions[0],
        id: "v2",
        number: 2,
        content: "기존 현재",
        at: "2026-11-01T00:00:00Z",
      },
    ]);
    const historical = {
      historical: true,
      periodFrom: "2026-10-29T00:00:00Z",
      periodTo: "2026-10-29T00:00:00.999Z",
    };
    r = await post("/api/v1/query", {
      question: "기존",
      mode: "model",
      scope: historical,
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).citations[0].version).toBe(1);
    const old = JSON.parse(bodies[1].messages[1].content);
    expect(old.temporalMode).toBe(
      "documented-history-not-current-recommendation",
    );
    expect(old.pages[0]).toMatchObject({
      content: "기존 내용",
      title: "topic",
      metadata: null,
      metadataStatus: "unknown",
      currentRecommendation: false,
    });
    expect(old.pages[0].claims.items).toEqual([]);
    for (const path of ["/mcp", "/api/v1/agent/mcp"]) {
      const client = new Client({ name: "scope-client", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + path), {
          requestInit: { headers },
        }),
      );
      const tool = path === "/mcp" ? "knowledge_query" : "wiki_get_context";
      expect(
        (await client.listTools()).tools.find((t) => t.name === tool)
          ?.inputSchema.properties,
      ).toHaveProperty("scope");
      const result = await client.callTool({
        name: tool,
        arguments:
          path === "/mcp"
            ? { question: "기존", mode: "model", scope: historical }
            : { task: "기존", token_budget: 16000, scope: historical },
      });
      const parsed = JSON.parse((result.content as { text: string }[])[0].text);
      expect(
        path === "/mcp" ? parsed.citations[0].version : parsed.items[0].version,
      ).toBe(1);
      if (path !== "/mcp") {
        expect(parsed.items[0].metadata).toBeNull();
        expect(parsed.items[0].conditions).toMatchObject({
          reviewDue: null,
          lifecycle: null,
          project: null,
          environment: null,
          effectiveFrom: null,
          currentRecommendation: false,
        });
      }
    }
    const count = bodies.length;
    r = await post(
      "/api/v1/query",
      { question: "기존", mode: "model", scope: historical },
      { ...headers, "X-CSRF-Token": "wrong" },
    );
    expect(r.status).toBe(403);
    r = await post("/api/v1/query", {
      question: "기존",
      mode: "model",
      scope: { ...historical, pageIds: ["topic"] },
    });
    expect(r.status).toBe(400);
    expect(bodies).toHaveLength(count);
    beforeProvider = revoke;
    r = await post("/api/v1/query", { question: "기존", mode: "model" });
    expect(r.status).not.toBe(200);
    expect(bodies).toHaveLength(count);
    beforeProvider = undefined;
    await restore();
    const answersBefore = (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n;
    afterProvider = revoke;
    r = await post("/api/v1/query", { question: "기존", mode: "model" });
    expect(r.status).not.toBe(200);
    expect(bodies).toHaveLength(count + 1);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(answersBefore);
    afterProvider = undefined;
    await restore();
    // A byte budget remains a hard provider boundary, with no hidden exception truncation.
    const small = new RuntimeService(f.pool, (op, input, options) =>
      callModel(op, input, { ...options, maxContextBytes: 64 }),
    );
    await expect(
      small.query(
        {
          ...f.editor,
          authorization: {
            revalidate: async () => {},
            assertSession: async () => {},
          },
        },
        "기존",
        "model",
      ),
    ).rejects.toThrow("MODEL_CONTEXT_LIMIT");
    expect(bodies).toHaveLength(count + 1);
    if (process.env.AKH_SCOPE_SCREENSHOT_DIR) {
      f.pool.options.max = 20;
      const { readFile, mkdir } = await import("node:fs/promises"),
        { join } = await import("node:path");
      let webHandler = handler;
      const url = await listen(
        createServer(async (req, res) => {
          const p = new URL(req.url!, "http://localhost").pathname;
          if (p.startsWith("/api/") || p === "/mcp")
            return webHandler(req, res);
          try {
            const file = p === "/" ? "index.html" : p.slice(1);
            if (file.includes("..")) throw Error();
            const bytes = await readFile(join(process.cwd(), "dist", file));
            res.setHeader(
              "Content-Type",
              file.endsWith(".js")
                ? "text/javascript"
                : file.endsWith(".css")
                  ? "text/css"
                  : "text/html",
            );
            res.end(bytes);
          } catch {
            res.writeHead(404).end();
          }
        }),
      );
      webHandler = createRuntimeHandler({
        pool: f.pool,
        service: runtime,
        auth: auth(url),
        origin: url,
        workspaceId: f.workspaceId,
      });
      await mkdir(process.env.AKH_SCOPE_SCREENSHOT_DIR!, { recursive: true });
      const pw = await import(process.env.AKH_PLAYWRIGHT_MODULE!);
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const context = await browser.newContext();
        await context.addCookies([
          { name: "akh_session", value: "scope-session", url },
        ]);
        for (const width of [1440, 390]) {
          const p = await context.newPage();
          await p.setViewportSize({ width, height: 1000 });
          p.setDefaultTimeout(5000);
          await p.goto(url + "/?app=1#query");
          await p
            .getByRole("heading", { name: "근거 기반 질문", exact: true })
            .waitFor();
          await p
            .getByLabel("조회 시점", { exact: true })
            .selectOption("historical");
          await p.getByLabel("시작일", { exact: true }).fill("2026-10-29");
          await p.getByLabel("종료일", { exact: true }).fill("2026-10-29");
          await p
            .getByPlaceholder("적용 환경과 버전을 함께 적어주세요.")
            .fill("기존");
          await p
            .getByRole("button", { name: "발행 지식에 질문", exact: true })
            .click();
          await p.getByText(/과거 발행 기록 · 현재 권고 아님/).waitFor();
          await p.waitForLoadState("networkidle");
          expect(await p.evaluate(() => window.innerWidth)).toBe(width);
          expect(
            await p.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(width);
          await p.screenshot({
            path: join(
              process.env.AKH_SCOPE_SCREENSHOT_DIR!,
              `scope-${width}.png`,
            ),
            fullPage: true,
          });
          await p.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    for (const c of clients) await c.close();
    await Promise.all(
      servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    await f.pool.end();
    vi.unstubAllEnvs();
  }
}, 60000);

test("durable scope survives admission, replay and execution without expanding a credential ceiling", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool),
    issued = await access.issueCredential(f.editor, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    ctx = await access.authenticateCredential(issued.secret, f.workspaceId),
    jobs = createRuntimeJobs(f.pool, new RuntimeService(f.pool));
  try {
    await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
      f.workspaceId,
      {
        ...page.versions[0],
        id: "v2",
        number: 2,
        content: "기존 현재",
        at: "2026-11-01T00:00:00Z",
      },
    ]);
    const payload = {
      question: "기존",
      mode: "offline",
      scope: { historical: true, periodTo: "2026-10-29T00:00:00Z" },
    };
    const receipt = await jobs.submitInteractive(
      ctx,
      "query",
      payload,
      "scope-once",
    );
    expect(
      (await jobs.submitInteractive(ctx, "query", payload, "scope-once")).id,
    ).toBe(receipt.id);
    await expect(
      jobs.submitInteractive(
        ctx,
        "query",
        { ...payload, scope: { historical: false } },
        "scope-once",
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(await jobs.worker.tick()).toBe(true);
    const result = await jobs.read(ctx, receipt.id);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result)).toContain('"version":1');
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
      [f.workspaceId],
    );
    await expect(jobs.read(ctx, receipt.id)).rejects.toThrow("NOT_FOUND");
  } finally {
    await jobs.stop();
    await f.pool.end();
  }
});
