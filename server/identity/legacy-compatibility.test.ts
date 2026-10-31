import { createServer, type IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import * as oidc from "openid-client";
import { expect, test } from "vitest";
import { migrate } from "../database";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { authorizeAction } from "../access/index";

test("actual released-schema upgrade: archived verified legacy reviewer authenticates but ownerless workload remains quarantined, not silently declared compatible", async () => {
  if (!process.env.TEST_DATABASE_URL) throw Error("TEST_DATABASE_URL_REQUIRED");
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
    schema = "identity_legacy_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const subject = "previously-verified-reviewer";
  const provider = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sub: subject, groups: ["legacy-reviewers"] }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const address = provider.address();
  if (!address || typeof address === "string") throw Error("FIXTURE_LISTEN");
  const issuer = `http://127.0.0.1:${address.port}`,
    principalId = sessionHash(issuer + "\0" + subject);
  try {
    await pool.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^00[1-7]-.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        Number(name.split("-")[0]),
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
    await pool.query(
      "INSERT INTO workspaces VALUES('verified-legacy'),('unknown-legacy')",
    );
    await pool.query(
      "INSERT INTO memberships VALUES('verified-legacy',$1,'reviewer'),('unknown-legacy',$1,'reviewer')",
      [principalId],
    );
    await pool.query(
      "INSERT INTO access_principals(id,display_name) VALUES($1,'Historical verified user')",
      [principalId],
    );
    await pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'verified-legacy',$2,'csrf',$3,'fixture-only',clock_timestamp()+interval '1 hour')",
      [sessionHash("old-" + schema), principalId, subject],
    );
    await pool.query(
      "INSERT INTO resources VALUES('verified-legacy','page','topic')",
    );
    await pool.query(
      "INSERT INTO resource_readers VALUES('verified-legacy','page','topic',$1)",
      [principalId],
    );
    const before = (
      await pool.query(
        "SELECT * FROM resource_readers WHERE workspace_id='verified-legacy'",
      )
    ).rows;
    await migrate(pool);
    expect(
      (
        await pool.query(
          "SELECT principal_id,subject FROM legacy_v1_identity_subjects",
        )
      ).rows,
    ).toEqual([{ principal_id: principalId, subject }]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM access_spaces WHERE workspace_id IN ('verified-legacy','unknown-legacy')",
        )
      ).rowCount,
    ).toBe(0);
    const config = new oidc.Configuration(
      { issuer, userinfo_endpoint: issuer + "/userinfo" },
      "client",
      "fixture-only",
    );
    oidc.allowInsecureRequests(config);
    const auth = new OidcAuth(
      pool,
      config,
      "http://localhost",
      "verified-legacy",
      { "legacy-reviewers": "reviewer" },
    );
    const raw = randomUUID();
    await pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,'verified-legacy',$2,'csrf',$3,'fixture-only',clock_timestamp()+interval '1 hour')",
      [sessionHash(raw), principalId, subject],
    );
    const req = {
        headers: { cookie: `akh_session=${raw}` },
      } as IncomingMessage,
      session = await auth.authenticate(req);
    expect(session?.identityRole).toBe("reviewer");
    expect(session?.spaceRole).toBeNull();
    const ctx = {
      ...session!,
      authorization: auth.requestGuard(req, session!),
    };
    await expect(
      authorizeAction(pool, ctx, "knowledge.read", {
        kind: "page",
        id: "topic",
        version: 1,
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(authorizeAction(pool, ctx, "space.admin")).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(
      authorizeAction(pool, ctx, "policy.strengthen"),
    ).rejects.toThrow("NOT_FOUND");
    expect(
      (
        await pool.query(
          "SELECT * FROM resource_readers WHERE workspace_id='verified-legacy'",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query("SELECT id FROM access_namespaces WHERE owner_id=$1", [
          principalId,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await new Promise<void>((r) => provider.close(() => r()));
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
