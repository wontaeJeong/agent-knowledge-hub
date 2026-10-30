import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture, source, page } from "../test-support";
import { transaction } from "../database";
import { authorizeInTransaction } from "../access";
import { JobService } from "../jobs/service";
import type { Lease, JobHooks } from "../jobs/types";
import type { RuntimeExecution } from "../runtime/knowledge";
import { digest } from "../publication";
import { RefinementService } from "./service";
import { createSemanticProvider } from "./semantic";
import { claim } from "./fixtures";
import { createRuntimeJobs } from "../jobs/runtime";
import { RuntimeService } from "../runtime/knowledge";
import { AccessService } from "../access";
import type { RuntimeIdentityOptions } from "../jobs/identity";
import { trustedFixtureVerifier } from "./execution-fixture";

const pools: Pool[] = [],
  servers: Server[] = [];
const ownedSchemas: { url: string; name: string }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await Promise.all(pools.splice(0).map((p) => p.end()));
  for (const own of ownedSchemas.splice(0)) {
    if (!/^akh_semantic_[a-f0-9]{32}$/.test(own.name))
      throw Error("invalid owned fixture schema");
    const admin = new Pool({ connectionString: own.url });
    try {
      await admin.query(`DROP SCHEMA ${own.name} CASCADE`);
    } finally {
      await admin.end();
    }
  }
  vi.unstubAllEnvs();
});
type Reply = (
  body: any,
  res: import("node:http").ServerResponse,
) => void | Promise<void>;
async function setup(reply?: Reply, configured = true) {
  // Each queue fixture uses its own schema in the designated test DB. No other job rows are truncated.
  if (!process.env.TEST_DATABASE_URL) throw Error("TEST_DATABASE_URL required");
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "akh_semantic_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  ownedSchemas.push({ url: process.env.TEST_DATABASE_URL, name: schema });
  await admin.end();
  const prior = process.env.TEST_DATABASE_URL,
    url = new URL(prior);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  url.searchParams.set("application_name", schema);
  process.env.TEST_DATABASE_URL = url.href;
  let f: Awaited<ReturnType<typeof fixture>>;
  try {
    f = await fixture();
  } finally {
    process.env.TEST_DATABASE_URL = prior;
  }
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  let calls = 0;
  const bodies: any[] = [];
  const finding = {
    kind: "stale",
    claimIds: ["c1"],
    explanation: "동일 원본을 보존하는 재검토 후보",
    citations: [
      {
        claimId: "c1",
        evidenceId: "e1",
        sourceId: source.id,
        sourceVersion: digest(source),
        quote: source.content,
      },
    ],
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls++;
    const body = JSON.parse(raw);
    bodies.push(body);
    if (reply) {
      await reply(body, res);
      return;
    }
    res.end(
      JSON.stringify({
        model: "actual-lint-fixture",
        usage: { prompt_tokens: 19, completion_tokens: 7 },
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ findings: [finding] }) },
          },
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("fixture");
  const provider = configured
    ? createSemanticProvider({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        provider: "semantic-http-fixture",
        model: "requested-fixture",
        allowTransmission: true,
      })
    : undefined;
  const refinement = new RefinementService(
    f.pool,
    authorizeInTransaction,
    provider,
  );
  const evidence = {
    id: "e1",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: digest(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: claim.assertedAt,
    verifiedAt: null,
    conditions: claim.conditions,
  };
  await refinement.addEvidence(f.editor, evidence);
  const { recordedAt: _, recordedBy: __, ...input } = claim;
  await refinement.addClaim(f.editor, input);
  const adapter = refinement.semanticJobAdapter();
  let now = Date.now();
  const hooks: JobHooks = {
    inputsAreReadOnly: true,
    authorize: async (db, ctx) => {
      if (
        ctx.workspaceId !== f.workspaceId ||
        ctx.principalId !== f.editor.principalId ||
        (ctx.credentialId && ctx.credentialId !== "semantic-fixture-credential")
      )
        throw Error("FORBIDDEN");
      await authorizeInTransaction(db, f.editor, "knowledge.read");
    },
    resolveIdentity: async (_db, identity) => {
      if (
        identity.workspaceId !== f.workspaceId ||
        identity.principalId !== f.editor.principalId ||
        identity.credentialId !== "semantic-fixture-credential"
      )
        throw Error("CREDENTIAL_REVOKED");
      return { ...identity };
    },
    policyFingerprint: async () => "semantic-fixture-policy-v1",
    validateScope: async () => {},
  };
  const jobs = new JobService(f.pool, hooks, {
    clock: () => new Date(now),
    leaseMs: 10000,
    globalConcurrency: 4,
    workspaceConcurrency: 2,
    principalConcurrency: 2,
  });
  const prepare = () =>
    transaction(f.pool, f.workspaceId, (db) =>
      adapter.prepare(db, f.editor, {
        semantic: true,
        context: { environment: {} },
      }),
    );
  const enqueue = async () => {
    const prepared = await prepare();
    const job = await jobs.enqueue(
      { ...f.editor, credentialId: "semantic-fixture-credential" },
      {
        kind: "lint",
        key: randomUUID(),
        ...prepared,
        reservation: { tokens: 20000, costMicros: 1000 },
        model: "requested-fixture",
        timeoutMs: 30000,
        maxAttempts: 3,
      },
    );
    const lease = await jobs.claim("semantic-fixture-worker");
    if (!lease || lease.id !== job.id) throw Error("fixture isolation");
    return { prepared, job, lease };
  };
  const execution = (
    lease: Lease,
    controller = new AbortController(),
    afterPrepared?: () => void,
  ): RuntimeExecution => {
    let used = false;
    return {
      modelWasUsed: () => used,
      producer: async (_mode, db) => {
        const r = (
          await (db ?? f.pool).query(
            "SELECT provider,model FROM durable_model_calls WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1",
            [lease.id],
          )
        ).rows[0];
        return {
          kind: "model",
          provider: r?.provider ?? null,
          model: r?.model ?? null,
        };
      },
      modelResult: async (operation, call) => {
        used = true;
        const previous = (
          await f.pool.query(
            "SELECT checkpoint FROM durable_jobs WHERE id=$1",
            [lease.id],
          )
        ).rows[0]?.checkpoint?.effects?.["model-" + operation];
        if (previous !== undefined) return previous;
        const raw = await call();
        const saved = await jobs.savePrepared(lease, "model-" + operation, raw);
        afterPrepared?.();
        return saved;
      },
      captureInputs: (db, pages, sources) =>
        jobs.captureInputs(db, lease, pages, sources).then(() => {}),
      beforeWrite: (db) =>
        jobs.assertReadyInTransaction(db, lease).then(() => {}),
      completed: async (stage) =>
        (
          await f.pool.query(
            "SELECT checkpoint FROM durable_jobs WHERE id=$1",
            [lease.id],
          )
        ).rows[0]?.checkpoint?.effects?.[stage],
      persist: (db, stage, write) => jobs.commitEffect(db, lease, stage, write),
      proposalCreated: async () => {
        throw Error("SEMANTIC_MUST_NOT_PUBLISH");
      },
      maxChanges: 20,
      modelOptions: {
        signal: controller.signal,
        maxContextBytes: 15000,
        maxOutputTokens: 32,
        maxResponseBytes: 10000,
        timeoutMs: 2000,
        beforeCall: (provider, model) =>
          jobs.beginModel(lease, {
            callId: "semantic-call-" + lease.attempt,
            provider,
            model,
            maxTokens: 20000,
            maxCostMicros: 1000,
          }),
        onUsage: (usage) =>
          jobs.recordModel(lease, {
            callId: "semantic-call-" + lease.attempt,
            ...usage,
          }),
      },
    };
  };
  const count = async () =>
    Number(
      (
        await f.pool.query(
          "SELECT count(*) n FROM refinement_requests WHERE workspace_id=$1 AND data->>'reason'='semantic-lint'",
          [f.workspaceId],
        )
      ).rows[0].n,
    );
  return {
    ...f,
    schema,
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    refinement,
    adapter,
    evidence,
    input,
    prepare,
    enqueue,
    execution,
    jobs,
    count,
    bodies,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("prepare is DB-only under the admission workspace lock and seals fixed claims and full parent/source scope", async () => {
  const f = await setup();
  const sourceB = { ...source, id: "source-b", content: "상위 문서 원본" };
  for (const [kind, id] of [
    ["source", sourceB.id],
    ["page", "parent"],
  ]) {
    await f.pool.query("INSERT INTO resources VALUES($1,$2,$3)", [
      f.workspaceId,
      kind,
      id,
    ]);
    for (const actor of ["editor", "reviewer", "reader"])
      await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
        f.workspaceId,
        kind,
        id,
        actor,
      ]);
  }
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, sourceB.id, sourceB],
  );
  const { versions, ...metadata } = page;
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'parent',$2)",
    [f.workspaceId, { ...metadata, id: "parent" }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'parent',1,$2)", [
    f.workspaceId,
    { ...versions[0], sourceIds: [sourceB.id] },
  ]);
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','parent')",
    [f.workspaceId],
  );
  const prepared = await transaction(f.pool, f.workspaceId, async (db) => {
    const noPool = vi.spyOn(f.pool, "connect").mockImplementation(() => {
      throw Error("nested pool call");
    });
    try {
      return await f.adapter.prepare(db, f.editor, {
        semantic: true,
        context: { environment: {} },
      });
    } finally {
      noPool.mockRestore();
    }
  });
  expect(prepared.pageIds).toEqual(["parent", "topic"]);
  expect(prepared.sourceIds).toEqual([source.id, sourceB.id]);
  expect(prepared.payload.claimIds).toEqual(["c1"]);
  expect(prepared.payload.contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(f.calls()).toBe(0);
  const replay = await transaction(f.pool, f.workspaceId, (db) =>
    f.adapter.prepare(db, f.editor, prepared.payload),
  );
  expect(replay).toEqual(prepared);
  const raw = await transaction(f.pool, f.workspaceId, (db) =>
    f.adapter.prepare(db, f.editor, { environment: {} }),
  );
  expect(raw.payload.claimIds).toEqual(["c1"]);
});
it("admission checks existing execution attestations locally and never recontacts the proof gateway or stores signed envelopes as sources", async () => {
  const f = await setup();
  let gatewayCalls = 0;
  const refinement = new RefinementService(
    f.pool,
    authorizeInTransaction,
    f.refinement.provider,
    {
      executionVerifier: trustedFixtureVerifier(async () => {
        gatewayCalls++;
      }),
    },
  );
  await refinement.addEvidence(f.editor, {
    ...f.evidence,
    id: "already-attested",
    kind: "independent-execution",
    executionId: "run-1",
  });
  await refinement.addClaim(f.editor, {
    ...f.input,
    id: "attested-claim",
    evidenceIds: ["already-attested"],
  });
  expect(gatewayCalls).toBe(1);
  const sealed = await transaction(f.pool, f.workspaceId, (db) =>
    refinement.semanticJobAdapter().prepare(db, f.editor, { environment: {} }),
  );
  expect(gatewayCalls).toBe(1);
  expect(f.calls()).toBe(0);
  expect(sealed.payload.claimIds).toEqual(["attested-claim", "c1"]);
  expect(sealed.sourceIds).toEqual([source.id]);
  expect(JSON.stringify(sealed.payload)).not.toContain("signature");
});
it("queued semantic HTTP is budgeted/attributed once, pins claims against later additions, and atomically replays findings", async () => {
  const f = await setup(),
    { prepared, lease } = await f.enqueue();
  await f.refinement.addClaim(f.editor, {
    ...f.input,
    id: "c0",
    value: "admission 이후 새 주장",
  });
  expect(
    await transaction(f.pool, f.workspaceId, (db) =>
      f.adapter.prepare(db, f.editor, prepared.payload),
    ),
  ).toEqual(prepared);
  const execution = f.execution(lease),
    result = await f.adapter.execute(f.editor, prepared.payload, execution);
  expect(result).toMatchObject({
    status: "completed",
    modelAnalysisPerformed: true,
  });
  expect(f.calls()).toBe(1);
  expect(f.bodies[0].max_tokens).toBe(32);
  expect(
    JSON.parse(f.bodies[0].messages[1].content).claims.map((c: any) => c.id),
  ).toEqual(["c1"]);
  const trace = (
    await f.pool.query("SELECT * FROM durable_model_calls WHERE job_id=$1", [
      lease.id,
    ])
  ).rows[0];
  expect(trace).toMatchObject({
    provider: "semantic-http-fixture",
    requested_model: "requested-fixture",
    model: "actual-lint-fixture",
    input_tokens: "19",
    output_tokens: "7",
    cost_micros: null,
    error_code: null,
  });
  expect(
    await f.adapter.execute(f.editor, prepared.payload, f.execution(lease)),
  ).toEqual(result);
  expect(f.calls()).toBe(1);
  expect(await f.count()).toBe(1);
  await f.jobs.complete(lease, { value: result, noModelCalls: false });
  expect((await f.jobs.get(f.editor, lease.id)).status).toBe("succeeded");
});
it("new review metadata after admission fails before any HTTP; authenticated callers cannot use inline semantic budget bypass", async () => {
  const f = await setup(),
    { prepared, lease } = await f.enqueue();
  await f.refinement.reviewClaim(f.ctx, {
    id: "review-after-admission",
    claimIds: ["c1"],
    status: "reviewed",
    evidenceIds: ["e1"],
    reason: "입력 상태가 바뀜",
  });
  await expect(
    f.adapter.execute(f.editor, prepared.payload, f.execution(lease)),
  ).rejects.toThrow("INPUT_CHANGED");
  expect(f.calls()).toBe(0);
  await expect(
    f.refinement.semanticLint(
      {
        ...f.editor,
        authorization: {
          revalidate: async () => {},
          assertSession: async () => {},
        },
      },
      { environment: {} },
    ),
  ).rejects.toThrow("SEMANTIC_JOB_REQUIRED");
});
it("a finding inherits ALL model-context source restrictions, not just the sources cited in the finding", async () => {
  const f = await setup(),
    sourceB = {
      ...source,
      id: "private-review-source",
      content: "검토 참고 자료 B",
    };
  await f.pool.query("INSERT INTO resources VALUES($1,'source',$2)", [
    f.workspaceId,
    sourceB.id,
  ]);
  for (const actor of ["editor", "reviewer"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source',$2,$3)",
      [f.workspaceId, sourceB.id, actor],
    );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [f.workspaceId, sourceB.id, sourceB],
  );
  await f.refinement.addEvidence(f.editor, {
    ...f.evidence,
    id: "private-review-evidence",
    sourceId: sourceB.id,
    sourceVersion: digest(sourceB),
    location: { start: 0, end: sourceB.content.length, quote: sourceB.content },
  });
  await f.refinement.reviewClaim(f.ctx, {
    id: "private-context-review",
    claimIds: ["c1"],
    status: "reviewed",
    evidenceIds: ["private-review-evidence"],
    reason: "비공개 원본을 함께 검토",
  });
  const { prepared, lease } = await f.enqueue();
  expect(prepared.sourceIds).toContain(sourceB.id);
  await f.adapter.execute(f.editor, prepared.payload, f.execution(lease));
  expect(
    (
      await f.refinement.context(f.reader, {
        asOf: "2026-03-01T00:00:00Z",
        environment: {},
      })
    ).items.map((c) => c.id),
  ).toContain("c1");
  expect(
    (await f.refinement.requests(f.reader)).items.filter(
      (r) => r.reason === "semantic-lint",
    ),
  ).toHaveLength(0);
});
it("an unconfigured queued model fails instead of succeeding with an error payload; empty inputs explicitly skip analysis", async () => {
  const f = await setup(undefined, false),
    { prepared, lease } = await f.enqueue();
  await expect(
    f.adapter.execute(f.editor, prepared.payload, f.execution(lease)),
  ).rejects.toThrow("MODEL_NOT_CONFIGURED");
  await f.jobs.fail(lease, "MODEL_NOT_CONFIGURED", false);
  expect((await f.jobs.get(f.editor, lease.id)).status).toBe("dead");
  expect(await f.count()).toBe(0);
  const empty = await transaction(f.pool, f.workspaceId, (db) =>
    f.adapter.prepare(db, f.editor, {
      semantic: true,
      context: { environment: {}, pageIds: ["not-selected"] },
    }),
  );
  const job = await f.jobs.enqueue(
    { ...f.editor, credentialId: "semantic-fixture-credential" },
    {
      kind: "lint",
      key: "empty",
      ...empty,
      reservation: { tokens: 20000, costMicros: 1000 },
      timeoutMs: 30000,
      maxAttempts: 1,
      model: "requested-fixture",
    },
  );
  const next = (await f.jobs.claim("semantic-empty"))!;
  expect(next.id).toBe(job.id);
  expect(
    await f.adapter.execute(f.editor, empty.payload, f.execution(next)),
  ).toMatchObject({
    status: "no-inputs",
    modelAnalysisPerformed: false,
    findings: [],
  });
  expect(f.calls()).toBe(0);
});
it("source permission changes during real HTTP prevent any findings write", async () => {
  let f: Awaited<ReturnType<typeof setup>>;
  f = await setup(async (_body, res) => {
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
      [f.workspaceId, source.id],
    );
    res.end(
      JSON.stringify({
        model: "actual-lint-fixture",
        usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0.000001 },
        choices: [
          { finish_reason: "stop", message: { content: '{"findings":[]}' } },
        ],
      }),
    );
  });
  const { prepared, lease } = await f.enqueue();
  await expect(
    f.adapter.execute(f.editor, prepared.payload, f.execution(lease)),
  ).rejects.toThrow();
  expect(await f.count()).toBe(0);
  expect(f.calls()).toBe(1);
});
it("invalid semantic citations are recorded as actual model errors and the queued job fails without candidate writes", async () => {
  const f = await setup(async (_body, res) => {
    res.end(
      JSON.stringify({
        model: "actual-invalid-fixture",
        usage: { prompt_tokens: 5, completion_tokens: 4, cost: 0.000002 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                findings: [
                  {
                    kind: "stale",
                    claimIds: ["not-in-snapshot"],
                    explanation: "forged",
                    citations: [
                      {
                        claimId: "not-in-snapshot",
                        evidenceId: "e1",
                        sourceId: source.id,
                        sourceVersion: digest(source),
                        quote: source.content,
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  const { prepared, lease } = await f.enqueue();
  await expect(
    f.adapter.execute(f.editor, prepared.payload, f.execution(lease)),
  ).rejects.toThrow("MODEL_INVALID");
  await f.jobs.fail(lease, "MODEL_INVALID", false);
  expect((await f.jobs.get(f.editor, lease.id)).status).toBe("dead");
  expect(await f.count()).toBe(0);
  expect(
    (
      await f.pool.query("SELECT * FROM durable_model_calls WHERE job_id=$1", [
        lease.id,
      ])
    ).rows[0],
  ).toMatchObject({
    provider: "semantic-http-fixture",
    model: "actual-invalid-fixture",
    input_tokens: "5",
    output_tokens: "4",
    cost_micros: "2",
    error_code: "MODEL_INVALID",
  });
});
it("cancellation aborts actual HTTP, records unknown/error telemetry and cannot commit model findings", async () => {
  const controller = new AbortController();
  let f: Awaited<ReturnType<typeof setup>>, lease: Lease;
  f = await setup(async () => {
    await f.jobs.cancel(f.editor, lease.id);
    controller.abort();
  });
  ({ lease } = await f.enqueue());
  await expect(
    f.adapter.execute(
      f.editor,
      lease.input.payload,
      f.execution(lease, controller),
    ),
  ).rejects.toThrow("CANCELLED");
  await f.jobs.fail(lease, "CANCELLED", false);
  expect((await f.jobs.get(f.editor, lease.id)).status).toBe("cancelled");
  expect(await f.count()).toBe(0);
  const row = (
    await f.pool.query("SELECT * FROM durable_model_calls WHERE job_id=$1", [
      lease.id,
    ])
  ).rows[0];
  expect(row).toMatchObject({
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_micros: null,
    error_code: "CANCELLED",
  });
});
it("a lost fence after cached model result leaves no write, then a reclaimed lease persists once without another HTTP call", async () => {
  const f = await setup(),
    { prepared, lease } = await f.enqueue();
  await expect(
    f.adapter.execute(
      f.editor,
      prepared.payload,
      f.execution(lease, new AbortController(), () => f.advance(10001)),
    ),
  ).rejects.toThrow("LEASE_LOST");
  expect(await f.count()).toBe(0);
  const next = (await f.jobs.claim("semantic-reclaimed"))!;
  expect(next.fence).toBeGreaterThan(lease.fence);
  const result = await f.adapter.execute(
    f.editor,
    prepared.payload,
    f.execution(next),
  );
  expect(result).toMatchObject({ status: "completed" });
  expect(f.calls()).toBe(1);
  expect(await f.count()).toBe(1);
});
it("lease loss after the request write rolls back findings and the stage checkpoint in the same transaction", async () => {
  const f = await setup(),
    { prepared, lease } = await f.enqueue(),
    execution = f.execution(lease);
  execution.persist = (db, stage, write) =>
    f.jobs.commitEffect(db, lease, stage, async () => {
      const value = await write();
      f.advance(10001);
      return value;
    });
  await expect(
    f.adapter.execute(f.editor, prepared.payload, execution),
  ).rejects.toThrow("LEASE_LOST");
  expect(await f.count()).toBe(0);
  const checkpoint = (
    await f.pool.query("SELECT checkpoint FROM durable_jobs WHERE id=$1", [
      lease.id,
    ])
  ).rows[0].checkpoint;
  expect(checkpoint.effects["semantic-lint"]).toBeUndefined();
  expect(checkpoint.effects["model-semantic-lint"]).toBeTruthy();
  const next = (await f.jobs.claim("semantic-atomic-retry"))!;
  await f.adapter.execute(f.editor, prepared.payload, f.execution(next));
  expect(await f.count()).toBe(1);
  expect(f.calls()).toBe(1);
});
it("production runtime bridge admits a bounded lint-only credential and executes the sealed semantic adapter through real HTTP", async () => {
  const f = await setup();
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", f.baseUrl);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "requested-fixture");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "semantic-http-fixture");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  const directory: RuntimeIdentityOptions = {
    directoryProviderId: "semantic-explicit-fixture-roster",
    directoryStatus: async (subject) => ({
      ...subject,
      active: true,
      verifiedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 10000).toISOString(),
    }),
  };
  const bridge = createRuntimeJobs(f.pool, new RuntimeService(f.pool), {
    ...directory,
    workerCount: 1,
    semanticLint: f.adapter,
  });
  try {
    const credential = await new AccessService(f.pool).issueCredential(
      f.editor,
      {
        actions: ["knowledge.read", "lint.run"],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    );
    const ctx = { ...f.editor, credentialId: credential.id };
    const job = await bridge.submitInteractive(
      ctx,
      "lint",
      { semantic: true, context: { environment: {} } },
      "semantic-production-bridge",
    );
    expect(job.status).toBe("queued");
    await f.refinement.addClaim(f.editor, {
      ...f.input,
      id: "c0",
      value: "대기 중 새 주장; 고정 입력에는 미포함",
    });
    await bridge.workers[0].tick();
    const done = await bridge.read(ctx, job.id);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({
      status: "completed",
      modelAnalysisPerformed: true,
    });
    expect(f.calls()).toBe(1);
    expect(await f.count()).toBe(1);
    expect(
      JSON.parse(f.bodies[0].messages[1].content).claims.map((c: any) => c.id),
    ).toEqual(["c1"]);
  } finally {
    await bridge.stop();
  }
}, 20000);
