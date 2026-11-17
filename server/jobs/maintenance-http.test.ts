import { test, expect } from "vitest";
import { createServer } from "node:http";
import { writeFile, access as fileAccess, unlink } from "node:fs/promises";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { AccessService } from "../access/index";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { createRuntimeHandler } from "../runtime/http";
import { createRuntimeJobs } from "./runtime";

test(
  "actual OIDC HTTP schedule, preview, manual weekly/monthly execution and source revocation preserve review boundaries",
  async () => {
    const f = await fixture();
    await adoptFixture(f.pool, f.workspaceId);
    const owner = { ...f.editor, principalId: "fixture-owner" },
      access = new AccessService(f.pool),
      runtime = new RuntimeService(f.pool);
    const account = await access.createServicePrincipal(owner, {
      name: "knowledge-maintenance",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await f.pool.query(
      "UPDATE access_grants SET role='write' WHERE workspace_id=$1 AND principal_id=$2",
      [f.workspaceId, account.id],
    );
    const credential = await access.issueServiceCredential(owner, account.id, {
      actions: ["knowledge.read", "changeset.propose", "lint.run"],
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    });
    const identity = {
      workspaceId: f.workspaceId,
      principalId: account.id,
      credentialId: credential.id,
    };
    for (const actor of [owner.principalId, account.id])
      await f.pool.query(
        "INSERT INTO resource_readers SELECT workspace_id,kind,id,$2 FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
        [f.workspaceId, actor],
      );
    const provider = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sub: "fixture-owner", groups: ["owners"] }));
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
      config = new oidc.Configuration(
        { issuer, userinfo_endpoint: issuer + "/userinfo" },
        "client",
        "secret",
      );
    oidc.allowInsecureRequests(config);
    let handler: ReturnType<typeof createRuntimeHandler>;
    const server = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const auth = new OidcAuth(f.pool, config, base, f.workspaceId, {
      owners: "editor",
    });
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'fixture-owner','csrf',now()+interval '1 hour','fixture-owner','token')",
      [sessionHash("maintenance-owner"), f.workspaceId],
    );
    const bridge = createRuntimeJobs(f.pool, runtime, {
      workerCount: 1,
      directoryProviderId: "fixture",
      directoryStatus: async (subject) => ({
        ...subject,
        active: true,
        verifiedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 10000).toISOString(),
      }),
    });
    handler = createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth,
      origin: base,
      workspaceId: f.workspaceId,
      jobs: bridge,
    });
    const headers = {
      Cookie: "akh_session=maintenance-owner",
      Origin: base,
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
    };
    try {
      for (const kind of ["weekly", "monthly"]) {
        const spec = {
          key: kind,
          cadence: kind,
          ...(kind === "weekly"
            ? { weekday: 1 }
            : { dayOfMonth: 31, invalidDay: "clamp" }),
          time: "09:00",
          timezone: "Asia/Seoul",
          holidays: [],
          catchup: "latest",
          identity,
          job: {
            kind,
            payload: { mode: "offline" },
            pageIds: ["topic"],
            sourceIds: ["source-a"],
            reservation: { tokens: 0, costMicros: 0 },
            timeoutMs: 60000,
            maxAttempts: 3,
          },
          approvedPageIds: ["topic"],
          approvedSourceIds: ["source-a"],
        };
        expect(
          (
            await fetch(base + "/api/v1/jobs-v2/schedules", {
              method: "POST",
              headers: { ...headers, "X-CSRF-Token": "wrong" },
              body: JSON.stringify(spec),
            })
          ).status,
        ).toBe(403);
        if (kind === "monthly") {
          const invalid = await fetch(base + "/api/v1/jobs-v2/schedules", {
            method: "POST",
            headers,
            body: JSON.stringify({ ...spec, invalidDay: undefined }),
          });
          expect(invalid.status, await invalid.clone().text()).toBe(400);
        }
        const saved = await fetch(base + "/api/v1/jobs-v2/schedules", {
          method: "POST",
          headers,
          body: JSON.stringify(spec),
        });
        expect(saved.status, await saved.clone().text()).toBe(201);
        const s = await saved.json();
        const preview = await fetch(
          `${base}/api/v1/jobs-v2/schedules/${s.id}/preview`,
          { headers },
        );
        expect(preview.status, await preview.clone().text()).toBe(200);
        const run = await fetch(
          `${base}/api/v1/jobs-v2/schedules/${s.id}/run`,
          { method: "POST", headers, body: JSON.stringify({ key: "manual" }) },
        );
        expect(run.status, await run.clone().text()).toBe(202);
        const j = await run.json();
        await bridge.worker.tick();
        const row = (
          await f.pool.query(
            "SELECT status,result FROM durable_jobs WHERE id=$1",
            [j.id],
          )
        ).rows[0];
        expect(row.status).toBe("succeeded");
        expect(row.result).toMatchObject({
          cadence: kind,
          humanReviewRequired: true,
          proposalOnly: true,
        });
        expect(row.result.window.timezone).toBe("Asia/Seoul");
        expect(
          (await fetch(`${base}/api/v1/jobs-v2/${j.id}`, { headers })).status,
        ).toBe(200);
      }
      if (process.env.AKH_MAINTENANCE_BROWSER === "true") {
        await writeFile(
          "/private/tmp/akh-task7-browser-ready.json",
          JSON.stringify({ base, cookie: "akh_session=maintenance-owner" }),
        );
        for (let i = 0; i < 1200; i++) {
          try {
            await fileAccess("/private/tmp/akh-task7-browser-done");
            await unlink("/private/tmp/akh-task7-browser-done");
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      const s = (
        await f.pool.query(
          "SELECT id FROM durable_schedules WHERE workspace_id=$1 AND schedule_key='weekly'",
          [f.workspaceId],
        )
      ).rows[0];
      const queued = await bridge.jobs.runSchedule(
        owner,
        s.id,
        "revoke-before-run",
      );
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id=$2 AND kind='source' AND resource_id='source-a'",
        [f.workspaceId, account.id],
      );
      await bridge.worker.tick();
      const failed = (
        await f.pool.query(
          "SELECT status,result FROM durable_jobs WHERE id=$1",
          [queued.id],
        )
      ).rows[0];
      expect(failed.status).toBe("dead");
      expect(failed.result).toBeNull();
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM publications WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await bridge.stop();
      server.closeAllConnections();
      provider.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => provider.close(() => r()));
      await f.pool.end();
    }
  },
  process.env.AKH_MAINTENANCE_BROWSER === "true" ? 660000 : 15000,
);
