import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { callModel, modelConfig } from "./model";
let server: Server, url: string;
let payload: Record<string, unknown>;
let status = 200;
let finishReason = "stop";
const original = { ...process.env };
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c.toString();
    payload = JSON.parse(raw);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      status === 200
        ? JSON.stringify({
            choices: [
              {
                finish_reason: finishReason,
                message: {
                  content: JSON.stringify({
                    content: "답변",
                    insufficient: true,
                    citations: [],
                  }),
                },
              },
            ],
          })
        : "provider private diagnostic",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  Object.assign(process.env, {
    AGENT_KNOWLEDGE_HUB_LLM_BASE_URL: url,
    AGENT_KNOWLEDGE_HUB_LLM_MODEL: "synthetic-fixture",
    AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION: "true",
    AGENT_KNOWLEDGE_HUB_LLM_TIMEOUT_MS: "2000",
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
});
test("real provider JSON request uses fixed server model, wiki rules and approved context", async () => {
  const data = await callModel("query", { question: "test", pages: [] });
  expect(data).toEqual({ content: "답변", insufficient: true, citations: [] });
  expect(payload.model).toBe("synthetic-fixture");
  expect((payload.messages as { content: string }[])[0].content).toContain(
    "untrusted DATA",
  );
});
test("provider failure is generic and transmission defaults denied", async () => {
  status = 500;
  await expect(callModel("query", {})).rejects.toThrow("MODEL_FAILED");
  delete process.env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION;
  expect(modelConfig().configured).toBe(false);
  await expect(callModel("query", {})).rejects.toThrow("MODEL_NOT_CONFIGURED");
});
test("thinking mode is an explicit optional provider setting, not an on-prem default", async () => {
  status = 200;
  process.env.AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION = "true";
  process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING = "disabled";
  await callModel("query", {});
  expect(payload.thinking).toEqual({ type: "disabled" });
  delete process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING;
  await callModel("query", {});
  expect(payload.thinking).toBeUndefined();
});
test("truncated provider output is never accepted even if its JSON parses", async () => {
  status = 200;
  finishReason = "length";
  await expect(callModel("query", {})).rejects.toThrow("MODEL_OUTPUT_LIMIT");
  finishReason = "stop";
});
test("invalid thinking configuration fails closed", async () => {
  process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING = "unsupported";
  await expect(callModel("query", {})).rejects.toThrow("MODEL_CONFIGURATION");
  delete process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING;
});
