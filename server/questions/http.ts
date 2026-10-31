import type { Context } from "../service";
import type { QuestionsService } from "./service";
/** Pure routing adapter. Authentication/qualified authorization is mandatory in the service. */
export async function handleQuestionRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  service: QuestionsService,
): Promise<boolean> {
  const { method, body, ctx, send } = input;
  const url = new URL(input.path, "http://questions.invalid");
  const root = "/api/v1/questions";
  if (!url.pathname.startsWith(root + "/")) return false;
  const route = url.pathname.slice(root.length);
  const reply = (data: unknown, status = 200) => {
    send(status, data);
    return true;
  };
  const page = () => ({
    ...(url.searchParams.has("cursor")
      ? { cursor: url.searchParams.get("cursor")! }
      : {}),
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : 25,
  });
  if (method === "GET") {
    if (route === "/threads")
      return reply(await service.listThreads(ctx, page()));
    if (route === "/feedback")
      return reply(await service.feedback(ctx, page()));
    const thread = route.match(
      /^\/threads\/([a-zA-Z0-9_-]{1,100})(?:\/(title))?$/,
    );
    if (thread) {
      const result = await service.readThread(ctx, thread[1]);
      return reply(
        thread[2]
          ? { id: result.id, title: result.title, revision: result.revision }
          : result,
      );
    }
  }
  if (method === "POST") {
    if (route === "/threads")
      return reply(await service.createThread(ctx), 201);
    if (route === "/search") return reply(await service.search(ctx, body));
    if (route === "/feedback")
      return reply(await service.reportFeedback(ctx, body), 201);
    const turn = route.match(/^\/threads\/([a-zA-Z0-9_-]{1,100})\/turns$/);
    if (turn) return reply(await service.submitTurn(ctx, turn[1], body), 202);
    const resume = route.match(
      /^\/threads\/([a-zA-Z0-9_-]{1,100})\/turns\/([a-zA-Z0-9_-]{1,100})\/resume$/,
    );
    if (resume)
      return reply(await service.resumeTurn(ctx, resume[1], resume[2]), 202);
  }
  return false;
}
