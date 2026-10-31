import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  OperationalApi,
  isDemoRequested,
  pageItems,
  snapshotPath,
  documentHref,
  resumeWorkspaceLink,
} from "./api";

describe("operational client boundary", () => {
  it("bounded GET retries absorb transient login fan-out backpressure but never repeat writes", async () => {
    let reads = 0,
      writes = 0;
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/me")) {
        res.end(JSON.stringify({ csrfToken: "session" }));
        return;
      }
      if (req.method === "GET") {
        reads++;
        if (reads > 2) {
          res.end(JSON.stringify({ items: ["ready"] }));
          return;
        }
      } else writes++;
      res
        .writeHead(429, { "Retry-After": "0" })
        .end(JSON.stringify({ code: "RATE_LIMITED" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const api = new OperationalApi(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      );
      await api.me();
      expect(await api.get("/pages")).toEqual({ items: ["ready"] });
      expect(reads).toBe(3);
      await expect(
        api.post("/sources", { content: "원본" }),
      ).rejects.toMatchObject({ status: 429 });
      expect(writes).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("raw attachment requests keep space/CSRF and notify the app when an established session expires", async () => {
    const calls: { space: string; csrf: string; body: string }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/me")) {
        res.end(JSON.stringify({ csrfToken: "raw-csrf" }));
        return;
      }
      calls.push({
        space: String(req.headers["x-space-id"]),
        csrf: String(req.headers["x-csrf-token"]),
        body,
      });
      res.writeHead(401).end(JSON.stringify({ code: "UNAUTHENTICATED" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const api = new OperationalApi(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        "space-two",
      );
      let expirations = 0;
      api.onExpired(() => {
        expirations++;
      });
      await api.me();
      await expect(
        api.transport("/storage/blobs", {
          method: "PUT",
          body: "원본 바이트",
          headers: { "Content-Type": "text/plain" },
        }),
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      expect(calls).toEqual([
        { space: "space-two", csrf: "raw-csrf", body: "원본 바이트" },
      ]);
      expect(expirations).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("document and comment links retain immutable space and page identities", () => {
    expect(documentHref("team-one", "topic", "c1")).toBe(
      "/?app=1&space=team-one&document=topic#comment-c1",
    );
    expect(documentHref("team-one", "topic")).toBe(
      "/?app=1&space=team-one&document=topic",
    );
  });
  it("login return links retain only same-app opaque document identities, never arbitrary redirects", () => {
    expect(
      resumeWorkspaceLink("/?app=1&space=team-one&document=topic#comment-c1"),
    ).toBe("/?app=1&space=team-one&document=topic#comment-c1");
    for (const value of [
      "https://attacker.test/?app=1",
      "//attacker.test/?app=1",
      "javascript:alert(1)",
      "/?demo=1",
      "/admin?app=1",
      "/?app=1&space=team&document=../secrets",
    ])
      expect(resumeWorkspaceLink(value)).toBeNull();
  });
  it("binds selected space to every API call without accepting a client principal", async () => {
    const spaces: string[] = [];
    const server = createServer((req, res) => {
      spaces.push(String(req.headers["x-space-id"] ?? ""));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ csrfToken: "csrf", workspaceId: "space-two" }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const api = new OperationalApi(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        "space-two",
      );
      await api.me();
      await api.get("/pages");
      expect(spaces).toEqual(["space-two", "space-two"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("pins citation navigation to an explicit positive integer version", () => {
    expect(snapshotPath("concept-backup", 3)).toBe(
      "/pages/concept-backup/versions/3",
    );
    expect(() => snapshotPath("concept-backup", 0)).toThrow();
    expect(() => snapshotPath("concept-backup", 1.5)).toThrow();
  });
  it("pages long lists in groups of 25 without losing original rows", () => {
    const rows = Array.from({ length: 63 }, (_, n) => n);
    expect(pageItems(rows, 0)).toHaveLength(25);
    expect([
      ...pageItems(rows, 0),
      ...pageItems(rows, 1),
      ...pageItems(rows, 2),
    ]).toEqual(rows);
    expect(pageItems(rows, 2)).toHaveLength(13);
  });
  it("only explicitly enables demo", () => {
    expect(isDemoRequested("")).toBe(false);
    expect(isDemoRequested("?demo=0")).toBe(false);
    expect(isDemoRequested("?demo=1")).toBe(true);
  });
  it("sends CSRF on writes and preserves real service failures", async () => {
    const calls: { method: string; csrf: string | undefined; body: string }[] =
      [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({
        method: req.method!,
        csrf: req.headers["x-csrf-token"] as string,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/me"))
        res.end(JSON.stringify({ csrfToken: "session-bound" }));
      else {
        res.statusCode = 503;
        res.end(
          JSON.stringify({ code: "MODEL_UNAVAILABLE", requestId: "trace-123" }),
        );
      }
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const addr = server.address() as { port: number };
      const api = new OperationalApi(`http://127.0.0.1:${addr.port}`);
      await api.me();
      await expect(
        api.post("/query", { question: "질문" }),
      ).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        requestId: "trace-123",
        status: 503,
      });
      expect(calls[1]).toMatchObject({ method: "POST", csrf: "session-bound" });
      expect(JSON.parse(calls[1].body)).toEqual({ question: "질문" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
