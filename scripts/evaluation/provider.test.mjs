import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createEvaluationAgent } from "./provider.mjs";
test("real HTTP evaluation transport uses fixed seed/budgets/tools, unknown cost null and clean session", async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const input = JSON.parse(body);
    calls.push(input);
    res.end(
      JSON.stringify({
        usage: { total_tokens: 20 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                answer: "보류",
                abstained: true,
                citations: [],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const agent = createEvaluationAgent({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "fixture",
      apiKey: "server-secret",
      allowTransmission: true,
    });
    const input = {
      model: "fixture",
      seed: 7,
      budget: { calls: 2, maxTokens: 2000, timeoutMs: 1000 },
      tools: ["raw_lookup"],
      context: [],
      task: { prompt: "보류" },
    };
    const result = await agent(input, {
      raw_lookup: async () => ({ id: "s1" }),
    });
    assert.equal(result.usage.cost, null);
    assert.equal(result.usage.tokens, 20);
    assert.equal(calls[0].seed, 7);
    assert.equal(calls[0].tools[0].function.name, "raw_lookup");
    await agent(input, { raw_lookup: async () => ({ id: "s1" }) });
    assert.equal(calls[1].messages.length, 2);
    assert.equal(JSON.stringify(calls).includes("server-secret"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("transmission opt-in required; never falls back to fixture when unconfigured", () => {
  assert.throws(
    () => createEvaluationAgent({ model: "x", allowTransmission: false }),
    /MODEL_NOT_CONFIGURED/,
  );
  assert.throws(
    () =>
      createEvaluationAgent({
        baseUrl: "file:///etc",
        model: "x",
        allowTransmission: true,
      }),
    /MODEL_CONFIGURATION/,
  );
});
test("unknown token usage cannot silently exceed a multi-call token budget", async () => {
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    count++;
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "x",
                  function: { name: "raw_lookup", arguments: '{"id":"s1"}' },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const agent = createEvaluationAgent({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "fixture",
      allowTransmission: true,
    });
    await assert.rejects(
      agent(
        {
          model: "fixture",
          seed: 1,
          budget: { calls: 2, maxTokens: 100, timeoutMs: 1000 },
          task: { prompt: "test" },
          context: [],
        },
        { raw_lookup: async () => ({ id: "s1" }) },
      ),
      /TOKEN_USAGE_UNKNOWN/,
    );
    assert.equal(count, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("records actual LiteLLM response cost without inferring a value", async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("x-litellm-response-cost", "0.125");
    res.end(
      JSON.stringify({
        usage: { total_tokens: 8 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: '{"answer":"yes","abstained":false,"citations":[]}',
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const agent = createEvaluationAgent({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "fixture",
      allowTransmission: true,
    });
    const r = await agent(
      {
        model: "fixture",
        seed: 1,
        budget: { calls: 1, maxTokens: 100, timeoutMs: 1000 },
        task: { prompt: "test" },
        context: [],
      },
      { raw_lookup: async () => ({}) },
    );
    assert.equal(r.usage.cost, 0.125);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
