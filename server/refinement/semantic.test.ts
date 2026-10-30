import { it, expect } from "vitest";
import { createServer } from "node:http";
import { createSemanticProvider, validateFindings } from "./semantic";
import { claim } from "./fixtures";
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
