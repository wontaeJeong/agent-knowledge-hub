import {test,expect,vi} from "vitest";
vi.setConfig({testTimeout:30000,hookTimeout:30000});
import {fixture,adoptFixture,page,source} from "../test-support";
import {AgentService} from "./service";
import {RuntimeService} from "../runtime/knowledge";
import {AccessService,authorizeInTransaction} from "../access/index";

async function setup() {
 const f=await fixture(); await adoptFixture(f.pool,f.workspaceId);
 await f.pool.query("INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",[f.workspaceId]);
 const access=new AccessService(f.pool), cred=await access.issueCredential(f.editor,{actions:["knowledge.read","local.copy","personal.sync","changeset.propose"],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const ctx=await access.authenticateCredential(cred.secret);
 const a=new AgentService(f.pool,new RuntimeService(f.pool),authorizeInTransaction);
 const snap=await a.connector(ctx,"snapshot",{}) as any;
 const personal={...snap.shared[0],spaceId:"personal",version:0,content:"selected personal text",upstream:{spaceId:f.workspaceId,pageId:"topic",version:1}};
 const p=await a.connector(ctx,"push",{mutationId:"seed",baseVersion:0,page:personal}) as any;
 const q={id:"chosen",targetSpaceId:f.workspaceId,selections:[{pageId:"topic",baseVersion:1,personalVersion:1}]};
 return {...f,access,ctx,a,p,q,cred};
}
for (const drift of ["copy-policy","personal-revision"] as const) test(`concurrent cached inner proposal must recheck ${drift}`,async()=>{
 const f=await setup();
 try {
  let resume!:()=>void, entered!:()=>void;
  const paused=new Promise<void>(r=>resume=r), reached=new Promise<void>(r=>entered=r);
  const original=f.a.proposeChange.bind(f.a);
  let once=true;
  f.a.proposeChange=async(...args)=>{if(once){once=false;entered();await paused;}return original(...args);};
  const slow=f.a.connector(f.ctx,"propose-batch",f.q);
  await reached;
  const fast=await f.a.connector(f.ctx,"propose-batch",f.q);
  if(drift==="copy-policy") await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=false WHERE workspace_id=$1",[f.workspaceId]);
  else await f.a.connector(f.ctx,"push",{mutationId:"changed",baseVersion:1,page:{...f.p,content:"newer personal text"}});
  resume();
  await expect(slow).rejects.toThrow(drift==="copy-policy"?"FORBIDDEN":"STALE_PERSONAL_VERSION");
  expect((await f.pool.query("SELECT count(*)::int AS n FROM batches WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(1);
 }finally{await f.pool.end();}
});

test("concurrent cached single proposal rechecks personal copy authorization",async()=>{
 const f=await setup();
 try {
  let resume!:()=>void, entered!:()=>void;
  const paused=new Promise<void>(r=>resume=r), reached=new Promise<void>(r=>entered=r);
  const original=f.a.proposeChange.bind(f.a); let once=true;
  f.a.proposeChange=async(...args)=>{if(once){once=false;entered();await paused;}return original(...args);};
  const q={id:"single",pageId:"topic",targetSpaceId:f.workspaceId,baseVersion:1,personalVersion:1};
  const slow=f.a.connector(f.ctx,"propose",q); await reached;
  await f.a.connector(f.ctx,"propose",q);
  await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=false WHERE workspace_id=$1",[f.workspaceId]);
  resume(); await expect(slow).rejects.toThrow("FORBIDDEN");
 } finally {await f.pool.end();}
});

test("personal added links retain current local-copy ceiling on snapshot and proposal",async()=>{
 const f=await setup();
 try {
  const {versions,...metadata}=page;
  for(const [kind,id] of [["page","second"],["source","source-b"]]){
   await f.pool.query("INSERT INTO resources VALUES($1,$2,$3)",[f.workspaceId,kind,id]);
   for(const who of ["editor","reviewer","reader"])await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)",[f.workspaceId,kind,id,who]);
  }
  await f.pool.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'source-b',$2)",[f.workspaceId,{...source,id:"source-b"}]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'second',$2)",[f.workspaceId,{...metadata,id:"second",title:"Second"}]);
  await f.pool.query("INSERT INTO versions VALUES($1,'second',1,$2)",[f.workspaceId,{...versions[0],sourceIds:["source-b"]}]);
  await f.pool.query("INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-b',true,false)",[f.workspaceId]);
  await f.a.connector(f.ctx,"push",{mutationId:"linked",baseVersion:1,page:{...f.p,links:["second"]}});
  await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=false WHERE workspace_id=$1 AND source_id='source-b'",[f.workspaceId]);
  const snapshot=await f.a.connector(f.ctx,"snapshot",{}) as any;
  const q={...f.q,selections:[{pageId:"topic",baseVersion:1,personalVersion:2}]};
  await expect(f.a.connector(f.ctx,"propose-batch",q)).rejects.toThrow("FORBIDDEN");
  expect(snapshot.personal).toEqual([]);
 }finally{await f.pool.end();}
});

test("personal added links retain raw source reader ceiling on cached batch replay",async()=>{
 const f=await setup();
 try {
  const {versions,...metadata}=page;
  for(const [kind,id] of [["page","second"],["source","source-b"]]){
   await f.pool.query("INSERT INTO resources VALUES($1,$2,$3)",[f.workspaceId,kind,id]);
   for(const who of ["editor","reviewer","reader"])await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)",[f.workspaceId,kind,id,who]);
  }
  await f.pool.query("INSERT INTO sources(workspace_id,id,data) VALUES($1,'source-b',$2)",[f.workspaceId,{...source,id:"source-b"}]);
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'second',$2)",[f.workspaceId,{...metadata,id:"second",title:"Second"}]);
  await f.pool.query("INSERT INTO versions VALUES($1,'second',1,$2)",[f.workspaceId,{...versions[0],sourceIds:["source-b"]}]);
  await f.pool.query("INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-b',true,false)",[f.workspaceId]);
  await f.a.connector(f.ctx,"push",{mutationId:"linked",baseVersion:1,page:{...f.p,links:["second"]}});
  const q={...f.q,selections:[{pageId:"topic",baseVersion:1,personalVersion:2}]};
  await f.a.connector(f.ctx,"propose-batch",q);
  await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-b' AND principal_id='editor'",[f.workspaceId]);
  const snapshot=await f.a.connector(f.ctx,"snapshot",{}) as any;
  const replay=await f.a.connector(f.ctx,"propose-batch",q).then(result=>({accepted:true,result}),e=>({accepted:false,code:e.message}));
  expect({personalCount:snapshot.personal.length,replay}).toEqual({personalCount:0,replay:{accepted:false,code:"NOT_FOUND"}});
 }finally{await f.pool.end();}
});

import {createServer} from "node:http";
import * as oidc from "openid-client";
import {OidcAuth} from "../runtime/auth";
import {createRuntimeHandler} from "../runtime/http";
// @ts-expect-error Portable client is plain JavaScript.
import {openClient} from "../../scripts/wiki-connector/client.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("unsynced source-backed personal draft is hidden after source copy revocation",async()=>{
 const f=await setup();
 const config=new oidc.Configuration({issuer:"http://127.0.0.1:1",userinfo_endpoint:"http://127.0.0.1:1/userinfo"},"client","secret");oidc.allowInsecureRequests(config);
 const auth=new OidcAuth(f.pool,config,"http://localhost",f.workspaceId,{});
 const server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId}));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const directory=await mkdtemp(join(tmpdir(),"akh-p8-unsynced-review-"));
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/v1/connector`;
 const client=await openClient({directory,url,token:f.cred.secret});
 try {
  await client.sync();
  const {upstream,...content}=f.p;
  await client.write({...content,id:"new-note",version:0,content:"copied confidential source-a"});
  await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=false WHERE workspace_id=$1 AND source_id='source-a'",[f.workspaceId]);
  await expect(client.read("new-note")).rejects.toThrow();
  expect(await client.search("confidential")).toEqual([]);
  await expect(client.sync()).rejects.toThrow("FORBIDDEN");
  await client.close();
  const reopened=await openClient({directory,url,token:f.cred.secret});
  try {
   await expect(reopened.read("new-note")).rejects.toThrow();
   await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=true WHERE workspace_id=$1 AND source_id='source-a'",[f.workspaceId]);
   expect((await reopened.read("new-note")).page.content).toBe("copied confidential source-a");
   expect((await reopened.status()).pending).toBe(1);
  } finally {await reopened.close();}
 }finally{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});await f.pool.end();}
});
