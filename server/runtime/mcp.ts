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
) {
  const server = new Server(
    { name: "agent-knowledge-hub", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const schemas = {
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
        idempotency_key: { type: "string", maxLength: 200 },
      },
      required: ["question", "mode"],
      additionalProperties: false,
    },
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
          : await service.query(ctx, data.question, data.mode);
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
