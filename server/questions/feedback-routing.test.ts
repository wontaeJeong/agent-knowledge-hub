import { expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { QuestionsService } from "./service";
import { authorizeActionDb } from "../access/index";
test("real published page version feedback routes current qualified C assignment and never self-verifies", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    const authorization = {
      revalidate: async () => {},
      assertSession: async () => {},
    };
    const reader = { ...f.reader, authorization },
      reviewer = { ...f.ctx, authorization };
    const runtime = new RuntimeService(f.pool);
    const service = new QuestionsService(f.pool, {
      runtime,
      authorize: async (...a) => {
        await authorizeActionDb(...a);
      },
      runQuery: async () => {
        throw Error("RUNTIME_QUESTION_CONTEXT_NOT_WIRED");
      },
    });
    const batch = await runtime.core.propose(
      f.editor,
      [
        {
          id: "topic",
          title: "주제",
          summary: "변경",
          content: "기존 내용 갱신",
          scope: "team",
          links: [],
          facts: [],
          sourceIds: ["source-a"],
          baseVersion: 1,
        },
      ],
      ["source-a"],
    );
    await runtime.core.approve(reviewer, batch.id, batch.hash);
    await runtime.core.publish(
      reviewer,
      batch.id,
      batch.hash,
      "publish-for-feedback",
    );
    await f.pool.query(
      "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO governance_review_assignments(workspace_id,batch_id,revision,batch_hash,assignee_ids,backup_id,deadline) VALUES($1,$2,1,$3,ARRAY['reviewer'],'fixture-owner',clock_timestamp()+interval '1 day')",
      [f.workspaceId, batch.id, batch.hash],
    );
    const answer = await runtime.query(reader, "기존", "offline");
    const report = await service.reportFeedback(reader, {
      answerId: answer.id,
      version: 1,
      nonce: "first",
      category: "citationmissing",
      reason: "인용의 적용 조건을 재검토하세요.",
    });
    expect(report.work).toMatchObject([
      {
        pageId: "topic",
        version: 2,
        recipientIds: ["editor", "reviewer"],
        evidenceKeys: { pageId: "topic", version: 2, citationIndexes: [0] },
      },
    ]);
    const before = (
      await f.pool.query(
        "SELECT count(*) FROM approvals WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count;
    await f.pool.query(
      "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
      [f.workspaceId],
    );
    const revoked = await service.reportFeedback(reader, {
      answerId: answer.id,
      version: 1,
      nonce: "second",
      category: "incorrect",
      reason: "재검토 요청은 실행 검증이 아닙니다.",
    });
    expect(revoked.work[0].recipientIds).toEqual(["editor"]);
    expect(revoked.verified).toBe(false);
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM approvals WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe(before);
  } finally {
    await f.pool.end();
  }
});
