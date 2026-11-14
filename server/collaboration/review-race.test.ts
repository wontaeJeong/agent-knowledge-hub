import { test, expect } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { CollaborationService, resolveGovernanceResponsibility } from "./index";
test("source revocation between reviewer selection and commit cannot create an assignment", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  let checks = 0;
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async (db) => {
        if (++checks === 4)
          await db.query(
            "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
            [f.workspaceId],
          );
      },
      verifyRecipient: async ({ workspaceId, principalId }) => {
        const verifiedAt = new Date();
        return {
          ctx: { workspaceId, principalId },
          address: null,
          issuer: "fixture",
          subject: principalId,
          verifiedAt: verifiedAt.toISOString(),
          validUntil: new Date(verifiedAt.getTime() + 30000).toISOString(),
          assertCurrent: async () => {},
        };
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  try {
    await f.pool.query(
      "UPDATE access_grants SET role='maintain' WHERE workspace_id=$1 AND principal_id='editor'",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO access_reviewers(workspace_id,principal_id) VALUES($1,'editor') ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"reviewDue\":\"2020-01-01T00:00:00Z\"}')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reader')",
      [f.workspaceId],
    );
    await expect(service.scanReviews()).rejects.toThrow();
    expect(
      (
        await f.pool.query(
          "SELECT id FROM collaboration_review_due_work WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.end();
  }
});
test("a readable editor without review authorization cannot receive review work", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async ({ workspaceId, principalId }) => {
        const verifiedAt = new Date();
        return {
          ctx: { workspaceId, principalId },
          address: null,
          issuer: "fixture",
          subject: principalId,
          verifiedAt: verifiedAt.toISOString(),
          validUntil: new Date(verifiedAt.getTime() + 30000).toISOString(),
          assertCurrent: async () => {},
        };
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  try {
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"reviewDue\":\"2020-01-01T00:00:00Z\"}')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
      [f.workspaceId],
    );
    await service.scanReviews();
    const rows = (
      await f.pool.query(
        "SELECT assigned_id FROM collaboration_review_due_work WHERE workspace_id=$1 AND status='needs-review'",
        [f.workspaceId],
      )
    ).rows;
    expect(rows).toEqual([{ assigned_id: "reviewer" }]);
    expect((await service.notifications(f.ctx)).items).toHaveLength(1);
    await f.pool.query(
      "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect((await service.reviewInbox(f.ctx)).items).toEqual([]);
    expect((await service.notifications(f.ctx)).items).toEqual([]);
  } finally {
    await f.pool.end();
  }
});
test("official standard review assignment honors the official reviewer rule", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async ({ workspaceId, principalId }) => {
        const verifiedAt = new Date();
        return {
          ctx: { workspaceId, principalId },
          address: null,
          issuer: "fixture",
          subject: principalId,
          verifiedAt: verifiedAt.toISOString(),
          validUntil: new Date(verifiedAt.getTime() + 20000).toISOString(),
          assertCurrent: async () => {},
        };
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  try {
    await f.pool.query(
      "UPDATE pages SET data=jsonb_set(data,'{status}',to_jsonb('공식 기준'::text)) WHERE workspace_id=$1 AND id='topic'",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"reviewDue\":\"2020-01-01T00:00:00Z\"}')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'reviewer','editor')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO access_review_rules(workspace_id,document_type,minimum_approvals,reviewer_ids) VALUES($1,'official-standard',1,ARRAY['fixture-owner'])",
      [f.workspaceId],
    );
    await service.scanReviews();
    expect(
      (
        await f.pool.query(
          "SELECT assigned_id,status FROM collaboration_review_due_work WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ assigned_id: null, status: "needs-assignment" }]);
  } finally {
    await f.pool.end();
  }
});
