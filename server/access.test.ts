import { afterEach, expect, test, vi } from "vitest";
import { fixture, source, adoptLegacyFixture } from "./test-support";
import { AccessService, registerPrincipal } from "./access";
import { syncIdentity } from "./access/index";
import { RuntimeService } from "./runtime/knowledge";
import { membership } from "./repository";
import { transaction } from "./database";
import { randomUUID } from "node:crypto";
import { usageSummary } from "./usage";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

test("Triage classifies only currently readable proposals and Maintain has no organization usage aggregate", async () => {
  const f = await setup();
  const batch = await f.runtime.core.propose(
    f.editor,
    [
      {
        id: "topic",
        title: "Topic",
        summary: "Summary",
        scope: "team",
        content: "New proposal",
        baseVersion: 1,
        links: [],
        facts: [],
        sourceIds: [source.id],
      },
    ],
    [source.id],
  );
  await expect(f.runtime.triage(f.reader, batch.id, "blocked")).rejects.toThrow(
    "FORBIDDEN",
  );
  await f.access.grant(f.editor, { principalId: "reader", role: "Triage" });
  await f.runtime.triage(f.reader, batch.id, "needs-review");
  expect((await f.runtime.changesets(f.reader))[0].triage).toBe("needs-review");
  await expect(
    f.runtime.core.approve(f.reader, batch.id, batch.hash),
  ).rejects.toThrow("FORBIDDEN");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    f.runtime.triage(f.reader, batch.id, "duplicate"),
  ).rejects.toThrow("NOT_FOUND");
  expect((await usageSummary(f.pool, f.ctx, 7)).scope).toBe("self");
  expect((await usageSummary(f.pool, f.editor, 7)).scope).toBe("workspace");
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  await adoptLegacyFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool);
  const state = await access.state(f.editor);
  return {
    ...f,
    access,
    orgId: state.space!.orgId!,
    runtime: new RuntimeService(f.pool),
  };
}
test("adoption requires explicit operator binding; legacy reviewer is Maintain, never Owner/Admin", async () => {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  const a = new AccessService(f.pool);
  vi.stubEnv("ACCESS_BOOTSTRAP_OWNERS", "");
  await expect(a.bootstrap(f.ctx, "Org")).rejects.toThrow("FORBIDDEN");
  expect((await a.state(f.ctx)).managed).toBe(false);
  await adoptLegacyFixture(f.pool, f.workspaceId);
  expect((await a.state(f.ctx)).space?.role).toBe("Maintain");
  expect((await a.state(f.ctx)).capabilities.manageSpace).toBe(false);
  expect((await a.state(f.editor)).space?.role).toBe("Admin");
});
test("released bootstrap accepts a verified explicit adoption policy without restoring unchosen legacy roles or broadening raw ACLs", async () => {
  const f = await fixture();
  cleanup.push(() => f.pool.end());
  const issuer = "https://verified-bootstrap.invalid",
    subject = randomUUID();
  const principalId = await syncIdentity(f.pool, { issuer, subject }),
    ctx = { workspaceId: f.workspaceId, principalId };
  vi.stubEnv("ACCESS_BOOTSTRAP_OWNERS", principalId);
  vi.stubEnv(
    "ACCESS_LEGACY_ADOPTION_JSON",
    JSON.stringify({
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Explicit" },
          owners: [{ issuer, subject }],
          grants: [{ principalId: "reviewer", role: "maintain" }],
          reviewers: ["reviewer"],
        },
      ],
    }),
  );
  const a = new AccessService(f.pool),
    before = (
      await f.pool.query(
        "SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",
        [f.workspaceId],
      )
    ).rows;
  expect((await a.state(ctx)).bootstrapAllowed).toBe(true);
  await a.bootstrap(ctx, "Verified organization");
  expect((await a.state(ctx)).space?.role).toBe("Admin");
  expect((await a.state(f.ctx)).space?.role).toBe("Maintain");
  await expect(a.state(f.editor)).rejects.toThrow("NOT_FOUND");
  expect(
    (
      await f.pool.query(
        "SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual(before);
});
test("organization and space invitations grant nothing before acceptance; last owner remains protected during transfer", async () => {
  const f = await setup();
  const who = "new-" + randomUUID();
  await registerPrincipal(f.pool, who, "New member");
  // A real user has their independently owned personal workspace for acceptance.
  const { id: personal } = await f.access.createSpace(f.reader, "Personal");
  const readOnly = { workspaceId: personal, principalId: "reader" };
  const invitation = await f.access.invite(f.editor, {
    principalId: "reader",
    role: "owner",
  });
  await expect(f.access.member(f.editor, "editor", null)).rejects.toThrow(
    "LAST_OWNER",
  );
  await f.access.invitation(readOnly, invitation.id, "accept");
  await f.access.member(f.editor, "editor", null);
  expect(
    (await f.access.state({ ...f.ctx, principalId: "reader" })).space?.role,
  ).toBe("Admin");
  await expect(f.access.state(f.editor)).rejects.toThrow("NOT_FOUND");
  const owner = { workspaceId: f.workspaceId, principalId: "reader" };
  const i = await f.access.invite(owner, { principalId: who, role: "member" });
  expect(
    (await f.pool.query("SELECT access_role($1,$2) AS r", [f.workspaceId, who]))
      .rows[0].r,
  ).toBeNull();
  await f.pool.query(
    "UPDATE access_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [i.id],
  );
  await expect(f.access.invitation(owner, i.id, "accept")).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("Team and direct paths combine only inside their organization; revocation and expiration are current", async () => {
  const f = await setup();
  const { id: team } = await f.access.createTeam(f.editor, "Engineering");
  await f.access.teamMember(f.editor, team, "reader", true);
  const g = await f.access.grant(f.editor, { teamId: team, role: "Write" });
  expect((await f.access.state(f.reader)).space?.role).toBe("Write");
  await f.access.teamMember(f.editor, team, "reader", false);
  expect((await f.access.state(f.reader)).space?.role).toBe("Read");
  await f.access.teamMember(f.editor, team, "reader", true);
  await f.access.revoke(f.editor, g.id);
  expect((await f.access.state(f.reader)).space?.role).toBe("Read");
  await f.access.grant(f.editor, {
    principalId: "reader",
    role: "Write",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await f.pool.query(
    "UPDATE access_grants SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    transaction(f.pool, f.workspaceId, (db) => membership(db, f.reader)),
  ).rejects.toThrow("NOT_FOUND");
  const { id: other } = await f.access.createSpace(
    f.editor,
    "Private",
    f.orgId,
  );
  expect(
    (await f.pool.query("SELECT access_role($1,'reviewer') AS r", [other]))
      .rows[0].r,
  ).toBeNull();
  const foreign = randomUUID();
  await f.pool.query(
    "INSERT INTO access_namespaces(id,kind,slug,name) VALUES($1,'team',$2,'Other')",
    [foreign, foreign],
  );
  const cross = randomUUID();
  await f.pool.query("INSERT INTO access_groups VALUES($1,$2,$3)", [
    cross,
    foreign,
    "Other team",
  ]);
  await expect(
    f.access.grant(f.editor, { teamId: cross, role: "Admin" }),
  ).rejects.toThrow("NOT_FOUND");
});
test("organization removal retires all Team/direct paths; re-adding does not restore old grants or approvals", async () => {
  const f = await setup();
  const { id: team } = await f.access.createTeam(f.editor, "Ops");
  await f.access.teamMember(f.editor, team, "reader", true);
  await f.access.grant(f.editor, { teamId: team, role: "Admin" });
  await f.access.member(f.editor, "reader", null);
  expect(
    (
      await f.pool.query("SELECT effective_membership($1,'reader') AS r", [
        f.workspaceId,
      ])
    ).rows[0].r,
  ).toBeNull();
  await expect(f.runtime.pages(f.reader)).rejects.toThrow("NOT_FOUND");
  const personal = await f.access.createSpace(f.ctx, "Reviewer personal");
  const i = await f.access.invite(f.editor, {
    principalId: "reader",
    role: "member",
  });
  // Establish the recipient's actual personal ownership, not a raw legacy membership.
  const readerPersonal = await f.access.createSpace(
    f.reader,
    "Reader personal",
  );
  await f.access.invitation(
    { workspaceId: readerPersonal.id, principalId: "reader" },
    i.id,
    "accept",
  );
  expect(
    (
      await f.pool.query("SELECT access_role($1,'reader') AS r", [
        f.workspaceId,
      ])
    ).rows[0].r,
  ).toBeNull();
  expect(personal.id).toBeTruthy();
});
test("space Admin has no automatic source/private access; personal owner and visibility remain independent", async () => {
  const f = await setup();
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  expect(await f.runtime.pages(f.editor)).toEqual([]);
  const p = await f.access.createSpace(f.reader, "Personal");
  await expect(
    f.access.visibility(
      { workspaceId: p.id, principalId: "reader" },
      "team",
      1,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect((await f.access.spaces(f.editor)).some((s) => s.id === p.id)).toBe(
    false,
  );
  const state = await f.access.state(f.editor);
  await f.access.visibility(f.editor, "team", state.space!.revision);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM resource_readers WHERE workspace_id=$1 AND principal_id=$2",
        [f.workspaceId, "editor"],
      )
    ).rows[0].n,
  ).toBe(0);
});
test("managed-space independent review cannot be bypassed by the proposer as Owner/Admin, and grant changes invalidate approval", async () => {
  const f = await setup();
  const proposed = await f.runtime.core.propose(
    f.editor,
    [
      {
        id: "topic",
        title: "Topic",
        summary: "Summary",
        scope: "team",
        content: "Reviewed candidate",
        baseVersion: 1,
        links: [],
        facts: [],
        sourceIds: [source.id],
      },
    ],
    [source.id],
  );
  await expect(
    f.runtime.core.approve(f.editor, proposed.id, proposed.hash),
  ).rejects.toThrow("FORBIDDEN");
  await f.runtime.core.approve(f.ctx, proposed.id, proposed.hash);
  await f.access.grant(f.editor, { principalId: "reader", role: "Triage" });
  await expect(
    f.runtime.core.publish(f.ctx, proposed.id, proposed.hash, "stale-policy"),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM approvals WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
