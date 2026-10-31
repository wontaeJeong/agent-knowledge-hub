import {afterAll,beforeAll,expect,test} from "vitest";
import {createServer,type Server} from "node:http";
import {fixture,adoptFixture} from "../test-support";
import {RuntimeService} from "./knowledge";
import {createRuntimeHandler} from "./http";
import type {OidcAuth} from "./auth";
let f:Awaited<ReturnType<typeof fixture>>,server:Server,base:string;
const old=process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
beforeAll(async()=>{
 process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED="true";
 f=await fixture();
 await adoptFixture(f.pool,f.workspaceId);
 const auth={
  authenticate: async(req:{headers:{cookie?:string}})=>req.headers.cookie==="akh_session=fixture"?
   {workspaceId:f.workspaceId,principalId:"editor",role:"editor",csrfToken:"csrf"}:null,
  requestGuard:()=>({revalidate:async()=>{},assertSession:async()=>{}}),
  logout:async()=>{},
 } as unknown as OidcAuth;
 server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId}));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 base="http://127.0.0.1:"+(server.address() as {port:number}).port;
});
afterAll(async()=>{
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 await f.pool.end();
 if(old===undefined)delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
 else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=old;
});
const sessionHeaders={"Cookie":"akh_session=fixture","Origin":"http://localhost","X-CSRF-Token":"csrf","Content-Type":"application/json"};
test("browser issues a 90-day key, bearer reads with current ACL but cannot access interactive approvals",async()=>{
 const issue=await fetch(base+"/api/v1/credentials/keys",{method:"POST",headers:sessionHeaders,body:JSON.stringify({name:"agent",scope:"read",days:90})});
 expect(issue.status).toBe(201);
 const {token}=await issue.json() as {token:string};
 expect((await fetch(base+"/api/v1/pages",{headers:{Authorization:"Bearer "+token}})).status).toBe(200);
 expect((await fetch(base+"/api/v1/usage",{headers:{Authorization:"Bearer "+token}})).status).toBe(403);
 expect((await fetch(base+"/api/v1/credentials/keys",{headers:{Authorization:"Bearer "+token}})).status).toBe(403);
 expect((await fetch(base+"/api/v1/access",{headers:{Authorization:"Bearer "+token}})).status).toBe(403);
 expect((await fetch(base+"/api/v1/query",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({question:"x",mode:"offline"})})).status).toBe(403);
 const list=await fetch(base+"/api/v1/credentials/keys",{headers:sessionHeaders});
 expect(list.status).toBe(200);
 const data=await list.json() as {items:{requests30d:number}[]};
 expect(data.items[0].requests30d).toBe(1);
 expect(JSON.stringify(data)).not.toContain(token);
});
test("no bearer token can bypass cookie CSRF or use a random principal claim",async()=>{
 expect((await fetch(base+"/api/v1/pages",{headers:{"X-Principal-Id":"editor"}})).status).toBe(401);
 expect((await fetch(base+"/api/v1/credentials/keys",{method:"POST",headers:{"Cookie":"akh_session=fixture","Content-Type":"application/json"},body:"{}"})).status).toBe(403);
 expect((await fetch(base+"/api/v1/pages",{headers:{Authorization:"Bearer invalid"}})).status).toBe(401);
});
