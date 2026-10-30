import { test, expect } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { generateKeyPairSync, sign, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { fixture, adoptFixture, source } from "../test-support";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import {
  captureRecoveryLedger,
  readRecoveryLedger,
  secureRestoredDatabase,
  assertOperationalStartup,
  refreshRestoredLedger,
} from "./recovery";
import {
  previewCurrentPolicyRelease,
  releaseCurrentPolicy,
  verifiedRestoreIdentity,
} from "./current-policy";
import { sealExport } from "./service";
import { assertReleasedImportContext } from "./released-imports";
const digest = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const base = [
  "--context",
  "kind-knowledge-hub-dev",
  "-n",
  "agent-knowledge-hub-local",
  "exec",
  "-i",
  "knowledge-db-0",
  "--",
];
const run = (args: string[], input?: Buffer) =>
  execFileSync("kubectl", [...base, ...args], {
    input,
    stdio: "pipe",
    maxBuffer: 128 * 1024 * 1024,
  });
async function isolatedRecoveryFixture() {
  const original = process.env.TEST_DATABASE_URL!;
  const control = new Pool({ connectionString: original }),
    name = "akh_ops_source_" + randomUUID().replaceAll("-", "");
  await control.query(`CREATE DATABASE ${name}`);
  const url = new URL(original);
  url.pathname = "/" + name;
  try {
    process.env.TEST_DATABASE_URL = url.href;
    const f = await fixture();
    return {
      f,
      cleanup: async () => {
        await control.query(`DROP DATABASE ${name}`);
        await control.end();
      },
    };
  } catch (e) {
    await control.query(`DROP DATABASE ${name}`);
    await control.end();
    throw e;
  } finally {
    process.env.TEST_DATABASE_URL = original;
  }
}
test("actual dump restore→signed current owner/qualified reviewer import→explicit release→actual NEW OIDC login only", async () => {
  if (
    !/^akh_[a-zA-Z0-9_]+$/.test(
      new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1),
    )
  )
    throw Error("ISOLATED_TEST_DATABASE_REQUIRED");
  const { f, cleanup } = await isolatedRecoveryFixture();
  const sourceDatabase = (
    await f.pool.query("SELECT current_database() AS name")
  ).rows[0].name;
  await adoptFixture(f.pool, f.workspaceId);
  let restored: Pool | undefined,
    app: Server | undefined,
    provider: Server | undefined,
    created = false;
  const database = "akh_ops_restore_" + randomUUID().replaceAll("-", ""),
    key = "recovery-encryption".repeat(4),
    signing = "independent-current-policy".repeat(3);
  let issuer = "",
    nonce = "";
  try {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    provider = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/realm/.well-known/openid-configuration")
        return res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            jwks_uri: issuer + "/jwks",
            userinfo_endpoint: issuer + "/userinfo",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      if (req.url === "/realm/jwks")
        return res.end(
          JSON.stringify({
            keys: [
              {
                ...publicKey.export({ format: "jwk" }),
                kid: "recovery",
                alg: "RS256",
                use: "sig",
              },
            ],
          }),
        );
      if (req.url === "/realm/userinfo")
        return res.end(
          JSON.stringify({ sub: "owner", groups: ["current-org"] }),
        );
      if (req.url === "/realm/token") {
        let body = "";
        for await (const b of req) body += b;
        const d = new URLSearchParams(body);
        if (d.get("code") !== "valid" || !d.get("code_verifier")) {
          res.writeHead(400);
          return res.end("{}");
        }
        const now = Math.floor(Date.now() / 1000),
          unsigned =
            Buffer.from(
              JSON.stringify({ alg: "RS256", kid: "recovery" }),
            ).toString("base64url") +
            "." +
            Buffer.from(
              JSON.stringify({
                iss: issuer,
                sub: "owner",
                aud: "knowledge-hub",
                iat: now,
                exp: now + 300,
                nonce,
              }),
            ).toString("base64url");
        return res.end(
          JSON.stringify({
            access_token: "new-live-token",
            token_type: "Bearer",
            expires_in: 300,
            id_token:
              unsigned +
              "." +
              sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString(
                "base64url",
              ),
          }),
        );
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise<void>((r) => provider!.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}/realm`;
    const owner = digest(issuer + "\0owner"),
      reviewer = digest(issuer + "\0qualified-reviewer");
    await f.pool.query(
      "INSERT INTO access_principals(id,issuer,subject) VALUES($1,$2,'owner')",
      [owner, issuer],
    );
    await f.pool.query("INSERT INTO memberships VALUES($1,$2,'reader')", [
      f.workspaceId,
      owner,
    ]);
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','source-a',$2)",
      [f.workspaceId, owner],
    );
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,$3,'csrf','owner','old-token',now()+interval '1 hour')",
      [sessionHash("old-cookie"), f.workspaceId, owner],
    );
    if (
      !(await f.pool.query("SELECT to_regclass('public.imports') AS t")).rows[0]
        .t
    )
      await f.pool.query(
        execFileSync(
          "git",
          ["show", "origin/main:server/migrations/006-imports.sql"],
          { encoding: "utf8" },
        ),
      );
    await f.pool.query(
      "INSERT INTO imports(workspace_id,id,principal_id,title,selection,parsed,request_key,request_hash,status) VALUES($1,'retained-input',$2,'retained input','{}','{\"records\":[],\"warnings\":[]}',$3,$4,'ready')",
      [f.workspaceId, owner, randomUUID(), "a".repeat(64)],
    );
    await f.pool.query(
      "INSERT INTO access_credentials(id,hash,principal_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",
      [
        randomUUID(),
        digest("old-secret"),
        owner,
        f.workspaceId,
        ["knowledge.read"],
      ],
    );
    const ledger = readRecoveryLedger(
        await captureRecoveryLedger(f.pool, key, signing),
        key,
        signing,
      ),
      dump = run(["pg_dump", "-U", "knowledge", "-d", sourceDatabase, "-Fc"]),
      sourceSystem = (
        await f.pool.query(
          "SELECT system_identifier::text AS id FROM pg_control_system()",
        )
      ).rows[0].id;
    run(["createdb", "-U", "knowledge", database]);
    created = true;
    run(
      [
        "pg_restore",
        "-U",
        "knowledge",
        "--no-owner",
        "--exit-on-error",
        "-d",
        database,
      ],
      dump,
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    restored = new Pool({ connectionString: url.href });
    await expect(
      secureRestoredDatabase(restored, {
        ...ledger,
        version: 2,
        legalHolds: undefined,
      }),
    ).rejects.toThrow("CURRENT_LEGAL_HOLDS_REQUIRED");
    await expect(assertOperationalStartup(restored)).rejects.toThrow(
      "QUARANTINED",
    );
    expect(
      (await restored.query("SELECT count(*) FROM runtime_sessions")).rows[0]
        .count,
    ).toBe("0");
    await secureRestoredDatabase(restored, ledger, {
      backupId: "signed-backup-fixture",
      database: sourceDatabase,
      systemIdentifier: sourceSystem,
      databaseSha256: digest(dump),
    });
    expect(
      Number(
        (await restored.query("SELECT count(*) FROM runtime_sessions")).rows[0]
          .count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await restored.query(
            "SELECT count(*) FROM access_credentials WHERE NOT revoked",
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (await restored.query("SELECT count(*) FROM approvals")).rows[0].count,
      ),
    ).toBe(0);
    await expect(assertOperationalStartup(restored)).rejects.toThrow(
      "QUARANTINED",
    );
    const savedBefore = (
      await restored.query("SELECT count(*) FROM operations_recovery_acl")
    ).rows[0].count;
    await restored.query(
      "UPDATE operations_recovery_releases SET policy_hash='recovery-ledger:2020-01-01T00:00:00Z' WHERE id='restore-binding'",
    );
    await expect(verifiedRestoreIdentity(restored)).rejects.toThrow(
      "RECOVERY_LEDGER_STALE_REPLAY_REQUIRED",
    );
    await refreshRestoredLedger(restored, ledger);
    expect(
      (await restored.query("SELECT count(*) FROM operations_recovery_acl"))
        .rows[0].count,
    ).toBe(savedBefore);
    const identity = await verifiedRestoreIdentity(restored),
      spaces = (
        await restored.query("SELECT id FROM workspaces ORDER BY id")
      ).rows.map((r) => ({
        workspaceId: r.id,
        namespaceId: "recovery-current-team",
        kind: "team",
        slug: r.id,
        visibility: "private",
        owners: [owner],
        grants: [{ principalId: reviewer, role: "maintain" }],
        reviewers: [
          {
            principalId: reviewer,
            qualified: true,
            qualifiedAt: new Date().toISOString(),
          },
        ],
        minimumApprovals: 1,
        readers:
          r.id === f.workspaceId
            ? [{ kind: "source", id: "source-a", principalIds: [owner] }]
            : [],
      }));
    const policy = {
      version: 2,
      collectedAt: new Date().toISOString(),
      maxAgeMs: 900000,
      organization: {
        id: "current-org",
        active: true,
        members: [owner, reviewer],
      },
      ...identity,
      operators: [owner],
      principals: [
        {
          principalId: owner,
          issuer,
          subject: "owner",
          kind: "human",
          active: true,
          teamCreate: false,
        },
        {
          principalId: reviewer,
          issuer,
          subject: "qualified-reviewer",
          kind: "human",
          active: true,
          teamCreate: false,
        },
      ],
      teams: [
        {
          id: "recovery-current-team",
          slug: "recovery-current-team",
          name: "Current organization team",
          members: [
            { principalId: owner, role: "owner", active: true },
            { principalId: reviewer, role: "member", active: true },
          ],
        },
      ],
      spaces,
    };
    const config = {
      encrypted: sealExport(policy, key, signing),
      key,
      signingKey: signing,
      operatorId: owner,
    };
    const preview = await previewCurrentPolicyRelease(restored, config);
    const unusedPreview = await previewCurrentPolicyRelease(restored, config);
    await expect(
      releaseCurrentPolicy(restored, {
        ...config,
        previewId: preview.id,
        previewHash: "0".repeat(64),
        confirm: "RELEASE_VERIFIED_CURRENT_POLICY_NEW_SSO_ONLY",
      }),
    ).rejects.toThrow();
    await expect(assertOperationalStartup(restored)).rejects.toThrow(
      "QUARANTINED",
    );
    expect(spaces.some((s) => s.workspaceId === f.workspaceId)).toBe(true);
    const widened = {
      ...policy,
      spaces: spaces.map((s) =>
        s.workspaceId === f.workspaceId
          ? {
              ...s,
              readers: [
                { kind: "source", id: "source-a", principalIds: [reviewer] },
              ],
            }
          : s,
      ),
    };
    await expect(
      previewCurrentPolicyRelease(restored, {
        ...config,
        encrypted: sealExport(widened, key, signing),
      }),
    ).rejects.toThrow("RAW_ACL_WIDENING");
    expect(
      await releaseCurrentPolicy(restored, {
        ...config,
        previewId: preview.id,
        previewHash: preview.previewHash,
        confirm: "IMPORT_CURRENT_POLICY_KEEP_QUARANTINE",
        keepQuarantined: true,
      }),
    ).toMatchObject({ released: false, quarantined: true });
    await expect(assertOperationalStartup(restored)).rejects.toThrow(
      "QUARANTINED",
    );
    expect(
      (await restored.query("SELECT count(*) FROM resource_readers")).rows[0]
        .count,
    ).toBe("0");
    expect(
      await releaseCurrentPolicy(restored, {
        ...config,
        previewId: preview.id,
        previewHash: preview.previewHash,
        confirm: "RELEASE_VERIFIED_CURRENT_POLICY_NEW_SSO_ONLY",
      }),
    ).toMatchObject({ released: true, requiresNewSsoLogin: true });
    await assertOperationalStartup(restored);
    const unauthenticatedGuard=await restored.connect();try{
    await expect(
      assertReleasedImportContext(
        unauthenticatedGuard,
        { workspaceId: f.workspaceId, principalId: owner },
        "retained-input",
      ),
    ).rejects.toThrow("AUTHORIZATION_REQUIRED");
    }finally{unauthenticatedGuard.release();}
    expect(
      (
        await restored.query(
          "SELECT count(*) FROM access_team_members WHERE principal_id='fixture-owner' AND active AND role='owner'",
        )
      ).rows[0].count,
    ).toBe("0");
    app = createServer();
    await new Promise<void>((r) => app!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`,
      oldEnv = { ...process.env };
    let auth: OidcAuth;
    Object.assign(process.env, {
      APP_ORIGIN: origin,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: "knowledge-hub",
      OIDC_CLIENT_SECRET: "fixture",
      OIDC_ALLOW_HTTP: "true",
      OIDC_GROUP_ROLES: JSON.stringify({ "current-org": "reader" }),
      WORKSPACE_ID: f.workspaceId,
      NODE_ENV: "test",
    });
    try {
      auth = await OidcAuth.create(restored);
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in oldEnv)) delete process.env[k];
      Object.assign(process.env, oldEnv);
    }
    app.on(
      "request",
      createRuntimeHandler({
        pool: restored,
        service: new RuntimeService(restored),
        auth,
        origin,
        workspaceId: f.workspaceId,
      }),
    );
    expect(
      (
        await fetch(origin + "/api/v1/sources", {
          headers: { Cookie: "akh_session=old-cookie" },
        })
      ).status,
    ).toBe(401);
    const login = await fetch(origin + "/auth/login", { redirect: "manual" }),
      authorization = new URL(login.headers.get("location")!);
    nonce = authorization.searchParams.get("nonce")!;
    const callback = await fetch(
      origin +
        "/auth/callback?code=valid&state=" +
        authorization.searchParams.get("state"),
      {
        redirect: "manual",
        headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
      },
    );
    expect(callback.status).toBe(302);
    const cookie = callback.headers.get("set-cookie")!.split(";")[0];
    const authenticatedRequest = { headers: { cookie } } as IncomingMessage,
      authenticated = await auth.authenticate(authenticatedRequest);
    expect(authenticated).not.toBeNull();
    const authenticatedGuard=await restored.connect();try{
    await assertReleasedImportContext(
      authenticatedGuard,
      {
        ...authenticated!,
        authorization: auth.requestGuard(authenticatedRequest, authenticated!),
      },
      "retained-input",
    );
    }finally{authenticatedGuard.release();}
    const read = await fetch(origin + "/api/v1/sources", {
      headers: { Cookie: cookie },
    });
    expect(read.status).toBe(200);
    expect((await read.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source-a", content: source.content }),
      ]),
    );
    expect(
      (await restored.query("SELECT count(*) FROM runtime_sessions")).rows[0]
        .count,
    ).toBe("1");
    await expect(
      releaseCurrentPolicy(restored, {
        ...config,
        previewId: unusedPreview.id,
        previewHash: unusedPreview.previewHash,
        confirm: "RELEASE_VERIFIED_CURRENT_POLICY_NEW_SSO_ONLY",
      }),
    ).rejects.toThrow("RESTORE_NOT_QUARANTINED");
    expect(
      (await restored.query("SELECT count(*) FROM runtime_sessions")).rows[0]
        .count,
    ).toBe("1");
  } finally {
    if (app) await new Promise<void>((r) => app!.close(() => r()));
    if (provider) await new Promise<void>((r) => provider!.close(() => r()));
    await restored?.end();
    await f.pool.end();
    if (created) run(["dropdb", "-U", "knowledge", database]);
    await cleanup();
  }
}, 120000);
