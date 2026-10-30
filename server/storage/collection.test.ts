import { it, expect, afterAll, beforeAll } from "vitest";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { UrlCollector, publicAddress, type PinnedFetch } from "./collection";
import { MAX_BYTES } from "./content";
let server: ReturnType<typeof createServer>, port: number;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
      return;
    }
    if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<script>bad()</script>");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      req.url === "/large" ? Buffer.alloc(MAX_BYTES + 1, 65) : "실제 HTTP 응답",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const transport: PinnedFetch = (url, address, signal) =>
  new Promise((resolve, reject) => {
    expect(address).toBe("93.184.216.34");
    const req = get(
      `http://127.0.0.1:${port}${url.pathname}`,
      { signal },
      (res) =>
        resolve({
          status: res.statusCode!,
          headers: res.headers as Record<string, string>,
          body: res,
        }),
    );
    req.on("error", reject);
  });
it("disabled unless explicitly enabled and origin approved", async () => {
  await expect(
    new UrlCollector({
      enabled: false,
      approvedOrigins: ["https://fixture.example"],
    }).collect("https://fixture.example/a"),
  ).rejects.toThrow("EXTERNAL_COLLECTION_DISABLED");
  await expect(
    new UrlCollector({
      enabled: true,
      approvedOrigins: ["https://fixture.example"],
    }).collect("https://other.example/a"),
  ).rejects.toThrow("ORIGIN_NOT_APPROVED");
});
it("denies private/mixed DNS and mapped IPv6 before invoking transport", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::ffff:127.0.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
  ])
    expect(publicAddress(ip)).toBe(false);
  let calls = 0;
  const collector = new UrlCollector(
    { enabled: true, approvedOrigins: ["https://fixture.example"] },
    async () => {
      calls++;
      throw Error("BAD");
    },
    async () => ["93.184.216.34", "10.1.2.3"],
  );
  await expect(collector.collect("https://fixture.example/a")).rejects.toThrow(
    "NETWORK_POLICY_DENIED",
  );
  expect(calls).toBe(0);
});
it("pins DNS resolution, reads bounded actual HTTP fixture and refuses redirects/HTML/overflow", async () => {
  let resolutions = 0;
  const collector = new UrlCollector(
    { enabled: true, approvedOrigins: ["https://fixture.example"] },
    transport,
    async () => {
      resolutions++;
      return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    },
  );
  expect(
    (await collector.collect("https://fixture.example/a")).bytes.toString(),
  ).toBe("실제 HTTP 응답");
  expect(resolutions).toBe(1);
  await expect(collector.collect("https://fixture.example/a")).rejects.toThrow(
    "NETWORK_POLICY_DENIED",
  );
  const safe = new UrlCollector(
    { enabled: true, approvedOrigins: ["https://fixture.example"] },
    transport,
    async () => ["93.184.216.34"],
  );
  await expect(
    safe.collect("https://fixture.example/redirect"),
  ).rejects.toThrow("REDIRECT_DENIED");
  await expect(safe.collect("https://fixture.example/html")).rejects.toThrow(
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expect(safe.collect("https://fixture.example/large")).rejects.toThrow(
    "PAYLOAD_TOO_LARGE",
  );
});
it("bounds resolver and injected network transport timeout", async () => {
  const policy = {
    enabled: true,
    approvedOrigins: ["https://fixture.example"],
    timeoutMs: 10,
  };
  await expect(
    new UrlCollector(policy, transport, () => new Promise(() => {})).collect(
      "https://fixture.example/a",
    ),
  ).rejects.toThrow("STORAGE_TIMEOUT");
  await expect(
    new UrlCollector(
      policy,
      () => new Promise(() => {}),
      async () => ["93.184.216.34"],
    ).collect("https://fixture.example/a"),
  ).rejects.toThrow("STORAGE_TIMEOUT");
});
