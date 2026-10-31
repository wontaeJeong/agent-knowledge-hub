import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
import { readJsonBody } from "./body";
import { assertSchemaCurrent } from "../database";
import {
  AccessService,
  authorizeAction,
  authorizeInTransaction,
} from "../access/index";
import { WorkflowService } from "../workflows/service";
import { handleWorkflowRoute } from "../workflows/http";
import { handleRetentionRoute } from "../retention/http";
import { DraftRecoveryService } from "../retention/recovery";
import { ContentRetentionService } from "../retention/service";
import { AgentService } from "../agents/service";
import { handleAgentRoute } from "../agents/http";
import { handleAgentMcp } from "../agents/mcp";
import { accessRoute, routeAction } from "../access/http";
import type { Context } from "../service";
import {
  storageRoutes,
  type StorageService,
  type UrlCollector,
} from "../storage";
import { handleRefinementRoute } from "../refinement/http";
import type { RefinementService } from "../refinement/service";
import { extensionErrorStatuses } from "./errors";
import type { HttpAdmission } from "./admission";
import type { OperationsRouteInput } from "../operations/routes";
import { assertOperationalStartup } from "../operations/recovery";
import type { ShutdownController } from "../operations/monitoring";
import { runtimeCapabilities, type RuntimeJobsBridge } from "../jobs/runtime";
import { handleJobRoute } from "../jobs/http";
import { readStoredAnswer } from "../workflows/answers";
import {handlePolicyRequest} from '../policy/http';
import {recordJobTrace,readJobTrace} from './traces';
import {GovernanceService} from '../workflows/governance/service';
import {handleGovernanceRoute} from '../workflows/governance/http';
import { handleImportRequest } from "../imports/http";
import { AccessService as LegacyAccessService } from "../access";
import { handleAccessRequest } from "../access-http";

export function createRuntimeHandler(options: {
  pool: Pool;
  service: RuntimeService;
  origin: string;
  workspaceId: string;
  auth?: OidcAuth;
  dist?: string;
  storage?: StorageService;
  collector?: UrlCollector;
  refinement?: RefinementService;
  admission?: HttpAdmission;
  operations?: (input: OperationsRouteInput) => Promise<boolean>;
  jobs?: RuntimeJobsBridge;
  platformOperatorIds?: readonly string[];
  probe?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  shutdown?: ShutdownController;
}) {
  const storageHandler = options.storage
    ? storageRoutes(options.storage, options.collector)
    : undefined;
  const legacyAccess = new LegacyAccessService(options.pool);
  const retention = {
    recovery: new DraftRecoveryService(options.pool),
    retention: new ContentRetentionService(options.pool, authorizeInTransaction),
  };
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
    res.setHeader("X-Request-Id", requestId);
    let ticket: ReturnType<HttpAdmission["enter"]> | undefined;
    let releaseShutdown: (() => void) | undefined;
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
        await assertOperationalStartup(options.pool);
        if (options.probe && (await options.probe(req, res))) return;
        return send(200, { ok: true });
      }
      if (options.probe && (await options.probe(req, res))) return;
      if (path === "/metrics" && req.method === "GET")
        return send(403, { code: "FORBIDDEN", requestId });
      releaseShutdown = options.shutdown?.enter();
      ticket = options.admission?.enter();
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
      const access = new AccessService(options.pool);
      const bearer = req.headers.authorization?.match(
        /^Bearer (akh_[a-zA-Z0-9_-]{43})$/,
      )?.[1];
      if (req.headers.authorization && !bearer) throw Error("UNAUTHENTICATED");
      const credential = bearer
        ? await access.authenticateCredential(
            bearer,
            typeof req.headers["x-space-id"] === "string"
              ? req.headers["x-space-id"]
              : undefined,
          )
        : undefined;
      if (credential) {
        if (options.jobs) await options.jobs.revalidateCredential(credential);
        else if (
          (
            await options.pool.query(
              "SELECT 1 FROM access_principals WHERE id=$1 AND kind='service'",
              [credential.principalId],
            )
          ).rowCount
        )
          throw Error("DIRECTORY_STATUS_UNKNOWN");
      }
      const session = credential
        ? { ...credential, role: "reader" as const, csrfToken: "" }
        : await (options.auth?.authenticate(req) ?? Promise.resolve(null));
      if (!session) return send(401, { code: "UNAUTHENTICATED", requestId });
      if (
        session.workspaceId !== options.workspaceId &&
        !(
          await options.pool.query(
            "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
            [session.workspaceId],
          )
        ).rowCount
      )
        return send(403, { code: "FORBIDDEN" });
      const ctx: Context = {
        requestId,
        workspaceId: session.workspaceId,
        principalId: session.principalId,
        credentialId: credential?.credentialId,
        authorization: credential
          ? undefined
          : options.auth!.requestGuard(req, session),
      };
      ticket?.identify(
        ctx.workspaceId,
        ctx.principalId,
        !["GET", "HEAD"].includes(req.method ?? "GET"),
      );
      let body: unknown;
      if (
        req.method === "POST" ||
        req.method === "PATCH" ||
        req.method === "DELETE" ||
        req.method === "PUT"
      ) {
        if (
          !credential &&
          (req.headers.origin !== options.origin ||
            req.headers["x-csrf-token"] !== session.csrfToken)
        )
          return send(403, { code: "CSRF_FAILED" });
        if (req.method === "PUT" && path === "/api/v1/storage/blobs") {
          if (!storageHandler) throw Error("STORAGE_NOT_CONFIGURED");
          if (
            await storageHandler({
              method: req.method,
              path,
              body: undefined,
              ctx,
              send,
              req,
              res,
            })
          )
            return;
          throw Error("NOT_FOUND");
        }
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return send(415, { code: "JSON_REQUIRED" });
        body = await readJsonBody(
          req,
          path.startsWith("/api/v1/storage/") ? 5 * 1024 * 1024 : 512000,
        );
      }
      const service = options.service;
      if (await handleRetentionRoute({ method: req.method ?? "GET", path, body, ctx, send }, retention)) return;
      if(await handleGovernanceRoute({method:req.method??'GET',path,body,ctx,send},new GovernanceService(options.pool,authorizeInTransaction)))return;
      const submitInteractive=async(actor:Context,kind:'query'|'ingest'|'lint',payload:unknown,key:string)=>{
        if(!options.jobs)throw Error('EXECUTION_NOT_CONFIGURED');
        const receipt=await options.jobs.submitInteractive(actor,kind,payload,key);
        await recordJobTrace(options.pool,actor,requestId,kind==='lint'&&payload&&typeof payload==='object'&&'semantic' in payload&&payload.semantic===true?'semantic-lint':kind,receipt.id);
        return {...receipt,requestId};
      };
      const policyResponse=await handlePolicyRequest(options.pool,ctx,req.method??'GET',path,body);
      if(policyResponse)return send(policyResponse.status,policyResponse.body);
      if (
        options.jobs &&
        req.method === "POST" &&
        path === "/api/v1/refinement/semantic-lint"
      ) {
        const key = z
          .string()
          .min(1)
          .max(200)
          .parse(req.headers["idempotency-key"]);
        return send(
          202,
          await submitInteractive(
            ctx,
            "lint",
            { semantic: true, context: body },
            "http-" +
              createHash("sha256")
                .update("semantic-lint\0" + key)
                .digest("hex"),
          ),
        );
      }
      if (
        options.operations &&
        (await options.operations({
          method: req.method ?? "GET",
          path,
          body,
          ctx,
          send,
        }))
      )
        return;
      if (
        storageHandler &&
        (await storageHandler({
          method: req.method ?? "GET",
          path,
          body,
          ctx,
          send,
          req,
          res,
        }))
      )
        return;
      if (
        options.refinement &&
        (await handleRefinementRoute(
          { method: req.method ?? "GET", path, body, ctx, send },
          options.refinement,
        ))
      )
        return;
      const accessResult = path.startsWith('/api/v1/access')?undefined:await accessRoute(
        access,
        ctx,
        req.method,
        path,
        body,
        url.searchParams,
      );
      if (accessResult) return send(accessResult.status, accessResult.body);
      if (path === "/api/v1/access/switch" && req.method === "POST") {
        const b = z.object({ spaceId: id }).strict().parse(body);
        return send(
          200,
          await options.auth!.switchSpace(req, session, b.spaceId),
        );
      }
      if (path.startsWith("/api/v1/access")) {
        const result = await handleAccessRequest(
          legacyAccess,
          ctx,
          req.method || "GET",
          path,
          body,
          url.searchParams,
        );
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
      if (path === "/auth/logout" && req.method === "POST") {
        if (credential) throw Error("FORBIDDEN");
        await options.auth?.logout(req, res);
        return send(200, { ok: true });
      }
      if (path === "/api/v1/me" && req.method === "GET") {
        try {
          const a = await access.effective(ctx);
          if (!a.role) throw Error("NOT_FOUND");
          const role = a.capabilities.includes("changeset.approve")
            ? "reviewer"
            : a.capabilities.includes("changeset.propose")
              ? "editor"
              : "reader";
          return send(200, {
            workspaceId: ctx.workspaceId,
            principalId: ctx.principalId,
            role,
            csrfToken: session.csrfToken,
            capabilities: options.jobs
              ? runtimeCapabilities(
                  a.capabilities,
                  ctx.principalId,
                  options.platformOperatorIds,
                )
              : a.capabilities,
            effectiveRole: a.role,
            spaceRole: {
              read: "Read",
              triage: "Triage",
              write: "Write",
              maintain: "Maintain",
              admin: "Admin",
            }[a.role],
            canReviewKnowledge:
              !ctx.credentialId && a.capabilities.includes("changeset.approve"),
            personalSpace: a.space.namespaceKind === "personal",
            space: a.space,
          });
        } catch (e) {
          if (
            !(e instanceof Error) ||
            e.message !== "NOT_FOUND" ||
            ctx.credentialId
          )
            throw e;
          const p = await options.pool.query(
            "SELECT team_create FROM access_principals WHERE id=$1 AND active AND kind='human'",
            [ctx.principalId],
          );
          if (!p.rowCount) throw Error("UNAUTHENTICATED");
          return send(200, {
            workspaceId: ctx.workspaceId,
            principalId: ctx.principalId,
            role: "reader",
            csrfToken: session.csrfToken,
            capabilities: [
              "space.create",
              ...(p.rows[0].team_create ? ["team.create"] : []),
            ],
            space: null,
          });
        }
      }
      if (options.jobs) {
        const trace=path.match(/^\/api\/v1\/traces\/([a-zA-Z0-9_-]{1,100})$/);
        if(req.method==='GET'&&trace)return send(200,await readJobTrace(options.pool,options.jobs,ctx,trace[1]));
        if (req.method === "GET" && path === "/api/v1/execution-identities") {
          const accessState = await authorizeAction(
            options.pool,
            ctx,
            "knowledge.protect",
          );
          const ready = options.jobs.readiness();
          if (!ready.serviceDirectoryConfigured)
            return send(200, { items: [], directoryConfigured: false });
          const rows = await options.pool.query(
            `SELECT c.id AS "credentialId",c.principal_id AS "principalId",c.workspace_id AS "workspaceId",s.name FROM access_credentials c JOIN access_service_accounts s ON s.principal_id=c.principal_id JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='service' JOIN access_principals sponsor ON sponsor.id=s.sponsor_id AND sponsor.active AND sponsor.kind='human' JOIN access_team_members m ON m.team_id=s.namespace_id AND m.principal_id=sponsor.id AND m.active WHERE c.workspace_id=$1 AND s.namespace_id=$2 AND NOT c.revoked AND c.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() ORDER BY s.name,c.id LIMIT 100`,
            [ctx.workspaceId, accessState.space.namespaceId],
          );
          const items = [];
          for (const item of rows.rows) {
            try {
              const effective = await new AccessService(options.pool).effective(
                {
                  workspaceId: ctx.workspaceId,
                  principalId: item.principalId,
                  credentialId: item.credentialId,
                },
              );
              if (
                effective.capabilities.includes("knowledge.read") &&
                (effective.capabilities.includes("changeset.propose") ||
                  effective.capabilities.includes("lint.run"))
              )
                items.push(item);
            } catch (e) {
              if (!(
                e instanceof Error &&
                ["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED"].includes(
                  e.message,
                )
              ))
                throw e;
            }
          }
          return send(200, { items, directoryConfigured: true });
        }
        if (req.method === "POST" && path === "/api/v1/jobs-v2"){
          const receipt=await options.jobs.submitDelegated(ctx,body);
          await recordJobTrace(options.pool,ctx,requestId,receipt.kind,receipt.id);
          return send(202,{...receipt,requestId});
        }
        if (
          await handleJobRoute(
            {
              method: req.method ?? "GET",
              path: path + url.search,
              body,
              ctx,
              send,
            },
            options.jobs.jobs,
          )
        )
          return;
      }
      const agents = new AgentService(
        options.pool,
        service,
        authorizeInTransaction,
        options.refinement
          ? (ctx, id) =>
              options.refinement!.importAgentSignals(ctx, { outcomeId: id })
          : undefined,
      );
      if (path === "/api/v1/agent/mcp" && req.method === "POST")
        return await handleAgentMcp(req, res, body, agents, ctx, options.jobs);
      if (
        await handleAgentRoute(
          { method: req.method ?? "GET", path, body, ctx, send },
          agents,
        )
      )
        return;
      if (path === "/mcp" && !(await access.effective(ctx)).role)
        throw Error("NOT_FOUND");
      if (path !== "/mcp")
        await authorizeAction(options.pool, ctx, routeAction(path, req.method));
      if (
        await handleWorkflowRoute(
          { method: req.method ?? "GET", path, body, ctx, send },
          new WorkflowService(options.pool, service, authorizeInTransaction),
        )
      )
        return;
      if (path === "/mcp" && req.method === "POST")
        return await handleMcp(req, res, body, service, ctx, options.jobs);
      if (req.method === "GET") {
        const storedAnswer = path.match(/^\/api\/v1\/answers\/([^/]+)$/);
        if (storedAnswer)
          return send(
            200,
            await readStoredAnswer(
              options.pool,
              service,
              ctx,
              id.parse(storedAnswer[1]),
            ),
          );
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
            items: await access.members(ctx),
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
          if (options.jobs) {
            const key = z
              .string()
              .min(1)
              .max(200)
              .parse(req.headers["idempotency-key"]);
            return send(
              202,
              await submitInteractive(
                ctx,
                "ingest",
                b,
                "http-" +
                  createHash("sha256")
                    .update("ingest\0" + key)
                    .digest("hex"),
              ),
            );
          }
          return send(201, await service.ingest(ctx, b.sourceIds, b.mode));
        }
        if (path === "/api/v1/query") {
          const b = queryInput.parse(body);
          if (options.jobs) {
            const key = z
              .string()
              .min(1)
              .max(200)
              .parse(req.headers["idempotency-key"]);
            return send(
              202,
              await submitInteractive(
                ctx,
                "query",
                b,
                "http-" +
                  createHash("sha256")
                    .update("query\0" + key)
                    .digest("hex"),
              ),
            );
          }
          return send(200, await service.query(ctx, b.question, b.mode));
        }
        if (path === "/api/v1/lint") {
          z.object({}).strict().parse(body);
          if (options.jobs) {
            const key = z
              .string()
              .min(1)
              .max(200)
              .parse(req.headers["idempotency-key"]);
            return send(
              202,
              await submitInteractive(
                ctx,
                "lint",
                {},
                "http-" +
                  createHash("sha256")
                    .update("lint\0" + key)
                    .digest("hex"),
              ),
            );
          }
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
          const approved=await service.core.approve(ctx, batchId, hash);
          return send(200, { id: batchId, hash,...(approved?.warnings?.length?{warnings:approved.warnings}:{}) });
        }
      }
      return send(404, { code: "NOT_FOUND", requestId });
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
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
        INPUT_TOO_LARGE: 413,
        ALREADY_EXISTS: 409,
        STALE_VERSION: 409,
        APPROVAL_STALE: 409,
        IDEMPOTENCY_CONFLICT: 409,
        SOURCE_SCOPE_CONFLICT: 409,
        LAST_OWNER: 409,
        MODEL_NOT_CONFIGURED: 503,
        MODEL_FAILED: 502,
        MODEL_OUTPUT_LIMIT: 502,
        MODEL_CONFIGURATION: 503,
        MODEL_CONTEXT_LIMIT: 413,
        JOB_CAPACITY: 429,
        INPUT_CHANGED: 409,
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
      const status = Object.hasOwn(statuses, code)
        ? statuses[code]
        : extensionErrorStatuses[code];
      const safe = status !== undefined ? code : "DEPENDENCY_UNAVAILABLE";
      if (status === 429) {
        const retry =
          e instanceof Error &&
          "retryAfterSeconds" in e &&
          typeof e.retryAfterSeconds === "number" &&
          Number.isSafeInteger(e.retryAfterSeconds)
            ? Math.max(1, Math.min(3600, e.retryAfterSeconds))
            : 5;
        res.setHeader("Retry-After", String(retry));
      }
      send(status ?? 503, { code: safe, requestId });
    } finally {
      ticket?.release();
      releaseShutdown?.();
    }
  };
}
