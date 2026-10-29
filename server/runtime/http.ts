import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { RuntimeService } from "./knowledge";
import { OidcAuth } from "./auth";
import {
  sourceInput,
  approvalInput,
  ingestInput,
  queryInput,
  id,
} from "./schema";
import { modelConfig } from "./model";
import { usageSummary } from "../usage";
import { handleMcp } from "./mcp";
import { assertSchemaCurrent } from "../database";

export function createRuntimeHandler(options: {
  pool: Pool;
  service: RuntimeService;
  origin: string;
  workspaceId: string;
  auth?: OidcAuth;
  dist?: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = randomUUID();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Request-Id": requestId,
      });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url || "/", options.origin),
        path = url.pathname;
      if (path === "/healthz" && req.method === "GET")
        return send(200, { ok: true });
      if (path === "/readyz" && req.method === "GET") {
        await assertSchemaCurrent(options.pool);
        return send(200, { ok: true });
      }
      if (path === "/auth/login" && req.method === "GET" && options.auth)
        return await options.auth.login(res);
      if (path === "/auth/callback" && req.method === "GET" && options.auth)
        return await options.auth.callback(req, res);
      if (
        !path.startsWith("/api/") &&
        !path.startsWith("/auth/") &&
        path !== "/mcp"
      ) {
        if (req.method !== "GET" && req.method !== "HEAD")
          return send(405, { code: "METHOD_NOT_ALLOWED" });
        const root = resolve(options.dist || "dist");
        let file = resolve(root, "." + decodeURIComponent(path));
        if (file !== root && !file.startsWith(root + sep))
          return send(404, { code: "NOT_FOUND" });
        if (path === "/" || !extname(file)) file = resolve(root, "index.html");
        const size = (await stat(file)).size;
        if (size > 20000000) return send(404, { code: "NOT_FOUND" });
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
          ".ico": "image/x-icon",
        };
        res.writeHead(200, {
          "Content-Type": mime[extname(file)] || "application/octet-stream",
          "Content-Security-Policy":
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        });
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
        return;
      }
      if (
        !path.startsWith("/api/v1/") &&
        path !== "/auth/logout" &&
        path !== "/mcp"
      )
        return send(404, { code: "NOT_FOUND" });
      await assertSchemaCurrent(options.pool);
      const session = await (options.auth?.authenticate(req) ??
        Promise.resolve(null));
      if (!session) return send(401, { code: "UNAUTHENTICATED", requestId });
      if (session.workspaceId !== options.workspaceId)
        return send(403, { code: "FORBIDDEN" });
      const ctx = {
        workspaceId: session.workspaceId,
        principalId: session.principalId,
        authorization: options.auth!.requestGuard(req, session),
      };
      let body: unknown;
      if (
        req.method === "POST" ||
        req.method === "PATCH" ||
        req.method === "DELETE"
      ) {
        if (
          req.headers.origin !== options.origin ||
          req.headers["x-csrf-token"] !== session.csrfToken
        )
          return send(403, { code: "CSRF_FAILED" });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return send(415, { code: "JSON_REQUIRED" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 512000)
            return send(413, { code: "INPUT_TOO_LARGE" });
        }
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return send(400, { code: "VALIDATION_FAILED" });
        }
      }
      const service = options.service;
      if (path === "/mcp" && req.method === "POST")
        return await handleMcp(req, res, body, service, ctx);
      if (path === "/auth/logout" && req.method === "POST") {
        await options.auth?.logout(req, res);
        return send(200, { ok: true });
      }
      if (req.method === "GET") {
        if (path === "/api/v1/me") return send(200, session);
        if (path === "/api/v1/pages")
          return send(200, { items: await service.pages(ctx) });
        if (path === "/api/v1/sources")
          return send(200, { items: await service.sources(ctx) });
        if (path === "/api/v1/changesets")
          return send(200, { items: await service.changesets(ctx) });
        if (path === "/api/v1/jobs")
          return send(200, { items: await service.jobs(ctx) });
        if (path === "/api/v1/model") return send(200, modelConfig());
        if (path === "/api/v1/usage") {
          const days = url.searchParams.get("days") || "7";
          if (!["7", "30"].includes(days)) throw Error("VALIDATION_FAILED");
          return send(200, await usageSummary(options.pool, ctx, Number(days)));
        }
        if (path === "/api/v1/members")
          return send(200, {
            items: (
              await options.pool.query(
                'SELECT principal_id AS "principalId",role FROM memberships WHERE workspace_id=$1 ORDER BY principal_id',
                [ctx.workspaceId],
              )
            ).rows,
          });
        const page = path.match(
          /^\/api\/v1\/pages\/([^/]+)(?:\/versions\/(\d+))?$/,
        );
        if (page) {
          const p = await service.core.readPage(
            ctx,
            id.parse(page[1]),
            page[2]
              ? z.coerce.number().int().positive().parse(page[2])
              : undefined,
          );
          return send(200, p);
        }
      }
      if (req.method === "POST") {
        if (path === "/api/v1/sources") {
          const wrapped = z
            .object({
              source: z.record(z.string(), z.unknown()),
              readers: z.array(z.string()),
            })
            .strict()
            .parse(body);
          const supplied = { ...wrapped.source };
          delete supplied.createdAt;
          delete supplied.processed;
          const parsed = sourceInput.parse({
            ...supplied,
            readers: wrapped.readers,
          });
          const { readers, ...fields } = parsed;
          const source = {
            ...fields,
            id: fields.id || randomUUID(),
            createdAt: new Date().toISOString(),
            processed: false,
          };
          await service.core.registerSource(ctx, source, readers);
          return send(201, source);
        }
        if (path === "/api/v1/ingest") {
          const b = ingestInput.parse(body);
          return send(201, await service.ingest(ctx, b.sourceIds, b.mode));
        }
        if (path === "/api/v1/query") {
          const b = queryInput.parse(body);
          return send(200, await service.query(ctx, b.question, b.mode));
        }
        if (path === "/api/v1/lint") {
          z.object({}).strict().parse(body);
          return send(200, await service.lint(ctx));
        }
        const file = path.match(/^\/api\/v1\/answers\/([^/]+)\/file$/);
        if (file) {
          z.object({}).strict().parse(body);
          return send(201, await service.file(ctx, id.parse(file[1])));
        }
        const action = path.match(
          /^\/api\/v1\/changesets\/([^/]+)\/(approve|publish|reject)$/,
        );
        if (action) {
          const batchId = id.parse(action[1]);
          const { hash } = approvalInput.parse(body);
          if (action[2] === "publish") {
            const key = z
              .string()
              .min(1)
              .max(200)
              .parse(req.headers["idempotency-key"]);
            return send(
              200,
              await service.core.publish(ctx, batchId, hash, key),
            );
          }
          if (action[2] === "reject")
            return send(200, await service.reject(ctx, batchId, hash));
          await service.core.approve(ctx, batchId, hash);
          return send(200, { id: batchId, hash });
        }
      }
      return send(404, { code: "NOT_FOUND", requestId });
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT")
        return send(404, { code: "NOT_FOUND", requestId });
      const code =
        e instanceof z.ZodError
          ? "VALIDATION_FAILED"
          : e instanceof Error
            ? e.message
            : "";
      const statuses: Record<string, number> = {
        NOT_FOUND: 404,
        ENOENT: 404,
        FORBIDDEN: 403,
        UNAUTHENTICATED: 401,
        VALIDATION_FAILED: 400,
        ALREADY_EXISTS: 409,
        STALE_VERSION: 409,
        APPROVAL_STALE: 409,
        IDEMPOTENCY_CONFLICT: 409,
        SOURCE_SCOPE_CONFLICT: 409,
        MODEL_NOT_CONFIGURED: 503,
        MODEL_FAILED: 502,
        MODEL_OUTPUT_LIMIT: 502,
        MODEL_CONFIGURATION: 503,
        MODEL_CONTEXT_LIMIT: 413,
        JOB_CAPACITY: 429,
      };
      const safe = Object.hasOwn(statuses, code)
        ? code
        : "DEPENDENCY_UNAVAILABLE";
      send(statuses[safe] || 503, { code: safe, requestId });
    }
  };
}
