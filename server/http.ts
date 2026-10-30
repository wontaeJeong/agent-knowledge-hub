import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { Context } from "./service";
import { randomUUID } from "node:crypto";
import { usageSummary } from "./usage";

/** Mount behind the host application's real session authenticator. No default identity. */
export function createUsageHandler(options: {
  pool: Pool;
  authenticate: (request: IncomingMessage) => Promise<Context | null>;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        Vary: "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://internal");
      if (url.pathname !== "/api/v1/usage")
        return send(404, { code: "NOT_FOUND", requestId });
      const ctx = await options.authenticate(req);
      if (!ctx) return send(401, { code: "UNAUTHENTICATED", requestId });
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return send(405, { code: "METHOD_NOT_ALLOWED", requestId });
      }
      const period = url.searchParams.get("days") ?? "7";
      if (
        !["7", "14", "30", "90"].includes(period) ||
        url.searchParams.getAll("days").length > 1
      )
        return send(400, { code: "VALIDATION_FAILED", requestId });
      send(200, await usageSummary(options.pool, ctx, Number(period)));
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "NOT_FOUND") return send(404, { code, requestId });
      send(503, { code: "DEPENDENCY_UNAVAILABLE", requestId });
    }
  };
}
