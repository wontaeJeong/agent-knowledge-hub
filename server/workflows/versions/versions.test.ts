import {expect,test} from "vitest";
import {fixture,adoptLegacyFixture,page} from "../../test-support";
import {transaction} from "../../database";
import {authorizeInTransaction} from "../../access/index";
import {VersionService,capturePublishedVersionMetadata,beginVersionMetadataChange,finishVersionMetadataChange,applyApprovedVersionMetadataPlans} from "./service";
import {compareText,segmentAnchors,resolveAnchor} from "./diff";
import {RuntimeService} from "../../runtime/knowledge";

async function setup(){const f=await fixture();await adoptLegacyFixture(f.pool,f.workspaceId);return {...f,service:new VersionService(f.pool,authorizeInTransaction)};}
test("old metadata is explicitly unknown; captured snapshots/events are immutable and current revoked sources hide all history",async()=>{
 const f=await setup();try{
  expect((await f.service.version(f.reader,"topic",1)).metadata).toMatchObject({known:false});
  await expect(transaction(f.pool,f.workspaceId,db=>capturePublishedVersionMetadata(db,f.editor,"topic",1))).rejects.toThrow("VERSION_METADATA_OUTSIDE_PUBLICATION");
  await transaction(f.pool,f.workspaceId,async db=>{await db.query("INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",[f.workspaceId,{properties:{owner:"old"},environment:{cluster:"test"}}]);await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)",[f.workspaceId,{...page.versions[0],number:2}]);await capturePublishedVersionMetadata(db,f.editor,"topic",2);});
  expect((await f.service.version(f.reader,"topic",2)).metadata.snapshot).toMatchObject({properties:{owner:"old"},environment:{cluster:"test"},title:page.title});
  await transaction(f.pool,f.workspaceId,async db=>{const token=await beginVersionMetadataChange(db,f.editor,"topic");await db.query("UPDATE workflow_document_state SET revision=revision+1,data=$2 WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId,{properties:{owner:"new"}}]);await finishVersionMetadataChange(db,f.editor,token,"담당 속성 변경");});
  expect((await f.service.metadataHistory(f.reader,"topic")).items[0].after.properties).toEqual({owner:"new"});
  expect((await f.service.version(f.reader,"topic",2)).metadata.snapshot?.properties).toEqual({owner:"old"});
  await expect(f.pool.query("UPDATE version_metadata SET snapshot='{}' WHERE workspace_id=$1",[f.workspaceId])).rejects.toThrow("VERSION_HISTORY_IMMUTABLE");
  await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",[f.workspaceId]);
  await expect(f.service.version(f.reader,"topic",2)).rejects.toThrow("NOT_FOUND");
 }finally{await f.pool.end();}
});

test("line/code/table changes preserve fixed positions; bounded mode never silently drops text; anchor moves/deletions/duplicates are explicit",()=>{
 const d=compareText("# 제목\n\n```ts\nconst a=1;\n```\n\n| A | B |\n| 1 | 2 |","# 제목\n\n```ts\nconst a=2;\n```\n\n| A | B |\n| 1 | 3 |");
 expect(d.lines.filter(l=>l.kind==="delete").map(l=>l.fromLine)).toContain(4);
 expect(d.lines.filter(l=>l.kind==="add").map(l=>l.text)).toContain("| 1 | 3 |");
 const old=segmentAnchors("p",1,"one\n\ntwo\n\nthree"),moved=segmentAnchors("p",2,"three\n\none\n\ntwo",old.anchors);
 expect(resolveAnchor(old.anchors[0],moved.anchors).status).toBe("moved");
 expect(resolveAnchor(old.anchors[1],segmentAnchors("p",3,"one\n\nthree",old.anchors).anchors).status).toBe("deleted");
 const duplicates=segmentAnchors("p",4,"same\n\nsame");expect(new Set(duplicates.anchors.map(a=>a.id)).size).toBe(2);
 expect(resolveAnchor(duplicates.anchors[0],segmentAnchors("p",5,"same\n\nsame",duplicates.anchors).anchors).status).toBe("ambiguous");
 const long=compareText(Array(4500).fill("old").join("\n"),Array(4500).fill("new").join("\n"));expect(long.mode).toBe("bounded");expect(long.lines.filter(l=>l.kind==="delete")).toHaveLength(4500);
});

test("eight-document partial selection denies open dependency edges and creates only a new attributed pending independent batch",async()=>{
 const f=await setup();try{
  const runtime=new RuntimeService(f.pool),updates=Array.from({length:8},(_,i)=>({id:"doc-"+i,title:"문서 "+i,summary:"근거",content:"자료 내용 "+i,scope:"team" as const,baseVersion:0,sourceIds:["source-a"],links:i<3?["doc-"+(i+1)]:[],facts:[]}));
  const b=await runtime.core.propose(f.editor,updates,["source-a"]);
  const blocked=await f.service.previewDecision(f.ctx,{batchId:b.id,expectedHash:b.hash,pageIds:["doc-0"],decision:"approve"});expect(blocked.allowed).toBe(false);expect(blocked.edges).toContainEqual({from:"doc-0",to:"doc-1",kind:"link"});
  await expect(f.service.decideSelection(f.ctx,{batchId:b.id,expectedHash:b.hash,pageIds:["doc-0"],decision:"approve",reasons:{"doc-0":"선택"}})).rejects.toThrow("DEPENDENCY_CLOSURE_REQUIRED");
   await runtime.core.approve(f.ctx,b.id,b.hash);
   const derived=await f.service.decideSelection(f.ctx,{batchId:b.id,expectedHash:b.hash,pageIds:["doc-6","doc-7"],decision:"approve",reasons:{"doc-6":"독립 변경","doc-7":"독립 변경"}});
  expect(derived.batchId).not.toBe(b.id);
  if(!derived.batchId||!derived.hash)throw Error("EXPECTED_DERIVED_BATCH");
  const row=(await f.pool.query("SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",[f.workspaceId,derived.batchId])).rows[0];expect(row.data.status).toBe("pending");expect(row.data.proposedBy).toBe("editor");expect(row.data.updates).toHaveLength(2);expect(row.hash).toBe(derived.hash);
  expect((await f.pool.query("SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",[f.workspaceId,derived.batchId])).rows[0].principal_id).toBe("editor");
  await expect(runtime.core.approve(f.editor,derived.batchId,derived.hash)).rejects.toThrow("FORBIDDEN");
  expect((await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1",[f.workspaceId])).rowCount).toBe(0);
 }finally{await f.pool.end();}
});

test("restore preview binds later human edits/settings and metadata plans never apply before reviewed exact publication",async()=>{
 const f=await setup();try{
  await transaction(f.pool,f.workspaceId,async db=>{await db.query("INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",[f.workspaceId,{properties:{owner:"before"}}]);await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)",[f.workspaceId,{...page.versions[0],number:2}]);await capturePublishedVersionMetadata(db,f.editor,"topic",2);});
  const old={...page.versions[0],number:3,content:"later human text",producer:{kind:"user-submission"},sourceIds:["source-a"]};
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',3,$2)",[f.workspaceId,old]);
  await f.pool.query("INSERT INTO batches VALUES($1,'fixture-publication','{\"status\":\"published\"}','fixture')",[f.workspaceId]);
  await f.pool.query("INSERT INTO publications VALUES($1,'fixture-publication',$2)",[f.workspaceId,{batchId:"fixture-publication",versions:{topic:2}}]);
  const preview=await f.service.previewRestore(f.editor,{batchId:"fixture-publication",pages:[{pageId:"topic",fields:["content","properties"]}]});expect(preview.conflicts).toContainEqual(expect.objectContaining({pageId:"topic",field:"content",code:"LATER_HUMAN_EDIT"}));
  const safe=await f.service.previewRestore(f.editor,{batchId:"fixture-publication",pages:[{pageId:"topic",fields:["properties"]}]});
  const proposed=await f.service.proposeRestoreSelection(f.editor,{previewHash:safe.previewHash,reason:"속성만 복원"});
  expect((await f.service.version(f.reader,"topic",3)).content).toBe("later human text");
  const plan=(await f.pool.query("SELECT * FROM version_restore_plans WHERE workspace_id=$1 AND batch_id=$2",[f.workspaceId,proposed.batchId])).rows[0];expect(plan).toBeTruthy();
  await expect(transaction(f.pool,f.workspaceId,db=>applyApprovedVersionMetadataPlans(db,f.ctx,proposed.batchId,proposed.hash,{topic:3}))).rejects.toThrow("APPROVAL_STALE");
  await f.pool.query("UPDATE workflow_document_state SET revision=revision+1 WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId]);
  await expect(f.service.proposeRestoreSelection(f.editor,{previewHash:safe.previewHash,reason:"다시 시도"})).rejects.toThrow("STALE_VERSION");
 }finally{await f.pool.end();}
});

test("trusted pre-create preparation and the existing onCreated fence roll back together without staging live metadata or ACL changes",async()=>{
 const f=await setup();try{
  const runtime=new RuntimeService(f.pool),updates=[{id:"topic",title:"주제",summary:"검토 후보",content:"검토할 내용",scope:"team" as const,baseVersion:1,sourceIds:["source-a"],links:[],facts:[]}];
  const original=await runtime.core.propose(f.editor,updates,["source-a"]);
  const live=async()=>({pages:(await f.pool.query("SELECT data FROM pages WHERE workspace_id=$1 ORDER BY id",[f.workspaceId])).rows,settings:(await f.pool.query("SELECT * FROM workflow_document_state WHERE workspace_id=$1 ORDER BY page_id",[f.workspaceId])).rows,readers:(await f.pool.query("SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",[f.workspaceId])).rows,owners:(await f.pool.query("SELECT m.* FROM access_team_members m JOIN access_spaces s ON s.namespace_id=m.team_id WHERE s.workspace_id=$1 ORDER BY principal_id",[f.workspaceId])).rows});
  const before=await live();
  await expect(runtime.core.propose(f.editor,updates,["source-a"],{
    onBeforeCreate:async db=>{await db.query("UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",[f.workspaceId,original.id]);},
    onCreated:async()=>{throw Error("CREATION_FENCE_FAILED");},
  })).rejects.toThrow("CREATION_FENCE_FAILED");
  expect((await f.pool.query("SELECT id,data->>'status' AS status FROM batches WHERE workspace_id=$1",[f.workspaceId])).rows).toEqual([{id:original.id,status:"pending"}]);
  expect(await live()).toEqual(before);
  let called=false;
  await expect(runtime.core.propose({...f.editor,authorization:{revalidate:async()=>{},assertSession:async()=>{throw Error("UNAUTHENTICATED");}}},updates,["source-a"],{onBeforeCreate:async()=>{called=true;}})).rejects.toThrow("UNAUTHENTICATED");
  expect(called).toBe(false);
 }finally{await f.pool.end();}
});
