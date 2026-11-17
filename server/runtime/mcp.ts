import {DocumentStructureService,structureCredentialOperation,structureQuery,structureMoveSchema,duplicateSchema} from "../convenience/structure";
import {WorkflowService} from "../workflows/service";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RuntimeService } from "./knowledge";
import type { Context } from "../service";
import { ingestInput, queryInput } from "./schema";
import type { RuntimeJobsBridge } from "../jobs/runtime";
import { createHash, randomUUID } from "node:crypto";
import { recordJobTrace } from "./traces";
import { hash } from "../imports/parser";
import { PART_SIZE, selectionSchema } from "../imports/service";
import { semanticSearchRequest } from "../questions/semantic";
import { ScopedSearch, searchFilters } from "../questions/search";
import { authorizeInTransaction } from "../access/index";
const searchers = new WeakMap<RuntimeService, ScopedSearch>();
const { query: _query, ...filterShape } = searchFilters.shape;
const mcpSearchInput = z
  .object({ ...filterShape, question: z.string().trim().min(1).max(2000) })
  .strict();
const requestKey = z.string().min(1).max(200).optional();
const jobKey = (kind: string, key: string | undefined) =>
  "mcp-" +
  createHash("sha256")
    .update(kind + "\0" + (key ?? randomUUID()))
    .digest("hex");

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  service: RuntimeService,
  ctx: Context,
  jobs?: RuntimeJobsBridge,
  scopedSearch?: ScopedSearch,
  structureIdentity?: import("./auth").OidcAuth,
  structureOrigin?: string,
) {
  const server = new Server(
    { name: "agent-knowledge-hub", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const pathSchema=z.object({pageId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}).strict();
  const structure=new DocumentStructureService(new WorkflowService(service.pool,service,authorizeInTransaction,structureOrigin),structureIdentity);
  const schemas = {
    knowledge_tree:z.toJSONSchema(structureQuery,{io:"input"}),
    knowledge_path:z.toJSONSchema(pathSchema,{io:"input"}),
    knowledge_move:z.toJSONSchema(structureMoveSchema,{io:"input"}),
    knowledge_duplicate:z.toJSONSchema(duplicateSchema,{io:"input"}),
    knowledge_import_selection: {
      type: "object",
      properties: {
        importId: { type: "string" },
        revision: { type: "integer" },
        selection: { type: "object" },
      },
      required: ["importId", "revision", "selection"],
      additionalProperties: false,
    },
    knowledge_import_text: {
      type: "object",
      properties: {
        title: { type: "string" },
        text: { type: "string" },
        requestKey: { type: "string" },
      },
      required: ["title", "text", "requestKey"],
      additionalProperties: false,
    },
    knowledge_import_preview: {
      type: "object",
      properties: {
        importId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
      },
      required: ["importId"],
      additionalProperties: false,
    },
    knowledge_import_start: {
      type: "object",
      properties: {
        importId: { type: "string" },
        revision: { type: "integer" },
        mode: { enum: ["model", "offline"] },
        requestKey: { type: "string" },
      },
      required: ["importId", "revision", "mode", "requestKey"],
      additionalProperties: false,
    },
    knowledge_import_status: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    knowledge_import_cancel: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    knowledge_import_resume: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    knowledge_semantic_search: z.toJSONSchema(semanticSearchRequest, {
      io: "input",
    }),
    knowledge_search: z.toJSONSchema(mcpSearchInput, { io: "input" }),
    knowledge_query: z.toJSONSchema(
      queryInput.extend({ idempotency_key: requestKey }),
      { io: "input" },
    ),
    knowledge_ingest: {
      type: "object",
      properties: {
        sourceIds: { type: "array", items: { type: "string" } },
        mode: { enum: ["offline", "model"] },
        idempotency_key: { type: "string", maxLength: 200 },
      },
      required: ["sourceIds", "mode"],
      additionalProperties: false,
    },
    knowledge_lint: {
      type: "object",
      properties: { idempotency_key: { type: "string", maxLength: 200 } },
      additionalProperties: false,
    },
    knowledge_jobs: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as const;
  const agentTools = ctx.agent
    ? new Set(
        ctx.agent.scope === "read"
          ? ["knowledge_search", "knowledge_jobs"]
          : [
              "knowledge_search",
              "knowledge_jobs",
              "knowledge_query",
              "knowledge_ingest",
              "knowledge_lint",
            ],
      )
    : null;
  const c7Operation=await structureCredentialOperation(service.pool,ctx);
  const admittedTools=c7Operation?new Set([`knowledge_${c7Operation}`]):agentTools;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas)
      .filter(([name]) => !admittedTools || admittedTools.has(name))
      .map(([name, inputSchema]) => ({ name, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    let result: unknown;
    const input = params.arguments || {};
    if (admittedTools && !admittedTools.has(params.name)) throw Error("FORBIDDEN");
    switch (params.name) {
      case "knowledge_tree":result=await structure.children(ctx,structureQuery.parse(input));break;
      case "knowledge_path":result=await structure.path(ctx,pathSchema.parse(input).pageId);break;
      case "knowledge_move":result=await structure.move(ctx,input);break;
      case "knowledge_duplicate":result=await structure.duplicateToDraft(ctx,input);break;
      case "knowledge_import_selection": {
        const b = z
          .object({
            importId: z.string().min(1).max(100),
            revision: z.number().int().positive(),
            selection: z.record(z.string(), z.unknown()),
          })
          .strict()
          .parse(input);
        const current = await service.imports.view(ctx, b.importId);
        result = await service.imports.select(
          ctx,
          b.importId,
          b.revision,
          selectionSchema.parse({ ...current.selection, ...b.selection }),
        );
        break;
      }
      case "knowledge_import_text": {
        const b = z
          .object({
            title: z.string().min(1).max(300),
            text: z.string().min(1).max(100_000),
            requestKey: z.string().min(1).max(80),
          })
          .strict()
          .parse(input);
        const bytes = Buffer.from(b.text, "utf8"),
          fileId = "text";
        const created = await service.imports.create(
          ctx,
          {
            title: b.title,
            files: [
              {
                id: fileId,
                name: "mcp-input.txt",
                size: bytes.length,
                sha256: hash(bytes),
              },
            ],
          },
          b.requestKey,
        );
        const existing = await service.imports.view(ctx, created.id);
        if (existing.status === "uploading") {
          for (
            let offset = 0, part = 0;
            offset < bytes.length;
            offset += PART_SIZE, part++
          ) {
            const chunk = bytes.subarray(offset, offset + PART_SIZE);
            await service.imports.uploadPart(ctx, created.id, fileId, part, {
              data: chunk.toString("base64"),
              sha256: hash(chunk),
            });
          }
          result = {
            importId: created.id,
            preflightRunId: (
              await service.imports.finalize(
                ctx,
                created.id,
                b.requestKey + ":preflight",
              )
            ).id,
          };
        } else result = { importId: created.id };
        break;
      }
      case "knowledge_import_preview": {
        const b = z
          .object({
            importId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            offset: z.number().int().min(0).max(20_000).default(0),
          })
          .strict()
          .parse(input);
        result = await service.imports.view(ctx, b.importId, b.offset);
        break;
      }
      case "knowledge_import_start": {
        const b = z
          .object({
            importId: z.string().min(1).max(100),
            revision: z.number().int().positive(),
            mode: z.enum(["model", "offline"]),
            requestKey: z.string().min(1).max(100),
          })
          .strict()
          .parse(input);
        result = await service.imports.start(
          ctx,
          b.importId,
          { revision: b.revision, mode: b.mode },
          b.requestKey,
        );
        break;
      }
      case "knowledge_import_status":
      case "knowledge_import_cancel":
      case "knowledge_import_resume": {
        const b = z
          .object({ runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
          .strict()
          .parse(input);
        result = await service.imports[
          params.name === "knowledge_import_status"
            ? "runViewFor"
            : params.name === "knowledge_import_cancel"
              ? "cancel"
              : "resume"
        ](ctx, b.runId);
        break;
      }
      case "knowledge_semantic_search": {
        if (!jobs) throw Error("SEMANTIC_SEARCH_NOT_CONFIGURED");
        const data = semanticSearchRequest.parse(input);
        result = await jobs.submitInteractive(
          ctx,
          "query",
          { semanticSearch: data.filters, mode: "model" },
          data.idempotency_key,
        );
        break;
      }
      case "knowledge_search": {
        const { question, ...filters } = mcpSearchInput.parse(input);
        let search = scopedSearch ?? searchers.get(service);
        if (!search) {
          search = new ScopedSearch(service.pool, {
            runtime: service,
            authorize: authorizeInTransaction,
          });
          searchers.set(service, search);
        }
        const found = await search.search(ctx, { ...filters, query: question });
        result = {
          ...found,
          items: found.items.map((item) => ({
            ...item,
            id: item.pageId,
            summary: item.metadata?.summary ?? item.content.slice(0, 300),
            scope: item.metadata?.scope ?? null,
            lifecycle: item.metadata?.state ?? null,
            effectiveFrom: item.metadata?.effectiveFrom ?? null,
            replacementId: item.metadata?.replacementId ?? null,
            reviewDue: item.metadata?.reviewDate ?? null,
            reviewOverdue: item.metadata?.reviewDate
              ? Date.parse(item.metadata.reviewDate) < Date.now()
              : false,
          })),
        };
        break;
      }
      case "knowledge_query": {
        const { idempotency_key, ...data } = queryInput
          .extend({ idempotency_key: requestKey })
          .parse(input);
        result = jobs
          ? await jobs.submitInteractive(
              ctx,
              "query",
              data,
              jobKey("query", idempotency_key),
            )
          : await service.query(
              ctx,
              data.question,
              data.mode,
              undefined,
              undefined,
              data.scope,
            );
        break;
      }
      case "knowledge_ingest": {
        const { idempotency_key, ...data } = ingestInput
          .extend({ idempotency_key: requestKey })
          .parse(input);
        result = jobs
          ? await jobs.submitInteractive(
              ctx,
              "ingest",
              data,
              jobKey("ingest", idempotency_key),
            )
          : await service.ingest(ctx, data.sourceIds, data.mode);
        break;
      }
      case "knowledge_lint": {
        const { idempotency_key } = z
          .object({ idempotency_key: requestKey })
          .strict()
          .parse(input);
        result = jobs
          ? await jobs.submitInteractive(
              ctx,
              "lint",
              {},
              jobKey("lint", idempotency_key),
            )
          : await service.lint(ctx);
        break;
      }
      case "knowledge_jobs":
        z.object({}).strict().parse(input);
        result = jobs
          ? await jobs.list(ctx)
          : { items: await service.jobs(ctx) };
        break;
      default:
        throw Error("UNKNOWN_TOOL");
    }
    if (
      jobs &&
      ctx.requestId &&
      typeof result === "object" &&
      result !== null &&
      "id" in result &&
      "status" in result &&
      typeof result.id === "string" &&
      ["knowledge_query", "knowledge_ingest", "knowledge_lint"].includes(
        params.name,
      )
    ) {
      await recordJobTrace(
        service.pool,
        ctx,
        ctx.requestId,
        params.name === "knowledge_query"
          ? "query"
          : params.name === "knowledge_ingest"
            ? "ingest"
            : "lint",
        result.id,
      );
      result = { ...result, requestId: ctx.requestId };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
