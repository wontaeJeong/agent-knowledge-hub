import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentInputs, type AgentService } from "./service";
import type { Context } from "../service";
import type { RuntimeJobsBridge } from "../jobs/runtime";
const descriptions = {
  wiki_search: "현재 권한의 발행 지식을 버전·적용 조건과 함께 검색합니다.",
  wiki_read: "현재 ACL로 고정 버전·문단·근거·예외를 읽습니다.",
  wiki_get_context:
    "업무의 근거를 예산 내에서 구성하고 생략과 추가 조회 방법을 명시합니다.",
  wiki_submit_artifact:
    "불변 원본을 등록합니다. 자동 편입·승인·발행하지 않습니다.",
  wiki_propose_change:
    "기준 버전·원본·의존 관계를 검사한 다중 페이지 변경 집합을 제안합니다.",
  wiki_report_outcome:
    "사용 버전과 업무 결과를 미검증 관측으로 접수하고 재검토 신호를 남깁니다.",
};
export async function callAgentTool(
  agents: AgentService,
  ctx: Context,
  name: string,
  input: unknown,
) {
  switch (name) {
    case "wiki_search":
      return agents.search(ctx, input);
    case "wiki_read":
      return agents.read(ctx, input);
    case "wiki_get_context":
      return agents.context(ctx, input);
    case "wiki_submit_artifact":
      return agents.submitArtifact(ctx, input);
    case "wiki_propose_change":
      return agents.proposeChange(ctx, input);
    case "wiki_report_outcome":
      return agents.reportOutcome(ctx, input);
    default:
      throw Error("UNKNOWN_TOOL");
  }
}
export async function handleAgentMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  agents: AgentService,
  ctx: Context,
  jobs?: RuntimeJobsBridge,
) {
  const server = new Server(
    { name: "agent-knowledge-hub-agent", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...Object.entries(agentInputs).map(([name, schema]) => ({
        name,
        description: descriptions[name as keyof typeof descriptions],
        inputSchema: z.toJSONSchema(schema, {
          io: "input",
        }) as Tool["inputSchema"],
        annotations: {
          readOnlyHint: [
            "wiki_search",
            "wiki_read",
            "wiki_get_context",
          ].includes(name),
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      })),
      ...(jobs
        ? ["wiki_job_status", "wiki_cancel_job"].map((name) => ({
            name,
            description:
              name === "wiki_job_status"
                ? "현재 권한으로 내 지속 작업의 실제 상태와 결과를 조회합니다."
                : "현재 권한으로 작업 취소를 요청합니다. 실제 취소 완료와 구분합니다.",
            inputSchema: {
              type: "object" as const,
              properties: {
                job_id: {
                  type: "string" as const,
                  pattern: "^[a-zA-Z0-9_-]{1,100}$",
                },
              },
              required: ["job_id"],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: name === "wiki_job_status",
              idempotentHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          }))
        : []),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const jobTool =
        jobs && ["wiki_job_status", "wiki_cancel_job"].includes(params.name);
      const job = jobTool
        ? z
            .object({ job_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) })
            .strict()
            .parse(params.arguments ?? {})
        : undefined;
      const result =
        jobTool && job
          ? await (params.name === "wiki_job_status"
              ? jobs!.read(ctx, job.job_id)
              : jobs!.cancel(ctx, job.job_id))
          : await callAgentTool(
              agents,
              ctx,
              params.name,
              params.arguments ?? {},
            );
      return {
        structuredContent: result,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (e) {
      const code =
        e instanceof z.ZodError
          ? "VALIDATION_FAILED"
          : e instanceof Error && /^[A-Z_]{3,60}$/.test(e.message)
            ? e.message
            : "REQUEST_FAILED";
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code, requestId: randomUUID() }),
          },
        ],
      };
    }
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
