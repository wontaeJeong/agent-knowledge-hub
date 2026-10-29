import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleModel } from "./model-api.mjs";
let api,
  provider,
  base,
  port,
  result,
  providerStatus = 200,
  lastRequest;
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
before(async () => {
  provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    lastRequest = { body: JSON.parse(body), auth: req.headers.authorization };
    res.writeHead(providerStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: result } }] }));
  });
  port = await listen(provider);
  api = http.createServer(async (req, res) => {
    if (
      !(await handleModel(
        req,
        res,
        new URL(req.url, "http://localhost").pathname,
      ))
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  base = `http://127.0.0.1:${await listen(api)}`;
});
after(() => {
  api.close();
  provider.close();
  delete process.env.FOLIO_LLM_BASE_URL;
  delete process.env.FOLIO_LLM_MODEL;
  delete process.env.FOLIO_LLM_API_KEY;
});
const request = (extra = {}) =>
  fetch(base + "/api/model/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify({
      operation: "query",
      context: { question: "test", pages: [] },
    }),
  });
test("unconfigured model returns a visible error without an offline fallback", async () => {
  delete process.env.FOLIO_LLM_BASE_URL;
  delete process.env.FOLIO_LLM_MODEL;
  assert.equal((await request()).status, 503);
});
test("model proxy sends system policy and data, keeps key server-side", async () => {
  process.env.FOLIO_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.FOLIO_LLM_MODEL = "fake-model";
  process.env.FOLIO_LLM_API_KEY = "test-key-never-a-real-secret";
  result = JSON.stringify({
    content: "no evidence",
    insufficient: true,
    citations: [],
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.content, "no evidence");
  assert.equal(lastRequest.auth, "Bearer test-key-never-a-real-secret");
  assert.match(lastRequest.body.messages[0].content, /folio-wiki\/2/);
  const cfg = await (await fetch(base + "/api/model/config")).json();
  assert.deepEqual(cfg, { configured: true, model: "fake-model" });
});
test("rejects cross-origin browser calls", async () => {
  assert.equal(
    (await request({ Origin: "http://untrusted.invalid" })).status,
    403,
  );
});
test("invalid provider JSON is not applied as a successful answer", async () => {
  result = "not json";
  const res = await request();
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /JSON/);
});
test("upstream failures do not leak response bodies", async () => {
  providerStatus = 401;
  result = "sensitive provider detail";
  const res = await request();
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /sensitive provider/);
});
