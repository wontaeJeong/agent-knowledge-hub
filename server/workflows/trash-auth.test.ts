import { test, expect } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { WorkflowService } from "./service";

async function addFolder(f: Awaited<ReturnType<typeof fixture>>) {
  await f.pool.query("INSERT INTO resources VALUES($1,'page','folder')", [f.workspaceId]);
  for (const principal of ["reviewer", "editor", "reader"])
    await f.pool.query("INSERT INTO resource_readers VALUES($1,'page','folder',$2)", [f.workspaceId, principal]);
  const {versions, ...metadata} = page;
  await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,'folder',$2)", [f.workspaceId, {...metadata, id:"folder", title:"Folder"}]);
  await f.pool.query("INSERT INTO versions VALUES($1,'folder',1,$2)", [f.workspaceId, versions[0]]);
}

test("canonical authorization restores renamed and moved trash without resurrecting ACLs", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await addFolder(f);
    const service = new WorkflowService(f.pool, new RuntimeService(f.pool), authorizeInTransaction);
    await service.setDocumentState(f.ctx, "topic", {expectedRevision:0, state:"trash", reason:"test"});
    const withoutProtect = new WorkflowService(f.pool, new RuntimeService(f.pool), async (db, ctx, action, resource) => {
      if (action === "knowledge.protect") throw Error("FORBIDDEN");
      return authorizeInTransaction(db, ctx, action, resource);
    });
    await expect(withoutProtect.setDocumentState(f.ctx,"topic",{expectedRevision:1,state:"active",restoreTitle:"Renamed",reason:"test"})).rejects.toThrow("FORBIDDEN");
    await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'", [f.workspaceId]);
    await expect(service.setDocumentState(f.ctx,"topic",{expectedRevision:1,state:"active",restoreTitle:"Renamed",reason:"test"})).rejects.toThrow("NOT_FOUND");
    await f.pool.query("INSERT INTO resource_readers VALUES($1,'source','source-a','reviewer')", [f.workspaceId]);
    await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'", [f.workspaceId]);
    await service.setDocumentState(f.ctx,"topic",{expectedRevision:1,state:"active",restoreTitle:"Renamed",reason:"test"});
    await service.setDocumentState(f.ctx,"topic",{expectedRevision:2,state:"trash",reason:"test"});
    const withoutTargetProtect = new WorkflowService(f.pool, new RuntimeService(f.pool), async (db, ctx, action, resource) => {
      if (action === "knowledge.protect" && resource?.id === "folder") throw Error("FORBIDDEN");
      return authorizeInTransaction(db, ctx, action, resource);
    });
    await expect(withoutTargetProtect.setDocumentState(f.ctx,"topic",{expectedRevision:3,state:"active",restoreParentId:"folder",reason:"test"})).rejects.toThrow("FORBIDDEN");
    await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='folder' AND principal_id='reviewer'", [f.workspaceId]);
    await expect(service.setDocumentState(f.ctx,"topic",{expectedRevision:3,state:"active",restoreParentId:"folder",reason:"test"})).rejects.toThrow("NOT_FOUND");
    await f.pool.query("INSERT INTO resource_readers VALUES($1,'page','folder','reviewer')", [f.workspaceId]);
    await service.setDocumentState(f.ctx,"topic",{expectedRevision:3,state:"active",restoreParentId:"folder",reason:"test"});
    expect((await f.pool.query("SELECT state,parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId])).rows[0]).toEqual({state:"active",parent_id:"folder"});
    expect((await f.pool.query("SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",[f.workspaceId])).rowCount).toBe(0);
    expect((await f.pool.query("SELECT number FROM versions WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId])).rows).toEqual([{number:1}]);
  } finally { await f.pool.end(); }
});

test("native HTTP session restores with a new title and parent", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  await addFolder(f);
  const provider = createServer((_req,res) => {res.setHeader("content-type","application/json");res.end(JSON.stringify({sub:"reviewer",groups:["reviewers"]}));});
  await new Promise<void>(resolve => provider.listen(0,"127.0.0.1",resolve));
  const issuer = `http://127.0.0.1:${(provider.address() as {port:number}).port}`;
  const config = new oidc.Configuration({issuer,userinfo_endpoint:issuer+"/userinfo"},"client","secret"); oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool,config,"http://localhost",f.workspaceId,{reviewers:"reviewer"});
  await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",[sessionHash("reviewer"),f.workspaceId]);
  const server = createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:"http://localhost",workspaceId:f.workspaceId}));
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1/workflows/pages/topic/state`;
  const send = (body:object) => fetch(url,{method:"POST",headers:{Cookie:"akh_session=reviewer",Origin:"http://localhost","X-CSRF-Token":"csrf","Content-Type":"application/json"},body:JSON.stringify(body)});
  try {
    let response = await send({expectedRevision:0,state:"trash",reason:"test"}); expect(response.status,await response.clone().text()).toBe(200);
    response = await send({expectedRevision:1,state:"active",restoreTitle:"Renamed",reason:"test"}); expect(response.status,await response.clone().text()).toBe(200);
    response = await send({expectedRevision:2,state:"trash",reason:"test"}); expect(response.status,await response.clone().text()).toBe(200);
    response = await send({expectedRevision:3,state:"active",restoreParentId:"folder",reason:"test"}); expect(response.status,await response.clone().text()).toBe(200);
  } finally {server.closeAllConnections();provider.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>provider.close(()=>resolve()));await f.pool.end();}
});
