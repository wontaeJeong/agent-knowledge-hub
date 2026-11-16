import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { AgentService } from "./service";
import { membership } from "../repository";
import { ScopedSearch } from "../questions/search";
let f: Awaited<ReturnType<typeof fixture>>,
  runtime: RuntimeService,
  agents: AgentService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  runtime = new RuntimeService(f.pool);
  agents = new AgentService(f.pool, runtime, async (db, ctx) => {
    await membership(db, ctx);
  });
});
afterEach(async () => {
  await f?.pool.end();
});
test("an active replacement is excluded from agent search and context and read reports nonrecommendation", async () => {
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','active',$2)",
    [f.workspaceId, { replacementId: "successor" }],
  );
  expect((await agents.search(f.reader, { query: "기존 내용" })).items).toEqual(
    [],
  );
  expect(
    (await agents.context(f.reader, { task: "기존 내용", token_budget: 10000 }))
      .items,
  ).toEqual([]);
  expect(await agents.read(f.reader, { page_id: "topic" })).toMatchObject({
    conditions: { currentRecommendation: false },
  });
});
test("scoped search defaults to current recommendations but explicit archived filter can inspect current snapshots", async () => {
  const search = new ScopedSearch(f.pool, {
    runtime,
    authorize: async () => {},
  });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','archived','{}')",
    [f.workspaceId],
  );
  expect((await search.search(f.reader, { query: "기존" })).items).toEqual([]);
  expect(
    (await search.search(f.reader, { query: "기존", archived: true })).items,
  ).toHaveLength(1);
});
test("agent search applies strict metadata filters and returns historical bodies without current title fallback", async () => {
  await f.pool.query(
    "UPDATE pages SET data=data||$2::jsonb WHERE workspace_id=$1",
    [f.workspaceId, { title: "현재 제목", tags: ["postgres"] }],
  );
  const second = {
    ...page.versions[0],
    id: "v2",
    number: 2,
    content: "현재 본문",
    at: "2026-11-01T00:00:00Z",
  };
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    second,
  ]);
  expect(
    (await agents.search(f.reader, { query: "현재", project: "missing" }))
      .items,
  ).toEqual([]);
  expect(
    (await agents.search(f.reader, { query: "현재", tags: ["missing"] })).items,
  ).toEqual([]);
  const result = await agents.search(f.reader, {
    query: "기존",
    include_history: true,
  });
  expect(result.items).toMatchObject([
    {
      id: "topic",
      version: 1,
      title: null,
      historical: true,
      conditions: { currentRecommendation: false },
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("현재 제목");
});
test("agent search authorizes every page and source against the credential ceiling", async () => {
  const scoped = new AgentService(
    f.pool,
    runtime,
    async (db, ctx, _action, resource) => {
      await membership(db, ctx);
      if (resource?.kind === "source") throw Error("FORBIDDEN");
    },
  );
  expect((await scoped.search(f.reader, { query: "기존" })).items).toEqual([]);
});
test("agent cursor survives repeated calls but rejects changed filters and revoked source access", async () => {
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    {
      ...page.versions[0],
      id: "v2",
      number: 2,
      content: "기존 두번째",
      at: "2026-11-01T00:00:00Z",
    },
  ]);
  const q = { query: "기존", include_history: true, limit: 1 };
  const first = await agents.search(f.reader, q);
  expect(first.nextCursor).toEqual(expect.any(String));
  const next = await agents.search(f.reader, {
    ...q,
    cursor: first.nextCursor,
  });
  expect(next.items[0].version).toBe(1);
  await expect(
    agents.search(f.reader, {
      ...q,
      query: "두번째",
      cursor: first.nextCursor,
    }),
  ).rejects.toThrow("STALE_CURSOR");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    agents.search(f.reader, { ...q, cursor: first.nextCursor }),
  ).rejects.toThrow("STALE_CURSOR");
});
