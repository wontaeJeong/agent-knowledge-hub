import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Context } from "./service";
import { transaction } from "./database";
import { audit, membership } from "./repository";
import { z } from "zod";

const hash = (token:string) => createHash("sha256").update(token).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const userCode = () => Array.from(randomBytes(8), b => alphabet[b % alphabet.length]).join("");
const keyForm = z.object({name:z.string().trim().min(1).max(100),scope:z.enum(["read","write"]),days:z.number().int().min(1).max(90).default(90)}).strict();
const clientForm = z.object({name:z.string().trim().min(1).max(100)}).strict();
const clientStart = z.object({clientId:z.string().uuid(),scope:z.enum(["read","write"])}).strict();
const pollForm = z.object({deviceCode:z.string().min(40).max(128)}).strict();
const decideForm = z.object({userCode:z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),approve:z.boolean()}).strict();
const reasonForm = z.object({reason:z.string().trim().min(5).max(500)}).strict();
const uuid = z.string().uuid();
const ok = (status:number,body:unknown)=>({status,body});
export type AgentScope = "read"|"write";
export type AgentActor = Context & {agent:{keyId:string;scope:AgentScope}};
export const credentialsEnabled = () => process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED === "true";

/** No client-supplied role or workspace: effective roles are always loaded from the database. */
async function authorize(db:PoolClient,ctx:Context) {
 await ctx.authorization?.assertSession(db);
 await membership(db,ctx);
}
async function requireSpaceAdmin(db:PoolClient,ctx:Context){
 await authorize(db,ctx);
 const r=await db.query("SELECT access_role($1,$2) AS role",[ctx.workspaceId,ctx.principalId]);
 if(r.rows[0]?.role!=="Admin")throw Error("FORBIDDEN");
}
async function issue(db:PoolClient,workspace:string,principal:string,params:{name:string;scope:AgentScope;days:number},clientId:string|null=null) {
 const token="akh_sk_"+random();
 const id=randomUUID();
 await db.query(
  "INSERT INTO agent_api_keys(id,workspace_id,principal_id,device_client_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+($9::int * interval '1 day'))",
  [id,workspace,principal,clientId,params.name,hash(token),token.slice(-6),params.scope,params.days],
 );
 await db.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action) VALUES($1,$2,$3,'issue')",[workspace,principal,id]);
 return {id,token,expiresInDays:params.days,scope:params.scope};
}
export async function authenticateAgentKey(pool:Pool,token:string):Promise<AgentActor|null> {
 if(!credentialsEnabled()|| !/^akh_sk_[A-Za-z0-9_-]{43}$/.test(token))return null;
 const digest=hash(token);
 const check=async(db:Pick<PoolClient,"query">)=>{
  const r=await db.query(
   "SELECT k.id,k.workspace_id,k.principal_id,k.scope FROM agent_api_keys k JOIN memberships m ON m.workspace_id=k.workspace_id AND m.principal_id=k.principal_id LEFT JOIN agent_device_clients c ON c.id=k.device_client_id WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND (k.device_client_id IS NULL OR c.active=true) AND effective_membership(k.workspace_id,k.principal_id) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM access_principals p WHERE p.id=k.principal_id AND NOT p.enabled)",
   [digest],
  );
  if(r.rows.length!==1)throw Error("UNAUTHENTICATED");
  return r.rows[0] as {id:string;workspace_id:string;principal_id:string;scope:AgentScope};
 };
 let found:Awaited<ReturnType<typeof check>>;
 try{found=await check(pool);}catch(e){if(e instanceof Error&&e.message==="UNAUTHENTICATED")return null;throw e;}
 const assert=async(db:PoolClient)=>{
  const current=await check(db);
  if(current.id!==found.id||current.scope!==found.scope||current.workspace_id!==found.workspace_id||current.principal_id!==found.principal_id)throw Error("UNAUTHENTICATED");
 };
 return {workspaceId:found.workspace_id,principalId:found.principal_id,agent:{keyId:found.id,scope:found.scope},authorization:{
  assertSession:assert,
  revalidate:async()=>{const client=await pool.connect();try{await assert(client);}finally{client.release();}},
 }};
}
/** Logs metadata only; never log token values. */
export async function recordAgentRequest(pool:Pool,actor:AgentActor,path:string) {
 await transaction(pool,actor.workspaceId,async db=>{
  await actor.authorization?.assertSession(db);
  await db.query("UPDATE agent_api_keys SET last_used_at=clock_timestamp() WHERE id=$1",[actor.agent.keyId]);
  await db.query("INSERT INTO agent_key_requests(key_id,route) VALUES($1,$2)",[actor.agent.keyId,path.slice(0,100)]);
 });
}
export function permittedAgentRoute(method:string,path:string,scope:AgentScope,body:unknown):boolean {
 if(method==="GET"){
  return ["/api/v1/me","/api/v1/pages","/api/v1/sources","/api/v1/jobs","/api/v1/model"].includes(path)
   || /^\/api\/v1\/pages\/[A-Za-z0-9_-]{1,100}(?:\/versions\/[0-9]+)?$/.test(path);
 }
 if(method==="POST"&&path==="/mcp"){
  const data=body as {method?:unknown,params?:{name?:unknown}};
  if(data?.method==="tools/list"||data?.method==="initialize"||data?.method==="notifications/initialized"||data?.method==="ping")return true;
  if(data?.method==="tools/call")return (scope==="read" ? ["knowledge_search","knowledge_jobs"] : ["knowledge_search","knowledge_query","knowledge_ingest","knowledge_lint","knowledge_jobs"]).includes(String(data.params?.name));
 }
 if(scope!=="write")return false;
 return method==="POST" && ["/api/v1/query","/api/v1/ingest","/api/v1/lint"].includes(path);
}
export async function handleCredentialRequest(pool:Pool,ctx:Context,method:string,path:string,body:unknown,origin:string) {
 if(!credentialsEnabled())return ok(404,{code:"NOT_FOUND"});
 const suffix=path.replace(/^\/api\/v1\/credentials/,"");
 if(suffix==="/admin/keys"&&method==="GET")return transaction(pool,ctx.workspaceId,async db=>{
  await requireSpaceAdmin(db,ctx);
  const r=await db.query("SELECT k.id,k.principal_id AS issuer,k.name,k.scope,k.suffix,k.created_at AS \"createdAt\",k.expires_at AS \"expiresAt\",k.revoked_at AS \"revokedAt\",k.last_used_at AS \"lastUsedAt\",count(h.id) FILTER(WHERE h.at>=clock_timestamp()-interval '30 days')::int AS \"requests30d\",count(DISTINCT date(h.at)) FILTER(WHERE h.at>=clock_timestamp()-interval '30 days')::int AS \"activeDays30d\" FROM agent_api_keys k LEFT JOIN agent_key_requests h ON h.key_id=k.id WHERE k.workspace_id=$1 GROUP BY k.id ORDER BY k.created_at DESC LIMIT 500",[ctx.workspaceId]);
  return ok(200,{items:r.rows});
 });
 const adminRevoke=/^\/admin\/keys\/([0-9a-f-]{36})\/revoke$/.exec(suffix);
 if(adminRevoke&&method==="POST"){
  const {reason}=reasonForm.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await requireSpaceAdmin(db,ctx);
   const id=uuid.parse(adminRevoke[1]);
   const found=await db.query("UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND workspace_id=$2 RETURNING id",[id,ctx.workspaceId]);
   if(!found.rowCount)throw Error("NOT_FOUND");
   await db.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action,reason) VALUES($1,$2,$3,'revoke',$4)",[ctx.workspaceId,ctx.principalId,id,reason]);
   await audit(db,ctx,"agent.key.admin_revoke",id);
   return ok(200,{ok:true});
  });
 }

 if(suffix==="/keys"&&method==="GET")return transaction(pool,ctx.workspaceId,async db=>{
  await authorize(db,ctx);
  const r=await db.query(
   "SELECT k.id,k.principal_id AS issuer,k.name,k.scope,k.suffix,k.created_at AS \"createdAt\",k.expires_at AS \"expiresAt\",k.revoked_at AS \"revokedAt\",k.last_used_at AS \"lastUsedAt\",count(h.id) FILTER(WHERE h.at>=clock_timestamp()-interval '30 days')::int AS \"requests30d\", count(DISTINCT date(h.at)) FILTER(WHERE h.at>=clock_timestamp()-interval '30 days')::int AS \"activeDays30d\" FROM agent_api_keys k LEFT JOIN agent_key_requests h ON h.key_id=k.id WHERE k.workspace_id=$1 AND k.principal_id=$2 GROUP BY k.id ORDER BY k.created_at DESC LIMIT 200",
   [ctx.workspaceId,ctx.principalId]);
  return ok(200,{items:r.rows});
 });
 if(suffix==="/keys"&&method==="POST"){
  const params=keyForm.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await authorize(db,ctx);
   const result=await issue(db,ctx.workspaceId,ctx.principalId,params);
   await audit(db,ctx,"agent.key.issue",result.id);
   return ok(201,result);
  });
 }
 const revoke=/^\/keys\/([0-9a-f-]{36})\/revoke$/.exec(suffix);
 if(revoke&&method==="POST"){
  const {reason}=reasonForm.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await authorize(db,ctx);
   const row=await db.query("UPDATE agent_api_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 RETURNING id",[uuid.parse(revoke[1]),ctx.workspaceId,ctx.principalId]);
   if(!row.rowCount)throw Error("NOT_FOUND");
   await audit(db,ctx,"agent.key.revoke",revoke[1]);
   await db.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action,reason) VALUES($1,$2,$3,'revoke',$4)",[ctx.workspaceId,ctx.principalId,revoke[1],reason]);
   return ok(200,{ok:true});
  });
 }
 if(suffix==="/clients"&&method==="GET")return transaction(pool,ctx.workspaceId,async db=>{
  await authorize(db,ctx);
  const rows=await db.query("SELECT id,name,active,created_at AS \"createdAt\" FROM agent_device_clients WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC LIMIT 100",[ctx.workspaceId,ctx.principalId]);
  return ok(200,{items:rows.rows});
 });
 if(suffix==="/clients"&&method==="POST"){
  const {name}=clientForm.parse(body);
  return transaction(pool,ctx.workspaceId,async db=>{
   await authorize(db,ctx);
   const count=await db.query("SELECT count(*)::int AS value FROM agent_device_clients WHERE workspace_id=$1 AND principal_id=$2 AND active",[ctx.workspaceId,ctx.principalId]);
   if(count.rows[0].value>=20)throw Error("CLIENT_LIMIT");
   const id=randomUUID();
   await db.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,$3,$4)",[id,ctx.workspaceId,ctx.principalId,name]);
   await audit(db,ctx,"agent.client.register",id);
   return ok(201,{id,name});
  });
 }
 const disable=/^\/clients\/([0-9a-f-]{36})$/.exec(suffix);
 if(disable&&method==="DELETE")return transaction(pool,ctx.workspaceId,async db=>{
  await authorize(db,ctx);
  const id=uuid.parse(disable[1]);
  const row=await db.query("UPDATE agent_device_clients SET active=false WHERE id=$1 AND workspace_id=$2 AND principal_id=$3 RETURNING id",[id,ctx.workspaceId,ctx.principalId]);
  if(!row.rowCount)throw Error("NOT_FOUND");
  await db.query("UPDATE agent_api_keys SET revoked_at=clock_timestamp() WHERE device_client_id=$1 AND revoked_at IS NULL",[id]);
  await db.query("UPDATE agent_device_grants SET status='denied' WHERE client_id=$1 AND status IN ('pending','approved')",[id]);
  await audit(db,ctx,"agent.client.disable",id);
  return ok(200,{ok:true});
 });
 return null;
}
export async function startDevice(pool:Pool,body:unknown,origin:string) {
 if(!credentialsEnabled())return ok(404,{code:"NOT_FOUND"});
 const input=clientStart.parse(body);
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const owner=await client.query("SELECT * FROM agent_device_clients WHERE id=$1 AND active=true FOR UPDATE",[input.clientId]);
  if(!owner.rowCount)throw Error("INVALID_CLIENT");
  const item=owner.rows[0];
  const live=await client.query("SELECT effective_membership($1,$2) AS role",[item.workspace_id,item.principal_id]);
  if(!live.rows[0]?.role)throw Error("INVALID_CLIENT");
  const cap=await client.query("SELECT count(*)::int AS value FROM agent_device_grants WHERE client_id=$1 AND created_at>clock_timestamp()-interval '10 minutes'",[input.clientId]);
  if(cap.rows[0].value>=10)throw Error("RATE_LIMITED");
  const deviceCode=random(),id=randomUUID(),code=userCode();
  await client.query(
   "INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')",
   [id,input.clientId,item.workspace_id,hash(deviceCode),code,input.scope]);
  await client.query("COMMIT");
  return ok(200,{deviceCode,userCode:code,verificationUri:origin+"/?app=1#agents",expiresIn:600,interval:5});
 }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}
export async function verifyDevice(pool:Pool,ctx:Context,code:string){
 if(!credentialsEnabled())return ok(404,{code:"NOT_FOUND"});
 const user=z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/).parse(code);
 return transaction(pool,ctx.workspaceId,async db=>{
  await authorize(db,ctx);
  const r=await db.query(
   "SELECT g.user_code,g.requested_scope,c.name AS \"clientName\" FROM agent_device_grants g JOIN agent_device_clients c ON c.id=g.client_id WHERE g.user_code=$1 AND g.workspace_id=$2 AND c.principal_id=$3 AND c.active AND g.status='pending' AND g.expires_at>clock_timestamp()",
   [user,ctx.workspaceId,ctx.principalId]);
  if(!r.rowCount)throw Error("NOT_FOUND");
  return ok(200,r.rows[0]);
 });
}
export async function decideDevice(pool:Pool,ctx:Context,body:unknown){
 if(!credentialsEnabled())return ok(404,{code:"NOT_FOUND"});
 const input=decideForm.parse(body);
 return transaction(pool,ctx.workspaceId,async db=>{
  await authorize(db,ctx);
  const row=await db.query(
   "SELECT g.id FROM agent_device_grants g JOIN agent_device_clients c ON c.id=g.client_id WHERE g.user_code=$1 AND g.workspace_id=$2 AND c.principal_id=$3 AND c.active AND g.status='pending' AND g.expires_at>clock_timestamp() FOR UPDATE OF g",
   [input.userCode,ctx.workspaceId,ctx.principalId]);
  if(!row.rowCount)throw Error("NOT_FOUND");
  await db.query("UPDATE agent_device_grants SET status=$2,approved_by=$3 WHERE id=$1",[row.rows[0].id,input.approve?"approved":"denied",ctx.principalId]);
  await audit(db,ctx,input.approve?"agent.device.approve":"agent.device.deny",row.rows[0].id);
  return ok(200,{ok:true});
 });
}
export async function pollDevice(pool:Pool,body:unknown){
 if(!credentialsEnabled())return ok(404,{code:"NOT_FOUND"});
 const {deviceCode}=pollForm.parse(body);
 const db=await pool.connect();
 try{
  await db.query("BEGIN");
  const row=await db.query("SELECT g.*,c.active,c.principal_id,c.name FROM agent_device_grants g JOIN agent_device_clients c ON c.id=g.client_id WHERE g.device_hash=$1 FOR UPDATE OF g",[hash(deviceCode)]);
  if(!row.rowCount)throw Error("INVALID_GRANT");
  const grant=row.rows[0];
  if(new Date(grant.expires_at).getTime()<=Date.now())throw Error("EXPIRED_GRANT");
  if(grant.status==="consumed")throw Error("INVALID_GRANT");
  if(grant.status==="denied")throw Error("ACCESS_DENIED");
  if(!grant.active)throw Error("INVALID_CLIENT");
  const elapsed=grant.last_poll_at?(Date.now()-new Date(grant.last_poll_at).getTime())/1000:null;
  if(elapsed!==null&&elapsed<5)throw Error("SLOW_DOWN");
  await db.query("UPDATE agent_device_grants SET last_poll_at=clock_timestamp() WHERE id=$1",[grant.id]);
  if(grant.status==="pending"){
   await db.query("COMMIT");
   return ok(202,{code:"AUTHORIZATION_PENDING",interval:5});
  }
  if(grant.status!=="approved"||grant.approved_by!==grant.principal_id)throw Error("INVALID_GRANT");
  const live=await db.query("SELECT effective_membership($1,$2) AS role",[grant.workspace_id,grant.principal_id]);
  if(!live.rows[0]?.role)throw Error("ACCESS_DENIED");
  const issued=await issue(db,grant.workspace_id,grant.principal_id,{name:grant.name+" (device)",scope:grant.requested_scope,days:90},grant.client_id);
  await db.query("UPDATE agent_device_grants SET status='consumed',consumed_at=clock_timestamp() WHERE id=$1",[grant.id]);
  await db.query("COMMIT");
  return ok(200,{access_token:issued.token,token_type:"Bearer",expires_in:90*86400,scope:issued.scope});
 }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}
