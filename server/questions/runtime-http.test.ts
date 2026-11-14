import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import * as oidc from "openid-client";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction, AccessService } from "../access/index";
import { RuntimeService } from "../runtime/knowledge";
import { createRuntimeHandler } from "../runtime/http";
import { OidcAuth, sessionHash } from "../runtime/auth";
import { QuestionsService } from "./service";
import { createRuntimeJobs } from "../jobs/runtime";

let f: Awaited<ReturnType<typeof fixture>>,
  server: Server,
  provider: Server,
  base: string;
let questions: QuestionsService;
let hostAuth: OidcAuth;
const headers = (who: string) => ({
  Cookie: `akh_session=${who}`,
  Origin: "http://localhost",
  "X-CSRF-Token": "csrf",
  "Content-Type": "application/json",
});

test("HTTP turn returns a durable receipt and completes through the shared runtime adapter", async () => {
  const runtime = new RuntimeService(f.pool);
  const service = new QuestionsService(f.pool, {
    runtime,
    authorize: authorizeInTransaction,
    runQuery: (ctx, q, mode, execution, context) =>
      runtime.query(ctx, q, mode, execution, context),
  });
  const jobs = createRuntimeJobs(f.pool, runtime, {
    workerCount: 1,
    questions: service.questionJobAdapter(),
    revalidateInteractiveGrant: (binding) =>
      hostAuth.revalidateInteractiveGrant(binding),
    assertInteractiveGrant: (db, binding) =>
      hostAuth.assertInteractiveGrant(db, binding),
  });
  const host = createServer(
    createRuntimeHandler({
      pool: f.pool,
      service: runtime,
      auth: hostAuth,
      origin: "http://localhost",
      workspaceId: f.workspaceId,
      jobs,
      questions: service,
    }),
  );
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(host.address() as { port: number }).port}/api/v1/questions/threads`;
  try {
    const thread = (await (
      await fetch(url, {
        method: "POST",
        headers: headers("editor"),
        body: "{}",
      })
    ).json()) as { id: string };
    const payload = {
      expectedRevision: 0,
      nonce: "http-one",
      question: "기존",
      mode: "offline",
    };
    const send = () =>
      fetch(`${url}/${thread.id}/turns`, {
        method: "POST",
        headers: headers("editor"),
        body: JSON.stringify(payload),
      });
    const accepted = await send();
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { id: string };
    await jobs.workers[0].tick();
    await f.pool.query(
      "UPDATE question_turns SET job_id=NULL WHERE workspace_id=$1 AND thread_id=$2",
      [f.workspaceId, thread.id],
    );
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(((await retry.json()) as { id: string }).id).toBe(receipt.id);
    const history = (await (
      await fetch(`${url}/${thread.id}`, { headers: headers("editor") })
    ).json()) as { turns: { status: string }[] };
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0].status).toBe("completed");
  } finally {
    await jobs.stop();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
}, 20000);

test("authenticated owner can reopen a private thread through the runtime host", async () => {
  const path = "/api/v1/questions/threads";
  const created = await fetch(base + path, {
    method: "POST",
    headers: headers("editor"),
    body: "{}",
  });
  expect(created.status).toBe(201);
  const thread = (await created.json()) as { id: string };
  const detail = await fetch(base + path + "/" + thread.id, {
    headers: headers("editor"),
  });
  expect(detail.status).toBe(200);
  expect(((await detail.json()) as { id: string }).id).toBe(thread.id);
  expect(
    (await fetch(base + path + "/" + thread.id, { headers: headers("reader") }))
      .status,
  ).toBe(404);
});

test("foreign history is rejected before workspace view", async () => {
  const path = "/api/v1/questions/threads";
  const response = await fetch(base + path, {
    method: "POST",
    headers: headers("reader"),
    body: "{}",
  });
  const owned = (await response.json()) as { id: string };
  const spy = vi.spyOn(questions.options.runtime, "view");
  try {
    expect(
      (
        await fetch(base + path + "/" + owned.id, {
          headers: headers("editor"),
        })
      ).status,
    ).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
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
  const auth = (hostAuth = new OidcAuth(
    f.pool,
    config,
    "http://localhost",
    f.workspaceId,
    {
      readers: "reader",
      writers: "editor",
    },
  ));
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
  ).toBe(404);
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
    ).json(),
  ).toMatchObject({ id: thread.id, contextOmitted: false });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const revoked = await (
    await fetch(base + path + "/" + thread.id, { headers: headers("reader") })
  ).json();
  expect(revoked).toMatchObject({ id: thread.id, contextOmitted: true });
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
  ).toBe(200);
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
  expect(
    (
      await fetch(base + path + "/" + thread.id, {
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
    expect(
      (
        await fetch(base + path + "/" + thread.id, {
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
  expect(history.status).toBe(404);
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
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ code: "QUESTION_HISTORY_LIMIT" });
    expect(text).not.toMatch(/sensitive|SELECT|ordinal/i);
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
