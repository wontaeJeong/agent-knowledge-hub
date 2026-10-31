import { describe, test, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import {
  OperationsService,
  verifyAudit,
  verifyAuditAnchor,
  sealExport,
  openExport,
  replayTombstones,
} from "./service";
import { healthSnapshot, metricsText, ShutdownController } from "./monitoring";
import { operationsRoutes } from "./routes";
import { previewErasure, executeErasure } from "./erasure";
import { operationalTelemetry } from "./observability";
import type { WorkflowAuthorizer } from "../workflows/service";
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
const authorize: WorkflowAuthorizer = async (db, ctx, action, resource) => {
  if (ctx.principalId !== "fixture-owner") throw Error("FORBIDDEN");
  if (resource) {
    const r = await db.query(
      "SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND principal_id=$4",
      [ctx.workspaceId, resource.kind, resource.id, ctx.principalId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
  }
  if (
    ![
      "space.admin",
      "policy.strengthen",
      "data.export",
      "knowledge.read",
    ].includes(action)
  )
    throw Error("FORBIDDEN");
};
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
    admin: { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    s: new OperationsService(f.pool, authorize, {
      physicalDeletionGateConfirmed: true,
    }),
  };
}
describe("real DB operational controls", () => {
  test("telemetry queries actual queue/database size and preserves missing model charges as null", async () => {
    const { pool } = await setup();
    const t = await operationalTelemetry(pool);
    expect(t.databaseBytes).toBeGreaterThan(0);
    expect(t.queueDepth).toBe(0);
    expect(t.costMicros).toBe(null);
    expect(t.inputTokens).toBe(null);
    expect(t.lastBackup).toBe(null);
  });
  test("admin retention CAS, fail closed ACL and encrypted signed audit export tampering", async () => {
    const { pool, s, admin, reader, workspaceId } = await setup();
    await expect(
      s.setPolicy(reader, {
        expectedRevision: 0,
        auditDays: 30,
        telemetryDays: 7,
        backupDays: 14,
      }),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      await s.setPolicy(admin, {
        expectedRevision: 0,
        auditDays: 30,
        telemetryDays: 7,
        backupDays: 14,
      }),
    ).toMatchObject({ revision: 1 });
    await expect(
      s.setPolicy(admin, {
        expectedRevision: 0,
        auditDays: 30,
        telemetryDays: 7,
        backupDays: 14,
      }),
    ).rejects.toThrow("STALE_VERSION");
    await s.appendAudit(admin, {
      operation: "policy.change",
      resource: { kind: "page", id: "topic" },
    });
    const rows = await s.auditRows(admin);
    expect(verifyAudit(rows)).toBe(true);
    const key = "secret".repeat(10),
      signing = "independent-signing".repeat(3);
    const encrypted = sealExport(rows, key, signing);
    expect(encrypted).not.toContain("policy.change");
    expect(openExport(encrypted, key, signing)).toEqual(rows);
    expect(verifyAuditAnchor(rows, encrypted, key, signing)).toBe(true);
    expect(verifyAuditAnchor([], encrypted, key, signing)).toBe(false);
    expect(() => openExport(encrypted, key, "wrong")).toThrow();
    await pool.query(
      "UPDATE operations_audit_chain SET event='{}' WHERE workspace_id=$1",
      [workspaceId],
    );
    await expect(s.auditRows(admin)).rejects.toThrow("AUDIT_TAMPER_DETECTED");
  });
  test("physical purge only uses explicitly approved tombstone hashes; shared live references survive", async () => {
    const { pool, s, admin, workspaceId } = await setup();
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    await pool.query(
      "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'ops-blob','source','source-a',$2,1,'text/plain','a.txt','clean','fixture-owner')",
      [workspaceId, hash],
    );
    const request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    };
    const preview = await previewErasure(s, admin, request);
    await executeErasure(s, admin, {
      ...request,
      previewHash: preview.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    });
    // The bytes are shared by an unrelated live page: purging a hash must not damage that page.
    await pool.query(
      "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'shared-blob','page','topic',$2,1,'text/plain','a.txt','clean','fixture-owner')",
      [workspaceId, hash],
    );
    const removed: string[] = [];
    expect(
      await s.purgeApprovedBlobs(admin, async (h) => {
        removed.push(h);
      }),
    ).toMatchObject({ removed: 0 });
    expect(removed).toEqual([]);
    // Explicit approval of the second reference permits idempotent physical removal.
    await pool.query(
      "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,'page','topic',$3,'[]',true,'fixture-owner')",
      [workspaceId, randomUUID(), JSON.stringify([hash])],
    );
    expect(
      await s.purgeApprovedBlobs(admin, async (h) => {
        removed.push(h);
      }),
    ).toMatchObject({ removed: 1 });
    expect(removed).toEqual([hash]);
  });
  test("narrowing tombstone replay never resurrects old grants; legal delete requires explicit confirmation", async () => {
    const { pool, s, admin, reader, workspaceId } = await setup();
    await expect(
      s.tombstone(reader, {
        resource: { kind: "source", id: "source-a" },
        readers: [],
        deleteContent: false,
        confirm: "APPLY",
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      s.tombstone(admin, {
        resource: { kind: "source", id: "source-a" },
        readers: [],
        deleteContent: true,
        confirm: "APPLY",
      }),
    ).rejects.toThrow();
    await s.tombstone(admin, {
      resource: { kind: "source", id: "source-a" },
      readers: ["fixture-owner"],
      deleteContent: false,
      confirm: "APPLY",
    });
    const records = await s.tombstones(admin);
    await pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a','reader') ON CONFLICT DO NOTHING",
      [workspaceId],
    );
    await replayTombstones(pool, records);
    const result = await pool.query(
      "SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a'",
      [workspaceId],
    );
    expect(result.rows).toEqual([{ principal_id: "fixture-owner" }]);
    await expect(
      s.tombstone(admin, {
        resource: { kind: "source", id: "source-a" },
        readers: [],
        deleteContent: true,
        confirm: "DELETE_CONTENT_AND_QUARANTINE",
      }),
    ).rejects.toThrow("ERASURE_PREVIEW_REQUIRED");
    const source = await pool.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [workspaceId, "source-a"],
    );
    expect(source.rows[0].data.content).not.toBe("");
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM resource_readers WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0].count,
    ).not.toBe("0");
  });
  test("durable deduplicated alert retry survives service recreation", async () => {
    const { pool, s } = await setup();
    const code = "DATABASE_UNAVAILABLE",
      incident = randomUUID();
    await s.queueAlert(code, incident);
    await s.queueAlert(code, incident);
    await s.deliverAlerts(async () => {
      throw Error("outage");
    });
    await pool.query(
      "UPDATE operations_alert_outbox SET next_attempt_at=now() WHERE dedupe_key=$1",
      [incident],
    );
    const next = new OperationsService(pool, authorize);
    let sent = 0;
    await next.deliverAlerts(async (alert) => {
      expect(alert.code).toBe(code);
      sent++;
    });
    expect(sent).toBe(1);
    await next.deliverAlerts(async () => {
      sent++;
    });
    expect(sent).toBe(1);
  });
  test("router enforces admin/export checks and anchors encrypted audit before reporting success", async () => {
    const { s, admin, reader, pool, workspaceId } = await setup();
    await s.appendAudit(admin, { operation: "admin.access" });
    const key = "encryption".repeat(5),
      signing = "signing".repeat(8);
    let anchored = "";
    const archiveTarget = {
      put: async () => {},
      get: async () => "",
      list: async () => [],
    };
    const route = operationsRoutes(s, {
      encryptionKey: key,
      signingKey: signing,
      archiveTarget,
      readAnchor: async () => anchored || null,
      anchor: async (_name, body) => {
        anchored = body;
      },
    });
    let response: unknown;
    const request = {
      method: "POST",
      path: "/api/v1/operations/audit/export",
      body: { confirm: "EXPORT_ENCRYPTED_AUDIT" },
      ctx: admin,
      send: (_status: number, body: unknown) => {
        response = body;
      },
    };
    await expect(route({ ...request, ctx: reader })).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(anchored).toBe("");
    expect(await route(request)).toBe(true);
    expect(response).toMatchObject({ anchored: true });
    expect(openExport(anchored, key, signing)).toMatchObject({
      version: 2,
      type: "audit-anchor",
      rows: expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ operation: "admin.access" }),
        }),
      ]),
    });
    const failed = operationsRoutes(s, {
      encryptionKey: key,
      signingKey: signing,
      archiveTarget,
      readAnchor: async () => anchored || null,
      anchor: async () => {
        throw Error("TARGET_DOWN");
      },
    });
    await expect(failed(request)).rejects.toThrow("TARGET_DOWN");
    await pool.query(
      "DELETE FROM operations_audit_chain WHERE workspace_id=$1",
      [workspaceId],
    );
    await expect(route(request)).rejects.toThrow(/AUDIT_ANCHOR/);
    expect(await route({ ...request, path: "/api/v1/unrelated" })).toBe(false);
  });
});
test("unknown model/queue/backup metrics stay unknown, draining blocks readiness not liveness", async () => {
  const h = await healthSnapshot({
    database: async () => true,
    model: async () => null,
    queue: async () => null,
    backup: async () => null,
    draining: false,
  });
  expect(h.ready).toBe(true);
  expect(h.automationReady).toBe(false);
  expect(h.live).toBe(true);
  expect(h.model).toBe(null);
  expect(metricsText(h)).not.toContain("model_available 0");
  const c = new ShutdownController();
  const release = c.enter();
  const draining = c.drain(1000);
  expect(() => c.enter()).toThrow("DRAINING");
  release();
  expect(await draining).toBe(true);
  const blocked = new ShutdownController();
  blocked.enter();
  expect(await blocked.drain(5)).toBe(false);
});
