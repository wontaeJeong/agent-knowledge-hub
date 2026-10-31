import { test, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure, replayProductErasure } from "./erasure";
import { operationsAuthorizer } from "./authorization";
import { recordModelUsage } from "../model-usage";
import { handleCredentialRequest, pollDevice, startDevice } from "../agent-credentials";
const pools: Pool[] = [];
test("administrative audit metadata export is explicit opt-in, never reader escalation or raw-source export fallback", async () => {
  const f = await setup();
  const enabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: true,
      }),
    ),
    disabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: false,
      }),
    );
  await expect(disabled.auditRows(f.ctx)).rejects.toThrow(
    "ADMIN_AUDIT_EXPORT_POLICY_DISABLED",
  );
  await expect(enabled.auditRows(f.reader)).rejects.toThrow("FORBIDDEN");
  expect((await enabled.auditRows(f.ctx)).length).toBeGreaterThan(0);
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  return {
    ...f,
    ctx: { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    s: new OperationsService(f.pool, authorizeInTransaction),
  };
}
test("credential request inventory follows its key workspace without mixing another workspace", async () => {
  const a = await setup(), b = await setup();
  for (const f of [a, b]) {
    const key = randomUUID();
    await f.pool.query(
      "INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','fixture',$3,'test','read',now()+interval '1 day')",
      [key, f.workspaceId, randomUUID()],
    );
    await f.pool.query("INSERT INTO agent_key_requests(key_id,route) VALUES($1,'/api/v1/pages')", [key]);
  }
  const aPreview = await previewErasure(a.s, a.ctx, { scope: "workspace" });
  const bPreview = await previewErasure(b.s, b.ctx, { scope: "workspace" });
  expect(aPreview.counts.agent_key_requests).toBe(1);
  expect(bPreview.counts.agent_key_requests).toBe(1);
});
test("credential and model usage rows block resource and workspace erasure and recovery replay", async () => {
  const a = await setup(), b = await setup();
  const preview = await previewErasure(a.s, a.ctx, {scope: "resource", resource: {kind: "source", id: "source-a"}});
  await a.pool.query("INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms) VALUES($1,'editor','query','openai','external','fixture',true,1)", [a.workspaceId]);
  const input = {scope: "resource" as const, resource: {kind: "source" as const, id: "source-a"}};
  const current = await previewErasure(a.s, a.ctx, input);
  await expect(executeErasure(a.s, a.ctx, {...input, previewHash: current.previewHash, confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  const workspace = await previewErasure(a.s, a.ctx, {scope: "workspace"});
  await expect(executeErasure(a.s, a.ctx, {scope: "workspace", previewHash: workspace.previewHash, confirm: "ERASE_ENTIRE_WORKSPACE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  const client = await a.pool.connect();
  try {
    await client.query("BEGIN");
    await expect(replayProductErasure(client, a.workspaceId, [input.resource])).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
    await client.query("ROLLBACK");
  } finally { client.release(); }
  expect((await a.pool.query("SELECT data FROM sources WHERE workspace_id=$1 AND id='source-a'", [a.workspaceId])).rowCount).toBe(1);
  expect((await a.pool.query("SELECT count(*)::int AS n FROM model_usage_events WHERE workspace_id=$1", [a.workspaceId])).rows[0].n).toBe(1);
  expect((await previewErasure(b.s, b.ctx, input)).previewHash).toBeTruthy();
  expect(preview.previewHash).toBeTruthy();
});
test("completed resource erasure fences later credential issuance and model usage", async () => {
  const f = await setup();
  const input = {scope: "resource" as const, resource: {kind: "source" as const, id: "source-a"}};
  const preview = await previewErasure(f.s, f.ctx, input);
  await executeErasure(f.s, f.ctx, {...input, previewHash: preview.previewHash, confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE"});
  const old = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  try {
    await expect(handleCredentialRequest(f.pool, f.ctx, "POST", "/api/v1/credentials/keys", {name:"fixture",scope:"read"}, "http://localhost")).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    await expect(recordModelUsage({pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"}, {operation:"query",provider:"openai",backend:"external",model:"fixture",deploymentId:null,succeeded:true,latencyMs:1,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null,errorCode:null})).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
  } finally {
    if (old === undefined) delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = old;
  }
});
test("recovery replay aborts instead of releasing unresolved unlineaged content", async () => {
  const f = await setup();
  await f.pool.query("INSERT INTO workflow_preferences(workspace_id,principal_id,revision,data) VALUES($1,'editor',1,$2)", [f.workspaceId, {content:"fixture unlineaged"}]);
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await expect(replayProductErasure(db, f.workspaceId, [{kind:"source",id:"source-a"}])).rejects.toThrow("RECOVERY_ERASURE_INCOMPLETE");
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect((await f.pool.query("SELECT data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id='editor'",[f.workspaceId])).rows[0].data.content).toBe("fixture unlineaged");
});

test("exclusive erasure gate fences concurrent key and usage writes after tombstone commit", async () => {
  const f = await setup(), db = await f.pool.connect();
  const old = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(822025)");
    await db.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','source-a','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
    const key = handleCredentialRequest(f.pool, f.ctx, "POST", "/api/v1/credentials/keys", {name:"fixture",scope:"read"}, "http://localhost");
    const usage = recordModelUsage({pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"}, {operation:"query",provider:"openai",backend:"external",model:"fixture",deploymentId:null,succeeded:true,latencyMs:1,inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costUsd:null,errorCode:null});
    const assertions = Promise.all([
      expect(key).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED"),
      expect(usage).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED"),
    ]);
    let waiting = 0;
    for (let i=0; i<1000 && waiting<2; i++) {
      waiting = (await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=822025 AND mode='ShareLock' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n;
    }
    expect(waiting).toBeGreaterThanOrEqual(2);
    await db.query("COMMIT");
    await assertions;
    expect((await f.pool.query("SELECT count(*)::int AS n FROM agent_api_keys WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
  } finally {
    await db.query("ROLLBACK"); db.release();
    if (old === undefined) delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = old;
  }
});
test("credential rows and resource-bearing routes block erasure without changing either workspace", async () => {
  const a = await setup(), b = await setup(), key = randomUUID();
  await a.pool.query("INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','fixture',$3,'test','read',now()+interval '1 day')",[key,a.workspaceId,randomUUID()]);
  await a.pool.query("INSERT INTO agent_key_requests(key_id,route) VALUES($1,'/api/v1/pages/topic')",[key]);
  const input = {scope:"resource" as const,resource:{kind:"page" as const,id:"topic"}};
  const preview = await previewErasure(a.s,a.ctx,input);
  await expect(executeErasure(a.s,a.ctx,{...input,previewHash:preview.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"})).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED");
  expect((await a.pool.query("SELECT route FROM agent_key_requests WHERE key_id=$1",[key])).rows[0].route).toBe("/api/v1/pages/topic");
  const other = await previewErasure(b.s,b.ctx,input);
  await executeErasure(b.s,b.ctx,{...input,previewHash:other.previewHash,confirm:"ERASE_PREVIEWED_RESOURCE_LINEAGE"});
  expect((await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1",[key])).rows[0].revoked_at).toBeNull();
  const db = await a.pool.connect();
  try { await db.query("BEGIN"); await expect(replayProductErasure(db,a.workspaceId,[],true)).rejects.toThrow("ERASURE_AGENT_DATA_UNSUPPORTED"); }
  finally { await db.query("ROLLBACK"); db.release(); }
});
test("restored device grant cannot issue credentials after an erasure tombstone", async () => {
  const f=await setup(), clientId=randomUUID(), deviceCode="A".repeat(43);
  await f.pool.query("INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','fixture')",[clientId,f.workspaceId]);
  await f.pool.query("INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,status,approved_by,expires_at) VALUES($1,$2,$3,$4,'ABCDEFGH','read','approved','editor',now()+interval '5 minutes')",[randomUUID(),clientId,f.workspaceId,createHash("sha256").update(deviceCode).digest("hex")]);
  await f.pool.query("INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'source','source-a','[]','[]',true,'fixture-owner')",[f.workspaceId,randomUUID()]);
  const old=process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED="true";
  try {
    await expect(startDevice(f.pool,{clientId,scope:"read"},"http://localhost")).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    await expect(pollDevice(f.pool,{deviceCode})).rejects.toThrow("ERASURE_AGENT_WRITES_FENCED");
    expect((await f.pool.query("SELECT count(*)::int AS n FROM agent_api_keys WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
  } finally { if(old===undefined)delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED; else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED=old; }
});
test("actual append-only refinement/draft/answer copies are erased by approved transitive lineage, roots/receipts persist", async () => {
  const f = await setup(),
    secret = "LEGAL_SECRET_72819";
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','derived-draft',1,$2)",
    [f.workspaceId, { pageId: "topic", content: secret }],
  );
  await f.pool.query(
    "INSERT INTO refinement_claims(workspace_id,id,data) VALUES($1,'derived-claim',$2)",
    [
      f.workspaceId,
      { id: "derived-claim", sourceIds: ["source-a"], claim: secret },
    ],
  );
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  const request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    preview = await previewErasure(f.s, f.ctx, request);
  expect(preview.counts.refinement_claims).toBe(1);
  expect(preview.counts.workflow_drafts).toBe(1);
  await expect(
    executeErasure(f.s, f.editor, {
      ...request,
      previewHash: preview.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow();
  const result = await executeErasure(f.s, f.ctx, {
    ...request,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(["completed", "blocked"]).toContain(result.status);
  expect(result.allCopiesErased).toBe(false);
  for (const table of [
    "sources",
    "versions",
    "workflow_drafts",
    "refinement_claims",
  ])
    expect(
      JSON.stringify(
        (
          await f.pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT status,counts FROM operations_erasure_receipts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM operations_audit_chain WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).not.toBe("0");
});
test("legal hold and stale preview block writes; separate explicit workspace Owner preview required", async () => {
  const f = await setup(),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    };
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','page','topic','fixture-owner')",
    [f.workspaceId],
  );
  const held = await previewErasure(f.s, f.ctx, request);
  expect(held.legalHold).toBe(true);
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: held.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("LEGAL_HOLD");
  await f.pool.query(
    "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const p = await previewErasure(f.s, f.ctx, request);
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: p.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_PREVIEW_STALE");
  const all = await previewErasure(f.s, f.ctx, { scope: "workspace" });
  await expect(
    executeErasure(f.s, f.ctx, {
      scope: "workspace",
      previewHash: all.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_CONFIRMATION_REQUIRED");
  expect(
    (
      await executeErasure(f.s, f.ctx, {
        scope: "workspace",
        previewHash: all.previewHash,
        confirm: "ERASE_ENTIRE_WORKSPACE",
      })
    ).status,
  ).toBe("completed");
});
