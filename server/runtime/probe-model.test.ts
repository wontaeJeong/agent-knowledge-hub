import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { modelAvailabilityProbe } from "./probe-model";
test("model availability is measured from the configured endpoint, never invented from env presence", async () => {
  let status = 200,
    calls = 0;
  const server = createServer((req, res) => {
    calls++;
    expect(req.url).toBe("/v1/models");
    expect(req.headers.authorization).toBe("Bearer fixture-only-key");
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = {
        configured: true,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        model: "fixture-model",
        apiKey: "fixture-only-key",
      },
      probe = modelAvailabilityProbe(config);
    expect(await probe()).toBe(true);
    status = 503;
    expect(await probe()).toBe(false);
    status = 404;
    expect(await probe()).toBeNull();
    expect(
      await modelAvailabilityProbe({ ...config, configured: false })(),
    ).toBeNull();
    expect(calls).toBe(3);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
