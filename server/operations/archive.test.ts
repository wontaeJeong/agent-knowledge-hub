import { test, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { OperationsService, appendOperationalAudit } from "./service";
import {
  archiveAudit,
  verifyArchivedSegment,
  verifyArchiveHistory,
} from "./archive";
import { transaction } from "../database";
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
test("over10000 actual DB audit records archive bounded segments BEFORE hot deletion, preserve root and next sequence", async () => {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  const authorize = async () => {};
  const service = new OperationsService(f.pool, authorize);
  const initial = (await service.auditRows(ctx)).length;
  await transaction(f.pool, f.workspaceId, async (db) => {
    for (let i = 0; i < 10020; i++)
      await appendOperationalAudit(db, ctx, { operation: "test.event" });
  });
  await f.pool.query(
    "UPDATE operations_audit_chain SET created_at=now()-interval '400 days' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const objects = new Map<string, string>(),
    key = "encryption".repeat(5),
    signing = "independent-signing".repeat(4),
    target = {
      put: async (name: string, body: string) => {
        objects.set(name, body);
      },
      get: async (name: string) => objects.get(name)!,
      list: async () => [...objects.keys()].map((name) => ({ name })),
    };
  let head: string | null = null;
  const result = await archiveAudit(service, ctx, {
    target,
    key,
    signingKey: signing,
    readAnchor: async () => head,
    anchor: async (name, body) => {
      objects.set(name, body);
      head = body;
    },
    batchSize: 1000,
    confirm: "ARCHIVE_AND_PRUNE_EXPIRED_AUDIT",
  });
  expect(result.archived).toBe(10020 + initial);
  const receipts = (
    await f.pool.query(
      "SELECT * FROM operations_audit_archives WHERE workspace_id=$1 ORDER BY last_sequence",
      [f.workspaceId],
    )
  ).rows;
  expect(receipts.length).toBe(11);
  expect(receipts.at(-1).last_sequence).toBe(String(10020 + initial));
  for (const r of receipts)
    expect(
      verifyArchivedSegment(objects.get(r.target_name)!, key, signing, r),
    ).toBe(true);
  await service.appendAudit(ctx, { operation: "test.next" });
  expect((await service.auditRows(ctx))[0].sequence).toBe(
    String(10021 + initial),
  );
  expect(
    (
      await verifyArchiveHistory(service, ctx, {
        target,
        key,
        signingKey: signing,
      })
    ).verified,
  ).toBe(true);
  await f.pool.query(
    "DELETE FROM operations_audit_archives WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    verifyArchiveHistory(service, ctx, { target, key, signingKey: signing }),
  ).rejects.toThrow("AUDIT_EXTERNAL_HISTORY_MISSING_FROM_DATABASE");
}, 120000);
test("failed independent target cannot delete unarchived audit", async () => {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    service = new OperationsService(f.pool, async () => {});
  await service.appendAudit(ctx, { operation: "test.event" });
  const count = (await service.auditRows(ctx)).length;
  await f.pool.query(
    "UPDATE operations_audit_chain SET created_at=now()-interval '400 days' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    archiveAudit(service, ctx, {
      target: {
        put: async () => {
          throw Error("OFFPOD_DOWN");
        },
        get: async () => "",
        list: async () => [],
      },
      key: "key".repeat(20),
      signingKey: "signing".repeat(10),
      readAnchor: async () => null,
      anchor: async () => {},
      batchSize: 1000,
      confirm: "ARCHIVE_AND_PRUNE_EXPIRED_AUDIT",
    }),
  ).rejects.toThrow("OFFPOD_DOWN");
  expect((await service.auditRows(ctx)).length).toBe(count);
});
