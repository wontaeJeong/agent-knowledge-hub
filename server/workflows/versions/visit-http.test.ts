import { expect, test } from "vitest";
import { handleVersionRoute } from "./http";
import type { VersionService } from "./service";
test("exact fixed-version visits require one explicit value and preserve nonvisit readers", async () => {
  const calls: unknown[] = [];
  const service = {
    version: async (...args: unknown[]) => {
      calls.push(args);
      return { pageId: "p", number: 1 };
    },
  } as unknown as VersionService;
  const ctx = { workspaceId: "s", principalId: "server-actor" };
  const open = (query: string) =>
    handleVersionRoute(
      {
        method: "GET",
        path: "/api/v1/versions/pages/p/1",
        body: undefined,
        ctx,
        query: new URLSearchParams(query),
        send: () => {},
      },
      service,
    );
  await open("");
  await open("visit=1");
  expect(calls).toEqual([
    [ctx, "p", 1, { recordVisit: false }],
    [ctx, "p", 1, { recordVisit: true }],
  ]);
  for (const query of ["visit=0", "visit=true", "visit=1&visit=1", "visit="])
    await expect(open(query)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});
