import { test, expect } from "vitest";
import { mkdtemp, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Pool } from "pg";
import { operationsProbeHandler } from "./observability";
import { PhysicalDeletionStore } from "./filesystem";
import {
  healthSnapshot,
  metricsText,
  requireMetricsToken,
  webhookAdapter,
  capacitySnapshot,
  ShutdownController,
  emailGatewayAdapter,
} from "./monitoring";
test("metrics require dedicated long constant-time token and never include content labels", async () => {
  expect(() => requireMetricsToken(undefined, undefined)).toThrow("FORBIDDEN");
  expect(() => requireMetricsToken("Bearer short", "short")).toThrow();
  const token = "metrics".repeat(8);
  requireMetricsToken(`Bearer ${token}`, token);
  expect(() => requireMetricsToken(`Bearer ${token}x`, token)).toThrow();
  const h = await healthSnapshot({
    database: async () => {
      throw Error("down");
    },
    model: async () => false,
    queue: async () => 4,
    backup: async () => new Date(Date.now() - 10000),
    draining: true,
  });
  expect(h.live).toBe(true);
  expect(h.ready).toBe(false);
  expect(h.backupAgeSeconds).toBeGreaterThanOrEqual(10);
  expect(metricsText(h)).toContain("akh_database_available_known 0");
});
test("approved filesystem deletion uses only digest filenames and is idempotent on retry", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "akh-purge-")),
    hash = "a".repeat(64);
  await writeFile(join(root, hash), "synthetic deletion fixture");
  const store = new PhysicalDeletionStore(root);
  await expect(store.remove("../escape")).rejects.toThrow("INVALID_HASH");
  await store.remove(hash);
  await expect(readFile(join(root, hash))).rejects.toThrow();
  await store.remove(hash);
});
test("alert adapter rejects unapproved targets, credentials, HTTP and validates allowed TLS webhook", () => {
  for (const url of [
    "http://alerts.example/a",
    "https://evil.example/a",
    "https://user:pass@alerts.example/a",
  ])
    expect(() =>
      webhookAdapter({
        url,
        allowedOrigins: ["https://alerts.example"],
        token: "secret",
      }),
    ).toThrow("NOT_APPROVED");
  expect(
    typeof webhookAdapter({
      url: "https://alerts.example/a",
      allowedOrigins: ["https://alerts.example"],
      token: "secret",
    }),
  ).toBe("function");
});
test("email adapter requires configured recipients and approved HTTPS gateway, never request-supplied addresses", () => {
  expect(() =>
    emailGatewayAdapter({
      url: "https://mail.example/send",
      allowedOrigins: [],
      token: "secret",
      recipients: ["ops@example.com"],
    }),
  ).toThrow("NOT_APPROVED");
  expect(() =>
    emailGatewayAdapter({
      url: "https://mail.example/send",
      allowedOrigins: ["https://mail.example"],
      token: "secret",
      recipients: ["bad\nInjected: header"],
    }),
  ).toThrow("RECIPIENT");
  expect(
    typeof emailGatewayAdapter({
      url: "https://mail.example/send",
      allowedOrigins: ["https://mail.example"],
      token: "secret",
      recipients: ["ops@example.com"],
    }),
  ).toBe("function");
});
test("capacity uses real filesystem availability and bound checks instead of fabricated free bytes", async () => {
  const c = await capacitySnapshot(process.cwd(), 1);
  expect(c.availableBytes).toBeGreaterThan(0);
  expect(c.acceptingWrites).toBe(true);
  expect((await capacitySnapshot("/nonexistent/akh", 1)).availableBytes).toBe(
    null,
  );
});
test("hung dependency times out as unknown without liveness failure", async () => {
  const h = await healthSnapshot({
    database: async () => true,
    model: () => new Promise(() => {}),
    queue: async () => 0,
    backup: async () => null,
    draining: false,
    timeoutMs: 5,
  });
  expect(h.live).toBe(true);
  expect(h.ready).toBe(true);
  expect(h.model).toBe(null);
});
test("actual HTTP probes survive unavailable DB; metrics fail closed without dedicated token", async () => {
  const pool = new Pool({
      host: "127.0.0.1",
      port: 1,
      connectionTimeoutMillis: 50,
    }),
    token = "dedicated-metrics".repeat(4),
    shutdown = new ShutdownController();
  const handle = operationsProbeHandler({
    pool,
    shutdown,
    modelProbe: async () => false,
    contentDirectory: process.cwd(),
    minimumAvailableBytes: 1,
    metricsToken: token,
  });
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("ADDRESS");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect((await fetch(url + "/healthz")).status).toBe(200);
    expect((await fetch(url + "/readyz")).status).toBe(503);
    expect((await fetch(url + "/metrics")).status).toBe(403);
    const metrics = await fetch(url + "/metrics", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("akh_database_bytes_known 0");
    expect(text).not.toContain("principal_id");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  }
});
