import { beforeEach, afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "./service";
import { RuntimeService } from "../runtime/knowledge";
import { handleWorkflowRoute } from "./http";
let f: Awaited<ReturnType<typeof fixture>>, s: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  s = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  await s.saveDraft(f.editor, {
    id: "private",
    expectedRevision: 0,
    title: "원본",
    content: "고정 비공개 본문",
  });
});
afterEach(async () => {
  await f?.pool.end();
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
});
async function call(
  ctx: typeof f.editor,
  path: string,
  body?: unknown,
): Promise<any> {
  let result: unknown;
  expect(
    await handleWorkflowRoute(
      {
        ctx,
        path: "/api/v1/workflows" + path,
        method: body === undefined ? "GET" : "POST",
        body,
        send: (_s, d) => {
          result = d;
        },
      },
      s,
    ),
    "manual disclosure endpoint",
  ).toBe(true);
  return result;
}
const input = () => ({
  expectedRevision: 1,
  title: "원본",
  parentId: null,
  readers: ["editor", "reviewer"],
  reviewerId: "reviewer",
  reason: "공유",
  mutationId: randomUUID(),
});
test("assigned reviewer sees only the frozen requested snapshot, never generic private drafts", async () => {
  const d = await call(f.editor, "/drafts/private/disclosure", input());
  const list = await call(f.ctx, "/draft-disclosures");
  expect(list.items[0]).toMatchObject({
    id: d.id,
    content: "고정 비공개 본문",
    status: "pending",
  });
  expect((await s.drafts(f.ctx)).items).toHaveLength(0);
  expect((await call(f.reader, "/draft-disclosures")).items).toHaveLength(0);
});
test("rejection and client personal-mode claims never create a source or proposal", async () => {
  await expect(
    call(f.editor, "/drafts/private/disclosure", {
      ...input(),
      policyMode: "personal",
    }),
  ).rejects.toThrow();
  const d = await call(f.editor, "/drafts/private/disclosure", input());
  await expect(
    call(f.editor, `/draft-disclosures/${d.id}/decision`, {
      hash: d.hash,
      decision: "approve",
      reason: "자기 승인",
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow();
  await call(f.ctx, `/draft-disclosures/${d.id}/decision`, {
    hash: d.hash,
    decision: "reject",
    reason: "수정 필요",
    mutationId: randomUUID(),
  });
  expect((await call(f.editor, "/draft-disclosures")).items[0].status).toBe(
    "rejected",
  );
  expect(
    (
      await f.pool.query("SELECT 1 FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("request and rejection reasons survive restart and exact idempotent replay for only authorized participants", async () => {
  const requestInput = {
    ...input(),
    reason: "운영 절차를 팀에서 검증해야 합니다",
  };
  const d = await call(f.editor, "/drafts/private/disclosure", requestInput);
  const { ManualDraftDisclosureService } = await import("./manual-disclosure");
  const restarted = new ManualDraftDisclosureService(s);
  for (const ctx of [f.editor, f.ctx])
    expect((await restarted.list(ctx)).items[0]).toMatchObject({
      requestReason: requestInput.reason,
    });
  expect(await restarted.request(f.editor, "private", requestInput)).toEqual(d);
  await expect(
    restarted.request(f.editor, "private", {
      ...requestInput,
      reason: "다른 사유",
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  const decision = {
    hash: d.hash,
    decision: "reject",
    reason: "롤백 담당자와 확인 절차를 보완해 주세요",
    mutationId: randomUUID(),
  };
  const decided = await restarted.decide(f.ctx, d.id, decision);
  expect(await restarted.decide(f.ctx, d.id, decision)).toEqual(decided);
  await expect(
    restarted.decide(f.ctx, d.id, { ...decision, reason: "다른 결정 사유" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  for (const ctx of [f.editor, f.ctx])
    expect(
      (await new ManualDraftDisclosureService(s).list(ctx)).items[0],
    ).toMatchObject({
      requestReason: requestInput.reason,
      decision: {
        decision: "reject",
        reason: decision.reason,
        principalId: "reviewer",
      },
    });
  expect((await restarted.list(f.reader)).items).toHaveLength(0);
  await s.deleteDraft(f.editor, "private", 1);
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT snapshot,decisions FROM workflow_draft_disclosures WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ),
  ).not.toContain(decision.reason);
});
test("revoked snapshots are hidden but unexpected policy and program failures are surfaced", async () => {
  await s.saveDraft(f.editor, {
    id: "private",
    expectedRevision: 1,
    title: "원본",
    content: "고정 비공개 본문",
    sourceIds: ["source-a"],
  });
  await call(f.editor, "/drafts/private/disclosure", {
    ...input(),
    expectedRevision: 2,
  });
  const { ManualDraftDisclosureService } = await import("./manual-disclosure");
  const service = new ManualDraftDisclosureService(s);
  const { vi } = await import("vitest");
  for (const error of [
    new Error("POLICY_UNAVAILABLE"),
    new Error("database dependency failed"),
    new TypeError("invalid policy shape"),
  ]) {
    const mock = vi.spyOn(service, "current").mockRejectedValueOnce(error);
    try {
      await expect(service.list(f.editor)).rejects.toThrow(error.message);
    } finally {
      mock.mockRestore();
    }
  }
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await service.list(f.editor)).items).toHaveLength(0);
});
