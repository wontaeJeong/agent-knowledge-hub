import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, adoptFixture, source, page } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { AgentService } from "../agents/service";
import { RefinementService } from "../refinement/service";
import { authorizeInTransaction } from "../access/index";
import { digest } from "../publication";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { queryInput } from "../runtime/schema";
let f: Awaited<ReturnType<typeof fixture>>;
let runtime: RuntimeService, inputs: any[];
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  inputs = [];
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_BASE_URL", "http://127.0.0.1:4444/v1");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_MODEL", "synthetic");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION", "true");
  vi.stubEnv("AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID", "scope-fixture");
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    "http://127.0.0.1:4444/v1/chat/completions",
    ["query"],
    "scope-fixture",
  );
  runtime = new RuntimeService(f.pool, async (_op, input) => {
    inputs.push(input);
    const p = (input as any).pages[0];
    return {
      content: "synthetic",
      insufficient: !p,
      citations: p
        ? [
            {
              pageId: p.id,
              title: p.title,
              version: p.version,
              quote: p.content,
            },
          ]
        : [],
    };
  });
});
afterEach(async () => {
  await f.pool.end();
  vi.unstubAllEnvs();
});
const actor = () => ({
  ...f.reader,
  authorization: { revalidate: async () => {}, assertSession: async () => {} },
});
const scoped = (scope: unknown) =>
  runtime.query(actor(), "기존", "model", undefined, undefined, scope as any);
test("query scope selects current topic and rejects malformed temporal ranges", async () => {
  expect(
    queryInput.parse({
      question: "기존",
      mode: "model",
      scope: { topic: page.category },
    }),
  ).toHaveProperty("scope.topic", page.category);
  await expect(scoped({ topic: "다른 주제" })).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(inputs).toEqual([]);
  expect(() =>
    queryInput.parse({
      question: "x",
      mode: "model",
      scope: {
        periodFrom: "2026-11-01T00:00:00Z",
        periodTo: "2026-10-01T00:00:00Z",
        historical: true,
      },
    }),
  ).toThrow();
});
test("historical query uses exact body and unknown metadata without today's topic or title", async () => {
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    {
      ...page.versions[0],
      id: "v2",
      number: 2,
      content: "기존 현재",
      at: "2026-11-01T00:00:00Z",
    },
  ]);
  const answer = await scoped({
    historical: true,
    periodFrom: "2026-10-29T00:00:00Z",
    periodTo: "2026-10-29T00:00:00Z",
  });
  expect(answer.citations[0]).toMatchObject({ version: 1, quote: "기존 내용" });
  expect(inputs[0].pages[0]).toMatchObject({
    version: 1,
    metadata: null,
    metadataStatus: "unknown",
    currentRecommendation: false,
  });
  expect(JSON.stringify(inputs[0])).not.toContain('"title":"주제"');
  await expect(
    scoped({ historical: true, topic: page.category }),
  ).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
  expect(inputs).toHaveLength(1);
});
test("actual query and agent context retain conditions exceptions and validity with conservative budgets", async () => {
  const r = new RefinementService(f.pool, authorizeInTransaction);
  await r.addEvidence(f.editor, {
    id: "ev",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: digest(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: "2026-10-29T00:00:00Z",
    verifiedAt: null,
    conditions: { os: "linux" },
  });
  await r.addClaim(f.editor, {
    id: "claim",
    pageId: "topic",
    pageVersion: 1,
    key: "retry",
    value: "재시도",
    kind: "claim",
    conditions: { os: "linux" },
    exceptions: ["영구 오류 제외"],
    assertedAt: "2026-10-29T00:00:00Z",
    validFrom: "2026-10-29T00:00:00Z",
    validTo: null,
    verifiedAt: null,
    evidenceIds: ["ev"],
    protected: false,
    uncertainty: "실행 검증 없음",
    supersedes: [],
  });
  await scoped({ environment: { os: "linux" } });
  expect(inputs[0].pages[0].claims.items[0]).toMatchObject({
    id: "claim",
    exceptions: ["영구 오류 제외"],
    conditions: { os: "linux" },
    validFrom: "2026-10-29T00:00:00Z",
    validation: "unverified",
  });
  const agents = new AgentService(f.pool, runtime, authorizeInTransaction);
  const result = await agents.context(f.reader, {
    task: "기존",
    token_budget: 16000,
    scope: { environment: { os: "linux" } },
  });
  expect(result.items[0]).toHaveProperty(
    "claims.items.0.exceptions.0",
    "영구 오류 제외",
  );
  const small = await agents.context(f.reader, {
    task: "기존",
    token_budget: 64,
  });
  expect(small.items).toEqual([]);
  expect(small.omitted[0].reason).toBe("budget");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(scoped({ environment: { os: "linux" } })).rejects.toThrow(
    "MODEL_TRANSMISSION_DENIED",
  );
  expect(inputs).toHaveLength(1);
  expect(
    (await agents.context(f.reader, { task: "기존", token_budget: 16000 }))
      .items,
  ).toEqual([]);
});
test("agent context retains legacy project and environment document filters", async () => {
  const agents = new AgentService(f.pool, runtime, authorizeInTransaction);
  expect(
    (
      await agents.context(f.reader, {
        task: "기존",
        token_budget: 16000,
        project: "unregistered",
      })
    ).items,
  ).toEqual([]);
  expect(
    (
      await agents.context(f.reader, {
        task: "기존",
        token_budget: 16000,
        environment: "unregistered",
      })
    ).items,
  ).toEqual([]);
});
test("unknown-time claims remain unknown and incompatible environments are excluded", async () => {
  const r = new RefinementService(f.pool, authorizeInTransaction);
  await r.addEvidence(f.editor, {
    id: "e",
    kind: "claim",
    sourceId: source.id,
    sourceVersion: digest(source),
    location: { start: 0, end: source.content.length, quote: source.content },
    parentIds: [],
    assertedAt: "2026-10-29T00:00:00Z",
    verifiedAt: null,
    conditions: { os: "linux" },
  });
  await r.addClaim(f.editor, {
    id: "c",
    pageId: "topic",
    pageVersion: 1,
    key: "retry",
    value: "retry",
    kind: "claim",
    conditions: { os: "linux" },
    exceptions: ["permanent errors"],
    assertedAt: "2026-10-29T00:00:00Z",
    validFrom: null,
    validTo: null,
    verifiedAt: null,
    evidenceIds: ["e"],
    protected: false,
    uncertainty: "unknown validity",
    supersedes: [],
  });
  await scoped({});
  expect(inputs[0].pages[0].claims.items[0]).toMatchObject({
    applicability: "unknown",
    missingConditions: ["os"],
    validFrom: null,
  });
  await scoped({ environment: { os: "windows" } });
  expect(inputs[1].pages[0].claims.items).toEqual([]);
});
test("documented historical metadata, rather than current topic or title, scopes actual provider input", async () => {
  const { transaction } = await import("../database"),
    { capturePublishedVersionMetadata } =
      await import("../workflows/versions/metadata");
  await transaction(f.pool, f.workspaceId, async (db) => {
    await db.query(
      "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='topic'",
      [f.workspaceId, { title: "기록된 과거 제목", category: "과거 주제" }],
    );
    await db.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
      f.workspaceId,
      {
        ...page.versions[0],
        id: "v2",
        number: 2,
        content: "기존 과거 발행",
        at: "2026-11-01T00:00:00Z",
      },
    ]);
    await capturePublishedVersionMetadata(db, f.editor, "topic", 2);
  });
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId, { title: "현재 변경 제목", category: "현재 주제" }],
  );
  await scoped({
    historical: true,
    topic: "과거 주제",
    periodFrom: "2026-11-01T00:00:00Z",
    periodTo: "2026-11-02T00:00:00Z",
  });
  expect(inputs[0].pages[0]).toMatchObject({
    version: 2,
    title: "기록된 과거 제목",
    metadataStatus: "known",
    metadata: { type: "과거 주제" },
    claims: { asOf: "2026-11-01T00:00:00.000Z" },
  });
  expect(JSON.stringify(inputs[0])).not.toContain("현재 변경 제목");
});
test("claims outside the selected source envelope never expand model or agent context", async () => {
  await runtime.core.registerSource(
    f.editor,
    {
      ...source,
      id: "extra",
      content: "outside-context-secret",
      targetPageId: "topic",
    },
    ["editor", "reviewer", "reader"],
  );
  const r = new RefinementService(f.pool, authorizeInTransaction),
    extra = {
      ...source,
      id: "extra",
      content: "outside-context-secret",
      targetPageId: "topic",
    };
  await r.addEvidence(f.editor, {
    id: "extra-e",
    kind: "claim",
    sourceId: "extra",
    sourceVersion: digest(extra),
    location: { start: 0, end: extra.content.length, quote: extra.content },
    parentIds: [],
    assertedAt: "2026-10-29T00:00:00Z",
    verifiedAt: null,
    conditions: {},
  });
  await r.addClaim(f.editor, {
    id: "extra-c",
    pageId: "topic",
    pageVersion: 1,
    key: "secret",
    value: "outside-context-secret",
    kind: "claim",
    conditions: {},
    exceptions: ["outside-context-exception"],
    assertedAt: "2026-10-29T00:00:00Z",
    validFrom: "2026-10-29T00:00:00Z",
    validTo: null,
    verifiedAt: null,
    evidenceIds: ["extra-e"],
    protected: false,
    uncertainty: "unverified",
    supersedes: [],
  });
  await scoped({});
  expect(JSON.stringify(inputs[0])).not.toContain("outside-context");
  const agents = new AgentService(f.pool, runtime, authorizeInTransaction);
  expect(
    JSON.stringify(
      await agents.context(f.reader, { task: "기존", token_budget: 16000 }),
    ),
  ).not.toContain("outside-context");
});
test("claims atomically documented by the same publication remain available in historical context", async () => {
  await approveLocalTransmissionFixture(
    f.pool,
    f.workspaceId,
    "http://127.0.0.1:4444/v1/chat/completions",
    ["query", "ingest"],
    "scope-fixture",
  );
  const ingest = new RuntimeService(f.pool, async () => ({
    updates: [
      {
        id: "topic",
        title: page.title,
        summary: page.summary,
        scope: "team",
        content: "기존 발행된 예외",
        links: [],
        facts: [],
        sourceIds: [source.id],
        baseVersion: 1,
      },
    ],
    candidates: [
      {
        pageId: "topic",
        key: "retry",
        value: "retry",
        kind: "claim",
        conditions: { os: "linux" },
        exceptions: ["permanent errors"],
        validFrom: "2026-10-29T00:00:00Z",
        validTo: null,
        uncertainty: "unverified",
        sourceId: source.id,
        quote: "실패 시 재시도한다.",
      },
    ],
  }));
  const b = await ingest.ingest(
    { ...f.editor, authorization: actor().authorization },
    [source.id],
    "model",
  );
  if ("noChanges" in b) throw Error("expected proposal");
  await ingest.core.approve(f.ctx, b.id, b.hash);
  await ingest.core.publish(f.ctx, b.id, b.hash, "scope-historical-publish");
  await scoped({ historical: true, environment: { os: "linux" } });
  expect(
    inputs[0].pages.find((p: any) => p.version === 2).claims.items[0],
  ).toMatchObject({
    exceptions: ["permanent errors"],
    applicability: "conditions-match-valid-at-requested-time",
    validation: "unverified",
  });
});
