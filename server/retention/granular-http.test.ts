import { expect, test } from "vitest";
import { createServer } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { AccessService } from "../access/index";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeHandler } from "../runtime/http";
import { RuntimeService } from "../runtime/knowledge";
test("actual authenticated OIDC/CSRF API selects, independently reviews and retires a terminal job; unauthenticated and revoked callers cannot mutate", async () => {
  const f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  const owner = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    access = new AccessService(f.pool);
  await access.setGrant(owner, {
    principalId: "reviewer",
    role: "admin",
    expectedVersion: (await access.effective(owner)).space.policyVersion,
  });
  let admitted = true;
  const provider = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!admitted) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const sub =
      req.headers.authorization === "Bearer reviewer"
        ? "reviewer"
        : "fixture-owner";
    res.end(JSON.stringify({ sub, groups: ["members"] }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    members: "editor",
  });
  for (const who of ["fixture-owner", "reviewer"])
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,'csrf',now()+interval '1 hour',$3,$3)",
      [sessionHash(who), f.workspaceId, who],
    );
  await f.pool.query(
    "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES('http-retire',$1,'editor','lint','succeeded')",
    [f.workspaceId],
  );
  const server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: new RuntimeService(f.pool),
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/retention/pruning`;
  const request = (
    path: string,
    body: unknown,
    who = "fixture-owner",
    csrf = "csrf",
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Cookie: `akh_session=${who}`,
        Origin: "http://localhost",
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const selection = [{ kind: "runtime-job", id: "http-retire" }];
    expect((await fetch(base)).status).toBe(401);
    expect(
      (await request("/preview", { selection }, "fixture-owner", "wrong"))
        .status,
    ).toBe(403);
    const previewResponse = await request("/preview", { selection });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(
      200,
    );
    const preview = await previewResponse.json();
    const planned = await request("/plans", {
      selection,
      previewHash: preview.hash,
      policyRevision: 0,
    });
    expect(planned.status, await planned.clone().text()).toBe(200);
    const plan = await planned.json();
    expect(
      (
        await request("/execute", {
          planId: plan.id,
          previewHash: preview.hash,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/review", {
          planId: plan.id,
          previewHash: preview.hash,
          decision: "approve",
        })
      ).status,
    ).toBe(403);
    const approved = await request(
      "/review",
      { planId: plan.id, previewHash: preview.hash, decision: "approve" },
      "reviewer",
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    const executed = await request("/execute", {
      planId: plan.id,
      previewHash: preview.hash,
    });
    expect(executed.status, await executed.clone().text()).toBe(200);
    expect(await executed.json()).toMatchObject({
      status: "completed",
      deleted: 1,
      allCopiesErased: false,
    });
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM runtime_jobs WHERE workspace_id=$1 AND id='http-retire'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT artifact_id FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='runtime-job'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ artifact_id: "http-retire" }]);
    admitted = false;
    expect(
      (
        await request("/execute", {
          planId: plan.id,
          previewHash: preview.hash,
        })
      ).status,
    ).toBe(401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => provider.close(() => r()));
    await f.pool.end();
  }
});
