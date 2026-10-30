import { expect, test } from "vitest";
import { fixture } from "../test-support";
import {
  AccessService,
  authorizeAction,
  bootstrapAccess,
  syncIdentity,
} from "./index";
import { RuntimeService } from "../runtime/knowledge";

test("explicit adoption quarantines unknown ownership and never promotes reviewer; personal isolation and default-none team membership", async () => {
  const f = await fixture();
  try {
    const access = new AccessService(f.pool);
    await expect(authorizeAction(f.pool, f.ctx, "space.admin")).rejects.toThrow(
      "NOT_FOUND",
    );
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Fixture" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reviewer", role: "maintain" }],
          reviewers: ["reviewer"],
        },
      ],
    });
    expect((await access.effective(f.ctx)).role).toBe("maintain");
    await expect(authorizeAction(f.pool, f.ctx, "space.admin")).rejects.toThrow(
      "FORBIDDEN",
    );
    const personal = await access.createSpace(f.editor, {
      slug: f.workspaceId,
    });
    await expect(
      authorizeAction(
        f.pool,
        { ...f.ctx, workspaceId: personal.id },
        "knowledge.read",
      ),
    ).rejects.toThrow("NOT_FOUND");
    const team = { id: (await access.effective(f.editor)).space.namespaceId };
    await syncIdentity(f.pool, {
      issuer: "https://fixture.invalid",
      subject: "reader",
      principalId: "reader",
    });
    const invite = await access.invite(f.editor, team.id, {
      principalId: "reader",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      authorizeAction(f.pool, f.reader, "knowledge.read"),
    ).rejects.toThrow("NOT_FOUND");
    await access.acceptInvite(f.reader, invite.id);
    await expect(
      authorizeAction(f.pool, f.reader, "knowledge.read"),
    ).rejects.toThrow("NOT_FOUND");
    await access.setGrant(f.editor, {
      principalId: "reader",
      role: "read",
      expectedVersion: (await access.effective(f.editor)).space.policyVersion,
    });
    expect((await access.effective(f.reader)).role).toBe("read");
    await access.removeGrant(
      f.editor,
      "reader",
      (await access.effective(f.editor)).space.policyVersion,
    );
    await syncIdentity(f.pool, {
      issuer: "https://fixture.invalid",
      subject: "reader",
      principalId: "reader",
    });
    await expect(
      authorizeAction(f.pool, f.reader, "knowledge.read"),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.end();
  }
});

test("designated independent human approvals are invalidated by grant/policy changes and cannot be restored by login", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Review" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reviewer", role: "maintain" }],
          reviewers: ["reviewer"],
        },
      ],
    });
    const runtime = new RuntimeService(f.pool),
      access = new AccessService(f.pool);
    const b = await runtime.ingest(f.editor, ["source-a"], "offline");
    await expect(runtime.core.approve(f.editor, b.id, b.hash)).rejects.toThrow(
      "FORBIDDEN",
    );
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await access.removeGrant(
      f.editor,
      "reviewer",
      (await access.effective(f.editor)).space.policyVersion,
    );
    await expect(
      runtime.core.publish(f.editor, b.id, b.hash, "publish"),
    ).rejects.toThrow("APPROVAL_STALE");
    await syncIdentity(f.pool, {
      issuer: "https://fixture.invalid",
      subject: "reviewer",
      principalId: "reviewer",
    });
    await expect(runtime.core.approve(f.ctx, b.id, b.hash)).rejects.toThrow();
    expect(
      (await runtime.pages(f.editor)).find((p) => p.id === "topic")?.version,
    ).toBe(1);
  } finally {
    await f.pool.end();
  }
});

test("group roles union with direct grants, removal keeps only remaining path; last owner requires accepted transfer", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Groups" },
          owners: [{ principalId: "editor" }],
          grants: [
            { principalId: "reader", role: "write" },
            { principalId: "reviewer", role: "maintain" },
          ],
          reviewers: [],
        },
      ],
    });
    const access = new AccessService(f.pool),
      teamId = (await access.effective(f.editor)).space.namespaceId;
    const group = await access.createGroup(f.editor, {
      teamId,
      name: "Readers",
      principalIds: ["reader"],
    });
    await access.setGrant(f.editor, {
      groupId: group.id,
      role: "read",
      expectedVersion: (await access.effective(f.editor)).space.policyVersion,
    });
    expect(
      (await access.effective(f.reader)).paths.map((p) => p.via),
    ).toContain(`group:${group.id}`);
    await access.removeGrant(
      f.editor,
      "reader",
      (await access.effective(f.editor)).space.policyVersion,
    );
    expect((await access.effective(f.reader)).role).toBe("read");
    await expect(
      access.removeMember(f.editor, teamId, "editor"),
    ).rejects.toThrow("LAST_OWNER");
    const i = await access.invite(f.editor, teamId, {
      principalId: "reviewer",
      kind: "owner-transfer",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      access.removeMember(f.editor, teamId, "editor"),
    ).rejects.toThrow("LAST_OWNER");
    await access.acceptInvite(f.ctx, i.id);
    expect((await access.effective(f.ctx)).space.owner).toBe(true);
    expect((await access.effective(f.editor)).space.owner).toBe(false);
    await expect(
      access.removeMember(f.ctx, teamId, "reviewer"),
    ).rejects.toThrow("LAST_OWNER");
  } finally {
    await f.pool.end();
  }
});

test("personal owner can compile and save private sources without team review, while other users and team destinations cannot", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Personal" },
          owners: [{ principalId: "editor" }],
          grants: [],
          reviewers: [],
        },
      ],
    });
    const access = new AccessService(f.pool),
      runtime = new RuntimeService(f.pool);
    const s = await access.createSpace(f.editor, { slug: f.workspaceId }),
      ctx = { ...f.editor, workspaceId: s.id };
    const source = (await import("../test-support")).source;
    await runtime.core.registerSource(ctx, { ...source, scope: "private" }, [
      "editor",
    ]);
    const b = await runtime.ingest(ctx, [source.id], "offline");
    await access.savePersonal(ctx, b.id, b.hash, "personal-save");
    expect((await runtime.pages(ctx)).length).toBeGreaterThan(0);
    await expect(
      runtime.pages({ ...ctx, principalId: "reviewer" }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      access.savePersonal(f.editor, b.id, b.hash, "wrong-space"),
    ).rejects.toThrow();
  } finally {
    await f.pool.end();
  }
});

test("credential issuance ceiling, current-rights intersection, expiry and revocation", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Token" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reader", role: "read" }],
          reviewers: [],
        },
      ],
    });
    const access = new AccessService(f.pool);
    await expect(
      access.issueCredential(f.reader, {
        actions: ["changeset.propose"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      access.issueCredential(f.editor, {
        actions: ["changeset.approve"],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    const c = await access.issueCredential(f.reader, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const ctx = await access.authenticateCredential(c.secret, f.workspaceId);
    await authorizeAction(f.pool, ctx, "knowledge.read");
    await expect(authorizeAction(f.pool, ctx, "source.create")).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(JSON.stringify(await access.credentials(f.reader))).not.toContain(
      c.secret,
    );
    await access.revokeCredential(f.reader, c.id);
    await expect(
      authorizeAction(f.pool, ctx, "knowledge.read"),
    ).rejects.toThrow("UNAUTHENTICATED");
  } finally {
    await f.pool.end();
  }
});

test("recipient shares are exact version/action/space grants, never broader than source or parent ACL; service credentials have a human sponsor", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Shares" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reader", role: "read" }],
          reviewers: [],
        },
      ],
    });
    const a = new AccessService(f.pool);
    await a.removeGrant(
      f.editor,
      "reader",
      (await a.effective(f.editor)).space.policyVersion,
    );
    const share = await a.createShare(f.editor, {
      pageId: "topic",
      version: 1,
      principalId: "reader",
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      expectedVersion: (await a.effective(f.editor)).space.policyVersion,
    });
    expect((await a.readShare(f.reader, share.id)).content).toBe("기존 내용");
    await expect(
      authorizeAction(f.pool, f.reader, "knowledge.read"),
    ).rejects.toThrow("NOT_FOUND");
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    await expect(a.readShare(f.reader, share.id)).rejects.toThrow("NOT_FOUND");
    const svc = await a.createServicePrincipal(f.editor, {
      name: "collector",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      a.issueServiceCredential(f.editor, svc.id, {
        actions: ["changeset.approve"],
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    const c = await a.issueServiceCredential(f.editor, svc.id, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    });
    const ctx = await a.authenticateCredential(c.secret);
    await authorizeAction(f.pool, ctx, "knowledge.read");
    await f.pool.query(
      "UPDATE access_principals SET active=false WHERE id='editor'",
    );
    await expect(
      authorizeAction(f.pool, ctx, "knowledge.read"),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.query(
      "UPDATE access_principals SET active=true WHERE id='editor'",
    );
    await f.pool.end();
  }
});

test("Maintain can strengthen but cannot self-designate; document-type rules and multiple independent reviewers are transactional", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Policy" },
          owners: [{ principalId: "fixture-owner" }],
          grants: [
            { principalId: "editor", role: "write" },
            { principalId: "reviewer", role: "maintain" },
            { principalId: "reader", role: "maintain" },
          ],
          reviewers: ["reviewer", "reader"],
        },
      ],
    });
    const a = new AccessService(f.pool),
      runtime = new RuntimeService(f.pool),
      owner = { ...f.ctx, principalId: "fixture-owner" };
    const policy = await a.reviewPolicy(f.ctx);
    await a.setReviewPolicy(f.ctx, {
      minimumApprovals: 2,
      reviewerIds: policy.reviewerIds,
      expectedVersion: policy.policyVersion,
    });
    await expect(
      a.setReviewPolicy(f.ctx, {
        minimumApprovals: 2,
        reviewerIds: ["reviewer"],
        expectedVersion: (await a.effective(owner)).space.policyVersion,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await a.setReviewPolicy(owner, {
      minimumApprovals: 2,
      reviewerIds: ["reviewer", "reader"],
      documentTypes: [
        {
          documentType: "기술 설계",
          minimumApprovals: 2,
          reviewerIds: ["reviewer", "reader"],
        },
      ],
      expectedVersion: (await a.effective(owner)).space.policyVersion,
    });
    const b = await runtime.ingest(f.editor, ["source-a"], "offline");
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await expect(
      runtime.core.publish(f.ctx, b.id, b.hash, "two-reviewers"),
    ).rejects.toThrow("APPROVAL_STALE");
    await runtime.core.approve(f.reader, b.id, b.hash);
    await runtime.core.publish(f.ctx, b.id, b.hash, "two-reviewers");
    expect(
      (await runtime.pages(f.reader)).find((p) => p.id === "topic")?.version,
    ).toBe(2);
  } finally {
    await f.pool.end();
  }
});

test("publication waits for the workspace policy lock then rejects revoked reviewer; expiry and issuance ceilings never grow", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Race" },
          owners: [{ principalId: "editor" }],
          grants: [
            { principalId: "reviewer", role: "maintain" },
            { principalId: "reader", role: "read" },
          ],
          reviewers: ["reviewer"],
        },
      ],
    });
    const a = new AccessService(f.pool),
      runtime = new RuntimeService(f.pool),
      b = await runtime.ingest(f.editor, ["source-a"], "offline");
    await runtime.core.approve(f.ctx, b.id, b.hash);
    const db = await f.pool.connect();
    let pending: Promise<unknown>;
    try {
      await db.query("BEGIN");
      await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        f.workspaceId,
      ]);
      await db.query(
        "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND principal_id='reviewer'",
        [f.workspaceId],
      );
      await db.query(
        "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
        [f.workspaceId],
      );
      pending = runtime.core.publish(f.editor, b.id, b.hash, "race");
      const checked = expect(pending).rejects.toThrow("APPROVAL_STALE");
      await db.query("COMMIT");
      await checked;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    expect(
      (
        await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
    const c = await a.issueCredential(f.reader, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const stored = (
      await f.pool.query("SELECT hash FROM access_credentials WHERE id=$1", [
        c.id,
      ])
    ).rows[0].hash;
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(stored).not.toBe(c.secret);
    await a.setGrant(f.editor, {
      principalId: "reader",
      role: "write",
      expectedVersion: (await a.effective(f.editor)).space.policyVersion,
    });
    const tokenCtx = await a.authenticateCredential(c.secret);
    await expect(
      authorizeAction(f.pool, tokenCtx, "changeset.propose"),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      a.authenticateCredential(c.secret, "another-space"),
    ).rejects.toThrow("NOT_FOUND");
    await f.pool.query(
      "UPDATE access_credentials SET expires_at=now()-interval '1 second' WHERE id=$1",
      [c.id],
    );
    await expect(a.authenticateCredential(c.secret)).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    const audit = JSON.stringify(
      (
        await f.pool.query(
          "SELECT data FROM access_audit WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    );
    expect(audit).not.toContain(c.secret);
    expect(audit).not.toContain(stored);
  } finally {
    await f.pool.end();
  }
});

test("local.copy delegated tokens need explicit scope plus current per-source egress permission; personal.sync is not a copy grant", async () => {
  const f = await fixture();
  try {
    await bootstrapAccess(f.pool, {
      spaces: [
        {
          workspaceId: f.workspaceId,
          team: { slug: f.workspaceId, name: "Egress" },
          owners: [{ principalId: "editor" }],
          grants: [{ principalId: "reader", role: "read" }],
          reviewers: [],
        },
      ],
    });
    const a = new AccessService(f.pool);
    const copy = await a.issueCredential(f.reader, {
      actions: ["knowledge.read", "local.copy"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const ctx = await a.authenticateCredential(copy.secret);
    await expect(
      authorizeAction(f.pool, ctx, "local.copy", { kind: "page", id: "topic" }),
    ).rejects.toThrow("FORBIDDEN");
    await a.setSourcePolicy(f.editor, "source-a", {
      localCopyAllowed: true,
      exportAllowed: false,
      expectedVersion: (await a.effective(f.editor)).space.policyVersion,
    });
    await authorizeAction(f.pool, ctx, "local.copy", {
      kind: "page",
      id: "topic",
    });
    const sync = await a.issueCredential(f.editor, {
      actions: ["knowledge.read", "personal.sync"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await expect(
      authorizeAction(
        f.pool,
        await a.authenticateCredential(sync.secret),
        "local.copy",
        { kind: "page", id: "topic" },
      ),
    ).rejects.toThrow("FORBIDDEN");
    await a.setSourcePolicy(f.editor, "source-a", {
      localCopyAllowed: false,
      exportAllowed: false,
      expectedVersion: (await a.effective(f.editor)).space.policyVersion,
    });
    await expect(
      authorizeAction(f.pool, ctx, "local.copy", { kind: "page", id: "topic" }),
    ).rejects.toThrow("FORBIDDEN");
  } finally {
    await f.pool.end();
  }
});

test("trusted core integration hooks commit atomically and roll back proposals, resources, snapshots and audit together", async () => {
  const f = await fixture();
  try {
    const { source } = await import("../test-support"),
      { KnowledgeService } = await import("../service"),
      { propose } = await import("../publication");
    const core = new KnowledgeService(f.pool);
    await expect(
      core.registerSource(
        f.editor,
        { ...source, id: "hook-source" },
        ["editor"],
        async (db) => {
          await db.query(
            "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,'editor','hook','hook-source')",
            [f.workspaceId],
          );
          throw Error("HOOK_FAILED");
        },
      ),
    ).rejects.toThrow("HOOK_FAILED");
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM sources WHERE workspace_id=$1 AND id='hook-source'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM resources WHERE workspace_id=$1 AND id='hook-source'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    await expect(
      propose(
        f.pool,
        f.editor,
        [
          {
            id: "topic",
            title: "주제",
            summary: "변경",
            content: "새 내용",
            scope: "team",
            links: [],
            sourceIds: [source.id],
            facts: [],
            baseVersion: 1,
          },
        ],
        [source.id],
        {
          onCreated: async (db, b) => {
            await db.query(
              "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,'editor','hook',$2)",
              [f.workspaceId, b.id],
            );
            throw Error("HOOK_FAILED");
          },
        },
      ),
    ).rejects.toThrow("HOOK_FAILED");
    expect(
      (
        await f.pool.query("SELECT 1 FROM batches WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM audit WHERE workspace_id=$1 AND operation='hook'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.end();
  }
});
