import { afterEach, beforeEach, expect, test } from "vitest";
import { Pool } from "pg";
import { fixture, adoptFixture, page } from "../../test-support";
import { draftOf } from "../../../src/domain/wiki";
import { propose } from "../../publication";
import { GovernanceService } from "./service";
import { scanHandoffs } from "./maintenance";

let f: Awaited<ReturnType<typeof fixture>>;
let ownedWorkspaces: string[];
let identityBefore: { issuer: string | null; subject: string | null };
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  ownedWorkspaces = [f.workspaceId];
  identityBefore = (
    await f.pool.query(
      "SELECT issuer,subject FROM access_principals WHERE id='editor'",
    )
  ).rows[0];
  await f.pool.query(
    "UPDATE access_principals SET issuer=NULL,subject=NULL WHERE id='editor'",
  );
  await f.pool.query(
    "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
    [f.workspaceId],
  );
});
afterEach(async () => {
  if (f) {
    await f.pool.query(
      "UPDATE access_principals SET active=true,issuer=$1,subject=$2 WHERE id='editor'",
      [identityBefore.issuer, identityBefore.subject],
    );
    await f.pool.query(
      "DELETE FROM identity_directory_proofs WHERE issuer=$1",
      [`https://directory-${f.workspaceId}.invalid`],
    );
    for (const table of [
      "governance_events",
      "governance_handoffs",
      "governance_business_owners",
    ])
      await f.pool.query(
        `DELETE FROM ${table} WHERE workspace_id=ANY($1::text[])`,
        [ownedWorkspaces],
      );
    await f.pool.end();
  }
});
test("missing current identity authority creates needs-check work, not an inactive-owner assertion", async () => {
  const before = (
    await f.pool.query(
      "SELECT count(*) FROM resource_readers WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0].count;
  const result = await scanHandoffs(f.pool, { batchSize: 25 });
  expect(result.scanned).toBeGreaterThanOrEqual(1);
  expect(result.queued).toBeGreaterThanOrEqual(1);
  expect(result.unknown).toBeGreaterThanOrEqual(1);
  expect(result.skipped).toBe(false);
  const task = (
    await f.pool.query(
      "SELECT * FROM governance_handoffs WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0];
  expect(task).toMatchObject({
    status: "pending",
    owner_id: "editor",
    backup_id: "reviewer",
    work: {
      ownerStatus: "unknown",
      workState: "needs-check",
      assessment: "CURRENT_IDENTITY_UNKNOWN",
    },
  });
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM resource_readers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe(before);
  expect(
    (
      await f.pool.query(
        "SELECT owner_id,revision FROM governance_business_owners WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0],
  ).toEqual({ owner_id: "editor", revision: 1 });
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM access_principals WHERE id='governance-maintenance'",
      )
    ).rowCount,
  ).toBe(0);
});
test("explicit local disabled owner queues actual outstanding work and system audit without human impersonation", async () => {
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  await f.pool.query(
    "INSERT INTO governance_review_assignments(workspace_id,batch_id,revision,batch_hash,assignee_ids,backup_id,deadline) VALUES($1,$2,1,$3,ARRAY['reviewer'],'fixture-owner','2026-10-01T00:00:00Z')",
    [f.workspaceId, b.id, b.hash],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [
      f.workspaceId,
      {
        reviewDue: "2026-10-01T00:00:00Z",
        properties: { environment: "PRIVATE-CONTENT-NOT-FOR-SCANNER" },
      },
    ],
  );
  await f.pool.query(
    "UPDATE access_principals SET active=false WHERE id='editor'",
  );
  const result = await scanHandoffs(f.pool, { batchSize: 100 });
  expect(result.unavailable).toBeGreaterThanOrEqual(1);
  expect(result.queued).toBeGreaterThanOrEqual(1);
  const task = (
    await f.pool.query(
      "SELECT work FROM governance_handoffs WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0].work;
  expect(task).toMatchObject({
    ownerStatus: "unavailable",
    workState: "handoff-required",
    assessment: "PRINCIPAL_DISABLED",
    proposalIds: [b.id],
    proposalCount: 1,
    reviewBatchIds: [b.id],
    reviewCount: 1,
    reviewDue: "2026-10-01T00:00:00Z",
  });
  const events = (
    await f.pool.query(
      "SELECT actor_id,reason,data FROM governance_events WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actor_id: "governance-maintenance",
    data: { systemActor: true, assessment: "PRINCIPAL_DISABLED" },
  });
  expect(JSON.stringify([task, events])).not.toContain(
    "PRIVATE-CONTENT-NOT-FOR-SCANNER",
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM operations_audit_chain WHERE workspace_id=$1 AND event->>'operation'='business-owner.maintenance.scan'",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("1");
});
test("cursor and dedupe survive a scanner restart and fairly visit later workspaces", async () => {
  const workspaces = [f.workspaceId];
  for (let n = 0; n < 3; n++) {
    const other = await fixture();
    await adoptFixture(other.pool, other.workspaceId);
    await other.pool.query(
      "INSERT INTO governance_business_owners(workspace_id,page_id,revision,owner_id,backup_id) VALUES($1,'topic',1,'editor','reviewer')",
      [other.workspaceId],
    );
    workspaces.push(other.workspaceId);
    ownedWorkspaces.push(other.workspaceId);
    await other.pool.end();
  }
  const count = Number(
    (await f.pool.query("SELECT count(*) FROM governance_business_owners"))
      .rows[0].count,
  );
  for (let n = 0; n < count; n++)
    expect(await scanHandoffs(f.pool, { batchSize: 1 })).toMatchObject({
      scanned: 1,
    });
  expect(
    (
      await f.pool.query(
        "SELECT workspace_id FROM governance_handoffs WHERE workspace_id=ANY($1::text[]) ORDER BY workspace_id",
        [workspaces],
      )
    ).rows.map((r) => r.workspace_id),
  ).toEqual(workspaces.sort());
  // Reconstruct a worker with a new connection pool: no in-memory cursor survives.
  const restarted = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
  });
  try {
    expect(await scanHandoffs(restarted, { batchSize: 1 })).toMatchObject({
      scanned: 1,
      queued: 0,
    });
  } finally {
    await restarted.end();
  }
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM governance_handoffs WHERE workspace_id=ANY($1::text[])",
        [workspaces],
      )
    ).rows[0].count,
  ).toBe("4");
});
test("fresh verified directory status distinguishes known-valid from missing or expired proof", async () => {
  const issuer = `https://directory-${f.workspaceId}.invalid`;
  await f.pool.query(
    "UPDATE access_principals SET issuer=$1,subject='editor' WHERE id='editor'",
    [issuer],
  );
  await f.pool.query(
    "INSERT INTO identity_directory_proofs VALUES('editor',$1,clock_timestamp(),clock_timestamp()+interval '60 seconds')",
    [issuer],
  );
  expect(
    (await scanHandoffs(f.pool, { batchSize: 100 })).valid,
  ).toBeGreaterThanOrEqual(1);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM governance_handoffs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  await f.pool.query(
    "UPDATE identity_directory_proofs SET verified_at=clock_timestamp()-interval '3 minutes',valid_until=clock_timestamp()-interval '1 minute' WHERE principal_id='editor' AND issuer=$1",
    [issuer],
  );
  expect(
    (await scanHandoffs(f.pool, { batchSize: 100 })).unknown,
  ).toBeGreaterThanOrEqual(1);
  expect(
    (
      await f.pool.query(
        "SELECT work->>'ownerStatus' AS status FROM governance_handoffs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].status,
  ).toBe("unknown");
});
test("known raw-source access loss wins over missing external proof and never grants the source back", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect(
    (await scanHandoffs(f.pool, { batchSize: 100 })).unavailable,
  ).toBeGreaterThanOrEqual(1);
  expect(
    (
      await f.pool.query(
        "SELECT work->>'assessment' AS reason FROM governance_handoffs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].reason,
  ).toBe("SOURCE_ACCESS_LOST");
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  const service = new GovernanceService(f.pool, async () => {});
  await expect(service.handoffInbox(f.reader)).rejects.toThrow("FORBIDDEN");
});
test("lineage budget produces needs-check rather than a false inactive verdict", async () => {
  await f.pool.query("INSERT INTO resources VALUES($1,'page','parent')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'parent',jsonb_set(data,'{id}','\"parent\"') FROM pages WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'parent',1,$2)", [
    f.workspaceId,
    page.versions[0],
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'page','parent','editor')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','parent')",
    [f.workspaceId],
  );
  await scanHandoffs(f.pool, { batchSize: 100, maxLineagePages: 1 });
  expect(
    (
      await f.pool.query(
        "SELECT work FROM governance_handoffs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].work,
  ).toMatchObject({
    ownerStatus: "unknown",
    workState: "needs-check",
    assessment: "LINEAGE_LIMIT_NEEDS_CHECK",
  });
});
test("concurrent maintenance skips explicitly and an audit failure rolls back task plus durable cursor", async () => {
  const held = await f.pool.connect();
  await held.query("BEGIN");
  await held.query("SELECT pg_advisory_xact_lock(7203102)");
  try {
    expect(await scanHandoffs(f.pool)).toEqual({
      scanned: 0,
      queued: 0,
      unknown: 0,
      unavailable: 0,
      valid: 0,
      skipped: true,
    });
  } finally {
    await held.query("ROLLBACK");
    held.release();
  }
  await f.pool.query(
    "CREATE FUNCTION fail_maintenance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event->>'operation'='business-owner.maintenance.scan' THEN RAISE EXCEPTION 'MAINTENANCE_AUDIT_FAILED'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER fail_maintenance_audit BEFORE INSERT ON operations_audit_chain FOR EACH ROW EXECUTE FUNCTION fail_maintenance_audit()",
  );
  try {
    await expect(scanHandoffs(f.pool, { batchSize: 100 })).rejects.toThrow(
      "MAINTENANCE_AUDIT_FAILED",
    );
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM governance_handoffs WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM governance_events WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.query(
      "DROP TRIGGER fail_maintenance_audit ON operations_audit_chain",
    );
    await f.pool.query("DROP FUNCTION fail_maintenance_audit()");
  }
  expect(
    (await scanHandoffs(f.pool, { batchSize: 100 })).queued,
  ).toBeGreaterThanOrEqual(1);
});
