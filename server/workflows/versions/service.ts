import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {Context} from "../../service";
import {transaction} from "../../database";
import {authorizeActionDb,type Action} from "../../access/index";
import {audit,loadState,requireRead} from "../../repository";
import {captureEnvelope,visiblePageIds,fingerprint,versionProvenance,type InputEnvelope} from "../../provenance";
import {current,draftOf,type Draft,type Batch} from "../../../src/domain/wiki";
import {propose} from "../../publication";
import {compareText,segmentAnchors,resolveAnchor,type Anchor} from "./diff";
import {currentMetadata,validatePlannedMetadata,type MetadataSnapshot,type RestorePlan} from "./metadata";
export {capturePublishedVersionMetadata,beginVersionMetadataChange,finishVersionMetadataChange,assertVersionPlansCurrent,applyApprovedVersionMetadataPlans,validateVersionMetadataPlans} from "./metadata";
export type {RestorePlan,MetadataSnapshot} from "./metadata";
export type VersionAuthorizer=(db:PoolClient,ctx:Context,action:string,resource?:{kind:"page"|"source";id:string})=>Promise<void>;
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().positive();
const why=z.string().trim().min(1).max(2000);
export const restoreFields=["content","title","summary","category","tags","properties","environment","parentId","lifecycle","relations","sources"] as const;
type Field=typeof restoreFields[number];
const selectionSchema=z.object({pageId:id,fields:z.array(z.enum(restoreFields)).min(1).max(11),merged:z.object({content:z.string().min(1).max(100000),title:z.string().min(1).max(300).optional(),summary:z.string().max(10000).optional(),category:z.string().min(1).max(100).optional(),tags:z.array(z.string().max(100)).max(100).optional(),properties:z.record(z.string().max(100),z.string().max(2000)).optional(),environment:z.union([z.string().max(2000),z.record(z.string().max(100),z.string().max(2000))]).nullable().optional(),parentId:id.nullable().optional(),lifecycle:z.enum(["active","archived","trash"]).optional(),relations:z.array(id).max(100).optional()}).partial().strict().optional()}).strict();
const restoreInput=z.object({batchId:id,pages:z.array(selectionSchema).min(1).max(20)}).strict();
const decisionSchema=z.object({batchId:id,expectedHash:hash,pageIds:z.array(id).min(1).max(20),decision:z.enum(["approve","reject"])}).strict();
type Decision=z.infer<typeof decisionSchema>;
export type Edge={from:string;to:string;kind:"link"|"input"|"provenance"};
type RuntimeBatch=Batch&{proposedBy?:string;importAuthorId?:string;importRunId?:string;responsibleUserId?:string;producer?:unknown;inputEnvelope?:InputEnvelope;contextDependencyIds?:string[];versionDecisionParent?:string;versionRestorePlanHash?:string;reviewWarnings?:unknown};
type Producer=NonNullable<NonNullable<Parameters<typeof propose>[4]>["producer"]>;
type TrustedProposalOptions=NonNullable<Parameters<typeof propose>[4]>&{onBeforeCreate?:(db:PoolClient)=>Promise<void>;versionMetadataPlans?:RestorePlan[]};
const fixedHash=({status:_status,approvedFingerprint:_fingerprint,requestAuthorizationPending:_pending,reviewWarnings:_warnings,...body}:RuntimeBatch&{requestAuthorizationPending?:boolean})=>fingerprint(body);
function closure(batch:RuntimeBatch,selected:Set<string>,state:Awaited<ReturnType<typeof loadState>>):Edge[]{
 const updates=new Set(batch.updates.map(d=>d.id)),edges:Edge[]=[];
 for(const d of batch.updates)if(selected.has(d.id)){
  for(const target of d.links)if(updates.has(target)&&!selected.has(target))edges.push({from:d.id,to:target,kind:"link"});
  for(const target of new Set([...(batch.contextDependencyIds??[]),...(batch.inputEnvelope?.pageIds??[])]))if(updates.has(target)&&!selected.has(target))edges.push({from:d.id,to:target,kind:"input"});
  const old=state.pages.find(p=>p.id===d.id);for(const target of old?.versions.flatMap(v=>versionProvenance(v).pageIds)??[])if(updates.has(target)&&!selected.has(target))edges.push({from:d.id,to:target,kind:"provenance"});
 }
 return [...new Map(edges.map(e=>[`${e.from}:${e.to}:${e.kind}`,e])).values()];
}

export class VersionService {
 constructor(readonly pool:Pool,readonly authorize:VersionAuthorizer){}
 private async permitted(db:PoolClient,ctx:Context,action:Action,resource?:{kind:"page"|"source";id:string}){await ctx.authorization?.assertSession(db);await authorizeActionDb(db,ctx,action,resource);await this.authorize(db,ctx,action,resource);}
 private async run<T>(ctx:Context,action:Action,work:(db:PoolClient)=>Promise<T>){await ctx.authorization?.revalidate();const result=await transaction(this.pool,ctx.workspaceId,async db=>{await this.permitted(db,ctx,action);return work(db);});await ctx.authorization?.revalidate();return result;}
 private async human(db:PoolClient,ctx:Context){if(ctx.credentialId||!(await db.query("SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",[ctx.principalId])).rowCount)throw Error("FORBIDDEN");}
 private async page(db:PoolClient,ctx:Context,pageId:string,number?:number){
  id.parse(pageId);await this.permitted(db,ctx,"knowledge.read",{kind:"page",id:pageId});
  await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id:pageId,version:number});
  const state=await loadState(db,ctx.workspaceId);if(!(await visiblePageIds(db,ctx,state)).has(pageId))throw Error("NOT_FOUND");
  const page=state.pages.find(p=>p.id===pageId)!;if(number&&!page.versions.some(v=>v.number===number))throw Error("NOT_FOUND");
  if(number){const v=page.versions.find(v=>v.number===number)!;for(const sourceId of new Set([...v.sourceIds,...versionProvenance(v).sourceIds]))await requireRead(db,ctx,"source",sourceId);for(const dependency of versionProvenance(v).pageIds)if(!(await visiblePageIds(db,ctx,state)).has(dependency))throw Error("NOT_FOUND");}
  return page;
 }
 private async versionDb(db:PoolClient,ctx:Context,pageId:string,number:number){
  const p=await this.page(db,ctx,pageId,number),v=p.versions.find(v=>v.number===number)!;
  const m=(await db.query("SELECT snapshot,snapshot_hash,anchors FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 AND number=$3",[ctx.workspaceId,pageId,number])).rows[0];
  if(m)for(const source of m.snapshot.sources??[])await requireRead(db,ctx,"source",source.id);
  if(m?.snapshot.parentId)await this.permitted(db,ctx,"knowledge.read",{kind:"page",id:m.snapshot.parentId});
  return {pageId,number,currentTitle:p.title,content:v.content,at:v.at,attribution:{author:v.author,producer:v.producer??{kind:"unknown"},proposedBy:v.proposedBy??null,publishedBy:v.publishedBy??null},metadata:m?{known:true as const,snapshot:m.snapshot as MetadataSnapshot,hash:m.snapshot_hash}:{known:false as const,snapshot:null,hash:null},anchors:m?.anchors??segmentAnchors(pageId,number,v.content)};
 }
 async version(ctx:Context,pageId:string,number:number){positive.parse(number);return this.run(ctx,"knowledge.read",db=>this.versionDb(db,ctx,pageId,number));}
 async bundles(ctx:Context,offset=0){return this.run(ctx,"knowledge.read",async db=>{
  const rows=(await db.query("SELECT batch_id,result FROM publications WHERE workspace_id=$1 ORDER BY batch_id LIMIT 2501",[ctx.workspaceId])).rows;if(rows.length>2500)throw Error("VERSION_QUERY_LIMIT");
  const visible=[];for(const row of rows)try{const pages=[];for(const [pageId,version] of Object.entries(row.result.versions as Record<string,number>)){const p=await this.page(db,ctx,pageId,version);pages.push({pageId,title:p.title,number:version});}visible.push({batchId:row.batch_id,pages});}catch(e){if(!(e instanceof Error)||e.message!=="NOT_FOUND")throw e;}
  const start=z.number().int().min(0).max(100000).parse(offset);return {items:visible.slice(start,start+25),offset:start,total:visible.length,next:start+25<visible.length?start+25:null};
 });}
 async history(ctx:Context,pageId:string,offset=0){return this.run(ctx,"knowledge.read",async db=>{const p=await this.page(db,ctx,pageId);const allowed=[];for(const v of [...p.versions].sort((a,b)=>b.number-a.number))try{await this.versionDb(db,ctx,pageId,v.number);allowed.push({number:v.number,at:v.at,producer:v.producer??{kind:"unknown"},author:v.author,metadataKnown:!!(await db.query("SELECT 1 FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 AND number=$3",[ctx.workspaceId,pageId,v.number])).rowCount});}catch(e){if(!(e instanceof Error)||e.message!=="NOT_FOUND")throw e;}const start=z.number().int().min(0).max(100000).parse(offset);return {items:allowed.slice(start,start+25),offset:start,total:allowed.length,next:start+25<allowed.length?start+25:null};});}
 async metadataHistory(ctx:Context,pageId:string,offset=0){return this.run(ctx,"knowledge.read",async db=>{await this.page(db,ctx,pageId);const rows=(await db.query("SELECT id,actor_id,reason,before_snapshot,after_snapshot,at FROM version_metadata_events WHERE workspace_id=$1 AND page_id=$2 ORDER BY id DESC",[ctx.workspaceId,pageId])).rows,visible=[];
  for(const row of rows)try{for(const snap of [row.before_snapshot,row.after_snapshot]){for(const src of snap.sources??[])await requireRead(db,ctx,"source",src.id);for(const dependency of Object.keys(snap.versions??{}))await this.page(db,ctx,dependency);if(snap.parentId)await this.page(db,ctx,snap.parentId);}visible.push({id:String(row.id),actorId:row.actor_id,reason:row.reason,before:row.before_snapshot,after:row.after_snapshot,at:row.at});}catch(e){if(!(e instanceof Error)||e.message!=="NOT_FOUND")throw e;}
  const start=z.number().int().min(0).max(100000).parse(offset);return {items:visible.slice(start,start+25),offset:start,total:visible.length,next:start+25<visible.length?start+25:null};});}
 async compareVersions(ctx:Context,pageId:string,from:number,to:number,range:{offset?:number;limit?:number}={}){positive.parse(from);positive.parse(to);const offset=z.number().int().min(0).max(200000).parse(range.offset??0),limit=z.number().int().min(1).max(250).parse(range.limit??25);return this.run(ctx,"knowledge.read",async db=>{const a=await this.versionDb(db,ctx,pageId,from),b=await this.versionDb(db,ctx,pageId,to),fields=[];
  for(const field of restoreFields.filter(f=>f!=="content")){const key=field==="sources"?"sources":field;if(!a.metadata.known||!b.metadata.known)fields.push({field,known:false,before:null,after:null,changed:null});else {const before=a.metadata.snapshot[key as keyof MetadataSnapshot],after=b.metadata.snapshot[key as keyof MetadataSnapshot];fields.push({field,known:true,before,after,changed:fingerprint(before??null)!==fingerprint(after??null)});}}
  const compared=compareText(a.content,b.content);return {pageId,from,to,text:{...compared,lines:compared.lines.slice(offset,offset+limit),offset,totalLines:compared.lines.length,next:offset+limit<compared.lines.length?offset+limit:null},metadata:fields,anchors:a.anchors.anchors.map((anchor:Anchor)=>({original:anchor,...resolveAnchor(anchor,b.anchors.anchors)})),semantic:false};});}
 async resolveCommentAnchor(ctx:Context,commentId:string,targetVersion:number){id.parse(commentId);positive.parse(targetVersion);return this.run(ctx,"knowledge.read",async db=>{
  const comment=(await db.query("SELECT page_id,version,anchor FROM workflow_comments WHERE workspace_id=$1 AND id=$2 AND NOT deleted",[ctx.workspaceId,commentId])).rows[0];if(!comment)throw Error("NOT_FOUND");
  const old=await this.versionDb(db,ctx,comment.page_id,comment.version),next=await this.versionDb(db,ctx,comment.page_id,targetVersion),anchors:Anchor[]=old.anchors.anchors;
  let original=anchors.find(a=>a.id===comment.anchor);
  if(!original&&comment.anchor){const lines=old.content.split("\n"),candidates=anchors.filter(a=>lines.slice(a.startLine-1,a.endLine).join("\n").includes(comment.anchor));if(candidates.length===1)original=candidates[0];else return {status:candidates.length?"ambiguous":"unresolved",resolved:false,original:null,target:null,originalVersion:comment.version,targetVersion,originalHref:`/api/v1/pages/${comment.page_id}/versions/${comment.version}`};}
  return {pageId:comment.page_id,originalVersion:comment.version,targetVersion,original:original??null,...(original?resolveAnchor(original,next.anchors.anchors):{status:"unresolved",resolved:false,target:null}),originalHref:`/api/v1/pages/${comment.page_id}/versions/${comment.version}`};
 });}

 private async batch(db:PoolClient,ctx:Context,batchId:string,expectedHash?:string){
  const row=(await db.query("SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id.parse(batchId)])).rows[0];if(!row||row.data.requestAuthorizationPending)throw Error("NOT_FOUND");
  const batch=row.data as RuntimeBatch;if(expectedHash&&(row.hash!==expectedHash||fixedHash(batch)!==expectedHash))throw Error("APPROVAL_STALE");
  const state=await loadState(db,ctx.workspaceId);for(const sourceId of new Set([...batch.snapshots.map(s=>s.id),...batch.updates.flatMap(d=>d.sourceIds),...(batch.inputEnvelope?.sourceIds??[])]))await requireRead(db,ctx,"source",sourceId);
  const existing=new Set(state.pages.map(p=>p.id));for(const p of new Set([...batch.updates.filter(d=>d.baseVersion>0).map(d=>d.id),...batch.updates.flatMap(d=>d.links).filter(id=>existing.has(id)),...(batch.inputEnvelope?.pageIds??[]),...(batch.contextDependencyIds??[])]))await this.page(db,ctx,p);
  return {batch,hash:row.hash,state};
 }
 private async decisionActor(db:PoolClient,ctx:Context,b:RuntimeBatch){
  await this.human(db,ctx);await this.permitted(db,ctx,"changeset.approve");
  const actual=(await db.query("SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",[ctx.workspaceId,b.id])).rows[0]?.principal_id;
  if(!actual)throw Error("AUTHOR_UNKNOWN");
  if([actual,b.proposedBy,b.importAuthorId,b.responsibleUserId].includes(ctx.principalId))throw Error("FORBIDDEN");
  if(!(await db.query("SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",[ctx.workspaceId,ctx.principalId])).rowCount)throw Error("FORBIDDEN");
  await authorizeActionDb(db,{workspaceId:ctx.workspaceId,principalId:actual},"changeset.propose");
  return {actual,proposedBy:b.proposedBy??actual,importAuthorId:b.importAuthorId??null,responsibleUserId:b.responsibleUserId??actual,producer:b.producer??{kind:"unknown"}};
 }
 async previewDecision(ctx:Context,input:unknown){const d=decisionSchema.parse(input);return this.run(ctx,"changeset.approve",async db=>{
  const {batch,state}=await this.batch(db,ctx,d.batchId,d.expectedHash);await this.decisionActor(db,ctx,batch);
  if(!["pending","approved"].includes(batch.status))throw Error("STALE_VERSION");const requested=new Set(d.pageIds);if(requested.size!==d.pageIds.length||d.pageIds.some(id=>!batch.updates.some(p=>p.id===id)))throw Error("VALIDATION_FAILED");
  const selected=d.decision==="approve"?requested:new Set(batch.updates.map(p=>p.id).filter(id=>!requested.has(id))),edges=closure(batch,selected,state);return {allowed:!edges.length,edges,selectedPageIds:[...selected],originalRetired:true,requiresIndependentReview:true};
 });}
 async decideSelection(ctx:Context,input:unknown){const parsed=z.object({...decisionSchema.shape,reasons:z.record(id,why)}).strict().parse(input),d:Decision=parsed;
  const ready=await this.run(ctx,"changeset.approve",async db=>{const checked=await this.batch(db,ctx,d.batchId,d.expectedHash),attribution=await this.decisionActor(db,ctx,checked.batch);if(!["pending","approved"].includes(checked.batch.status))throw Error("STALE_VERSION");
   const ids=new Set(d.pageIds);if(ids.size!==d.pageIds.length||d.pageIds.some(id=>!checked.batch.updates.some(p=>p.id===id)||!parsed.reasons[id]))throw Error("VALIDATION_FAILED");
   const chosen=new Set(checked.batch.updates.map(p=>p.id).filter(id=>d.decision==="approve"?ids.has(id):!ids.has(id)));if(closure(checked.batch,chosen,checked.state).length)throw Error("DEPENDENCY_CLOSURE_REQUIRED");
   return {...checked,attribution,updates:checked.batch.updates.filter(p=>chosen.has(p.id)),stateHash:fingerprint(checked.state)};
  });
  let result:{batchId:string|null;hash:string|null;decisionId:string}|undefined,retired=false;
  const retire=async(db:PoolClient)=>{const original=await this.batch(db,ctx,d.batchId,d.expectedHash);await this.decisionActor(db,ctx,original.batch);if(fingerprint(original.state)!==ready.stateHash||!["pending","approved"].includes(original.batch.status))throw Error("STALE_VERSION");await db.query("UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,d.batchId]);await db.query("DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",[ctx.workspaceId,d.batchId]);retired=true;};
  const write=async(db:PoolClient,created?:{id:string;hash:string})=>{
   const original=await this.batch(db,ctx,d.batchId,d.expectedHash);await this.decisionActor(db,ctx,original.batch);if(!["pending","approved"].includes(original.batch.status)&&!(retired&&original.batch.status==="rejected"))throw Error("STALE_VERSION");
   const decisionId=randomUUID();let derivedHash:string|null=null;
   if(created){const r=(await db.query("SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,created.id])).rows[0];const data={...r.data,proposedBy:ready.attribution.proposedBy,responsibleUserId:ready.attribution.responsibleUserId,producer:ready.attribution.producer,versionDecisionParent:d.batchId,...(ready.batch.importAuthorId?{importAuthorId:ready.batch.importAuthorId}:{}),...(ready.batch.importRunId?{importRunId:ready.batch.importRunId}:{})};derivedHash=fixedHash(data);await db.query("UPDATE batches SET data=$3,hash=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,created.id,data,derivedHash]);await db.query("UPDATE access_batch_authors SET principal_id=$3 WHERE workspace_id=$1 AND batch_id=$2",[ctx.workspaceId,created.id,ready.attribution.actual]);}
   await db.query("INSERT INTO versions_decisions(id,workspace_id,original_batch_id,original_hash,actor_id,decision,selected_page_ids,reasons,attribution,derived_batch_id,derived_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[decisionId,ctx.workspaceId,d.batchId,d.expectedHash,ctx.principalId,d.decision,d.pageIds,parsed.reasons,ready.attribution,created?.id??null,derivedHash]);
   await db.query("UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,d.batchId]);await db.query("DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",[ctx.workspaceId,d.batchId]);await audit(db,ctx,"versions.partial-decision",decisionId);result={batchId:created?.id??null,hash:derivedHash,decisionId};
  };
  if(!ready.updates.length)await transaction(this.pool,ctx.workspaceId,db=>write(db));else {const options:TrustedProposalOptions={mode:ready.batch.mode,dependencyIds:ready.batch.contextDependencyIds,inputEnvelope:ready.batch.inputEnvelope,producer:ready.attribution.producer as Producer,onBeforeCreate:retire,onCreated:write};await propose(this.pool,ctx,ready.updates,ready.batch.snapshots.map(s=>s.id),options);}
  return {...result!,status:result?.batchId?"pending":"rejected",originalStatus:"rejected",requiresIndependentReview:!!result?.batchId};
 }

 private async restorePlan(db:PoolClient,ctx:Context,input:z.infer<typeof restoreInput>){
  await this.human(db,ctx);const published=(await db.query("SELECT result FROM publications WHERE workspace_id=$1 AND batch_id=$2",[ctx.workspaceId,input.batchId])).rows[0];if(!published)throw Error("NOT_FOUND");
  const plans:RestorePlan[]=[],conflicts:{pageId:string;field:string;code:string}[]=[];
  for(const selection of input.pages){const target=published.result.versions[selection.pageId];if(!target)throw Error("NOT_FOUND");const old=await this.versionDb(db,ctx,selection.pageId,target),p=await this.page(db,ctx,selection.pageId),base=await currentMetadata(db,ctx,p.id),fields=[...new Set(selection.fields)],next=structuredClone(base),merged=selection.merged??{};
   if(fields.length!==selection.fields.length)throw Error("VALIDATION_FAILED");
   if(fields.some(f=>["properties","environment","lifecycle","parentId","category"].includes(f)))await this.permitted(db,ctx,"knowledge.protect",{kind:"page",id:p.id});
   const laterHuman=p.versions.some(v=>v.number>target&&(!v.producer||!["model","structural"].includes(v.producer.kind)));
   if(fields.includes("content")&&laterHuman&&merged.content===undefined)conflicts.push({pageId:p.id,field:"content",code:"LATER_HUMAN_EDIT"});
   for(const field of fields.filter(f=>!["content","sources"].includes(f))){const k=field as Exclude<Field,"content"|"sources">,override=merged[k as keyof typeof merged];if(override!==undefined)(next as unknown as Record<string,unknown>)[k]=override;else if(old.metadata.known)(next as unknown as Record<string,unknown>)[k]=old.metadata.snapshot[k as keyof MetadataSnapshot];else conflicts.push({pageId:p.id,field,code:"METADATA_UNKNOWN"});}
   const sourceIds=[...new Set([...current(p).sourceIds,...(old.metadata.known?old.metadata.snapshot.sources.map(s=>s.id):[]),...(p.versions.find(v=>v.number===target)!.sourceIds),...versionProvenance(current(p)).sourceIds])];for(const sourceId of sourceIds)await requireRead(db,ctx,"source",sourceId);
   const content=fields.includes("content")?(merged.content??old.content):current(p).content;
   const policy=(await db.query("SELECT policy_version FROM access_spaces WHERE workspace_id=$1",[ctx.workspaceId])).rows[0];
   const plan:RestorePlan={pageId:p.id,targetVersion:target,baseVersion:current(p).number,settingsRevision:base.settingsRevision,policyVersion:policy.policy_version,fields,next,currentHash:fingerprint(base),content,sourceIds,dependencies:[...new Set([...Object.keys(base.versions),...next.relations,...versionProvenance(current(p)).pageIds])].filter(id=>id!==p.id)};
   await validatePlannedMetadata(db,ctx,plan);plans.push(plan);
  }
  if(new Set(plans.map(p=>p.pageId)).size!==plans.length)throw Error("VALIDATION_FAILED");
  return {batchId:input.batchId,selection:input,plans,conflicts,scope:"current-permissions"};
 }
 async previewRestore(ctx:Context,input:unknown){const d=restoreInput.parse(input);return this.run(ctx,"changeset.propose",async db=>{
  const payload=await this.restorePlan(db,ctx,d),previewHash=fingerprint({principalId:ctx.principalId,...payload});
  await db.query("INSERT INTO version_restore_previews(workspace_id,principal_id,hash,payload,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '15 minutes') ON CONFLICT DO NOTHING",[ctx.workspaceId,ctx.principalId,previewHash,payload]);
  return {previewHash,conflicts:payload.conflicts,items:payload.plans.map(p=>({pageId:p.pageId,targetVersion:p.targetVersion,currentVersion:p.baseVersion,fields:p.fields,metadata:p.next,content:p.content})),requiresIndependentReview:true,expiresInSeconds:900};
 });}
 async proposeRestoreSelection(ctx:Context,input:unknown){const d=z.object({previewHash:hash,reason:why}).strict().parse(input);
  const prepared=await this.run(ctx,"changeset.propose",async db=>{
   await this.human(db,ctx);const row=(await db.query("SELECT payload FROM version_restore_previews WHERE workspace_id=$1 AND principal_id=$2 AND hash=$3 AND expires_at>clock_timestamp()",[ctx.workspaceId,ctx.principalId,d.previewHash])).rows[0];if(!row)throw Error("NOT_FOUND");
   const current=await this.restorePlan(db,ctx,row.payload.selection);if(fingerprint({principalId:ctx.principalId,...current})!==d.previewHash)throw Error("STALE_VERSION");if(current.conflicts.length)throw Error("RESTORE_CONFLICT");
   const state=await loadState(db,ctx.workspaceId),updates=current.plans.map(p=>({...draftOf(state.pages.find(page=>page.id===p.pageId)!),title:p.next.title,summary:p.next.summary,content:p.content,links:p.next.relations,sourceIds:p.sourceIds}));
   const sourceIds=[...new Set(current.plans.flatMap(p=>p.sourceIds))],dependencies=[...new Set(current.plans.flatMap(p=>p.dependencies))];
   return {payload:current,updates,sourceIds,dependencies,envelope:await captureEnvelope(db,ctx,state,[...new Set([...current.plans.map(p=>p.pageId),...dependencies])],sourceIds),stateHash:fingerprint(state)};
  });
  let result:{batchId:string;hash:string}|undefined;
  const options:TrustedProposalOptions={expectedStateHash:prepared.stateHash,dependencyIds:prepared.dependencies,inputEnvelope:prepared.envelope,producer:{kind:"structural"},versionMetadataPlans:prepared.payload.plans,onCreated:async(db,created)=>{
   for(const plan of prepared.payload.plans)await validatePlannedMetadata(db,ctx,plan);
   const planHash=fingerprint(prepared.payload.plans),r=(await db.query("SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,created.id])).rows[0];
   const data={...r.data,title:d.reason,versionRestorePlanHash:planHash,versionMetadataChanges:prepared.payload.plans.map(p=>({pageId:p.pageId,targetVersion:p.targetVersion,fields:p.fields,next:p.next}))};
   const finalHash=fixedHash(data);await db.query("UPDATE batches SET data=$3,hash=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,created.id,data,finalHash]);
   for(const plan of prepared.payload.plans)await db.query("INSERT INTO version_restore_plans VALUES($1,$2,$3,$4,$5,$6)",[ctx.workspaceId,created.id,finalHash,plan.pageId,fingerprint(plan),plan]);
   await audit(db,ctx,"versions.restore-propose",created.id);result={batchId:created.id,hash:finalHash};
  }};await propose(this.pool,ctx,prepared.updates,prepared.sourceIds,options);
  return {...result!,status:"pending",requiresIndependentReview:true};
 }
}
