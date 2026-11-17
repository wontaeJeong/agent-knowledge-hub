import { test, expect } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import * as oidc from "openid-client";
import { Client } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { OidcAuth, sessionHash } from "./auth";
import { transaction } from "../database";
import { effectiveAccess } from "../access/index";
async function host() {
  const f = await fixture();
  const raw = "auth-order-" + f.workspaceId;
  await adoptFixture(f.pool, f.workspaceId);
  const provider = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sub: "editor", groups: ["editor"] }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    editor: "editor",
  });
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()+interval '1 hour','editor','editor')",
    [sessionHash(raw), f.workspaceId],
  );
  const req = {
    headers: { cookie: "akh_session=" + raw },
    url: "/api/v1/pages",
  } as IncomingMessage;
  return {
    f,
    auth,
    req,
    raw,
    close: async () => {
      await new Promise<void>((r) => provider.close(() => r()));
      await f.pool.end();
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("authentication refresh and protected effects never invert directory and session row locks", async () => {
  const h = await host();
  const held = deferred(),
    release = deferred();
  const original = Client.prototype.query;
  let pause = true,
    pid = 0;
  let background: Promise<unknown>[] = [];
  try {
    const session = await h.auth.authenticate(h.req, false);
    expect(session).not.toBeNull();
    (Client.prototype as any).query = function (...args: any[]) {
      const result = (original as any).apply(this, args);
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (
        pause &&
        sql?.startsWith("UPDATE runtime_sessions SET legacy_role_ceiling")
      ) {
        pause = false;
        pid = this.processID;
        return result.then(async (value: unknown) => {
          held.resolve();
          await release.promise;
          return value;
        });
      }
      return result;
    };
    const authentication = h.auth.authenticate(h.req, false);
    background.push(authentication);
    await held.promise;
    const guard = h.auth.requestGuard(h.req, session!);
    const protectedEffect = transaction(
      h.f.pool,
      h.f.workspaceId,
      async (db) => {
        await effectiveAccess(db, h.f.editor);
        await guard.assertSession(db);
        return true;
      },
    );
    background.push(protectedEffect);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = (
        await h.f.pool.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rows[0];
      if (row.n > 0) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(blocked).toBe(true);
    release.resolve();
    const results = await Promise.all(background);
    expect(results[0]).toMatchObject({ principalId: "editor" });
    expect(results[1]).toBe(true);
    expect(
      (
        await h.f.pool.query("SELECT 1 FROM runtime_sessions WHERE id=$1", [
          sessionHash(h.raw),
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    release.resolve();
    await Promise.allSettled(background);
    Client.prototype.query = original;
    await h.close();
  }
}, 15000);
test("transient database deadlock fails closed without discarding a valid session", async () => {
  const h = await host();
  const original = Client.prototype.query;
  let fail = true;
  try {
    (Client.prototype as any).query = function (...args: any[]) {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (fail && sql?.includes("pg_advisory_xact_lock(7203101)")) {
        fail = false;
        return Promise.reject(
          Object.assign(Error("synthetic deadlock"), { code: "40P01" }),
        );
      }
      return (original as any).apply(this, args);
    };
    await expect(h.auth.authenticate(h.req, false)).rejects.toThrow(
      "AUTH_BACKEND_UNAVAILABLE",
    );
    expect(
      (
        await h.f.pool.query("SELECT 1 FROM runtime_sessions WHERE id=$1", [
          sessionHash(h.raw),
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    Client.prototype.query = original;
    await h.close();
  }
});
