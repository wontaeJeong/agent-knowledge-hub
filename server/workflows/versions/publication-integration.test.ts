import {expect,test} from 'vitest';
import {fixture,adoptLegacyFixture,page} from '../../test-support';
import {RuntimeService} from '../../runtime/knowledge';
import {VersionService,capturePublishedVersionMetadata} from './service';
import {authorizeInTransaction} from '../../access/index';
import {transaction} from '../../database';
import {WorkflowService} from '../service';
async function setup(){const f=await fixture();await adoptLegacyFixture(f.pool,f.workspaceId);return {...f,runtime:new RuntimeService(f.pool),versions:new VersionService(f.pool,authorizeInTransaction)};}
const draft=(id='topic',baseVersion=1)=>({id,title:'주제',summary:'검토 요약',content:'검토된 새 본문',scope:'team' as const,baseVersion,sourceIds:['source-a'],links:[],facts:[]});
async function oldPublication(f:Awaited<ReturnType<typeof setup>>,ids=['topic']){
 await transaction(f.pool,f.workspaceId,async db=>{
  for(const id of ids){
   if(id!=='topic'){
    await db.query("INSERT INTO resources(workspace_id,kind,id) VALUES($1,'page',$2)",[f.workspaceId,id]);
    await db.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",[f.workspaceId,id,{...page,id,versions:undefined,tags:['historical-tag']}]);
    await db.query("INSERT INTO resource_readers SELECT workspace_id,kind,$2,principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic'",[f.workspaceId,id]);
   }else await db.query("UPDATE pages SET data=jsonb_set(data,'{tags}','[\"historical-tag\"]') WHERE workspace_id=$1 AND id=$2",[f.workspaceId,id]);
   await db.query("INSERT INTO versions VALUES($1,$2,2,$3)",[f.workspaceId,id,{...page.versions[0],number:2}]);
   await db.query("INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,$2,'{\"properties\":{\"owner\":\"historical-owner\"}}')",[f.workspaceId,id]);
   await capturePublishedVersionMetadata(db,f.editor,id,2);
  }
  await db.query("INSERT INTO batches VALUES($1,'historical','{\"status\":\"published\"}','fixture')",[f.workspaceId]);
  await db.query("INSERT INTO publications VALUES($1,'historical',$2)",[f.workspaceId,{batchId:'historical',versions:Object.fromEntries(ids.map(id=>[id,2]))}]);
 });
 for(const id of ids){
  await f.pool.query("UPDATE pages SET data=jsonb_set(data,'{tags}','[\"current-tag\"]') WHERE workspace_id=$1 AND id=$2",[f.workspaceId,id]);
  await f.pool.query("UPDATE workflow_document_state SET data=' {\"properties\":{\"owner\":\"current-owner\"}}',revision=revision+1 WHERE workspace_id=$1 AND page_id=$2",[f.workspaceId,id]);
 }
}
async function proposeRestore(f:Awaited<ReturnType<typeof setup>>,ids=['topic']){
 const preview=await f.versions.previewRestore(f.editor,{batchId:'historical',pages:ids.map(pageId=>({pageId,fields:['tags','properties']}))});
 expect(preview.conflicts).toEqual([]);
 return f.versions.proposeRestoreSelection(f.editor,{previewHash:preview.previewHash,reason:'검토할 속성 복원'});
}
test('canonical publication captures immutable metadata and metadata-only settings edits leave history',async()=>{
 const f=await setup();try{
  const b=await f.runtime.core.propose(f.editor,[draft()],['source-a']);await f.runtime.core.approve(f.ctx,b.id,b.hash);await f.runtime.core.publish(f.ctx,b.id,b.hash,'normal-publication');
  expect((await f.versions.version(f.reader,'topic',2)).metadata.known).toBe(true);
  const wf=new WorkflowService(f.pool,f.runtime,authorizeInTransaction);
  await wf.setDocumentState(f.editor,'topic',{expectedRevision:0,properties:{owner:'new-owner'},reason:'담당 변경'});
  const history=await f.versions.metadataHistory(f.reader,'topic');
  expect(history.items).toHaveLength(1);expect(history.items[0].after.properties).toEqual({owner:'new-owner'});
  expect((await f.versions.version(f.reader,'topic',2)).metadata.snapshot?.properties).toEqual({});
 }finally{await f.pool.end();}
});
test('real approve and publish apply exact metadata restore and snapshot it without restoring ACL',async()=>{
 const f=await setup();try{
  await oldPublication(f);const b=await proposeRestore(f);
  const before=(await f.pool.query("SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",[f.workspaceId])).rows;
  await f.runtime.core.approve(f.ctx,b.batchId,b.hash);await f.runtime.core.publish(f.ctx,b.batchId,b.hash,'metadata-restore');
  expect((await f.pool.query("SELECT data->'tags' tags FROM pages WHERE workspace_id=$1 AND id='topic'",[f.workspaceId])).rows[0].tags).toEqual(['historical-tag']);
  const v=await f.versions.version(f.reader,'topic',3);expect(v.metadata).toMatchObject({known:true,snapshot:{tags:['historical-tag'],properties:{owner:'historical-owner'}}});
  expect((await f.pool.query("SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",[f.workspaceId])).rows).toEqual(before);
  expect(await f.runtime.core.publish(f.ctx,b.batchId,b.hash,'metadata-restore-retry')).toMatchObject({versions:{topic:3}});
 }finally{await f.pool.end();}
});
test.each(['approve','reject'] as const)('selective %s keeps only selected restore plans bound to derived hash through publication',async decision=>{
 const f=await setup();try{
  await oldPublication(f,['topic','second']);
  const preview=await f.versions.previewRestore(f.editor,{batchId:'historical',pages:[{pageId:'topic',fields:['tags','properties']}]});
  const plan=(await f.pool.query('SELECT payload FROM version_restore_previews WHERE workspace_id=$1 AND hash=$2',[f.workspaceId,preview.previewHash])).rows[0].payload.plans;
  const proposed=await f.runtime.core.propose(f.editor,[{...draft('topic',2),title:plan[0].next.title,summary:plan[0].next.summary,content:plan[0].content,links:plan[0].next.relations,sourceIds:plan[0].sourceIds},draft('second',2)],['source-a'],{versionMetadataPlans:plan});
  const b={batchId:proposed.id,hash:proposed.hash};
  // These independent fixtures have no cross-page provenance; choose one to retain in either decision mode.
  const chosen=decision==='approve'?'topic':'second';
  const result=await f.versions.decideSelection(f.ctx,{batchId:b.batchId,expectedHash:b.hash,pageIds:[chosen],decision,reasons:{[chosen]:'독립 속성 검토'}});
  const plans=(await f.pool.query("SELECT page_id,batch_hash FROM version_restore_plans WHERE workspace_id=$1 AND batch_id=$2",[f.workspaceId,result.batchId])).rows;
  expect(plans).toEqual([{page_id:'topic',batch_hash:result.hash}]);
  expect((await f.pool.query("SELECT 1 FROM approvals WHERE workspace_id=$1 AND batch_id=$2",[f.workspaceId,result.batchId])).rowCount).toBe(0);
  await f.runtime.core.approve(f.ctx,result.batchId!,result.hash!);await f.runtime.core.publish(f.ctx,result.batchId!,result.hash!,'derived-'+decision);
  expect((await f.versions.version(f.reader,'topic',3)).metadata.snapshot?.tags).toEqual(['historical-tag']);
  expect((await f.pool.query("SELECT data->'tags' tags FROM pages WHERE workspace_id=$1 AND id='second'",[f.workspaceId])).rows[0].tags).toEqual(['current-tag']);
 }finally{await f.pool.end();}
});
test('metadata changes after approval and missing restore plans block publication',async()=>{
 const f=await setup();try{
  await oldPublication(f);const b=await proposeRestore(f);await f.runtime.core.approve(f.ctx,b.batchId,b.hash);
  await f.pool.query("UPDATE pages SET data=jsonb_set(data,'{tags}','[\"changed-after-approval\"]') WHERE workspace_id=$1 AND id='topic'",[f.workspaceId]);
  await expect(f.runtime.core.publish(f.ctx,b.batchId,b.hash,'stale-plan')).rejects.toThrow();
 }finally{await f.pool.end();}
});
test('missing restore plan cannot be silently treated as ordinary content review',async()=>{
 const f=await setup();try{
  await oldPublication(f);const next=await proposeRestore(f);
  await expect(f.pool.query("DELETE FROM version_restore_plans WHERE workspace_id=$1 AND batch_id=$2",[f.workspaceId,next.batchId])).rejects.toThrow("VERSION_HISTORY_IMMUTABLE");
  expect((await f.pool.query("SELECT max(number) n FROM versions WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId])).rows[0].n).toBe(2);
 }finally{await f.pool.end();}
});

test('required properties evaluate the restored projection without rewriting the approved current state',async()=>{
 const f=await setup();try{
  await oldPublication(f);
  await f.pool.query("UPDATE workflow_document_state SET data='{\"properties\":{}}',revision=revision+1 WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId]);
  await f.pool.query("INSERT INTO governance_type_policies VALUES($1,'*',1,ARRAY['owner'],'block',NULL)",[f.workspaceId]);
  const b=await proposeRestore(f);await f.runtime.core.approve(f.ctx,b.batchId,b.hash);
  expect((await f.pool.query("SELECT data->'properties' p FROM workflow_document_state WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId])).rows[0].p).toEqual({});
  await f.runtime.core.publish(f.ctx,b.batchId,b.hash,'required-properties');
  expect((await f.versions.version(f.reader,'topic',3)).metadata.snapshot?.properties).toEqual({owner:'historical-owner'});
 }finally{await f.pool.end();}
});
test('trusted projection cannot substitute an unrelated draft and claimed missing plans fail closed',async()=>{
 const f=await setup();try{
  await oldPublication(f);
  const preview=await f.versions.previewRestore(f.editor,{batchId:'historical',pages:[{pageId:'topic',fields:['properties']}]});
  const plans=(await f.pool.query('SELECT payload FROM version_restore_previews WHERE workspace_id=$1 AND hash=$2',[f.workspaceId,preview.previewHash])).rows[0].payload.plans;
  await expect(f.runtime.core.propose(f.editor,[draft('topic',2)],['source-a'],{versionMetadataPlans:plans})).rejects.toThrow('VALIDATION_FAILED');
  const {digest}=await import('../../publication');
  const b=await f.runtime.core.propose(f.editor,[draft('topic',2)],['source-a'],{onCreated:async(db,r)=>{
   const data=(await db.query('SELECT data FROM batches WHERE workspace_id=$1 AND id=$2',[f.workspaceId,r.id])).rows[0].data;
   data.versionRestorePlanHash=digest(plans);
   const {status:_s,approvedFingerprint:_f,requestAuthorizationPending:_p,reviewWarnings:_w,...content}=data;
   await db.query('UPDATE batches SET data=$3,hash=$4 WHERE workspace_id=$1 AND id=$2',[f.workspaceId,r.id,data,digest(content)]);
  }});
  await expect(f.runtime.core.approve(f.ctx,b.id,b.hash)).rejects.toThrow('APPROVAL_STALE');
 }finally{await f.pool.end();}
});
