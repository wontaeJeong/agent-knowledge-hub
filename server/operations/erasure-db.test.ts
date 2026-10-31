import { test, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { fixture, adoptFixture, page } from "../test-support";
import { transaction } from "../database";
import { capturePublishedVersionMetadata } from "../workflows/versions/metadata";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure, replayProductErasure } from "./erasure";
import { operationsAuthorizer } from "./authorization";
import { recordModelUsage } from "../model-usage";
import { handleCredentialRequest, pollDevice, startDevice } from "../agent-credentials";
import { QuestionsService } from "../questions/service";
import { RuntimeService } from "../runtime/knowledge";
const pools: Pool[] = [];
test("administrative audit metadata export is explicit opt-in, never reader escalation or raw-source export fallback", async () => {
  const f = await setup();
  const enabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: true,
      }),
    ),
    disabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: false,
      }),
    );
  await expect(disabled.auditRows(f.ctx)).rejects.toThrow(
    "ADMIN_AUDIT_EXPORT_POLICY_DISABLED",
  );
  await expect(enabled.auditRows(f.reader)).rejects.toThrow("FORBIDDEN");
  expect((await enabled.auditRows(f.ctx)).length).toBeGreaterThan(0);
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  return {
    ...f,
    ctx: { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    s: new OperationsService(f.pool, authorizeInTransaction),
  };
}
test("workspace erasure cannot complete while immutable version metadata remains", async () => {
  const f = await setup();
  await transaction(f.pool, f.workspaceId, async db => {
    await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [f.workspaceId, {...page.versions[0], number: 2}]);
    await capturePublishedVersionMetadata(db, f.editor, "topic", 2);
  });
  const input = {scope: "workspace" as const};
  const preview = await previewErasure(f.s, f.ctx, input);
  await expect(executeErasure(f.s, f.ctx, {...input, previewHash: preview.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
  expect((await f.pool.query("SELECT 1 FROM version_metadata WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(1);
});
test("workspace erasure cannot complete while immutable metadata events remain", async () => {
  const f = await setup();
  await f.pool.query("INSERT INTO version_metadata_events(workspace_id,page_id,actor_id,reason,before_snapshot,after_snapshot) VALUES($1,'topic','editor','private reason',$2,$3)", [f.workspaceId, {title: "private before"}, {title: "private after"}]);
  const input = {scope: "workspace" as const};
  const preview = await previewErasure(f.s, f.ctx, input);
  await expect(executeErasure(f.s, f.ctx, {...input, previewHash: preview.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
  expect((await f.pool.query("SELECT 1 FROM version_metadata_events WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(1);
});
test("version workflow data blocks both scopes and replay only in its own workspace", async () => {
  const a = await setup(), b = await setup();
  const resource = {scope: "resource" as const, resource: {kind: "source" as const, id: "source-a"}};
  const before = await previewErasure(a.s, a.ctx, resource);
  await a.pool.query("INSERT INTO version_restore_previews(workspace_id,principal_id,hash,payload,expires_at) VALUES($1,'editor','preview',$2,now()+interval '1 hour')", [a.workspaceId, {content: "protected"}]);
  await expect(executeErasure(a.s, a.ctx, {...resource, previewHash:before.previewHash, confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
  for (const input of [resource, {scope: "workspace" as const}]) {
    const preview = await previewErasure(a.s, a.ctx, input);
    expect(preview.versionWorkflowDataUnsupported).toBe(true);
    await expect(executeErasure(a.s, a.ctx, {...input, previewHash: preview.previewHash, confirm: input.scope === "resource" ? "ERASE_PREVIEWED_RESOURCE_LINEAGE" : "ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
    const db = await a.pool.connect();
    try {
      await db.query("BEGIN");
      await expect(replayProductErasure(db, a.workspaceId, input.scope === "resource" ? [input.resource] : [], input.scope === "workspace")).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
    } finally { await db.query("ROLLBACK"); db.release(); }
  }
  expect((await previewErasure(b.s, b.ctx, resource)).versionWorkflowDataUnsupported).toBe(false);
  const preview = await previewErasure(b.s, b.ctx, resource);
  expect((await executeErasure(b.s, b.ctx, {...resource, previewHash: preview.previewHash, confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE"})).status).toBe("completed");
  expect((await a.pool.query("SELECT payload FROM version_restore_previews WHERE workspace_id=$1", [a.workspaceId])).rows[0].payload.content).toBe("protected");
});
test.each(["versions_decisions", "version_restore_plans", "version_restore_applications"])("%s records block workspace erasure", async table => {
  const f = await setup();
  await f.pool.query("INSERT INTO batches(workspace_id,id,data,hash) VALUES($1,'batch','{}','hash')", [f.workspaceId]);
  if (table === "versions_decisions") {
    await f.pool.query("INSERT INTO versions_decisions(id,workspace_id,original_batch_id,original_hash,actor_id,decision,selected_page_ids,reasons,attribution) VALUES($2,$1,'batch','hash','editor','reject',ARRAY['topic'], $3,$3)", [f.workspaceId, randomUUID(), {reason:"private"}]);
  } else {
    await f.pool.query("INSERT INTO version_restore_plans(workspace_id,batch_id,batch_hash,page_id,plan_hash,payload) VALUES($1,'batch','hash','topic','hash',$2)", [f.workspaceId, {content:"private"}]);
    if (table === "version_restore_applications") await f.pool.query("INSERT INTO version_restore_applications(workspace_id,batch_id,page_id,number,plan_hash,applied_by) VALUES($1,'batch','topic',1,'hash','editor')", [f.workspaceId]);
  }
  const input = {scope:"workspace" as const}, preview = await previewErasure(f.s, f.ctx, input);
  expect(preview.versionWorkflowDataUnsupported).toBe(true);
  await expect(executeErasure(f.s, f.ctx, {...input, previewHash:preview.previewHash, confirm:"ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_VERSION_METADATA_UNSUPPORTED");
});
test("legacy arbitrary-client capture bypasses the exclusive erasure gate", async () => {
  const f = await setup();
  const gate = await f.pool.connect(), writer = await f.pool.connect();
  let capture: Promise<void> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [f.workspaceId, {...page.versions[0], number: 2}]);
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(822025)");
    capture = capturePublishedVersionMetadata(writer, f.editor, "topic", 2);
    await gate.query("SELECT pg_sleep(0.1)");
    const activity = (await gate.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    expect(activity).toMatchObject({wait_event_type: "Client", wait_event: "ClientRead"});
  } finally {
    await gate.query("ROLLBACK");
    if (capture) await capture;
    await writer.query("ROLLBACK");
    gate.release();
    writer.release();
  }
});
test("question copies block resource and workspace erasure and recovery without affecting other workspaces", async () => {
  const a = await setup(), b = await setup();
  await a.pool.query("INSERT INTO question_threads(workspace_id,id,principal_id,revision) VALUES($1,'thread','editor',1)", [a.workspaceId]);
  await a.pool.query("INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,'thread','turn','editor',1,'nonce','hash','private copied text','offline','pending',$2)", [a.workspaceId, {sourceIds:['source-a'], history:'private history'}]);
  await a.pool.query("INSERT INTO question_feedback(workspace_id,id,principal_id,nonce,request_hash,answer_id,answer_version,category,reason,evidence,input_envelope) VALUES($1,'feedback','editor','nonce','hash','answer',1,'incorrect','private reason',$2,$3)", [a.workspaceId, {text:'private evidence'}, {sourceIds:['source-a']}]);
  await a.pool.query("INSERT INTO question_feedback_work(workspace_id,feedback_id,page_id,page_version,recipient_ids,status,evidence_keys) VALUES($1,'feedback','topic',1,ARRAY[]::text[],'pending-unassigned',$2)", [a.workspaceId, {quote:'private work'}]);
  const resource = {scope:'resource' as const,resource:{kind:'source' as const,id:'source-a'}};
  for (const input of [resource, {scope:'workspace' as const}]) {
    const preview = await previewErasure(a.s,a.ctx,input);
    expect(preview.questionDataUnsupported).toBe(true);
    await expect(executeErasure(a.s,a.ctx,{...input,previewHash:preview.previewHash,confirm:input.scope==='workspace'?'ERASE_ENTIRE_WORKSPACE':'ERASE_PREVIEWED_RESOURCE_LINEAGE'})).rejects.toThrow('ERASURE_QUESTION_DATA_UNSUPPORTED');
    const db = await a.pool.connect();
    try { await db.query('BEGIN'); await expect(replayProductErasure(db,a.workspaceId,input.scope==='resource'?[input.resource]:[],input.scope==='workspace')).rejects.toThrow('ERASURE_QUESTION_DATA_UNSUPPORTED'); }
    finally { await db.query('ROLLBACK'); db.release(); }
  }
  expect((await a.pool.query("SELECT status,error_code FROM operations_erasure_receipts WHERE workspace_id=$1",[a.workspaceId])).rows).toEqual(expect.arrayContaining([expect.objectContaining({status:'blocked',error_code:'ERASURE_QUESTION_DATA_UNSUPPORTED'})]));
  expect((await a.pool.query("SELECT question FROM question_turns WHERE workspace_id=$1",[a.workspaceId])).rows[0].question).toBe('private copied text');
  expect((await a.pool.query("SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1 AND id='source-a'",[a.workspaceId])).rows[0].content).toContain('재시도');
  const other = await previewErasure(b.s,b.ctx,resource);
  expect((await executeErasure(b.s,b.ctx,{...resource,previewHash:other.previewHash,confirm:'ERASE_PREVIEWED_RESOURCE_LINEAGE'})).status).toBe('completed');
});
test("question writes wait for erasure and fail closed after its tombstone", async () => {
  const f=await setup(), db=await f.pool.connect();
  const service = new QuestionsService(f.pool,{runtime:new RuntimeService(f.pool),authorize:authorizeInTransaction,runQuery:async()=>{throw Error('NOT_CONFIGURED');}});
  const ctx={...f.editor,authorization:{revalidate:async()=>{},assertSession:async()=>{}}};
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(822025)');
    await db.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','source-a','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
    const pending=service.createThread(ctx);
    const assertion=expect(pending).rejects.toThrow('ERASURE_QUESTION_WRITES_FENCED');
    let waiting=0;
    for(let i=0;i<1000 && !waiting;i++) waiting=(await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
    expect(waiting).toBeGreaterThan(0);
    await db.query('COMMIT');
    await assertion;
    expect((await f.pool.query('SELECT 1 FROM question_threads WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0);
  } finally { await db.query('ROLLBACK'); db.release(); }
});
test("restored question turns and feedback cannot be written after workspace erasure", async () => {
  const f = await setup();
  const ctx = {...f.editor,authorization:{revalidate:async()=>{},assertSession:async()=>{}}};
  const service = new QuestionsService(f.pool,{runtime:new RuntimeService(f.pool),authorize:authorizeInTransaction,runQuery:async()=>{throw Error('NOT_CONFIGURED');}});
  const thread=await service.createThread(ctx);
  const turn=await service.acceptTurn(ctx,thread.id,{expectedRevision:0,nonce:'old',question:'old',mode:'offline'});
  let submitted=false;
  service.setSubmit(async()=>{submitted=true;return {id:'job',status:'queued'};});
  await f.pool.query("INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,$3,'workspace','fixture-owner','completed','{}')",[f.workspaceId,randomUUID(),'a'.repeat(64)]);
  await expect(service.acceptTurn(ctx,thread.id,{expectedRevision:1,nonce:'new',question:'new',mode:'offline'})).rejects.toThrow('ERASURE_QUESTION_WRITES_FENCED');
  await expect(service.resumeTurn(ctx,thread.id,turn.turnId)).rejects.toThrow('ERASURE_QUESTION_WRITES_FENCED');
  await expect(service.reportFeedback(ctx,{answerId:'answer',version:1,nonce:'feedback',category:'incorrect',reason:'text'})).rejects.toThrow('ERASURE_QUESTION_WRITES_FENCED');
  expect(submitted).toBe(false);
  expect((await f.pool.query('SELECT count(*)::int AS n FROM question_turns WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1);
  expect((await f.pool.query('SELECT 1 FROM question_feedback WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0);
});
test("credential request inventory follows its key workspace without mixing another workspace", async () => {
  const a = await setup(), b = await setup();
  for (const f of [a, b]) {
    const key = randomUUID();
    await f.pool.query(
      "INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','fixture',$3,'test','read',now()+interval '1 day')",
      [key, f.workspaceId, randomUUID()],
    );
    await f.pool.query("INSERT INTO agent_key_requests(key_id,route) VALUES($1,'/api/v1/pages')", [key]);
  }
  const aPreview = await previewErasure(a.s, a.ctx, { scope: "workspace" });
  const bPreview = await previewErasure(b.s, b.ctx, { scope: "workspace" });
  expect(aPreview.counts.agent_key_requests).toBe(1);
  expect(bPreview.counts.agent_key_requests).toBe(1);
});
test("credential and model usage rows block resource and workspace erasure and recovery replay", async () => {
  const a = await setup(), b = await setup();
  const preview = await previewErasure(a.s, a.ctx, {scope: "resource", resource: {kind: "source", id: "source-a"}});
  await a.pool.query("INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms) VALUES($1,'editor','query','openai','external','fixture',true,1)", [a.workspaceId]);
  const input = {scope: "resource" as const, resource: {kind: "source" as const, id: "source-a"}};
  const current = await previewErasure(a.s, a.ctx, input);
  await expect(executeErasure(a.s, a.ctx, {...input, previewHash: current.previewHash, confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  const workspace = await previewErasure(a.s, a.ctx, {scope: "workspace"});
  await expect(executeErasure(a.s, a.ctx, {scope: "workspace", previewHash: workspace.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  const client = await a.pool.connect();
  try {
    await client.query("BEGIN");
    await expect(replayProductErasure(client, a.workspaceId, [input.resource])).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
    await client.query("ROLLBACK");
  } finally { client.release(); }
  expect((await a.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='source-a'", [a.workspaceId])).rowCount).toBe(1);
  expect((await a.pool.query("SELECT count(*)::int AS n FROM model_usage_events WHERE workspace_id=$1", [a.workspaceId])).rows[0].n).toBe(1);
  expect((await previewErasure(b.s, b.ctx, input)).previewHash).toBeTruthy();
  expect(preview.previewHash).toBeTruthy();
});
test("completed resource erasure fences later credential issuance and model usage", async () => {
  const f = await setup();
  const input = {scope: "resource" as const, resource: {kind: "source" as const, id: "source-a"}};
  const preview = await previewErasure(f.s, f.ctx, input);
  await executeErasure(f.s, f.ctx, {...input, previewHash: preview.previewHash, confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE"});
  const old = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  try {
    await expect(handleCredentialRequest(f.pool, f.ctx, "POST", "/api/v1/credentials/keys", {name:"fixture",scope:"read"}, "http://localhost")).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    await expect(recordModelUsage({pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"}, {operation:"query",provider:"openai",backend:"external",model:"fixture",deploymentId:null,succeeded:true,latencyMs:1,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null,errorCode:null})).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
  } finally {
    if (old === undefined) delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = old;
  }
});
test("recovery replay aborts instead of releasing unresolved unlineaged content", async () => {
  const f = await setup();
  await f.pool.query("INSERT INTO workflow_preferences(workspace_id,principal_id,revision,data) VALUES($1,'editor',1,$2)", [f.workspaceId, {content:"fixture unlineaged"}]);
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await expect(replayProductErasure(db, f.workspaceId, [{kind:"source",id:"source-a"}])).rejects.toThrow("RECOVERY_ERASURE_INCOMPLETE");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await f.pool.query("SELECT data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id='editor'",[f.workspaceId])).rows[0].data.content).toBe("fixture unlineaged");
});

test("exclusive erasure gate fences concurrent key and usage writes after tombstone commit", async () => {
  const f = await setup(), db = await f.pool.connect();
  const old = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(822025)");
    await db.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','source-a','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
    const key = handleCredentialRequest(f.pool, f.ctx, "POST", "/api/v1/credentials/keys", {name:"fixture",scope:"read"}, "http://localhost");
    const usage = recordModelUsage({pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"}, {operation:"query",provider:"openai",backend:"external",model:"fixture",deploymentId:null,succeeded:true,latencyMs:1,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null,errorCode:null});
    const assertions = Promise.all([
      expect(key).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED"),
      expect(usage).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED"),
    ]);
    let waiting = 0;
    for (let i=0; i<1000 && waiting<2; i++) {
      waiting = (await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
    }
    expect(waiting).toBeGreaterThanOrEqual(2);
    await db.query("COMMIT");
    await assertions;
    expect((await f.pool.query("SELECT count(*)::int AS n FROM agent_api_keys WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
  } finally {
    await db.query("ROLLBACK"); db.release();
    if (old === undefined) delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = old;
  }
});
test("credential rows and resource-bearing routes block erasure without changing either workspace", async () => {
  const a = await setup(), b = await setup(), key = randomUUID();
  await a.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','fixture',$3,'test','read',now()+interval '1 day')",[key,a.workspaceId,randomUUID()]);
  await a.pool.query("INSERT INTO agent_key_requests(key_id,route) VALUES($1,'/api/v1/pages/topic')",[key]);
  const input = {scope:"resource" as const,resource:{kind:"page" as const,id:"topic"}};
  const preview = await previewErasure(a.s,a.ctx,input);
  await expect(executeErasure(a.s,a.ctx,{...input,previewHash:preview.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  expect((await a.pool.query("SELECT route FROM agent_key_requests WHERE key_id=$1",[key])).rows[0].route).toBe("/api/v1/pages/topic");
  const other = await previewErasure(b.s,b.ctx,input);
  await executeErasure(b.s,b.ctx,{...input,previewHash:other.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"});
  expect((await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1",[key])).rows[0].revoked_at).toBeNull();
  const db = await a.pool.connect();
  try { await db.query("BEGIN"); await expect(replayProductErasure(db,a.workspaceId,[],true)).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED"); }
  finally { await db.query("ROLLBACK"); db.release(); }
});
test("restored device grant cannot issue credentials after an erasure tombstone", async () => {
  const f=await setup(), clientId=randomUUID(), deviceCode="A".repeat(43);
  await f.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','fixture')",[clientId,f.workspaceId]);
  await f.pool.query("INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,status,approved_by,expires_at) VALUES($1,$2,$3,$4,'ABCDEFGH','read','approved','editor',now()+interval '5 minutes')",[randomUUID(),clientId,f.workspaceId,createHash("sha256").update(deviceCode).digest("hex")]);
  await f.pool.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','source-a','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
  const old=process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED="true";
  try {
    await expect(startDevice(f.pool,{clientId,scope:"read"},"http://localhost")).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    await expect(pollDevice(f.pool,{deviceCode})).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM agent_api_keys WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
  } finally { if(old===undefined)delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED; else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=old; }
});
test("actual append-only refinement/draft/answer copies are erased by approved transitive lineage, roots/receipts persist", async () => {
  const f = await setup(),
    secret = "LEGAL_SECRET_72819";
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','derived-draft',1,$2)",
    [f.workspaceId, { pageId: "topic", content: secret }],
  );
  await f.pool.query(
    "INSERT INTO refinement_claims(workspace_id,id,data) VALUES($1,'derived-claim',$2)",
    [
      f.workspaceId,
      { id: "derived-claim", sourceIds: ["source-a"], claim: secret },
    ],
  );
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  const request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    preview = await previewErasure(f.s, f.ctx, request);
  expect(preview.counts.refinement_claims).toBe(1);
  expect(preview.counts.workflow_drafts).toBe(1);
  await expect(
    executeErasure(f.s, f.editor, {
      ...request,
      previewHash: preview.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow();
  const result = await executeErasure(f.s, f.ctx, {
    ...request,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(["completed", "blocked"]).toContain(result.status);
  expect(result.allCopiesErased).toBe(false);
  for (const table of [
    "sources",
    "versions",
    "workflow_drafts",
    "refinement_claims",
  ])
    expect(
      JSON.stringify(
        (
          await f.pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT status,counts FROM operations_erasure_receipts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM operations_audit_chain WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).not.toBe("0");
});
test("legal hold and stale preview block writes; separate explicit workspace Owner preview required", async () => {
  const f = await setup(),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    };
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','page','topic','fixture-owner')",
    [f.workspaceId],
  );
  const held = await previewErasure(f.s, f.ctx, request);
  expect(held.legalHold).toBe(true);
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: held.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("LEGAL_HOLD");
  await f.pool.query(
    "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const p = await previewErasure(f.s, f.ctx, request);
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: p.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_PREVIEW_STALE");
  const all = await previewErasure(f.s, f.ctx, { scope: "workspace" });
  await expect(
    executeErasure(f.s, f.ctx, {
      scope: "workspace",
      previewHash: all.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_CONFIRMATION_REQUIRED");
  expect(
    (
      await executeErasure(f.s, f.ctx, {
        scope: "workspace",
        previewHash: all.previewHash,
        confirm: "ERASE_ENTIRE_WORKSPACE",
      })
    ).status,
  ).toBe("completed");
});
