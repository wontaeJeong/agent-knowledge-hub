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
import { assessPage, systemOneConfig } from "./systemone";
import { usageSummary, exportUsageCsv } from "../usage";
import { handleMcp } from "./mcp";
import { readJsonBody } from "./body";
import { assertSchemaCurrent } from "../database";
import { handleImportRequest } from "../imports/http";
import { AccessService } from "../access";
import { handleAccessRequest } from "../access-http";
import { handleBoardRequest } from "../boards";
import { authenticateAgentKey, recordAgentRequest, permittedAgentRoute, handleCredentialRequest, startDevice, pollDevice, verifyDevice, decideDevice } from "../agent-credentials";

export function createRuntimeHandler(options: {
  pool: Pool;
  service: RuntimeService;
  origin: string;
  workspaceId: string;
  auth?: OidcAuth;
  dist?: string;
}) {
  const access = new AccessService(options.pool);
  if (options.auth)
    options.service.imports.authorizer = (row) =>
      options.auth!.backgroundContext(
        row as {
          workspace_id: string;
          principal_id: string;
          session_id: string | null;
          grant_role: string;
          grant_expires_at: Date | string;
        },
      );
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
      if ((path === "/api/v1/device/authorize" || path === "/api/v1/device/token") && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return send(415, { code: "JSON_REQUIRED" });
        const payload = await readJsonBody(req, 8192);
        const result = path.endsWith("authorize")
          ? await startDevice(options.pool, payload, options.origin)
          : await pollDevice(options.pool, payload);
        return send(result.status, result.body);
      }
      const authHeader = req.headers.authorization;
      if (authHeader && !/^Bearer akh_sk_[A-Za-z0-9_-]{43}$/.test(authHeader))
        return send(401, {code:"UNAUTHENTICATED", requestId});
      const agent = authHeader
        ? await authenticateAgentKey(options.pool,authHeader.slice(7))
        : null;
      const session = authHeader ? null : await (options.auth?.authenticate(req) ?? Promise.resolve(null));
      if (!session && !agent) return send(401, { code: "UNAUTHENTICATED", requestId });
      const ctx = agent ?? {
        workspaceId: session!.workspaceId,
        principalId: session!.principalId,
        authorization: options.auth!.requestGuard(req, session!),
      };
      if (ctx.workspaceId !== options.workspaceId &&
        !(await options.pool.query("SELECT 1 FROM access_spaces WHERE workspace_id=$1",[ctx.workspaceId])).rowCount)
        return send(403, {code:"FORBIDDEN",requestId});
      let body: unknown;
      if (
        req.method === "POST" ||
        req.method === "PATCH" ||
        req.method === "DELETE"
      ) {
        if (
          !agent && (req.headers.origin !== options.origin ||
          req.headers["x-csrf-token"] !== session!.csrfToken)
        )
          return send(403, { code: "CSRF_FAILED" });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return send(415, { code: "JSON_REQUIRED" });
        body = await readJsonBody(req, 512000);
      }
      if (agent) {
        if (!permittedAgentRoute(req.method || "GET",path,agent.agent.scope,body))
          return send(403,{code:"FORBIDDEN",requestId});
        await recordAgentRequest(options.pool,agent,path);
      }
      if (path.startsWith("/api/v1/credentials")) {
        if (agent) return send(403,{code:"FORBIDDEN",requestId});
        const result=await handleCredentialRequest(options.pool,ctx,req.method || "GET",path,body,options.origin);
        if(result) return send(result.status,result.body);
      }
      if (path.startsWith("/api/v1/device/verify/") && req.method==="GET") {
        const code=path.slice("/api/v1/device/verify/".length);
        const result=await verifyDevice(options.pool,ctx,code);
        return send(result.status,result.body);
      }
      if (path==="/api/v1/device/decision" && req.method==="POST") {
        const result=await decideDevice(options.pool,ctx,body);
        return send(result.status,result.body);
      }
      if (path === "/api/v1/usage/export" && req.method === "GET") {
        const days = Number(url.searchParams.get("days") || "30");
        const output = await exportUsageCsv(options.pool, ctx, days);
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"agent-knowledge-hub-usage.csv\"",
          "X-Request-Id": requestId,
        });
        return res.end(output);
      }
      const service = options.service;
      if (path === "/api/v1/access/switch" && req.method === "POST") {
        const b = z.object({ spaceId: id }).strict().parse(body);
        return send(
          200,
          await options.auth!.switchSpace(req, session, b.spaceId),
        );
      }
      if (path.startsWith("/api/v1/access")) {
        const result = await handleAccessRequest(
          access,
          ctx,
          req.method || "GET",
          path,
          body,
          url.searchParams,
        );
        if (result) return send(result.status, result.body);
      }
      if (path.startsWith("/api/v1/board/")) {
        const result = await handleBoardRequest(options.pool, ctx, req.method || "GET", path, body, url.searchParams);
        if (result) return send(result.status, result.body);
      }
      if (path.startsWith("/api/v1/import")) {
        const result = await handleImportRequest(
          service.imports,
          ctx,
          req.method || "GET",
          path,
          body,
          req.headers,
          url.searchParams,
        );
        if (result) return send(result.status, result.body);
      }
      if (path === "/mcp" && req.method === "POST")
        return await handleMcp(req, res, body, service, ctx);
      if (path === "/auth/logout" && req.method === "POST") {
        await options.auth?.logout(req, res);
        return send(200, { ok: true });
      }
      if (req.method === "GET") {
        if (path === "/api/v1/me") return send(200, session ?? {principalId:ctx.principalId,workspaceId:ctx.workspaceId,role:agent?.agent.scope==="read"?"reader":"editor",agent:true});
        if (path === "/api/v1/pages")
          return send(200, { items: await service.pages(ctx) });
        if (path === "/api/v1/sources")
          return send(200, { items: await service.sources(ctx) });
        if (path === "/api/v1/changesets")
          return send(200, { items: await service.changesets(ctx) });
        if (path === "/api/v1/jobs")
          return send(200, { items: await service.jobs(ctx) });
        if (path === "/api/v1/model") return send(200, {...modelConfig(),systemone:systemOneConfig()});
        if (path === "/api/v1/usage") {
          const days = url.searchParams.get("days") || "7";
          if (!["7", "14", "30", "90"].includes(days)) throw Error("VALIDATION_FAILED");
          return send(200, await usageSummary(options.pool, ctx, Number(days)));
        }
        if (path === "/api/v1/members")
          return send(200, {
            items: (
              await options.pool.query(
                'SELECT principal_id AS "principalId",effective_membership(workspace_id,principal_id) AS role FROM memberships WHERE workspace_id=$1 AND effective_membership(workspace_id,principal_id) IS NOT NULL ORDER BY principal_id',
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
        if(path==="/api/v1/evaluations/systemone") {
          if(!session || session.role!=="reviewer" || session.canReviewKnowledge===false)
            return send(403,{code:"FORBIDDEN",requestId});
          const b=z.object({pageId:id}).strict().parse(body);
          return send(200,await assessPage(options.pool,service,ctx,b.pageId));
        }
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
          /^\/api\/v1\/changesets\/([^/]+)\/(approve|publish|reject|triage)$/,
        );
        if (action) {
          const batchId = id.parse(action[1]);
          if (action[2] === "triage") {
            const b = z
              .object({
                label: z.enum([
                  "untriaged",
                  "needs-review",
                  "duplicate",
                  "blocked",
                ]),
              })
              .strict()
              .parse(body);
            return send(200, await service.triage(ctx, batchId, b.label));
          }
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
        EXPORT_TOO_LARGE: 413,
        INVALID_CLIENT: 400,
        INVALID_GRANT: 400,
        EXPIRED_GRANT: 400,
        ACCESS_DENIED: 403,
        SLOW_DOWN: 429,
        RATE_LIMITED: 429,
        CLIENT_LIMIT: 429,
        INPUT_TOO_LARGE: 413,
        ALREADY_EXISTS: 409,
        STALE_VERSION: 409,
        APPROVAL_STALE: 409,
        IDEMPOTENCY_CONFLICT: 409,
        SOURCE_SCOPE_CONFLICT: 409,
        MODEL_NOT_CONFIGURED: 503,
        MODEL_FAILED: 502,
        MODEL_OUTPUT_LIMIT: 502,
        MODEL_CONFIGURATION: 503,
        MODEL_INVALID: 502,
        MODEL_CONTEXT_LIMIT: 413,
        JOB_CAPACITY: 429,
        INPUT_CHANGED: 409,
        LAST_OWNER: 409,
        INVITATION_REQUIRED: 409,
        ORGANIZATION_MEMBERSHIP_REQUIRED: 409,
        ALREADY_MANAGED: 409,
        POLICY_CHANGED: 409,
        MODEL_CONFIGURATION_CHANGED: 409,
        INPUT_FROZEN: 409,
        IMPORT_BUSY: 409,
        UPLOAD_INCOMPLETE: 409,
        CHECKSUM_MISMATCH: 400,
        INVALID_UPLOAD: 400,
        PREFLIGHT_REQUIRED: 409,
        WARNINGS_REQUIRE_ACKNOWLEDGEMENT: 409,
        AUTHORIZATION_REQUIRED: 401,
        IMPORT_QUOTA: 429,
        RETRY_LIMIT: 409,
        BUDGET_EXCEEDED: 413,
        ALREADY_PROPOSED: 409,
        UNSUPPORTED_FORMAT: 415,
        INVALID_ARCHIVE: 400,
        UNSAFE_ARCHIVE: 400,
        ARCHIVE_LIMIT: 413,
        ENCODING_REQUIRED: 400,
        INVALID_JSON: 400,
        INVALID_CSV: 400,
        CSV_MAPPING_REQUIRED: 400,
        NO_RECORDS: 400,
        RECORD_LIMIT: 413,
        INVALID_MODEL_EVIDENCE: 502,
        CONTEXT_INCOMPLETE: 409,
      };
      const safe = Object.hasOwn(statuses, code)
        ? code
        : "DEPENDENCY_UNAVAILABLE";
      send(statuses[safe] || 503, { code: safe, requestId });
    }
  };
}
