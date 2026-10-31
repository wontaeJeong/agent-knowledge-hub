import { afterEach, test, expect, vi } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fixture, adoptLegacyFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { ImportService } from "./service";
import { defaultSelection } from "../../src/domain/imports";
import { transaction } from "../database";
import { registerTrustedDestinations, setSourcePolicy } from "../policy/model";
import { setPrivateImportPolicy } from "../policy/imports";
import { hash } from "./parser";
// Real HTTP extraction and PostgreSQL policy/accounting can exceed the default 5s on shared runners.
vi.setConfig({ testTimeout: 30000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});
async function setup(
  options: {
    records?: number;
    unknown?: boolean;
    during?: () => Promise<void>;
  } = {},
) {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await adoptLegacyFixture(f.pool, f.workspaceId);
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const p of req) raw += p;
    const request = JSON.parse(raw),
      context = JSON.parse(request.messages[1].content);
    requests++;
    await options.during?.();
    let output;
    if (context.phase === "extract")
      output = {
        topics: [
          {
            key: "topic",
            title: "fixture candidate",
            summary: "not independent execution evidence",
            content: "fixture proposed knowledge",
            targetPageId: null,
            relatedPageIds: [],
            statements: context.records.map(
              (r: { id: string; text: string }) => ({
                kind: "statement",
                text: r.text,
                context: "synthetic fixture",
                recordId: r.id,
                quote: r.text,
              }),
            ),
          },
        ],
        excluded: [],
      };
    else
      output = {
        topics: [
          {
            key: "topic",
            title: "combined fixture",
            summary: "fixture",
            content: "combined fixture proposed knowledge",
            targetPageId: null,
            relatedPageIds: [],
            candidateIds: context.candidates.map((c: { id: string }) => c.id),
          },
        ],
        excludedCandidates: [],
      };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...(options.unknown
          ? {}
          : {
              model: "served-model",
              provider: "served-provider",
              usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0005 },
            }),
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(output) },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", base);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "requested-alias");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "imports-fixture");
  await registerTrustedDestinations(f.pool, [
    {
      id: "imports-fixture",
      url: base + "/chat/completions",
      purposes: ["organize"],
      classifications: ["local-fixture"],
      active: true,
    },
  ]);
  const sessionId = hash(randomUUID());
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','local-fixture-csrf','editor','local-fixture-no-idp-token',clock_timestamp()+interval '1 hour')",
    [sessionId, f.workspaceId],
  );
  const assertFixtureSession = async (
    db: Pick<import("pg").PoolClient, "query">,
  ) => {
    if (
      !(
        await db.query(
          "SELECT 1 FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human' WHERE s.id=$1 AND s.workspace_id=$2 AND s.principal_id='editor' AND s.expires_at>clock_timestamp()",
          [sessionId, f.workspaceId],
        )
      ).rowCount
    )
      throw Error("UNAUTHENTICATED");
  };
  const ctx = {
      ...f.editor,
      authorization: {
        sessionId,
        revalidate: async () => assertFixtureSession(f.pool),
        assertSession: assertFixtureSession,
      },
    },
    runtime = new RuntimeService(f.pool),
    imports = new ImportService(f.pool, runtime),
    bytes = Buffer.from(
      Array.from(
        { length: options.records ?? 2 },
        (_, i) => `[2026-10-19 10:00] A: synthetic record ${i}`,
      ).join("\n"),
    );
  // Explicit local fixture delegation binds the SAME original session; canonical permissions
  // are still checked by the production guard, policy binder and workspace transactions.
  imports.authorizer = async (row) => {
    if (
      row.workspace_id !== ctx.workspaceId ||
      row.principal_id !== ctx.principalId ||
      row.session_id !== sessionId
    )
      throw Error("UNAUTHENTICATED");
    await ctx.authorization.revalidate();
    return ctx;
  };
  const item = await imports.create(
    ctx,
    {
      title: "telemetry fixture",
      files: [
        {
          id: "file",
          name: "chat.txt",
          size: bytes.length,
          sha256: hash(bytes),
        },
      ],
    },
    randomUUID(),
  );
  await imports.uploadPart(ctx, item.id, "file", 0, {
    data: bytes.toString("base64"),
    sha256: hash(bytes),
  });
  await imports.finalize(ctx, item.id, randomUUID());
  await imports.tick();
  let view = await imports.view(ctx, item.id);
  await imports.select(ctx, item.id, view.revision, {
    ...view.selection,
    acknowledgeWarnings: true,
  });
  view = await imports.view(ctx, item.id);
  const approve = async () => {
    const d = (
      await f.pool.query(
        "SELECT fingerprint FROM model_destinations WHERE id='imports-fixture'",
      )
    ).rows[0];
    await transaction(f.pool, f.workspaceId, (db) =>
      setSourcePolicy(db, ctx, {
        sourceId: "source-a",
        expectedRevision: 0,
        classification: "local-fixture",
        grants: [
          {
            destinationId: "imports-fixture",
            purpose: "organize",
            fingerprint: d.fingerprint,
          },
        ],
        impactAcknowledged: true,
      }),
    );
    await transaction(f.pool, f.workspaceId, (db) =>
      setPrivateImportPolicy(db, ctx, {
        importId: item.id,
        expectedRevision: 0,
        expectedImportRevision: view.revision,
        classification: "local-fixture",
        grants: [
          {
            destinationId: "imports-fixture",
            purpose: "organize",
            fingerprint: d.fingerprint,
          },
        ],
        impactAcknowledged: true,
      }),
    );
  };
  const start = () =>
    imports.start(
      ctx,
      item.id,
      { revision: view.revision, mode: "model" },
      randomUUID(),
    );
  return {
    ...f,
    ctx,
    imports,
    item,
    view,
    approve,
    start,
    requests: () => requests,
  };
}
test("actual HTTP extraction + final calls reserve shared budget and store returned model/usage, never the alias as actual", async () => {
  const f = await setup({ records: 51 });
  await f.approve();
  const run = await f.start();
  await f.imports.tick();
  expect((await f.imports.runViewFor(f.ctx, run.id)).status).toBe(
    "review_ready",
  );
  expect(f.requests()).toBe(3);
  const rows = (
    await f.pool.query(
      "SELECT * FROM import_model_calls WHERE workspace_id=$1 AND run_id=$2 ORDER BY call_index",
      [f.workspaceId, run.id],
    )
  ).rows;
  expect(rows.map((r) => r.phase)).toEqual([
    "extract",
    "extract",
    "consolidate",
  ]);
  expect(
    rows.every(
      (r) =>
        r.requested_model === "requested-alias" &&
        r.actual_model === "served-model",
    ),
  ).toBe(true);
  expect(
    rows.every(
      (r) =>
        r.input_tokens === "7" &&
        r.output_tokens === "3" &&
        r.cost_micros === "500" &&
        r.tokens_settled &&
        r.cost_settled,
    ),
  ).toBe(true);
  expect(new Set(rows.map((r) => r.input_hash)).size).toBe(3);
  expect(new Set(rows.map((r) => r.private_input_hash)).size).toBe(1);
  const budget = (
    await f.pool.query(
      "SELECT * FROM durable_budget_days WHERE workspace_id=$1 AND principal_id='*'",
      [f.workspaceId],
    )
  ).rows[0];
  expect(Number(budget.tokens_reserved)).toBe(0);
  expect(Number(budget.tokens_charged)).toBe(30);
  expect(Number(budget.cost_charged)).toBe(1500);
});
test("missing response usage/model remain null and conservatively reserved, not zero or requested alias", async () => {
  const f = await setup({ unknown: true });
  await f.approve();
  const run = await f.start();
  await f.imports.tick();
  const row = (
    await f.pool.query(
      "SELECT * FROM import_model_calls WHERE workspace_id=$1 AND run_id=$2",
      [f.workspaceId, run.id],
    )
  ).rows[0];
  expect(row.actual_model).toBe(null);
  expect(row.input_tokens).toBe(null);
  expect(row.output_tokens).toBe(null);
  expect(row.cost_micros).toBe(null);
  expect(row.tokens_settled).toBe(false);
  expect(
    Number(
      (
        await f.pool.query(
          "SELECT tokens_reserved FROM durable_budget_days WHERE workspace_id=$1 AND principal_id='*'",
          [f.workspaceId],
        )
      ).rows[0].tokens_reserved,
    ),
  ).toBeGreaterThan(0);
});
test("private root default DENY produces no request despite global transmission flag; missing model keeps its actual error", async () => {
  const f = await setup(),
    run = await f.start();
  await f.imports.tick();
  expect((await f.imports.runViewFor(f.ctx, run.id)).errorCode).toBe(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(f.requests()).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM import_model_calls WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "false");
  const next = await f.start();
  await f.imports.tick();
  expect((await f.imports.runViewFor(f.ctx, next.id)).errorCode).toBe(
    "MODEL_NOT_CONFIGURED",
  );
  expect(f.requests()).toBe(0);
});
test("other-producer workspace AND principal daily reservations intersect imports before any provider request", async () => {
  for (const scope of ["*", "editor"]) {
    const f = await setup();
    await f.approve();
    await f.pool.query(
      "INSERT INTO durable_budget_days(workspace_id,principal_id,day,tokens_reserved) VALUES($1,$2,current_date,99999)",
      [f.workspaceId, scope],
    );
    const run = await f.start();
    await f.imports.tick();
    expect((await f.imports.runViewFor(f.ctx, run.id)).errorCode).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(f.requests()).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM import_model_calls WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  }
});
test("cancellation while actual provider is in flight preserves known usage/cost but rejects all result effects", async () => {
  let entered!: () => void, release!: () => void;
  const received = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r)),
    f = await setup({
      during: async () => {
        entered();
        await gate;
      },
    });
  await f.approve();
  const run = await f.start(),
    tick = f.imports.tick();
  await received;
  await f.imports.cancel(f.ctx, run.id);
  release();
  await tick;
  const view = await f.imports.runViewFor(f.ctx, run.id);
  expect(view.status).toBe("cancelled");
  expect(view.result).toBe(null);
  const row = (
    await f.pool.query(
      "SELECT * FROM import_model_calls WHERE workspace_id=$1 AND run_id=$2",
      [f.workspaceId, run.id],
    )
  ).rows[0];
  expect(row.actual_model).toBe("served-model");
  expect(row.cost_micros).toBe("500");
  expect(row.effect_error_code).toBe("IMPORT_CANCELLED");
});
