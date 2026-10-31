import {test, expect} from "vitest";
import {createServer} from "node:http";
import * as oidc from "openid-client";
import {fixture, adoptFixture} from "../test-support";
import {authorizeInTransaction} from "../access/index";
import {RuntimeService} from "../runtime/knowledge";
import {createRuntimeHandler} from "../runtime/http";
import {OidcAuth, sessionHash} from "../runtime/auth";
import {OperationsService} from "./service";
import {operationsRoutes} from "./routes";

test("authenticated erasure preview and execute expose version workflow conflict", async () => {
  const f=await fixture(); await adoptFixture(f.pool,f.workspaceId);
  await f.pool.query("INSERT INTO version_metadata_events(workspace_id,page_id,actor_id,reason,before_snapshot,after_snapshot) VALUES($1,'topic','editor','reason','{}','{}')",[f.workspaceId]);
  const provider=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({sub:"fixture-owner",groups:["owners"]}));});
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const issuer=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;
  const config=new oidc.Configuration({issuer,userinfo_endpoint:issuer+"/userinfo"},"client","secret"); oidc.allowInsecureRequests(config);
  const auth=new OidcAuth(f.pool,config,"http://localhost",f.workspaceId,{owners:"editor"});
  await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'fixture-owner','csrf',now()+interval '1 hour','fixture-owner','token')",[sessionHash("owner"),f.workspaceId]);
  const server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId,operations:operationsRoutes(new OperationsService(f.pool,authorizeInTransaction))}));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={Cookie:"akh_session=owner",Origin:"http://localhost","X-CSRF-Token":"csrf","Content-Type":"application/json"};
  try {
    const preview=await fetch(base+"/api/v1/operations/erasure/preview",{method:"POST",headers,body:JSON.stringify({scope:"workspace"})});
    expect(preview.status,await preview.clone().text()).toBe(200);
    const data=await preview.json() as {previewHash:string;versionWorkflowDataUnsupported:boolean};
    expect(data.versionWorkflowDataUnsupported).toBe(true);
    const execute=await fetch(base+"/api/v1/operations/erasure/execute",{method:"POST",headers,body:JSON.stringify({scope:"workspace",previewHash:data.previewHash,confirm:"ERASE_ENTIRE_WORKSPACE"})});
    expect(execute.status).toBe(409);
    expect(await execute.json()).toMatchObject({code:"ERASURE_VERSION_METADATA_UNSUPPORTED"});
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>provider.close(()=>resolve()));await f.pool.end();}
});
