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
  if (method === "POST" && path === "/api/v1/workflows/favorites/reorder") {
    send(200, await service.reorderFavorites(ctx, input.body));
    return true;
  }
  return false;
}
