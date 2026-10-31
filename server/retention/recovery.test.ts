import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture, source } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { DraftRecoveryService } from "./recovery";
let f: Awaited<ReturnType<typeof fixture>>;
let service: DraftRecoveryService, workflows: WorkflowService;
let now: number;
const draft = {
  id: "private",
  pageId: "topic",
  baseVersion: 1,
  expectedRevision: 0,
  title: "제목",
  content: "미전송 본문",
};
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  now = Date.now();
  workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  service = new DraftRecoveryService(f.pool, () => now);
});
afterEach(async () => {
  await f?.pool.end();
});
async function permit() {
  await f.pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",
    [f.workspaceId],
  );
}
test("read/write and space Owner are not local-copy approval; explicit local.copy alone suffices without export", async () => {
  await expect(service.permission(f.editor, draft)).rejects.toThrow(
    "FORBIDDEN",
  );
  await permit();
  const grant = await service.permission(f.editor, draft);
  expect(grant.expiresAt).toBe(now + 300000);
  expect(grant.principalId).toBe(f.editor.principalId);
  expect(await service.validate(f.editor, { binding: grant })).toMatchObject({
    status: "ready",
    revision: 0,
  });
});
test("expiry, different identity, changed policy, revoked ancestry and page divergence all fail closed", async () => {
  await permit();
  const grant = await service.permission(f.editor, draft);
  await expect(
    service.validate(f.reader, { binding: grant }),
  ).rejects.toThrow();
  await expect(
    service.validate(
      { ...f.editor, workspaceId: "missing" },
      { binding: grant },
    ),
  ).rejects.toThrow();
  now += 300001;
  await expect(service.validate(f.editor, { binding: grant })).rejects.toThrow(
    "RECOVERY_EXPIRED",
  );
  now -= 300001;
  await f.pool.query(
    "UPDATE access_source_policy SET local_copy_allowed=false,revision=revision+1 WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(service.validate(f.editor, { binding: grant })).rejects.toThrow(
    "FORBIDDEN",
  );
  await f.pool.query(
    "UPDATE access_source_policy SET local_copy_allowed=true,revision=revision+1 WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(service.validate(f.editor, { binding: grant })).rejects.toThrow(
    "RECOVERY_POLICY_CHANGED",
  );
});
test("idempotent lost acknowledgement does not overwrite a later winner, and explicit new CAS preserves revisions", async () => {
  const mutationId = randomUUID();
  const first = await workflows.saveDraft(f.editor, { ...draft, mutationId });
  await workflows.saveDraft(f.editor, {
    ...draft,
    expectedRevision: 1,
    content: "別タブの勝者",
    mutationId: randomUUID(),
  });
  expect(
    (await workflows.saveDraft(f.editor, { ...draft, mutationId })).revision,
  ).toBe(first.revision);
  await expect(
    workflows.saveDraft(f.editor, { ...draft, mutationId: randomUUID() }),
  ).rejects.toThrow("STALE_VERSION");
  expect((await workflows.drafts(f.editor)).items[0].content).toBe(
    "別タブの勝者",
  );
  await workflows.saveDraft(f.editor, {
    ...draft,
    expectedRevision: 2,
    content: "명시적으로 병합한 본문",
    mutationId: randomUUID(),
  });
  expect(
    (
      await f.pool.query(
        "SELECT revision FROM workflow_draft_revision_history WHERE workspace_id=$1 ORDER BY revision",
        [f.workspaceId],
      )
    ).rows.map((r) => r.revision),
  ).toEqual([1, 2, 3]);
});
test("removing labels from a later private revision cannot remove historical source ACL or local-copy ceilings", async () => {
  const sid = "historical-only";
  await f.pool.query("INSERT INTO resources VALUES($1,'source',$2)", [
    f.workspaceId,
    sid,
  ]);
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, sid, { ...source, id: sid }],
  );
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'editor')",
    [f.workspaceId, sid],
  );
  await workflows.saveDraft(f.editor, { ...draft, sourceIds: [sid] });
  await workflows.saveDraft(f.editor, {
    ...draft,
    expectedRevision: 1,
    sourceIds: [],
  });
  await permit();
  await expect(
    service.permission(f.editor, {
      ...draft,
      expectedRevision: 2,
      sourceIds: [],
    }),
  ).rejects.toThrow("FORBIDDEN");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2",
    [f.workspaceId, sid],
  );
  expect((await workflows.drafts(f.editor)).items).toHaveLength(0);
  await expect(
    workflows.saveDraft(f.editor, { ...draft, expectedRevision: 2 }),
  ).rejects.toThrow("NOT_FOUND");
});
