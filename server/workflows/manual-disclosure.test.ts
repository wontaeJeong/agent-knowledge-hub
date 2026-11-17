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
