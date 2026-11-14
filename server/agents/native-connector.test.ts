import { test, expect } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture, page } from "../test-support";
import { AccessService } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth } from "../runtime/auth";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error Portable connector is intentionally plain JavaScript.
import { openClient } from "../../scripts/wiki-connector/client.mjs";

test("native scoped connector creates one pending proposal for two selected personal revisions", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const other = await fixture(); await adoptFixture(other.pool, other.workspaceId);
  await f.pool.query("INSERT INTO resources VALUES($1,'page','second')",[f.workspaceId]);
  for (const principal of ["editor","reviewer","reader"]) await f.pool.query("INSERT INTO resource_readers VALUES($1,'page','second',$2)",[f.workspaceId,principal]);
  const {versions,...metadata}=page;
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'second',$2)",[f.workspaceId,{...metadata,id:"second",title:"Second"}]);
  await f.pool.query("INSERT INTO versions VALUES($1,'second',1,$2)",[f.workspaceId,versions[0]]);
  await f.pool.query("INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",[f.workspaceId]);
  const access=new AccessService(f.pool), credential=await access.issueCredential(f.editor,{actions:["knowledge.read","local.copy","personal.sync","changeset.propose"],expiresAt:new Date(Date.now()+3600000).toISOString()});
  await other.pool.query("INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",[other.workspaceId]);
  const otherCredential=await access.issueCredential(other.editor,{actions:["knowledge.read","local.copy","personal.sync","changeset.propose"],expiresAt:new Date(Date.now()+3600000).toISOString()});
  const config=new oidc.Configuration({issuer:"http://127.0.0.1:1",userinfo_endpoint:"http://127.0.0.1:1/userinfo"},"client","secret"); oidc.allowInsecureRequests(config);
  const auth=new OidcAuth(f.pool,config,"http://localhost",f.workspaceId,{});
  const server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId}));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1/connector`;
  const directory=await mkdtemp(join(tmpdir(),"akh-native-connector-"));
  const secondDirectory=await mkdtemp(join(tmpdir(),"akh-native-connector-2-"));
  const client=await openClient({directory,url,token:credential.secret});
  const secondClient=await openClient({directory:secondDirectory,url,token:credential.secret});
  const request=async(action:string,input:unknown)=>fetch(url,{method:"POST",headers:{Authorization:`Bearer ${credential.secret}`,"Content-Type":"application/json"},body:JSON.stringify({action,input})});
  try {
    const snapshot=await request("snapshot",{}); expect(snapshot.status,await snapshot.clone().text()).toBe(200);
    const data=await snapshot.json() as {shared:Array<Record<string,unknown>>};
    for (const id of ["topic","second"]) {
      const shared=data.shared.find(p=>p.id===id)!; expect(shared).toBeDefined();
      const personal={...shared,spaceId:"personal",version:0,content:`edited ${id}`,upstream:{spaceId:f.workspaceId,pageId:id,version:1}};
      const push=await request("push",{mutationId:`push-${id}`,baseVersion:0,page:personal}); expect(push.status,await push.clone().text()).toBe(200);
    }
    const input={id:"selected-batch",targetSpaceId:f.workspaceId,selections:[{pageId:"topic",baseVersion:1,personalVersion:1},{pageId:"second",baseVersion:1,personalVersion:1}]};
    await client.sync();
    await secondClient.sync();
    const [proposal, concurrent]=await Promise.all([request("propose-batch",input),request("propose-batch",input)]);
    expect(proposal.status,await proposal.clone().text()).toBe(200);
    const result=await proposal.json(); expect(result).toMatchObject({status:"pending",published:false});
    expect(concurrent.status,await concurrent.clone().text()).toBe(200); expect(await concurrent.json()).toEqual(result);
    expect(await client.proposeBatch(input)).toEqual(result);
    const retry=await request("propose-batch",input); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(result);
    const mismatch=await request("propose-batch",{...input,selections:[input.selections[0]]}); expect(mismatch.status).toBe(409);
    expect((await request("propose-batch",{...input,id:"other-space",targetSpaceId:"other"})).status).toBe(409);
    const origin=(await client.read("topic")).page;
    expect((await request("push",{mutationId:"forged-source",baseVersion:1,page:{...origin,sourceRefs:[...origin.sourceRefs,{id:"forged",version:1,location:"content"}]}})).status).toBe(404);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM batches WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(1);
    const batch=(await f.pool.query("SELECT data FROM batches WHERE workspace_id=$1",[f.workspaceId])).rows[0].data;
    expect(JSON.stringify(batch)).toContain("edited topic"); expect(JSON.stringify(batch)).toContain("edited second");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM publications WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
    await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=false WHERE workspace_id=$1 AND source_id='source-a'",[f.workspaceId]);
    expect((await request("propose-batch",input)).status).toBe(403);
    await expect(client.read("topic")).rejects.toThrow("NOT_FOUND");
    await f.pool.query("UPDATE access_source_policy SET local_copy_allowed=true WHERE workspace_id=$1 AND source_id='source-a'",[f.workspaceId]);
    await client.sync();
    await f.pool.query("UPDATE agent_personal_pages SET revision=2 WHERE workspace_id=$1 AND owner_id='editor' AND id='topic'",[f.workspaceId]);
    const stale=await request("propose-batch",input); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({code:"STALE_PERSONAL_VERSION"});
    await f.pool.query("UPDATE agent_personal_pages SET revision=1 WHERE workspace_id=$1 AND owner_id='editor' AND id='topic'",[f.workspaceId]);
    const first=(await client.read("topic")).page, second=(await secondClient.read("topic")).page;
    await client.write({...first,content:"first device"}); await secondClient.write({...second,content:"second device"});
    await client.sync(); await secondClient.sync();
    const conflicts=await secondClient.conflicts(); expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({base:{content:"edited topic"},draft:{content:"second device"},incoming:{content:"first device"}});
    await expect(secondClient.proposeBatch(input)).rejects.toThrow("SYNC_REQUIRED");
    await secondClient.close();
    await expect(openClient({directory:secondDirectory,url,token:otherCredential.secret})).rejects.toThrow("WORKSPACE_IDENTITY_MISMATCH");
    const reopened=await openClient({directory:secondDirectory,url,token:credential.secret});
    try {expect(await reopened.conflicts()).toHaveLength(1);} finally {await reopened.close();}
    const otherDirectory=await mkdtemp(join(tmpdir(),"akh-other-space-"));
    const otherClient=await openClient({directory:otherDirectory,url,token:otherCredential.secret});
    try {await otherClient.sync(); expect((await otherClient.read("topic",other.workspaceId)).page.content).toBe("기존 내용"); await expect(otherClient.read("topic",f.workspaceId)).rejects.toThrow("NOT_FOUND");}
    finally {await otherClient.close();await rm(otherDirectory,{recursive:true,force:true});}
    const runtime=new RuntimeService(f.pool);
    await runtime.core.approve(f.ctx,result.id,result.hash);
    await f.pool.query("INSERT INTO versions(workspace_id,page_id,number,data) VALUES($1,'second',2,$2)",[f.workspaceId,{...versions[0],id:"v2",number:2,content:"changed baseline"}]);
    await expect(runtime.core.publish(f.ctx,result.id,result.hash,"publish-stale")).rejects.toThrow();
    expect((await f.pool.query("SELECT count(*)::int AS n FROM publications WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
    await access.revokeCredential(f.editor,credential.id);
    expect((await request("propose-batch",input)).status).toBe(401);
  } finally {await client.close();await secondClient.close();await rm(directory,{recursive:true,force:true});await rm(secondDirectory,{recursive:true,force:true});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.pool.end();await other.pool.end();}
});
