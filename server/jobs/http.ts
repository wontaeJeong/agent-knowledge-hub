import { z } from "zod";
import type { Context } from "../service";
import type { JobService } from "./service";

/** Host MUST authenticate selected space and enforce CSRF/body bounds first.
 * This router is transport-free; never accepts caller identity/roles in body. */
export async function handleJobRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: JobService,
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  const url = new URL(path, "http://router.invalid"),
    base = "/api/v1/jobs-v2";
  if (url.pathname !== base && !url.pathname.startsWith(base + "/"))
    return false;
  const route = url.pathname.slice(base.length),
    reply = (data: unknown, status = 200) => {
      send(status, data);
      return true;
    };
  if (method === "GET") {
    if (!route || route === "/")
      return reply(
        await service.list(
          ctx,
          z.coerce
            .number()
            .int()
            .min(0)
            .parse(url.searchParams.get("offset") ?? 0),
          z
            .enum(["own", "workspace"])
            .parse(url.searchParams.get("scope") ?? "own"),
        ),
      );
    if (route === "/schedules") return reply(await service.schedules(ctx));
    if (route === "/budgets") return reply(await service.budgets(ctx));
    if (route === "/stops") return reply(await service.stops(ctx));
    const preview = route.match(/^\/schedules\/([^/]+)\/preview$/);
    if (preview) return reply(await service.previewSchedule(ctx, preview[1]));
    const job = route.match(/^\/([^/]+)(?:\/(telemetry))?$/);
    if (job)
      return reply(
        job[2]
          ? await service.telemetry(ctx, job[1])
          : await service.get(ctx, job[1]),
      );
  }
  if (method === "POST") {
    if (!route || route === "/")
      return reply(await service.enqueue(ctx, body), 202);
    if (route === "/schedules")
      return reply(await service.saveSchedule(ctx, body), 201);
    if (route === "/budgets") return reply(await service.setBudget(ctx, body));
    if (route === "/stops") return reply(await service.setStop(ctx, body));
    const schedule = route.match(/^\/schedules\/([^/]+)\/(run|enabled)$/);
    if (schedule) {
      if (schedule[2] === "run") {
        const d = z
          .object({ key: z.string().min(1).max(100) })
          .strict()
          .parse(body);
        return reply(await service.runSchedule(ctx, schedule[1], d.key), 202);
      }
      const d = z.object({ enabled: z.boolean() }).strict().parse(body);
      return reply(await service.enableSchedule(ctx, schedule[1], d.enabled));
    }
    const job = route.match(/^\/([^/]+)\/(cancel|pause|retry)$/);
    if (job) {
      if (job[2] === "cancel") {
        z.object({}).strict().parse(body);
        return reply(await service.cancel(ctx, job[1]));
      }
      if (job[2] === "retry") {
        z.object({}).strict().parse(body);
        return reply(await service.retry(ctx, job[1]), 202);
      }
      const d = z.object({ paused: z.boolean() }).strict().parse(body);
      return reply(await service.pause(ctx, job[1], d.paused));
    }
  }
  return false;
}
