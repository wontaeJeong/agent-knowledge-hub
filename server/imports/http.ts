import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { Context } from "../service";
import type { ImportService } from "./service";

export async function handleImportRequest(
  service: ImportService,
  ctx: Context,
  method: string,
  path: string,
  body: unknown,
  headers: IncomingHttpHeaders,
  search = new URLSearchParams(),
) {
  const send = (status: number, value: unknown) => ({ status, body: value });
  const key = () =>
    z.string().min(1).max(100).parse(headers["idempotency-key"]);
  if (path === "/api/v1/imports/config" && method === "GET")
    return send(200, await service.config(ctx));
  if (path === "/api/v1/imports" && method === "GET")
    return send(200, { items: await service.list(ctx) });
  if (path === "/api/v1/imports" && method === "POST")
    return send(201, await service.create(ctx, body, key()));
  if (path === "/api/v1/import-disclosures" && method === "GET")
    return send(200, { items: await service.disclosureList(ctx) });
  const match = path.match(
    /^\/api\/v1\/imports\/([a-zA-Z0-9_-]{1,100})(?:\/(finalize|selection|runs))?$/,
  );
  if (match) {
    const [, id, action] = match;
    if (method === "DELETE" && !action) {
      z.object({}).strict().parse(body);
      return send(200, await service.remove(ctx, id));
    }
    if (method === "GET" && !action)
      return send(
        200,
        await service.view(ctx, id, Number(search.get("offset") || 0)),
      );
    if (method === "POST" && action === "finalize") {
      z.object({}).strict().parse(body);
      return send(202, await service.finalize(ctx, id, key()));
    }
    if (method === "PATCH" && action === "selection") {
      const revision = z.coerce
        .number()
        .int()
        .positive()
        .parse(headers["if-match"]);
      return send(200, await service.select(ctx, id, revision, body));
    }
    if (method === "POST" && action === "runs")
      return send(202, await service.start(ctx, id, body, key()));
  }
  const part = path.match(
    /^\/api\/v1\/imports\/([a-zA-Z0-9_-]{1,100})\/files\/([a-zA-Z0-9_-]{1,100})\/parts\/(\d+)$/,
  );
  if (part && method === "POST")
    return send(
      200,
      await service.uploadPart(ctx, part[1], part[2], Number(part[3]), body),
    );
  const run = path.match(
    /^\/api\/v1\/import-runs\/([a-zA-Z0-9_-]{1,100})(?:\/(cancel|resume|disclosure|approve-disclosure|save-personal))?$/,
  );
  if (run) {
    const [, id, action] = run;
    if (method === "POST" && action === "save-personal") {
      z.object({}).strict().parse(body);
      return send(200, await service.savePersonal(ctx, id));
    }
    if (method === "GET" && !action)
      return send(200, await service.runViewFor(ctx, id));
    if (method === "POST" && (action === "cancel" || action === "resume")) {
      z.object({}).strict().parse(body);
      return send(
        action === "cancel" ? 200 : 202,
        await service[action](ctx, id),
      );
    }
    if (method === "POST" && action === "disclosure")
      return send(201, await service.requestDisclosure(ctx, id, body));
    if (method === "POST" && action === "approve-disclosure") {
      const input = z
        .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(body);
      return send(201, await service.approveDisclosure(ctx, id, input.hash));
    }
  }
  return null;
}
