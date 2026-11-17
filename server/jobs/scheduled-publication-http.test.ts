import { test, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import * as oidc from "openid-client";
import { fixture, adoptFixture, page } from "../test-support";
import { draftOf } from "../../src/domain/wiki";
import { propose, approve } from "../publication";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { initializeSessionPolicy } from "../identity/sessions";
import { ScheduledPublicationService } from "./scheduled-publication";

test("real OIDC HTTP binds consent to the human session and CSRF; due worker publishes once and IdP revocation blocks later consent", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  let enabled = true;
  const idp = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!enabled) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const sub = req.headers.authorization?.replace("Bearer ", "") ?? "";
    res.end(JSON.stringify({ sub, groups: [sub] }));
  }).listen(0, "127.0.0.1");
  await once(idp, "listening");
  const issuer = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "fixture-secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    reviewer: "reviewer",
    editor: "editor",
  });
  const raw = crypto.randomUUID(),
    sessionId = sessionHash(raw);
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '20 minutes','reviewer','reviewer')",
    [sessionId, f.workspaceId],
  );
  await initializeSessionPolicy(f.pool, {
    sessionId,
    principalId: "reviewer",
    workspaceId: f.workspaceId,
  });
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  ).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, csrf = true, cookie = true) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: `akh_session=${raw}` } : {}),
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              "Idempotency-Key": crypto.randomUUID(),
              ...(csrf ? { "X-CSRF-Token": "csrf" } : {}),
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const b = await propose(
      f.pool,
      f.editor,
      [{ ...draftOf(page), content: "HTTP 예약 내용" }],
      ["source-a"],
    );
    await approve(f.pool, f.ctx, b.id, b.hash);
    const path = `/api/v1/changesets/${b.id}/publication-schedules`,
      input = {
        hash: b.hash,
        dueAt: new Date(Date.now() + 60000).toISOString(),
      };
    expect((await call(path + "/preview", input, true, false)).status).toBe(
      401,
    );
    expect((await call(path + "/preview", input, false)).status).toBe(403);
    const previewResponse = await call(path + "/preview", input);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      dueAt: input.dueAt,
      versions: { topic: 2 },
    });
    expect(
      (
        await call(path, {
          ...input,
          previewHash: preview.previewHash,
          confirm: "SCHEDULE_APPROVED_PUBLICATION",
          principalId: "editor",
        })
      ).status,
    ).toBe(400);
    const created = await call(path, {
      ...input,
      previewHash: preview.previewHash,
      confirm: "SCHEDULE_APPROVED_PUBLICATION",
    });
    expect(created.status).toBe(201);
    const s = await created.json();
    await f.pool.query(
      "UPDATE scheduled_publications SET due_at=now()-interval '1 second' WHERE id=$1",
      [s.id],
    );
    await new ScheduledPublicationService(
      f.pool,
      (row) => auth.backgroundContext(row),
      auth.sessionPolicy,
    ).runDue();
    await f.pool.query(
      "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '2 minutes',last_seen_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",
      [sessionId],
    );
    const before = (
      await f.pool.query(
        "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
        [sessionId],
      )
    ).rows[0].last_seen_at;
    const read = await call(`/api/v1/publication-schedules/${s.id}`);
    expect(
      (
        await f.pool.query(
          "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
          [sessionId],
        )
      ).rows[0].last_seen_at,
    ).toEqual(before);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      status: "published",
      result: { versions: { topic: 2 } },
    });
    const next = await propose(
      f.pool,
      f.editor,
      [{ ...draftOf(page), baseVersion: 2, content: "다음 예약" }],
      ["source-a"],
    );
    await approve(f.pool, f.ctx, next.id, next.hash);
    const nextPath = `/api/v1/changesets/${next.id}/publication-schedules`,
      nextInput = {
        hash: next.hash,
        dueAt: new Date(Date.now() + 60000).toISOString(),
      };
    const p = await (await call(nextPath + "/preview", nextInput)).json();
    const c = await call(nextPath, {
      ...nextInput,
      previewHash: p.previewHash,
      confirm: "SCHEDULE_APPROVED_PUBLICATION",
    });
    expect(c.status).toBe(201);
    const pending = await c.json();
    enabled = false;
    await f.pool.query(
      "UPDATE scheduled_publications SET due_at=now()-interval '1 second' WHERE id=$1",
      [pending.id],
    );
    await new ScheduledPublicationService(
      f.pool,
      (row) => auth.backgroundContext(row),
      auth.sessionPolicy,
    ).runDue();
    expect(
      (
        await f.pool.query(
          "SELECT status,error_code FROM scheduled_publications WHERE id=$1",
          [pending.id],
        )
      ).rows[0],
    ).toEqual({ status: "failed", error_code: "AUTHORIZATION_REQUIRED" });
    expect(
      (
        await f.pool.query(
          "SELECT max(number) AS n FROM versions WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(2);
  } finally {
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => idp.close(() => r())),
    ]);
    await f.pool.end();
  }
});
