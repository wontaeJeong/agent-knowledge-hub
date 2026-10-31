import { afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import {
  authenticateAgentKey,
  handleCredentialRequest,
  pollDevice,
  startDevice,
} from "../agent-credentials";
import { revokeWorkspaceCredentials } from "./credential-erasure.test-support";

const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

test("a fenced workspace loses credentials without modifying another workspace, and retry is harmless", async () => {
  const a = await fixture(),
    b = await fixture();
  pools.push(a.pool, b.pool);
  const key = randomUUID(),
    client = randomUUID(),
    grant = randomUUID(),
    other = randomUUID();
  await a.pool.query(
    "INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','client')",
    [client, a.workspaceId],
  );
  await a.pool.query(
    "INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','key',$3,'test','read',now()+interval '1 day'),($4,$5,'editor','key',$6,'test','read',now()+interval '1 day')",
    [key, a.workspaceId, randomUUID(), other, b.workspaceId, randomUUID()],
  );
  await a.pool.query(
    "INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,status,approved_by,expires_at) VALUES($1,$2,$3,$4,$5,'read','approved','editor',now()+interval '5 minutes')",
    [grant, client, a.workspaceId, randomUUID(), randomUUID().slice(0, 8)],
  );
  await a.pool.query(
    "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,'test','workspace','test','blocked','{}')",
    [a.workspaceId, randomUUID()],
  );
  await revokeWorkspaceCredentials(a.pool, a.workspaceId);
  await revokeWorkspaceCredentials(a.pool, a.workspaceId);
  expect(
    (
      await a.pool.query(
        "SELECT revoked_at IS NOT NULL AS revoked FROM agent_api_keys WHERE id=$1",
        [key],
      )
    ).rows[0].revoked,
  ).toBe(true);
  expect(
    (
      await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1", [
        other,
      ])
    ).rows[0].revoked_at,
  ).toBeNull();
  expect(
    (
      await a.pool.query(
        "SELECT active FROM agent_device_clients WHERE id=$1",
        [client],
      )
    ).rows[0].active,
  ).toBe(false);
  expect(
    (
      await a.pool.query("SELECT status FROM agent_device_grants WHERE id=$1", [
        grant,
      ])
    ).rows[0].status,
  ).toBe("denied");
});

test("missing workspace or exact workspace fence fails without changing keys", async () => {
  const a = await fixture(),
    b = await fixture();
  pools.push(a.pool, b.pool);
  const key = randomUUID();
  await a.pool.query(
    "INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','key',$3,'test','read',now()+interval '1 day')",
    [key, a.workspaceId, randomUUID()],
  );
  await a.pool.query(
    "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,'test','workspace','test','blocked','{}'),($3,$4,'test','resource','test','completed','{}')",
    [b.workspaceId, randomUUID(), a.workspaceId, randomUUID()],
  );
  await expect(
    revokeWorkspaceCredentials(a.pool, a.workspaceId),
  ).rejects.toThrow("ERASURE_FENCE_REQUIRED");
  await expect(
    revokeWorkspaceCredentials(a.pool, randomUUID()),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    (
      await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1", [
        key,
      ])
    ).rows[0].revoked_at,
  ).toBeNull();
});

test("cross workspace references fail closed in both directions without modifying credentials", async () => {
  const a = await fixture(),
    b = await fixture();
  pools.push(a.pool, b.pool);
  const client = randomUUID(),
    key = randomUUID();
  for (const f of [a, b])
    await a.pool.query(
      "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,'test','workspace','test','blocked','{}')",
      [f.workspaceId, randomUUID()],
    );
  await a.pool.query(
    "INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','client')",
    [client, a.workspaceId],
  );
  await a.pool.query(
    "INSERT INTO agent_api_keys(id,workspace_id,principal_id,device_client_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor',$3,'key',$4,'test','read',now()+interval '1 day')",
    [key, b.workspaceId, client, randomUUID()],
  );
  for (const f of [a, b])
    await expect(
      revokeWorkspaceCredentials(a.pool, f.workspaceId),
    ).rejects.toThrow("ERASURE_CREDENTIAL_SCOPE_MISMATCH");
  expect(
    (
      await a.pool.query(
        "SELECT active FROM agent_device_clients WHERE id=$1",
        [client],
      )
    ).rows[0].active,
  ).toBe(true);
  expect(
    (
      await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1", [
        key,
      ])
    ).rows[0].revoked_at,
  ).toBeNull();
});

test("an update failure rolls back earlier revocation and client deactivation", async () => {
  const a = await fixture();
  pools.push(a.pool);
  const client = randomUUID(),
    key = randomUUID();
  await a.pool.query(
    "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,'test','workspace','test','blocked','{}')",
    [a.workspaceId, randomUUID()],
  );
  await a.pool.query(
    "INSERT INTO agent_device_clients(id,workspace_id,principal_id,name) VALUES($1,$2,'editor','client')",
    [client, a.workspaceId],
  );
  await a.pool.query(
    "INSERT INTO agent_api_keys(id,workspace_id,principal_id,name,token_hash,suffix,scope,expires_at) VALUES($1,$2,'editor','key',$3,'test','read',now()+interval '1 day')",
    [key, a.workspaceId, randomUUID()],
  );
  await a.pool.query(
    "INSERT INTO agent_device_grants(id,client_id,workspace_id,device_hash,user_code,requested_scope,expires_at) VALUES($1,$2,$3,$4,$5,'read',now()+interval '5 minutes')",
    [
      randomUUID(),
      client,
      a.workspaceId,
      randomUUID(),
      randomUUID().slice(0, 8),
    ],
  );
  await a.pool.query(
    "CREATE FUNCTION test_credential_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$",
  );
  await a.pool.query(
    "CREATE TRIGGER test_credential_failure BEFORE UPDATE ON agent_device_grants FOR EACH ROW EXECUTE FUNCTION test_credential_failure()",
  );
  try {
    await expect(
      revokeWorkspaceCredentials(a.pool, a.workspaceId),
    ).rejects.toThrow("test failure");
  } finally {
    await a.pool.query(
      "DROP TRIGGER test_credential_failure ON agent_device_grants",
    );
    await a.pool.query("DROP FUNCTION test_credential_failure()");
  }
  expect(
    (
      await a.pool.query("SELECT revoked_at FROM agent_api_keys WHERE id=$1", [
        key,
      ])
    ).rows[0].revoked_at,
  ).toBeNull();
  expect(
    (
      await a.pool.query(
        "SELECT active FROM agent_device_clients WHERE id=$1",
        [client],
      )
    ).rows[0].active,
  ).toBe(true);
});

test("exclusive gate serializes racing issue and fence prevents later key and device use", async () => {
  const a = await fixture();
  pools.push(a.pool);
  await adoptFixture(a.pool, a.workspaceId);
  const previous = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  const blocker = await a.pool.connect();
  try {
    const issued = await handleCredentialRequest(
      a.pool,
      a.editor,
      "POST",
      "/api/v1/credentials/keys",
      { name: "fixture", scope: "read" },
      "http://localhost",
    );
    const token = (issued!.body as { token: string }).token;
    const registered = await handleCredentialRequest(
      a.pool,
      a.editor,
      "POST",
      "/api/v1/credentials/clients",
      { name: "fixture" },
      "http://localhost",
    );
    const device = await startDevice(
      a.pool,
      { clientId: (registered!.body as { id: string }).id, scope: "read" },
      "http://localhost",
    );
    const deviceCode = (device.body as { deviceCode: string }).deviceCode;
    await a.pool.query(
      "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts) VALUES($1,$2,'test','workspace','test','blocked','{}')",
      [a.workspaceId, randomUUID()],
    );
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      a.workspaceId,
    ]);
    const revoke = revokeWorkspaceCredentials(a.pool, a.workspaceId);
    let locked = false;
    for (let i = 0; i < 100 && !locked; i++) {
      const r = await a.pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=822025 AND objsubid=1 AND mode='ExclusiveLock' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS locked",
      );
      locked = r.rows[0].locked;
      if (!locked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(locked).toBe(true);
    const racing = handleCredentialRequest(
      a.pool,
      a.editor,
      "POST",
      "/api/v1/credentials/keys",
      { name: "late", scope: "read" },
      "http://localhost",
    ).then(
      () => "unexpected",
      (e) => e.message,
    );
    await blocker.query("COMMIT");
    await revoke;
    expect(await racing).toBe("ERASURE_AGENT_WRITES_FENCED");
    expect(await authenticateAgentKey(a.pool, token)).toBeNull();
    await expect(pollDevice(a.pool, { deviceCode })).rejects.toThrow(
      "ERASURE_AGENT_WRITES_FENCED",
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    if (previous === undefined)
      delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = previous;
  }
});
