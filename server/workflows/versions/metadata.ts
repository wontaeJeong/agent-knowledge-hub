import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import type {Context} from "../../service";
import {authorizeActionDb} from "../../access/index";
import {fingerprint} from "../../provenance";
import {segmentAnchors,type Anchor} from "./diff";

export interface MetadataSnapshot {
 pageId:string;number:number;title:string;summary:string;category:string;tags:string[];
 properties:Record<string,string>;environment:unknown;parentId:string|null;lifecycle:string;
 settingsRevision:number;workflowData:Record<string,unknown>;sources:{id:string;hash:string;revision:number}[];
 versions:Record<string,number>;relations:string[];attribution:Record<string,unknown>;bodyHash:string;
}
export async function currentMetadata(db:PoolClient,ctx:Context,pageId:string,number?:number):Promise<MetadataSnapshot> {
 const p=(await db.query("SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,pageId])).rows[0]?.data;
 const v=(await db.query("SELECT number,data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND ($3::integer IS NULL OR number=$3) ORDER BY number DESC LIMIT 1",[ctx.workspaceId,pageId,number??null])).rows[0];
 if(!p||!v)throw Error("NOT_FOUND");
 const w=(await db.query("SELECT revision,parent_id,state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,pageId])).rows[0];
 const sources:MetadataSnapshot["sources"]=[];
 for(const id of [...new Set<string>([...(v.data.sourceIds??[]),...(v.data.provenance?.sourceIds??[])])].sort()){
  const s=(await db.query("SELECT s.data,w.revision FROM sources s LEFT JOIN workflow_source_state w ON w.workspace_id=s.workspace_id AND w.source_id=s.id WHERE s.workspace_id=$1 AND s.id=$2",[ctx.workspaceId,id])).rows[0];
  if(!s)throw Error("NOT_FOUND");sources.push({id,hash:fingerprint(s.data),revision:s.revision??0});
 }
 const versions:Record<string,number>={};
 for(const id of [...new Set<string>([...(p.links??[]),...(v.data.provenance?.pageIds??[])])].sort()){
  const dependency=(await db.query("SELECT max(number)::integer AS number FROM versions WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,id])).rows[0];
  if(!dependency?.number)throw Error("NOT_FOUND");versions[id]=dependency.number;
 }
 const environment=w?.data&&Object.hasOwn(w.data,"environment")?w.data.environment:w?.data?.properties?.environment??null;
 const snapshot:MetadataSnapshot={pageId,number:v.number,title:p.title??"",summary:p.summary??"",category:p.category??"연결된 지식",tags:p.tags??[],properties:w?.data?.properties??{},environment,parentId:w?.parent_id??null,lifecycle:w?.state??"active",settingsRevision:w?.revision??0,workflowData:w?.data??{},sources,versions,relations:p.links??[],bodyHash:fingerprint(v.data.content),attribution:Object.fromEntries(["author","proposedBy","responsibleUserId","publishedBy","producer","batchId","at"].map(k=>[k,v.data[k]??null]))};
 if(Buffer.byteLength(JSON.stringify(snapshot))>1048576)throw Error("VERSION_METADATA_LIMIT");
 return snapshot;
}
/** Trusted publication hook. Call after ALL page/version inserts, before transaction commit. */
export async function capturePublishedVersionMetadata(db:PoolClient,ctx:Context,pageId:string,number:number,_metadata?:unknown) {
 const existing=await db.query("SELECT snapshot_hash FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 AND number=$3",[ctx.workspaceId,pageId,number]);
 if(existing.rowCount)return; // Never reinterpret an already captured historical version.
 const inserted=(await db.query("SELECT 1 FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3 AND xmin::text::bigint=mod(txid_current(),4294967296)",[ctx.workspaceId,pageId,number])).rowCount;
 if(!inserted)throw Error("VERSION_METADATA_OUTSIDE_PUBLICATION");
 const latest=(await db.query("SELECT max(number)::integer AS n FROM versions WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,pageId])).rows[0]?.n;
 if(latest!==number)throw Error("VERSION_METADATA_NOT_CURRENT");
 const snapshot=await currentMetadata(db,ctx,pageId,number);
 const body=(await db.query("SELECT data->>'content' AS content FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3",[ctx.workspaceId,pageId,number])).rows[0].content;
 const prior=(await db.query("SELECT anchors FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 AND number<$3 ORDER BY number DESC LIMIT 1",[ctx.workspaceId,pageId,number])).rows[0]?.anchors?.anchors??[];
 const anchors=segmentAnchors(pageId,number,body,prior as Anchor[]);
 await db.query("INSERT INTO version_metadata(workspace_id,page_id,number,snapshot,snapshot_hash,anchors,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[ctx.workspaceId,pageId,number,snapshot,fingerprint(snapshot),anchors,ctx.principalId]);
}

type ChangeToken=Readonly<{id:string}>;
const changes=new WeakMap<ChangeToken,{workspaceId:string;principalId:string;pageId:string;tx:string;before:MetadataSnapshot}>();
/** Call immediately before a metadata-only settings/page edit in the SAME transaction. */
export async function beginVersionMetadataChange(db:PoolClient,ctx:Context,pageId:string):Promise<ChangeToken>{
 await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id:pageId});
 const token=Object.freeze({id:randomUUID()}),tx=(await db.query("SELECT txid_current()::text AS id")).rows[0].id;
 changes.set(token,{workspaceId:ctx.workspaceId,principalId:ctx.principalId,pageId,tx,before:await currentMetadata(db,ctx,pageId)});return token;
}
/** No caller-provided before/after snapshots: both are server reads, token cannot cross transaction/actor. */
export async function finishVersionMetadataChange(db:PoolClient,ctx:Context,token:ChangeToken,reason:string){
 const entry=changes.get(token),tx=(await db.query("SELECT txid_current()::text AS id")).rows[0].id;
 if(!entry||entry.tx!==tx||entry.workspaceId!==ctx.workspaceId||entry.principalId!==ctx.principalId)throw Error("INVALID_METADATA_CHANGE_TOKEN");
 if(!reason.trim()||reason.length>2000)throw Error("VALIDATION_FAILED");
 const after=await currentMetadata(db,ctx,entry.pageId);
 await authorizeActionDb(db,ctx,after.lifecycle==="trash"?"lifecycle.manage":"knowledge.read",{kind:"page",id:entry.pageId});
 if(fingerprint(entry.before)!==fingerprint(after))await db.query("INSERT INTO version_metadata_events(workspace_id,page_id,actor_id,reason,before_snapshot,after_snapshot) VALUES($1,$2,$3,$4,$5,$6)",[ctx.workspaceId,entry.pageId,ctx.principalId,reason,entry.before,after]);
 changes.delete(token);
}

export interface RestorePlan {
 pageId:string;targetVersion:number;baseVersion:number;settingsRevision:number;policyVersion:number;
 fields:string[];next:MetadataSnapshot;currentHash:string;content:string;sourceIds:string[];dependencies:string[];
}
const validatedPlans=new WeakMap<PoolClient,{tx:string;batchId:string;hash:string;actor:string;digest:string}>();
export async function validatePlannedMetadata(db:PoolClient,ctx:Context,plan:RestorePlan){
 const current=await currentMetadata(db,ctx,plan.pageId);
 if(current.number!==plan.baseVersion||current.settingsRevision!==plan.settingsRevision||fingerprint(current)!==plan.currentHash)throw Error("STALE_VERSION");
 const policy=(await db.query("SELECT policy_version FROM access_spaces WHERE workspace_id=$1 AND active",[ctx.workspaceId])).rows[0];if(!policy||policy.policy_version!==plan.policyVersion)throw Error("APPROVAL_STALE");
 if(plan.fields.some(f=>["properties","environment","lifecycle","parentId","category"].includes(f)))await authorizeActionDb(db,ctx,"knowledge.protect",{kind:"page",id:plan.pageId});
 if(plan.fields.includes("parentId")){
  await authorizeActionDb(db,ctx,"space.admin",{kind:"page",id:plan.pageId});
  const seen=new Set([plan.pageId]);let parent=plan.next.parentId;
  while(parent){if(seen.has(parent))throw Error("RESTORE_PARENT_CYCLE");seen.add(parent);await authorizeActionDb(db,ctx,"knowledge.read",{kind:"page",id:parent});parent=(await db.query("SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,parent])).rows[0]?.parent_id??null;}
 }
 const policies=(await db.query("SELECT * FROM governance_type_policies WHERE workspace_id=$1 ORDER BY document_type",[ctx.workspaceId])).rows;
 const required=policies.find(p=>p.document_type===plan.next.category)??policies.find(p=>p.document_type==="*");
 if(required?.mode==="block")for(const key of required.required_keys){const owner=(await db.query("SELECT owner_id FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,plan.pageId])).rows[0];const value=key==="summary"?plan.next.summary:key==="tags"?plan.next.tags:key==="reviewDue"?plan.next.workflowData.reviewDue:key==="businessOwner"?owner?.owner_id:plan.next.properties[key];if(value==null||value===""||(Array.isArray(value)&&!value.length))throw Error("PROPERTY_REQUIRED");}
}
/** Trusted pre-proposal projection for C's required-property checks. Never parse this from a DTO. */
export async function validateVersionMetadataPlans(db:PoolClient,ctx:Context,plans:RestorePlan[]) {
 if(plans.length>20||new Set(plans.map(p=>p.pageId)).size!==plans.length)throw Error("VALIDATION_FAILED");
 const projections:Record<string,MetadataSnapshot>={};
 for(const plan of plans){await validatePlannedMetadata(db,ctx,plan);projections[plan.pageId]=plan.next;}
 return projections;
}

/** C review/publication hook: frozen plan/hash and current bases/policy, never a DTO projection. */
export async function assertVersionPlansCurrent(db:PoolClient,ctx:Context,batchId:string,batchHash:string){
 const rows=(await db.query("SELECT * FROM version_restore_plans WHERE workspace_id=$1 AND batch_id=$2 ORDER BY page_id",[ctx.workspaceId,batchId])).rows;
 const projections:Record<string,MetadataSnapshot>={};
 for(const row of rows){if(row.batch_hash!==batchHash||row.plan_hash!==fingerprint(row.payload))throw Error("APPROVAL_STALE");await validatePlannedMetadata(db,ctx,row.payload);projections[row.page_id]=row.payload.next;}
 const digest=fingerprint(rows.map(r=>[r.page_id,r.plan_hash]));
 validatedPlans.set(db,{tx:(await db.query("SELECT txid_current()::text AS id")).rows[0].id,batchId,hash:batchHash,actor:ctx.principalId,digest});
 return {digest,projections};
}

/** Trusted commit hook: after canonical independent approval checks and ALL version inserts; before snapshots. */
export async function applyApprovedVersionMetadataPlans(db:PoolClient,ctx:Context,batchId:string,batchHash:string,versions:Record<string,number>){
 const rows=(await db.query("SELECT * FROM version_restore_plans WHERE workspace_id=$1 AND batch_id=$2 ORDER BY page_id",[ctx.workspaceId,batchId])).rows;if(!rows.length)return;
 const receipt=validatedPlans.get(db),tx=(await db.query("SELECT txid_current()::text AS id")).rows[0].id;
 if(!receipt||receipt.tx!==tx||receipt.batchId!==batchId||receipt.hash!==batchHash||receipt.actor!==ctx.principalId||receipt.digest!==fingerprint(rows.map(r=>[r.page_id,r.plan_hash])))throw Error("APPROVAL_STALE");
 const batch=(await db.query("SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,batchId])).rows[0];
 if(!batch||batch.hash!==batchHash||batch.data.status!=="approved"||ctx.credentialId)throw Error("APPROVAL_STALE");
 const actor=(await db.query("SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",[ctx.principalId])).rowCount;if(!actor)throw Error("FORBIDDEN");
 const approvals=(await db.query("SELECT principal_id FROM approvals WHERE workspace_id=$1 AND batch_id=$2 AND hash=$3",[ctx.workspaceId,batchId,batchHash])).rows;
 if(!approvals.length)throw Error("APPROVAL_STALE");
 for(const row of rows){
  const p:RestorePlan=row.payload,newVersion=versions[p.pageId];if(!newVersion||row.batch_hash!==batchHash||fingerprint(p)!==row.plan_hash)throw Error("APPROVAL_STALE");
  if((await db.query("SELECT 1 FROM version_restore_applications WHERE workspace_id=$1 AND batch_id=$2 AND page_id=$3 AND number=$4",[ctx.workspaceId,batchId,p.pageId,newVersion])).rowCount)continue;
  // After new version INSERT, validate the pre-publication base/settings rather than treating it as stale.
  const settings=(await db.query("SELECT revision FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,p.pageId])).rows[0];
  const published=(await db.query("SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 AND number=$3",[ctx.workspaceId,p.pageId,newVersion])).rows[0]?.data;
  if((settings?.revision??0)!==p.settingsRevision||newVersion!==p.baseVersion+1||published?.batchId!==batchId||fingerprint(published?.content)!==fingerprint(p.content)||p.sourceIds.some(id=>!published.sourceIds?.includes(id)))throw Error("STALE_VERSION");
  const policy=(await db.query("SELECT policy_version FROM access_spaces WHERE workspace_id=$1",[ctx.workspaceId])).rows[0];if(policy?.policy_version!==p.policyVersion)throw Error("APPROVAL_STALE");
  await authorizeActionDb(db,ctx,"knowledge.protect",{kind:"page",id:p.pageId});
  const {readers}=await import("../../repository");const before=await readers(db,ctx.workspaceId,"page",p.pageId);
  const old=(await db.query("SELECT data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",[ctx.workspaceId,p.pageId])).rows[0]?.data??{};
  const data={...old,properties:p.next.properties,environment:p.next.environment};
  if(p.fields.some(f=>["properties","environment","parentId","lifecycle"].includes(f)))await db.query("INSERT INTO workflow_document_state(workspace_id,page_id,parent_id,state,revision,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,page_id) DO UPDATE SET parent_id=excluded.parent_id,state=excluded.state,revision=excluded.revision,data=excluded.data",[ctx.workspaceId,p.pageId,p.next.parentId,p.next.lifecycle,p.settingsRevision+1,data]);
  const metadata=(await db.query("SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,p.pageId])).rows[0].data;
  await db.query("UPDATE pages SET data=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,p.pageId,{...metadata,title:p.next.title,summary:p.next.summary,category:p.next.category,tags:p.next.tags}]);
  const after=await readers(db,ctx.workspaceId,"page",p.pageId);if(after.some(id=>!before.includes(id)))throw Error("RESTORE_SCOPE_EXPANSION");
  await db.query("INSERT INTO version_restore_applications VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())",[ctx.workspaceId,batchId,p.pageId,newVersion,row.plan_hash,ctx.principalId]);
 }
}
