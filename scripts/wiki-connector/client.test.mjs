import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startDevServer } from "./dev-server.mjs";
import { openClient } from "./client.mjs";

const shared = {
  id: "guide",
  title: "Guide",
  content: "shared original",
  links: [],
  sourceRefs: [],
  spaceId: "team-a",
  version: 1,
  localCopyAllowed: true,
};
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-client-"));
  const identities = {
    alice: { userId: "alice", spaces: ["team-a"] },
    reviewer: { userId: "reviewer", spaces: ["team-a"], reviewer: true },
  };
  const remote = await startDevServer({
    file: path.join(dir, "remote"),
    identities,
    pages: [shared],
  });
  const clients = [];
  const connect = async (name, options = {}) => {
    const c = await openClient({
      directory: path.join(dir, name),
      url: remote.url,
      token: "alice",
      intervalMs: 20,
      ...options,
    });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    await remote.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, remote, identities, connect };
}

test("local edits persist through restart, sync to personal only and are visible on another device", async (t) => {
  const { remote, connect } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "personal change" });
  assert.equal((await a.status()).pending, 1);
  await a.close();
  const resumed = await connect("a");
  await resumed.sync();
  const b = await connect("b");
  await b.sync();
  assert.equal((await b.read("guide")).page.content, "personal change");
  assert.equal(
    (await b.read("guide", "team-a")).page.content,
    "shared original",
  );
  assert.equal(
    (await remote.service.request("alice", "snapshot", {})).shared[0].version,
    1,
  );
});

test("simultaneous device edits preserve three versions and require a hash-bound confirmation", async (t) => {
  const { connect } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "base personal" });
  await a.sync();
  const b = await connect("b");
  await b.sync();
  await a.write({ ...shared, content: "from a" });
  await b.write({ ...shared, content: "from b" });
  await b.sync();
  await a.sync();
  const [conflict] = await a.conflicts();
  assert.equal(conflict.base.content, "base personal");
  assert.equal(conflict.draft.content, "from a");
  assert.equal(conflict.incoming.content, "from b");
  const proposal = await a.prepareMerge("guide", "human reviewed merge");
  await assert.rejects(
    a.confirmMerge("guide", "wrong"),
    /MERGE_CONFIRMATION_STALE/,
  );
  await a.confirmMerge("guide", proposal.hash);
  await b.sync();
  assert.equal((await b.read("guide")).page.content, "human reviewed merge");
});

test("new remote edits invalidate prepared merge and preserve both sides", async (t) => {
  const { connect } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "first" });
  await a.sync();
  const b = await connect("b");
  await b.sync();
  await a.write({ ...shared, content: "local" });
  await b.write({ ...shared, content: "remote" });
  await b.sync();
  await a.sync();
  const proposal = await a.prepareMerge("guide", "merge");
  await b.write({ ...shared, content: "remote newer" });
  await b.sync();
  await assert.rejects(
    a.confirmMerge("guide", proposal.hash),
    /MERGE_CONFIRMATION_STALE/,
  );
  assert.equal((await a.conflicts())[0].draft.content, "local");
  assert.equal((await a.conflicts())[0].incoming.content, "remote newer");
});

test("revocation removes cached content and prepared conflicts from every response", async (t) => {
  const { connect, identities } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "first" });
  await a.sync();
  const b = await connect("b");
  await b.sync();
  await a.write({ ...shared, content: "local secret" });
  await b.write({ ...shared, content: "remote secret" });
  await b.sync();
  await a.sync();
  await a.prepareMerge("guide", "merged secret");
  identities.alice.spaces = [];
  assert.deepEqual(await a.search("secret"), []);
  assert.deepEqual(await a.conflicts(), []);
  await assert.rejects(a.read("guide"), /NOT_FOUND/);
  await assert.rejects(a.prepareMerge("guide", "bad"), /NOT_FOUND/);
});

test("authorization outage fails closed, pending edits survive, tokens never reach disk", async (t) => {
  const { dir, connect, identities } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "not lost" });
  delete identities.alice;
  await assert.rejects(a.search("Guide"), /UNAUTHORIZED/);
  assert.equal((await a.status()).pending, 1);
  assert.equal((await a.status()).error, "UNAUTHORIZED");
  assert.ok(
    !(await readFile(path.join(dir, "a", "state.json"), "utf8")).includes(
      '"token"',
    ),
  );
});

test("writes queued behind a sync are not lost; repeated syncs do not create duplicate revisions", async (t) => {
  const { connect, remote } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await Promise.all([a.sync(), a.write({ ...shared, content: "queued" })]);
  await a.sync();
  await a.sync();
  const snapshot = await remote.service.request("alice", "snapshot", {});
  assert.equal(snapshot.personal[0].content, "queued");
  assert.equal(snapshot.personal[0].version, 1);
});

test("explicit proposal freezes selected personal text, never automatically publishes it", async (t) => {
  const { connect, remote } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.write({ ...shared, content: "proposed" });
  await a.sync();
  const p = await a.propose({
    id: "pr-one",
    pageId: "guide",
    targetSpaceId: "team-a",
    baseVersion: 1,
  });
  assert.equal(p.status, "pending");
  assert.equal(
    (await remote.service.request("alice", "snapshot", {})).shared[0].content,
    "shared original",
  );
});

test("local directory is bound to endpoint and account without persisting the token", async (t) => {
  const { connect } = await setup(t);
  const a = await connect("a");
  await a.sync();
  await a.close();
  await assert.rejects(
    connect("a", { token: "different-account" }),
    /WORKSPACE_IDENTITY_MISMATCH/,
  );
});

test("a lost acceptance response recovers without duplicate personal versions", async (t) => {
  const { connect, remote } = await setup(t);
  let lost = false;
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const result = await fetch(remote.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer alice",
      },
      body,
    });
    const text = await result.text();
    if (!lost && JSON.parse(body).action === "push") {
      lost = true;
      req.socket.destroy();
      return;
    }
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(text);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const a = await connect("lost", {
    url: `http://127.0.0.1:${proxy.address().port}/sync`,
  });
  await a.sync();
  await a.write({ ...shared, content: "accepted once" });
  await assert.rejects(a.sync(), /CONNECTION_FAILED/);
  assert.equal((await a.status()).pending, 1);
  await a.sync();
  assert.equal((await a.status()).pending, 0);
  assert.equal(
    (await remote.service.request("alice", "snapshot", {})).personal[0].version,
    1,
  );
});

test("connected polling syncs writes and close cancels scheduling without a daemon", async (t) => {
  const { connect, remote } = await setup(t);
  const a = await connect("polling");
  await a.start();
  await a.write({ ...shared, content: "automatic" });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (
      (await remote.service.request("alice", "snapshot", {})).personal[0]
        ?.content === "automatic"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    (await remote.service.request("alice", "snapshot", {})).personal[0]
      ?.content,
    "automatic",
  );
  await a.close();
  await assert.rejects(a.sync(), /CLIENT_CLOSED/);
});

test("network transport rejects redirects and does not forward authorization to another origin", async (t) => {
  const { connect } = await setup(t);
  let leaked = false;
  const target = http.createServer((req, res) => {
    leaked = Boolean(req.headers.authorization);
    res.end("{}");
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const redirect = http.createServer((req, res) => {
    res.writeHead(302, {
      Location: `http://127.0.0.1:${target.address().port}`,
    });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  });
  const a = await connect("redirect", {
    url: `http://127.0.0.1:${redirect.address().port}/sync`,
  });
  await assert.rejects(a.sync(), /CONNECTION_FAILED/);
  assert.equal(leaked, false);
});
