import { beforeAll, afterAll, test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, adoptFixture } from "../test-support";
import { AccessService, authorizeInTransaction } from "../access";
import { StorageService, FileBlobStore } from "../storage";
import { RefinementService } from "../refinement/service";
import { RuntimeService } from "./knowledge";
import { HttpAdmission } from "./admission";
import { OperationsService, operationsRoutes } from "../operations";
import { ShutdownController, operationsProbeHandler } from "../operations";
import { createRuntimeJobs } from "../jobs/runtime";
import { createRuntimeHandler } from "./http";
import { OidcAuth, sessionHash } from "./auth";
import * as oidc from "openid-client";
let f: Awaited<ReturnType<typeof fixture>>,
  base: string,
  server: Server,
  provider: Server,
  root: string,
  secret: string;
let auth: OidcAuth,
  providerEnabled = true;
const cookie = randomUUID();
const ownerCookie = randomUUID();
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  root = await realpath(await mkdtemp(join(tmpdir(), "akh-runtime-content-")));
  const access = new AccessService(f.pool);
  secret = (
    await access.issueCredential(f.editor, {
      actions: [
        "knowledge.read",
        "source.create",
        "changeset.propose",
        "personal.sync",
      ],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    })
  ).secret;
  provider = createServer((_req, res) => {
    if (!providerEnabled) {
      res.writeHead(401).end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    const owner = _req.headers.authorization === "Bearer fixture-owner-access";
    res.end(
      JSON.stringify({
        sub: owner ? "fixture-owner" : "editor",
        groups: [owner ? "reviewers" : "writers"],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    writers: "editor",
    reviewers: "reviewer",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','fixture-access')",
    [sessionHash(cookie), f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'fixture-owner','owner-csrf','fixture-owner','fixture-owner-access',now()+interval '1 hour')",
    [sessionHash(ownerCookie), f.workspaceId],
  );
  server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      storage: new StorageService(
        f.pool,
        new FileBlobStore(root),
        authorizeInTransaction,
      ),
      refinement: new RefinementService(f.pool, authorizeInTransaction),
      operations: operationsRoutes(
        new OperationsService(f.pool, authorizeInTransaction),
      ),
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (provider) await new Promise<void>((r) => provider.close(() => r()));
  await f?.pool.end();
  if (root) await rm(root, { recursive: true, force: true });
});
test("mounted raw upload enforces cookie CSRF before reading bytes and returns scoped persistent downloads", async () => {
  const metadata = {
    "X-Parent-Kind": "source",
    "X-Parent-Id": "source-a",
    "X-Filename": encodeURIComponent("한글 원본.txt"),
    "Content-Type": "text/plain",
  };
  const denied = await fetch(base + "/api/v1/storage/blobs", {
    method: "PUT",
    headers: {
      ...metadata,
      Cookie: `akh_session=${cookie}`,
      Origin: "http://localhost",
    },
    body: "CSRF로 거부할 본문",
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "CSRF_FAILED" });
  const uploaded = await fetch(base + "/api/v1/storage/blobs", {
    method: "PUT",
    headers: { ...metadata, Authorization: `Bearer ${secret}` },
    body: "파일의 한글 내용",
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const blob = (await uploaded.json()) as { id: string };
  expect(blob.id).toBeTruthy();
  const downloaded = await fetch(base + `/api/v1/storage/blobs/${blob.id}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-disposition")).toContain("attachment");
  expect(await downloaded.text()).toBe("파일의 한글 내용");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  const revoked = await fetch(base + `/api/v1/storage/blobs/${blob.id}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(revoked.status).toBe(404);
  expect(await revoked.text()).not.toContain("파일의 한글 내용");
});
test("mounted refinement route uses the actual identity and strict schemas, not a static UI placeholder", async () => {
  const result = await fetch(base + "/api/v1/refinement/context", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ environment: {}, pageIds: [], limit: 25 }),
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ acl: "current", items: [] });
  const spoofed = await fetch(base + "/api/v1/refinement/context", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ environment: {}, principalId: "reviewer" }),
  });
  expect(spoofed.status).toBe(400);
});
test("actual agent outcome submission enters the current-ACL refinement review loop without becoming verified", async () => {
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a','editor') ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const result = await fetch(base + "/api/v1/agent/outcomes", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      used_versions: [{ page_id: "topic", version: 1 }],
      result: "failure",
      observations: "합성 업무에서 재검토 필요",
      evidence: [{ id: "source-a", version: 1, location: "content" }],
      idempotency_key: "runtime-outcome-1",
    }),
  });
  expect(result.status).toBe(201);
  const receipt = await result.json();
  expect(receipt).toMatchObject({
    verified: false,
    status: "needs_review",
    reviewImport: { status: "imported" },
  });
  const requests = await fetch(base + "/api/v1/refinement/requests", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(requests.status).toBe(200);
  expect(
    (
      (await requests.json()) as { items: { agentOutcomeId?: string }[] }
    ).items.some((item) => item.agentOutcomeId === receipt.id),
  ).toBe(true);
});
test("unconfigured official review policy returns a stable conflict code, not a hidden dependency failure", async () => {
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{status}','\"공식 기준\"') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  const result = await fetch(base + "/api/v1/ingest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourceIds: ["source-a"], mode: "offline" }),
  });
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({
    code: "OFFICIAL_REVIEW_REQUIRED",
  });
});
test("actual HTTP admission returns actor-scoped 429 and retry timing while probes stay available", async () => {
  const limited = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      admission: new HttpAdmission({ read: 1 }),
    }),
  ).listen(0, "127.0.0.1");
  await once(limited, "listening");
  const url = `http://127.0.0.1:${(limited.address() as { port: number }).port}`;
  try {
    const headers = { Authorization: `Bearer ${secret}` };
    expect((await fetch(url + "/api/v1/me", { headers })).status).toBe(200);
    const blocked = await fetch(url + "/api/v1/me", { headers });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect((await fetch(url + "/healthz")).status).toBe(200);
  } finally {
    await new Promise<void>((r) => limited.close(() => r()));
  }
});
test("interactive jobs can restore only a hashed live parent session and revalidate actual IdP outside DB locks", async () => {
  const raw = randomUUID(),
    sessionId = sessionHash(raw),
    binding = { sessionId, workspaceId: f.workspaceId, principalId: "editor" };
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','parent-csrf','editor','fixture-access',now()+interval '1 hour')",
    [sessionId, f.workspaceId],
  );
  const snapshot = await auth.revalidateInteractiveGrant(binding);
  expect(snapshot).toMatchObject({
    role: "editor",
    identityRole: "editor",
    csrfHash: sessionHash("parent-csrf"),
    subjectHash: sessionHash("editor"),
  });
  const guard = auth.requestGuard(
    {
      headers: { cookie: `akh_session=${raw}` },
    } as import("node:http").IncomingMessage,
    {
      ...f.editor,
      role: "editor",
      identityRole: "editor",
      csrfToken: "parent-csrf",
    },
  );
  expect(guard.sessionId).toBe(sessionId);
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await auth.assertInteractiveGrant(db, { ...binding, snapshot });
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  providerEnabled = false;
  try {
    await expect(
      auth.revalidateInteractiveGrant({ ...binding, snapshot }),
    ).rejects.toThrow("UNAUTHENTICATED");
  } finally {
    providerEnabled = true;
  }
  expect(
    (
      await f.pool.query("SELECT id FROM runtime_sessions WHERE id=$1", [
        sessionId,
      ])
    ).rows,
  ).toEqual([]);
});
test("mounted operational policy is admin-only and revision-checked, never an anonymous management mock", async () => {
  expect((await fetch(base + "/api/v1/operations/policy")).status).toBe(401);
  expect(
    (
      await fetch(base + "/api/v1/operations/policy", {
        headers: { Authorization: `Bearer ${secret}` },
      })
    ).status,
  ).toBe(403);
  const headers = {
    Cookie: `akh_session=${ownerCookie}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "owner-csrf",
    "Content-Type": "application/json",
  };
  const old = await fetch(base + "/api/v1/operations/policy", { headers });
  expect(old.status).toBe(200);
  expect(await old.json()).toMatchObject({ revision: 0 });
  const saved = await fetch(base + "/api/v1/operations/policy", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      expectedRevision: 0,
      auditDays: 365,
      telemetryDays: 90,
      backupDays: 30,
    }),
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ revision: 1 });
});
test("production HTTP accepts durable work before execution and exposes only the same actor completed result", async () => {
  const runtime = new RuntimeService(f.pool),
    jobs = createRuntimeJobs(f.pool, runtime, {
      revalidateInteractiveGrant: (binding) =>
        auth.revalidateInteractiveGrant(binding),
      assertInteractiveGrant: (db, binding) =>
        auth.assertInteractiveGrant(db, binding),
    });
  const queued = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      jobs,
    }),
  ).listen(0, "127.0.0.1");
  await once(queued, "listening");
  const url = `http://127.0.0.1:${(queued.address() as { port: number }).port}`;
  const headers = {
    Cookie: `akh_session=${cookie}`,
    Origin: "http://localhost",
    "X-CSRF-Token": "csrf",
    "Content-Type": "application/json",
    "Idempotency-Key": "http-durable-query",
  };
  try {
    expect(
      (await fetch(url + "/api/v1/execution-identities", { headers })).status,
    ).toBe(403);
    const identities = await fetch(url + "/api/v1/execution-identities", {
      headers: { Cookie: `akh_session=${ownerCookie}` },
    });
    expect(identities.status).toBe(200);
    expect(await identities.json()).toMatchObject({
      items: [],
      directoryConfigured: false,
    });
    const accepted = await fetch(url + "/api/v1/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "기존 내용", mode: "offline" }),
    });
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(receipt).toMatchObject({ status: "queued" });
    expect(await jobs.worker.tick()).toBe(true);
    const done = await fetch(url + `/api/v1/jobs-v2/${receipt.id}`, {
      headers,
    });
    expect(done.status).toBe(200);
    const result = await done.json();
    expect(result).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(result.result)).toContain("기존 내용");
    const replay = await fetch(url + "/api/v1/query", {
      method: "POST",
      headers,
      body: JSON.stringify({ question: "기존 내용", mode: "offline" }),
    });
    expect(replay.status).toBe(202);
    expect((await replay.json()).id).toBe(receipt.id);
  } finally {
    await jobs.stop();
    await new Promise<void>((r) => queued.close(() => r()));
  }
});
test("stored answer readback is private, hides internal ACL envelopes and revokes cached content with its sources", async () => {
  const answer = await new RuntimeService(f.pool).query(
      f.editor,
      "기존 내용",
      "offline",
    ),
    headers = { Authorization: `Bearer ${secret}` };
  const visible = await fetch(base + `/api/v1/answers/${answer.id}`, {
    headers,
  });
  expect(visible.status).toBe(200);
  const body = await visible.json();
  expect(body).toMatchObject({ id: answer.id, content: answer.content });
  expect(body).not.toHaveProperty("inputEnvelope");
  expect(
    (
      await fetch(base + `/api/v1/answers/${answer.id}`, {
        headers: { Cookie: `akh_session=${ownerCookie}` },
      })
    ).status,
  ).toBe(404);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  try {
    const denied = await fetch(base + `/api/v1/answers/${answer.id}`, {
      headers,
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(answer.content);
  } finally {
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a','editor') ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
  }
});
test("actual probes expose protected measured metrics, keep liveness independent and reject new work while draining", async () => {
  let probeError: unknown;
  const shutdown = new ShutdownController(),
    probe = operationsProbeHandler({
      pool: f.pool,
      shutdown,
      metricsToken: "m".repeat(32),
      modelProbe: async () => null,
      contentDirectory: root,
      minimumAvailableBytes: 64 * 1024 * 1024,
    }),
    live = createServer(
      createRuntimeHandler({
        pool: f.pool,
        service: new RuntimeService(f.pool),
        origin: "http://localhost",
        workspaceId: f.workspaceId,
        probe: async (req, res) => {
          try {
            return await probe(req, res);
          } catch (e) {
            probeError = e;
            throw e;
          }
        },
        shutdown,
      }),
    ).listen(0, "127.0.0.1");
  await once(live, "listening");
  const url = `http://127.0.0.1:${(live.address() as { port: number }).port}`;
  try {
    expect((await fetch(url + "/metrics")).status).toBe(403);
    const metrics = await fetch(url + "/metrics", {
      headers: { Authorization: "Bearer " + "m".repeat(32) },
    });
    expect(
      metrics.status,
      String(probeError) + " " + (await metrics.clone().text()),
    ).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("akh_model_input_tokens_known 0");
    expect(text).not.toContain(f.workspaceId);
    expect(text).not.toContain("기존 내용");
    expect((await fetch(url + "/readyz")).status).toBe(200);
    shutdown.draining = true;
    expect((await fetch(url + "/readyz")).status).toBe(503);
    expect((await fetch(url + "/healthz")).status).toBe(200);
    const denied = await fetch(url + "/api/v1/me", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ code: "DRAINING" });
  } finally {
    await new Promise<void>((r) => live.close(() => r()));
  }
});
