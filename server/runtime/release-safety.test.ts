import { expect, test } from "vitest";
import { Pool } from "pg";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as oidc from "openid-client";
import * as database from "../database";
import { fixture, source } from "../test-support";
import { RuntimeService } from "./knowledge";
import { OidcAuth, sessionHash } from "./auth";
import { createRuntimeHandler } from "./http";

async function connection(
  runtime: RuntimeService,
  workspaceId: string,
  onInfo?: (count: number) => Promise<void>,
) {
  let groups = ["writers"];
  let active = true;
  const pool = runtime.pool;
  if (
    (await pool.query("SELECT to_regclass('access_spaces') AS present")).rows[0]
      .present
  )
    await (await import("../test-support")).adoptFixture(pool, workspaceId);
  let count = 0;
  const provider = createServer(async (_req, res) => {
    await onInfo?.(++count);
    res.setHeader("Content-Type", "application/json");
    if (!active) {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    res.end(JSON.stringify({ sub: "editor", groups }));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const token = randomUUID();
  await pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,subject,access_token,expires_at) VALUES($1,$2,'editor','csrf','editor','token',now()+interval '1 hour')",
    [sessionHash(token), workspaceId],
  );
  const server = createServer(
    createRuntimeHandler({
      pool,
      service: runtime,
      auth: new OidcAuth(pool, config, "http://localhost", workspaceId, {
        writers: "editor",
        readers: "reader",
      }),
      origin: "http://localhost",
      workspaceId,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    headers: {
      Cookie: `akh_session=${token}`,
      Origin: "http://localhost",
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    token,
    setGroups: (value: string[]) => (groups = value),
    disable: () => (active = false),
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => provider.close(() => r())),
      ]);
    },
  };
}
test("image schema gate rejects004 and wrong checksums, then005 enables protected access with recovered provenance", async () => {
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "gate_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    await pool.query(
      "CREATE TABLE schema_migrations(version integer PRIMARY KEY,hash text NOT NULL)",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => /^00[1-4]-.*\.sql$/.test(n))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations VALUES($1,$2)", [
        Number(name.split("-")[0]),
        createHash("sha256").update(sql).digest("hex"),
      ]);
    }
    await pool.query("INSERT INTO workspaces VALUES('legacy')");
    await pool.query(
      "INSERT INTO memberships VALUES('legacy','editor','editor')",
    );
    await pool.query(
      "INSERT INTO resources VALUES('legacy','source','s'),('legacy','page','context'),('legacy','page','derived')",
    );
    await pool.query(
      "INSERT INTO resource_readers VALUES('legacy','source','s','editor'),('legacy','page','derived','editor')",
    );
    await pool.query(
      "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
      ["legacy", "s", { ...source, id: "s" }],
    );
    for (const id of ["context", "derived"]) {
      await pool.query(
        "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",
        [
          "legacy",
          id,
          {
            id,
            title: "legacy secret " + id,
            summary: "legacy",
            scope: "team",
            links: [],
          },
        ],
      );
      await pool.query("INSERT INTO versions VALUES($1,$2,1,$3)", [
        "legacy",
        id,
        {
          id: "v-" + id,
          number: 1,
          content: "legacy secret",
          sourceIds: ["s"],
        },
      ]);
    }
    await pool.query("INSERT INTO batches VALUES($1,$2,$3,$4)", [
      "legacy",
      "legacy-batch",
      {
        snapshots: [{ ...source, id: "s" }],
        contextDependencyIds: ["context"],
        mode: "model",
        status: "published",
      },
      "unused",
    ]);
    await pool.query("INSERT INTO publications VALUES($1,$2,$3)", [
      "legacy",
      "legacy-batch",
      { batchId: "legacy-batch", versions: { derived: 1 } },
    ]);
    const runtime = new RuntimeService(pool);
    client = await connection(runtime, "legacy");
    expect(
      typeof (database as Record<string, unknown>).assertSchemaCurrent,
    ).toBe("function");
    const assertCurrent = (
      database as typeof database & {
        assertSchemaCurrent: (pool: Pool) => Promise<void>;
      }
    ).assertSchemaCurrent;
    await expect(assertCurrent(pool)).rejects.toThrow("SCHEMA_NOT_CURRENT");
    expect((await fetch(client.base + "/readyz")).status).toBe(503);
    expect(
      (await fetch(client.base + "/api/v1/pages", { headers: client.headers }))
        .status,
    ).toBe(503);
    const startupUrl = new URL(process.env.TEST_DATABASE_URL!);
    startupUrl.searchParams.set("options", `-c search_path=${schema}`);
    const startup = spawnSync(
      process.execPath,
      ["--import", "tsx", "server/runtime/main.ts"],
      {
        env: { ...process.env, DATABASE_URL: startupUrl.href },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(startup.status).toBe(1);
    expect(startup.stderr).toContain("SCHEMA_NOT_CURRENT");
    expect(
      (
        await pool.query(
          "SELECT version FROM schema_migrations WHERE version=5",
        )
      ).rowCount,
    ).toBe(0);
    await database.migrate(pool);
    await (await import("../test-support")).adoptFixture(pool, "legacy");
    // Migration intentionally invalidates old sessions; re-authenticate the explicit fixture.
    await client.close();
    client = await connection(runtime, "legacy");
    await expect(assertCurrent(pool)).resolves.toBeUndefined();
    expect((await fetch(client.base + "/readyz")).status).toBe(200);
    const pages = await fetch(client.base + "/api/v1/pages", {
      headers: client.headers,
    });
    expect(pages.status).toBe(200);
    expect(await pages.json()).toEqual({ items: [] });
    const original = (
      await pool.query("SELECT hash FROM schema_migrations WHERE version=5")
    ).rows[0].hash;
    await pool.query(
      "UPDATE schema_migrations SET hash='wrong' WHERE version=5",
    );
    await expect(assertCurrent(pool)).rejects.toThrow("SCHEMA_NOT_CURRENT");
    expect(
      (await fetch(client.base + "/api/v1/me", { headers: client.headers }))
        .status,
    ).toBe(503);
    await pool.query("UPDATE schema_migrations SET hash=$1 WHERE version=5", [
      original,
    ]);
    await assertCurrent(pool);
  } finally {
    await client?.close();
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
for (const operation of ["query", "ingest"] as const)
  test(`final ${operation} response guard discards private staged result if logout races live IdP revalidation`, async () => {
    const f = await fixture();
    let client: Awaited<ReturnType<typeof connection>> | undefined;
    let release!: () => void;
    try {
      let entered!: () => void;
      const waiting = new Promise<void>((r) => (entered = r));
      const hold = new Promise<void>((r) => (release = r));
      const runtime = new RuntimeService(f.pool, async () =>
        operation === "query"
          ? {
              content: "STAGED-SECRET",
              insufficient: false,
              citations: [
                {
                  pageId: "topic",
                  title: "주제",
                  version: 1,
                  quote: "기존 내용",
                },
              ],
            }
          : {
              updates: [
                {
                  id: "staged",
                  title: "STAGED-SECRET",
                  summary: "staged",
                  content: "staged",
                  scope: "team",
                  baseVersion: 0,
                  links: [],
                  sourceIds: [source.id],
                  facts: [],
                },
              ],
            },
      );
      client = await connection(runtime, f.workspaceId, async (count) => {
        if (count === 3) {
          entered();
          await hold;
        }
      });
      const pending = fetch(client.base + "/api/v1/" + operation, {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify(
          operation === "query"
            ? { question: "기존", mode: "model" }
            : { sourceIds: [source.id], mode: "model" },
        ),
      });
      await waiting;
      await database.transaction(f.pool, f.workspaceId, async () => {}); // IdP wait must not hold the workspace transaction.
      if (operation === "ingest") {
        expect(await runtime.changesets(f.ctx)).toEqual([]);
        const row = (
          await f.pool.query(
            "SELECT id,hash FROM batches WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rows[0];
        await expect(
          runtime.core.approve(f.ctx, row.id, row.hash),
        ).rejects.toThrow("NOT_FOUND");
      }
      expect(
        (
          await fetch(client.base + "/auth/logout", {
            method: "POST",
            headers: client.headers,
            body: "{}",
          })
        ).status,
      ).toBe(200);
      release();
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("STAGED-SECRET");
      expect(
        (
          await f.pool.query(
            "SELECT id FROM runtime_answers WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await f.pool.query("SELECT id FROM batches WHERE workspace_id=$1", [
            f.workspaceId,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await runtime.jobs(f.editor)).at(-1)?.status).toBe("failed");
    } finally {
      release?.();
      await client?.close();
      await f.pool.end();
    }
  });
test("authorized HTTP model flow still releases unchanged DTOs and publishes the exact returned hash", async () => {
  const f = await fixture();
  let client: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    const runtime = new RuntimeService(f.pool, async (op) =>
      op === "query"
        ? {
            content: "정상 답변",
            insufficient: false,
            citations: [
              {
                pageId: "topic",
                title: "주제",
                version: 1,
                quote: "기존 내용",
              },
            ],
          }
        : {
            updates: [
              {
                id: "normal",
                title: "normal",
                summary: "normal",
                content: "normal",
                scope: "team",
                baseVersion: 0,
                links: [],
                sourceIds: [source.id],
                facts: [],
              },
            ],
          },
    );
    client = await connection(runtime, f.workspaceId);
    const ingest = await fetch(client.base + "/api/v1/ingest", {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ sourceIds: [source.id], mode: "model" }),
    });
    expect(ingest.status).toBe(201);
    const b = await ingest.json();
    expect(Object.keys(b).sort()).toEqual(["hash", "id"]);
    await runtime.core.approve(f.ctx, b.id, b.hash);
    await runtime.core.publish(f.ctx, b.id, b.hash, "guarded-normal");
    const query = await fetch(client.base + "/api/v1/query", {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ question: "기존", mode: "model" }),
    });
    expect(query.status).toBe(200);
    const answer = await query.json();
    expect(answer.content).toBe("정상 답변");
    expect(answer.inputEnvelope).toBeUndefined();
    expect(answer.requestAuthorizationPending).toBeUndefined();
    expect(
      (await runtime.jobs(f.editor)).every((j) => j.status === "succeeded"),
    ).toBe(true);
  } finally {
    await client?.close();
    await f.pool.end();
  }
});
for (const transport of ["http", "mcp"] as const)
  for (const operation of ["query", "ingest"] as const)
    for (const revocation of [
      "logout",
      "expiry",
      "groups",
      "role",
      "account",
    ] as const)
      test(`${transport} ${operation} fails closed after paused-model ${revocation}`, async () => {
        const f = await fixture();
        let client: Awaited<ReturnType<typeof connection>> | undefined;
        try {
          let entered!: () => void, finish!: (value: unknown) => void;
          const started = new Promise<void>((r) => (entered = r));
          const runtime = new RuntimeService(f.pool, async () => {
            entered();
            return new Promise((r) => (finish = r));
          });
          client = await connection(runtime, f.workspaceId);
          const input =
            operation === "query"
              ? { question: "기존", mode: "model" }
              : { sourceIds: [source.id], mode: "model" };
          const pending = fetch(
            client.base +
              (transport === "http" ? "/api/v1/" + operation : "/mcp"),
            {
              method: "POST",
              headers: client.headers,
              body: JSON.stringify(
                transport === "http"
                  ? input
                  : {
                      jsonrpc: "2.0",
                      id: 1,
                      method: "tools/call",
                      params: {
                        name: "knowledge_" + operation,
                        arguments: input,
                      },
                    },
              ),
            },
          );
          await started;
          if (revocation === "logout")
            expect(
              (
                await fetch(client.base + "/auth/logout", {
                  method: "POST",
                  headers: client.headers,
                  body: "{}",
                })
              ).status,
            ).toBe(200);
          if (revocation === "expiry")
            await f.pool.query(
              "UPDATE runtime_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
              [sessionHash(client.token)],
            );
          if (revocation === "groups") client.setGroups([]);
          if (revocation === "role") client.setGroups(["readers"]);
          if (revocation === "account") client.disable();
          finish(
            operation === "query"
              ? {
                  content: "NEVER-RELEASE-AFTER-REVOCATION",
                  insufficient: false,
                  citations: [
                    {
                      pageId: "topic",
                      title: "주제",
                      version: 1,
                      quote: "기존 내용",
                    },
                  ],
                }
              : {
                  updates: [
                    {
                      id: "guarded",
                      title: "NEVER-RELEASE-AFTER-REVOCATION",
                      summary: "guarded",
                      content: "guarded",
                      scope: "team",
                      baseVersion: 0,
                      links: [],
                      sourceIds: [source.id],
                      facts: [],
                    },
                  ],
                },
          );
          const response = await pending;
          const raw = await response.text();
          expect(raw).not.toContain("NEVER-RELEASE-AFTER-REVOCATION");
          expect(raw).toContain("UNAUTHENTICATED");
          if (transport === "http") expect(response.status).toBe(401);
          expect(
            (
              await f.pool.query(
                "SELECT id FROM runtime_answers WHERE workspace_id=$1",
                [f.workspaceId],
              )
            ).rowCount,
          ).toBe(0);
          expect(
            (
              await f.pool.query(
                "SELECT id FROM batches WHERE workspace_id=$1",
                [f.workspaceId],
              )
            ).rowCount,
          ).toBe(0);
          const jobs = await runtime.jobs(f.editor);
          expect(jobs.at(-1)?.status).toBe("failed");
          expect(jobs.at(-1)?.error_code).toBe("UNAUTHENTICATED");
        } finally {
          await client?.close();
          await f.pool.end();
        }
      });
