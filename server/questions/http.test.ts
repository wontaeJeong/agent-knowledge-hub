import { expect, test } from "vitest";
import { handleQuestionRoute } from "./http";
import type { QuestionsService } from "./service";
test("question route preserves queue acceptance and never accepts another principal from public DTO", async () => {
  const calls: unknown[] = [];
  const ctx = { workspaceId: "space", principalId: "server-user" };
  const service = {
    submitTurn: async (...args: unknown[]) => {
      calls.push(args);
      return { id: "actual-job", status: "queued" };
    },
  } as unknown as QuestionsService;
  let response: unknown;
  expect(
    await handleQuestionRoute(
      {
        method: "POST",
        path: "/api/v1/questions/threads/thread-a/turns",
        ctx,
        body: {
          question: "q",
          expectedRevision: 0,
          nonce: "once",
          mode: "model",
        },
        send: (status, data) => {
          response = { status, data };
        },
      },
      service,
    ),
  ).toBe(true);
  expect(response).toEqual({
    status: 202,
    data: { id: "actual-job", status: "queued" },
  });
  expect(calls).toEqual([
    [
      ctx,
      "thread-a",
      { question: "q", expectedRevision: 0, nonce: "once", mode: "model" },
    ],
  ]);
  expect(
    await handleQuestionRoute(
      {
        method: "POST",
        path: "/api/v1/unrelated",
        ctx,
        body: {},
        send: () => {
          throw Error("wrong handler");
        },
      },
      service,
    ),
  ).toBe(false);
});
