import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { fixture, adoptFixture, source } from "../test-support";
import { transaction } from "../database";
import { RuntimeService } from "../runtime/knowledge";
import {
  registerTrustedDestinations,
  setSourcePolicy,
  type Purpose,
} from "./model";
import { bindModelTransmission } from "./binding";
import {
  assertFeature,
  featureForMcpOperation,
  featureForRoute,
  featureForJobOperation,
} from "./features";
import type { Context } from "../service";
import {
  bindPrivateImportTransmission,
  setPrivateImportPolicy,
} from "./imports";
import { callModel } from "../runtime/model";
import { setFeature } from "./features";
import { createRuntimeJobs } from "../jobs/runtime";
import { captureEnvelope } from "../provenance";
import { loadState } from "../repository";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});
async function setup(
  onRequest?: () => Promise<void>,
  kind: "query" | "ingest" = "query",
) {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await adoptFixture(f.pool, f.workspaceId);
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw));
    calls++;
    await onRequest?.();
    res.end(
      JSON.stringify({
        model: "fixture",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify(
                kind === "ingest"
                  ? {
                      updates: [
                        {
                          id: "policy-ingest-proposal",
                          title: "합성 검토 후보",
                          summary: "fixture",
                          content: "합성 입력의 검토 후보",
                          scope: "team",
                          baseVersion: 0,
                          sourceIds: [source.id],
                          links: [],
                          facts: [],
                        },
                      ],
                    }
                  : {
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
                    },
              ),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => provider.close(() => r())));
  const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "fixture");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "fixture");
  await registerTrustedDestinations(f.pool, [
    {
      id: "fixture",
      url: base + "/chat/completions",
      purposes: [
        "query",
        "ingest",
        "semantic-lint",
        "organize",
        "execution-verification",
      ],
      classifications: ["local-fixture"],
      active: true,
    },
  ]);
  const guard = { revalidate: async () => {}, assertSession: async () => {} };
  const ctx: Context = { ...f.editor, authorization: guard };
  const admin: Context = {
    workspaceId: f.workspaceId,
    principalId: "fixture-owner",
    authorization: guard,
  };
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source',$2,'fixture-owner')",
    [f.workspaceId, source.id],
  );
  const tx = <T>(work: (db: import("pg").PoolClient) => Promise<T>) =>
    transaction(f.pool, f.workspaceId, work);
  const approve = async (purpose: Purpose = "query") => {
    const d = (
      await f.pool.query(
        "SELECT fingerprint FROM model_destinations WHERE id='fixture'",
      )
    ).rows[0];
    await tx((db) =>
      setSourcePolicy(db, admin, {
        sourceId: source.id,
        classification: "local-fixture",
        expectedRevision: 0,
        grants: [
          {
            destinationId: "fixture",
            purpose,
            fingerprint: d.fingerprint,
          },
        ],
        impactAcknowledged: true,
      }),
    );
  };
  return {
    ...f,
    ctx,
    admin,
    tx,
    approve,
    base,
    runtime: new RuntimeService(f.pool),
    calls: () => calls,
    bodies,
  };
}
test("actual RuntimeService query fails before provider network without source policy", async () => {
  const f = await setup();
  await expect(f.runtime.query(f.ctx, "기존", "model")).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(f.calls()).toBe(0);
});
test("actual RuntimeService ingest is denied before network, then creates only an authorized review proposal", async () => {
  const f = await setup(undefined, "ingest");
  await expect(f.runtime.ingest(f.ctx, [source.id], "model")).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(f.calls()).toBe(0);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'page','topic','fixture-owner')",
    [f.workspaceId],
  );
  await f.approve("ingest");
  const result = await f.runtime.ingest(f.ctx, [source.id], "model");
  expect(result.id).toBeTruthy();
  expect(f.calls()).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT status FROM (SELECT data->>'status' AS status FROM batches WHERE workspace_id=$1) s",
        [f.workspaceId],
      )
    ).rows[0].status,
  ).toBe("pending");
  expect(
    (
      await f.pool.query("SELECT * FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("actual inflight ingest policy revocation rolls back its proposal", async () => {
  let revoke: () => Promise<void> = async () => {};
  const f = await setup(() => revoke(), "ingest");
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'page','topic','fixture-owner')",
    [f.workspaceId],
  );
  await f.approve("ingest");
  revoke = () =>
    f.tx((db) =>
      setSourcePolicy(db, f.admin, {
        sourceId: source.id,
        expectedRevision: 1,
        classification: "local-fixture",
        grants: [],
        impactAcknowledged: true,
      }),
    );
  await expect(f.runtime.ingest(f.ctx, [source.id], "model")).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(f.calls()).toBe(1);
  expect(
    (
      await f.pool.query("SELECT * FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("policy binding preserves byte/token/timeout limits and chains budget/usage callbacks without replacing them", async () => {
  const f = await setup();
  await f.approve();
  let before = 0,
    usage = 0;
  const envelope = await f.tx(async (db) =>
    captureEnvelope(db, f.ctx, await loadState(db, f.workspaceId), ["topic"]),
  );
  const binding = await bindModelTransmission(
    f.pool,
    f.ctx,
    "query",
    envelope,
    {
      rules: "explicit synthetic fixture rules",
      maxContextBytes: 10000,
      maxOutputTokens: 32,
      maxResponseBytes: 5000,
      timeoutMs: 1000,
      beforeCall: async () => {
        before++;
      },
      onUsage: async () => {
        usage++;
      },
    },
  );
  await callModel("query", { question: "기존" }, binding.options);
  await f.tx((db) => binding.recheck(db));
  expect(before).toBe(1);
  expect(usage).toBe(1);
  expect(f.bodies[0].max_tokens).toBe(32);
  expect(binding.options.timeoutMs).toBe(1000);
  await expect(
    callModel(
      "query",
      { question: "too large" },
      { ...binding.options, maxContextBytes: 1 },
    ),
  ).rejects.toThrow("MODEL_CONTEXT_LIMIT");
  expect(f.calls()).toBe(1);
  expect(before).toBe(1);
});
test("current canonical PAT works without an OIDC capability; forged revoked and wrong-space credentials fail", async () => {
  const f = await setup();
  await f.approve();
  await f.pool.query(
    "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES('pat-fixture','fixture-no-usable-secret','editor',$1,ARRAY['knowledge.read'],now()+interval '1 hour')",
    [f.workspaceId],
  );
  const pat = { ...f.editor, credentialId: "pat-fixture" };
  await f.tx((db) => assertFeature(db, pat, "query"));
  const answer = await f.runtime.query(pat, "기존", "model");
  expect(answer.content).toBe("기존 내용");
  expect(f.calls()).toBe(1);
  await f.pool.query(
    "UPDATE access_credentials SET revoked=true WHERE id='pat-fixture'",
  );
  await expect(f.runtime.query(pat, "기존", "model")).rejects.toThrow();
  expect(f.calls()).toBe(1);
  await expect(
    f.tx((db) =>
      assertFeature(db, { ...pat, credentialId: "forged" }, "query"),
    ),
  ).rejects.toThrow();
});
test("source policy changed while actual model is inflight prevents answer persistence", async () => {
  let change: () => Promise<void> = async () => {};
  const f = await setup(() => change());
  await f.approve();
  change = () =>
    f.tx((db) =>
      setSourcePolicy(db, f.admin, {
        sourceId: source.id,
        classification: "local-fixture",
        expectedRevision: 1,
        grants: [],
        impactAcknowledged: true,
      }),
    );
  await expect(f.runtime.query(f.ctx, "기존", "model")).rejects.toThrow();
  expect(f.calls()).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT * FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
});
test("actual RuntimeService cannot reuse an old grant after provider address changes back", async () => {
  const f = await setup();
  await f.approve();
  for (const url of [f.base + "/changed", f.base + "/chat/completions"])
    await registerTrustedDestinations(f.pool, [
      {
        id: "fixture",
        url,
        purposes: [
          "query",
          "ingest",
          "semantic-lint",
          "organize",
          "execution-verification",
        ],
        classifications: ["local-fixture"],
        active: true,
      },
    ]);
  await expect(f.runtime.query(f.ctx, "기존", "model")).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(f.calls()).toBe(0);
});
test("feature checks do not add unrelated read/export/admin capabilities and prototype operations never resolve", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES('write-fixture','no-secret','editor',$1,ARRAY['source.create'],now()+interval '1 hour')",
    [f.workspaceId],
  );
  const write = { ...f.editor, credentialId: "write-fixture" };
  await f.tx((db) =>
    assertFeature(db, write, "ingest", undefined, "source.create"),
  );
  for (const name of ["constructor", "__proto__", "toString"]) {
    expect(featureForMcpOperation(name)).toBeNull();
    expect(featureForJobOperation(name)).toBeNull();
    expect(featureForRoute("POST", name)).toBeNull();
  }
});
test("role-less exact-version shared reader can check sharing without global read/admin promotion", async () => {
  const f = await setup();
  const principal = "share-" + f.workspaceId;
  await f.pool.query("INSERT INTO access_principals(id) VALUES($1)", [
    principal,
  ]);
  await f.pool.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
    f.workspaceId,
    principal,
  ]);
  await f.pool.query(
    "INSERT INTO access_team_members(team_id,principal_id,role) SELECT namespace_id,$2,'member' FROM access_spaces WHERE workspace_id=$1",
    [f.workspaceId, principal],
  );
  for (const [kind, id] of [
    ["page", "topic"],
    ["source", source.id],
  ])
    await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
      f.workspaceId,
      kind,
      id,
      principal,
    ]);
  await f.pool.query(
    "INSERT INTO access_shares(id,workspace_id,page_id,version,principal_id,actions,expires_at) VALUES($1,$2,'topic',1,$3,ARRAY['knowledge.read'],now()+interval '1 hour')",
    [principal, f.workspaceId, principal],
  );
  const share = {
    workspaceId: f.workspaceId,
    principalId: principal,
    authorization: f.ctx.authorization,
  };
  await f.tx((db) =>
    assertFeature(db, share, "sharing", {
      kind: "page",
      id: "topic",
      version: 1,
    }),
  );
  await expect(
    f.tx((db) => assertFeature(db, share, "sharing")),
  ).rejects.toThrow();
  await f.tx((db) => setFeature(db, f.admin, "sharing", false, 0));
  await expect(
    f.tx((db) =>
      assertFeature(db, share, "sharing", {
        kind: "page",
        id: "topic",
        version: 1,
      }),
    ),
  ).rejects.toThrow("FEATURE_DISABLED");
  expect(featureForMcpOperation("wiki_cancel_job")).toBeNull();
  expect(featureForMcpOperation("knowledge_import_cancel")).toBeNull();
  expect(featureForRoute("POST", "/api/v1/import-runs/run/cancel")).toBeNull();
});
test("private raw organize sends zero without explicit current-input approval, then works and invalidates after selection changes", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO imports(workspace_id,id,principal_id,title,selection,parsed,request_key,request_hash) VALUES($1,'private-import','editor','fixture','{}',$2,'fixture-key','fixture-hash')",
    [f.workspaceId, { records: [{ id: "r1", text: "private synthetic raw" }] }],
  );
  const envelope = {
    pageIds: [],
    sourceIds: [],
    pages: {},
    sources: {},
    acl: {},
  };
  const ref = { importId: "private-import", inputRevision: 1 };
  const send = async () => {
    const binding = await bindPrivateImportTransmission(
      f.pool,
      f.ctx,
      ref,
      envelope,
    );
    await callModel(
      "organize",
      { records: [{ id: "r1", text: "private synthetic raw" }] },
      binding.options,
    );
    await f.tx((db) => binding.recheck(db));
  };
  await expect(send()).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.calls()).toBe(0);
  const d = (
    await f.pool.query(
      "SELECT fingerprint FROM model_destinations WHERE id='fixture'",
    )
  ).rows[0];
  await f.tx((db) =>
    setPrivateImportPolicy(db, f.ctx, {
      importId: ref.importId,
      expectedRevision: 0,
      expectedImportRevision: 1,
      classification: "local-fixture",
      grants: [
        {
          destinationId: "fixture",
          purpose: "organize",
          fingerprint: d.fingerprint,
        },
      ],
      impactAcknowledged: true,
    }),
  );
  await send();
  expect(f.calls()).toBe(1);
  await f.pool.query(
    "UPDATE imports SET selection=$2 WHERE workspace_id=$1 AND id='private-import'",
    [f.workspaceId, { changed: true }],
  );
  await expect(send()).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.calls()).toBe(1);
});
test("trusted registry strictly rejects unknown properties, prototype IDs and malformed purposes before DB updates", async () => {
  const f = await setup();
  const valid = {
    id: "fixture",
    url: f.base + "/chat/completions",
    purposes: ["query"],
    classifications: ["local-fixture"],
    active: true,
  };
  for (const entry of [
    { ...valid, id: "constructor" },
    { ...valid, purposes: ["unknown"] },
    { ...valid, classifications: [] },
    { ...valid, principalId: "editor" },
    { ...valid, active: "true" },
  ])
    await expect(
      registerTrustedDestinations(f.pool, [entry]),
    ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT active FROM model_destinations WHERE id='fixture'",
      )
    ).rows[0].active,
  ).toBe(true);
});
test("actual runtime queue worker sends zero for source denial and still permits cancellation with feature disabled", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES('queue-policy-fixture','queue-no-secret','editor',$1,ARRAY['knowledge.read'],now()+interval '1 hour')",
    [f.workspaceId],
  );
  const pat = { ...f.editor, credentialId: "queue-policy-fixture" };
  const bridge = createRuntimeJobs(f.pool, f.runtime, { workerCount: 1 });
  cleanup.push(() => bridge.stop());
  const job = await bridge.submitInteractive(
    pat,
    "query",
    { question: "기존", mode: "model" },
    "policy-denied-job",
  );
  expect(await bridge.worker.tick()).toBe(true);
  expect(f.calls()).toBe(0);
  expect((await bridge.read(pat, job.id)).status).not.toBe("succeeded");
  const queued = await bridge.submitInteractive(
    pat,
    "query",
    { question: "기존", mode: "offline" },
    "queued-before-disable",
  );
  await f.tx((db) => setFeature(db, f.admin, "query", false, 0));
  await bridge.cancel(pat, queued.id);
  await expect(
    bridge.submitInteractive(
      pat,
      "query",
      { question: "기존", mode: "model" },
      "disabled-policy-job",
    ),
  ).rejects.toThrow("FEATURE_DISABLED");
  expect(f.calls()).toBe(0);
});
test("trusted historical query context retains all source restrictions and writes turn callback atomically with answer", async () => {
  const f = await setup();
  await f.approve();
  const historySource = {
    ...source,
    id: "history-source",
    content: "synthetic historical context",
  };
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'source','history-source')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,'history-source',$2)",
    [f.workspaceId, historySource],
  );
  for (const principal of ["editor", "fixture-owner"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','history-source',$2)",
      [f.workspaceId, principal],
    );
  const envelope = await f.tx(async (db) =>
    captureEnvelope(
      db,
      f.ctx,
      await loadState(db, f.workspaceId),
      [],
      ["history-source"],
    ),
  );
  let callbacks = 0;
  const context = {
    messages: [
      {
        role: "assistant" as const,
        content: historySource.content,
        turnId: "historical-turn",
      },
    ],
    inputEnvelope: envelope,
    contextFingerprint: "fixture-pinned-context",
    recheck: async () => {},
    onAnswerPersist: async () => {
      callbacks++;
    },
  };
  await expect(
    f.runtime.query(f.ctx, "기존", "model", undefined, context),
  ).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(f.calls()).toBe(0);
  const d = (
    await f.pool.query(
      "SELECT fingerprint FROM model_destinations WHERE id='fixture'",
    )
  ).rows[0];
  await f.tx((db) =>
    setSourcePolicy(db, f.admin, {
      sourceId: "history-source",
      expectedRevision: 0,
      classification: "local-fixture",
      grants: [
        {
          destinationId: "fixture",
          purpose: "query",
          fingerprint: d.fingerprint,
        },
      ],
      impactAcknowledged: true,
    }),
  );
  await expect(
    f.runtime.query(f.ctx, "기존", "model", undefined, {
      ...context,
      onAnswerPersist: async () => {
        throw Error("TURN_RACE");
      },
    }),
  ).rejects.toThrow("TURN_RACE");
  expect(
    (
      await f.pool.query(
        "SELECT * FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  const answer = await f.runtime.query(
    f.ctx,
    "기존",
    "model",
    undefined,
    context,
  );
  expect(callbacks).toBe(1);
  const stored = (
    await f.pool.query(
      "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, answer.id],
    )
  ).rows[0].data;
  expect(stored.inputEnvelope.sourceIds).toEqual(["history-source", source.id]);
  const body = f.bodies.at(-1)!;
  const messages = body.messages as { role: string; content: string }[];
  expect(JSON.parse(messages[1].content).history[0]).toEqual(
    context.messages[0],
  );
  expect(messages[0].role).toBe("system");
});
test("thread jobs are rejected when their trusted adapter is not configured", async () => {
  const f = await setup();
  const bridge = createRuntimeJobs(f.pool, f.runtime, { workerCount: 1 });
  cleanup.push(() => bridge.stop());
  await expect(
    bridge.submitInteractive(
      f.ctx,
      "query",
      { threadId: "thread", turnId: "turn" },
      "unconfigured-thread",
    ),
  ).rejects.toThrow("QUESTION_JOBS_NOT_CONFIGURED");
  expect(f.calls()).toBe(0);
});
