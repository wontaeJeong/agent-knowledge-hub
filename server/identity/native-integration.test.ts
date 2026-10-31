import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { afterEach, expect, test } from "vitest";
import { fixture } from "../test-support";
import { OidcAuth, sessionHash } from "../runtime/auth";
import {
  bootstrapAccess,
  syncIdentity,
  effectiveAccess,
  authorizeActionDb,
  AccessService,
} from "../access/index";
import { identityTransaction, initializeSessionPolicy } from "./sessions";
import {
  DirectoryAuthority,
  bindDirectoryGroup,
  syncDirectoryMemberships,
} from "./directory";
import { EmergencyAccess } from "./emergency";
import { createIdentityRuntime } from "./runtime";
import { handleIdentityRequest } from "./http";

const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function native() {
  const f = await fixture();
  pools.push(f.pool);
  let enabled = true;
  const groups = new Map<string, string[]>();
  const provider = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (!enabled) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    const subject = req.headers.authorization?.slice(7) ?? "";
    res.end(
      JSON.stringify({
        sub: subject,
        groups: groups.get(subject) ?? ["admission"],
      }),
    );
  });
  servers.push(provider);
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("FIXTURE_LISTEN");
  const issuer = `http://127.0.0.1:${address.port}`,
    config = new oidc.Configuration(
      { issuer, userinfo_endpoint: issuer + "/userinfo" },
      "client",
      "fixture-only",
    );
  oidc.allowInsecureRequests(config);
  const subject = randomUUID(),
    principalId = await syncIdentity(f.pool, { issuer, subject });
  await bootstrapAccess(f.pool, {
    spaces: [
      {
        workspaceId: f.workspaceId,
        team: { slug: f.workspaceId, name: "Native identity" },
        owners: [{ principalId }],
        grants: [],
        reviewers: [],
      },
    ],
  });
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    admission: "reader",
  });
  async function session(who = subject, initialize = false) {
    const principal = await syncIdentity(f.pool, { issuer, subject: who }),
      raw = randomUUID(),
      id = sessionHash(raw);
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf',$4,$4,clock_timestamp()+interval '1 hour')",
      [id, f.workspaceId, principal, who],
    );
    if (initialize)
      await initializeSessionPolicy(f.pool, {
        sessionId: id,
        workspaceId: f.workspaceId,
        principalId: principal,
      });
    const req = {
      headers: { cookie: `akh_session=${raw}` },
    } as IncomingMessage;
    return { raw, id, req, principalId: principal, subject: who };
  }
  return {
    ...f,
    issuer,
    config,
    auth,
    principalId,
    subject,
    session,
    groups,
    disable: () => {
      enabled = false;
    },
  };
}
test("native final guards reject unknown activity; only live verified recovery uses conservative issuance, then idle expiry cannot be touched alive", async () => {
  const f = await native(),
    s = await f.session();
  const expected = {
    workspaceId: f.workspaceId,
    principalId: s.principalId,
    role: "reviewer" as const,
    identityRole: "reader" as const,
    csrfToken: "csrf",
  };
  await expect(
    identityTransaction(f.pool, (db) =>
      f.auth.requestGuard(s.req, expected).assertSession(db),
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  const current = await f.auth.authenticate(s.req);
  expect(current).not.toBeNull();
  const activity = (
    await f.pool.query(
      "SELECT created_at,last_seen_at FROM identity_session_activity WHERE session_id=$1",
      [s.id],
    )
  ).rows[0];
  expect(activity).toBeTruthy();
  expect(activity.created_at.getTime()).toBeLessThanOrEqual(Date.now());
  const expiry = (
    await f.pool.query("SELECT expires_at FROM runtime_sessions WHERE id=$1", [
      s.id,
    ])
  ).rows[0].expires_at;
  await f.auth.authenticate(s.req);
  expect(
    (
      await f.pool.query(
        "SELECT expires_at FROM runtime_sessions WHERE id=$1",
        [s.id],
      )
    ).rows[0].expires_at,
  ).toEqual(expiry);
  await f.pool.query(
    "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '31 minutes' WHERE session_id=$1",
    [s.id],
  );
  await expect(
    identityTransaction(f.pool, (db) =>
      f.auth.requestGuard(s.req, current!).assertSession(db),
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(await f.auth.authenticate(s.req)).toBeNull();
  expect(
    (await f.pool.query("SELECT id FROM runtime_sessions WHERE id=$1", [s.id]))
      .rowCount,
  ).toBe(0);
});
test("native interactive grant revalidation does not extend idle lifetime; current policy checked again at final effect", async () => {
  const f = await native(),
    s = await f.session(f.subject, true),
    binding = {
      sessionId: s.id,
      workspaceId: f.workspaceId,
      principalId: s.principalId,
    };
  await f.pool.query(
    "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '10 minutes',last_seen_at=clock_timestamp()-interval '2 minutes' WHERE session_id=$1",
    [s.id],
  );
  const before = (
    await f.pool.query(
      "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
      [s.id],
    )
  ).rows[0].last_seen_at;
  const snapshot = await f.auth.revalidateInteractiveGrant(binding);
  expect(
    (
      await f.pool.query(
        "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
        [s.id],
      )
    ).rows[0].last_seen_at,
  ).toEqual(before);
  await f.pool.query(
    "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '31 minutes' WHERE session_id=$1",
    [s.id],
  );
  let effects = 0;
  await expect(
    identityTransaction(f.pool, async (db) => {
      await f.auth.assertInteractiveGrant(db, { ...binding, snapshot });
      effects++;
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(effects).toBe(0);
});
test("native UserInfo refresh removes only the mapped group path while actor stays admitted; canonical reads expire unknown proofs", async () => {
  const f = await native(),
    owner = await f.session(f.subject, true),
    ownerSession = await f.auth.authenticate(owner.req);
  const ownerCtx = {
    ...ownerSession!,
    authorization: f.auth.requestGuard(owner.req, ownerSession!),
  };
  const actor = await f.session(randomUUID(), true),
    team = (await effectiveAccess(f.pool, ownerCtx)).space.namespaceId;
  await f.pool.query(
    "INSERT INTO access_team_members(team_id,principal_id,role) VALUES($1,$2,'member')",
    [team, actor.principalId],
  );
  const group = randomUUID();
  await f.pool.query("INSERT INTO access_groups VALUES($1,$2,$1)", [
    group,
    team,
  ]);
  await f.pool.query(
    "INSERT INTO access_grants(id,workspace_id,group_id,role) VALUES($1,$2,$3,'write')",
    [randomUUID(), f.workspaceId, group],
  );
  await identityTransaction(f.pool, (db) =>
    bindDirectoryGroup(
      db,
      ownerCtx,
      {
        issuer: f.issuer,
        externalGroupId: "group-opaque-19",
        groupId: group,
        expectedRevision: 0,
      },
      async () => {},
      { allowLoopbackHttp: true },
    ),
  );
  f.groups.set(actor.subject, ["admission", "group-opaque-19"]);
  const earlier = await f.auth.authenticate(actor.req);
  expect(earlier?.role).toBe("editor");
  f.groups.set(actor.subject, ["admission"]);
  expect((await f.auth.authenticate(actor.req))?.spaceRole).toBeNull();
  await expect(
    identityTransaction(f.pool, (db) =>
      f.auth.requestGuard(actor.req, earlier!).assertSession(db),
    ),
  ).rejects.toThrow("UNAUTHENTICATED");
  expect(
    (
      await f.pool.query(
        "SELECT active FROM access_team_members WHERE team_id=$1 AND principal_id=$2",
        [team, actor.principalId],
      )
    ).rows[0].active,
  ).toBe(true);
  f.groups.set(actor.subject, ["admission", "group-opaque-19"]);
  await f.auth.authenticate(actor.req);
  await f.pool.query(
    "UPDATE identity_directory_edges SET valid_until=clock_timestamp()-interval '1 second' WHERE principal_id=$1",
    [actor.principalId],
  );
  expect(
    (
      await effectiveAccess(f.pool, {
        workspaceId: f.workspaceId,
        principalId: actor.principalId,
      })
    ).role,
  ).toBeNull();
  const access = new AccessService(f.pool),
    version = (
      await f.pool.query("SELECT version FROM access_namespaces WHERE id=$1", [
        team,
      ])
    ).rows[0].version;
  await access.setGroupMembers(ownerCtx, group, {
    principalIds: [],
    expectedVersion: version,
  });
  await f.auth.authenticate(actor.req);
  expect(
    (
      await effectiveAccess(f.pool, {
        workspaceId: f.workspaceId,
        principalId: actor.principalId,
      })
    ).role,
  ).toBeNull();
});
test("canonical authorizer consumes emergency approval only for exact page/version and never bypasses current raw ACL, expiry or global Admin", async () => {
  const f = await native(),
    actor = await f.session(randomUUID(), true),
    approver = await f.session(randomUUID(), true),
    owner = await f.session(f.subject, true),
    ownerSession = await f.auth.authenticate(owner.req),
    team = (await effectiveAccess(f.pool, ownerSession!)).space.namespaceId;
  for (const principal of [actor.principalId, approver.principalId]) {
    await f.pool.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
      f.workspaceId,
      principal,
    ]);
    await f.pool.query(
      "INSERT INTO access_team_members(team_id,principal_id,role) VALUES($1,$2,'member')",
      [team, principal],
    );
    for (const kind of ["source", "page"])
      await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
        f.workspaceId,
        kind,
        kind === "source" ? "source-a" : "topic",
        principal,
      ]);
  }
  const runtime = createIdentityRuntime(f.pool, {
    platformEmergencyApproverIds: [approver.principalId],
  });
  const auth = new OidcAuth(
    f.pool,
    f.config,
    "http://localhost",
    f.workspaceId,
    { admission: "reader" },
    runtime.authOptions,
  );
  const a = await auth.authenticate(actor.req),
    p = await auth.authenticate(approver.req);
  const actorCtx = { ...a!, authorization: auth.requestGuard(actor.req, a!) },
    approverCtx = { ...p!, authorization: auth.requestGuard(approver.req, p!) };
  const emergency = runtime.emergency!;
  const request = await emergency.request(actorCtx, {
    reason: "Scoped canonical incident investigation",
    pageIds: ["topic"],
    actions: ["knowledge.read"],
    minutes: 10,
  });
  await emergency.decide(approverCtx, request.id, 1, "approved");
  await identityTransaction(f.pool, (db) =>
    authorizeActionDb(db, actorCtx, "knowledge.read", {
      kind: "page",
      id: "topic",
      version: 1,
    }),
  );
  expect(
    (
      await handleIdentityRequest(
        runtime.httpServices,
        actorCtx,
        "GET",
        "/api/v1/identity/emergency-pages/topic/versions/1",
        undefined,
      )
    )?.body,
  ).toEqual({ pageId: "topic", version: 1, content: "기존 내용" });
  expect((await effectiveAccess(f.pool, actorCtx)).capabilities).not.toContain(
    "knowledge.read",
  );
  await expect(
    identityTransaction(f.pool, (db) =>
      authorizeActionDb(db, actorCtx, "space.admin"),
    ),
  ).rejects.toThrow();
  await expect(
    identityTransaction(f.pool, (db) =>
      authorizeActionDb(db, actorCtx, "knowledge.read", {
        kind: "page",
        id: "topic",
        version: 99,
      }),
    ),
  ).rejects.toThrow();
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id=$2",
    [f.workspaceId, actor.principalId],
  );
  await expect(
    identityTransaction(f.pool, (db) =>
      authorizeActionDb(db, actorCtx, "knowledge.read", {
        kind: "page",
        id: "topic",
        version: 1,
      }),
    ),
  ).rejects.toThrow("NOT_FOUND");
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a',$2)",
    [f.workspaceId, actor.principalId],
  );
  await f.pool.query(
    "UPDATE identity_emergencies SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [request.id],
  );
  await expect(
    identityTransaction(f.pool, (db) =>
      authorizeActionDb(db, actorCtx, "knowledge.read", {
        kind: "page",
        id: "topic",
        version: 1,
      }),
    ),
  ).rejects.toThrow();
});
