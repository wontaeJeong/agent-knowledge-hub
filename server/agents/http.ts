import type { Context } from "../service";
import type { AgentService } from "./service";
import { localKnowledge } from "./local-knowledge";
import type { RuntimeJobsBridge } from "../jobs/runtime";
import { z } from "zod";

/** Host must perform session/bearer verification, selected space and CSRF checks first. */
export async function handleAgentRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  agents: AgentService,
  jobs?: RuntimeJobsBridge,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  if (method !== "POST") return false;
  if (path === "/api/v1/connector") {
    const request = z
      .object({
        action: z.enum([
          "knowledge-capabilities",
          "knowledge-register",
          "knowledge-ingest",
          "knowledge-query",
          "knowledge-lint",
          "knowledge-job",
          "knowledge-file-answer",
          "snapshot",
          "access",
          "check-local",
          "push",
          "propose",
          "propose-batch",
          "proposal",
        ]),
        input: z.unknown(),
      })
      .strict()
      .parse(body);
    send(
      200,
      await (request.action.startsWith("knowledge-")
        ? localKnowledge(agents, ctx, request.action, request.input, jobs)
        : agents.connector(ctx, request.action, request.input)),
    );
    return true;
  }
  const handlers = {
    search: () => agents.search(ctx, body),
    "semantic-search": () => agents.semanticSearch(ctx, body),
    read: () => agents.read(ctx, body),
    context: () => agents.context(ctx, body),
    artifacts: () => agents.submitArtifact(ctx, body),
    changesets: () => agents.proposeChange(ctx, body),
    outcomes: () => agents.reportOutcome(ctx, body),
  };
  const route = path.match(
    /^\/api\/v1\/agent\/(search|semantic-search|read|context|artifacts|changesets|outcomes)$/,
  );
  if (!route) return false;
  const name = route[1] as keyof typeof handlers;
  send(
    name === "semantic-search"
      ? 202
      : ["artifacts", "changesets", "outcomes"].includes(name)
        ? 201
        : 200,
    await handlers[name](),
  );
  return true;
}
