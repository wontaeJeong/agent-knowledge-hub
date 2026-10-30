import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { spawn } from "node:child_process";
import { fixture } from "../test-support";
import {
  JobService,
  JobWorker,
  nextOccurrence,
  handleJobRoute,
  type JobHooks,
  type JobHandler,
  type Lease,
} from "./index";
const pools: Pool[] = [];
afterEach(async () => {
  if (pools[0])
    await pools[0].query(
      "TRUNCATE durable_jobs,durable_schedules,durable_job_stops,durable_budget_days,durable_budget_limits,durable_job_fairness CASCADE",
    );
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  let now = new Date("2026-10-30T09:00:00Z"),
    policy = "v1",
    revoked = false;
  const hooks: JobHooks = {
    authorize: async (db, ctx) => {
      if (revoked) throw Error("CREDENTIAL_REVOKED");
      const r = await db.query(
        "SELECT 1 FROM memberships WHERE workspace_id=$1 AND principal_id=$2",
        [ctx.workspaceId, ctx.principalId],
      );
      if (!r.rowCount) throw Error("FORBIDDEN");
    },
    resolveIdentity: async (_db, identity) => {
      if (revoked || !identity.credentialId) throw Error("CREDENTIAL_REVOKED");
      return { ...identity };
    },
    policyFingerprint: async () => policy,
    validateScope: async () => {},
  };
  const service = new JobService(f.pool, hooks, {
    clock: () => now,
    leaseMs: 1000,
    globalConcurrency: 10,
    workspaceConcurrency: 2,
    principalConcurrency: 1,
  });
  const ctx = { ...f.editor, credentialId: "scoped-credential" };
  const input = {
    kind: "lint",
    key: "one",
    payload: {},
    pageIds: ["topic"],
    sourceIds: ["source-a"],
    reservation: { tokens: 100, costMicros: 50 },
    timeoutMs: 10000,
    maxAttempts: 3,
  };
  return {
    ...f,
    ctx,
    service,
    hooks,
    input,
    advance: (ms: number) => {
      now = new Date(+now + ms);
    },
    policy: () => {
      policy = "v2";
    },
    revoke: () => {
      revoked = true;
    },
  };
}
describe("durable PostgreSQL queue", () => {
  it("persists across service restart and binds idempotency key to canonical body", async () => {
    const f = await setup();
    const a = await f.service.enqueue(f.ctx, f.input);
    const restarted = new JobService(f.pool, f.hooks);
    expect((await restarted.get(f.ctx, a.id)).status).toBe("queued");
    expect(
      (await f.service.enqueue(f.ctx, { ...f.input, payload: {} })).id,
    ).toBe(a.id);
    await expect(
      f.service.enqueue(f.ctx, { ...f.input, payload: { different: true } }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM durable_jobs WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("idempotent enqueue replay cannot expose a completed result after input ancestry changes", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    await f.service.complete((await f.service.claim("a"))!, {
      value: "old private output",
    });
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
      [f.workspaceId],
    );
    await expect(f.service.enqueue(f.ctx, f.input)).rejects.toThrow();
  });
  it("reclaims expired leases with monotonic fences and rejects stale heartbeat/commit", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const first = (await f.service.claim("worker-a"))!;
    f.advance(1001);
    const second = (await f.service.claim("worker-b"))!;
    expect(second.fence).toBeGreaterThan(first.fence);
    await expect(f.service.heartbeat(first)).rejects.toThrow("LEASE_LOST");
    await expect(f.service.complete(first, { value: "stale" })).rejects.toThrow(
      "LEASE_LOST",
    );
    await f.service.complete(second, { value: "current" });
    expect((await f.service.get(f.ctx, second.id)).result).toBe("current");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM durable_job_outbox WHERE job_id=$1",
          [second.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("heartbeats extend ownership, cancellation fences effects and completed jobs cannot claim cancellation", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    const lease = (await f.service.claim("a"))!;
    f.advance(900);
    await f.service.heartbeat(lease);
    f.advance(900);
    expect(await f.service.claim("b")).toBeNull();
    expect((await f.service.cancel(f.ctx, j.id)).status).toBe(
      "cancel_requested",
    );
    await expect(f.service.complete(lease, { value: 1 })).rejects.toThrow(
      "CANCELLED",
    );
    await f.service.fail(lease, "CANCELLED");
    expect((await f.service.get(f.ctx, j.id)).status).toBe("cancelled");
    const other = await f.service.enqueue(f.ctx, { ...f.input, key: "two" });
    const l = (await f.service.claim("b"))!;
    await f.service.complete(l, { value: 2 });
    await expect(f.service.cancel(f.ctx, other.id)).rejects.toThrow(
      "ALREADY_COMPLETED",
    );
  });
  it.each(["policy", "source", "page", "revoke"])(
    "fails closed when %s changes before effects",
    async (change) => {
      const f = await setup();
      await f.service.enqueue(f.ctx, f.input);
      const lease = (await f.service.claim("a"))!;
      if (change === "policy") f.policy();
      if (change === "revoke") f.revoke();
      if (change === "source")
        await f.pool.query(
          "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed\"') WHERE workspace_id=$1",
          [f.workspaceId],
        );
      if (change === "page")
        await f.pool.query(
          "UPDATE versions SET data=jsonb_set(data,'{content}','\"manual edit\"') WHERE workspace_id=$1",
          [f.workspaceId],
        );
      let wrote = false;
      await expect(
        f.service.complete(lease, {
          value: 1,
          commit: async () => {
            wrote = true;
          },
        }),
      ).rejects.toThrow();
      expect(wrote).toBe(false);
    },
  );
  it("retries transient faults with bounded backoff but never retries permission errors", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, { ...f.input, maxAttempts: 2 });
    let l = (await f.service.claim("a"))!;
    await f.service.fail(l, "MODEL_UNAVAILABLE", true);
    expect(await f.service.claim("a")).toBeNull();
    f.advance(1000);
    l = (await f.service.claim("a"))!;
    await f.service.fail(l, "MODEL_UNAVAILABLE", true);
    expect((await f.service.get(f.ctx, j.id)).status).toBe("dead");
    const k = await f.service.enqueue(f.ctx, { ...f.input, key: "auth" });
    l = (await f.service.claim("a"))!;
    await f.service.fail(l, "FORBIDDEN", true);
    expect((await f.service.get(f.ctx, k.id)).status).toBe("dead");
  });
  it("serializes ten principals, enforces per-principal/workspace quotas and fair turns", async () => {
    const f = await setup();
    for (let i = 0; i < 10; i++) {
      await f.pool.query("INSERT INTO memberships VALUES($1,$2,'editor')", [
        f.workspaceId,
        "u" + i,
      ]);
      await f.pool.query(
        "INSERT INTO resource_readers SELECT workspace_id,kind,id,$2 FROM resources WHERE workspace_id=$1",
        [f.workspaceId, "u" + i],
      );
    }
    for (let i = 0; i < 10; i++)
      await f.service.enqueue(
        { ...f.ctx, principalId: "u" + i },
        { ...f.input, key: "ten-" + i },
      );
    const leases = await Promise.all(
      Array.from({ length: 10 }, (_, i) => f.service.claim("w" + i)),
    );
    expect(leases.filter(Boolean)).toHaveLength(2);
    for (const l of leases) if (l) await f.service.complete(l, { value: 1 });
    const next = (await f.service.claim("next"))!;
    expect(
      leases.filter(Boolean).some((l) => l!.principalId === next.principalId),
    ).toBe(false);
  });
  it("atomically reserves budgets and reconciles real telemetry without treating unknown as zero", async () => {
    const f = await setup();
    await f.service.setBudget(f.ctx, {
      principalId: "*",
      tokens: 150,
      costMicros: 100,
    });
    const j = await f.service.enqueue(f.ctx, f.input);
    await expect(
      f.service.enqueue(f.ctx, { ...f.input, key: "over" }),
    ).rejects.toThrow("BUDGET_EXCEEDED");
    const l = (await f.service.claim("a"))!;
    const call = {
      callId: "call-1",
      provider: "fixture",
      model: "actual-v1",
      inputTokens: 20,
      outputTokens: 10,
      costMicros: null,
      error: null,
    };
    await f.service.recordModel(l, call);
    await f.service.recordModel(l, call);
    await f.service.complete(l, { value: 1 });
    const usage = await f.service.telemetry(f.ctx, j.id);
    expect(usage.items).toHaveLength(1);
    expect(usage.items[0].cost_micros).toBeNull();
    const budget = await f.service.budgets(f.ctx);
    expect(
      budget.items.find((r: { principal_id: string }) => r.principal_id === "*")
        .tokens_charged,
    ).toBe(30);
  });
  it("outbox redelivery survives consumer death and acknowledges only a current fence", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    await f.service.complete((await f.service.claim("a"))!, { value: 1 });
    const first = (await f.service.claimEvent("c1"))!;
    f.advance(1001);
    const again = (await f.service.claimEvent("c2"))!;
    expect(again.id).toBe(first.id);
    await expect(f.service.ackEvent(first)).rejects.toThrow("LEASE_LOST");
    await f.service.ackEvent(again);
    expect(await f.service.claimEvent("c3")).toBeNull();
  });
  it("emergency stop blocks queued claims and in-flight commits", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    await f.service.setStop(f.ctx, {
      scope: "workspace",
      key: f.workspaceId,
      stopped: true,
    });
    await expect(f.service.complete(l, { value: 1 })).rejects.toThrow(
      "EMERGENCY_STOP",
    );
    await f.service.fail(l, "EMERGENCY_STOP");
    expect(await f.service.claim("b")).toBeNull();
    await f.service.setStop(f.ctx, {
      scope: "workspace",
      key: f.workspaceId,
      stopped: false,
    });
  });
  it("worker passes AbortSignal, checkpoints and fences commit after timeout", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, { ...f.input, timeoutMs: 50 });
    const handler: JobHandler = async (run) => {
      await run.checkpoint({ stage: "model-ready" });
      await new Promise((resolve) =>
        run.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { value: "must not commit" };
    };
    const worker = new JobWorker(
      f.service,
      { lint: handler },
      { workerId: "async-worker", heartbeatMs: 10 },
    );
    await worker.tick();
    expect((await f.service.get(f.ctx, j.id)).status).toBe("dead");
    await worker.stop();
  });
  it("reserves model calls before transmission and conservatively accounts crash/unknown usage", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, { ...f.input, model: "actual-v1" });
    const l = (await f.service.claim("a"))!;
    const call = {
      callId: "pending",
      provider: "fixture",
      model: "actual-v1",
      maxTokens: 100,
      maxCostMicros: 50,
    };
    await f.service.beginModel(l, call);
    await expect(
      f.service.beginModel(l, { ...call, callId: "second" }),
    ).rejects.toThrow("MODEL_USAGE_UNKNOWN");
    await f.service.fail(l, "MODEL_FAILED");
    let b = await f.service.budgets(f.ctx);
    expect(b.items[0].tokens_charged).toBe(100);
    // Actual late telemetry is allowed to reconcile accounting, NOT effects.
    await f.service.recordModel(l, {
      callId: "pending",
      provider: "fixture",
      model: "actual-v1",
      inputTokens: 10,
      outputTokens: 10,
      costMicros: 5,
      error: "MODEL_FAILED",
    });
    b = await f.service.budgets(f.ctx);
    expect(b.items[0].tokens_charged).toBe(20);
    expect(b.items[0].cost_charged).toBe(5);
    await expect(f.service.complete(l, { value: "late" })).rejects.toThrow(
      "LEASE_LOST",
    );
  });
  it("rejects unbudgeted model calls and blocks new calls after reservation exhausted", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    await expect(
      f.service.beginModel(l, {
        callId: "huge",
        provider: "fixture",
        model: "v1",
        maxTokens: 101,
        maxCostMicros: 1,
      }),
    ).rejects.toThrow("BUDGET_EXCEEDED");
    await f.service.beginModel(l, {
      callId: "one",
      provider: "fixture",
      model: "v1",
      maxTokens: 90,
      maxCostMicros: 50,
    });
    await f.service.recordModel(l, {
      callId: "one",
      provider: "fixture",
      model: "v1",
      inputTokens: 70,
      outputTokens: 20,
      costMicros: 40,
      error: null,
    });
    await expect(
      f.service.beginModel(l, {
        callId: "two",
        provider: "fixture",
        model: "v1",
        maxTokens: 20,
        maxCostMicros: 1,
      }),
    ).rejects.toThrow("BUDGET_EXCEEDED");
  });
  it("rolls back effects and outbox on a DB fault without duplicating successful commits", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    await expect(
      f.service.complete(l, {
        value: 1,
        commit: async (db) => {
          await db.query(
            "UPDATE pages SET data=jsonb_set(data,'{title}','\"must rollback\"') WHERE workspace_id=$1",
            [f.workspaceId],
          );
          throw Error("DB_FAULT");
        },
      }),
    ).rejects.toThrow("DB_FAULT");
    expect(
      (
        await f.pool.query(
          "SELECT data->>'title' title FROM pages WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].title,
    ).toBe("주제");
    expect(
      (await f.pool.query("SELECT count(*)::int n FROM durable_job_outbox"))
        .rows[0].n,
    ).toBe(0);
    await f.service.complete(l, { value: 2 });
    await expect(f.service.complete(l, { value: 2 })).rejects.toThrow(
      "LEASE_LOST",
    );
  });
  it("rejects changed execution identity and missing mandatory authorization hooks", async () => {
    const f = await setup();
    expect(
      () => new JobService(f.pool, undefined as unknown as JobHooks),
    ).toThrow("JOB_AUTHORIZATION_REQUIRED");
    const service = new JobService(f.pool, {
      ...f.hooks,
      resolveIdentity: async (_db, id) => ({ ...id, principalId: "reviewer" }),
    });
    await expect(service.enqueue(f.ctx, f.input)).rejects.toThrow(
      "EXECUTION_IDENTITY_MISMATCH",
    );
  });
  it("protects current human-edited pages regardless of execution identity", async () => {
    const f = await setup();
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"protected\":true}')",
      [f.workspaceId],
    );
    await expect(f.service.enqueue(f.ctx, f.input)).rejects.toThrow(
      "DOCUMENT_PROTECTED",
    );
  });
  it("moves reservations into the execution day instead of bypassing a new day's limits", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    f.advance(86400000);
    await f.service.claim("tomorrow");
    const b = await f.service.budgets(f.ctx);
    expect(
      b.items.find((r: { principal_id: string }) => r.principal_id === "*")
        .tokens_reserved,
    ).toBe(100);
  });
  it("lowered live limits block effects of previously accepted reservations", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    await f.service.setBudget(f.ctx, {
      principalId: "*",
      tokens: 10,
      costMicros: 5,
    });
    await expect(f.service.complete(l, { value: 1 })).rejects.toThrow(
      "BUDGET_EXCEEDED",
    );
  });
  it("outbox claims recheck the current scoped actor, not enqueue-time authority", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    await f.service.complete((await f.service.claim("a"))!, { value: 1 });
    f.revoke();
    expect(await f.service.claimEvent("consumer")).toBeNull();
  });
  it("withheld outbox events back off instead of starving later authorized events", async () => {
    const f = await setup();
    const stale = await f.service.enqueue(f.ctx, f.input);
    await f.service.complete((await f.service.claim("a"))!, { value: 1 });
    await f.pool.query("DELETE FROM durable_job_outbox WHERE job_id=$1", [
      stale.id,
    ]);
    await f.pool.query(
      "INSERT INTO durable_job_outbox(id,job_id,topic,payload,created_at) SELECT gen_random_uuid()::text,$1,'blocked-'||i,'{}', $2::timestamptz FROM generate_series(1,100) i",
      [stale.id, new Date(+f.service.clock() - 1000)],
    );
    const current = await f.service.enqueue(
      { ...f.ctx, principalId: "reviewer" },
      { ...f.input, key: "authorized" },
    );
    await f.service.complete((await f.service.claim("b"))!, { value: 2 });
    const consumer = new JobService(
      f.pool,
      {
        ...f.hooks,
        resolveIdentity: async (db, identity) => {
          if (identity.principalId === "editor")
            throw Error("CREDENTIAL_REVOKED");
          return f.hooks.resolveIdentity(db, identity);
        },
      },
      { clock: f.service.clock },
    );
    expect(await consumer.claimEvent("c")).toBeNull();
    expect((await consumer.claimEvent("c"))!.job_id).toBe(current.id);
  });
  it("pure routes accept/poll/cancel durable records without executing HTTP-inline", async () => {
    const f = await setup();
    let status = 0,
      data: unknown;
    const send = (s: number, d: unknown) => {
      status = s;
      data = d;
    };
    expect(
      await handleJobRoute(
        {
          method: "POST",
          path: "/api/v1/jobs-v2",
          ctx: f.ctx,
          body: f.input,
          send,
        },
        f.service,
      ),
    ).toBe(true);
    expect(status).toBe(202);
    const job = data as { id: string };
    await handleJobRoute(
      {
        method: "GET",
        path: `/api/v1/jobs-v2/${job.id}`,
        ctx: f.ctx,
        body: undefined,
        send,
      },
      f.service,
    );
    expect((data as { status: string }).status).toBe("queued");
    await handleJobRoute(
      {
        method: "POST",
        path: `/api/v1/jobs-v2/${job.id}/cancel`,
        ctx: f.ctx,
        body: {},
        send,
      },
      f.service,
    );
    expect((data as { status: string }).status).toBe("cancelled");
    expect(
      await handleJobRoute(
        {
          method: "GET",
          path: "/api/v1/jobs",
          ctx: f.ctx,
          body: undefined,
          send,
        },
        f.service,
      ),
    ).toBe(false);
  });
  it("SIGKILL of an actual worker process preserves the lease and enables fenced recovery", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/jobs/fixtures/crash-worker.ts"],
      {
        env: { ...process.env, JOB_TEST_CLOCK: "2026-10-30T09:00:00Z" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      const first = await new Promise<Lease>((resolve, reject) => {
        child.once("message", (msg) => resolve(msg as Lease));
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(Error("Child exited before lease: " + code)),
        );
      });
      expect(first.id).toBe(j.id);
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      f.advance(1001);
      const second = (await f.service.claim("replacement"))!;
      expect(second.fence).toBeGreaterThan(first.fence);
      await f.service.complete(second, { value: "recovered" });
      expect((await f.service.get(f.ctx, j.id)).status).toBe("succeeded");
    } finally {
      child.kill("SIGKILL");
    }
  }, 15000);
  it("runtime effect hooks atomically checkpoint each stage across retry/reclaim", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    let l = (await f.service.claim("a"))!;
    const db = await f.pool.connect();
    let calls = 0;
    const perform = async () => {
      await db.query("BEGIN");
      try {
        const r = await f.service.commitEffect(
          db,
          l,
          "proposal",
          async (_db, ctx, key) => {
            calls++;
            expect(ctx.principalId).toBe("editor");
            expect(key).toBe("durable-job:" + l.id + ":proposal");
            return { id: "proposal-one" };
          },
        );
        await db.query("COMMIT");
        return r;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    };
    try {
      expect(await perform()).toEqual({ id: "proposal-one" });
      f.advance(1001);
      l = (await f.service.claim("b"))!;
      expect(await perform()).toEqual({ id: "proposal-one" });
      expect(calls).toBe(1);
      await f.service.complete(l, { value: "proposal-one" });
    } finally {
      db.release();
    }
  });
  it("runtime capture hook refuses unpinned model context", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    const db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      await expect(
        f.service.captureInputs(db, l, ["unlisted-page"], []),
      ).rejects.toThrow("INPUT_SCOPE_MISMATCH");
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
  });
  it("real SQL failure rolls back completion and leaves lease retryable", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    await expect(
      f.service.complete(l, {
        value: 1,
        commit: async (db) => {
          await db.query("SELECT 1/0");
        },
      }),
    ).rejects.toThrow("division by zero");
    expect((await f.service.get(f.ctx, l.id)).status).toBe("running");
    await f.service.complete(l, { value: 2 });
  });
  it("reserves interactive capacity rather than allowing maintenance to exhaust all slots", async () => {
    const f = await setup();
    const service = new JobService(f.pool, f.hooks, {
      clock: f.service.clock,
      globalConcurrency: 2,
      workspaceConcurrency: 2,
      principalConcurrency: 2,
    });
    await service.enqueue(f.ctx, f.input);
    await service.enqueue(f.ctx, { ...f.input, key: "maintenance-2" });
    await service.enqueue(f.ctx, { ...f.input, key: "query", kind: "query" });
    expect(await service.claim("maintenance-1", "maintenance")).not.toBeNull();
    expect(await service.claim("maintenance-2", "maintenance")).toBeNull();
    expect(await service.claim("interactive", "interactive")).not.toBeNull();
  });
  it("manual dead-letter replay preserves effect checkpoints and charges only new actual usage", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    let l = (await f.service.claim("a"))!;
    await f.service.recordModel(l, {
      callId: "old",
      provider: "fixture",
      model: "v1",
      inputTokens: 20,
      outputTokens: 10,
      costMicros: 5,
      error: "MODEL_FAILED",
    });
    await f.service.fail(l, "MODEL_FAILED");
    await f.service.retry(f.ctx, l.id);
    l = (await f.service.claim("b"))!;
    await f.service.recordModel(l, {
      callId: "new",
      provider: "fixture",
      model: "v1",
      inputTokens: 5,
      outputTokens: 5,
      costMicros: 3,
      error: null,
    });
    await f.service.complete(l, { value: 1 });
    const b = await f.service.budgets(f.ctx);
    expect(b.items[0].tokens_charged).toBe(40);
    expect(b.items[0].cost_charged).toBe(8);
  });
  it("concurrent enqueue cannot oversubscribe the shared space budget", async () => {
    const f = await setup();
    await f.service.setBudget(f.ctx, {
      principalId: "*",
      tokens: 150,
      costMicros: 100,
    });
    const results = await Promise.allSettled([
      f.service.enqueue(f.ctx, f.input),
      f.service.enqueue(f.ctx, { ...f.input, key: "racer" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.service.budgets(f.ctx)).items[0].tokens_reserved).toBe(100);
  });
  it("rechecks changed protection at claim and never executes already-poisoned queued work", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"protected\":true}')",
      [f.workspaceId],
    );
    expect(await f.service.claim("must-not-run")).toBeNull();
    expect(
      (
        await f.pool.query(
          "SELECT status,error_code FROM durable_jobs WHERE id=$1",
          [j.id],
        )
      ).rows[0],
    ).toEqual({ status: "dead", error_code: "DOCUMENT_PROTECTED" });
  });
  it("a runtime holding a workspace lock fails fast rather than deadlocking with queue order", async () => {
    const f = await setup();
    await f.service.enqueue(f.ctx, f.input);
    const l = (await f.service.claim("a"))!;
    const blocker = await f.pool.connect(),
      runtime = await f.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(822022)");
      await runtime.query("BEGIN");
      await runtime.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        f.workspaceId,
      ]);
      await expect(
        f.service.assertReadyInTransaction(runtime, l),
      ).rejects.toThrow("QUEUE_BUSY");
      await runtime.query("ROLLBACK");
      await blocker.query("ROLLBACK");
    } finally {
      runtime.release();
      blocker.release();
    }
  });
  it("cross-workspace job polling and global-stop privilege escalation fail closed", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    await expect(
      f.service.get({ ...f.ctx, workspaceId: "another-space" }, j.id),
    ).rejects.toThrow("FORBIDDEN");
    const limited = new JobService(f.pool, {
      ...f.hooks,
      authorize: async (db, ctx, action, r) => {
        if (action === "jobs.global") throw Error("FORBIDDEN");
        await f.hooks.authorize(db, ctx, action, r);
      },
    });
    await expect(
      limited.setStop(f.ctx, { scope: "global", key: "*", stopped: true }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("pause and resume revalidate policy rather than executing an old approval", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    await f.service.pause(f.ctx, j.id, true);
    expect(await f.service.claim("a")).toBeNull();
    f.policy();
    await expect(f.service.pause(f.ctx, j.id, false)).rejects.toThrow(
      "POLICY_CHANGED",
    );
  });
  it("authorized managers can inspect scoped service executions, while normal lists stay personal", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    expect((await f.service.list(f.ctx)).items[0].id).toBe(j.id);
    expect((await f.service.list(f.reader)).items).toHaveLength(0);
    expect((await f.service.list(f.editor, 0, "workspace")).items[0].id).toBe(
      j.id,
    );
    expect(
      (
        await f.service.list(
          { ...f.ctx, principalId: "reviewer" },
          0,
          "workspace",
        )
      ).items[0].id,
    ).toBe(j.id);
  });
  it("worker cancellation interrupts an async handler and never commits its late result", async () => {
    const f = await setup();
    const j = await f.service.enqueue(f.ctx, f.input);
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    let aborted = false;
    const worker = new JobWorker(
      f.service,
      {
        lint: async (run) => {
          began();
          await new Promise<void>((resolve) =>
            run.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return { value: "late" };
        },
      },
      { workerId: "cancel-worker", heartbeatMs: 10 },
    );
    const ticking = worker.tick();
    await started;
    await f.service.cancel(f.ctx, j.id);
    await ticking;
    expect(aborted).toBe(true);
    expect((await f.service.get(f.ctx, j.id)).status).toBe("cancelled");
    await worker.stop();
  });
});
describe("timezone schedules", () => {
  it("skips spring gap and deduplicates fall fold by local date", () => {
    const daily = {
      cadence: "daily" as const,
      time: "02:30",
      timezone: "America/New_York",
      holidays: [],
    };
    expect(
      nextOccurrence(daily, new Date("2026-03-08T00:00:00Z")).toISOString(),
    ).toBe("2026-03-09T06:30:00.000Z");
    expect(
      nextOccurrence(
        { ...daily, time: "01:30" },
        new Date("2026-11-01T05:30:00Z"),
      ).toISOString(),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
  it("supports weekly weekdays and holidays with explicit IANA validation", () => {
    const s = {
      cadence: "weekly" as const,
      weekday: 1,
      time: "09:00",
      timezone: "Asia/Seoul",
      holidays: ["2026-11-02"],
    };
    expect(
      nextOccurrence(s, new Date("2026-10-30T00:00:00Z")).toISOString(),
    ).toBe("2026-11-09T00:00:00.000Z");
    expect(() =>
      nextOccurrence({ ...s, timezone: "bad-zone" }, new Date()),
    ).toThrow();
  });
  it("durably dedupes bounded catchup and never persists human sessions", async () => {
    const f = await setup();
    const { key: _, ...job } = f.input;
    const s = await f.service.saveSchedule(f.ctx, {
      key: "daily",
      cadence: "daily",
      time: "10:00",
      timezone: "UTC",
      holidays: [],
      catchup: "latest",
      job,
      identity: { ...f.ctx },
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    });
    f.advance(4 * 86400000);
    expect(await f.service.scheduleTick()).toBe(1);
    expect(await f.service.scheduleTick()).toBe(0);
    const rows = await f.pool.query(
      "SELECT identity FROM durable_schedules WHERE id=$1",
      [s.id],
    );
    expect(Object.keys(rows.rows[0].identity).sort()).toEqual([
      "credentialId",
      "principalId",
      "workspaceId",
    ]);
    expect(
      (await f.service.previewSchedule(f.ctx, s.id)).occurrences,
    ).toHaveLength(5);
  });
  it("schedule revisions retain approver, bounded catchup and explicit pause/manual-run behavior", async () => {
    const f = await setup();
    const { key: _, ...job } = f.input;
    const input = {
      key: "bounded",
      cadence: "daily",
      time: "10:00",
      timezone: "UTC",
      holidays: [],
      catchup: "bounded",
      catchupLimit: 2,
      job,
      identity: f.ctx,
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    };
    const s = await f.service.saveSchedule(f.ctx, input);
    await expect(f.service.saveSchedule(f.ctx, input)).rejects.toThrow(
      "STALE_VERSION",
    );
    await f.service.enableSchedule(f.ctx, s.id, false);
    f.advance(4 * 86400000);
    expect(await f.service.scheduleTick()).toBe(0);
    await f.service.enableSchedule(f.ctx, s.id, true);
    expect(await f.service.scheduleTick()).toBe(2);
    const manual = await f.service.runSchedule(f.ctx, s.id, "manual-key");
    expect(manual.status).toBe("queued");
    expect((await f.service.runSchedule(f.ctx, s.id, "manual-key")).id).toBe(
      manual.id,
    );
    const rows = (
      await f.pool.query("SELECT input FROM durable_jobs WHERE id=$1", [
        manual.id,
      ])
    ).rows;
    expect(rows[0].input.payload.manager).toEqual({
      scheduleId: s.id,
      revision: 1,
      approvedBy: "editor",
    });
    await f.service.saveSchedule(f.ctx, {
      ...input,
      expectedRevision: 1,
      time: "11:00",
    });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM durable_schedule_versions WHERE schedule_id=$1",
          [s.id],
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("long downtime schedules real wall-clock occurrences, never a fabricated now-time", async () => {
    const f = await setup();
    const { key: _, ...job } = f.input;
    const s = await f.service.saveSchedule(f.ctx, {
      key: "long",
      cadence: "daily",
      time: "10:00",
      timezone: "UTC",
      holidays: [],
      catchup: "latest",
      job,
      identity: f.ctx,
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    });
    f.advance(90 * 86400000);
    expect(await f.service.scheduleTick()).toBe(1);
    const row = (
      await f.pool.query(
        "SELECT scheduled_at FROM durable_schedule_runs WHERE schedule_id=$1",
        [s.id],
      )
    ).rows[0];
    expect(new Date(row.scheduled_at).getUTCHours()).toBe(10);
  });
  it("schedule scope cannot exceed approved page/source ids or use another workspace identity", async () => {
    const f = await setup();
    const { key: _, ...job } = f.input;
    const input = {
      key: "bad",
      cadence: "daily",
      time: "10:00",
      timezone: "UTC",
      holidays: [],
      catchup: "skip",
      job,
      identity: f.ctx,
      approvedPageIds: [],
      approvedSourceIds: ["source-a"],
    };
    await expect(f.service.saveSchedule(f.ctx, input)).rejects.toThrow(
      "SCOPE_CONFLICT",
    );
    await expect(
      f.service.saveSchedule(f.ctx, {
        ...input,
        identity: { ...f.ctx, workspaceId: "other" },
        approvedPageIds: ["topic"],
      }),
    ).rejects.toThrow("SCOPE_CONFLICT");
  });
});
