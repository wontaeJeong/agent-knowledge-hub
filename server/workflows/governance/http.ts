import type { Context } from "../../service";
import type { GovernanceService } from "./service";
export const governanceErrorStatuses = Object.freeze({
  PROPERTY_REQUIRED: 409,
});
export async function handleGovernanceRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: GovernanceService,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  if (!path.startsWith("/api/v1/governance/")) return false;
  const route = path.slice("/api/v1/governance".length);
  const reply = (data: unknown, status = 200) => {
    send(status, data);
    return true;
  };
  if (method === "GET") {
    if (route === "/workbench") return reply(await service.workbench(ctx));
    if (route === "/access-inbox") return reply(await service.accessInbox(ctx));
    if (route === "/handoffs") return reply(await service.handoffInbox(ctx));
    if (route === "/review-inbox") return reply(await service.reviewInbox(ctx));
    const page = route.match(/^\/pages\/([^/]+)\/(history|eligible-owners)$/);
    if (page)
      return reply(
        page[2] === "history"
          ? await service.history(ctx, page[1])
          : await service.eligibleOwners(ctx, page[1]),
      );
    const batch = route.match(
      /^\/changesets\/([^/]+)\/(eligible-reviewers|history)$/,
    );
    if (batch)
      return reply(
        batch[2] === "history"
          ? await service.reviewHistory(ctx, batch[1])
          : await service.eligibleReviewers(ctx, batch[1]),
      );
  }
  if (method !== "POST") return false;
  if (route === "/type-policy")
    return reply(await service.setTypePolicy(ctx, body));
  if (route === "/access-requests")
    return reply(await service.requestAccess(ctx, body), 202);
  const page = route.match(/^\/pages\/([^/]+)\/owner$/);
  if (page) return reply(await service.assignBusinessOwner(ctx, page[1], body));
  const request = route.match(/^\/access-requests\/([^/]+)\/decision$/);
  if (request) return reply(await service.decideAccess(ctx, request[1], body));
  const batch = route.match(/^\/changesets\/([^/]+)\/assignment$/);
  if (batch) return reply(await service.assignReview(ctx, batch[1], body));
  return false;
}
