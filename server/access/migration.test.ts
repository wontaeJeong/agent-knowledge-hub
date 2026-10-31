import { expect, test } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { migrate, assertSchemaCurrent } from "../database";
import { authorizeAction, syncIdentity } from "./index";
import { LegacyAccessService, registerPrincipal } from "./legacy-adapter";

test("released001..009 data adopts through010..015 preserving IDs, raw ACLs, disabled identities and independent authors without unowned-role fallback", async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error("TEST_DATABASE_URL_REQUIRED");
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    schema = "access_upgrade_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 6,
  });
  const issuer = "https://legacy-migration.invalid",
    pid = (subject: string) =>
      createHash("sha256")
        .update(issuer + "\0" + subject)
        .digest("hex");
  const owner = pid("owner"),
    reviewer = pid("reviewer"),
    reader = pid("reader"),
    disabled = pid("disabled"),
    personal = "personal-" + owner;
  try {
    await pool.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)",
    );
    const directory = new URL("../migrations/", import.meta.url),
      files = (await readdir(directory))
        .filter((n) => /^00[1-9]-.*\.sql$/.test(n))
        .sort();
    expect(files).toHaveLength(9);
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        Number(name.split("-")[0]),
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
    await expect(assertSchemaCurrent(pool)).rejects.toThrow(
      "SCHEMA_NOT_CURRENT",
    );
    await pool.query(
      "INSERT INTO workspaces VALUES('legacy-space'),('quarantined-legacy'),($1)",
      [personal],
    );
    for (const [who, role] of [
      [owner, "editor"],
      [reviewer, "reviewer"],
      [reader, "reader"],
      [disabled, "reviewer"],
    ]) {
      await pool.query("INSERT INTO memberships VALUES('legacy-space',$1,$2)", [
        who,
        role,
      ]);
      await pool.query(
        "INSERT INTO access_principals(id,display_name,enabled) VALUES($1,'Same display name',$2)",
        [who, who !== disabled],
      );
    }
    await pool.query(
      "INSERT INTO memberships VALUES('quarantined-legacy',$1,'reviewer'),($2,$3,'reviewer')",
      [reviewer, personal, owner],
    );
    await pool.query(
      "INSERT INTO access_orgs VALUES('legacy-org','조직 이름');INSERT INTO access_teams VALUES('legacy-team','legacy-org','Engineering')",
    );
    for (const who of [owner, reviewer, reader, disabled])
      await pool.query(
        "INSERT INTO access_org_members VALUES('legacy-org',$1,$2)",
        [who, who === owner ? "owner" : "member"],
      );
    await pool.query(
      "INSERT INTO access_team_members VALUES('legacy-org','legacy-team',$1)",
      [reader],
    );
    await pool.query(
      "INSERT INTO access_spaces(workspace_id,name,org_id,revision) VALUES('legacy-space','공간 이름','legacy-org',7)",
    );
    await pool.query(
      "INSERT INTO access_spaces(workspace_id,name,owner_id) VALUES($1,'개인 이름',$2)",
      [personal, owner],
    );
    await pool.query(
      "INSERT INTO access_grants(id,workspace_id,principal_id,team_id,role,expires_at,granted_by) VALUES('maintain','legacy-space',$1,null,'Maintain',null,$2),('expired','legacy-space',$3,null,'Read',now()-interval '1 second',$2),('group','legacy-space',null,'legacy-team','Write',now()+interval '1 hour',$2)",
      [reviewer, owner, reader],
    );
    await pool.query("INSERT INTO access_reviewers VALUES('legacy-space',$1)", [
      reviewer,
    ]);
    await pool.query(
      "INSERT INTO access_invitations(id,org_id,principal_id,role,invited_by,expires_at) VALUES('pending-owner','legacy-org',$1,'owner',$2,now()+interval '1 day')",
      [reader, owner],
    );
    await pool.query(
      "INSERT INTO access_audit(actor_id,operation,resource_id,details) VALUES($1,'organization.create','legacy-org','{\"name\":\"조직 이름\"}')",
      [owner],
    );
    for (const kind of ["source", "page"]) {
      await pool.query("INSERT INTO resources VALUES('legacy-space',$1,$2)", [
        kind,
        kind === "source" ? "raw" : "topic",
      ]);
      for (const who of [owner, reviewer])
        await pool.query(
          "INSERT INTO resource_readers VALUES('legacy-space',$1,$2,$3)",
          [kind, kind === "source" ? "raw" : "topic", who],
        );
    }
    const raw = { id: "raw", content: "immutable input", scope: "team" };
    await pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES('legacy-space','raw',$1)",
      [raw],
    );
    await pool.query(
      "INSERT INTO pages(workspace_id,id,data) VALUES('legacy-space','topic',$1)",
      [
        {
          id: "topic",
          title: "기존 제목",
          summary: "기존 내용",
          scope: "team",
          links: [],
        },
      ],
    );
    await pool.query(
      "INSERT INTO versions VALUES('legacy-space','topic',1,$1)",
      [{ number: 1, content: "기존 내용", sourceIds: ["raw"] }],
    );
    await pool.query(
      "INSERT INTO batches VALUES('legacy-space','known-author',$1,'fixed-hash'),('legacy-space','unknown-author','{\"status\":\"pending\"}','unknown-hash')",
      [{ status: "approved", proposedBy: reviewer, importAuthorId: owner }],
    );
    await pool.query(
      "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash) VALUES('legacy-space','known-author',$1,'fixed-hash')",
      [reviewer],
    );
    await pool.query(
      "INSERT INTO access_triage VALUES('legacy-space','known-author',$1,'needs-review')",
      [reader],
    );
    await pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES('old-session','legacy-space',$1,'csrf','owner','not-preserved-as-a-credential',now()+interval '1 hour')",
      [owner],
    );
    const before = (
      await pool.query("SELECT * FROM resource_readers ORDER BY 1,2,3,4")
    ).rows;
    await migrate(pool);
    await migrate(pool);
    await assertSchemaCurrent(pool);
    expect(
      (
        await pool.query(
          "SELECT namespace_id,name,policy_version FROM access_spaces WHERE workspace_id='legacy-space'",
        )
      ).rows[0],
    ).toMatchObject({
      namespace_id: "legacy-org",
      name: "공간 이름",
      policy_version: 7,
    });
    expect(
      (
        await pool.query(
          "SELECT team_id,name FROM access_groups WHERE id='legacy-team'",
        )
      ).rows[0],
    ).toEqual({ team_id: "legacy-org", name: "Engineering" });
    for (const [who, expected] of [
      [owner, "Admin"],
      [reviewer, "Maintain"],
      [reader, "Write"],
      [disabled, null],
    ])
      expect(
        (
          await pool.query("SELECT access_role('legacy-space',$1) AS role", [
            who,
          ])
        ).rows[0].role,
      ).toBe(expected);
    expect(
      (
        await pool.query(
          "SELECT effective_membership('quarantined-legacy',$1) AS role",
          [reviewer],
        )
      ).rows[0].role,
    ).toBeNull();
    expect(
      (await pool.query("SELECT * FROM resource_readers ORDER BY 1,2,3,4"))
        .rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT data FROM sources WHERE workspace_id='legacy-space' AND id='raw'",
        )
      ).rows[0].data,
    ).toEqual(raw);
    expect((await pool.query("SELECT 1 FROM approvals")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM runtime_sessions")).rowCount).toBe(
      0,
    );
    expect(
      (
        await pool.query(
          "SELECT principal_id FROM access_batch_authors WHERE batch_id='known-author'",
        )
      ).rows[0].principal_id,
    ).toBe(owner);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM access_batch_authors WHERE batch_id='unknown-author'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT data->>'status' AS status,hash FROM batches WHERE id='known-author'",
        )
      ).rows[0],
    ).toEqual({ status: "pending", hash: "fixed-hash" });
    expect(
      (
        await pool.query(
          "SELECT label FROM access_triage WHERE batch_id='known-author'",
        )
      ).rows[0].label,
    ).toBe("needs-review");
    await expect(
      authorizeAction(
        pool,
        { workspaceId: "legacy-space", principalId: reader },
        "knowledge.read",
        { kind: "page", id: "topic" },
      ),
    ).rejects.toThrow("NOT_FOUND");
    await syncIdentity(pool, { issuer, subject: "owner" });
    await expect(
      syncIdentity(pool, { issuer, subject: "disabled" }),
    ).rejects.toThrow("UNAUTHENTICATED");
    await expect(
      registerPrincipal(pool, disabled, "Still same name"),
    ).rejects.toThrow("FORBIDDEN");
    expect(
      (
        await pool.query("SELECT active FROM access_principals WHERE id=$1", [
          disabled,
        ])
      ).rows[0].active,
    ).toBe(false);
    const adapter = new LegacyAccessService(pool),
      ctx = { workspaceId: "legacy-space", principalId: owner };
    expect((await adapter.state(ctx)).space).toMatchObject({
      id: "legacy-space",
      name: "공간 이름",
      orgId: "legacy-org",
      organization: "조직 이름",
      role: "Admin",
      revision: 7,
    });
    expect(
      (await adapter.invitations({ ...ctx, principalId: reader }))[0],
    ).toMatchObject({
      id: "pending-owner",
      role: "owner",
      orgId: "legacy-org",
    });
    await adapter.invitation(
      { ...ctx, principalId: reader },
      "pending-owner",
      "accept",
    );
    expect(
      (
        await pool.query(
          "SELECT principal_id FROM access_team_members WHERE team_id='legacy-org' AND role='owner' AND active ORDER BY principal_id",
        )
      ).rows
        .map((r) => r.principal_id)
        .sort(),
    ).toEqual([owner, reader].sort());
    await pool.query(
      "UPDATE access_grants SET revoked=true WHERE id='maintain'",
    );
    expect(
      (
        await pool.query(
          "SELECT effective_membership('legacy-space',$1) AS role",
          [reviewer],
        )
      ).rows[0].role,
    ).toBeNull();
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
