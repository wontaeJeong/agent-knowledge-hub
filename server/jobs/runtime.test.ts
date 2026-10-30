import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { fingerprint } from "../provenance";
import { current } from "../../src/domain/wiki";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService, type RuntimeExecution } from "../runtime/knowledge";
import { createRuntimeJobs, runtimeCapabilities } from "./runtime";
import type { RuntimeIdentityOptions } from "./identity";
import { browserIdentity, browserTransport } from "./fixtures/session";
import { parseJobInput } from "./service";
import { callModel } from "../runtime/model";
import { AccessService, authorizeInTransaction } from "../access/index";
import { RefinementService } from "../refinement/service";
import {
  createSemanticProvider,
  semanticConfigFromEnvironment,
} from "../refinement/semantic";
import { claim as semanticClaim } from "../refinement/fixtures";
import { source } from "../test-support";
const pools: Pool[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  vi.unstubAllEnvs();
  if (pools[0])
    await pools[0].query(
      "TRUNCATE durable_jobs,durable_schedules,durable_job_stops,durable_budget_days,durable_budget_limits,durable_job_fairness CASCADE",
    );
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function modelServer(
  reply: (body: any, res: import("node:http").ServerResponse) => void,
) {
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const c of req) data += c;
    reply(JSON.parse(data), res);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  vi.stubEnv(
    "AGENT_KNOWLEDGE_HUB_LLM_BASE_URL",
    `http://127.0.0.1:${address.port}/v1`,
  );
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "fixture-request");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "fixture-http");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
}
const fixtureDirectory: RuntimeIdentityOptions = {
  directoryProviderId: "explicit-test-roster",
  directoryStatus: async (subject) => ({
    ...subject,
    active: true,
    verifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 10000).toISOString(),
  }),
};
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const pat = await new AccessService(f.pool).issueCredential(f.editor, {
    actions: ["knowledge.read", "changeset.propose", "lint.run"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const editor = { ...f.editor, credentialId: pat.id };
  const service = new RuntimeService(f.pool);
  const bridge = createRuntimeJobs(f.pool, service, {
    workerCount: 1,
    ...fixtureDirectory,
  });
  return { ...f, humanEditor: f.editor, editor, service, bridge };
}
function semanticFixture(f: Awaited<ReturnType<typeof setup>>) {
  const prepare = async (db: PoolClient, ctx: Context, input: unknown) => {
    const context = z
        .object({ pageId: z.literal("topic") })
        .strict()
        .parse(
          input && typeof input === "object" && "context" in input
            ? input.context
            : input,
        ),
      state = (await f.service.view(db, ctx)).state,
      page = state.pages.find((p) => p.id === context.pageId);
    if (!page) throw Error("NOT_FOUND");
    const allClaims = (
      await db.query(
        "SELECT id,data FROM refinement_claims WHERE workspace_id=$1 ORDER BY id",
        [ctx.workspaceId],
      )
    ).rows;
    const pinned =
      input &&
      typeof input === "object" &&
      "claimIds" in input &&
      Array.isArray(input.claimIds)
        ? input.claimIds
        : undefined;
    const claims = pinned
      ? allClaims.filter((c) => pinned.includes(c.id))
      : allClaims;
    const reviews = (
      await db.query(
        "SELECT id,data FROM refinement_reviews WHERE workspace_id=$1 ORDER BY id",
        [ctx.workspaceId],
      )
    ).rows;
    return {
      payload: {
        context,
        claimIds: claims.map((c) => c.id),
        contextFingerprint: fingerprint({
          context,
          page: current(page),
          claims,
          reviews,
        }),
      },
      pageIds: [page.id],
      sourceIds: current(page).sourceIds,
    };
  };
  return {
    prepare,
    execute: async (
      ctx: Context,
      payload: Record<string, unknown>,
      e: RuntimeExecution,
    ) => {
      await transaction(f.pool, ctx.workspaceId, (db) =>
        e.captureInputs(db, ["topic"], ["source-a"]),
      );
      // Reuse the real bounded shared transport in this adapter fixture. The
      // production refiner owns its provider-specific semantic contract/validator.
      const raw = await e.modelResult("semantic-lint", () =>
        callModel(
          "query",
          { question: "semantic transport fixture", pages: [] },
          e.modelOptions,
        ),
      );
      const parsed = z
        .object({ findings: z.array(z.unknown()).max(e.maxChanges) })
        .strict()
        .parse(raw);
      await ctx.authorization?.revalidate();
      return transaction(f.pool, ctx.workspaceId, async (db) => {
        await e.beforeWrite(db);
        const now = await prepare(db, ctx, payload);
        if (now.payload.contextFingerprint !== payload.contextFingerprint)
          throw Error("STALE_VERSION");
        return e.persist(db, "semantic-lint", async () => {
          const result = {
            semantic: true,
            findings: parsed.findings,
            contextFingerprint: payload.contextFingerprint,
          };
          await db.query(
            "INSERT INTO runtime_lints VALUES($1,$2,$3) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET data=excluded.data",
            [ctx.workspaceId, ctx.principalId, result],
          );
          return result;
        });
      });
    },
  };
}
it("interactive consent persists one bounded grant for the SAME actor and executes offline query once", async () => {
  const f = await setup();
  const job = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "offline" },
    "query-one",
  );
  expect(job.status).toBe("queued");
  const row = (
    await f.pool.query("SELECT * FROM durable_jobs WHERE id=$1", [job.id])
  ).rows[0];
  expect(row.principal_id).toBe("editor");
  const grant = (
    await f.pool.query(
      "SELECT * FROM runtime_execution_grants WHERE credential_id=$1",
      [row.credential_id],
    )
  ).rows[0];
  expect(grant.principal_id).toBe("editor");
  expect(
    +new Date(grant.expires_at) - +new Date(grant.created_at),
  ).toBeLessThanOrEqual(row.timeout_ms);
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(f.editor, job.id)).status).toBe("succeeded");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.bridge.submitInteractive(
        f.editor,
        "query",
        { question: "기존", mode: "offline" },
        "query-one",
      )
    ).id,
  ).toBe(job.id);
  await f.bridge.stop();
});
it("current role/credential revocation after consent prevents queued effects", async () => {
  const f = await setup();
  const job = await f.bridge.submitInteractive(
    f.editor,
    "ingest",
    { sourceIds: ["source-a"], mode: "offline" },
    "revoke",
  );
  await f.pool.query(
    "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  await f.bridge.workers[0].tick();
  expect(
    (
      await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [
        job.id,
      ])
    ).rows[0].status,
  ).toBe("dead");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await f.bridge.stop();
});
it("ingest proposal uses core onCreated checkpoint and restart cannot duplicate domain writes", async () => {
  const f = await setup();
  const job = await f.bridge.submitInteractive(
    f.editor,
    "ingest",
    { sourceIds: ["source-a"], mode: "offline" },
    "ingest-once",
  );
  await f.bridge.workers[0].tick();
  const stored = (
    await f.pool.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
      job.id,
    ])
  ).rows[0];
  expect(stored.checkpoint.effects.ingest.id).toBeTruthy();
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT max(number)::int n FROM versions WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await f.bridge.stop();
});
it("lint writes run through fenced current-authority transactions", async () => {
  const f = await setup();
  const job = await f.bridge.submitInteractive(
    f.editor,
    "lint",
    {},
    "lint-one",
  );
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(f.editor, job.id)).status).toBe("succeeded");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_lints WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await f.bridge.stop();
});
it("real HTTP model transport records actual response model/tokens/cost null and keeps same principal", async () => {
  let transmitted: any;
  await modelServer((body, res) => {
    transmitted = body;
    res.end(
      JSON.stringify({
        model: "fixture-actual-model",
        usage: { prompt_tokens: 31, completion_tokens: 7 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content: "기존 내용",
                insufficient: false,
                citations: [
                  {
                    pageId: "topic",
                    title: "주제",
                    version: 1,
                    quote: "기존 내용",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "actual",
  );
  await f.bridge.workers[0].tick();
  const result = await f.bridge.read(f.editor, j.id);
  expect(result.status).toBe("succeeded");
  const calls = (await f.bridge.jobs.telemetry(f.editor, j.id)).items;
  expect(calls).toHaveLength(1);
  expect(calls[0].provider).toBe("fixture-http");
  expect(calls[0].model).toBe("fixture-actual-model");
  expect(Number(calls[0].input_tokens)).toBe(31);
  expect(Number(calls[0].output_tokens)).toBe(7);
  expect(calls[0].cost_micros).toBeNull();
  expect(transmitted.max_tokens).toBe(6000);
  expect(
    (
      await f.pool.query(
        "SELECT principal_id FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].principal_id,
  ).toBe("editor");
  await f.bridge.stop();
  expect(
    (
      await f.pool.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
        j.id,
      ])
    ).rows[0].checkpoint.effects["model-query"].content,
  ).toBe("기존 내용");
});
it("cancellation aborts real pending HTTP model call and records unknown usage without writing an answer", async () => {
  let begin!: () => void;
  const begun = new Promise<void>((r) => (begin = r));
  await modelServer((_body, _res) => begin());
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "cancel-http",
  );
  const tick = f.bridge.workers[0].tick();
  await begun;
  await f.bridge.cancel(f.editor, j.id);
  await f.bridge.stop();
  await tick;
  expect((await f.bridge.read(f.editor, j.id)).status).toBe("cancelled");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  const call = (await f.bridge.jobs.telemetry(f.editor, j.id)).items[0];
  expect(call.input_tokens).toBeNull();
  expect(call.error_code).toBe("CANCELLED");
});
it.each(["archived", "future", "replacement"])(
  "query never recommends %s policy, but explicit page reads and review flags remain",
  async (flag) => {
    const f = await setup();
    const data =
      flag === "future"
        ? {
            effectiveFrom: "2099-01-01T00:00:00Z",
            reviewDue: "2020-01-01T00:00:00Z",
          }
        : flag === "replacement"
          ? { replacementId: "other-policy" }
          : { reviewDue: "2020-01-01T00:00:00Z" };
    await f.pool.query(
      "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,$2,$3,$4)",
      [
        f.workspaceId,
        "topic",
        flag === "archived" ? "archived" : "active",
        data,
      ],
    );
    const pages = await f.service.pages(f.editor);
    expect(pages).toHaveLength(1);
    expect(pages[0].currentRecommendation).toBe(false);
    if (flag !== "replacement") expect(pages[0].reviewOverdue).toBe(true);
    const answer = await f.service.query(f.editor, "기존", "offline");
    expect(answer.citations).toHaveLength(0);
    expect(answer.insufficient).toBe(true);
    const job = await f.bridge.submitInteractive(
      f.editor,
      "query",
      { question: "기존", mode: "offline" },
      "not-current",
    );
    await f.bridge.workers[0].tick();
    const result = await f.bridge.read(f.editor, job.id);
    expect(result.status).toBe("succeeded");
    expect(result.result.citations).toHaveLength(0);
    await f.bridge.stop();
  },
);
it("actual model query context excludes future/archived pages without globally hiding history", async () => {
  let pages: unknown;
  await modelServer((body, res) => {
    pages = JSON.parse(body.messages[1].content).pages;
    res.end(
      JSON.stringify({
        model: "fixture-request",
        usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: "현재 근거가 부족합니다.",
                insufficient: true,
                citations: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state) VALUES($1,'topic','archived')",
    [f.workspaceId],
  );
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "archive-model",
  );
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(f.editor, j.id)).status).toBe("succeeded");
  expect(pages).toEqual([]);
  await f.bridge.stop();
});
it("model configuration/provider changes invalidate already accepted calls before transmission", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end("{}");
  });
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "change-provider",
  );
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "other-provider");
  await f.bridge.workers[0].tick();
  expect(calls).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT status,error_code FROM durable_jobs WHERE id=$1",
        [j.id],
      )
    ).rows[0],
  ).toEqual({ status: "dead", error_code: "POLICY_CHANGED" });
  await f.bridge.stop();
});
it("model failure and bounded response faults preserve real telemetry but never invent a successful answer", async () => {
  await modelServer((_body, res) => {
    res.writeHead(503);
    res.end("upstream secret error must never persist");
  });
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "model-fail",
  );
  await f.bridge.workers[0].tick();
  const call = (await f.bridge.jobs.telemetry(f.editor, j.id)).items[0];
  expect(call.error_code).toBe("MODEL_UNAVAILABLE");
  expect(call.input_tokens).toBeNull();
  expect(JSON.stringify(call)).not.toContain("secret");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await f.bridge.stop();
});
it("one-operation grant cannot be reused as an unattended schedule identity", async () => {
  const f = await setup();
  const j = await f.bridge.submitInteractive(f.editor, "lint", {}, "consent");
  const row = (
    await f.pool.query("SELECT credential_id FROM durable_jobs WHERE id=$1", [
      j.id,
    ])
  ).rows[0];
  await expect(
    f.bridge.jobs.saveSchedule(f.ctx, {
      key: "illegal-human-daemon",
      cadence: "daily",
      time: "09:00",
      timezone: "UTC",
      holidays: [],
      catchup: "latest",
      identity: { ...f.editor, credentialId: row.credential_id },
      job: {
        kind: "lint",
        payload: {},
        pageIds: ["topic"],
        sourceIds: ["source-a"],
        reservation: { tokens: 0, costMicros: 0 },
        timeoutMs: 120000,
        maxAttempts: 3,
      },
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    }),
  ).rejects.toThrow("SCOPED_SERVICE_IDENTITY_REQUIRED");
  await f.bridge.stop();
});
it("bound grant revocation and parent PAT scope narrowing both fail closed", async () => {
  const f = await setup();
  const { id, secret } = await new AccessService(f.pool).issueCredential(
    f.humanEditor,
    {
      actions: ["knowledge.read", "changeset.propose"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  );
  expect(secret).toBeTruthy();
  const j = await f.bridge.submitInteractive(
    { ...f.editor, credentialId: id },
    "ingest",
    { sourceIds: ["source-a"], mode: "offline" },
    "pat-consent",
  );
  await f.pool.query(
    "UPDATE access_credentials SET actions=ARRAY['knowledge.read'] WHERE id=$1",
    [id],
  );
  await f.bridge.workers[0].tick();
  expect(
    (await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [j.id]))
      .rows[0].status,
  ).toBe("dead");
  await f.bridge.stop();
});
it.each(["query", "ingest", "lint"] as const)(
  "SIGKILL after real %s domain commit reclaims without duplicate writes or audit events",
  async (kind) => {
    const f = await setup();
    await f.bridge.stop();
    let now = new Date();
    const bridge = createRuntimeJobs(f.pool, f.service, {
      workerCount: 1,
      queue: { leaseMs: 1000, clock: () => now },
    });
    const payload =
      kind === "query"
        ? { question: "기존", mode: "offline" }
        : kind === "ingest"
          ? { sourceIds: ["source-a"], mode: "offline" }
          : {};
    const job = await bridge.submitInteractive(
      f.editor,
      kind,
      payload,
      "domain-crash",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/jobs/fixtures/runtime-crash-worker.ts"],
      {
        env: { ...process.env, JOB_TEST_CLOCK: now.toISOString() },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      const committed = await new Promise<{ id: string; fence: number }>(
        (resolve, reject) => {
          child.once("message", (m) =>
            resolve(m as { id: string; fence: number }),
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            reject(Error("runtime child exited before domain commit: " + code)),
          );
        },
      );
      expect(committed.id).toBe(job.id);
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      now = new Date(+now + 1001);
      await bridge.workers[0].tick();
      const result = await bridge.read(f.editor, job.id);
      expect(result.status).toBe("succeeded");
      expect(result.attempts).toBe(2);
      const table =
        kind === "query"
          ? "runtime_answers"
          : kind === "ingest"
            ? "batches"
            : "runtime_lints";
      expect(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(1);
      const op = kind === "ingest" ? "batch.propose" : kind;
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM audit WHERE workspace_id=$1 AND operation=$2",
            [f.workspaceId, op],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      child.kill("SIGKILL");
      await bridge.stop();
    }
  },
  20000,
);
it("actual output changes above the admitted limit never create a proposal", async () => {
  const f = await setup();
  await f.bridge.stop();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    maxChanges: 0,
  });
  const j = await bridge.submitInteractive(
    f.editor,
    "ingest",
    { sourceIds: ["source-a"], mode: "offline" },
    "zero-changes",
  );
  await bridge.workers[0].tick();
  expect((await bridge.read(f.editor, j.id)).error).toBe("CHANGE_LIMIT");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await bridge.stop();
});
it("partial model response is bounded while streaming, and abort propagates without waiting for full body", async () => {
  await modelServer((_body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("x".repeat(2000));
  });
  const usages: any[] = [];
  await expect(
    callModel(
      "query",
      { question: "x", pages: [] },
      {
        maxResponseBytes: 100,
        onUsage: async (u) => {
          usages.push(u);
        },
      },
    ),
  ).rejects.toThrow("MODEL_RESPONSE_LIMIT");
  expect(usages[0].inputTokens).toBeNull();
  expect(usages[0].error).toBe("MODEL_RESPONSE_LIMIT");
});
it("context byte bounds reject before any model transmission", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end("{}");
  });
  await expect(
    callModel("query", { data: "x".repeat(2000) }, { maxContextBytes: 100 }),
  ).rejects.toThrow("MODEL_CONTEXT_LIMIT");
  expect(calls).toBe(0);
});
it("SIGKILL after model checkpoint reuses real HTTP output and charges its actual usage exactly once", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end(
      JSON.stringify({
        model: "fixture-request",
        usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content: "기존 내용",
                insufficient: false,
                citations: [
                  {
                    pageId: "topic",
                    title: "주제",
                    version: 1,
                    quote: "기존 내용",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.bridge.stop();
  let now = new Date();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    queue: { leaseMs: 1000, clock: () => now },
  });
  const j = await bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "model-checkpoint-crash",
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/jobs/fixtures/runtime-crash-worker.ts"],
    {
      env: {
        ...process.env,
        JOB_TEST_CLOCK: now.toISOString(),
        JOB_CRASH_STAGE: "model",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  try {
    const committed = await new Promise<{ id: string }>((resolve, reject) => {
      child.once("message", (m) => resolve(m as { id: string }));
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(Error("model child exited before checkpoint: " + code)),
      );
    });
    expect(committed.id).toBe(j.id);
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    now = new Date(+now + 1001);
    await bridge.workers[0].tick();
    expect((await bridge.read(f.editor, j.id)).status).toBe("succeeded");
    expect(calls).toBe(1);
    expect((await bridge.jobs.telemetry(f.editor, j.id)).items).toHaveLength(1);
    const usage = (
      await f.pool.query(
        "SELECT tokens_charged::int,cost_charged::int FROM durable_budget_days WHERE workspace_id=$1 AND principal_id='*'",
        [f.workspaceId],
      )
    ).rows[0];
    expect(usage).toEqual({ tokens_charged: 8, cost_charged: 1000 });
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    child.kill("SIGKILL");
    await bridge.stop();
  }
}, 20000);
it("real PostgreSQL serialization failure retries the domain stage from cached model output without another provider call", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end(
      JSON.stringify({
        model: "fixture-request",
        usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content: "기존 내용",
                insufficient: false,
                citations: [
                  {
                    pageId: "topic",
                    title: "주제",
                    version: 1,
                    quote: "기존 내용",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.bridge.stop();
  let now = new Date();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    queue: { clock: () => now },
  });
  const commit = bridge.jobs.commitEffect.bind(bridge.jobs);
  let failed = false;
  bridge.jobs.commitEffect = async (db, lease, stage, effect) => {
    if (stage === "query" && !failed) {
      failed = true;
      await db.query(
        "DO $$BEGIN RAISE EXCEPTION 'fixture serialization failure' USING ERRCODE='40001'; END$$",
      );
    }
    return commit(db, lease, stage, effect);
  };
  const j = await bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "pg-retry",
  );
  await bridge.workers[0].tick();
  expect((await bridge.read(f.editor, j.id)).status).toBe("queued");
  now = new Date(+now + 1001);
  await bridge.workers[0].tick();
  expect((await bridge.read(f.editor, j.id)).status).toBe("succeeded");
  expect(calls).toBe(1);
  expect((await bridge.jobs.telemetry(f.editor, j.id)).items).toHaveLength(1);
  await bridge.stop();
});
it("shutdown waits for signal-aware model telemetry cleanup before the pool may close", async () => {
  let begun!: () => void;
  const transmitting = new Promise<void>((r) => (begun = r));
  await modelServer(() => begun());
  const f = await setup();
  await f.bridge.stop();
  const service = new RuntimeService(f.pool, (op, context, opts) =>
    callModel(op, context, {
      ...opts,
      onUsage: async (u) => {
        await new Promise((r) => setTimeout(r, 40));
        await opts?.onUsage?.(u);
      },
    }),
  );
  const bridge = createRuntimeJobs(f.pool, service, { workerCount: 1 });
  const j = await bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "drain",
  );
  const tick = bridge.workers[0].tick();
  await transmitting;
  await bridge.cancel(f.editor, j.id);
  await bridge.stop();
  await tick;
  expect(
    (await bridge.jobs.telemetry(f.editor, j.id)).items[0].error_code,
  ).toBe("CANCELLED");
});
it("model ingest excludes archived policy context and cannot overwrite protected actual targets", async () => {
  let contextPages: any[] = [];
  let protectedTarget = false;
  await modelServer((body, res) => {
    contextPages = JSON.parse(body.messages[1].content).pages;
    res.end(
      JSON.stringify({
        model: "fixture-request",
        usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                updates: [
                  {
                    id: protectedTarget ? "topic" : "new-concept",
                    title: "새 근거",
                    summary: "근거",
                    content: "실패 시 재시도한다.",
                    scope: "team",
                    baseVersion: protectedTarget ? 1 : 0,
                    links: [],
                    sourceIds: ["source-a"],
                    facts: [],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state) VALUES($1,'topic','archived')",
    [f.workspaceId],
  );
  const j = await f.bridge.submitInteractive(
    f.editor,
    "ingest",
    { sourceIds: ["source-a"], mode: "model" },
    "archive-context",
  );
  await f.bridge.workers[0].tick();
  expect(contextPages).toEqual([]);
  expect((await f.bridge.read(f.editor, j.id)).status).toBe("succeeded");
  protectedTarget = true;
  await f.pool.query(
    "UPDATE workflow_document_state SET state='active',data='{\"protected\":true}',revision=revision+1 WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const k = await f.bridge.submitInteractive(
    f.editor,
    "ingest",
    { sourceIds: ["source-a"], mode: "model" },
    "protected-target",
  );
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(f.editor, k.id)).error).toBe("FORBIDDEN");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await f.bridge.stop();
});
it("one-shot consent binds operation, payload, key, resources and revocation; no approve/publish capability is minted", async () => {
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "offline" },
    "bind",
  );
  const row = (
    await f.pool.query(
      "SELECT credential_id,input FROM durable_jobs WHERE id=$1",
      [j.id],
    )
  ).rows[0];
  const ctx = { ...f.editor, credentialId: row.credential_id };
  const credential = (
    await f.pool.query("SELECT actions FROM access_credentials WHERE id=$1", [
      ctx.credentialId,
    ])
  ).rows[0];
  expect(credential.actions).toEqual(["knowledge.read"]);
  await expect(
    f.bridge.jobs.enqueue(ctx, { ...row.input, key: "different-key" }),
  ).rejects.toThrow("EXECUTION_SCOPE_CONFLICT");
  await f.pool.query(
    "UPDATE runtime_execution_grants SET revoked=true WHERE credential_id=$1",
    [ctx.credentialId],
  );
  await f.bridge.workers[0].tick();
  expect(
    (await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [j.id]))
      .rows[0].status,
  ).toBe("dead");
  await f.bridge.stop();
});
it("model request timeout and reported output-token overrun fail closed with actual usage retained", async () => {
  let hold = true;
  await modelServer((_body, res) => {
    if (!hold)
      res.end(
        JSON.stringify({
          model: "fixture-request",
          usage: { prompt_tokens: 5, completion_tokens: 7000, cost: 0.02 },
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        }),
      );
  });
  const usages: any[] = [];
  await expect(
    callModel(
      "query",
      {},
      {
        timeoutMs: 20,
        onUsage: async (u) => {
          usages.push(u);
        },
      },
    ),
  ).rejects.toThrow("TIMEOUT");
  expect(usages[0].inputTokens).toBeNull();
  hold = false;
  await expect(
    callModel(
      "query",
      {},
      {
        onUsage: async (u) => {
          usages.push(u);
        },
      },
    ),
  ).rejects.toThrow("MODEL_OUTPUT_LIMIT");
  expect(usages[1].outputTokens).toBe(7000);
  expect(usages[1].costMicros).toBe(20000);
});
it("an overdue review remains current but is visible to lint instead of becoming an automatic false claim", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic','{\"reviewDue\":\"2020-01-01T00:00:00Z\"}')",
    [f.workspaceId],
  );
  const pages = await f.service.pages(f.editor);
  expect(pages[0].reviewOverdue).toBe(true);
  expect(pages[0].currentRecommendation).toBe(true);
  const lint = await f.service.lint(f.editor);
  expect(lint.issues.some((i) => i.id === "review-due:topic")).toBe(true);
  expect(
    (await f.service.query(f.editor, "기존", "offline")).citations,
  ).toHaveLength(1);
  await f.bridge.stop();
});
it("daily/weekly schedules require an actual team service credential and current active sponsor", async () => {
  const f = await setup();
  const access = new AccessService(f.pool),
    owner = { ...f.humanEditor, principalId: "fixture-owner" };
  const service = await access.createServicePrincipal(owner, {
    name: "bounded-manager",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.pool.query(
    "UPDATE access_grants SET role='write' WHERE workspace_id=$1 AND principal_id=$2",
    [f.workspaceId, service.id],
  );
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,$2 FROM resources WHERE workspace_id=$1",
    [f.workspaceId, service.id],
  );
  const credential = await access.issueServiceCredential(owner, service.id, {
    actions: ["knowledge.read", "changeset.propose", "lint.run"],
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  });
  await expect(
    f.bridge.jobs.enqueue(
      {
        workspaceId: f.workspaceId,
        principalId: service.id,
        credentialId: credential.id,
      },
      {
        kind: "query",
        key: "caller-picks-context",
        payload: { question: "기존", mode: "offline" },
        pageIds: [],
        sourceIds: [],
        reservation: { tokens: 0, costMicros: 0 },
        timeoutMs: 120000,
        maxAttempts: 3,
      },
    ),
  ).rejects.toThrow("EXECUTION_SCOPE_CONFLICT");
  await modelServer((_body, res) => res.end("{}"));
  await expect(
    f.bridge.jobs.saveSchedule(f.ctx, {
      key: "under-reserved-model",
      cadence: "daily",
      time: "09:00",
      timezone: "UTC",
      holidays: [],
      catchup: "latest",
      identity: {
        workspaceId: f.workspaceId,
        principalId: service.id,
        credentialId: credential.id,
      },
      job: {
        kind: "daily",
        payload: { mode: "model" },
        model: "fixture-request",
        pageIds: ["topic"],
        sourceIds: ["source-a"],
        reservation: { tokens: 0, costMicros: 0 },
        timeoutMs: 60000,
        maxAttempts: 3,
      },
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    }),
  ).rejects.toThrow("BUDGET_SCOPE_CONFLICT");
  const spec = {
    key: "service-manager",
    cadence: "daily",
    time: "09:00",
    timezone: "UTC",
    holidays: [],
    catchup: "latest",
    identity: {
      workspaceId: f.workspaceId,
      principalId: service.id,
      credentialId: credential.id,
    },
    job: {
      kind: "daily",
      payload: { mode: "offline" },
      pageIds: ["topic"],
      sourceIds: ["source-a"],
      reservation: { tokens: 0, costMicros: 0 },
      timeoutMs: 60000,
      maxAttempts: 3,
    },
    approvedPageIds: ["topic"],
    approvedSourceIds: ["source-a"],
  };
  await expect(f.bridge.jobs.saveSchedule(owner, spec)).rejects.toThrow();
  const schedule = await f.bridge.jobs.saveSchedule(f.ctx, spec);
  const first = await f.bridge.jobs.runSchedule(f.ctx, schedule.id, "once");
  await f.bridge.workers[0].tick();
  expect(
    (
      await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [
        first.id,
      ])
    ).rows[0].status,
  ).toBe("succeeded");
  const repeat = await f.bridge.jobs.runSchedule(
    f.ctx,
    schedule.id,
    "repeat-unchanged",
  );
  await f.bridge.workers[0].tick();
  expect(
    (
      await f.pool.query("SELECT result FROM durable_jobs WHERE id=$1", [
        repeat.id,
      ])
    ).rows[0].result.noNewEvidence,
  ).toBe(true);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  const firstProposal = (
    await f.pool.query("SELECT result FROM durable_jobs WHERE id=$1", [
      first.id,
    ])
  ).rows[0].result.proposal;
  await f.service.core.approve(f.ctx, firstProposal.id, firstProposal.hash);
  await f.service.core.publish(
    f.ctx,
    firstProposal.id,
    firstProposal.hash,
    "maintenance-human-publication",
  );
  const before = (
    await f.pool.query(
      "SELECT (SELECT count(*)::int FROM pages WHERE workspace_id=$1) pages,(SELECT count(*)::int FROM versions WHERE workspace_id=$1) versions,(SELECT count(*)::int FROM batches WHERE workspace_id=$1) batches",
      [f.workspaceId],
    )
  ).rows[0];
  const afterPublication = await f.bridge.jobs.runSchedule(
    f.ctx,
    schedule.id,
    "after-publication-no-op",
  );
  await f.bridge.workers[0].tick();
  const noOp = (
    await f.pool.query("SELECT result FROM durable_jobs WHERE id=$1", [
      afterPublication.id,
    ])
  ).rows[0].result;
  expect(noOp.noChanges).toBe(true);
  expect(noOp.proposal).toBeNull();
  expect(noOp.processedSourceIds).toEqual([]);
  expect(noOp.sourceAttempts[0].outcome).toBe("checked-no-change");
  expect(noOp.sourceAttempts[0].lastPublishedContext.batchId).toBe(
    firstProposal.id,
  );
  expect(noOp.processing.rulesFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(noOp.processing.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const after = (
    await f.pool.query(
      "SELECT (SELECT count(*)::int FROM pages WHERE workspace_id=$1) pages,(SELECT count(*)::int FROM versions WHERE workspace_id=$1) versions,(SELECT count(*)::int FROM batches WHERE workspace_id=$1) batches",
      [f.workspaceId],
    )
  ).rows[0];
  expect(after).toEqual(before);
  expect(
    (
      await f.pool.query(
        "SELECT data->'processed' processed FROM sources WHERE workspace_id=$1 AND id='source-a'",
        [f.workspaceId],
      )
    ).rows[0].processed,
  ).toBe(false);
  const second = await f.bridge.jobs.runSchedule(
    f.ctx,
    schedule.id,
    "revoked-sponsor",
  );
  await f.pool.query(
    "UPDATE access_team_members SET active=false WHERE team_id=$1 AND principal_id='fixture-owner'",
    [
      (
        await f.pool.query(
          "SELECT namespace_id FROM access_service_accounts WHERE principal_id=$1",
          [service.id],
        )
      ).rows[0].namespace_id,
    ],
  );
  await f.bridge.workers[0].tick();
  expect(
    (
      await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [
        second.id,
      ])
    ).rows[0].status,
  ).toBe("dead");
  await f.bridge.stop();
});
it("raw delegated inputs are strict and tighter caller bounds are preserved", async () => {
  const f = await setup();
  await expect(
    f.bridge.submitDelegated(f.editor, {
      kind: "approve",
      key: "bad",
      payload: {},
    }),
  ).rejects.toThrow();
  const raw = {
    kind: "ingest",
    key: "bounded",
    payload: { sourceIds: ["source-a"], mode: "offline" },
    pageIds: [],
    sourceIds: [],
    reservation: { tokens: 0, costMicros: 0 },
    timeoutMs: 60000,
    maxAttempts: 1,
    limits: { documents: 200, changes: 0 },
  };
  expect(parseJobInput(raw).maxAttempts).toBe(1);
  const j = await f.bridge.submitDelegated(f.editor, raw);
  const row = (
    await f.pool.query(
      "SELECT input,timeout_ms FROM durable_jobs WHERE id=$1",
      [j.id],
    )
  ).rows[0];
  expect(row.timeout_ms).toBe(60000);
  expect(row.input.pageIds).toEqual(["topic"]);
  expect(row.input.limits.changes).toBe(0);
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(f.editor, j.id)).error).toBe("CHANGE_LIMIT");
  await f.bridge.stop();
});
it("missing semantic adapter rejects before acceptance, never runs structural lint instead", async () => {
  const f = await setup();
  await expect(
    f.bridge.submitInteractive(
      f.editor,
      "lint",
      { semantic: true, context: { pageId: "topic" } },
      "no-semantic-adapter",
    ),
  ).rejects.toThrow("SEMANTIC_LINT_NOT_CONFIGURED");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM durable_jobs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_lints WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await f.bridge.stop();
});
it("semantic adapter seals claim context server-side, uses real budgeted model transport and atomically persists its report", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end(
      JSON.stringify({
        model: "actual-semantic-model",
        usage: { prompt_tokens: 6, completion_tokens: 2, cost: 0.001 },
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ findings: [] }) },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.bridge.stop();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    semanticLint: semanticFixture(f),
  });
  await expect(
    bridge.submitInteractive(
      f.editor,
      "lint",
      {
        semantic: true,
        context: { pageId: "topic" },
        prepared: { contextFingerprint: "forged" },
      },
      "forged-semantic",
    ),
  ).rejects.toThrow();
  const j = await bridge.submitInteractive(
    f.editor,
    "lint",
    { semantic: true, context: { pageId: "topic" } },
    "semantic-once",
  );
  const stored = (
    await f.pool.query("SELECT input FROM durable_jobs WHERE id=$1", [j.id])
  ).rows[0].input;
  expect(stored.pageIds).toEqual(["topic"]);
  expect(stored.sourceIds).toEqual(["source-a"]);
  expect(stored.payload.prepared.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.reservation.tokens).toBe(70000);
  await bridge.workers[0].tick();
  const done = await bridge.read(f.editor, j.id);
  expect(done.status).toBe("succeeded");
  expect(done.result.semantic).toBe(true);
  expect(done.checkpoint.effects["model-semantic-lint"]).toEqual({
    findings: [],
  });
  expect(done.checkpoint.effects["semantic-lint"].contextFingerprint).toBe(
    stored.payload.prepared.contextFingerprint,
  );
  expect((await bridge.jobs.telemetry(f.editor, j.id)).items[0].model).toBe(
    "actual-semantic-model",
  );
  expect(
    (
      await bridge.submitInteractive(
        f.editor,
        "lint",
        { semantic: true, context: { pageId: "topic" } },
        "semantic-once",
      )
    ).id,
  ).toBe(j.id);
  expect(calls).toBe(1);
  await bridge.stop();
});
it("the actual refinement adapter integrates with RuntimeJobs using normalized time and pinned claims", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end(
      JSON.stringify({
        model: "actual-refinement-model",
        usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0 },
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ findings: [] }) },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.bridge.stop();
  const refinement = new RefinementService(
    f.pool,
    authorizeInTransaction,
    createSemanticProvider({
      ...semanticConfigFromEnvironment(),
      provider: "fixture-http",
    }),
  );
  await refinement.addEvidence(f.editor, {
    id: "e1",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: fingerprint(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: semanticClaim.assertedAt,
    verifiedAt: null,
    conditions: semanticClaim.conditions,
  });
  const { recordedAt: _, recordedBy: __, ...input } = semanticClaim;
  await refinement.addClaim(f.editor, input);
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    semanticLint: refinement.semanticJobAdapter(),
  });
  const j = await bridge.submitInteractive(
    f.editor,
    "lint",
    { semantic: true, context: { environment: {} } },
    "actual-refinement-adapter",
  );
  await refinement.addClaim(f.editor, {
    ...input,
    id: "late-claim",
    value: "not part of admitted snapshot",
  });
  await bridge.workers[0].tick();
  const result = await bridge.read(f.editor, j.id);
  expect(result.status).toBe("succeeded");
  expect(result.result.modelAnalysisPerformed).toBe(true);
  expect(result.result.findings).toEqual([]);
  expect(calls).toBe(1);
  expect((await bridge.jobs.telemetry(f.editor, j.id)).items[0].model).toBe(
    "actual-refinement-model",
  );
  expect(
    (
      await bridge.submitInteractive(
        f.editor,
        "lint",
        { semantic: true, context: { environment: {} } },
        "actual-refinement-adapter",
      )
    ).id,
  ).toBe(j.id);
  await bridge.stop();
}, 20000);
it("changed sealed claims block semantic execution even when page/source versions are unchanged", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end("{}");
  });
  const f = await setup();
  await f.bridge.stop();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    semanticLint: semanticFixture(f),
  });
  const j = await bridge.submitInteractive(
    f.editor,
    "lint",
    { semantic: true, context: { pageId: "topic" } },
    "semantic-stale",
  );
  await f.pool.query(
    "INSERT INTO refinement_claims VALUES($1,'semantic-new-claim',$2)",
    [
      f.workspaceId,
      {
        id: "semantic-new-claim",
        pageId: "topic",
        pageVersion: 1,
        kind: "claim",
        key: "retry",
        value: "changed",
        conditions: {},
        exceptions: [],
        assertedAt: new Date().toISOString(),
        validFrom: new Date().toISOString(),
        validTo: null,
        verifiedAt: null,
        evidenceIds: [],
        protected: false,
        uncertainty: "unverified fixture",
        supersedes: [],
        recordedAt: new Date().toISOString(),
        recordedBy: "editor",
      },
    ],
  );
  await f.pool.query(
    "INSERT INTO refinement_reviews VALUES($1,'semantic-context-review',$2)",
    [
      f.workspaceId,
      {
        id: "semantic-context-review",
        claimIds: ["semantic-new-claim"],
        status: "reviewed",
        evidenceIds: [],
        reason: "context metadata epoch changed",
        recordedAt: new Date().toISOString(),
        recordedBy: "reviewer",
      },
    ],
  );
  await bridge.workers[0].tick();
  expect(
    (
      await f.pool.query(
        "SELECT status,error_code FROM durable_jobs WHERE id=$1",
        [j.id],
      )
    ).rows[0],
  ).toEqual({ status: "dead", error_code: "STALE_VERSION" });
  expect(calls).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_lints WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await bridge.stop();
});
it("semantic model cancellation fences its report with no structural fallback", async () => {
  let began!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (began = r));
  await modelServer((_body, res) => {
    began();
    release = () =>
      res.end(
        JSON.stringify({
          model: "actual-semantic-model",
          usage: { prompt_tokens: 6, completion_tokens: 2, cost: 0 },
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ findings: [] }) },
            },
          ],
        }),
      );
  });
  const f = await setup();
  await f.bridge.stop();
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    semanticLint: semanticFixture(f),
  });
  const j = await bridge.submitInteractive(
    f.editor,
    "lint",
    { semantic: true, context: { pageId: "topic" } },
    "semantic-cancel",
  );
  const tick = bridge.workers[0].tick();
  await entered;
  await bridge.cancel(f.editor, j.id);
  release();
  await tick;
  expect((await bridge.read(f.editor, j.id)).status).toBe("cancelled");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM runtime_lints WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  await bridge.stop();
});
it("job capabilities never infer platform-global authority from team management", () => {
  expect(
    runtimeCapabilities(
      ["knowledge.read", "knowledge.protect", "space.admin", "jobs.global"],
      "team-owner",
    ),
  ).toEqual([
    "knowledge.read",
    "knowledge.protect",
    "space.admin",
    "jobs.read",
    "jobs.run",
    "jobs.manage",
  ]);
  expect(
    runtimeCapabilities(["knowledge.read"], "operator", ["operator"]),
  ).toContain("jobs.global");
});
it("a source.create-only human PAT passes freshness but receives neither read nor proposal authority", async () => {
  const f = await setup(),
    access = new AccessService(f.pool),
    token = await access.issueCredential(f.humanEditor, {
      actions: ["source.create"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    ctx = { ...f.humanEditor, credentialId: token.id };
  await f.bridge.revalidateCredential(ctx);
  await f.service.core.registerSource(
    ctx,
    { ...source, id: "write-only-source" },
    [ctx.principalId],
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM sources WHERE workspace_id=$1 AND id='write-only-source'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    f.bridge.submitInteractive(
      ctx,
      "query",
      { question: "기존", mode: "offline" },
      "write-only-cannot-read",
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.bridge.submitInteractive(
      ctx,
      "ingest",
      { sourceIds: ["source-a"], mode: "offline" },
      "write-only-cannot-propose",
    ),
  ).rejects.toThrow("FORBIDDEN");
  await f.bridge.stop();
});
it("explicit model no-change is not source completion, and unchanged maintenance never charges another model call", async () => {
  let calls = 0;
  await modelServer((_body, res) => {
    calls++;
    res.end(
      JSON.stringify({
        model: "actual-no-change-model",
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({ updates: [], noChanges: true }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup(),
    access = new AccessService(f.pool),
    owner = { ...f.humanEditor, principalId: "fixture-owner" };
  const service = await access.createServicePrincipal(owner, {
    name: "model-no-change-manager",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.pool.query(
    "UPDATE access_grants SET role='write' WHERE workspace_id=$1 AND principal_id=$2",
    [f.workspaceId, service.id],
  );
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,$2 FROM resources WHERE workspace_id=$1",
    [f.workspaceId, service.id],
  );
  const credential = await access.issueServiceCredential(owner, service.id, {
      actions: ["knowledge.read", "changeset.propose", "lint.run"],
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    }),
    ctx = {
      workspaceId: f.workspaceId,
      principalId: service.id,
      credentialId: credential.id,
    };
  const input = {
    kind: "daily",
    key: "model-no-change",
    payload: { mode: "model" },
    pageIds: [],
    sourceIds: [],
    reservation: { tokens: 70000, costMicros: 100000 },
    timeoutMs: 120000,
    maxAttempts: 3,
    limits: { documents: 200, changes: 20 },
  };
  const j = await f.bridge.submitDelegated(ctx, input);
  await f.bridge.workers[0].tick();
  const first = (await f.bridge.read(ctx, j.id)).result;
  expect(first.noChanges).toBe(true);
  expect(first.proposal).toBeNull();
  expect(first.processedSourceIds).toEqual([]);
  expect(first.sourceAttempts[0].outcome).toBe("checked-no-change");
  expect(first.sourceAttempts[0].lastPublishedContext).toBeNull();
  const before = (
    await f.pool.query(
      "SELECT tokens_charged::int,cost_charged::int FROM durable_budget_days WHERE workspace_id=$1 AND principal_id='*'",
      [f.workspaceId],
    )
  ).rows[0];
  const repeat = await f.bridge.submitDelegated(ctx, {
    ...input,
    key: "model-no-change-repeat",
  });
  await f.bridge.workers[0].tick();
  expect((await f.bridge.read(ctx, repeat.id)).result.noChanges).toBe(true);
  expect(calls).toBe(1);
  const after = (
    await f.pool.query(
      "SELECT tokens_charged::int,cost_charged::int FROM durable_budget_days WHERE workspace_id=$1 AND principal_id='*'",
      [f.workspaceId],
    )
  ).rows[0];
  expect(after).toEqual(before);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT data->'processed' processed FROM sources WHERE workspace_id=$1 AND id='source-a'",
        [f.workspaceId],
      )
    ).rows[0].processed,
  ).toBe(false);
  await f.bridge.stop();
});
it("browser close/restart continues only with the SAME live parent session, without copying tokens into jobs", async () => {
  const f = await setup();
  await f.bridge.stop();
  const browser = await browserIdentity(f.pool, f.humanEditor, servers),
    first = createRuntimeJobs(f.pool, f.service, {
      workerCount: 1,
      ...browser.options,
    });
  const j = await first.submitInteractive(
    browser.ctx,
    "query",
    { question: "기존", mode: "offline" },
    "browser-restart",
  );
  await first.stop();
  const second = createRuntimeJobs(f.pool, new RuntimeService(f.pool), {
    workerCount: 1,
    ...browser.options,
  });
  await second.workers[0].tick();
  expect((await second.read(browser.ctx, j.id)).status).toBe("succeeded");
  const grant = (
    await f.pool.query(
      "SELECT * FROM runtime_execution_grants WHERE job_id=$1",
      [j.id],
    )
  ).rows[0];
  expect(grant.parent_session_id).toBe(browser.sessionId);
  expect(grant.parent_credential_id).toBeNull();
  expect(JSON.stringify(grant)).not.toContain(browser.raw);
  expect(JSON.stringify(grant)).not.toContain(browser.accessToken);
  expect(JSON.stringify(grant)).not.toContain(browser.csrf);
  expect(browser.lockedNetworkCalls()).toBe(0);
  expect(browser.calls()).toBeGreaterThan(2);
  await second.stop();
});
it.each(["query", "ingest"] as const)(
  "HTTP logout during a real %s model call prevents cached results/domain writes and future poll returns401",
  async (kind) => {
    let begun!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (begun = r));
    await modelServer((_body, res) => {
      begun();
      release = () =>
        res.end(
          JSON.stringify({
            model: "actual-session-fixture",
            usage: { prompt_tokens: 4, completion_tokens: 3, cost: 0.001 },
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify(
                    kind === "query"
                      ? {
                          content: "기존 내용",
                          insufficient: false,
                          citations: [
                            {
                              pageId: "topic",
                              title: "주제",
                              version: 1,
                              quote: "기존 내용",
                            },
                          ],
                        }
                      : {
                          updates: [
                            {
                              id: "topic",
                              title: "주제",
                              summary: "제안",
                              content: "새 제안",
                              scope: "team",
                              baseVersion: 1,
                              links: [],
                              sourceIds: ["source-a"],
                              facts: [],
                            },
                          ],
                        },
                  ),
                },
              },
            ],
          }),
        );
    });
    const f = await setup();
    await f.bridge.stop();
    const browser = await browserIdentity(f.pool, f.humanEditor, servers),
      bridge = createRuntimeJobs(f.pool, f.service, {
        workerCount: 1,
        ...browser.options,
      }),
      url = await browserTransport(f.pool, browser, bridge, servers);
    const headers = {
      Cookie: `akh_session=${browser.raw}`,
      "X-CSRF-Token": browser.csrf,
      "Content-Type": "application/json",
      "Idempotency-Key": "logout-gate",
    };
    const accepted = await fetch(url + "/" + kind, {
      method: "POST",
      headers,
      body: JSON.stringify(
        kind === "query"
          ? { question: "기존", mode: "model" }
          : { sourceIds: ["source-a"], mode: "model" },
      ),
    });
    expect(accepted.status).toBe(202);
    const j = (await accepted.json()) as { id: string };
    const tick = bridge.workers[0].tick();
    await entered;
    expect(
      (await fetch(url + "/logout", { method: "POST", headers })).status,
    ).toBe(200);
    release();
    await tick;
    expect(
      (
        await fetch(url + "/jobs/" + j.id, {
          headers: { Cookie: `akh_session=${browser.raw}` },
        })
      ).status,
    ).toBe(401);
    const row = (
      await f.pool.query(
        "SELECT status,result,checkpoint FROM durable_jobs WHERE id=$1",
        [j.id],
      )
    ).rows[0];
    expect(row.status).toBe("dead");
    expect(row.result).toBeNull();
    expect(row.checkpoint?.effects?.["model-" + kind]).toBeUndefined();
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM runtime_answers WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(browser.lockedNetworkCalls()).toBe(0);
    await bridge.stop();
  },
);
it.each(["expired", "disabled", "group-removed"] as const)(
  "restarted parent grant fails closed on %s SSO state before effects",
  async (state) => {
    const f = await setup();
    await f.bridge.stop();
    const browser = await browserIdentity(f.pool, f.humanEditor, servers),
      first = createRuntimeJobs(f.pool, f.service, {
        workerCount: 1,
        ...browser.options,
      });
    const j = await first.submitInteractive(
      browser.ctx,
      "ingest",
      { sourceIds: ["source-a"], mode: "offline" },
      "parent-revoked",
    );
    await first.stop();
    if (state === "expired")
      await f.pool.query(
        "UPDATE runtime_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [browser.sessionId],
      );
    else if (state === "disabled") browser.setActive(false);
    else browser.setIdentityRole("reader");
    const restarted = createRuntimeJobs(f.pool, f.service, {
      workerCount: 1,
      ...browser.options,
    });
    await restarted.workers[0].tick();
    expect(
      (
        await f.pool.query("SELECT status FROM durable_jobs WHERE id=$1", [
          j.id,
        ])
      ).rows[0].status,
    ).toBe("dead");
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    await restarted.stop();
  },
);
it("unconfigured parent/directory verification is unknown, never an ambient session or stale login fallback", async () => {
  const f = await setup();
  await expect(
    f.bridge.submitInteractive(
      f.humanEditor,
      "query",
      { question: "기존", mode: "offline" },
      "no-parent",
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  const browser = await browserIdentity(f.pool, f.humanEditor, servers);
  await expect(
    f.bridge.submitInteractive(
      browser.ctx,
      "query",
      { question: "기존", mode: "offline" },
      "no-live-hook",
    ),
  ).rejects.toThrow("INTERACTIVE_GUARD_REQUIRED");
  const unconfigured = createRuntimeJobs(f.pool, f.service);
  expect(unconfigured.readiness().serviceDirectoryConfigured).toBe(false);
  expect(unconfigured.readiness().interactiveSessionConfigured).toBe(false);
  await unconfigured.stop();
  await f.bridge.stop();
});
it("all service bearer reads require independent current HTTP directory proof and cannot restore manually disabled product identities", async () => {
  const f = await setup();
  await f.bridge.stop();
  const access = new AccessService(f.pool),
    owner = { ...f.humanEditor, principalId: "fixture-owner" };
  const service = await access.createServicePrincipal(owner, {
    name: "directory-bound",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.pool.query(
    "UPDATE access_grants SET role='write' WHERE workspace_id=$1 AND principal_id=$2",
    [f.workspaceId, service.id],
  );
  const credential = await access.issueServiceCredential(owner, service.id, {
      actions: ["knowledge.read", "changeset.propose", "lint.run"],
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    }),
    ctx = {
      workspaceId: f.workspaceId,
      principalId: service.id,
      credentialId: credential.id,
    };
  const noProvider = createRuntimeJobs(f.pool, f.service, { workerCount: 1 });
  await expect(noProvider.revalidateCredential(ctx)).rejects.toThrow(
    "DIRECTORY_STATUS_UNKNOWN",
  );
  await noProvider.stop();
  let active: boolean | null = true,
    stale = false,
    calls = 0;
  const directory = createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const c of req) body += c;
    const subject = JSON.parse(body);
    res.end(
      JSON.stringify({
        ...subject,
        active,
        verifiedAt: new Date(Date.now() - (stale ? 60000 : 0)).toISOString(),
        validUntil: new Date(Date.now() + 10000).toISOString(),
      }),
    );
  });
  servers.push(directory);
  directory.listen(0, "127.0.0.1");
  await once(directory, "listening");
  const url = `http://127.0.0.1:${(directory.address() as { port: number }).port}/status`;
  const bridge = createRuntimeJobs(f.pool, f.service, {
    workerCount: 1,
    directoryProviderId: "actual-http-fixture-directory",
    directoryStatus: async (subject, io) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subject),
        signal: io?.signal,
      });
      return res.json();
    },
  });
  await bridge.revalidateCredential(ctx);
  expect(calls).toBe(1);
  active = false;
  await expect(bridge.revalidateCredential(ctx)).rejects.toThrow();
  expect(
    (
      await f.pool.query("SELECT active FROM access_principals WHERE id=$1", [
        service.id,
      ])
    ).rows[0].active,
  ).toBe(true);
  active = true;
  stale = true;
  await expect(bridge.revalidateCredential(ctx)).rejects.toThrow(
    "DIRECTORY_STATUS_UNKNOWN",
  );
  stale = false;
  await bridge.revalidateCredential(ctx);
  await f.pool.query("UPDATE access_principals SET active=false WHERE id=$1", [
    service.id,
  ]);
  await expect(bridge.revalidateCredential(ctx)).rejects.toThrow();
  expect(
    (
      await f.pool.query("SELECT active FROM access_principals WHERE id=$1", [
        service.id,
      ])
    ).rows[0].active,
  ).toBe(false);
  await bridge.stop();
});
it("verified private-personal input is prompted as private, preserves the source author and records the actual AI response model", async () => {
  let prompt = "";
  await modelServer((body, res) => {
    prompt = body.messages[0].content;
    res.end(
      JSON.stringify({
        model: "actual-private-producer",
        usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                updates: [
                  {
                    id: "private-knowledge",
                    title: "개인 지식",
                    summary: "개인 근거",
                    content: "개인 근거 내용",
                    scope: "private",
                    baseVersion: 0,
                    links: [],
                    sourceIds: ["private-source"],
                    facts: [],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const f = await setup();
  await f.bridge.stop();
  const access = new AccessService(f.pool),
    space = await access.createSpace(f.humanEditor, {
      slug: `private-${f.workspaceId.slice(0, 12)}`,
    }),
    human = { workspaceId: space.id, principalId: f.humanEditor.principalId };
  const rawSource = {
    ...source,
    id: "private-source",
    scope: "private" as const,
    content: "개인 근거 내용",
    targetPageId: "private-knowledge",
    author: "original-source-human",
  };
  await f.service.core.registerSource(human, rawSource, [human.principalId]);
  const pat = await access.issueCredential(human, {
      actions: ["knowledge.read", "changeset.propose", "lint.run"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
    ctx = { ...human, credentialId: pat.id },
    bridge = createRuntimeJobs(f.pool, f.service, { workerCount: 1 });
  const j = await bridge.submitInteractive(
    ctx,
    "ingest",
    { sourceIds: ["private-source"], mode: "model" },
    "private-model",
  );
  await bridge.workers[0].tick();
  const result = await bridge.read(ctx, j.id);
  expect(result.status).toBe("succeeded");
  expect(prompt).toContain('"scope":"private"');
  expect(prompt).toContain("NEVER team/company");
  expect(prompt).not.toContain('"scope":"team or company"');
  const raw = (
    await f.pool.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [space.id, "private-source"],
    )
  ).rows[0].data;
  expect(raw.author).toBe("original-source-human");
  expect(raw.content).toBe("개인 근거 내용");
  const batch = (
    await f.pool.query("SELECT data FROM batches WHERE workspace_id=$1", [
      space.id,
    ])
  ).rows[0].data;
  expect(batch.producer).toEqual({
    kind: "model",
    provider: "fixture-http",
    model: "actual-private-producer",
  });
  expect(batch.responsibleUserId).toBe(human.principalId);
  expect((await bridge.jobs.telemetry(ctx, j.id)).items[0].model).toBe(
    "actual-private-producer",
  );
  await bridge.stop();
});
it("an omitted response model is unknown rather than being replaced by the requested alias", async () => {
  await modelServer((_body, res) =>
    res.end(
      JSON.stringify({
        usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                content: "근거 부족",
                insufficient: true,
                citations: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  const f = await setup();
  const j = await f.bridge.submitInteractive(
    f.editor,
    "query",
    { question: "기존", mode: "model" },
    "unknown-response-model",
  );
  await f.bridge.workers[0].tick();
  const row = (await f.bridge.jobs.telemetry(f.editor, j.id)).items[0];
  expect(row.model).toBeNull();
  expect(row.requested_model).toBe("fixture-request");
  await f.bridge.stop();
});
