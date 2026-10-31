import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "../test-support";
import {
  IdentityOperations,
  assertSessionPolicy,
  initializeSessionPolicy,
  touchSession,
  identityTransaction,
} from "./sessions";
import {
  DirectoryAuthority,
  syncDirectoryMemberships,
  projectDirectoryMemberships,
  bindDirectoryGroup,
  denyGroupMembership,
  canonicalGroupAdmin,
} from "./directory";
import { EmergencyAccess } from "./emergency";
import { effectiveAccess } from "../access/index";
import { handleIdentityRequest } from "./http";
import { createServer } from "node:http";

const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  for (const id of ["human", "approver", "other"])
    await f.pool.query(
      "INSERT INTO access_principals(id,issuer,subject) VALUES($1,'https://directory.example',$1) ON CONFLICT(id) DO UPDATE SET active=true",
      [id],
    );
  await f.pool.query(
    "DELETE FROM runtime_sessions WHERE principal_id IN ('human','approver','other')",
  );
  await f.pool.query(
    "INSERT INTO access_namespaces(id,kind,slug,name,owner_id) VALUES($1,'personal',$1,'Identity fixture','human')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO access_spaces(workspace_id,namespace_id,slug) VALUES($1,$1,'identity')",
    [f.workspaceId],
  );
  async function session(who: string, suffix = "") {
    const id = hash(who + f.workspaceId + suffix);
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'secret-csrf',$3,'secret-access',clock_timestamp()+interval '1 hour')",
      [id, f.workspaceId, who],
    );
    await initializeSessionPolicy(f.pool, {
      sessionId: id,
      principalId: who,
      workspaceId: f.workspaceId,
    });
    return {
      workspaceId: f.workspaceId,
      principalId: who,
      authorization: {
        sessionId: id,
        revalidate: async () => {},
        assertSession: async () => {},
      },
    };
  }
  return { ...f, session };
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
describe("identity actual PostgreSQL boundaries", () => {
  it("asserts idle and absolute independently; touch is server-time monotonic and cannot extend absolute", async () => {
    const f = await setup(),
      ctx = await f.session("human"),
      binding = { ...ctx, sessionId: ctx.authorization.sessionId };
    await assertSessionPolicy(f.pool, binding);
    await f.pool.query(
      "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '2 hours',last_seen_at=clock_timestamp()-interval '31 minutes' WHERE session_id=$1",
      [binding.sessionId],
    );
    await expect(touchSession(f.pool, binding)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    await f.pool.query(
      "UPDATE identity_session_activity SET last_seen_at=clock_timestamp() WHERE session_id=$1",
      [binding.sessionId],
    );
    await expect(
      assertSessionPolicy(f.pool, binding, {
        absoluteSeconds: 3600,
        idleSeconds: 1800,
        touchSeconds: 30,
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
  it("lists only own safe metadata; selected revocation cannot target another actor; logout stops all bound grants", async () => {
    const f = await setup(),
      ctx = await f.session("human"),
      second = await f.session("human", "2"),
      other = await f.session("other");
    const op = new IdentityOperations(f.pool);
    const listed = await op.sessions(ctx);
    expect(listed.items).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(/secret-|access_token|csrf/);
    await expect(
      op.revokeSession(ctx, other.authorization.sessionId),
    ).rejects.toThrow("NOT_FOUND");
    await f.pool.query(
      "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES('exec',$1,'human',$2,ARRAY['knowledge.read'],clock_timestamp()+interval '1 hour')",
      [hash("execution"), f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO runtime_execution_grants(credential_id,workspace_id,principal_id,operation,payload_hash,page_ids,source_ids,parent_session_id,parent_session_snapshot,request_key,timeout_ms,created_at,expires_at) VALUES('exec',$1,'human','query','hash','{}','{}',$2,'{}','key',3600000,clock_timestamp(),clock_timestamp()+interval '30 minutes')",
      [f.workspaceId, second.authorization.sessionId],
    );
    await op.logoutAll(ctx);
    expect(
      (
        await f.pool.query(
          "SELECT revoked FROM runtime_execution_grants WHERE credential_id='exec'",
        )
      ).rows[0].revoked,
    ).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT revoked FROM access_credentials WHERE id='exec'",
        )
      ).rows[0].revoked,
    ).toBe(true);
    await expect(
      assertSessionPolicy(f.pool, {
        ...ctx,
        sessionId: second.authorization.sessionId,
      }),
    ).rejects.toThrow();
    await assertSessionPolicy(f.pool, {
      ...other,
      sessionId: other.authorization.sessionId,
    });
  });
  it("selected revocation and DB failure deny the final protected effect; activity is bounded and never extends absolute expiry", async () => {
    const f = await setup(),
      ctx = await f.session("human"),
      other = await f.session("human", "second"),
      op = new IdentityOperations(f.pool);
    const binding = { ...other, sessionId: other.authorization.sessionId };
    const initial = (
      await f.pool.query(
        "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
        [binding.sessionId],
      )
    ).rows[0].last_seen_at;
    await identityTransaction(f.pool, (db) => touchSession(db, binding));
    expect(
      (
        await f.pool.query(
          "SELECT last_seen_at FROM identity_session_activity WHERE session_id=$1",
          [binding.sessionId],
        )
      ).rows[0].last_seen_at,
    ).toEqual(initial);
    await f.pool.query(
      "UPDATE identity_session_activity SET created_at=clock_timestamp()-interval '1 hour',last_seen_at=clock_timestamp()-interval '2 minutes' WHERE session_id=$1",
      [binding.sessionId],
    );
    const absolute = (
      await f.pool.query(
        "SELECT expires_at FROM runtime_sessions WHERE id=$1",
        [binding.sessionId],
      )
    ).rows[0].expires_at;
    await identityTransaction(f.pool, (db) =>
      touchSession(db, binding, {
        absoluteSeconds: 7200,
        idleSeconds: 1800,
        touchSeconds: 30,
      }),
    );
    expect(
      (
        await f.pool.query(
          "SELECT expires_at FROM runtime_sessions WHERE id=$1",
          [binding.sessionId],
        )
      ).rows[0].expires_at,
    ).toEqual(absolute);
    await op.revokeSession(ctx, binding.sessionId);
    let effects = 0;
    await expect(
      identityTransaction(f.pool, async (db) => {
        await assertSessionPolicy(db, binding);
        effects++;
      }),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      assertSessionPolicy(
        {
          query: async () => {
            throw Error("DB_OFFLINE");
          },
        } as never,
        binding,
      ),
    ).rejects.toThrow("DB_OFFLINE");
    expect(effects).toBe(0);
  });
  it("fresh group removal removes only directory paths; manual paths and product tombstones survive", async () => {
    const f = await setup();
    await f.pool.query(
      "INSERT INTO access_namespaces(id,kind,slug,name) VALUES('directory-team','team','directory-team','Directory') ON CONFLICT DO NOTHING",
    );
    await f.pool.query(
      "INSERT INTO access_groups VALUES('mapped','directory-team','mapped'),('manual','directory-team','manual') ON CONFLICT DO NOTHING",
    );
    await f.pool.query(
      "UPDATE access_spaces SET namespace_id='directory-team' WHERE workspace_id=$1",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO access_team_members(team_id,principal_id,role) VALUES('directory-team','human','member')",
    );
    await f.pool.query(
      "INSERT INTO access_grants(id,workspace_id,group_id,role) VALUES('directory-grant',$1,'mapped','write')",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO access_group_members VALUES('manual','human')",
    );
    const ctx = await f.session("approver");
    await identityTransaction(f.pool, (db) =>
      bindDirectoryGroup(
        db,
        ctx,
        {
          issuer: "https://directory.example",
          externalGroupId: "opaque-group-17",
          groupId: "mapped",
          expectedRevision: 0,
        },
        async () => {},
      ),
    );
    let groups = ["admission", "opaque-group-17"];
    const authority = new DirectoryAuthority({
      issuer: "https://directory.example",
      maxAgeSeconds: 60,
      fetchVerifiedUserInfo: async () => ({
        issuer: "https://directory.example",
        subject: "human",
        groups,
      }),
    });
    const sync = async () => {
      const proof = await authority.verify("human");
      return identityTransaction(f.pool, (db) =>
        syncDirectoryMemberships(db, proof),
      );
    };
    await sync();
    expect(
      (
        await effectiveAccess(f.pool, {
          workspaceId: f.workspaceId,
          principalId: "human",
        })
      ).role,
    ).toBe("write");
    expect(
      (
        await f.pool.query(
          "SELECT group_id FROM access_group_members WHERE principal_id='human' ORDER BY group_id",
        )
      ).rows.map((r) => r.group_id),
    ).toEqual(["manual", "mapped"]);
    groups = ["admission"];
    await sync();
    expect(
      (
        await effectiveAccess(f.pool, {
          workspaceId: f.workspaceId,
          principalId: "human",
        })
      ).role,
    ).toBeNull();
    expect(
      (
        await f.pool.query(
          "SELECT active FROM access_team_members WHERE team_id='directory-team' AND principal_id='human'",
        )
      ).rows[0].active,
    ).toBe(true);
    expect(
      (
        await f.pool.query(
          "SELECT group_id FROM access_group_members WHERE principal_id='human'",
        )
      ).rows,
    ).toEqual([{ group_id: "manual" }]);
    groups = ["admission", "opaque-group-17"];
    await sync();
    await f.pool.query(
      "UPDATE access_grants SET revoked=true WHERE id='directory-grant'",
    );
    await sync();
    expect(
      (
        await effectiveAccess(f.pool, {
          workspaceId: f.workspaceId,
          principalId: "human",
        })
      ).role,
    ).toBeNull();
    await identityTransaction(f.pool, (db) =>
      denyGroupMembership(db, "mapped", "human"),
    );
    await sync();
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM access_group_members WHERE group_id='mapped'",
        )
      ).rowCount,
    ).toBe(0);
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id='human'",
    );
    await expect(sync()).rejects.toThrow("DIRECTORY_IDENTITY_MISMATCH");
    expect(
      (
        await f.pool.query(
          "SELECT active FROM access_principals WHERE id='human'",
        )
      ).rows[0].active,
    ).toBe(false);
  });
  it("rejects forged, stale and changed-issuer proof; expiry removes mapped path without deleting manual memberships", async () => {
    const f = await setup();
    await expect(
      syncDirectoryMemberships(f.pool, {
        issuer: "https://directory.example",
      } as never),
    ).rejects.toThrow("UNVERIFIED_DIRECTORY_PROOF");
    const authority = new DirectoryAuthority({
      issuer: "https://directory.example",
      maxAgeSeconds: 60,
      fetchVerifiedUserInfo: async () => ({
        issuer: "https://changed.example",
        subject: "human",
        groups: [],
      }),
    });
    await expect(authority.verify("human")).rejects.toThrow(
      "DIRECTORY_IDENTITY_MISMATCH",
    );
    await f.pool.query(
      "UPDATE identity_directory_edges SET valid_until=clock_timestamp()-interval '1 second'",
    );
    await identityTransaction(f.pool, (db) =>
      projectDirectoryMemberships(db, "human"),
    );
    const currentAuthority = new DirectoryAuthority({
      issuer: "https://directory.example",
      maxAgeSeconds: 60,
      fetchVerifiedUserInfo: async () => ({
        issuer: "https://directory.example",
        subject: "human",
        groups: [],
      }),
    });
    await f.pool.query(
      "INSERT INTO identity_directory_proofs(principal_id,issuer,verified_at,valid_until) VALUES('human','https://directory.example',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '2 minutes') ON CONFLICT(principal_id,issuer) DO UPDATE SET verified_at=EXCLUDED.verified_at,valid_until=EXCLUDED.valid_until",
    );
    const stale = await currentAuthority.verify("human");
    await expect(
      identityTransaction(f.pool, (db) => syncDirectoryMemberships(db, stale)),
    ).rejects.toThrow("STALE_DIRECTORY_PROOF");
    await f.pool.query(
      "DELETE FROM identity_directory_proofs WHERE principal_id='human'",
    );
  });
  it("proof freshness and binding removal revoke only directory contributions; unrelated namespace Admin cannot approve a binding", async () => {
    const f = await setup(),
      ctx = await f.session("approver"),
      team = "expiry-" + f.workspaceId;
    await f.pool.query(
      "UPDATE access_namespaces SET owner_id='approver' WHERE id=$1",
      [f.workspaceId],
    );
    await f.pool.query(
      "INSERT INTO access_namespaces(id,kind,slug,name) VALUES($1,'team',$1,'Expiry fixture')",
      [team],
    );
    await f.pool.query(
      "INSERT INTO access_groups VALUES('expiry-group',$1,'Expiry'),('expiry-manual',$1,'Manual')",
      [team],
    );
    await expect(
      identityTransaction(f.pool, (db) =>
        bindDirectoryGroup(
          db,
          ctx,
          {
            issuer: "https://directory.example",
            externalGroupId: "external-expiry",
            groupId: "expiry-group",
            expectedRevision: 0,
          },
          canonicalGroupAdmin,
        ),
      ),
    ).rejects.toThrow("FORBIDDEN");
    await f.pool.query(
      "INSERT INTO access_team_members(team_id,principal_id,role) VALUES($1,'approver','owner')",
      [team],
    );
    const bind = (
      externalGroupId: string,
      expectedRevision: number,
      active = true,
    ) =>
      identityTransaction(f.pool, (db) =>
        bindDirectoryGroup(
          db,
          ctx,
          {
            issuer: "https://directory.example",
            externalGroupId,
            groupId: "expiry-group",
            expectedRevision,
            active,
          },
          canonicalGroupAdmin,
        ),
      );
    await bind("external-expiry", 0);
    await bind("second-contribution", 0);
    await f.pool.query(
      "INSERT INTO access_group_members VALUES('expiry-manual','human')",
    );
    const authority = new DirectoryAuthority({
      issuer: "https://directory.example",
      maxAgeSeconds: 60,
      fetchVerifiedUserInfo: async () => ({
        issuer: "https://directory.example",
        subject: "human",
        groups: ["external-expiry", "second-contribution", "admission"],
      }),
    });
    const sync = async () => {
      const proof = await authority.verify("human");
      await identityTransaction(f.pool, (db) =>
        syncDirectoryMemberships(db, proof),
      );
    };
    await sync();
    await bind("external-expiry", 1, false);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM access_group_members WHERE group_id='expiry-group' AND principal_id='human'",
        )
      ).rowCount,
    ).toBe(1);
    await bind("second-contribution", 1, false);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM access_group_members WHERE group_id='expiry-group' AND principal_id='human'",
        )
      ).rowCount,
    ).toBe(0);
    await bind("external-expiry", 2, true);
    await sync();
    await f.pool.query(
      "UPDATE identity_directory_edges SET valid_until=clock_timestamp()-interval '1 second' WHERE binding_id IN (SELECT id FROM identity_directory_bindings WHERE group_id='expiry-group')",
    );
    await identityTransaction(f.pool, (db) =>
      projectDirectoryMemberships(db, "human"),
    );
    expect(
      (
        await f.pool.query(
          "SELECT group_id FROM access_group_members WHERE principal_id='human' AND group_id IN ('expiry-group','expiry-manual')",
        )
      ).rows,
    ).toEqual([{ group_id: "expiry-manual" }]);
  });
  it("emergency request is scoped, independent, nonrenewable and never expands raw ACL", async () => {
    const f = await setup(),
      requester = await f.session("human"),
      approver = await f.session("approver");
    const authority = new DirectoryAuthority({
      issuer: "https://directory.example",
      maxAgeSeconds: 60,
      fetchVerifiedUserInfo: async (subject) => ({
        issuer: "https://directory.example",
        subject,
        groups: ["admission"],
      }),
    });
    for (const subject of ["human", "approver"]) {
      const proof = await authority.verify(subject);
      await identityTransaction(f.pool, (db) =>
        syncDirectoryMemberships(db, proof),
      );
    }
    const emergency = new EmergencyAccess(f.pool, {
      platformEmergencyApproverIds: ["approver"],
      assertFreshHuman: async () => {},
      assertSourceUpperBound: async (_db, _ctx, pageIds) => {
        if (pageIds.includes("denied")) throw Error("RAW_SOURCE_DENIED");
      },
    });
    await expect(
      emergency.request(requester, {
        reason: "",
        pageIds: ["topic"],
        actions: ["queue.triage"],
        minutes: 10,
      }),
    ).rejects.toThrow("INVALID_EMERGENCY_REQUEST");
    const grant = await emergency.request(requester, {
      reason: "Incident 17 investigation",
      pageIds: ["topic"],
      actions: ["queue.triage"],
      minutes: 10,
    });
    await expect(
      emergency.decide(requester, grant.id, 1, "approved"),
    ).rejects.toThrow("FORBIDDEN");
    const selfApprover = new EmergencyAccess(f.pool, {
      platformEmergencyApproverIds: ["human"],
      assertFreshHuman: async () => {},
      assertSourceUpperBound: async () => {},
    });
    await expect(
      selfApprover.decide(requester, grant.id, 1, "approved"),
    ).rejects.toThrow("FORBIDDEN");
    await emergency.decide(approver, grant.id, 1, "approved");
    expect(
      await emergency.emergencyEffectiveCapabilities(
        f.pool,
        requester,
        "topic",
        ["knowledge.read", "queue.triage"],
      ),
    ).toEqual(["queue.triage"]);
    expect(
      await emergency.emergencyEffectiveCapabilities(
        f.pool,
        requester,
        "other",
        ["queue.triage"],
      ),
    ).toEqual([]);
    expect(
      await emergency.emergencyEffectiveCapabilities(
        f.pool,
        requester,
        "topic",
        [],
      ),
    ).toEqual([]);
    const denied = await emergency.request(requester, {
      reason: "Incident 18 investigation",
      pageIds: ["denied"],
      actions: ["knowledge.read"],
      minutes: 10,
    });
    await expect(
      emergency.decide(approver, denied.id, 1, "approved"),
    ).rejects.toThrow("RAW_SOURCE_DENIED");
    await f.pool.query(
      "UPDATE identity_directory_proofs SET verified_at=clock_timestamp()-interval '10 minutes',valid_until=clock_timestamp()-interval '1 minute' WHERE principal_id='human'",
    );
    await expect(
      emergency.emergencyEffectiveCapabilities(f.pool, requester, "topic", [
        "queue.triage",
      ]),
    ).rejects.toThrow("FRESH_DIRECTORY_HUMAN_REQUIRED");
    const fresh = await authority.verify("human");
    await identityTransaction(f.pool, (db) =>
      syncDirectoryMemberships(db, fresh),
    );
    await f.pool.query(
      "UPDATE identity_emergencies SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [grant.id],
    );
    expect(
      await emergency.emergencyEffectiveCapabilities(
        f.pool,
        requester,
        "topic",
        ["queue.triage"],
      ),
    ).toEqual([]);
    await expect(f.pool.query("DELETE FROM identity_events")).rejects.toThrow(
      "IDENTITY_AUDIT_APPEND_ONLY",
    );
  });
  it("actual HTTP dispatch uses server Context, strict body schemas, safe own metadata and immediate logout", async () => {
    const f = await setup(),
      ctx = await f.session("human"),
      other = await f.session("other"),
      services = { sessions: new IdentityOperations(f.pool) };
    const server = createServer(async (req, res) => {
      try {
        if (
          req.method !== "GET" &&
          (req.headers.origin !== "https://app.example" ||
            req.headers["x-csrf"] !== "fixture-only")
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        let raw = "";
        for await (const chunk of req) {
          raw += chunk.toString();
          if (raw.length > 4096) throw Error("BODY_TOO_LARGE");
        }
        const response = await handleIdentityRequest(
          services,
          ctx,
          req.method ?? "GET",
          req.url ?? "/",
          raw ? JSON.parse(raw) : undefined,
        );
        res.writeHead(response?.status ?? 404, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(response?.body ?? {}));
      } catch (e) {
        const message = e instanceof Error ? e.message : "error";
        res.writeHead(
          message === "UNAUTHENTICATED"
            ? 401
            : message === "NOT_FOUND"
              ? 404
              : 400,
        );
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("FIXTURE_LISTEN");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const listed = await (
        await fetch(origin + "/api/v1/identity/sessions")
      ).json();
      expect(listed.items).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toMatch(/secret-|access_token|csrf/);
      const headers = {
        "Content-Type": "application/json",
        Origin: "https://app.example",
        "X-CSRF": "fixture-only",
      };
      expect(
        (
          await fetch(origin + "/api/v1/identity/logout-all", {
            method: "POST",
            headers,
            body: JSON.stringify({ principalId: "other" }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(
            origin +
              "/api/v1/identity/sessions/" +
              other.authorization.sessionId,
            { method: "DELETE", headers, body: "{}" },
          )
        ).status,
      ).toBe(404);
      const response = await fetch(origin + "/api/v1/identity/logout-all", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        productSessionsRevoked: true,
        idpLogout: "not_configured",
      });
      expect((await fetch(origin + "/api/v1/identity/sessions")).status).toBe(
        401,
      );
      await assertSessionPolicy(f.pool, {
        ...other,
        sessionId: other.authorization.sessionId,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
