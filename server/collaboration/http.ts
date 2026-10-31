import { z } from "zod";
import type { Context } from "../service";
import type { CollaborationService } from "./service";
/** Host supplies authenticated immutable identity, space/body/CSRF checks first. */
export async function handleCollaborationRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: CollaborationService,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input,
    url = new URL(path, "https://router.invalid"),
    base = "/api/v1/collaboration";
  if (!url.pathname.startsWith(base + "/")) return false;
  const route = url.pathname.slice(base.length),
    reply = (data: unknown, status = 200) => {
      send(status, data);
      return true;
    },
    offset = z.coerce
      .number()
      .int()
      .min(0)
      .parse(url.searchParams.get("offset") ?? 0);
  if (method === "GET") {
    if (route === "/preferences") return reply(await service.preferences(ctx));
    if (route === "/notifications")
      return reply(await service.notifications(ctx, offset));
    if (route === "/deliveries")
      return reply(await service.deliveries(ctx, offset));
    if (route === "/review-due")
      return reply(
        await service.reviewInbox(ctx, {
          offset,
          all: url.searchParams.get("all") === "true",
        }),
      );
    if (route === "/digest-preview")
      return reply(
        await service.previewDigest(
          ctx,
          z
            .enum(["daily", "weekly"])
            .parse(url.searchParams.get("cadence") ?? "daily"),
        ),
      );
  }
  if (method === "POST") {
    if (route === "/preferences")
      return reply(await service.preferences(ctx, body));
    if (route === "/review-cadence")
      return reply(await service.configureReviewCadence(ctx, body));
    const ack = route.match(/^\/notifications\/([^/]+)\/read$/);
    if (ack) {
      z.object({}).strict().parse(body);
      return reply(await service.ackNotification(ctx, ack[1]));
    }
    const retry = route.match(/^\/deliveries\/([^/]+)\/retry$/);
    if (retry) {
      z.object({}).strict().parse(body);
      return reply(await service.retryDelivery(ctx, retry[1]), 202);
    }
    const work = route.match(/^\/review-due\/([^/]+)\/acknowledge$/);
    if (work) {
      const p = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(body);
      return reply(
        await service.acknowledgeReview(ctx, work[1], p.expectedRevision),
      );
    }
  }
  return false;
}
