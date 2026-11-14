import { test, expect, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { fixture, source, adoptFixture } from "../test-support";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import {
  createPolicyEvaluationAgent,
  assertEvaluationSnapshots,
} from "./policy-agent";
import { runPolicyBoundExperiment } from "./run";
// @ts-expect-error server-side JS evaluation modules have no TS declarations
import { runMaintenance } from "../../scripts/evaluation/maintenance.mjs";
// @ts-expect-error server-side JS evaluation modules have no TS declarations
import { evaluateEvolution } from "../../scripts/evaluation/evolution.mjs";
// @ts-expect-error server-side JS evaluation modules have no TS declarations
import { createRuntimeHttpDriver } from "../../scripts/evaluation/http-driver.mjs";
// @ts-expect-error server-side JS evaluation modules have no TS declarations
import { createUsageReader } from "../../scripts/evaluation/usage.mjs";
// @ts-expect-error existing server-side evaluation provider is JavaScript
import { createEvaluationAgent } from "../../scripts/evaluation/provider.mjs";

test("three actual HTTP model maintenance cycles create maintained snapshots and equal raw/static controls", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const sent: any[] = [];
  let revokeDuring = false;
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages[1].content);
    sent.push(input);
    let out;
    if (revokeDuring && input.task?.prompt)
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
        [f.workspaceId],
      );
    if (input.task?.prompt) {
      out = { answer: "yes", abstained: false, citations: [] };
    } else if (input.sources) {
      const page = input.pages.find((p: any) => p.id === "topic");
      const src = input.sources[0];
      out = page.content.includes(src.content)
        ? { updates: [], noChanges: true }
        : {
            updates: [
              {
                id: "topic",
                title: page.title,
                summary: page.summary,
                scope: "team",
                baseVersion: page.baseVersion,
                content: page.content + "\n" + src.content,
                links: page.links,
                facts: page.facts,
                sourceIds: [src.id],
              },
            ],
          };
    } else {
      const page = input.pages.find((p: any) => p.id === "topic");
      out = {
        content: "유지 점검",
        insufficient: false,
        citations: [
          {
            pageId: "topic",
            title: page.title,
            version: page.version,
            quote: page.content.slice(0, 4),
          },
        ],
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("x-litellm-response-cost", "0.01");
    res.end(
      JSON.stringify({
        model: "loopback",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: 0.01,
        },
        choices: [
          { finish_reason: "stop", message: { content: JSON.stringify(out) } },
        ],
      }),
    );
  });
  const idp = createServer((req, res) => {
    const user = req.headers.authorization?.includes("reviewer")
      ? "reviewer"
      : "editor";
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        sub: user,
        groups: [user === "reviewer" ? "reviewers" : "writers"],
      }),
    );
  });
  await Promise.all([
    new Promise<void>((r) => model.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => idp.listen(0, "127.0.0.1", r)),
  ]);
  const modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", modelBase);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "loopback");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_PROVIDER", "litellm");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "p10-fixture");
  const runtime = new RuntimeService(f.pool);
  for (const [id, content] of [
    ["source-b", "Linux 1.0 반증: 실패"],
    ["source-c", "Windows 1.0: 실패"],
  ])
    await runtime.core.registerSource(f.editor, { ...source, id, content }, [
      "editor",
      "reviewer",
      "reader",
    ]);
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    modelBase + "/chat/completions",
    ["query", "ingest"],
    "p10-fixture",
    ["source-a", "source-b", "source-c"],
  );
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const tokens: Record<string, string> = {};
  for (const who of ["editor", "reviewer"]) {
    const token = randomUUID();
    tokens[who] = token;
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf',$3,$3,now()+interval '1 hour')",
      [sessionHash(token), f.workspaceId, who],
    );
  }
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth: new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
        writers: "editor",
        reviewers: "reviewer",
      }),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = (who: string) => ({
    Cookie: `akh_session=${tokens[who]}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
  });
  try {
    const usage = createUsageReader({
      pool: f.pool,
      workspaceId: f.workspaceId,
      principalId: "editor",
      exclusiveWorkspace: true,
    });
    const driver = createRuntimeHttpDriver({
      baseUrl: base,
      editorHeaders: headers("editor"),
      reviewerHeaders: headers("reviewer"),
      review: async () => ({ decision: "approve", events: [] }),
      usage,
    });
    const stages = ["source-a", "source-b", "source-c"].map((id, i) => ({
      stage: i,
      sourceIds: [id],
      operationalQuestion: "기존",
    }));
    const heldout = [0, 1, 2].map((i) => ({
      id: `h${i}`,
      stage: i,
      family: "past",
      prompt: `비공개 평가 문제 ${i}`,
    }));
    const expected = {
      withheldMarker: "P10_EVALUATOR_SECRET",
      answers: heldout.map((t) => ({
        taskId: t.id,
        expectedAnswer: "yes",
        alternatives: [],
        requiresCitation: false,
      })),
    };
    const configEval = {
      model: "loopback",
      provider: "litellm",
      seed: 1,
      repeats: 1,
      budget: { calls: 1, maxTokens: 6000, timeoutMs: 60000 },
    };
    const oldPolicy = (
      await f.pool.query(
        "SELECT grants FROM model_source_policies WHERE workspace_id=$1 AND source_id='source-c'",
        [f.workspaceId],
      )
    ).rows[0].grants;
    await f.pool.query(
      "UPDATE model_source_policies SET grants='[]' WHERE workspace_id=$1 AND source_id='source-c'",
      [f.workspaceId],
    );
    await expect(
      runPolicyBoundExperiment({
        runtime,
        ctx: {
          ...f.editor,
          authorization: {
            revalidate: async () => {},
            assertSession: async () => {},
          },
        },
        driver,
        stages,
        heldout,
        expected,
        config: configEval,
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM versions WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("1");
    await f.pool.query(
      "UPDATE model_source_policies SET grants=$2 WHERE workspace_id=$1 AND source_id='source-c'",
      [f.workspaceId, JSON.stringify(oldPolicy)],
    );
    const experiment = await runPolicyBoundExperiment({
      runtime,
      ctx: {
        ...f.editor,
        authorization: {
          revalidate: async () => {},
          assertSession: async () => {},
        },
      },
      driver,
      stages,
      heldout,
      expected,
      config: configEval,
    });
    const maintained = experiment.maintenance;
    const report = experiment.evaluation;
    expect(maintained.status).toBe("completed");
    expect(maintained.snapshots.map((s: any) => s.wiki[0].version)).toEqual([
      2, 3, 4,
    ]);
    expect(maintained.snapshots[2].wiki[0].content).toContain("기존 내용");
    expect(maintained.snapshots[2].wiki[0].content).toContain("Linux 1.0 반증");
    expect(maintained.snapshots[2].wiki[0].content).toContain("Windows 1.0");
    expect(maintained.cycles.every((c: any) => c.reviewWorkMs === null)).toBe(
      true,
    );
    expect(maintained.cycles[1].usage.maintenanceCost).toBeCloseTo(0.01);
    expect(maintained.cycles[1].usage.queryCost).toBeCloseTo(0.01);
    expect(
      sent
        .filter((x) => !x.task?.prompt)
        .some((x) => JSON.stringify(x).includes("비공개 평가 문제")),
    ).toBe(false);
    const agent = createPolicyEvaluationAgent({
      runtime,
      ctx: {
        ...f.editor,
        authorization: {
          revalidate: async () => {},
          assertSession: async () => {},
        },
      },
    });
    expect(report.assigned).toBe(9);
    expect(report.completed).toBe(9);
    expect(report.benefit).toBe("미확인");
    expect(report.maintenanceCost).toBeCloseTo(0.03);
    expect(report.operationalQueryCost).toBeCloseTo(0.03);
    expect(report.evaluationCost).toBeCloseTo(0.09);
    expect(report.totalCost).toBeCloseTo(0.15);
    expect(report.conditions.maintained.regressionDenominator).toBe(2);
    expect(report.conditions.maintained.regressions).toBe(0);
    const evalInputs = sent.filter((x) => x.task?.prompt);
    expect(evalInputs).toHaveLength(9);
    expect(
      report.results
        .filter((x: any) => x.condition === "static")
        .map((x: any) => x.inputVersions.pages[0].version),
    ).toEqual([2, 2, 2]);
    expect(
      report.results
        .filter((x: any) => x.condition === "maintained")
        .map((x: any) => x.inputVersions.pages[0].version),
    ).toEqual([2, 3, 4]);
    expect(evalInputs.every((x) => !("condition" in x))).toBe(true);
    expect(
      evalInputs.every(
        (x) => !JSON.stringify(x).includes("P10_EVALUATOR_SECRET"),
      ),
    ).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM versions WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("4");
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM runtime_answers WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("3");
    await expect(
      runtime.ingest(
        {
          ...f.editor,
          authorization: {
            revalidate: async () => {},
            assertSession: async () => {},
          },
        },
        ["source-a"],
        "model",
      ),
    ).rejects.toThrow("NO_CHANGES");
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM versions WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows[0].count,
    ).toBe("4");
    const guardedInput = {
      task: heldout[0],
      condition: "raw",
      model: "loopback",
      seed: 1,
      budget: { calls: 1, maxTokens: 6000, timeoutMs: 60000 },
      sources: maintained.snapshots[0].sources,
      wiki: [],
      promptVersion: "eval/1",
      rulesVersion: "rules/1",
    };
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
      [f.workspaceId],
    );
    const before = sent.length;
    await expect(
      agent(guardedInput, { raw_lookup: async () => null }),
    ).rejects.toThrow();
    expect(sent.length).toBe(before);
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a','editor')",
      [f.workspaceId],
    );
    revokeDuring = true;
    await expect(
      agent(guardedInput, { raw_lookup: async () => null }),
    ).rejects.toThrow();
    expect(sent.length).toBe(before + 1);
    await expect(
      assertEvaluationSnapshots({
        runtime,
        ctx: {
          ...f.editor,
          authorization: {
            revalidate: async () => {},
            assertSession: async () => {},
          },
        },
        snapshots: maintained.snapshots,
      }),
    ).rejects.toThrow();
  } finally {
    await Promise.all(
      [server, model, idp].map(
        (s) => new Promise<void>((r) => s.close(() => r())),
      ),
    );
    await f.pool.end();
    vi.unstubAllEnvs();
  }
}, 30000);
