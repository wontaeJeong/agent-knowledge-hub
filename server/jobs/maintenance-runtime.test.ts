import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { maintenanceWindow } from "../refinement/maintenance";
import { fixture, adoptFixture, page, source } from "../test-support";
import { AccessService, authorizeInTransaction } from "../access/index";
import { RefinementService } from "../refinement/service";
import { claim as storedClaim } from "../refinement/fixtures";
import { digest } from "../publication";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeJobs } from "./runtime";
const pools: Pool[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  vi.unstubAllEnvs();
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool),
    owner = { ...f.editor, principalId: "fixture-owner" };
  const svc = await access.createServicePrincipal(owner, {
    name: "maintenance",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  await f.pool.query(
    "UPDATE access_grants SET role='write' WHERE workspace_id=$1 AND principal_id=$2",
    [f.workspaceId, svc.id],
  );
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,$2 FROM resources WHERE workspace_id=$1",
    [f.workspaceId, svc.id],
  );
  const credential = await access.issueServiceCredential(owner, svc.id, {
    actions: ["knowledge.read", "changeset.propose", "lint.run"],
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
  });
  const identity = {
    workspaceId: f.workspaceId,
    principalId: svc.id,
    credentialId: credential.id,
  };
  const runtime = new RuntimeService(f.pool);
  const bridge = createRuntimeJobs(f.pool, runtime, {
    workerCount: 1,
    directoryProviderId: "fixture-roster",
    directoryStatus: async (subject) => ({
      ...subject,
      active: true,
      verifiedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 10000).toISOString(),
    }),
  });
  const schedule = async (kind: string, extra: Record<string, unknown> = {}) =>
    bridge.jobs.saveSchedule(f.ctx, {
      key: kind,
      cadence: kind,
      time: "09:00",
      timezone: "UTC",
      holidays: [],
      ...(kind === "weekly"
        ? { weekday: 1 }
        : { dayOfMonth: 31, invalidDay: "clamp" }),
      catchup: "latest",
      identity,
      job: {
        kind,
        payload: { mode: "offline" },
        pageIds: ["topic"],
        sourceIds: ["source-a"],
        reservation: { tokens: 0, costMicros: 0 },
        timeoutMs: 60000,
        maxAttempts: 1,
        ...extra,
      },
      approvedPageIds: ["topic"],
      approvedSourceIds: ["source-a"],
    });
  const run = async (kind: string, extra: Record<string, unknown> = {}) => {
    const s = await schedule(kind, extra);
    const j = await bridge.jobs.runSchedule(f.ctx, s.id, "once");
    await bridge.worker.tick();
    return (
      await f.pool.query(
        "SELECT status,result,error_code FROM durable_jobs WHERE id=$1",
        [j.id],
      )
    ).rows[0];
  };
  return { ...f, identity, bridge, runtime, schedule, run };
}
it("weekly inspects published processed knowledge and returns typed structural candidates without daily ingestion", async () => {
  const f = await setup();
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{processed}','true') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const result = await f.run("weekly");
  expect(result.status).toBe("succeeded");
  expect(result.result.cadence).toBe("weekly");
  expect(result.result.engine).toBe("structural");
  expect(result.result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "connection-gap", pageIds: ["topic"] }),
    ]),
  );
  expect(result.result.humanReviewRequired).toBe(true);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("monthly proposes ownership retention and measured cost review without changing policy or owners", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms,input_tokens,output_tokens,cost_usd,at) VALUES($1,'other-human','query','litellm','unknown','private-model',true,1,12,3,0.02,date_trunc('month',now())-interval '15 days')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms,input_tokens,output_tokens,cost_usd,at) VALUES($1,$2,'ingest','litellm','unknown','recorded',true,1,8,2,0.03,date_trunc('month',now())-interval '15 days')",
    [f.workspaceId, f.identity.principalId],
  );
  const result = await f.run("monthly");
  expect(result.status).toBe("succeeded");
  expect(result.result.cadence).toBe("monthly");
  expect(result.result.proposals.map((p: any) => p.kind)).toEqual([
    "ownership-review",
    "retention-review",
    "cost-review",
  ]);
  expect(result.result.proposals[0].pages[0]).toMatchObject({
    pageId: "topic",
    owner: null,
    status: "unknown",
  });
  expect(result.result.proposals[2].usage).toMatchObject({
    calls: 1,
    knownCostUsd: 0.03,
    unknownCostCalls: 0,
  });
  expect(result.result.proposals[2].trend).toMatchObject({
    previous: { calls: 0, knownCostUsd: 0 },
    knownCostDeltaUsd: 0.03,
    status: "complete-measurement",
  });
  expect(result.result.proposals[1].classifications).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pageId: "topic",
        category: page.category,
        scope: "team",
      }),
    ]),
  );
  expect(JSON.stringify(result.result)).not.toContain("other-human");
  expect(JSON.stringify(result.result)).not.toContain("private-model");
  expect(
    (
      await f.pool.query("SELECT data FROM pages WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rows[0].data.owner,
  ).toBe(page.owner);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM content_retention_policies WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});

async function addPage(f: Awaited<ReturnType<typeof setup>>) {
  const { versions, ...metadata } = page;
  await f.pool.query("INSERT INTO resources VALUES($1,'page','topic-two')", [
    f.workspaceId,
  ]);
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'topic-two',$2)",
    [f.workspaceId, { ...metadata, id: "topic-two", title: "두 번째 주제" }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'topic-two',1,$2)", [
    f.workspaceId,
    { ...versions[0], id: "v-two", content: "다른 기존 내용" },
  ]);
  for (const actor of ["editor", "reviewer", "reader", f.identity.principalId])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','topic-two',$2)",
      [f.workspaceId, actor],
    );
}
async function model(
  f: Awaited<ReturnType<typeof setup>>,
  beforeReply?: () => Promise<void>,
) {
  let calls = 0,
    input: any,
    system = "";
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    calls++;
    input = JSON.parse(request.messages[1].content);
    system = request.messages[0].content;
    await beforeReply?.();
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "actual-weekly-model",
        usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                reason: "Review a connected topic across existing documents.",
                updates: input.pages.map((p: any) => ({
                  id: p.id,
                  title: p.title,
                  summary: "검토 제안",
                  content: p.content + "\n주간 종합 제안",
                  scope: p.scope,
                  baseVersion: p.baseVersion,
                  links: input.pages
                    .filter((q: any) => q.id !== p.id)
                    .map((q: any) => q.id),
                  sourceIds: ["source-a"],
                  facts: [],
                })),
              }),
            },
          },
        ],
      }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "requested-weekly-model");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "openai");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "maintenance-fixture");
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    base + "/chat/completions",
    ["ingest"],
    "maintenance-fixture",
  );
  return { calls: () => calls, input: () => input, system: () => system };
}
const modelJob = {
  payload: { mode: "model" },
  model: "requested-weekly-model",
  pageIds: ["topic", "topic-two"],
  reservation: { tokens: 70000, costMicros: 100000 },
};
it("weekly actual configured model proposes multiple version-bound documents then independent human publishes atomically", async () => {
  const f = await setup();
  await addPage(f);
  const m = await model(f);
  // Approved page ceiling must cover every transmitted page.
  const s = await f.bridge.jobs.saveSchedule(f.ctx, {
    key: "model-weekly",
    cadence: "weekly",
    weekday: 1,
    time: "09:00",
    timezone: "Asia/Seoul",
    holidays: [],
    catchup: "latest",
    identity: f.identity,
    job: {
      kind: "weekly",
      sourceIds: ["source-a"],
      timeoutMs: 60000,
      maxAttempts: 3,
      ...modelJob,
    },
    approvedPageIds: ["topic", "topic-two"],
    approvedSourceIds: ["source-a"],
  });
  const j = await f.bridge.jobs.runSchedule(f.ctx, s.id, "once");
  await f.bridge.worker.tick();
  const row = (
    await f.pool.query(
      "SELECT status,result,error_code FROM durable_jobs WHERE id=$1",
      [j.id],
    )
  ).rows[0];
  expect(row.status, JSON.stringify(row)).toBe("succeeded");
  expect(m.calls()).toBe(1);
  expect(m.system()).toContain("WEEKLY knowledge maintenance");
  expect(m.input().phase).toBe("weekly-maintenance");
  expect(m.input().pages).toHaveLength(2);
  expect(m.input().window.timezone).toBe("Asia/Seoul");
  expect(row.result.input).toEqual(m.input());
  expect(row.result.engine).toBe("model");
  const b = (
    await f.pool.query(
      "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, row.result.proposal.id],
    )
  ).rows[0].data;
  expect(b.updates).toHaveLength(2);
  expect(b.updates.map((d: any) => d.baseVersion)).toEqual([1, 1]);
  expect(b.status).toBe("pending");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM versions WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(2);
  await expect(
    f.runtime.core.approve(
      f.identity,
      row.result.proposal.id,
      row.result.proposal.hash,
    ),
  ).rejects.toThrow();
  await f.runtime.core.approve(
    f.ctx,
    row.result.proposal.id,
    row.result.proposal.hash,
  );
  await f.runtime.core.publish(
    f.ctx,
    row.result.proposal.id,
    row.result.proposal.hash,
    "weekly-reviewed",
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM versions WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(4);
}, 15000);
it("weekly stale input during actual model transmission prevents proposal effects", async () => {
  const f = await setup();
  const m = await model(f, async () => {
    await f.pool.query(
      "UPDATE versions SET data=jsonb_set(data,'{content}','\"changed while model ran\"') WHERE workspace_id=$1",
      [f.workspaceId],
    );
  });
  const row = await f.run("weekly", { ...modelJob, pageIds: ["topic"] });
  expect(m.calls()).toBe(1);
  expect(row.status).toBe("dead");
  expect(row.error_code).toMatch(/STALE|POLICY/);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("weekly model cannot target a protected document and never falls back to fake structural success", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,revision,data) VALUES($1,'topic','active',1,'{\"protected\":true}')",
    [f.workspaceId],
  );
  const m = await model(f);
  const row = await f.run("weekly", { ...modelJob, pageIds: ["topic"] });
  expect(m.calls()).toBe(1);
  expect(row.status).toBe("dead");
  expect(row.error_code).toMatch(/PROTECTED|FORBIDDEN/);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("monthly and weekly windows use local calendar periods across DST rather than fixed hour subtraction", () => {
  expect(
    maintenanceWindow(
      "weekly",
      new Date("2026-03-09T14:00:00Z"),
      "America/New_York",
    ),
  ).toMatchObject({
    from: "2026-03-02T05:00:00.000Z",
    to: "2026-03-09T04:00:00.000Z",
  });
  expect(
    maintenanceWindow(
      "monthly",
      new Date("2026-11-17T14:00:00Z"),
      "Asia/Seoul",
    ),
  ).toMatchObject({
    from: "2026-09-30T15:00:00.000Z",
    to: "2026-10-31T15:00:00.000Z",
  });
});

it("weekly retry after proposal commit reuses the exact proposal and cached model response", async () => {
  const f = await setup();
  const m = await model(f);
  const original = f.bridge.jobs.commitEffect.bind(f.bridge.jobs);
  let interrupted = false;
  f.bridge.jobs.commitEffect = async (db, lease, stage, effect) => {
    if (stage === "weekly" && !interrupted) {
      interrupted = true;
      throw Object.assign(Error("connection interrupted"), {
        code: "ECONNRESET",
      });
    }
    return original(db, lease, stage, effect);
  };
  const s = await f.schedule("weekly", {
    ...modelJob,
    pageIds: ["topic"],
    maxAttempts: 3,
  });
  const j = await f.bridge.jobs.runSchedule(f.ctx, s.id, "retry");
  await f.bridge.worker.tick();
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await f.pool.query("UPDATE durable_jobs SET available_at=now() WHERE id=$1", [
    j.id,
  ]);
  await f.bridge.worker.tick();
  const row = (
    await f.pool.query(
      "SELECT status,result,error_code FROM durable_jobs WHERE id=$1",
      [j.id],
    )
  ).rows[0];
  expect(row.status, JSON.stringify(row)).toBe("succeeded");
  expect(m.calls()).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("weekly claim review preserves exact lineage, duplicate candidates, applicability and expired validity", async () => {
  const f = await setup(),
    refinement = new RefinementService(f.pool, authorizeInTransaction);
  await refinement.addEvidence(f.editor, {
    id: "e1",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: digest(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: storedClaim.assertedAt,
    verifiedAt: null,
    conditions: storedClaim.conditions,
  });
  const { recordedAt: _, recordedBy: __, ...claim } = storedClaim;
  await refinement.addClaim(f.editor, claim);
  await refinement.addClaim(f.editor, { ...claim, id: "c2" });
  const row = await f.run("weekly");
  expect(row.status).toBe("succeeded");
  expect(row.result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "duplicate-claim",
        claimIds: ["c1", "c2"],
      }),
      expect.objectContaining({ kind: "stale-review", claimIds: ["c1"] }),
    ]),
  );
  expect(row.result.input.claims[0]).toMatchObject({
    conditions: { os: "linux", version: "1" },
    exceptions: ["네트워크 단절 제외"],
    validTo: "2026-06-01T00:00:00Z",
    verification: "not-assessed",
    evidence: [
      expect.objectContaining({
        sourceId: "source-a",
        sourceVersion: digest(source),
        location: {
          start: 0,
          end: source.content.length,
          quote: source.content,
        },
      }),
    ],
  });
});
it("monthly unknown metering never becomes zero-cost trend or automatic policy mutation", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,succeeded,latency_ms,at) VALUES($1,$2,'query','openai','unknown','unknown-price',true,1,date_trunc('month',now())-interval '15 days')",
    [f.workspaceId, f.identity.principalId],
  );
  const row = await f.run("monthly");
  expect(row.status).toBe("succeeded");
  const cost = row.result.proposals.find((p: any) => p.kind === "cost-review");
  expect(cost.usage).toMatchObject({
    calls: 1,
    unknownCostCalls: 1,
    unknownTokenCalls: 1,
  });
  expect(cost.trend).toMatchObject({
    knownCostDeltaUsd: null,
    status: "incomplete-measurement",
  });
});
