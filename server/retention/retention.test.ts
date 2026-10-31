import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { ContentRetentionService } from "./service";
import { draftRetirementId } from "./drafts";
import { transaction } from "../database";
import { replayRetentionTombstones } from "./drafts";
import { OperationsService } from "../operations/service";
import { previewErasure, executeErasure } from "../operations/erasure";
import { randomUUID } from "node:crypto";
import { captureRecoveryLedger, readRecoveryLedger } from "../operations/recovery";
let f: Awaited<ReturnType<typeof fixture>>,
  service: ContentRetentionService,
  workflows: WorkflowService;
let now: number;
const input = {
  id: "old-draft",
  expectedRevision: 0,
  title: "초안",
  content: "보관할 미완성 작업",
  pageId: "topic",
  baseVersion: 1,
};
const policy = {
  enabled: true,
  drafts: 1,
  publishedVersions: null,
  sourceVersions: null,
  runtimeResults: null,
};
const admin = () => ({ ...f.editor, principalId: "fixture-owner" });
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  now = Date.now();
  // Explicit Owner still has to be a member, not a fabricated worker identity.
  await f.pool.query(
    "INSERT INTO memberships VALUES($1,'fixture-owner','editor') ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  service = new ContentRetentionService(f.pool, authorizeInTransaction, {
    clock: () => now,
    workerGuard: async () => true,
    serviceName: "host-retention",
  });
});
afterEach(async () => {
  await f?.pool.end();
});
async function oldDraft() {
  await workflows.saveDraft(f.editor, input);
  await f.pool.query(
    "UPDATE workflow_drafts SET updated_at=$2 WHERE workspace_id=$1",
    [f.workspaceId, new Date(now - 2 * 86400000)],
  );
}
test("default is no automatic deletion; explicit policy CAS, exact preview and durable retirement prevent resurrection", async () => {
  await oldDraft();
  expect(await service.retentionTick(f.workspaceId)).toMatchObject({
    status: "disabled",
  });
  await service.setPolicy(admin(), { expectedRevision: 0, policy });
  const preview = await service.previewRetention(admin());
  expect(preview.counts.eligible).toBe(1);
  const receipt = await service.executeRetention(admin(), {
    previewHash: preview.hash,
    policyRevision: 1,
  });
  expect(receipt.status).toBe("completed");
  expect((await workflows.drafts(f.editor)).items).toHaveLength(0);
  await expect(workflows.saveDraft(f.editor, input)).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(
    (
      await f.pool.query(
        "SELECT artifact_id FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='draft'",
        [f.workspaceId],
      )
    ).rows[0].artifact_id,
  ).toBe(draftRetirementId("editor", input.id));
});
test("retained publication source and ALL historical dependencies stay protected; legal holds block drafts", async () => {
  await oldDraft();
  await service.setPolicy(admin(), {
    expectedRevision: 0,
    policy: { ...policy, publishedVersions: 1, sourceVersions: 1 },
  });
  await service.setHold(admin(), {
    contentClass: "drafts",
    enabled: true,
    reason: "소송 보존",
    expectedPolicyRevision: 1,
  });
  const preview = await service.previewRetention(admin());
  expect(preview.records.find((r) => r.kind === "drafts")?.reasons).toContain(
    "LEGAL_HOLD",
  );
  expect(
    preview.records
      .find((r) => r.kind === "sourceVersions")
      ?.retainedBy.some((r) => r.table === "versions"),
  ).toBe(true);
  expect(preview.counts.eligible).toBe(0);
  expect(
    (
      await service.executeRetention(admin(), {
        previewHash: preview.hash,
        policyRevision: 1,
      })
    ).status,
  ).toBe("blocked");
});
test("late jobs/references and policy races invalidate execution; append-only refinement is never ordinary retention", async () => {
  await oldDraft();
  await service.setPolicy(admin(), { expectedRevision: 0, policy });
  const preview = await service.previewRetention(admin());
  await f.pool.query(
    "INSERT INTO workflow_events VALUES($1,'late-job','editor','job.reference','topic',$2,now())",
    [f.workspaceId, { draftId: input.id }],
  );
  await expect(
    service.executeRetention(admin(), {
      previewHash: preview.hash,
      policyRevision: 1,
    }),
  ).rejects.toThrow("RETENTION_PREVIEW_STALE");
  const next = await service.previewRetention(admin());
  expect(next.records.find((r) => r.kind === "drafts")?.reasons).toContain(
    "RETAINED_REFERENCE",
  );
  expect((await workflows.drafts(f.editor)).items).toHaveLength(1);
  await service.setPolicy(admin(), {
    expectedRevision: 1,
    policy: { ...policy, enabled: false },
  });
  await expect(
    service.executeRetention(admin(), {
      previewHash: next.hash,
      policyRevision: 1,
    }),
  ).rejects.toThrow("STALE_VERSION");
});
test("atomic rollback keeps every draft and tombstone on deletion failure, and records failed receipt", async () => {
  await oldDraft();
  await workflows.saveDraft(f.editor, { ...input, id: "second-draft" });
  await f.pool.query(
    "UPDATE workflow_drafts SET updated_at=$2 WHERE workspace_id=$1",
    [f.workspaceId, new Date(now - 2 * 86400000)],
  );
  await service.setPolicy(admin(), { expectedRevision: 0, policy });
  const preview = await service.previewRetention(admin());
  await f.pool.query(
    "CREATE FUNCTION retention_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='second-draft' THEN RAISE EXCEPTION 'fixture deletion failed'; END IF; RETURN OLD; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER retention_failure_fixture BEFORE DELETE ON workflow_drafts FOR EACH ROW EXECUTE FUNCTION retention_failure_fixture()",
  );
  try {
    await expect(
      service.executeRetention(admin(), {
        previewHash: preview.hash,
        policyRevision: 1,
      }),
    ).rejects.toThrow("fixture deletion failed");
    expect((await workflows.drafts(f.editor)).items).toHaveLength(2);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='draft'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    expect((await service.receipts(admin())).items[0].status).toBe("failed");
  } finally {
    await f.pool.query(
      "DROP TRIGGER retention_failure_fixture ON workflow_drafts",
    );
    await f.pool.query("DROP FUNCTION retention_failure_fixture()");
  }
});
test("signed operational artifact ledger prevents an old restored draft from resurfacing and replay removes its plaintext", async () => {
  await oldDraft();
  const historical = (
    await f.pool.query("SELECT * FROM workflow_drafts WHERE workspace_id=$1", [
      f.workspaceId,
    ])
  ).rows[0];
  await service.setPolicy(admin(), { expectedRevision: 0, policy });
  await service.retentionTick(f.workspaceId);
  const encryption = "fixture-retention-encryption".repeat(3), signing = "fixture-independent-signing".repeat(3);
  const ledger = readRecoveryLedger(await captureRecoveryLedger(f.pool, encryption, signing), encryption, signing);
  expect(ledger.erasedArtifacts?.some(a => a.workspace_id === f.workspaceId && a.artifact_kind === "draft" && a.artifact_id === draftRetirementId("editor", input.id))).toBe(true);
  // Simulate an older backup row plus current independently imported tombstone.
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data,updated_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      f.workspaceId,
      historical.owner_id,
      historical.id,
      historical.revision,
      historical.data,
      historical.updated_at,
    ],
  );
  expect((await workflows.drafts(f.editor)).items).toHaveLength(0);
  await expect(
    workflows.saveDraft(f.editor, { ...input, expectedRevision: 1 }),
  ).rejects.toThrow("NOT_FOUND");
  await transaction(f.pool, f.workspaceId, (db) =>
    replayRetentionTombstones(db, f.workspaceId),
  );
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM workflow_drafts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
});
test("separately approved lawful erasure discovers autosave revision/idempotency copies in the shared operations graph", async () => {
  const secret = "RECOVERY_LAWFUL_ERASURE_FIXTURE_107";
  await workflows.saveDraft(f.editor, {
    ...input,
    content: secret,
    mutationId: randomUUID(),
  });
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const ops = new OperationsService(f.pool, authorizeInTransaction);
  const request = {
    scope: "resource",
    resource: { kind: "source", id: "source-a" },
  };
  const preview = await previewErasure(ops, admin(), request);
  expect(preview.counts.workflow_draft_revision_history).toBe(1);
  expect(preview.counts.workflow_draft_save_mutations).toBe(1);
  await executeErasure(ops, admin(), {
    ...request,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  for (const table of [
    "workflow_drafts",
    "workflow_draft_revision_history",
    "workflow_draft_save_mutations",
  ])
    expect(
      JSON.stringify(
        (
          await f.pool.query(
            `SELECT to_jsonb(t) FROM ${table} t WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
});
