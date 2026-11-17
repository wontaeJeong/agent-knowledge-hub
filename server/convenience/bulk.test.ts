import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fixture, adoptFixture, page } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "../workflows/service";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeJobs } from "../jobs/runtime";
import { browserIdentity } from "../jobs/fixtures/session";
import { DocumentPropertiesService } from "./properties";
import { BulkDocumentService } from "./bulk";
let f: Awaited<ReturnType<typeof fixture>>,
  workflows: WorkflowService,
  bulk: BulkDocumentService;
let bridge: ReturnType<typeof createRuntimeJobs>,
  browser: Awaited<ReturnType<typeof browserIdentity>>;
const servers: Server[] = [];
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const runtime = new RuntimeService(f.pool);
  workflows = new WorkflowService(f.pool, runtime, authorizeInTransaction);
  browser = await browserIdentity(f.pool, f.ctx, servers);
  bridge = createRuntimeJobs(f.pool, runtime, {
    ...browser.options,
    workerCount: 1,
  });
  bulk = new BulkDocumentService(workflows, bridge);
});
afterEach(async () => {
  await bridge?.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await f?.pool.end();
});
const preview = (kind: "archive" | "tags" = "archive") =>
  bulk.preview(browser.ctx, {
    pageIds: ["topic"],
    operation:
      kind === "tags" ? { kind, tags: [" guide ", "guide", "한글"] } : { kind },
    reason: "정리",
  });
test("accepted archive is durable, replayable and applied once after worker restart", async () => {
  const p = await preview(),
    mutationId = randomUUID();
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: p.previewToken,
    mutationId,
  });
  expect(p.items[0]).toMatchObject({
    before: { state: "active" },
    patch: { state: "archived" },
  });
  expect(accepted.status).toBe("queued");
  expect((await workflows.document(browser.ctx, "topic")).settings.state).toBe(
    "active",
  );
  expect(
    (
      await bulk.execute(browser.ctx, {
        previewToken: p.previewToken,
        mutationId,
      })
    ).id,
  ).toBe(accepted.id);
  await bridge.worker.tick();
  const r = await bulk.read(browser.ctx, accepted.id);
  expect(r.items[0].status).toBe("applied");
  expect(
    (await workflows.document(browser.ctx, "topic")).settings.revision,
  ).toBe(1);
  await expect(
    bulk.execute(browser.ctx, {
      previewToken: (await preview()).previewToken,
      mutationId,
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("tag changes produce one independently reviewed proposal without changing published tags", async () => {
  const p = await preview("tags"),
    accepted = await bulk.execute(browser.ctx, {
      previewToken: p.previewToken,
      mutationId: randomUUID(),
    });
  await bridge.worker.tick();
  const r = await bulk.read(browser.ctx, accepted.id);
  expect(r.items[0]).toMatchObject({ status: "needs-review" });
  expect((await workflows.document(browser.ctx, "topic")).page.tags).toEqual(
    [],
  );
  const plans = (
    await f.pool.query(
      "SELECT payload FROM version_restore_plans WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows;
  expect(plans).toHaveLength(1);
  expect(plans[0].payload.next.tags).toEqual(["guide", "한글"]);
});
test("50/51 preview and current revision/ACL/session boundaries fail closed", async () => {
  await bulk.preview(browser.ctx, {
    pageIds: Array.from({ length: 50 }, (_, i) => "p" + i),
    operation: { kind: "archive" },
    reason: "test",
  });
  await expect(
    bulk.preview(browser.ctx, {
      pageIds: Array.from({ length: 51 }, (_, i) => "p" + i),
      operation: { kind: "archive" },
      reason: "test",
    }),
  ).rejects.toThrow();
  const p = await preview();
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: p.previewToken,
    mutationId: randomUUID(),
  });
  await workflows.setDocumentState(browser.ctx, "topic", {
    expectedRevision: 0,
    properties: { environment: "prod" },
    reason: "raced",
  });
  await bridge.worker.tick();
  expect((await bulk.read(browser.ctx, accepted.id)).items[0].status).toBe(
    "stale",
  );
  await expect(
    bulk.execute(f.ctx, {
      previewToken: p.previewToken,
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow();
});

test("property edits validate canonical required fields, retain CAS and never grant owner access", async () => {
  const service = new DocumentPropertiesService(workflows);
  const before = await service.read(browser.ctx, "topic");
  await f.pool.query(
    "INSERT INTO governance_type_policies VALUES($1,'기술 설계',1,ARRAY['environment'],'block',NULL)",
    [f.workspaceId],
  );
  const input = {
    expectedVersion: before.metadata.number,
    expectedRevision: before.metadata.settingsRevision,
    category: "기술 설계",
    summary: "정리",
    tags: [" guide ", "guide"],
    properties: {},
    environment: "",
    reviewDue: null,
    reason: "속성 수정",
    mutationId: randomUUID(),
  };
  await expect(service.propose(browser.ctx, "topic", input)).rejects.toThrow(
    "PROPERTY_REQUIRED",
  );
  const accepted = await service.propose(browser.ctx, "topic", {
    ...input,
    properties: { environment: "prod" },
    environment: "prod",
  });
  expect(accepted.status).toBe("needs-review");
  expect((await service.read(browser.ctx, "topic")).metadata.tags).toEqual([]);
  await expect(
    service.propose(browser.ctx, "topic", { ...input, ownerId: "reader" }),
  ).rejects.toThrow();
  await workflows.setDocumentState(browser.ctx, "topic", {
    expectedRevision: 0,
    reason: "changed",
    reviewDue: "2026-12-01T00:00:00Z",
  });
  await expect(
    service.propose(browser.ctx, "topic", {
      ...input,
      properties: { environment: "prod" },
      environment: "prod",
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow("STALE_VERSION");
});

test("accepted input expires independently of preview and live parent-session revocation stops writes", async () => {
  const p = await preview();
  await f.pool.query(
    "UPDATE workflow_bulk_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    bulk.execute(browser.ctx, {
      previewToken: p.previewToken,
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow("INVALID_BULK_PREVIEW");
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: (await preview()).previewToken,
    mutationId: randomUUID(),
  });
  await f.pool.query(
    "UPDATE workflow_bulk_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await bridge.worker.tick();
  expect((await bulk.read(browser.ctx, accepted.id)).items[0].status).toBe(
    "applied",
  );
  const second = await bulk.execute(browser.ctx, {
    previewToken: (await preview()).previewToken,
    mutationId: randomUUID(),
  });
  await f.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
    browser.sessionId,
  ]);
  await bridge.worker.tick();
  expect(
    (
      await f.pool.query(
        "SELECT status FROM durable_jobs WHERE id=(SELECT job_id FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2)",
        [f.workspaceId, second.id],
      )
    ).rows[0].status,
  ).toBe("dead");
  expect((await workflows.document(f.ctx, "topic")).settings.revision).toBe(1);
});
test("source revocation hides receipt entries and denies execution; grant has no lifecycle rights", async () => {
  const p = await preview(),
    accepted = await bulk.execute(browser.ctx, {
      previewToken: p.previewToken,
      mutationId: randomUUID(),
    });
  const c = (
    await f.pool.query(
      "SELECT j.credential_id FROM durable_jobs j JOIN workflow_bulk_requests r ON r.job_id=j.id WHERE r.workspace_id=$1 AND r.id=$2",
      [f.workspaceId, accepted.id],
    )
  ).rows[0].credential_id;
  await expect(
    workflows.setDocumentState({ ...f.ctx, credentialId: c }, "topic", {
      expectedRevision: 0,
      state: "archived",
      reason: "escape",
    }),
  ).rejects.toThrow();
  await expect(
    bridge.submitDelegated(
      { ...f.ctx, credentialId: c },
      {
        kind: "bulk",
        key: "escape",
        payload: {},
        pageIds: [],
        sourceIds: [],
        reservation: { tokens: 0, costMicros: 0 },
        timeoutMs: 10000,
        maxAttempts: 1,
      },
    ),
  ).rejects.toThrow("BULK_SESSION_REQUIRED");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  await bridge.worker.tick();
  expect((await bulk.read(browser.ctx, accepted.id)).items).toEqual([]);
  expect(
    (
      await f.pool.query(
        "SELECT status FROM workflow_bulk_items WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].status,
  ).toBe("denied");
});
test("publication of metadata requires independent review and captures canonical values in the new version", async () => {
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,resource_id,'fixture-owner' FROM resource_readers WHERE workspace_id=$1 AND principal_id='reviewer' ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO access_reviewers VALUES($1,'fixture-owner')",
    [f.workspaceId],
  );
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: (await preview("tags")).previewToken,
    mutationId: randomUUID(),
  });
  await bridge.worker.tick();
  const outcome = (await bulk.read(browser.ctx, accepted.id))
    .items[0] as unknown as { batchId: string; hash: string };
  const { KnowledgeService } = await import("../service");
  const ks = new KnowledgeService(f.pool);
  await expect(
    ks.approve(f.ctx, outcome.batchId, outcome.hash),
  ).rejects.toThrow();
  const reviewer = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  await ks.approve(reviewer, outcome.batchId, outcome.hash);
  await ks.publish(reviewer, outcome.batchId, outcome.hash, randomUUID());
  expect((await workflows.document(f.ctx, "topic")).page.tags).toEqual([
    "guide",
    "한글",
  ]);
  expect(
    (
      await f.pool.query(
        "SELECT snapshot->'tags' AS tags FROM version_metadata WHERE workspace_id=$1 AND number=2",
        [f.workspaceId],
      )
    ).rows[0].tags,
  ).toEqual(["guide", "한글"]);
});

test("frozen patch tampering cannot reuse the accepted hash", async () => {
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: (await preview()).previewToken,
    mutationId: randomUUID(),
  });
  await f.pool.query(
    "UPDATE workflow_bulk_items SET patch=$2 WHERE workspace_id=$1",
    [f.workspaceId, { parentId: null }],
  );
  await bridge.worker.tick();
  expect((await workflows.document(f.ctx, "topic")).settings.revision).toBe(0);
  expect((await bulk.read(browser.ctx, accepted.id)).status).toBe("dead");
});

async function clone(id: string) {
  const { versions, ...data } = page;
  await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)", [
    f.workspaceId,
    id,
  ]);
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, id, { ...data, id, title: id }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
    f.workspaceId,
    id,
    versions[0],
  ]);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,$2,principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic'",
    [f.workspaceId, id],
  );
}
test("mixed ready, stale and inaccessible items retain separate receipts and current visibility", async () => {
  await clone("stale");
  await clone("denied");
  const p = await bulk.preview(browser.ctx, {
    pageIds: ["topic", "stale", "denied"],
    operation: { kind: "archive" },
    reason: "mixed",
  });
  const a = await bulk.execute(browser.ctx, {
    previewToken: p.previewToken,
    mutationId: randomUUID(),
  });
  await workflows.setDocumentState(browser.ctx, "stale", {
    expectedRevision: 0,
    reason: "race",
    reviewDue: "2026-12-01T00:00:00Z",
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='denied' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  await bridge.worker.tick();
  expect(
    (await bulk.read(browser.ctx, a.id)).items.map((x) => x.status),
  ).toEqual(["applied", "stale"]);
  expect(
    (
      await f.pool.query(
        "SELECT status FROM workflow_bulk_items WHERE workspace_id=$1 ORDER BY ordinal",
        [f.workspaceId],
      )
    ).rows.map((r) => r.status),
  ).toEqual(["applied", "stale", "denied"]);
});
test("destination parent revision and ancestry changes invalidate the frozen move", async () => {
  await clone("parent");
  const p = await bulk.preview(browser.ctx, {
    pageIds: ["topic"],
    operation: { kind: "move", parentId: "parent" },
    reason: "move",
  });
  const a = await bulk.execute(browser.ctx, {
    previewToken: p.previewToken,
    mutationId: randomUUID(),
  });
  await workflows.setDocumentState(browser.ctx, "parent", {
    expectedRevision: 0,
    reason: "parent changed",
    properties: { environment: "prod" },
  });
  await bridge.worker.tick();
  expect((await bulk.read(browser.ctx, a.id)).items[0].status).toBe("stale");
  expect(
    (await workflows.document(browser.ctx, "topic")).settings.parent_id,
  ).toBe(null);
});
test("erasure selects and redacts accepted bulk payload and cancels its job through source lineage", async () => {
  const { OperationsService } = await import("../operations/service"),
    { previewErasure, executeErasure } = await import("../operations/erasure");
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,resource_id,'fixture-owner' FROM resource_readers WHERE workspace_id=$1 AND principal_id='reviewer' ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const a = await bulk.execute(browser.ctx, {
    previewToken: (await preview("tags")).previewToken,
    mutationId: randomUUID(),
  });
  const ops = new OperationsService(f.pool, authorizeInTransaction),
    ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  const request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    p = await previewErasure(ops, ctx, request);
  expect(
    (
      await executeErasure(ops, ctx, {
        ...request,
        previewHash: p.previewHash,
        confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
      })
    ).status,
  ).toBe("completed");
  const row = (
    await f.pool.query(
      "SELECT patch,status FROM workflow_bulk_items WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0];
  expect(JSON.stringify(row.patch)).not.toContain("guide");
  expect(
    (
      await f.pool.query(
        "SELECT status FROM durable_jobs WHERE id=(SELECT job_id FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2)",
        [f.workspaceId, a.id],
      )
    ).rows[0].status,
  ).toBe("cancelled");
  await bridge.worker.tick();
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM version_restore_plans WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});

test.each(["archive", "tags"] as const)(
  "SIGKILL after real %s commit restarts without duplicate effect or proposal",
  async (kind) => {
    const { spawn } = await import("node:child_process"),
      { once } = await import("node:events");
    await bridge.stop();
    let now = new Date();
    bridge = createRuntimeJobs(f.pool, workflows.runtime, {
      ...browser.options,
      workerCount: 1,
      queue: { leaseMs: 60000, clock: () => now },
    });
    bulk = new BulkDocumentService(workflows, bridge);
    const p = await preview(kind),
      accepted = await bulk.execute(browser.ctx, {
        previewToken: p.previewToken,
        mutationId: randomUUID(),
      });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/jobs/fixtures/bulk-crash-worker.ts"],
      {
        env: {
          ...process.env,
          JOB_TEST_CLOCK: now.toISOString(),
          BULK_TEST_USERINFO: browser.userInfoUrl,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr!.on("data", (b) => (stderr += b));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(Error("child exit " + code + " " + stderr)),
        );
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      now = new Date(+now + 60001);
      await bridge.worker.tick();
      expect((await bulk.read(browser.ctx, accepted.id)).status).toBe(
        "succeeded",
      );
      expect(
        (
          await f.pool.query(
            "SELECT attempts FROM durable_jobs WHERE id=(SELECT job_id FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2)",
            [f.workspaceId, accepted.id],
          )
        ).rows[0].attempts,
      ).toBe(2);
      if (kind === "archive")
        expect(
          (await workflows.document(f.ctx, "topic")).settings.revision,
        ).toBe(1);
      else
        expect(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM version_restore_plans WHERE workspace_id=$1",
              [f.workspaceId],
            )
          ).rows[0].n,
        ).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  },
  20000,
);

test("a failed queue admission cannot extend preview expiry", async () => {
  const p = await preview(),
    mutationId = randomUUID();
  await f.pool.query(
    "UPDATE workflow_bulk_requests SET mutation_id=$3,expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, p.previewToken.split(".")[0], mutationId],
  );
  await expect(
    bulk.execute(browser.ctx, { token: p.previewToken, mutationId }),
  ).rejects.toThrow("INVALID_BULK_PREVIEW");
});
test("expired preview replays only the admitted original job, actor, mutation and input hash", async () => {
  const p = await preview(),
    mutationId = randomUUID(),
    args = { previewToken: p.previewToken, mutationId };
  const accepted = await bulk.execute(browser.ctx, args);
  await f.pool.query(
    "UPDATE workflow_bulk_requests SET expires_at=now()-interval '1 second',job_id=NULL WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, accepted.id],
  );
  expect(await bulk.execute(browser.ctx, args)).toEqual(accepted);
  await expect(
    bulk.execute(browser.ctx, { ...args, mutationId: randomUUID() }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    bulk.execute({ ...browser.ctx, principalId: "editor" }, args),
  ).rejects.toThrow();
  await f.pool.query(
    "UPDATE workflow_bulk_requests SET input_hash='changed' WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, accepted.id],
  );
  await expect(bulk.execute(browser.ctx, args)).rejects.toThrow(
    "INVALID_BULK_PREVIEW",
  );
  await f.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
    browser.sessionId,
  ]);
  await expect(bulk.execute(browser.ctx, args)).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM durable_jobs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
test("bulk receipt cannot escape its original session through generic jobs or a replacement session", async () => {
  const accepted = await bulk.execute(browser.ctx, {
    previewToken: (await preview()).previewToken,
    mutationId: randomUUID(),
  });
  const job = (
    await f.pool.query(
      "SELECT job_id FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, accepted.id],
    )
  ).rows[0].job_id;
  const replacement = await browserIdentity(f.pool, f.ctx, servers);
  await expect(bulk.read(replacement.ctx, accepted.id)).rejects.toThrow(
    "NOT_FOUND",
  );
  await bridge.worker.tick();
  expect(await bridge.jobs.get(browser.ctx, job)).toMatchObject({
    result: null,
    checkpoint: null,
  });
  await expect(bridge.jobs.get(replacement.ctx, job)).rejects.toThrow(
    "NOT_FOUND",
  );
  await f.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
    browser.sessionId,
  ]);
  await expect(bulk.read(replacement.ctx, accepted.id)).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("an expired bulk execution grant fails explicitly without extending it or writing an item", async () => {
  const a = await bulk.execute(browser.ctx, {
    previewToken: (await preview()).previewToken,
    mutationId: randomUUID(),
  });
  await f.pool.query(
    "UPDATE runtime_execution_grants SET created_at=now()-interval '2 minutes',expires_at=now()-interval '1 second' WHERE credential_id=(SELECT credential_id FROM durable_jobs WHERE id=(SELECT job_id FROM workflow_bulk_requests WHERE workspace_id=$1 AND id=$2))",
    [f.workspaceId, a.id],
  );
  await bridge.worker.tick();
  const receipt = await bulk.read(browser.ctx, a.id);
  expect(receipt.status).toBe("dead");
  expect(receipt.error).toBeTruthy();
  expect(receipt.items[0].status).toBe("pending");
  expect(
    (await workflows.document(browser.ctx, "topic")).settings.revision,
  ).toBe(0);
});
