import { it, expect } from "vitest";
import { handleRefinementRoute } from "./http";
import type { RefinementService } from "./service";
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
