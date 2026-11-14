import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure, replayProductErasure } from "./erasure";
import { QuestionsService } from "../questions/service";
import { RuntimeService } from "../runtime/knowledge";

const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map(p => p.end())); });
async function setup() {
  const f = await fixture(); pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING", [f.workspaceId]);
  return { ...f, owner: { workspaceId: f.workspaceId, principalId: "fixture-owner" }, service: new OperationsService(f.pool, authorizeInTransaction) };
}
async function privateRecords(f: Awaited<ReturnType<typeof setup>>, marker: string) {
  const thread = randomUUID(), turn = randomUUID(), feedback = randomUUID();
  await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,$2,'editor',1)", [f.workspaceId, thread]);
  await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,'editor',1,$3,'hash',$4,'offline','pending',$5)", [f.workspaceId, thread, turn, marker, { revision: 1, envelope: { pageIds: ["topic"], sourceIds: ["source-a"], pages: {}, sources: {}, acl: {} }, history: [], policyHash: "hash", contextOmitted: false }]);
  await f.pool.query("INSERT INTO question_feedback(workspace_id,id,principal_id,nonce,request_hash,answer_id,answer_version,category,reason,evidence,input_envelope) VALUES($1,$2,'editor',$2,'hash','answer',1,'incorrect',$3,$4,$5)", [f.workspaceId, feedback, marker, { text: marker }, { pageIds: ["topic"], sourceIds: ["source-a"] }]);
  await f.pool.query("INSERT INTO question_feedback_work(workspace_id,feedback_id,page_id,page_version,recipient_ids,status,evidence_keys) VALUES($1,$2,'topic',1,ARRAY['reviewer'],'pending',$3)", [f.workspaceId, feedback, { text: marker }]);
  await f.pool.query("INSERT INTO version_metadata_events(workspace_id,page_id,actor_id,reason,before_snapshot,after_snapshot) VALUES($1,'topic','editor',$2,$3,$3)", [f.workspaceId, marker, { title: marker, pageId: "topic", sources: [{ id: "source-a" }] }]);
  return { thread, turn, feedback };
}

test("approved workspace erasure scrubs private conversations and immutable metadata, retaining IDs and enum constraints", async () => {
  const f = await setup(), other = await setup();
  const ids = await privateRecords(f, "private-question-marker"), neighbor = await privateRecords(other, "neighbor-marker");
  const preview = await previewErasure(f.service, f.owner, { scope: "workspace" });
  expect(preview.questionDataUnsupported).toBe(false);
  expect(preview.versionWorkflowDataUnsupported).toBe(false);
  const receipt = await executeErasure(f.service, f.owner, { scope: "workspace", previewHash: preview.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE" });
  expect(receipt.status).toBe("completed");
  expect(receipt.allCopiesErased).toBe(false);
  const turn = (await f.pool.query("SELECT * FROM question_turns WHERE workspace_id=$1 AND id=$2", [f.workspaceId, ids.turn])).rows[0];
  expect(turn).toMatchObject({ id: ids.turn, principal_id: "editor", mode: "offline", status: "pending", question: "[법정 삭제]" });
  const feedback = (await f.pool.query("SELECT * FROM question_feedback WHERE workspace_id=$1 AND id=$2", [f.workspaceId, ids.feedback])).rows[0];
  expect(feedback.category).toBe("incorrect");
  expect(JSON.stringify(feedback)).not.toContain("private-question-marker");
  const metadata = (await f.pool.query("SELECT * FROM version_metadata_events WHERE workspace_id=$1", [f.workspaceId])).rows;
  expect(metadata).toHaveLength(1); expect(metadata[0].actor_id).toBe("editor");
  expect(JSON.stringify(metadata)).not.toContain("private-question-marker");
  await expect(f.pool.query("UPDATE version_metadata_events SET reason='rewritten' WHERE workspace_id=$1", [f.workspaceId])).rejects.toThrow("VERSION_HISTORY_IMMUTABLE");
  expect((await other.pool.query("SELECT question FROM question_turns WHERE id=$1", [neighbor.turn])).rows[0].question).toBe("neighbor-marker");
  const questions = new QuestionsService(f.pool, { runtime: new RuntimeService(f.pool), authorize: authorizeInTransaction, runQuery: async () => { throw Error("UNEXPECTED_MODEL"); } });
  await expect(questions.createThread(f.editor)).rejects.toThrow();
});

test("whole workspace erasure revokes credentials and removes freeform usage labels while preserving cost attribution", async () => {
  const f = await setup(), key = randomUUID(), client = randomUUID(), grant = randomUUID();
  await f.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','credential-marker')", [client, f.workspaceId]);
  await f.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,device_client_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor',$3,'credential-marker',$4,'test','read',now()+interval '1 day')", [key, f.workspaceId, client, randomUUID()]);
  await f.pool.query("INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,status,approved_by,expires_at) VALUES($1,$2,$3,$4,'ERASE123','read','approved','editor',now()+interval '5 minutes')", [grant, client, f.workspaceId, randomUUID()]);
  await f.pool.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action,reason) VALUES($1,'editor',$2,'issue','credential-marker')", [f.workspaceId, key]);
  await f.pool.query("INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms,input_tokens,output_tokens,cost_usd) VALUES($1,'editor','query','openai','external','usage-marker',true,2,30,4,0.25)", [f.workspaceId]);
  const preview = await previewErasure(f.service, f.owner, { scope: "workspace" });
  expect(preview.agentDataUnsupported).toBe(false);
  await executeErasure(f.service, f.owner, { scope: "workspace", previewHash: preview.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE" });
  const stored = (await f.pool.query("SELECT * FROM agent_api_keys WHERE id=$1", [key])).rows[0];
  expect(stored.revoked_at).not.toBeNull(); expect(stored.principal_id).toBe("editor"); expect(stored.name).toBe("[법정 삭제]");
  expect((await f.pool.query("SELECT active FROM agent_device_clients WHERE id=$1", [client])).rows[0].active).toBe(false);
  expect((await f.pool.query("SELECT status FROM agent_device_grants WHERE id=$1", [grant])).rows[0].status).toBe("denied");
  const usage = (await f.pool.query("SELECT * FROM model_usage_events WHERE workspace_id=$1", [f.workspaceId])).rows[0];
  expect(usage).toMatchObject({ principal_id: "editor", provider: "openai", backend: "external", model: "[법정 삭제]", input_tokens: "30", output_tokens: "4", cost_usd: "0.2500000000" });
});

test("signed workspace recovery replay applies the same private-row erasure", async () => {
  const f = await setup(); await privateRecords(f, "restored-private-marker");
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await replayProductErasure(db, f.workspaceId, [], true);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
  expect((await f.pool.query("SELECT question FROM question_turns WHERE workspace_id=$1", [f.workspaceId])).rows[0].question).toBe("[법정 삭제]");
});

test("version metadata fences only erased pages and does not treat a denied legal hold as deletion", async () => {
  const f = await setup();
  const { transaction } = await import("../database");
  const { beginVersionMetadataChange } = await import("../workflows/versions/metadata");
  await f.pool.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','unrelated','[]','[]',true,'fixture-owner')", [f.workspaceId, randomUUID()]);
  await f.pool.query("INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts,error_code) VALUES($1,$2,$3,'workspace','fixture-owner','blocked','{}','LEGAL_HOLD')", [f.workspaceId, randomUUID(), 'a'.repeat(64)]);
  await expect(transaction(f.pool,f.workspaceId,db=>beginVersionMetadataChange(db,f.editor,'topic'))).resolves.toBeDefined();
  await f.pool.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'page','topic','[]','[]',true,'fixture-owner')", [f.workspaceId, randomUUID()]);
  await expect(transaction(f.pool,f.workspaceId,db=>beginVersionMetadataChange(db,f.editor,'topic'))).rejects.toThrow('ERASURE_PRODUCT_WRITES_FENCED');
});

test("resource erasure follows question and version lineage without scrubbing unrelated private threads", async () => {
  const f=await setup(), ids=await privateRecords(f,'selected-private-marker');
  const otherThread=randomUUID(), otherTurn=randomUUID();
  await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,$2,'editor',1)",[f.workspaceId,otherThread]);
  await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,'editor',1,$3,'hash','unrelated-private-marker','offline','pending',$4)",[f.workspaceId,otherThread,otherTurn,{envelope:{sourceIds:['other-source']}}]);
  const input={scope:'resource' as const,resource:{kind:'source' as const,id:'source-a'}};
  const preview=await previewErasure(f.service,f.owner,input);
  expect(preview.counts.question_turns).toBe(1);
  const result=await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_PREVIEWED_RESOURCE_LINEAGE'});
  expect(['completed','blocked']).toContain(result.status);
  expect((await f.pool.query('SELECT question FROM question_turns WHERE workspace_id=$1 AND id=$2',[f.workspaceId,ids.turn])).rows[0].question).toBe('[법정 삭제]');
  expect((await f.pool.query('SELECT question FROM question_turns WHERE workspace_id=$1 AND id=$2',[f.workspaceId,otherTurn])).rows[0].question).toBe('unrelated-private-marker');
  expect(JSON.stringify((await f.pool.query('SELECT * FROM version_metadata_events WHERE workspace_id=$1',[f.workspaceId])).rows)).not.toContain('selected-private-marker');
});

test("cross-workspace credential closure rejects erasure atomically", async () => {
  const f=await setup(), other=await setup(), client=randomUUID(), key=randomUUID();
  await f.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','other-private')",[client,other.workspaceId]);
  await f.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,device_client_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor',$3,'must-preserve',$4,'test','read',now()+interval '1 day')",[key,f.workspaceId,client,randomUUID()]);
  const input={scope:'workspace' as const}, preview=await previewErasure(f.service,f.owner,input);
  await expect(executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).rejects.toThrow('ERASURE_CREDENTIAL_SCOPE_MISMATCH');
  expect((await f.pool.query('SELECT name,revoked_at FROM agent_api_keys WHERE id=$1',[key])).rows[0]).toEqual({name:'must-preserve',revoked_at:null});
  expect((await f.pool.query('SELECT count(*)::int AS n FROM operations_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0);
});

test("resource preview reports an unlineaged private turn rather than silently declaring complete", async () => {
  const f=await setup(), thread=randomUUID(), turn=randomUUID();
  await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,$2,'editor',1)",[f.workspaceId,thread]);
  await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,'editor',1,$3,'hash','short private text','offline','pending',$4)",[f.workspaceId,thread,turn,{envelope:{pageIds:[],sourceIds:[]},history:[]}]);
  const input={scope:'resource' as const,resource:{kind:'source' as const,id:'source-a'}};
  const preview=await previewErasure(f.service,f.owner,input);
  expect(preview.unresolvedUnlineagedRows).toBeGreaterThan(0);
  const result=await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_PREVIEWED_RESOURCE_LINEAGE'});
  expect(result).toMatchObject({status:'blocked',errorCode:'UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW'});
  expect((await f.pool.query('SELECT question FROM question_turns WHERE id=$1',[turn])).rows[0].question).toBe('short private text');
});

test("metadata change rejects a trusted caller that omitted the gate", async () => {
  const f=await setup(), db=await f.pool.connect();
  const { beginVersionMetadataChange, capturePublishedVersionMetadata }=await import('../workflows/versions/metadata');
  try {
    await db.query('BEGIN');
    await expect(beginVersionMetadataChange(db,f.editor,'topic')).rejects.toThrow('ERASURE_MUTATION_GATE_REQUIRED');
    await expect(capturePublishedVersionMetadata(db,f.editor,'topic',1)).rejects.toThrow('ERASURE_MUTATION_GATE_REQUIRED');
  } finally {await db.query('ROLLBACK');db.release();}
});

test("version writer waits at shared gate and cannot write after page erasure commits", async () => {
  const f=await setup(), gate=await f.pool.connect();
  const { transaction }=await import('../database');
  const { beginVersionMetadataChange }=await import('../workflows/versions/metadata');
  let pending:Promise<unknown>|undefined;
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock(822025)');
    await gate.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'page','topic','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
    pending=transaction(f.pool,f.workspaceId,db=>beginVersionMetadataChange(db,f.editor,'topic'));
    const denied=expect(pending).rejects.toThrow('ERASURE_PRODUCT_WRITES_FENCED');
    let waiting=0;
    for(let i=0;i<1000&&!waiting;i++) waiting=(await gate.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
    expect(waiting).toBeGreaterThan(0);
    await gate.query('COMMIT');
    await denied;
    expect((await f.pool.query('SELECT count(*)::int AS n FROM version_metadata_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0);
  } finally {await gate.query('ROLLBACK');gate.release();if(pending)await pending.catch(()=>{});}
});

test("workspace erasure redacts distinct question nonces without violating uniqueness", async () => {
  const f=await setup(), thread=randomUUID();
  await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,$2,'editor',2)",[f.workspaceId,thread]);
  for (let i=1;i<=2;i++) {
    await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,'editor',$4,$5,'hash','sensitive','offline','pending','{}')",[f.workspaceId,thread,randomUUID(),i,`nonce-secret-${i}`]);
    await f.pool.query("INSERT INTO question_feedback(workspace_id,id,principal_id,nonce,request_hash,answer_id,answer_version,category,reason,evidence,input_envelope) VALUES($1,$2,'editor',$3,'hash','answer',1,'incorrect','sensitive','{}','{}')",[f.workspaceId,randomUUID(),`nonce-secret-${i}`]);
  }
  const input={scope:'workspace' as const}, preview=await previewErasure(f.service,f.owner,input);
  expect((await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).status).toBe('completed');
  for(const table of ['question_turns','question_feedback']) {
    const rows=(await f.pool.query(`SELECT nonce FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows;
    expect(new Set(rows.map(r=>r.nonce)).size).toBe(2);
    expect(JSON.stringify(rows)).not.toContain('nonce-secret');
  }
});

test("recovery replay also redacts multiple unique private nonces", async () => {
  const f=await setup(), thread=randomUUID();
  await f.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,$2,'editor',2)",[f.workspaceId,thread]);
  for(let i=1;i<=2;i++) await f.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,'editor',$4,$5,'hash','private','offline','pending','{}')",[f.workspaceId,thread,randomUUID(),i,`secret-${i}`]);
  const db=await f.pool.connect();
  try {await db.query('BEGIN');await replayProductErasure(db,f.workspaceId,[],true);await db.query('COMMIT');}
  finally {await db.query('ROLLBACK');db.release();}
  const rows=(await f.pool.query('SELECT nonce FROM question_turns WHERE workspace_id=$1',[f.workspaceId])).rows;
  expect(new Set(rows.map(r=>r.nonce)).size).toBe(2);expect(JSON.stringify(rows)).not.toContain('secret-');
});

test("workspace erasure preserves constrained outcome values and distinct governance identifiers", async () => {
  const f=await setup();
  await f.pool.query("INSERT INTO agent_outcomes(workspace_id,id,principal_id,result,data) VALUES($1,'outcome','editor','success',$2)",[f.workspaceId,{text:'outcome-private'}]);
  for(const type of ['design','operations']) {
    await f.pool.query("INSERT INTO governance_type_policies(workspace_id,document_type,revision,required_keys,mode) VALUES($1,$2,1,ARRAY[]::text[],'warn')",[f.workspaceId,type]);
    await f.pool.query("INSERT INTO collaboration_review_cadence(workspace_id,document_type,revision,days,updated_by,updated_at) VALUES($1,$2,1,30,'editor',now())",[f.workspaceId,type]);
  }
  const input={scope:'workspace' as const}, preview=await previewErasure(f.service,f.owner,input);
  expect((await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).status).toBe('completed');
  expect((await f.pool.query('SELECT result,principal_id,data FROM agent_outcomes WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toMatchObject({result:'success',principal_id:'editor',data:{text:'[법정 삭제]'}});
  expect((await f.pool.query('SELECT document_type,updated_by FROM collaboration_review_cadence WHERE workspace_id=$1 ORDER BY document_type',[f.workspaceId])).rows).toEqual([{document_type:'design',updated_by:'editor'},{document_type:'operations',updated_by:'editor'}]);
});

test("unlineaged agent outcome text blocks a resource erasure completion", async () => {
  const f=await setup();
  await f.pool.query("INSERT INTO agent_outcomes(workspace_id,id,principal_id,result,data) VALUES($1,'unknown-outcome','editor','failure',$2)",[f.workspaceId,{text:'unmapped-agent-text'}]);
  const input={scope:'resource' as const,resource:{kind:'source' as const,id:'source-a'}};
  const preview=await previewErasure(f.service,f.owner,input);
  expect(preview.unresolvedUnlineagedRows).toBeGreaterThan(0);
  const result=await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_PREVIEWED_RESOURCE_LINEAGE'});
  expect(result).toMatchObject({status:'blocked',errorCode:'UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW'});
  expect(JSON.stringify((await f.pool.query('SELECT data FROM agent_outcomes WHERE workspace_id=$1',[f.workspaceId])).rows)).toContain('unmapped-agent-text');
});

test.each(['execute','replay'] as const)("%s preserves distinct restore preview keys while redacting payloads", async (method) => {
  const f=await setup();
  for (const hash of ['preview-one','preview-two']) await f.pool.query("INSERT INTO version_restore_previews(workspace_id,principal_id,hash,payload,expires_at) VALUES($1,'editor',$2,$3,now()+interval '1 hour')",[f.workspaceId,hash,{content:`private-${hash}`}]);
  if (method==='execute') {
    const input={scope:'workspace' as const},preview=await previewErasure(f.service,f.owner,input);
    expect((await executeErasure(f.service,f.owner,{...input,previewHash:preview.previewHash,confirm:'ERASE_ENTIRE_WORKSPACE'})).status).toBe('completed');
  } else {
    const db=await f.pool.connect();
    try {await db.query('BEGIN');await replayProductErasure(db,f.workspaceId,[],true);await db.query('COMMIT');}
    finally {await db.query('ROLLBACK');db.release();}
  }
  const rows=(await f.pool.query('SELECT hash,payload FROM version_restore_previews WHERE workspace_id=$1 ORDER BY hash',[f.workspaceId])).rows;
  expect(rows).toEqual([{hash:'preview-one',payload:{content:'[법정 삭제]'}},{hash:'preview-two',payload:{content:'[법정 삭제]'}}]);
  const locator=(await f.pool.query("SELECT ctid::text AS locator FROM version_restore_previews WHERE workspace_id=$1 AND hash='preview-one'",[f.workspaceId])).rows[0].locator;
  await expect(f.pool.query("SELECT operations_privileged_product_redaction('version_restore_previews',$1::tid,$2::jsonb)",[locator,JSON.stringify({hash:'changed'})])).rejects.toThrow('ERASURE_IDENTITY_COLUMN_FORBIDDEN');
});
