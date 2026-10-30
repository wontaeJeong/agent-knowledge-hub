import { it, expect } from "vitest";
import { handleRefinementRoute } from "./http";
import type { RefinementService } from "./service";
it("forwards targeted import and opaque continuation under host ctx, never a body identity", async () => {
  const calls: unknown[] = [];
  const service = {
    importAgentSignals: async (...args: unknown[]) => {
      calls.push(args);
      return { imported: [], acknowledged: [], nextCursor: null };
    },
  } as unknown as RefinementService;
  const ctx = {
    workspaceId: "selected-workspace",
    principalId: "actual-caller",
  };
  await handleRefinementRoute(
    {
      method: "POST",
      path: "/api/v1/refinement/import-agent-signals",
      ctx,
      body: { outcomeId: "new-outcome" },
      send: () => {},
    },
    service,
  );
  await handleRefinementRoute(
    {
      method: "POST",
      path: "/api/v1/refinement/import-agent-signals",
      ctx,
      body: { cursor: "opaque-continuation", limit: 25 },
      send: () => {},
    },
    service,
  );
  expect(calls).toEqual([
    [ctx, { outcomeId: "new-outcome" }],
    [ctx, { cursor: "opaque-continuation", limit: 25 }],
  ]);
});
it("pure refinement routes hand typed bodies to authorized service without opening server or implicit fallback", async () => {
  const calls: string[] = [];
  const responses: unknown[] = [];
  const service = Object.fromEntries(
    [
      "addEvidence",
      "addClaim",
      "context",
      "reportOutcome",
      "reviewOutcome",
      "reviewClaim",
      "requests",
      "outcomes",
      "semanticLint",
      "importAgentSignals",
      "sourceSnapshot",
    ].map((name) => [
      name,
      async () => {
        calls.push(name);
        return { kind: name };
      },
    ]),
  ) as unknown as RefinementService;
  const input = {
    ctx: { workspaceId: "w", principalId: "p" },
    body: {},
    send: (status: number, data: unknown) => responses.push({ status, data }),
  };
  for (const [method, path] of [
    ["POST", "evidence"],
    ["POST", "claims"],
    ["POST", "context"],
    ["POST", "outcomes"],
    ["POST", "outcome-reviews"],
    ["POST", "claim-reviews"],
    ["GET", "requests"],
    ["GET", "outcomes"],
    ["POST", "semantic-lint"],
    ["POST", "import-agent-signals"],
    ["POST", "source-snapshot"],
  ])
    expect(
      await handleRefinementRoute(
        { ...input, method: method!, path: `/api/v1/refinement/${path}` },
        service,
      ),
    ).toBe(true);
  expect(calls).toEqual([
    "addEvidence",
    "addClaim",
    "context",
    "reportOutcome",
    "reviewOutcome",
    "reviewClaim",
    "requests",
    "outcomes",
    "semanticLint",
    "importAgentSignals",
    "sourceSnapshot",
  ]);
  expect(
    await handleRefinementRoute(
      { ...input, method: "DELETE", path: "/api/v1/refinement/claims" },
      service,
    ),
  ).toBe(false);
  expect(
    await handleRefinementRoute(
      { ...input, method: "GET", path: "/api/v1/pages" },
      service,
    ),
  ).toBe(false);
  expect(responses).toHaveLength(11);
});
