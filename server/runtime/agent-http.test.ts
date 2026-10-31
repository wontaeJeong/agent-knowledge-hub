import {afterAll,beforeAll,expect,test} from "vitest";
import {createServer,type Server} from "node:http";
import {mkdtemp,realpath,rm,readdir,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import * as oidc from "openid-client";
import {fixture,adoptFixture} from "../test-support";
import {AccessService,authorizeInTransaction} from "../access/index";
import {FileBlobStore,StorageService} from "../storage";
import {RuntimeService} from "./knowledge";
import {createRuntimeHandler} from "./http";
import {OidcAuth,sessionHash} from "./auth";
let f:Awaited<ReturnType<typeof fixture>>,server:Server,provider:Server,base:string,root:string;
const old=process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
beforeAll(async()=>{
 process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED="true";
 f=await fixture();
 await adoptFixture(f.pool,f.workspaceId);
  root=await realpath(await mkdtemp(join(tmpdir(),"akh-agent-upload-")));
  provider=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({sub:"editor",groups:["writers"]}));});
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const issuer="http://127.0.0.1:"+(provider.address() as {port:number}).port;
  const config=new oidc.Configuration({issuer,userinfo_endpoint:issuer+"/userinfo"},"client","secret");
  oidc.allowInsecureRequests(config);
  const auth=new OidcAuth(f.pool,config,"http://localhost",f.workspaceId,{writers:"editor"});
  await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','fixture-access')",[sessionHash("fixture"),f.workspaceId]);
  server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId,storage:new StorageService(f.pool,new FileBlobStore(root),authorizeInTransaction)}));
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 base="http://127.0.0.1:"+(server.address() as {port:number}).port;
});
afterAll(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await new Promise<void>(resolve=>provider.close(()=>resolve()));
  await f.pool.end();
  await rm(root,{recursive:true,force:true});
 if(old===undefined)delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
 else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=old;
});
const sessionHeaders={"Cookie":"akh_session=fixture","Origin":"http://localhost","X-CSRF-Token":"csrf","Content-Type":"application/json"};
test("version workflow routes remain unavailable through the authenticated runtime",async()=>{
 for(const path of ["/api/v1/versions/decisions", "/api/v1/versions/decisions/preview", "/api/v1/versions/restore/preview", "/api/v1/versions/restore/propose"]){
  const response=await fetch(base+path,{method:"POST",headers:sessionHeaders,body:"{}"});
  expect(response.status, path).toBe(404);
 }
});
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

const metadata={"X-Parent-Kind":"source","X-Parent-Id":"source-a","X-Filename":"fixture.txt","Content-Type":"text/plain"};
test.each(["read","write"])("%s agent key cannot upload raw bytes",async(scope)=>{
 const bytesOnDisk=async(dir:string):Promise<number>=>{
  let total=0;
  for(const name of await readdir(dir)){
   const path=join(dir,name),info=await stat(path);
   total+=info.isDirectory()?await bytesOnDisk(path):info.size;
  }
  return total;
 };
  const issue=await fetch(base+"/api/v1/credentials/keys",{method:"POST",headers:sessionHeaders,body:JSON.stringify({name:"upload-"+scope,scope,days:90})});
  expect(issue.status).toBe(201);
  const {token}=await issue.json() as {token:string};
  const response=await fetch(base+"/api/v1/storage/blobs",{method:"PUT",headers:{...metadata,Authorization:"Bearer "+token},body:"unauthorized "+scope});
  expect(response.status,await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({code:"FORBIDDEN"});
  for(const table of ["storage_blobs","storage_attachment_slots","storage_attachment_versions"]){
   const count=await f.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`,[f.workspaceId]);
   expect(count.rows[0].n).toBe(0);
  }
  expect(await bytesOnDisk(root)).toBe(0);
});
test("raw upload preserves cookie CSRF and scoped bearer access",async()=>{
 const csrfDenied=await fetch(base+"/api/v1/storage/blobs",{method:"PUT",headers:{...metadata,Cookie:"akh_session=fixture",Origin:"http://localhost"},body:"blocked"});
 expect(csrfDenied.status).toBe(403);
 expect(await csrfDenied.json()).toMatchObject({code:"CSRF_FAILED"});
 const cookie=await fetch(base+"/api/v1/storage/blobs",{method:"PUT",headers:{...metadata,Cookie:"akh_session=fixture",Origin:"http://localhost","X-CSRF-Token":"csrf"},body:"cookie upload"});
 expect(cookie.status,await cookie.clone().text()).toBe(201);
 const access=new AccessService(f.pool);
 const {secret}=await access.issueCredential(f.editor,{actions:["knowledge.read","source.create","changeset.propose","personal.sync"],expiresAt:new Date(Date.now()+3600000).toISOString()});
 const bearer=await fetch(base+"/api/v1/storage/blobs",{method:"PUT",headers:{...metadata,Authorization:"Bearer "+secret},body:"scoped upload"});
 expect(bearer.status,await bearer.clone().text()).toBe(201);
});
