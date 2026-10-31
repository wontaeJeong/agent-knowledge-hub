import { afterAll, beforeAll, expect, test, vi } from "vitest";
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
test("all private history paths fail identically before any history query or view", async () => {
  const path = "/api/v1/questions/threads";
  const first = await fetch(base + path, {
    method: "POST",
    headers: headers("editor"),
    body: "{}",
  });
  const owned = (await first.json()) as { id: string };
  const other = await fetch(base + path, {
    method: "POST",
    headers: headers("reader"),
    body: "{}",
  });
  const foreign = (await other.json()) as { id: string };
  await f.pool.query(
    "INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) SELECT $1,$2,'hist-'||n,'editor',n,'nonce-'||n,'hash',repeat('secret',20000),'offline','pending',jsonb_build_object('blob',repeat('x',200000)) FROM generate_series(1,21) n",
    [f.workspaceId, owned.id],
  );
  const spy = vi.spyOn(questions.options.runtime, "view");
  const query = vi.spyOn(questions.options.runtime, "query");
  const observed: string[] = [];
  const acquire = (client: import("pg").PoolClient) => {
    const existing = client.query;
    if ((existing as unknown as { tracked?: boolean }).tracked) return;
    const wrapped = ((...args: unknown[]) => {
      if (typeof args[0] === "string") observed.push(args[0]);
      return (existing as (...args: unknown[]) => unknown).apply(client, args);
    }) as typeof client.query;
    (wrapped as unknown as { tracked: boolean }).tracked = true;
    client.query = wrapped;
  };
  f.pool.on("acquire", acquire);
  try {
    const urls = [
      owned.id,
      foreign.id,
      "missing",
      "bad%21identifier",
      "x".repeat(140),
    ].flatMap((id) => [`${path}/${id}`, `${path}/${id}/title`]);
    for (const url of urls) {
      const response = await fetch(base + url, { headers: headers("editor") });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "QUESTION_HISTORY_NOT_CONFIGURED",
      });
    }
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
      [f.workspaceId],
    );
    try {
      const response = await fetch(base + path + "/" + foreign.id, {
        headers: headers("reader"),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "QUESTION_HISTORY_NOT_CONFIGURED",
      });
    } finally {
      await f.pool.query(
        "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'source','source-a','reader') ON CONFLICT DO NOTHING",
        [f.workspaceId],
      );
    }
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'editor','csrf',now()-interval '1 second','editor','editor-token')",
      [sessionHash("expired-session"), f.workspaceId],
    );
    expect(
      (
        await fetch(base + path + "/unknown", {
          headers: headers("expired-session"),
        })
      ).status,
    ).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(
      observed.some((sql) =>
        /question_turns|runtime_answers|question_threads|FROM pages|FROM sources|FROM versions/i.test(
          sql,
        ),
      ),
    ).toBe(false);
  } finally {
    f.pool.off("acquire", acquire);
    spy.mockRestore();
    query.mockRestore();
  }
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
  const reader = {
    ...f.reader,
    authorization: {
      revalidate: async () => {},
      assertSession: async () => {},
    },
  };
  const first = await questions.acceptTurn(reader, thread.id, {
    expectedRevision: 0,
    nonce: "one",
    question: "private prompt",
    mode: "offline",
  });
  const answer1 = await questions.options.runtime.query(
    reader,
    "기존",
    "offline",
  );
  await f.pool.query(
    "UPDATE question_turns SET status='completed',answer_id=$3,answer_version=1 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, first.turnId, answer1.id],
  );
  const second = await questions.acceptTurn(reader, thread.id, {
    expectedRevision: 1,
    nonce: "two",
    question: "second private prompt",
    mode: "offline",
  });
  const answer2 = await questions.options.runtime.query(
    reader,
    "기존",
    "offline",
  );
  await f.pool.query(
    "UPDATE question_turns SET status='completed',answer_id=$3,answer_version=1 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, second.turnId, answer2.id],
  );
  expect(
    (await fetch(base + path + "/" + thread.id, { headers: headers("editor") }))
      .status,
  ).toBe(503);
  const editorList = (await (
    await fetch(base + path, { headers: headers("editor") })
  ).json()) as { items: { id: string }[] };
  expect(editorList.items.some((item) => item.id === thread.id)).toBe(false);
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
    ).toBe(503);
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
    ).json(),
  ).toEqual({ code: "QUESTION_HISTORY_NOT_CONFIGURED" });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const revoked = await (
    await fetch(base + path + "/" + thread.id, { headers: headers("reader") })
  ).json();
  expect(revoked).toEqual({ code: "QUESTION_HISTORY_NOT_CONFIGURED" });
  expect(JSON.stringify(revoked)).not.toContain("private prompt");
  expect(
    await (
      await fetch(base + path + "/" + thread.id + "/title", {
        headers: headers("reader"),
      })
    ).text(),
  ).not.toContain("private prompt");
  const listing = (await (
    await fetch(base + path, { headers: headers("reader") })
  ).json()) as { items: { id: string; revision: number | null }[] };
  expect(
    listing.items.find((item) => item.id === thread.id)?.revision,
  ).toBeNull();
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
test("blocked history does not prevent a concurrent workspace thread write", async () => {
  const path = "/api/v1/questions/threads",
    started = performance.now();
  const [history, write] = await Promise.all([
    fetch(base + path + "/not-present/title", { headers: headers("editor") }),
    fetch(base + path, {
      method: "POST",
      headers: headers("editor"),
      body: "{}",
    }),
  ]);
  expect(history.status).toBe(503);
  expect(write.status).toBe(201);
  expect(performance.now() - started).toBeLessThan(10000);
});
test("large private history returns a generic bounded error for detail and title", async () => {
  const path = "/api/v1/questions/threads";
  const created = await fetch(base + path, {
    method: "POST",
    headers: headers("editor"),
    body: "{}",
  });
  const thread = (await created.json()) as { id: string };
  await f.pool.query(
    "INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) SELECT $1,$2,'large-'||n,'editor',n,'nonce-'||n,'hash','sensitive content','offline','pending','{}' FROM generate_series(1,21) n",
    [f.workspaceId, thread.id],
  );
  for (const suffix of ["", "/title"]) {
    const response = await fetch(base + path + "/" + thread.id + suffix, {
      headers: headers("editor"),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      code: "QUESTION_HISTORY_NOT_CONFIGURED",
    });
    expect(text).not.toMatch(/sensitive|SELECT|ordinal/i);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["code"]);
  }
});
test("post-erasure question writes expose a safe explicit error", async () => {
  await f.pool.query(
    "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,'http-fence','source','source-a','[]','[]',true,'editor')",
    [f.workspaceId],
  );
  const response = await fetch(base + "/api/v1/questions/threads", {
    method: "POST",
    headers: headers("editor"),
    body: "{}",
  });
  expect(response.status).toBe(409);
  const payload = await response.json();
  expect(payload).toMatchObject({ code: "ERASURE_QUESTION_WRITES_FENCED" });
  expect(JSON.stringify(payload)).not.toMatch(/SELECT|INSERT|workspace_id/i);
});
