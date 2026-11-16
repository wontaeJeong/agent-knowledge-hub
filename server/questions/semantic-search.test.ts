import { afterEach, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeJobs } from "../jobs/runtime";
import { browserIdentity } from "../jobs/fixtures/session";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { ScopedSearch } from "./search";
import { authorizeInTransaction } from "../access/index";
vi.setConfig({ testTimeout: 30000 });
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const f of fixtures.splice(0)) await f.pool.end();
  vi.unstubAllEnvs();
});
async function setup(reply?: (body: any) => Promise<unknown>) {
  const f = await fixture();
  fixtures.push(f);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, "HTTP_429 발생 시 지수 백오프를 적용한다."],
  );
  let calls = 0;
  const bodies: any[] = [];
  if (reply) {
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      bodies.push(body);
      calls++;
      const result = await reply(body);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "deployed-search-fixture",
          usage: { prompt_tokens: 100, completion_tokens: 15, cost: 0.0002 },
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(result) },
            },
          ],
        }),
      );
    }).listen(0, "127.0.0.1");
    servers.push(provider);
    await once(provider, "listening");
    const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
    vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "search-fixture");
    vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "openai");
    vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
    vi.stubEnv(
      "AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID",
      "semantic-search-fixture",
    );
    await approveLocalTransmissionFixture(
      f.pool,
      f.workspaceId,
      base + "/chat/completions",
      ["query"],
      "semantic-search-fixture",
    );
  } else {
    vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "false");
  }
  const browser = await browserIdentity(f.pool, f.editor, servers),
    runtime = new RuntimeService(f.pool),
    bridge = createRuntimeJobs(f.pool, runtime, {
      workerCount: 1,
      ...browser.options,
    });
  return { ...f, browser, runtime, bridge, bodies, calls: () => calls };
}
const filters = { query: "호출 제한 때 다시 시도" };
const modelReply = {
  matches: [
    {
      pageId: "topic",
      version: 1,
      quote: "지수 백오프",
      reason: "호출 제한 뒤 재시도 조건",
    },
  ],
};
test("configured semantic search transmits the complete authorized corpus beyond lexical hits and records actual budgeted usage", async () => {
  const f = await setup(async () => modelReply);
  const lexical = new ScopedSearch(f.pool, {
    runtime: f.runtime,
    authorize: authorizeInTransaction,
  });
  expect((await lexical.search(f.browser.ctx, filters)).items).toEqual([]);
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "semantic-one",
  );
  expect(
    await f.bridge.submitInteractive(
      f.browser.ctx,
      "query",
      { semanticSearch: filters, mode: "model" },
      "semantic-one",
    ),
  ).toMatchObject({ id: admitted.id });
  await f.bridge.worker.tick();
  const job = await f.bridge.jobs.get(f.browser.ctx, admitted.id);
  expect(job).toMatchObject({
    status: "succeeded",
    result: {
      items: [
        {
          pageId: "topic",
          version: 1,
          content: "HTTP_429 발생 시 지수 백오프를 적용한다.",
        },
      ],
      retrieval: {
        kind: "semantic-model-selection",
        invoked: true,
        provider: "openai",
        model: "deployed-search-fixture",
      },
    },
  });
  expect(f.calls()).toBe(1);
  expect(JSON.parse(f.bodies[0].messages[1].content).pages[0].content).toBe(
    "HTTP_429 발생 시 지수 백오프를 적용한다.",
  );
  expect(
    (await f.bridge.jobs.telemetry(f.browser.ctx, admitted.id)).items,
  ).toMatchObject([
    { input_tokens: "100", output_tokens: "15", cost_micros: "200" },
  ]);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM model_usage_events WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT tokens_charged::int n,tokens_reserved::int r FROM durable_budget_days WHERE workspace_id=$1 AND principal_id=$2",
        [f.workspaceId, f.editor.principalId],
      )
    ).rows[0],
  ).toMatchObject({ n: 115, r: 0 });
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
test("unconfigured semantic search fails closed before any queued or model success", async () => {
  const f = await setup();
  await expect(
    f.bridge.submitInteractive(
      f.browser.ctx,
      "query",
      { semanticSearch: filters, mode: "model" },
      "unconfigured",
    ),
  ).rejects.toThrow("SEMANTIC_SEARCH_NOT_CONFIGURED");
  expect(f.calls()).toBe(0);
});
test("revoked model transmission policy or source access blocks semantic calls and result reads", async () => {
  const f = await setup(async () => modelReply);
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "revoked",
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  await f.bridge.worker.tick();
  expect(f.calls()).toBe(0);
  await expect(f.bridge.jobs.get(f.browser.ctx, admitted.id)).rejects.toThrow();
});
test("a model cannot fabricate pages or source quotes and failure never becomes lexical success", async () => {
  const f = await setup(async () => ({
    matches: [
      {
        pageId: "topic",
        version: 1,
        quote: "invented evidence",
        reason: "claim",
      },
    ],
  }));
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "invalid",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, admitted.id)).toMatchObject({
    status: "dead",
    error: "MODEL_CITATION_INVALID",
  });
  expect(f.calls()).toBe(1);
});

test("authenticated HTTP and MCP admit semantic searches as real durable jobs and retain read-only credential ceilings", async () => {
  const f = await setup(async () => modelReply);
  const { AccessService } = await import("../access/index");
  const { createRuntimeHandler } = await import("../runtime/http");
  const pat = await new AccessService(f.pool).issueCredential(f.editor, {
    actions: ["knowledge.read"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: f.runtime,
      jobs: f.bridge,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Authorization: "Bearer " + pat.secret,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const response = await fetch(base + "/api/v1/search/semantic", {
    method: "POST",
    headers,
    body: JSON.stringify({ filters, idempotency_key: "http-semantic" }),
  });
  expect(response.status).toBe(202);
  const receipt = await response.json();
  await f.bridge.worker.tick();
  expect(
    await (
      await fetch(base + "/api/v1/jobs-v2/" + receipt.id, { headers })
    ).json(),
  ).toMatchObject({
    status: "succeeded",
    result: { items: [{ pageId: "topic" }] },
  });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  for (const [path, name] of [
    ["/api/v1/agent/mcp", "wiki_semantic_search"],
    ["/mcp", "knowledge_semantic_search"],
  ]) {
    const client = new Client({ name: "semantic-fixture", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + path), {
          requestInit: { headers },
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(
        name,
      );
      const result = await client.callTool({
        name,
        arguments: { filters, idempotency_key: name },
      });
      expect(result.isError).not.toBe(true);
      const data =
        result.structuredContent ??
        JSON.parse((result.content as { text: string }[])[0].text);
      expect(data).toMatchObject({ status: "queued" });
      await f.bridge.worker.tick();
    } finally {
      await client.close();
    }
  }
  expect(f.calls()).toBe(3);
  const forbidden = await fetch(base + "/api/v1/agent/changesets", {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  expect(forbidden.status).toBeGreaterThanOrEqual(400);
}, 30000);

test("semantic admission respects the existing hard daily model budget before transmission", async () => {
  const f = await setup(async () => modelReply);
  await f.bridge.jobs.setBudget(f.ctx, {
    principalId: "*",
    tokens: 0,
    costMicros: 0,
  });
  await expect(
    f.bridge.submitInteractive(
      f.browser.ctx,
      "query",
      { semanticSearch: filters, mode: "model" },
      "over-budget",
    ),
  ).rejects.toThrow("BUDGET_EXCEEDED");
  expect(f.calls()).toBe(0);
});
test("changed approved model destination prevents transmission rather than lexical fallback", async () => {
  const f = await setup(async () => modelReply);
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "policy-revoked",
  );
  await f.pool.query(
    "UPDATE model_destinations SET active=false WHERE id='semantic-search-fixture'",
  );
  await f.bridge.worker.tick();
  expect(f.calls()).toBe(0);
  expect(await f.bridge.jobs.get(f.browser.ctx, admitted.id)).toMatchObject({
    status: "dead",
  });
});
test("source revocation during an actual model request prevents exposing its selected snippet", async () => {
  let f: Awaited<ReturnType<typeof setup>>;
  f = await setup(async () => {
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    return modelReply;
  });
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "during-call-revoked",
  );
  await f.bridge.worker.tick();
  expect(f.calls()).toBe(1);
  await expect(f.bridge.jobs.get(f.browser.ctx, admitted.id)).rejects.toThrow();
  expect(
    (
      await f.pool.query("SELECT result,status FROM durable_jobs WHERE id=$1", [
        admitted.id,
      ])
    ).rows[0],
  ).toMatchObject({ result: null, status: "dead" });
});
test("semantic historical input contains the selected old body and unknown old metadata, never current titles", async () => {
  const f = await setup(async () => modelReply);
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1",
    [
      f.workspaceId,
      { title: "CURRENT-ONLY-PRIVATE-TITLE", summary: "CURRENT-ONLY-SUMMARY" },
    ],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    {
      id: "new",
      number: 2,
      content: "Current unrelated content",
      author: "editor",
      reason: "fixture",
      at: "2026-11-01T00:00:00Z",
      sourceIds: ["source-a"],
    },
  ]);
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    {
      semanticSearch: {
        ...filters,
        historical: true,
        periodTo: "2026-10-30T00:00:00Z",
      },
      mode: "model",
    },
    "historical",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, admitted.id)).toMatchObject({
    status: "succeeded",
    result: {
      items: [
        {
          pageId: "topic",
          version: 1,
          title: null,
          historical: true,
          currentRecommendation: false,
        },
      ],
    },
  });
  expect(JSON.stringify(f.bodies)).not.toContain("CURRENT-ONLY");
});

test("oversized semantic input fails explicitly before any provider call instead of silently truncating the corpus", async () => {
  const f = await setup(async () => modelReply);
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb(repeat('x',72000))) WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "oversized",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, admitted.id)).toMatchObject({
    status: "dead",
    error: "MODEL_CONTEXT_LIMIT",
  });
  expect(f.calls()).toBe(0);
  expect(
    (await f.bridge.jobs.telemetry(f.browser.ctx, admitted.id)).items,
  ).toEqual([]);
});

test("malformed semantic provider output is an explicit model validation failure", async () => {
  const f = await setup(async () => ({ matches: "invalid" }));
  const admitted = await f.bridge.submitInteractive(
    f.browser.ctx,
    "query",
    { semanticSearch: filters, mode: "model" },
    "malformed",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, admitted.id)).toMatchObject({
    status: "dead",
    error: "MODEL_INVALID",
  });
  expect(f.calls()).toBe(1);
});

test.each(["query", "lint"] as const)(
  "semantic search rejects a key already bound to ordinary %s with IDEMPOTENCY_CONFLICT and no new job",
  async (kind) => {
    const f = await setup(async () => modelReply);
    const key = "collision-" + kind;
    const original = await f.bridge.submitInteractive(
      f.browser.ctx,
      kind,
      kind === "query"
        ? { question: "ordinary question", mode: "offline" }
        : {},
      key,
    );
    await expect(
      f.bridge.submitInteractive(
        f.browser.ctx,
        "query",
        { semanticSearch: filters, mode: "model" },
        key,
      ),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await f.pool.query(
          "SELECT id FROM durable_jobs WHERE workspace_id=$1 AND principal_id=$2 AND idempotency_key=$3",
          [f.workspaceId, f.editor.principalId, key],
        )
      ).rows,
    ).toEqual([{ id: original.id }]);
    expect(f.calls()).toBe(0);
  },
);
