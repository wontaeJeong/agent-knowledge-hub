import type { Context } from "../service";
import type { AgentService } from "./service";
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
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  if (method !== "POST") return false;
  if (path === "/api/v1/connector") {
    const request = z
      .object({
        action: z.enum(["snapshot", "access", "push", "propose", "proposal"]),
        input: z.unknown(),
      })
      .strict()
      .parse(body);
    send(200, await agents.connector(ctx, request.action, request.input));
    return true;
  }
  const handlers = {
    search: () => agents.search(ctx, body),
    read: () => agents.read(ctx, body),
    context: () => agents.context(ctx, body),
    artifacts: () => agents.submitArtifact(ctx, body),
    changesets: () => agents.proposeChange(ctx, body),
    outcomes: () => agents.reportOutcome(ctx, body),
  };
  const route = path.match(
    /^\/api\/v1\/agent\/(search|read|context|artifacts|changesets|outcomes)$/,
  );
  if (!route) return false;
  const name = route[1] as keyof typeof handlers;
  send(
    ["artifacts", "changesets", "outcomes"].includes(name) ? 201 : 200,
    await handlers[name](),
  );
  return true;
}
