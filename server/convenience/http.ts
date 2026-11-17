import type { HomeService } from "./home";
import { homeWidgets } from "./home";
import { z } from "zod";
import type { Context } from "../service";
import type { PersonalLibraryService } from "./personal";
export async function handlePersonalRoute(
  input: {
    method: string;
    path: string;
    query?: URLSearchParams;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: PersonalLibraryService,
): Promise<boolean> {
  const { method, path, ctx, send } = input;
  const list = path.match(
    /^\/api\/v1\/workflows\/(favorites|recent|subscriptions)$/,
  );
  if (method === "GET" && list) {
    const raw = Object.fromEntries(input.query ?? new URLSearchParams());
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(25).optional(),
        cursor: z.string().max(4096).optional(),
      })
      .strict()
      .parse(raw);
    send(
      200,
      await service.list(ctx, {
        kind: list[1] as "favorites" | "recent" | "subscriptions",
        ...q,
      }),
    );
    return true;
  }
  const state = path.match(
    /^\/api\/v1\/workflows\/pages\/([a-zA-Z0-9_-]{1,100})\/personal-state$/,
  );
  if (method === "GET" && state) {
    send(200, await service.documentState(ctx, state[1]));
    return true;
  }
  if (method === "POST" && path === "/api/v1/workflows/favorites/move") {
    send(200, await service.moveFavorite(ctx, input.body));
    return true;
  }
  if (method === "POST" && path === "/api/v1/workflows/favorites/reorder") {
    send(200, await service.reorderFavorites(ctx, input.body));
    return true;
  }
  return false;
}

/** Authenticated read-only adapter; query cannot override actor/space. */
export async function handleHomeRoute(
  input: {
    method: string;
    path: string;
    query?: URLSearchParams;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: HomeService,
): Promise<boolean> {
  if (input.method !== "GET" || input.path !== "/api/v1/convenience/home")
    return false;
  const params = input.query ?? new URLSearchParams();
  if ([...params.keys()].some((k) => params.getAll(k).length > 1))
    throw Error("VALIDATION_FAILED");
  const q = z
    .object({
      widget: z.enum(homeWidgets).optional(),
      cursor: z.string().max(4096).optional(),
    })
    .strict()
    .parse(Object.fromEntries(params));
  if (q.cursor && !q.widget) throw Error("VALIDATION_FAILED");
  input.send(
    200,
    q.widget
      ? await service.widget(input.ctx, q.widget, q.cursor)
      : await service.read(input.ctx),
  );
  return true;
}

export async function handleStructureRoute(
  input: {
    method: string;
    path: string;
    query?: URLSearchParams;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: import("./structure").DocumentStructureService,
): Promise<boolean> {
  const { method, path, ctx, send } = input;
  if (method === "GET" && path === "/api/v1/convenience/tree") {
    const params = input.query ?? new URLSearchParams();
    if ([...params.keys()].some((k) => params.getAll(k).length > 1))
      throw Error("VALIDATION_FAILED");
    const q = z
      .object({
        parentId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,100}$/)
          .optional(),
        cursor: z.string().max(4096).optional(),
        limit: z.coerce.number().int().min(1).max(25).optional(),
      })
      .strict()
      .parse(Object.fromEntries(params));
    send(200, await service.children(ctx, q));
    return true;
  }
  const pathMatch = path.match(
    /^\/api\/v1\/convenience\/pages\/([a-zA-Z0-9_-]{1,100})\/path$/,
  );
  if (method === "GET" && pathMatch) {
    if (input.query?.size) throw Error("VALIDATION_FAILED");
    send(200, await service.path(ctx, pathMatch[1]));
    return true;
  }
  if (method === "POST" && path === "/api/v1/convenience/pages/move") {
    send(200, await service.move(ctx, input.body));
    return true;
  }
  if (method === "POST" && path === "/api/v1/convenience/pages/duplicate") {
    send(200, await service.duplicateToDraft(ctx, input.body));
    return true;
  }
  return false;
}
