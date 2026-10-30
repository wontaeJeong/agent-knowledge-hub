import { afterEach, describe, it, expect } from "vitest";
import { fixture, adoptFixture, source } from "../test-support";
import { RefinementService } from "./service";
import { digest } from "../publication";
import { claim } from "./fixtures";
import type { WorkflowAuthorizer } from "../workflows/service";
import { authorizeInTransaction } from "../access";

const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
const allow: WorkflowAuthorizer = async () => {};
async function setup(authorize = allow) {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const service = new RefinementService(f.pool, authorize);
  const evidence = {
    id: "e1",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: digest(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: claim.assertedAt,
    verifiedAt: null,
    conditions: claim.conditions,
  };
  return { ...f, service, evidence };
}
const input = () => {
  const { recordedAt: _, recordedBy: __, ...c } = claim;
  return c;
};
describe("durable refinement (actual PostgreSQL)", () => {
  it("uses the production shared authorizer without inventing action names or reader write grants", async () => {
    const f = await setup(authorizeInTransaction);
    await expect(f.service.addEvidence(f.reader, f.evidence)).rejects.toThrow(
      "FORBIDDEN",
    );
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    expect(
      (
        await f.service.context(f.reader, {
          asOf: "2026-03-01T00:00:00Z",
          environment: {},
        })
      ).items,
    ).toHaveLength(1);
    await expect(
      f.service.reviewClaim(f.editor, {
        id: "rv",
        claimIds: ["c1"],
        status: "reviewed",
        evidenceIds: ["e1"],
        reason: "작성자 자기검토",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await f.service.reviewClaim(f.ctx, {
      id: "rv",
      claimIds: ["c1"],
      status: "reviewed",
      evidenceIds: ["e1"],
      reason: "지정 역할의 독립 인간 검토",
    });
  });
  it("KE-01 stores exact source version/location and immutable temporal metadata", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    const c = await f.service.addClaim(f.editor, input());
    expect(c.verifiedAt).toBeNull();
    expect(
      (
        await f.service.context(f.reader, {
          asOf: "2026-03-01T00:00:00Z",
          environment: { os: "linux" },
        })
      ).items[0]!.evidence[0]!.location!.quote,
    ).toBe(source.content);
    await expect(
      f.pool.query(
        "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
        [f.workspaceId],
      ),
    ).rejects.toThrow("REFINEMENT_IMMUTABLE");
    await expect(
      f.service.addClaim(f.editor, { ...input(), value: "changed" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("rejects fake quotes, circular evidence, inference masquerading as execution and invented verification", async () => {
    const f = await setup();
    await expect(
      f.service.addEvidence(f.editor, {
        ...f.evidence,
        location: { start: 0, end: 4, quote: "fake" },
      }),
    ).rejects.toThrow("EVIDENCE_INVALID");
    await expect(
      f.service.addEvidence(f.editor, { ...f.evidence, parentIds: ["e1"] }),
    ).rejects.toThrow("CIRCULAR_EVIDENCE");
    await f.service.addEvidence(f.editor, f.evidence);
    await expect(
      f.service.addEvidence(f.editor, {
        ...f.evidence,
        id: "e2",
        kind: "independent-execution",
        parentIds: ["e1"],
        executionId: "run",
      }),
    ).rejects.toThrow("EVIDENCE_INVALID");
    await expect(
      f.service.addClaim(f.editor, {
        ...input(),
        verifiedAt: claim.assertedAt,
      }),
    ).rejects.toThrow("VERIFICATION_REQUIRES_REVIEW");
  });
  it("KE-02/03/04 stores supersession as a proposal preserving both source chains", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    await f.service.addClaim(f.editor, {
      ...input(),
      id: "c2",
      value: "no",
      supersedes: ["c1"],
    });
    const r = await f.service.context(f.reader, {
      asOf: "2026-03-01T00:00:00Z",
      environment: {},
    });
    expect(r.items).toHaveLength(2);
    expect(r.conflicts[0].kind).toBe("contradiction");
    expect((await f.service.requests(f.reader)).items).toHaveLength(2);
  });
  it("KE-05/08 retry and derived evidence share only one root", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addEvidence(f.editor, f.evidence);
    const d = {
      ...f.evidence,
      id: "e2",
      sourceId: undefined,
      sourceVersion: undefined,
      location: undefined,
      kind: "inference",
      parentIds: ["e1"],
    };
    await f.service.addEvidence(f.editor, d);
    await f.service.addClaim(f.editor, {
      ...input(),
      evidenceIds: ["e1", "e2"],
    });
    const r = await f.service.context(f.reader, {
      asOf: "2026-03-01T00:00:00Z",
      environment: {},
    });
    expect(r.items[0].independentRoots).toHaveLength(1);
    await f.service.addClaim(f.editor, {
      ...input(),
      id: "derived",
      evidenceIds: ["e2"],
    });
    const derived = (
      await f.service.context(f.reader, {
        asOf: "2026-03-01T00:00:00Z",
        environment: {},
      })
    ).items.find((c) => c.id === "derived")!;
    expect(derived.evidence.map((e) => e.id)).toEqual(["e2", "e1"]);
  });
  it("KE-06 success/failure and human validation are distinct, durable review not live edit", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    const outcome = await f.service.reportOutcome(f.editor, {
      id: "o1",
      claimIds: ["c1"],
      usedVersions: [{ pageId: "topic", version: 1 }],
      result: "failure",
      problem: "재시도",
      attempt: "1회 시도",
      observations: "실패",
      conditions: { os: "linux" },
      evidenceIds: ["e1"],
      lesson: "이 환경에서만 재검증",
      limits: "단일 사례; 다른 환경 미검증",
    });
    expect(outcome.humanValidation).toBe("unreviewed");
    expect(
      (await f.service.requests(f.reader)).items.some(
        (r) => r.reason === "outcome",
      ),
    ).toBe(true);
    await f.service.reviewOutcome(f.ctx, {
      id: "rv1",
      outcomeId: "o1",
      status: "confirmed",
      evidenceIds: ["e1"],
      reason: "인간 검토, 독립 실행 아님",
    });
    expect((await f.service.outcomes(f.reader)).items[0].humanValidation).toBe(
      "confirmed",
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM versions WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("KE-07 past context obeys current source ACL and session checks", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    expect(
      (
        await f.service.context(f.reader, {
          asOf: "2026-03-01T00:00:00Z",
          environment: {},
        })
      ).items,
    ).toEqual([]);
    await expect(
      f.service.context(
        {
          ...f.ctx,
          authorization: {
            revalidate: async () => {
              throw Error("SESSION_REVOKED");
            },
            assertSession: async () => {},
          },
        },
        { environment: {} },
      ),
    ).rejects.toThrow("SESSION_REVOKED");
  });
  it("mandatory authorizer runs for every public operation", async () => {
    const f = await setup(async () => {
      throw Error("FORBIDDEN");
    });
    for (const work of [
      () => f.service.addEvidence(f.editor, f.evidence),
      () => f.service.addClaim(f.editor, input()),
      () => f.service.context(f.reader, { environment: {} }),
      () => f.service.requests(f.reader),
      () => f.service.outcomes(f.reader),
    ])
      await expect(work()).rejects.toThrow("FORBIDDEN");
  });
  it("protected facts need a human review capability; semantic lint never overwrites", async () => {
    const f = await setup(async (_db, ctx, action) => {
      if (action === "knowledge.protect" && ctx.principalId !== "reviewer")
        throw Error("FORBIDDEN");
    });
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.ctx, { ...input(), protected: true });
    await expect(
      f.service.addClaim(f.editor, {
        ...input(),
        id: "c2",
        value: "changed",
        supersedes: ["c1"],
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(await f.service.semanticLint(f.reader, { environment: {} })).toEqual(
      { status: "unconfigured", findings: [] },
    );
  });
  it("claim verification is a separate immutable human review with execution evidence, not model self-rating", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    await expect(
      f.service.reviewClaim(f.ctx, {
        id: "v1",
        claimIds: ["c1"],
        status: "execution-verified",
        evidenceIds: ["e1"],
        reason: "검토",
      }),
    ).rejects.toThrow("INDEPENDENT_EXECUTION_REQUIRED");
    await f.service.addEvidence(f.editor, {
      ...f.evidence,
      id: "run-e1",
      kind: "independent-execution",
      executionId: "run-1",
    });
    await f.service.reviewClaim(f.ctx, {
      id: "v1",
      claimIds: ["c1"],
      status: "execution-verified",
      evidenceIds: ["run-e1"],
      reason: "정확한 실행 로그 검토",
    });
    await f.service.reviewClaim(f.ctx, {
      id: "v1",
      claimIds: ["c1"],
      status: "execution-verified",
      evidenceIds: ["run-e1"],
      reason: "정확한 실행 로그 검토",
    });
    const r = await f.service.context(f.reader, {
      asOf: "2026-03-01T00:00:00Z",
      environment: {},
    });
    expect(r.items[0].verifiedAt).toBeNull();
    expect(r.items[0].verificationReviews[0].verifiedAt).toBeTruthy();
    expect(r.items[0].validation).toBe("execution-verified");
    await expect(
      f.service.reviewClaim(
        { ...f.ctx, credentialId: "agent" },
        {
          id: "v2",
          claimIds: ["c1"],
          status: "reviewed",
          evidenceIds: ["e1"],
          reason: "모델",
        },
      ),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
  it("model provider failure/invalid citation produce explicit error, never a fake finding or write", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    const broken = new RefinementService(f.pool, allow, async () => {
      throw Error("private-upstream-error");
    });
    expect(
      await broken.semanticLint(f.editor, {
        asOf: "2026-03-01T00:00:00Z",
        environment: {},
      }),
    ).toEqual({ status: "error", code: "MODEL_FAILED", findings: [] });
    const valid = new RefinementService(f.pool, allow, async ({ claims }) => ({
      findings: [
        {
          kind: "stale",
          claimIds: [claims[0]!.id],
          explanation: "오래됨, 재검토 후보",
          citations: [
            {
              claimId: "c1",
              evidenceId: "e1",
              sourceId: source.id,
              sourceVersion: digest(source),
              quote: source.content,
            },
          ],
        },
      ],
    }));
    expect(
      (
        await valid.semanticLint(f.editor, {
          asOf: "2026-03-01T00:00:00Z",
          environment: {},
        })
      ).status,
    ).toBe("completed");
    expect(
      (await f.service.requests(f.reader)).items.some(
        (r) => r.reason === "semantic-lint",
      ),
    ).toBe(true);
  });
  it("rechecks model input provenance before transmission and after the provider returns", async () => {
    const f = await setup();
    await f.service.addEvidence(f.editor, f.evidence);
    await f.service.addClaim(f.editor, input());
    let calls = 0;
    const guarded = new RefinementService(
      f.pool,
      async (db, ctx, action) => {
        if (action === "lint.run")
          await db.query(
            "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id=$3",
            [ctx.workspaceId, source.id, ctx.principalId],
          );
      },
      async () => {
        calls++;
        return { findings: [] };
      },
    );
    await expect(
      guarded.semanticLint(f.editor, { environment: {} }),
    ).rejects.toThrow("NOT_FOUND");
    expect(calls).toBe(0);
    const after = new RefinementService(f.pool, allow, async () => {
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
        [f.workspaceId, source.id],
      );
      return { findings: [] };
    });
    await expect(
      after.semanticLint(f.editor, { environment: {} }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("consumes Task5 signals once preserving original root lineage, agent uncertainty and current ACL", async () => {
    const f = await setup();
    const data = {
      used_versions: [{ page_id: "topic", version: 1 }],
      result: "failure",
      observations: "에이전트가 실패 주장",
      evidence: [
        { id: source.id, version: 1, location: "quote:" + source.content },
      ],
      idempotency_key: "key",
      verified: false,
      evidenceKind: "agent-observation",
      independentExecution: false,
    };
    await f.pool.query(
      "INSERT INTO agent_outcomes(workspace_id,id,principal_id,result,data) VALUES($1,'ao1','editor','failure',$2)",
      [f.workspaceId, data],
    );
    await f.pool.query(
      "INSERT INTO agent_review_signals(workspace_id,id,page_id,outcome_id) VALUES($1,'sig1','topic','ao1')",
      [f.workspaceId],
    );
    const imported = await f.service.importAgentSignals(f.editor);
    expect(imported.imported).toHaveLength(1);
    expect(
      (await f.service.importAgentSignals(f.editor)).imported,
    ).toHaveLength(0);
    const request = (await f.service.requests(f.reader)).items[0]!;
    expect(request.evidenceKind).toBe("agent-observation");
    expect(request.independentExecution).toBe(false);
    expect(request.verified).toBe(false);
    expect(request.rootLineage).toEqual([
      expect.objectContaining({
        sourceId: source.id,
        sourceVersion: digest(source),
        root: expect.stringMatching(/^source:/),
      }),
    ]);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
      [f.workspaceId, source.id],
    );
    expect((await f.service.requests(f.reader)).items).toHaveLength(0);
    expect(
      (await f.service.importAgentSignals(f.reader)).imported,
    ).toHaveLength(0);
  });
});
