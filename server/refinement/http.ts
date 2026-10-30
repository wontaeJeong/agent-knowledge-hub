import type { Context } from "../service";
import type { RefinementService } from "./service";

/** Pure adapter: host MUST enforce identity, selected workspace, CSRF, body limits and error mapping. */
export async function handleRefinementRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: RefinementService,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  if (!path.startsWith("/api/v1/refinement/")) return false;
  const route = path.slice("/api/v1/refinement/".length);
  const reply = (data: unknown, status = 200) => {
    send(status, data);
    return true;
  };
  if (method === "GET") {
    if (route === "requests") return reply(await service.requests(ctx));
    if (route === "outcomes") return reply(await service.outcomes(ctx));
  }
  if (method !== "POST") return false;
  if (route === "source-snapshot")
    return reply(await service.sourceSnapshot(ctx, body));
  if (route === "evidence")
    return reply(await service.addEvidence(ctx, body), 201);
  if (route === "claims") return reply(await service.addClaim(ctx, body), 201);
  if (route === "context") return reply(await service.context(ctx, body));
  if (route === "outcomes")
    return reply(await service.reportOutcome(ctx, body), 201);
  if (route === "outcome-reviews")
    return reply(await service.reviewOutcome(ctx, body), 201);
  if (route === "claim-reviews")
    return reply(await service.reviewClaim(ctx, body), 201);
  if (route === "semantic-lint")
    return reply(await service.semanticLint(ctx, body));
  if (route === "import-agent-signals")
    return reply(await service.importAgentSignals(ctx, body ?? {}), 202);
  return false;
}
