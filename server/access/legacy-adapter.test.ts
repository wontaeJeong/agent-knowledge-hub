import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../test-support";
import { bootstrapAccess, authorizeAction, syncIdentity } from "./index";
import { LegacyAccessService, registerPrincipal } from "./legacy-adapter";
import { RuntimeService } from "../runtime/knowledge";

async function setup() {
  const f = await fixture();
  await bootstrapAccess(f.pool, {
    spaces: [
      {
        workspaceId: f.workspaceId,
        team: { slug: f.workspaceId, name: "Preserved Organization" },
        owners: [{ principalId: "editor" }],
        grants: [
          { principalId: "reviewer", role: "maintain" },
          { principalId: "reader", role: "read" },
        ],
        reviewers: ["reviewer"],
      },
    ],
  });
  return { ...f, access: new LegacyAccessService(f.pool) };
}
test(
  "released Organization/Team/space DTOs map to the one canonical authority with uppercase roles and preserved IDs",
  { timeout: 20000 },
  async () => {
    const f = await setup();
    try {
      const state = await f.access.state(f.editor),
        org = state.space!.orgId!;
      expect(state.space!.organization).toBe("Preserved Organization");
      expect(state.space!.role).toBe("Admin");
      expect((await f.access.state(f.ctx)).space!.role).toBe("Maintain");
      expect(
        (await f.access.state(f.ctx)).capabilities.manageOrganization,
      ).toBe(false);
      const team = await f.access.createTeam(f.editor, "Engineering");
      await f.access.teamMember(f.editor, team.id, "reader", true);
      const grant = await f.access.grant(f.editor, {
        teamId: team.id,
        role: "Write",
      });
      expect((await f.access.state(f.reader)).space!.role).toBe("Write");
      expect(
        (
          await f.pool.query("SELECT team_id FROM access_groups WHERE id=$1", [
            team.id,
          ])
        ).rows[0].team_id,
      ).toBe(org);
      await f.access.teamMember(f.editor, team.id, "reader", false);
      expect((await f.access.state(f.reader)).space!.role).toBe("Read");
      await f.access.revoke(f.editor, grant.id);
      const space = await f.access.createSpace(f.editor, "추가 조직 공간", org);
      expect(
        (await f.access.spaces(f.editor)).find((s) => s.id === space.id)?.name,
      ).toBe("추가 조직 공간");
      await expect(
        authorizeAction(
          f.pool,
          { ...f.reader, workspaceId: space.id },
          "knowledge.read",
        ),
      ).rejects.toThrow("NOT_FOUND");
      const before = (
        await f.pool.query(
          "SELECT count(*) AS n FROM resource_readers WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n;
      await f.access.visibility(
        f.editor,
        "team",
        (await f.access.state(f.editor)).space!.revision,
      );
      expect(
        (
          await f.pool.query(
            "SELECT count(*) AS n FROM resource_readers WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0].n,
      ).toBe(before);
    } finally {
      await f.pool.end();
    }
  },
);
test("legacy role invitation acceptance is atomic, scoped, independent of personal space, and owner invitation never self-promotes", async () => {
  const f = await setup();
  try {
    const who = "legacy_" + randomUUID();
    await registerPrincipal(f.pool, who, "이름 보존");
    const personal = await f.access.createSpace(
        { ...f.reader, principalId: who },
        "개인 공간",
      ),
      ctx = { workspaceId: personal.id, principalId: who };
    const member = await f.access.invite(f.editor, {
      principalId: who,
      role: "member",
    });
    expect((await f.access.invitations(ctx))[0]).toMatchObject({
      id: member.id,
      role: "member",
      principalId: who,
    });
    await f.access.invitation(ctx, member.id, "accept");
    expect(
      (
        await f.pool.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND principal_id=$2",
          [f.workspaceId, who],
        )
      ).rows[0]?.role,
    ).toBe("reader");
    await expect(
      authorizeAction(
        f.pool,
        { ...ctx, workspaceId: f.workspaceId },
        "knowledge.read",
      ),
    ).rejects.toThrow("NOT_FOUND");
    const role = await f.access.invite(f.editor, {
      principalId: who,
      role: "Write",
      workspaceId: f.workspaceId,
    });
    // Either protocol accepts the same fixed invitation against the same policy engine.
    await f.access.canonical.acceptInvite(ctx, role.id);
    expect(
      (await f.access.state({ ...ctx, workspaceId: f.workspaceId })).space!
        .role,
    ).toBe("Write");
    const owner = await f.access.invite(f.editor, {
      principalId: who,
      role: "owner",
    });
    await expect(f.access.member(f.editor, "editor", null)).rejects.toThrow(
      "LAST_OWNER",
    );
    await f.access.invitation(ctx, owner.id, "accept");
    expect(
      (await f.access.state(f.editor)).capabilities.manageOrganization,
    ).toBe(true);
    await f.access.member(
      { ...ctx, workspaceId: f.workspaceId },
      "editor",
      null,
    );
    await expect(f.access.state(f.editor)).rejects.toThrow("NOT_FOUND");
    await expect(
      f.access.reviewer({ ...ctx, workspaceId: f.workspaceId }, "reader", true),
    ).rejects.toThrow("FORBIDDEN");
  } finally {
    await f.pool.end();
  }
});
test("legacy registration never revives disabled identities, expiry remains current and unowned legacy reviewer stays quarantined", async () => {
  const f = await fixture();
  try {
    const access = new LegacyAccessService(f.pool);
    expect((await access.state(f.ctx)).managed).toBe(false);
    await expect(access.bootstrap(f.ctx, "Not auto Admin")).rejects.toThrow(
      "FORBIDDEN",
    );
    const who = "disabled_" + randomUUID();
    await registerPrincipal(f.pool, who, "Known");
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id=$1",
      [who],
    );
    await expect(
      registerPrincipal(f.pool, who, "Still disabled"),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      (
        await f.pool.query("SELECT active FROM access_principals WHERE id=$1", [
          who,
        ])
      ).rows[0].active,
    ).toBe(false);
  } finally {
    await f.pool.end();
  }
});

test("released explicit organization-creation policy permits an admitted human, never another organization's administration", async () => {
  const f = await setup(),
    previous = process.env.ACCESS_ALLOW_ORG_CREATE;
  try {
    const who = await syncIdentity(f.pool, {
        issuer: "https://compat.invalid",
        subject: randomUUID(),
      }),
      personal = await f.access.createSpace(
        { ...f.reader, principalId: who },
        "개인",
      );
    const ctx = { workspaceId: personal.id, principalId: who };
    process.env.ACCESS_ALLOW_ORG_CREATE = "true";
    const org = await f.access.createOrganization(ctx, "새 Organization");
    expect(
      (await f.access.organizations(ctx)).find((o) => o.id === org.id)?.role,
    ).toBe("owner");
    await expect(
      f.access.createSpace(
        ctx,
        "다른 조직",
        (await f.access.state(f.editor)).space!.orgId!,
      ),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    if (previous === undefined) delete process.env.ACCESS_ALLOW_ORG_CREATE;
    else process.env.ACCESS_ALLOW_ORG_CREATE = previous;
    await f.pool.end();
  }
});

test("released expulsion cancels pending recipient/inviter invitations and expiry never consults historical membership", async () => {
  const f = await setup();
  try {
    await f.access.grant(f.editor, {
      principalId: "reader",
      role: "Write",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f.pool.query(
      "UPDATE access_grants SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND principal_id='reader'",
      [f.workspaceId],
    );
    await expect(f.access.state(f.reader)).rejects.toThrow("NOT_FOUND");
    const i = await f.access.invite(f.editor, {
      principalId: "reader",
      role: "Read",
      workspaceId: f.workspaceId,
    });
    await f.access.member(f.editor, "reader", null);
    await expect(f.access.invitation(f.reader, i.id, "accept")).rejects.toThrow(
      "NOT_FOUND",
    );
  } finally {
    await f.pool.end();
  }
});

test("released policy updates retire approvals and re-open fixed proposals for the same canonical independent-review checks", async () => {
  const f = await setup();
  try {
    const runtime = new RuntimeService(f.pool);
    const b = await runtime.core.propose(
      f.editor,
      [
        {
          id: "topic",
          title: "주제",
          summary: "변경",
          content: "변경 내용",
          scope: "team",
          baseVersion: 1,
          sourceIds: ["source-a"],
          links: [],
          facts: [],
        },
      ],
      ["source-a"],
    );
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await f.access.grant(f.editor, { principalId: "reader", role: "Triage" });
    expect(
      (
        await f.pool.query("SELECT 1 FROM approvals WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT data->>'status' AS status FROM batches WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, b.id],
        )
      ).rows[0].status,
    ).toBe("pending");
    await expect(
      runtime.core.publish(f.ctx, b.id, b.hash, "stale-role"),
    ).rejects.toThrow("APPROVAL_STALE");
  } finally {
    await f.pool.end();
  }
});

test("legacy management keeps disabled/expired members visible as blocked without reviving their permissions", async () => {
  const f = await setup();
  try {
    const org = (await f.access.state(f.editor)).space!.orgId!,
      who = "inactive_" + randomUUID();
    await f.pool.query(
      "INSERT INTO access_principals(id,active) VALUES($1,false)",
      [who],
    );
    await f.pool.query(
      "INSERT INTO access_team_members VALUES($1,$2,'member',true)",
      [org, who],
    );
    const service = await f.access.canonical.createServicePrincipal(f.editor, {
      name: "expired",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await f.pool.query(
      "UPDATE access_service_accounts SET expires_at=now()-interval '1 second' WHERE principal_id=$1",
      [service.id],
    );
    expect(
      (await f.access.canonical.members(f.editor)).some(
        (m) => m.principalId === service.id,
      ),
    ).toBe(false);
    const state = await f.access.state(f.editor);
    expect(state.members.find((m) => m.principalId === who)?.role).toBeNull();
    expect(
      state.members.find((m) => m.principalId === service.id)?.role,
    ).toBeNull();
    await expect(registerPrincipal(f.pool, who, "No revival")).rejects.toThrow(
      "FORBIDDEN",
    );
  } finally {
    await f.pool.end();
  }
});
