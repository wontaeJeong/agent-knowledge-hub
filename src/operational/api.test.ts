import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  OperationalApi,
  isDemoRequested,
  pageItems,
  snapshotPath,
} from "./api";

describe("operational client boundary", () => {
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
