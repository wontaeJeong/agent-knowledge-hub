import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure, replayProductErasure } from "./erasure";

const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.map((pool) => pool.end())); });

test("preview diagnoses workspace-wide unsupported agent categories without leaking records or crossing spaces", async () => {
  const a = await fixture(), b = await fixture();
  pools.push(a.pool, b.pool);
  await adoptFixture(a.pool, a.workspaceId);
  await adoptFixture(b.pool, b.workspaceId);
  const service = new OperationsService(a.pool, authorizeInTransaction);
  const owner = { workspaceId: a.workspaceId, principalId: "fixture-owner" };
  const other = { workspaceId: b.workspaceId, principalId: "fixture-owner" };
  const input = { scope: "resource" as const, resource: { kind: "source" as const, id: "source-a" } };
  for (const f of [a, b]) await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING", [f.workspaceId]);
  const empty = await previewErasure(service, owner, input);
  expect(empty.agentDataBoundary).toEqual({ scope: "workspace", resourceRelationship: "unknown", apiKeys: false, deviceClients: false, deviceGrants: false, keyAudit: false, modelUsage: false });
  await expect(previewErasure(service, a.reader, input)).rejects.toThrow();
  const key = randomUUID(), client = randomUUID(), secret = `sensitive-${randomUUID()}`;
  await a.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor',$3)", [client, a.workspaceId, secret]);
  expect((await previewErasure(service, owner, input)).agentDataBoundary).toEqual({ ...empty.agentDataBoundary, deviceClients: true });
  await a.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor',$3,$4,'test','read',now()+interval '1 day')", [key, a.workspaceId, secret, randomUUID()]);
  expect((await previewErasure(service, owner, input)).agentDataBoundary).toEqual({ ...empty.agentDataBoundary, deviceClients: true, apiKeys: true });
  await a.pool.query("INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,expires_at) VALUES($1,$2,$3,$4,$5,'read',now()+interval '5 minutes')", [randomUUID(),client,a.workspaceId,randomUUID(),randomUUID().slice(0,8).toUpperCase()]);
  expect((await previewErasure(service, owner, input)).agentDataBoundary).toEqual({ ...empty.agentDataBoundary, deviceClients: true, apiKeys: true, deviceGrants: true });
  await a.pool.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action,reason) VALUES($1,'editor',$2,'revoke',$3)", [a.workspaceId,key,secret]);
  expect((await previewErasure(service, owner, input)).agentDataBoundary).toEqual({ ...empty.agentDataBoundary, deviceClients: true, apiKeys: true, deviceGrants: true, keyAudit: true });
  await a.pool.query("INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms) VALUES($1,'editor','query','openai','external',$2,true,1)", [a.workspaceId,secret]);
  const result = await previewErasure(service, owner, input);
  expect(result.agentDataBoundary).toEqual({ scope: "workspace", resourceRelationship: "unknown", apiKeys: true, deviceClients: true, deviceGrants: true, keyAudit: true, modelUsage: true });
  expect(result.agentDataUnsupported).toBe(true);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(key);
  const workspace = await previewErasure(service, owner, {scope:"workspace"});
  expect(workspace.agentDataBoundary).toEqual(result.agentDataBoundary);
  const isolated = await previewErasure(service, other, input);
  expect(isolated.agentDataBoundary).toEqual(empty.agentDataBoundary);
  await expect(executeErasure(service, owner, {...input, previewHash: result.previewHash, confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  expect((await a.pool.query("SELECT name FROM agent_api_keys WHERE id=$1", [key])).rows[0].name).toBe(secret);
});

test("cross-workspace grants and audits do not disclose their presence but still block execution and replay", async () => {
  const a = await fixture(), b = await fixture();
  pools.push(a.pool, b.pool);
  await adoptFixture(a.pool, a.workspaceId);
  await adoptFixture(b.pool, b.workspaceId);
  for (const f of [a, b]) await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING", [f.workspaceId]);
  const service = new OperationsService(a.pool, authorizeInTransaction);
  const ownerA = { workspaceId: a.workspaceId, principalId: "fixture-owner" };
  const ownerB = { workspaceId: b.workspaceId, principalId: "fixture-owner" };
  const input = { scope: "resource" as const, resource: { kind: "source" as const, id: "source-a" } };
  const key = randomUUID(), client = randomUUID(), secret = `private-${randomUUID()}`, neighborSecret = `neighbor-${randomUUID()}`, grant = randomUUID();
  await a.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor',$3)", [client,a.workspaceId,secret]);
  await a.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor',$3,$4,'test','read',now()+interval '1 day')", [key,a.workspaceId,secret,randomUUID()]);
  const before = await previewErasure(service, ownerA, input);
  await a.pool.query("INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,expires_at) VALUES($1,$2,$3,$4,$5,'read',now()+interval '5 minutes')", [grant,client,b.workspaceId,randomUUID(),randomUUID().slice(0,8).toUpperCase()]);
  await a.pool.query("INSERT INTO agent_key_audit(workspace_id,actor_id,key_id,action,reason) VALUES($1,'editor',$2,'revoke',$3)", [b.workspaceId,key,neighborSecret]);
  const after = await previewErasure(service, ownerA, input);
  expect(after.agentDataBoundary).toEqual(before.agentDataBoundary);
  expect(after).toEqual(before);
  expect(after.agentDataBoundary.deviceGrants).toBe(false);
  expect(after.agentDataBoundary.keyAudit).toBe(false);
  expect(after.agentDataUnsupported).toBe(true);
  expect(JSON.stringify(after)).not.toContain(secret);
  expect(JSON.stringify(after)).not.toContain(key);
  expect(JSON.stringify(after)).not.toContain(grant);
  expect(JSON.stringify(after)).not.toContain(neighborSecret);
  const neighbor = await previewErasure(service, ownerB, input);
  expect(neighbor.agentDataBoundary.deviceGrants).toBe(true);
  expect(neighbor.agentDataBoundary.keyAudit).toBe(true);
  await expect(executeErasure(service, ownerA, {...input, previewHash:after.previewHash, confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  const db = await a.pool.connect();
  try {
    await db.query("BEGIN");
    await expect(replayProductErasure(db, a.workspaceId, [input.resource])).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await a.pool.query("SELECT name FROM agent_api_keys WHERE id=$1", [key])).rows[0].name).toBe(secret);
});

test("policy maintainers still need resource ACL and workspace preview requires ownership", async () => {
  const f = await fixture(); pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query("UPDATE access_grants SET role='admin' WHERE workspace_id=$1 AND principal_id='reviewer'", [f.workspaceId]);
  const service = new OperationsService(f.pool, authorizeInTransaction);
  const db = await f.pool.connect();
  try { await authorizeInTransaction(db, f.ctx, "policy.strengthen"); } finally { db.release(); }
  await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'", [f.workspaceId]);
  await expect(previewErasure(service, f.ctx, {scope:"resource",resource:{kind:"source",id:"source-a"}})).rejects.toThrow();
  await expect(previewErasure(service, f.ctx, {scope:"workspace"})).rejects.toThrow("OWNER_REQUIRED");
});

test("usage inserted after a preview is checked again before erasure", async () => {
  const f = await fixture(); pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING", [f.workspaceId]);
  const service = new OperationsService(f.pool, authorizeInTransaction);
  const owner = {workspaceId:f.workspaceId,principalId:"fixture-owner"};
  const input = {scope:"resource" as const,resource:{kind:"source" as const,id:"source-a"}};
  const before = await previewErasure(service, owner, input);
  expect(before.agentDataUnsupported).toBe(false);
  await f.pool.query("INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms) VALUES($1,'editor','query','openai','external','fixture',true,1)", [f.workspaceId]);
  await expect(executeErasure(service, owner, {...input,previewHash:before.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  expect((await f.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='source-a'", [f.workspaceId])).rows[0].data.content).toContain("실패 시 재시도한다");
});
