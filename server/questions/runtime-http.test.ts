import { afterAll, beforeAll, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction, AccessService } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { QuestionsService } from "./service";

let f: Awaited<ReturnType<typeof fixture>>,
  server: Server,
  provider: Server,
  base: string;
let questions: QuestionsService;
const headers = (who: string) => ({
  Cookie: `akh_session=${who}`,
  Origin: "http://localhost",
  "X-CSRF-Token": "csrf",
  "Content-Type": "application/json",
});
beforeAll(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  provider = createServer((req, res) => {
    const subject = req.headers.authorization?.includes("reader-token")
      ? "reader"
      : "editor";
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        sub: subject,
        groups: [subject === "reader" ? "readers" : "writers"],
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "client",
    "secret",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, "http://localhost", f.workspaceId, {
    readers: "reader",
    writers: "editor",
  });
  for (const who of ["reader", "editor"])
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,'csrf',now()+interval '1 hour',$3,$4)",
      [sessionHash(who), f.workspaceId, who, `${who}-token`],
    );
  const runtime = new RuntimeService(f.pool);
  questions = new QuestionsService(f.pool, {
    runtime,
    authorize: authorizeInTransaction,
    runQuery: async () => {
      throw Error("NOT_CONFIGURED");
    },
  });
  server = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await f.pool.end();
});
test("authenticated thread endpoints isolate principal and hide revoked source-bound history", async () => {
  const path = "/api/v1/questions/threads";
  expect((await fetch(base + path)).status).toBe(401);
  expect(
    (
      await fetch(base + path, {
        method: "POST",
        headers: {
          Cookie: "akh_session=reader",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  const created = await fetch(base + path, {
    method: "POST",
    headers: headers("reader"),
    body: "{}",
  });
  expect(created.status).toBe(201);
  const thread = (await created.json()) as { id: string };
  await questions.acceptTurn(
    {
      ...f.reader,
      authorization: {
        revalidate: async () => {},
        assertSession: async () => {},
      },
    },
    thread.id,
    {
      expectedRevision: 0,
      nonce: "one",
      question: "private prompt",
      mode: "offline",
    },
  );
  expect(
    (await fetch(base + path + "/" + thread.id, { headers: headers("editor") }))
      .status,
  ).toBe(404);
  expect(
    await (await fetch(base + path, { headers: headers("editor") })).json(),
  ).toMatchObject({ items: [] });
  const other = await fixture();
  try {
    await adoptFixture(other.pool, other.workspaceId);
    await other.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reader','csrf',now()+interval '1 hour','reader','reader-token')",
      [sessionHash("other-space"), other.workspaceId],
    );
    expect(
      (
        await fetch(base + path + "/" + thread.id, {
          headers: headers("other-space"),
        })
      ).status,
    ).toBe(404);
    expect(
      await (
        await fetch(base + path, { headers: headers("other-space") })
      ).json(),
    ).toMatchObject({ items: [] });
  } finally {
    await other.pool.end();
  }
  expect(
    await (
      await fetch(base + path + "/" + thread.id, { headers: headers("reader") })
    ).text(),
  ).toContain("private prompt");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const revoked = await (
    await fetch(base + path + "/" + thread.id, { headers: headers("reader") })
  ).json();
  expect(revoked).toMatchObject({ turns: [], contextOmitted: true });
  expect(JSON.stringify(revoked)).not.toContain("private prompt");
  expect(
    await (
      await fetch(base + path + "/" + thread.id + "/title", {
        headers: headers("reader"),
      })
    ).text(),
  ).not.toContain("private prompt");
  await f.pool.query(
    "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND principal_id='reader'",
    [f.workspaceId],
  );
  expect(
    (await fetch(base + path + "/" + thread.id, { headers: headers("reader") }))
      .status,
  ).not.toBe(200);
});
test("unintegrated turn submission and bearer credentials fail closed", async () => {
  const path = "/api/v1/questions/threads";
  const created = await fetch(base + path, {
    method: "POST",
    headers: headers("editor"),
    body: "{}",
  });
  expect(created.status).toBe(201);
  const thread = (await created.json()) as { id: string };
  const submit = await fetch(base + path + "/" + thread.id + "/turns", {
    method: "POST",
    headers: headers("editor"),
    body: JSON.stringify({
      expectedRevision: 0,
      nonce: "n",
      question: "never persisted",
      mode: "model",
    }),
  });
  expect(submit.status).toBe(503);
  expect(
    (
      await fetch(base + path + "/" + thread.id + "/turns/turn/resume", {
        method: "POST",
        headers: headers("editor"),
        body: "{}",
      })
    ).status,
  ).toBe(503);
  expect(
    (
      await fetch(base + "/api/v1/questions/search", {
        method: "POST",
        headers: headers("editor"),
        body: "{}",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM question_turns WHERE workspace_id=$1 AND thread_id=$2",
        [f.workspaceId, thread.id],
      )
    ).rowCount,
  ).toBe(0);
  const { secret } = await new AccessService(f.pool).issueCredential(f.editor, {
    actions: ["knowledge.read"],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  expect(
    (
      await fetch(base + path, {
        headers: { Authorization: "Bearer " + secret },
      })
    ).status,
  ).toBe(403);
  const old = process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
  process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = "true";
  try {
    const issued = await fetch(base + "/api/v1/credentials/keys", {
      method: "POST",
      headers: headers("editor"),
      body: JSON.stringify({ name: "thread-test", scope: "read", days: 1 }),
    });
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };
    expect(
      (
        await fetch(base + path, {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(403);
  } finally {
    if (old === undefined)
      delete process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED;
    else process.env.AGENT_KNOWLEDGE_HUB_AGENT_CREDENTIALS_ENABLED = old;
  }
});
