import { afterEach, expect, test, vi } from "vitest";
import type { Server } from "node:http";
import { fixture, adoptLegacyFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeJobs } from "../jobs/runtime";
import { browserIdentity } from "../jobs/fixtures/session";
vi.setConfig({ testTimeout: 30000 });
const pools: Awaited<ReturnType<typeof fixture>>[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await Promise.all(pools.splice(0).map((f) => f.pool.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f);
  await f.pool.query(
    "UPDATE access_principals SET active=true WHERE id='editor'",
  );
  await adoptLegacyFixture(f.pool, f.workspaceId);
  const browser = await browserIdentity(f.pool, f.editor, servers);
  const runtime = new RuntimeService(f.pool);
  const bridge = createRuntimeJobs(f.pool, runtime, {
    workerCount: 1,
    platformOperatorIds: ["editor"],
    ...browser.options,
  });
  return { ...f, browser, runtime, bridge };
}
test("native search index exists and is valid after the real migration", async () => {
  const f = await setup();
  const row = (
    await f.pool.query(
      "SELECT c.relname,i.indisvalid,i.indisready FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname='versions_content_trgm_idx' AND c.relnamespace='public'::regnamespace",
    )
  ).rows[0];
  expect(row).toMatchObject({
    relname: "versions_content_trgm_idx",
    indisvalid: true,
    indisready: true,
  });
});
test("a current platform operator and space Admin can admit a durable rebuild and replay without rebuilding twice", async () => {
  const f = await setup();
  const input = { action: "rebuild-search-index" };
  const first = await f.bridge.submitInteractive(
    f.browser.ctx,
    "index",
    input,
    "index-one",
  );
  expect(first).toMatchObject({ kind: "index", status: "queued" });
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, first.id)).toMatchObject({
    status: "succeeded",
    result: { rebuilt: true },
  });
  expect(
    await f.bridge.submitInteractive(
      f.browser.ctx,
      "index",
      input,
      "index-one",
    ),
  ).toMatchObject({ id: first.id, status: "succeeded" });
});

test("indexed canonical search preserves Korean/code and literal wildcard characters and rechecks current source ACL", async () => {
  const f = await setup();
  const { ScopedSearch } = await import("../questions/search");
  const { authorizeInTransaction } = await import("../access/index");
  const search = new ScopedSearch(f.pool, {
    runtime: f.runtime,
    authorize: authorizeInTransaction,
  });
  const text =
    "장애 복구 HTTP_429 key=value 100% a_b !literal path" +
    String.fromCharCode(92) +
    "name";
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, text],
  );
  for (const query of [
    "장애 복구",
    "HTTP_429",
    "http_429",
    "100%",
    "a_b",
    "!literal",
    String.fromCharCode(92) + "name",
  ])
    expect(
      (await search.search(f.reader, { query })).items.map((i) => i.pageId),
    ).toEqual(["topic"]);
  for (const query of ["HTTPX429", "100X", "aXb", "absent"])
    expect((await search.search(f.reader, { query })).items).toEqual([]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect((await search.search(f.reader, { query: "HTTP_429" })).items).toEqual(
    [],
  );
});
test("the real retrieval SQL uses the native GIN index for selective candidates", async () => {
  const f = await setup();
  const { CONTENT_MATCH_SQL, literalPattern } = await import("./query");
  await f.pool.query(
    "INSERT INTO versions SELECT $1,'topic',n,data||jsonb_build_object('id','bulk-'||n,'number',n,'content',CASE WHEN n=5000 THEN 'rare_retry_code_72931' ELSE 'ordinary unrelated fixture content '||n END) FROM versions CROSS JOIN generate_series(2,10001)n WHERE workspace_id=$1 AND page_id='topic' AND number=1",
    [f.workspaceId],
  );
  await f.pool.query("VACUUM (ANALYZE) versions");
  const plan = await f.pool.query(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + CONTENT_MATCH_SQL,
    [f.workspaceId, literalPattern("rare_retry_code_72931")],
  );
  expect(JSON.stringify(plan.rows[0])).toContain("versions_content_trgm_idx");
  expect(
    (
      await f.pool.query(CONTENT_MATCH_SQL, [
        f.workspaceId,
        literalPattern("rare_retry_code_72931"),
      ])
    ).rows,
  ).toEqual([{ page_id: "topic", number: 5000 }]);
});
test("freshness metadata changes only with committed native index mutations and distinguishes rebuild time", async () => {
  const f = await setup();
  const before = await f.bridge.searchIndex.status(f.browser.ctx);
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "UPDATE versions SET data=jsonb_set(data,'{content}','\"rolled back\"') WHERE workspace_id=$1",
      [f.workspaceId],
    );
    expect(
      (await f.bridge.searchIndex.status(f.browser.ctx)).freshness
        .workspaceRevision,
    ).toBe(before.freshness.workspaceRevision);
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  expect((await f.bridge.searchIndex.status(f.browser.ctx)).freshness).toEqual(
    before.freshness,
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}','\"committed update\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const after = await f.bridge.searchIndex.status(f.browser.ctx);
  expect(BigInt(after.freshness.workspaceRevision!)).toBe(
    BigInt(before.freshness.workspaceRevision!) + 1n,
  );
  expect(after.freshness.lastContentMutationObservedAt).toEqual(
    expect.any(String),
  );
  expect(after.lastSuccess).toEqual(before.lastSuccess);
  expect(after.freshness.lagSeconds).toBeNull();
});
test("a blocked native rebuild rolls back the index, records actual failure and recovers on a fresh authorized retry", async () => {
  const f = await setup();
  const before = await f.bridge.searchIndex.status(f.browser.ctx);
  const node = async () =>
    (
      await f.pool.query(
        "SELECT relfilenode FROM pg_class WHERE oid='public.versions_content_trgm_idx'::regclass",
      )
    ).rows[0].relfilenode;
  const old = await node();
  const blocker = await f.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE versions IN ROW EXCLUSIVE MODE");
    const receipt = await f.bridge.submitInteractive(
      f.browser.ctx,
      "index",
      { action: "rebuild-search-index" },
      "blocked",
    );
    await f.bridge.worker.tick();
    expect(await f.bridge.jobs.get(f.browser.ctx, receipt.id)).toMatchObject({
      status: "dead",
      error: "SEARCH_INDEX_LOCK_TIMEOUT",
    });
    expect(await node()).toBe(old);
    expect(
      (await f.bridge.searchIndex.status(f.browser.ctx)).lastSuccess,
    ).toEqual(before.lastSuccess);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  const failed = await f.bridge.searchIndex.status(f.browser.ctx);
  expect(failed.lastFailure?.code).toBe("SEARCH_INDEX_LOCK_TIMEOUT");
  const { ScopedSearch } = await import("../questions/search");
  const { authorizeInTransaction } = await import("../access/index");
  const search = new ScopedSearch(f.pool, {
    runtime: f.runtime,
    authorize: authorizeInTransaction,
  });
  expect(
    (await search.search(f.reader, { query: "기존 내용" })).items,
  ).toHaveLength(1);
  const retry = await f.bridge.submitInteractive(
    f.browser.ctx,
    "index",
    { action: "rebuild-search-index" },
    "recovered",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, retry.id)).toMatchObject({
    status: "succeeded",
  });
  expect(await node()).not.toBe(old);
  const recovered = await f.bridge.searchIndex.status(f.browser.ctx);
  expect(recovered.lastSuccess.kind).toBe("rebuild");
  expect(recovered.lastFailure).toEqual(failed.lastFailure);
});
test("missing native index is visible as degraded and can be recreated from canonical versions", async () => {
  const f = await setup();
  await f.pool.query("DROP INDEX public.versions_content_trgm_idx");
  expect(await f.bridge.searchIndex.status(f.browser.ctx)).toMatchObject({
    status: "degraded",
    indexBytes: null,
  });
  const receipt = await f.bridge.submitInteractive(
    f.browser.ctx,
    "index",
    { action: "rebuild-search-index" },
    "missing",
  );
  await f.bridge.worker.tick();
  expect(await f.bridge.jobs.get(f.browser.ctx, receipt.id)).toMatchObject({
    status: "succeeded",
  });
  expect(await f.bridge.searchIndex.status(f.browser.ctx)).toMatchObject({
    status: "ready",
    lastSuccess: { kind: "rebuild" },
  });
});
test("admin/operator and current verified-session requirements cannot be replaced with a PAT or ordinary role", async () => {
  const f = await setup();
  const { AccessService } = await import("../access/index");
  const pat = await new AccessService(f.pool).issueCredential(f.editor, {
    actions: ["knowledge.read", "changeset.propose"],
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const ctx = await new AccessService(f.pool).authenticateCredential(
    pat.secret,
  );
  await expect(
    f.bridge.submitInteractive(
      ctx,
      "index",
      { action: "rebuild-search-index" },
      "pat",
    ),
  ).rejects.toThrow("INDEX_SESSION_REQUIRED");
  await expect(
    f.bridge.submitInteractive(
      f.editor,
      "index",
      { action: "rebuild-search-index" },
      "bare",
    ),
  ).rejects.toThrow("INDEX_SESSION_REQUIRED");
  const other = createRuntimeJobs(f.pool, f.runtime, {
    workerCount: 1,
    platformOperatorIds: [],
    ...f.browser.options,
  });
  await expect(
    other.submitInteractive(
      f.browser.ctx,
      "index",
      { action: "rebuild-search-index" },
      "not-operator",
    ),
  ).rejects.toThrow("FORBIDDEN");
  const reader = await browserIdentity(f.pool, f.reader, servers);
  const readerBridge = createRuntimeJobs(f.pool, f.runtime, {
    workerCount: 1,
    platformOperatorIds: ["reader"],
    ...reader.options,
  });
  await expect(
    readerBridge.submitInteractive(
      reader.ctx,
      "index",
      { action: "rebuild-search-index" },
      "reader",
    ),
  ).rejects.toThrow("FORBIDDEN");
});
test("revoking an admitted operator identity prevents the worker from replacing the index", async () => {
  const f = await setup();
  const node = async () =>
    (
      await f.pool.query(
        "SELECT relfilenode FROM pg_class WHERE oid='public.versions_content_trgm_idx'::regclass",
      )
    ).rows[0].relfilenode;
  const old = await node();
  const receipt = await f.bridge.submitInteractive(
    f.browser.ctx,
    "index",
    { action: "rebuild-search-index" },
    "revoked",
  );
  await f.pool.query(
    "UPDATE access_principals SET active=false WHERE id='editor'",
  );
  await f.bridge.worker.tick();
  expect(await node()).toBe(old);
  expect(
    (
      await f.pool.query("SELECT status,result FROM durable_jobs WHERE id=$1", [
        receipt.id,
      ])
    ).rows[0],
  ).toMatchObject({ status: "dead", result: null });
});

test("actual OIDC HTTP exposes catalog status and durable Admin rebuild while enforcing CSRF and strict input", async () => {
  const f = await setup();
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { randomUUID } = await import("node:crypto");
  const oidc = await import("openid-client");
  const { OidcAuth, sessionHash } = await import("../runtime/auth");
  const { createRuntimeHandler } = await import("../runtime/http");
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups: ["writers"] }));
  }).listen(0, "127.0.0.1");
  servers.push(provider);
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    writers: "editor",
    readers: "reader",
  });
  const token = randomUUID();
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','fixture-csrf','editor','fixture-token',now()+interval '1 hour')",
    [sessionHash(token), f.workspaceId],
  );
  const jobs = createRuntimeJobs(f.pool, f.runtime, {
    workerCount: 1,
    platformOperatorIds: ["editor"],
    revalidateInteractiveGrant: (binding) =>
      auth.revalidateInteractiveGrant(binding),
    assertInteractiveGrant: (db, binding) =>
      auth.assertInteractiveGrant(db, binding),
  });
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: f.runtime,
      auth,
      jobs,
      platformOperatorIds: ["editor"],
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = {
    Cookie: "akh_session=" + token,
    Origin: "http://localhost",
    "X-CSRF-Token": "fixture-csrf",
    "Content-Type": "application/json",
  };
  const status = await fetch(base + "/api/v1/search/index", { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    status: "ready",
    freshness: { mode: "transaction-synchronous" },
    lastSuccess: { at: expect.any(String) },
  });
  const csrf = await fetch(base + "/api/v1/search/index/rebuild", {
    method: "POST",
    headers: { ...headers, "X-CSRF-Token": "wrong" },
    body: JSON.stringify({ idempotency_key: "csrf" }),
  });
  expect(csrf.status).toBe(403);
  const invalid = await fetch(base + "/api/v1/search/index/rebuild", {
    method: "POST",
    headers,
    body: JSON.stringify({
      idempotency_key: "invalid",
      indexName: "arbitrary",
    }),
  });
  expect(invalid.status).toBe(400);
  const admitted = await fetch(base + "/api/v1/search/index/rebuild", {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotency_key: "http-index" }),
  });
  expect(admitted.status).toBe(202);
  const receipt = await admitted.json();
  await jobs.worker.tick();
  const result = await fetch(base + "/api/v1/jobs-v2/" + receipt.id, {
    headers,
  });
  expect(await result.json()).toMatchObject({
    status: "succeeded",
    result: { rebuilt: true },
  });
  expect(
    await (await fetch(base + "/api/v1/search/index", { headers })).json(),
  ).toMatchObject({ lastSuccess: { kind: "rebuild" } });
});

test("an admitted operator must retain current space Admin authority before rebuilding", async () => {
  const f = await setup();
  const old = (
    await f.pool.query(
      "SELECT relfilenode FROM pg_class WHERE oid='public.versions_content_trgm_idx'::regclass",
    )
  ).rows[0].relfilenode;
  const receipt = await f.bridge.submitInteractive(
    f.browser.ctx,
    "index",
    { action: "rebuild-search-index" },
    "demoted",
  );
  await f.pool.query(
    "UPDATE access_team_members SET role='member' WHERE principal_id='editor' AND team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1)",
    [f.workspaceId],
  );
  await f.bridge.worker.tick();
  expect(
    (
      await f.pool.query(
        "SELECT relfilenode FROM pg_class WHERE oid='public.versions_content_trgm_idx'::regclass",
      )
    ).rows[0].relfilenode,
  ).toBe(old);
  expect(
    (
      await f.pool.query("SELECT status,result FROM durable_jobs WHERE id=$1", [
        receipt.id,
      ])
    ).rows[0],
  ).toMatchObject({ status: "dead", result: null });
});
