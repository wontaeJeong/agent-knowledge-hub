import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { AccessService, authorizeInTransaction, authorizeActionDb } from "../access/index";
import { createRuntimeJobs } from "../jobs/runtime";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { ContentRetentionService } from "./service";
import { draftRetirementId } from "./drafts";
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
  await f.pool.query("INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'page','topic','fixture-owner'),($1,'source','source-a','fixture-owner') ON CONFLICT DO NOTHING",[f.workspaceId]);
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
  const preview = await service.previewRetention(admin());
  await service.executeRetention(admin(), {previewHash:preview.hash,policyRevision:1});
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
  const replayClient=await f.pool.connect();
  try {await replayClient.query('BEGIN');await replayClient.query('SELECT pg_advisory_xact_lock(822025)');await replayRetentionTombstones(replayClient,f.workspaceId);await replayClient.query('COMMIT');}
  finally {await replayClient.query('ROLLBACK');replayClient.release();}
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

test("explicit published version policy prunes only an unreferenced expired non-head version and fences resurrection", async () => {
  await f.pool.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','isolated')",[f.workspaceId]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'isolated',jsonb_set(data,'{id}','\"isolated\"') FROM pages WHERE workspace_id=$1 AND id='topic'",[f.workspaceId]);
  const older={...pageVersion(),sourceIds:[]};
  const newer={...older,number:2,id:'v2',content:'kept latest',at:new Date(now).toISOString()};
  await f.pool.query("INSERT INTO versions(workspace_id,page_id,number,data) VALUES($1,'isolated',1,$2),($1,'isolated',2,$3)",[f.workspaceId,older,newer]);
  await f.pool.query("INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'page','isolated','fixture-owner')",[f.workspaceId]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
  const preview=await service.previewRetention(admin());
  const candidate=preview.records.find(r=>r.kind==='publishedVersions'&&r.id==='isolated:1');
  expect(candidate?.eligible,JSON.stringify(candidate)).toBe(true);
  const result=await service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1});
  expect(result).toMatchObject({status:'completed',deleted:1});
  expect((await f.pool.query("SELECT number FROM versions WHERE workspace_id=$1 AND page_id='isolated' ORDER BY number",[f.workspaceId])).rows).toEqual([{number:2}]);
  await expect(f.pool.query("INSERT INTO versions(workspace_id,page_id,number,data) VALUES($1,'isolated',1,$2)",[f.workspaceId,older])).rejects.toThrow('RETENTION_VERSION_RETIRED');
});
function pageVersion() { return {id:'v1',number:1,content:'old private',author:'editor',reason:'old',at:new Date(now-3*86400000).toISOString(),sourceIds:['source-a']}; }

test("signed version retirement replays into restored old rows and fails closed on new references", async () => {
  await f.pool.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','isolated')",[f.workspaceId]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'isolated',jsonb_set(data,'{id}','\"isolated\"') FROM pages WHERE workspace_id=$1 AND id='topic'",[f.workspaceId]);
  const older={...pageVersion(),sourceIds:[]}, newer={...older,number:2,id:'v2',at:new Date(now).toISOString()};
  await f.pool.query("INSERT INTO versions VALUES($1,'isolated',1,$2),($1,'isolated',2,$3)",[f.workspaceId,older,newer]);
  await f.pool.query("INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'page','isolated','fixture-owner')",[f.workspaceId]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
  const preview=await service.previewRetention(admin()); await service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1});
  const encryption='fixture-retention-encryption'.repeat(3),signing='fixture-independent-signing'.repeat(3);
  const ledger=readRecoveryLedger(await captureRecoveryLedger(f.pool,encryption,signing),encryption,signing);
  expect(ledger.erasedArtifacts).toEqual(expect.arrayContaining([expect.objectContaining({workspace_id:f.workspaceId,artifact_kind:'published-version',artifact_id:'isolated/1'})]));
  const db=await f.pool.connect();
  try {
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(822025)');
    const saved=(await db.query("DELETE FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='published-version' AND artifact_id='isolated/1' RETURNING *",[f.workspaceId])).rows[0];
    await db.query("INSERT INTO versions VALUES($1,'isolated',1,$2)",[f.workspaceId,older]);
    await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6)",[saved.workspace_id,saved.artifact_kind,saved.artifact_id,saved.hashes,saved.preview_hash,saved.approved_by]);
    await replayRetentionTombstones(db,f.workspaceId);
    expect((await db.query("SELECT 1 FROM versions WHERE workspace_id=$1 AND page_id='isolated' AND number=1",[f.workspaceId])).rowCount).toBe(0);
  } finally {await db.query('ROLLBACK');db.release();}
});

test("retirement replay refuses restored version with newly present retained reference", async () => {
  const db=await f.pool.connect();
  try {
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(822025)');
    await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)",[f.workspaceId,{...pageVersion(),number:2}]);
    await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'published-version','topic/2','[]',$2,'fixture-owner')",[f.workspaceId,'a'.repeat(64)]);
    await db.query("INSERT INTO workflow_events(workspace_id,id,principal_id,kind,resource_id,data) VALUES($1,'late-ref','editor','reference','topic',$2)",[f.workspaceId,{pageId:'topic',version:2}]);
    await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
  } finally {await db.query('ROLLBACK');db.release();}
});

test("explicit source version policy prunes unreferenced old snapshot and fences reinsertion", async () => {
  const oldBlob=randomUUID(),newBlob=randomUUID(),oldSnap=randomUUID(),newSnap=randomUUID();
  await f.pool.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'source','isolated-source')",[f.workspaceId]);
  await f.pool.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'isolated-source',$2)",[f.workspaceId,{id:'isolated-source',content:'new',createdAt:new Date(now).toISOString()}]);
  for(const [blob,snap,hash,age] of [[oldBlob,oldSnap,'a'.repeat(64),3],[newBlob,newSnap,'b'.repeat(64),0]] as const) {
    await f.pool.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by,created_at) VALUES($1,$2,'source','isolated-source',$3,10,'text/plain','source.txt','clean','editor',$4)",[f.workspaceId,blob,hash,new Date(now-age*86400000)]);
    await f.pool.query("INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash,created_at) VALUES($1,$2,'isolated-source',$3,$4,$5)",[f.workspaceId,snap,blob,hash,new Date(now-age*86400000)]);
  }
  await f.pool.query("INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'source','isolated-source','fixture-owner')",[f.workspaceId]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,sourceVersions:1}});
  const preview=await service.previewRetention(admin()), candidate=preview.records.find(r=>r.kind==='sourceVersions'&&r.id===oldSnap);
  expect(candidate?.eligible,JSON.stringify(candidate)).toBe(true);
  expect(await service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1})).toMatchObject({status:'blocked',deleted:1,physicalPurgePending:1,allCopiesErased:false});
  expect((await f.pool.query('SELECT id FROM storage_snapshots WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual([{id:newSnap}]);
  expect((await f.pool.query('SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id=$2',[f.workspaceId,oldBlob])).rowCount).toBe(0);
  await expect(f.pool.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'source','isolated-source',$3,10,'text/plain','x','clean','editor')",[f.workspaceId,oldBlob,'a'.repeat(64)])).rejects.toThrow('RETENTION_SNAPSHOT_RETIRED');
});

test("source snapshot retirement replays old backup rows from the signed ledger", async () => {
  const db=await f.pool.connect(),blob=randomUUID(),snap=randomUUID(),hash='c'.repeat(64);
  try {
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(822025)');
    await db.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'source','isolated-source')",[f.workspaceId]);
    await db.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'isolated-source',$2)",[f.workspaceId,{id:'isolated-source',content:'latest'}]);
    await db.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'source','isolated-source',$3,5,'text/plain','old','clean','editor')",[f.workspaceId,blob,hash]);
    await db.query("INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,$2,'isolated-source',$3,$4)",[f.workspaceId,snap,blob,hash]);
    await db.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'new-replay-blob','source','isolated-source',$2,5,'text/plain','new','clean','editor')",[f.workspaceId,'d'.repeat(64)]);
    await db.query("INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,'new-replay-snap','isolated-source','new-replay-blob',$2)",[f.workspaceId,'d'.repeat(64)]);
    await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'source-snapshot',$2,$3,$4,'fixture-owner')",[f.workspaceId,`isolated-source/${hash}`,JSON.stringify([hash]),'a'.repeat(64)]);
    await replayRetentionTombstones(db,f.workspaceId);
    expect((await db.query('SELECT 1 FROM storage_snapshots WHERE workspace_id=$1 AND id=$2',[f.workspaceId,snap])).rowCount).toBe(0);
    expect((await db.query('SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id=$2',[f.workspaceId,blob])).rowCount).toBe(0);
  } finally {await db.query('ROLLBACK');db.release();}
});

test("version pruning blocks retained references, legal holds and stale preview", async () => {
  await f.pool.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','isolated')",[f.workspaceId]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'isolated',jsonb_set(data,'{id}','\"isolated\"') FROM pages WHERE workspace_id=$1 AND id='topic'",[f.workspaceId]);
  const older={...pageVersion(),sourceIds:[]},newer={...older,id:'v2',number:2,at:new Date(now).toISOString()};
  await f.pool.query("INSERT INTO versions VALUES($1,'isolated',1,$2),($1,'isolated',2,$3)",[f.workspaceId,older,newer]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
  const before=await service.previewRetention(admin());
  await f.pool.query("INSERT INTO workflow_events(workspace_id,id,principal_id,kind,resource_id,data) VALUES($1,'retained-ref','editor','reference','isolated',$2)",[f.workspaceId,{pageId:'isolated',version:1}]);
  await expect(service.executeRetention(admin(),{previewHash:before.hash,policyRevision:1})).rejects.toThrow('RETENTION_PREVIEW_STALE');
  const referenced=await service.previewRetention(admin()); expect(referenced.records.find(r=>r.id==='isolated:1')?.reasons).toContain('RETAINED_REFERENCE');
  await f.pool.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold-isolated','page','isolated','fixture-owner')",[f.workspaceId]);
  const held=await service.previewRetention(admin());expect(held.records.find(r=>r.id==='isolated:1')?.reasons).toContain('LEGAL_HOLD');
  expect((await service.executeRetention(admin(),{previewHash:held.hash,policyRevision:1})).status).toBe('blocked');
  expect((await f.pool.query("SELECT count(*)::int n FROM versions WHERE workspace_id=$1 AND page_id='isolated'",[f.workspaceId])).rows[0].n).toBe(2);
});

test("unknown text-only workspace content tables fail closed rather than hide a retained reference", async () => {
  await f.pool.query('CREATE TABLE workflow_unknown_fixture(workspace_id text NOT NULL, payload text NOT NULL)');
  try {
    await f.pool.query("INSERT INTO workflow_unknown_fixture VALUES($1,$2)",[f.workspaceId,'topic version 1']);
    await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
    await expect(service.previewRetention(admin())).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED');
  } finally {await f.pool.query('DROP TABLE workflow_unknown_fixture');}
});

test("manual version pruning requires the approving actor's current page and source access", async () => {
  await f.pool.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','isolated')",[f.workspaceId]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'isolated',jsonb_set(data,'{id}','\"isolated\"') FROM pages WHERE workspace_id=$1 AND id='topic'",[f.workspaceId]);
  const old={...pageVersion(),sourceIds:[]},current={...old,id:'v2',number:2,at:new Date(now).toISOString()};
  await f.pool.query("INSERT INTO versions VALUES($1,'isolated',1,$2),($1,'isolated',2,$3)",[f.workspaceId,old,current]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
  const preview=await service.previewRetention(admin());
  await expect(service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1})).rejects.toThrow('NOT_FOUND');
  expect((await f.pool.query("SELECT count(*)::int n FROM versions WHERE workspace_id=$1 AND page_id='isolated'",[f.workspaceId])).rows[0].n).toBe(2);
});


test("a source snapshot used by retained publication and protected by hold is never pruned", async () => {
 const blob=randomUUID(),snap=randomUUID(),hash='e'.repeat(64);
 await f.pool.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by,created_at) VALUES($1,$2,'source','source-a',$3,5,'text/plain','old','clean','editor',now()-interval '4 days')",[f.workspaceId,blob,hash]);
 await f.pool.query("INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash,created_at) VALUES($1,$2,'source-a',$3,$4,now()-interval '4 days')",[f.workspaceId,snap,blob,hash]);
 await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,sourceVersions:1}});
 await service.setHold(admin(),{contentClass:'sourceVersions',enabled:true,reason:'법적 보존',expectedPolicyRevision:1});
 const preview=await service.previewRetention(admin()),candidate=preview.records.find(r=>r.id===snap)!;
 expect(candidate.reasons).toContain('LEGAL_HOLD');expect(candidate.reasons).toContain('RETAINED_REFERENCE');expect(candidate.eligible).toBe(false);
 expect((await service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1})).status).toBe('blocked');
 expect((await f.pool.query('SELECT 1 FROM storage_snapshots WHERE workspace_id=$1 AND id=$2',[f.workspaceId,snap])).rowCount).toBe(1);
});

test("concurrent late version insertion waits for committed retirement and is rejected", async () => {
 const gate=await f.pool.connect(), writer=await f.pool.connect();let pending:Promise<unknown>|undefined;
 try {
  await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(822025)');
  await gate.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'published-version','topic/2','[]',$2,'fixture-owner')",[f.workspaceId,'a'.repeat(64)]);
  await writer.query('BEGIN');
  pending=writer.query("INSERT INTO versions VALUES($1,'topic',2,$2)",[f.workspaceId,{...pageVersion(),number:2}]);
  const rejected=expect(pending).rejects.toThrow('RETENTION_VERSION_RETIRED');
  let waiting=0;for(let i=0;i<1000&&!waiting;i++) waiting=(await gate.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
  expect(waiting).toBeGreaterThan(0);await gate.query('COMMIT');await rejected;
 } finally {await gate.query('ROLLBACK');await writer.query('ROLLBACK');gate.release();writer.release();if(pending)await pending.catch(()=>{});}
});

test("current legal hold stops draft retirement replay during recovery", async () => {
 const db=await f.pool.connect();
 try {
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(822025)');
  await db.query("INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','held-draft',1,$2)",[f.workspaceId,{content:'held'}]);
  await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'draft',$2,'[]',$3,'fixture-owner')",[f.workspaceId,draftRetirementId('editor','held-draft'),'a'.repeat(64)]);
  await db.query("INSERT INTO content_retention_holds(workspace_id,content_class,reason,placed_by) VALUES($1,'drafts','hold','fixture-owner')",[f.workspaceId]);
  await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
 } finally {await db.query('ROLLBACK');db.release();}
});

test("unknown foreign-key references without a workspace_id column block retention", async () => {
 await f.pool.query('CREATE TABLE retention_unknown_link(w text,p text,n integer, note text, FOREIGN KEY(w,p,n) REFERENCES versions(workspace_id,page_id,number))');
 try {
  await f.pool.query("INSERT INTO retention_unknown_link VALUES($1,'topic',1,'reference')",[f.workspaceId]);
  await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,drafts:null,publishedVersions:1}});
  await expect(service.previewRetention(admin())).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED');
 } finally {await f.pool.query('DROP TABLE retention_unknown_link');}
});

test("unlineaged board text blocks pruning even without an exact identifier", async () => {
 await oldDraft();
 await f.pool.query("INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,'post','editor','internal','team','note','copied content without structured lineage')",[f.workspaceId]);
 await service.setPolicy(admin(),{expectedRevision:0,policy});
 const preview=await service.previewRetention(admin());
 expect(preview.records.find(r=>r.kind==='drafts'&&r.id===input.id)?.eligible).toBe(false);
});

test("recovery replay rejects a caller without the exclusive mutation gate",async()=>{
 const db=await f.pool.connect();
 try {await db.query('BEGIN');await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_EXCLUSIVE_GATE_REQUIRED');}
 finally {await db.query('ROLLBACK');db.release();}
});

test("retention inventory excludes private draft, question and board text from service memory",async()=>{
 await workflows.saveDraft(f.editor,{...input,content:'PRIVATE_DRAFT_BODY',title:'PRIVATE_DRAFT_TITLE'});
 await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,'private-thread','editor',1)",[f.workspaceId]);
 await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,'private-thread','private-turn','editor',1,'nonce','hash','PRIVATE_QUESTION','offline','pending',$2)",[f.workspaceId,{history:['PRIVATE_HISTORY']}]);
 await f.pool.query("INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,'private-post','editor','voc','private','PRIVATE_TITLE','PRIVATE_BOARD')",[f.workspaceId]);
 await f.pool.query("INSERT INTO runtime_answers(workspace_id,id,principal_id,data) VALUES($1,'private-answer','editor',$2)",[f.workspaceId,{answer:'PRIVATE_ANSWER'}]);
 await f.pool.query("UPDATE sources SET data=jsonb_set(data,'{content}','\"PRIVATE_SOURCE\"') WHERE workspace_id=$1 AND id='source-a'",[f.workspaceId]);
 await f.pool.query("UPDATE versions SET data=jsonb_set(data,'{content}','\"PRIVATE_VERSION\"') WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId]);
 const db=await f.pool.connect();
 try {const {inventory}=await import('./inventory');const rows=await inventory(db,f.workspaceId);const text=JSON.stringify(rows);for(const value of ['PRIVATE_DRAFT_BODY','PRIVATE_DRAFT_TITLE','PRIVATE_QUESTION','PRIVATE_HISTORY','PRIVATE_TITLE','PRIVATE_BOARD','PRIVATE_ANSWER','PRIVATE_SOURCE','PRIVATE_VERSION']) expect(text).not.toContain(value);}
 finally {db.release();}
});
test("unclassified global content tables also fail closed",async()=>{
 await f.pool.query('CREATE TABLE workflow_unknown_global(note text)');
 try {await f.pool.query("INSERT INTO workflow_unknown_global VALUES('private reference')");await service.setPolicy(admin(),{expectedRevision:0,policy});await expect(service.previewRetention(admin())).rejects.toThrow('RETENTION_GRAPH_UNSUPPORTED');}
 finally {await f.pool.query('DROP TABLE workflow_unknown_global');}
});

test('replay blocks a source hold on a retired publication', async () => {
 const db=await f.pool.connect(); try {
  await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(822025)');
  await db.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','held-page')",[f.workspaceId]);
  await db.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'held-page',$2)",[f.workspaceId,{id:'held-page'}]);
  await db.query("INSERT INTO versions VALUES($1,'held-page',1,$2),($1,'held-page',2,$3)",[f.workspaceId,pageVersion(),{...pageVersion(),number:2}]);
  await db.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'source-hold','source','source-a','fixture-owner')",[f.workspaceId]);
  await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'published-version','held-page/1','[]',$2,'fixture-owner')",[f.workspaceId,'b'.repeat(64)]);
  await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
  expect((await db.query("SELECT 1 FROM versions WHERE workspace_id=$1 AND page_id='held-page' AND number=1",[f.workspaceId])).rowCount).toBe(1);
 } finally {await db.query('ROLLBACK');db.release();}
});

test('replay blocks a pending question whose sealed envelope pins a retired version', async () => {
 const db=await f.pool.connect(); try {
  await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(822025)');
  await db.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page','private-pin')",[f.workspaceId]);
  await db.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'private-pin',$2)",[f.workspaceId,{id:'private-pin'}]);
  await db.query("INSERT INTO versions VALUES($1,'private-pin',1,$2),($1,'private-pin',2,$3)",[f.workspaceId,{...pageVersion(),sourceIds:[]},{...pageVersion(),number:2,sourceIds:[]}]);
  await db.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,'thread','editor',1)",[f.workspaceId]);
  await db.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,'thread','turn','editor',1,'nonce','hash','Question','offline','pending',$2)",[f.workspaceId,{envelope:{pageIds:['private-pin'],pages:{'private-pin':1}}}]);
  await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'published-version','private-pin/1','[]',$2,'fixture-owner')",[f.workspaceId,'b'.repeat(64)]);
  await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
  expect((await db.query("SELECT 1 FROM versions WHERE workspace_id=$1 AND page_id='private-pin' AND number=1",[f.workspaceId])).rowCount).toBe(1);
 } finally {await db.query('ROLLBACK');db.release();}
});

test('replay cannot remove the only retained source snapshot', async () => {
 const db=await f.pool.connect(); try {
  await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(822025)');
  await db.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'source','replay-source')",[f.workspaceId]);
  await db.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'replay-source',$2)",[f.workspaceId,{id:'replay-source'}]);
  await db.query("INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'replay-blob','source','replay-source',$2,5,'text/plain','x','clean','editor')",[f.workspaceId,'a'.repeat(64)]);
  await db.query("INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,'replay-snapshot','replay-source','replay-blob',$2)",[f.workspaceId,'a'.repeat(64)]);
  await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'source-snapshot',$2,$3,$4,'fixture-owner')",[f.workspaceId,'replay-source/'+'a'.repeat(64),JSON.stringify(['a'.repeat(64)]),'b'.repeat(64)]);
  await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
  expect((await db.query("SELECT 1 FROM storage_snapshots WHERE workspace_id=$1 AND id='replay-snapshot'",[f.workspaceId])).rowCount).toBe(1);
 } finally {await db.query('ROLLBACK');db.release();}
});

test('scheduled retention checks the service credential against private draft lineage before deletion', async () => {
 const access=new AccessService(f.pool);
 const account=await access.createServicePrincipal(admin(),{name:'retention',expiresAt:new Date(Date.now()+3600000).toISOString()});
 const credential=await access.issueServiceCredential(admin(),account.id,{actions:['knowledge.read'],expiresAt:new Date(Date.now()+1800000).toISOString()});
 const identity={workspaceId:f.workspaceId,principalId:account.id,credentialId:credential.id};
 await oldDraft(); await service.setPolicy(admin(),{expectedRevision:0,policy:{...policy,draftOwners:['editor']}});
 const db=await f.pool.connect(); try {await expect(authorizeActionDb(db,identity,'knowledge.read',{kind:'page',id:'topic'})).rejects.toThrow('NOT_FOUND');} finally {db.release();}
 const bridge=createRuntimeJobs(f.pool,new RuntimeService(f.pool),{workerCount:1,directoryProviderId:'fixture',directoryStatus:async subject=>({...subject,active:true,verifiedAt:new Date().toISOString(),validUntil:new Date(Date.now()+10000).toISOString()}),retentionServices:[identity]});
 try {
  const schedule=await bridge.jobs.saveSchedule(admin(),{key:'retention',cadence:'daily',time:'09:00',timezone:'UTC',holidays:[],catchup:'latest',identity,job:{kind:'retention',payload:{policyRevision:1},pageIds:[],sourceIds:[],reservation:{tokens:0,costMicros:0},timeoutMs:60000,maxAttempts:3},approvedPageIds:[],approvedSourceIds:[]});
  const job=await bridge.jobs.runSchedule(admin(),schedule.id,'once'); await bridge.workers[0].tick();
  expect((await f.pool.query('SELECT status FROM durable_jobs WHERE id=$1',[job.id])).rows[0].status).not.toBe('succeeded');
  expect((await f.pool.query("SELECT 1 FROM workflow_drafts WHERE workspace_id=$1 AND id=$2",[f.workspaceId,input.id])).rowCount).toBe(1);
  expect((await f.pool.query("SELECT 1 FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='draft'",[f.workspaceId])).rowCount).toBe(0);
 } finally {await bridge.stop();}
});

test('replay preserves held historical draft copies when the current draft is absent', async () => {
 const db=await f.pool.connect(); try {
  await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(822025)');
  await db.query("INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,'editor','history-only',1,$2)",[f.workspaceId,{sourceIds:['source-a']}]);
  await db.query("INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'source-hold','source','source-a','fixture-owner')",[f.workspaceId]);
  await db.query("INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'draft',$2,'[]',$3,'fixture-owner')",[f.workspaceId,draftRetirementId('editor','history-only'),'b'.repeat(64)]);
  await expect(replayRetentionTombstones(db,f.workspaceId)).rejects.toThrow('RETENTION_REPLAY_REFERENCE_CONFLICT');
  expect((await db.query("SELECT 1 FROM workflow_draft_revision_history WHERE workspace_id=$1 AND draft_id='history-only'",[f.workspaceId])).rowCount).toBe(1);
 } finally {await db.query('ROLLBACK');db.release();}
});

test.each(['source','page'] as const)('retention checks historical draft %s lineage even when removed from the current revision', async (kind) => {
 await oldDraft();
 const id=`historical-${kind}`;
 await f.pool.query('INSERT INTO resources(workspace_id,kind,id) VALUES($1,$2,$3)',[f.workspaceId,kind,id]);
 if(kind==='source') await f.pool.query('INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)',[f.workspaceId,id,{id}]);
 else {
  await f.pool.query('INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)',[f.workspaceId,id,{id}]);
  await f.pool.query('INSERT INTO versions(workspace_id,page_id,number,data) VALUES($1,$2,1,$3)',[f.workspaceId,id,{...pageVersion(),sourceIds:[]}]);
 }
 await f.pool.query("INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,'editor',$2,99,$3)",[f.workspaceId,input.id,kind==='source'?{sourceIds:[id]}:{pageId:id}]);
 await service.setPolicy(admin(),{expectedRevision:0,policy});
 const preview=await service.previewRetention(admin());
 await expect(service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1})).rejects.toThrow('NOT_FOUND');
 expect((await f.pool.query('SELECT 1 FROM workflow_drafts WHERE workspace_id=$1 AND id=$2',[f.workspaceId,input.id])).rowCount).toBe(1);
});

test('retention accepts legacy authorization and collector control tables without exposing or deleting their records', async () => {
 await f.pool.query("INSERT INTO legacy_compat_memberships(workspace_id,principal_id,role,subject) VALUES($1,'editor','editor','PRIVATE_SUBJECT')",[f.workspaceId]);
 await f.pool.query("INSERT INTO legacy_compat_manifest_imports(manifest_hash,backup_hash,key_fingerprint,captured_at,issued_at) VALUES('manifest-fixture','backup-fixture','key-fixture',now(),now()) ON CONFLICT DO NOTHING");
 await f.pool.query("INSERT INTO storage_collector_connections(workspace_id,id,principal_id,configuration_hash) VALUES($1,'control-fixture','editor',$2)",[f.workspaceId,'a'.repeat(64)]);
 await oldDraft(); await service.setPolicy(admin(),{expectedRevision:0,policy});
 const preview=await service.previewRetention(admin());
 expect(JSON.stringify(preview)).not.toContain('PRIVATE_SUBJECT');
 expect(preview.records.find(r=>r.kind==='drafts'&&r.id===input.id)?.eligible).toBe(true);
 const receipt=await service.executeRetention(admin(),{previewHash:preview.hash,policyRevision:1});
 expect(receipt.deleted).toBe(1);
 expect((await f.pool.query("SELECT 1 FROM legacy_compat_memberships WHERE workspace_id=$1 AND principal_id='editor'",[f.workspaceId])).rowCount).toBe(1);
 expect((await f.pool.query("SELECT 1 FROM storage_collector_connections WHERE workspace_id=$1 AND id='control-fixture'",[f.workspaceId])).rowCount).toBe(1);
});
