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
import { hash } from "../imports/parser";
import { PART_SIZE, selectionSchema } from "../imports/service";

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  service: RuntimeService,
  ctx: Context,
) {
  const server = new Server(
    { name: "agent-knowledge-hub", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const schemas = {
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
    knowledge_search: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
    knowledge_query: {
      type: "object",
      properties: {
        question: { type: "string" },
        mode: { enum: ["offline", "model"] },
      },
      required: ["question", "mode"],
      additionalProperties: false,
    },
    knowledge_ingest: {
      type: "object",
      properties: {
        sourceIds: { type: "array", items: { type: "string" } },
        mode: { enum: ["offline", "model"] },
      },
      required: ["sourceIds", "mode"],
      additionalProperties: false,
    },
    knowledge_lint: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    knowledge_jobs: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as const;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas).map(([name, inputSchema]) => ({
      name,
      inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    let result: unknown;
    const input = params.arguments || {};
    switch (params.name) {
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
      case "knowledge_search": {
        const { question } = z
          .object({ question: z.string().min(1).max(2000) })
          .strict()
          .parse(input);
        const pages = await service.pages(ctx);
        result = {
          items: pages
            .filter((p) =>
              (p.title + " " + p.summary + " " + p.content)
                .toLowerCase()
                .includes(question.toLowerCase()),
            )
            .slice(0, 20),
        };
        break;
      }
      case "knowledge_query": {
        const data = queryInput.parse(input);
        result = await service.query(ctx, data.question, data.mode);
        break;
      }
      case "knowledge_ingest": {
        const data = ingestInput.parse(input);
        result = await service.ingest(ctx, data.sourceIds, data.mode);
        break;
      }
      case "knowledge_lint":
        z.object({}).strict().parse(input);
        result = await service.lint(ctx);
        break;
      case "knowledge_jobs":
        z.object({}).strict().parse(input);
        result = { items: await service.jobs(ctx) };
        break;
      default:
        throw Error("UNKNOWN_TOOL");
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
