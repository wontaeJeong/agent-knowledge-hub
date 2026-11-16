import { test,expect } from 'vitest';
import { createServer } from 'node:http';
import * as oidc from 'openid-client';
import { fixture,adoptFixture } from '../test-support';
import { RuntimeService } from '../runtime/knowledge';
import { WorkflowService } from '../workflows/service';
import { AccessService,authorizeInTransaction } from '../access/index';
import { OidcAuth,sessionHash } from '../runtime/auth';
import { createRuntimeHandler } from '../runtime/http';
import { createRuntimeJobs } from './runtime';

test('authenticated HTTP policy and schedule execute through the bounded durable worker',async()=>{
 const f=await fixture();await adoptFixture(f.pool,f.workspaceId);
 const owner={...f.editor,principalId:'fixture-owner'},access=new AccessService(f.pool),runtime=new RuntimeService(f.pool);
 const account=await access.createServicePrincipal(owner,{name:'retention',expiresAt:new Date(Date.now()+3600000).toISOString()});
 const credential=await access.issueServiceCredential(owner,account.id,{actions:['knowledge.read'],expiresAt:new Date(Date.now()+1800000).toISOString()});
 const identity={workspaceId:f.workspaceId,principalId:account.id,credentialId:credential.id};
 await f.pool.query("INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'page','topic',$2),($1,'source','source-a',$2)",[f.workspaceId,account.id]);
 const workflow=new WorkflowService(f.pool,runtime,authorizeInTransaction);
 await workflow.saveDraft(f.editor,{id:'http-old-draft',expectedRevision:0,title:'private',content:'do-not-return',pageId:'topic',baseVersion:1});
 await f.pool.query("UPDATE workflow_drafts SET updated_at=now()-interval '3 days' WHERE workspace_id=$1",[f.workspaceId]);
 const provider=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sub:'fixture-owner',groups:['owners']}));});
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const issuer=`http://127.0.0.1:${(provider.address() as {port:number}).port}`, config=new oidc.Configuration({issuer,userinfo_endpoint:issuer+'/userinfo'},'client','secret');oidc.allowInsecureRequests(config);
 const auth=new OidcAuth(f.pool,config,'http://localhost',f.workspaceId,{owners:'editor'});
 await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'fixture-owner','csrf',now()+interval '1 hour','fixture-owner','token')",[sessionHash('owner'),f.workspaceId]);
 const bridge=createRuntimeJobs(f.pool,runtime,{workerCount:1,directoryProviderId:'fixture',directoryStatus:async subject=>({...subject,active:true,verifiedAt:new Date().toISOString(),validUntil:new Date(Date.now()+10000).toISOString()}),retentionServices:[identity]});
 const server=createServer(createRuntimeHandler({pool:f.pool,service:runtime,auth,origin:'http://localhost',workspaceId:f.workspaceId,jobs:bridge}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={Cookie:'akh_session=owner',Origin:'http://localhost','X-CSRF-Token':'csrf','Content-Type':'application/json'};
 try {
  const policy={expectedRevision:0,policy:{enabled:true,drafts:1,publishedVersions:null,sourceVersions:null,runtimeResults:null,draftOwners:['editor']}};
  expect((await fetch(`${base}/api/v1/retention/policy`,{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify(policy)})).status).toBe(403);
  const saved=await fetch(`${base}/api/v1/retention/policy`,{method:'POST',headers,body:JSON.stringify(policy)});expect(saved.status,await saved.clone().text()).toBe(200);
  const spec={key:'retention-http',cadence:'daily',time:'09:00',timezone:'UTC',holidays:[],catchup:'latest',identity,job:{kind:'retention',payload:{policyRevision:1},pageIds:[],sourceIds:[],reservation:{tokens:0,costMicros:0},timeoutMs:60000,maxAttempts:3},approvedPageIds:[],approvedSourceIds:[]};
  const response=await fetch(`${base}/api/v1/jobs-v2/schedules`,{method:'POST',headers,body:JSON.stringify(spec)});expect(response.status,await response.clone().text()).toBe(201);
  const schedule=await response.json();await f.pool.query("UPDATE durable_schedules SET next_at=now()-interval '1 minute' WHERE id=$1",[schedule.id]);
  expect(await bridge.jobs.scheduleTick()).toBe(1);await bridge.workers[0].tick();
  expect((await f.pool.query("SELECT status,result FROM durable_jobs WHERE kind='retention' AND workspace_id=$1",[f.workspaceId])).rows[0]).toMatchObject({status:'succeeded',result:{status:'completed',deleted:1}});
  expect((await f.pool.query("SELECT 1 FROM workflow_drafts WHERE workspace_id=$1 AND id='http-old-draft'",[f.workspaceId])).rowCount).toBe(0);
 } finally {await bridge.stop();await new Promise<void>(r=>server.close(()=>r()));await new Promise<void>(r=>provider.close(()=>r()));await f.pool.end();}
});
