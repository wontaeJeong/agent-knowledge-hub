import { it, expect } from "vitest";
import { createServer } from "node:http";
import { createSemanticProvider, validateFindings } from "./semantic";
import { claim } from "./fixtures";
import type { ModelUsage } from "../runtime/model";
const citations = [
  {
    claimId: "c1",
    evidenceId: "e1",
    sourceId: "s1",
    sourceVersion: "v1",
    quote: "실행 실패",
  },
];
const claims = [
  {
    ...claim,
    evidence: [
      {
        id: "e1",
        sourceId: "s1",
        sourceVersion: "v1",
        location: { quote: "실행 실패", start: 0, end: 5 },
      },
    ],
  },
];
it("semantic proposals require actual supplied source-version citations and bounded claim scope", () => {
  const finding = {
    kind: "contradiction",
    claimIds: ["c1"],
    explanation: "재검증 필요",
    citations,
  };
  expect(validateFindings({ findings: [finding] }, claims)).toHaveLength(1);
  expect(() =>
    validateFindings(
      {
        findings: [
          {
            ...finding,
            citations: [{ ...citations[0], sourceVersion: "forged" }],
          },
        ],
      },
      claims,
    ),
  ).toThrow("MODEL_CITATION_INVALID");
  expect(() =>
    validateFindings(
      { findings: [{ ...finding, claimIds: ["hidden"] }] },
      claims,
    ),
  ).toThrow("MODEL_SCOPE_INVALID");
  expect(() =>
    validateFindings({ findings: [{ ...finding, publish: true }] }, claims),
  ).toThrow();
});
it("OpenAI-compatible host-injected endpoint really calls HTTP, includes rules, never leaks key", async () => {
  let request: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    request = JSON.parse(text);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: '{"findings":[]}' } },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  try {
    const provider = createSemanticProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture-only",
      apiKey: "secret-fixture",
      allowTransmission: true,
    })!;
    expect(await provider({ claims })).toEqual({ findings: [] });
    expect(JSON.stringify(request)).toContain("agent-knowledge-hub/2");
    expect(JSON.stringify(request)).not.toContain("secret-fixture");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("provider is explicitly unconfigured without transmission permission and blocks secrets before HTTP", async () => {
  expect(
    createSemanticProvider({
      baseUrl: "http://127.0.0.1/v1",
      model: "x",
      allowTransmission: false,
    }),
  ).toBeUndefined();
  const provider = createSemanticProvider({
    baseUrl: "http://127.0.0.1:1/v1",
    model: "x",
    allowTransmission: true,
  })!;
  await expect(
    provider({ claims: [{ ...claim, value: "-----BEGIN PRIVATE KEY-----" }] }),
  ).rejects.toThrow("SENSITIVE_CONTENT");
  await expect(
    provider({
      claims: [{ ...claim, value: '{"api_key":"abcdefghijklmnop"}' }],
    }),
  ).rejects.toThrow("SENSITIVE_CONTENT");
  await expect(provider({ claims: [] })).rejects.toThrow("MODEL_FAILED");
});
it("actual semantic HTTP transport reserves before call and records actual usage/model with unknown cost", async () => {
  const order: string[] = [],
    usage: ModelUsage[] = [];
  let body: any;
  const server = createServer(async (req, res) => {
    order.push("http");
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.end(
      JSON.stringify({
        model: "returned-model",
        usage: { prompt_tokens: 17, completion_tokens: 4 },
        choices: [
          { finish_reason: "stop", message: { content: '{"findings":[]}' } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  try {
    const provider = createSemanticProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      provider: "fixture-http",
      model: "requested-model",
      allowTransmission: true,
    })!;
    expect(
      await provider(
        { claims },
        {
          maxContextBytes: 10000,
          maxResponseBytes: 10000,
          maxOutputTokens: 13,
          timeoutMs: 1000,
          rules: "fixture-rules",
          beforeCall: async (p, m) => {
            expect([p, m]).toEqual(["fixture-http", "requested-model"]);
            order.push("reserve");
          },
          onUsage: async (u) => {
            usage.push(u);
            order.push("usage");
          },
        },
      ),
    ).toEqual({ findings: [] });
    expect(order).toEqual(["reserve", "http", "usage"]);
    expect(body.max_tokens).toBe(13);
    expect(body.messages[0].content).toContain("fixture-rules");
    expect(usage).toEqual([
      {
        provider: "fixture-http",
        model: "returned-model",
        inputTokens: 17,
        outputTokens: 4,
        costMicros: null,
        error: null,
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("cancellation and response caps fail the real call and report unknown usage/error without fabricated zero", async () => {
  let mode = "cancel",
    called = 0;
  const controller = new AbortController(),
    usage: ModelUsage[] = [];
  const server = createServer(async (req, res) => {
    called++;
    for await (const _ of req) {
    }
    if (mode === "cancel") {
      controller.abort();
      return;
    }
    res.end("x".repeat(1000));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  try {
    const provider = createSemanticProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "fixture",
      allowTransmission: true,
    })!;
    await expect(
      provider(
        { claims },
        {
          signal: controller.signal,
          onUsage: async (u) => {
            usage.push(u);
          },
        },
      ),
    ).rejects.toThrow("CANCELLED");
    expect(usage[0]).toMatchObject({
      model: null,
      inputTokens: null,
      outputTokens: null,
      costMicros: null,
      error: "CANCELLED",
    });
    mode = "oversized";
    await expect(
      provider(
        { claims },
        {
          maxResponseBytes: 100,
          onUsage: async (u) => {
            usage.push(u);
          },
        },
      ),
    ).rejects.toThrow("MODEL_RESPONSE_LIMIT");
    expect(usage[1].error).toBe("MODEL_RESPONSE_LIMIT");
    const before = called;
    await expect(
      provider(
        { claims },
        {
          beforeCall: async () => {
            throw Error("BUDGET_EXCEEDED");
          },
        },
      ),
    ).rejects.toThrow("BUDGET_EXCEEDED");
    expect(called).toBe(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
