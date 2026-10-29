import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createService } from "./service.mjs";
import { openStore } from "./store.mjs";

export const page = (content = "shared original") => ({
  id: "guide",
  title: "Guide",
  content,
  links: [],
  sourceRefs: [],
  spaceId: "team-a",
  version: 1,
  localCopyAllowed: true,
});
export const identities = {
  alice: { userId: "alice", spaces: ["team-a"], reviewer: false },
  bob: { userId: "bob", spaces: ["team-a"], reviewer: false },
  reviewer: { userId: "reviewer", spaces: ["team-a"], reviewer: true },
};
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-service-"));
  const service = await createService({
    file: path.join(dir, "remote.json"),
    identities,
    pages: [page()],
  });
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service, request: service.request };
}
const draft = (content) => ({
  ...page(content),
  spaceId: "personal",
  version: 0,
  upstream: { spaceId: "team-a", pageId: "guide", version: 1 },
});

test("personal push persists, is isolated, and never changes shared knowledge", async (t) => {
  const { request } = await fixture(t);
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: draft("my draft"),
  });
  const a = await request("alice", "snapshot", {});
  assert.equal(a.personal[0].content, "my draft");
  assert.equal(a.shared[0].content, "shared original");
  assert.deepEqual((await request("bob", "snapshot", {})).personal, []);
  await assert.rejects(request("bad", "snapshot", {}), /UNAUTHORIZED/);
});

test("retries are idempotent, reused keys with different payload fail, stale writes preserve winner", async (t) => {
  const { request } = await fixture(t);
  const input = { mutationId: "one", baseVersion: 0, page: draft("first") };
  assert.equal((await request("alice", "push", input)).version, 1);
  assert.equal((await request("alice", "push", input)).version, 1);
  await assert.rejects(
    request("alice", "push", { ...input, page: draft("different") }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    request("alice", "push", { ...input, mutationId: "two" }),
    /STALE_VERSION/,
  );
  assert.equal(
    (await request("alice", "snapshot", {})).personal[0].content,
    "first",
  );
});

test("PR freezes personal revision; only reviewers publish with current shared base", async (t) => {
  const { request } = await fixture(t);
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: draft("proposal"),
  });
  await request("alice", "propose", {
    id: "pr-one",
    pageId: "guide",
    targetSpaceId: "team-a",
    baseVersion: 1,
    personalVersion: 1,
  });
  await request("alice", "push", {
    mutationId: "two",
    baseVersion: 1,
    page: draft("later private"),
  });
  await assert.rejects(
    request("alice", "approve", { id: "pr-one" }),
    /FORBIDDEN/,
  );
  await request("reviewer", "approve", { id: "pr-one" });
  await request("reviewer", "publish", { id: "pr-one" });
  await request("reviewer", "publish", { id: "pr-one" });
  const s = await request("alice", "snapshot", {});
  assert.equal(s.shared[0].content, "proposal");
  assert.equal(s.shared[0].version, 2);
  assert.equal(s.personal[0].content, "later private");
});

test("competing PRs cannot publish over a changed shared base", async (t) => {
  const { request } = await fixture(t);
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: draft("proposal"),
  });
  for (const id of ["pr-one", "pr-two"]) {
    await request("alice", "propose", {
      id,
      pageId: "guide",
      targetSpaceId: "team-a",
      baseVersion: 1,
      personalVersion: 1,
    });
    await request("reviewer", "approve", { id });
  }
  await request("reviewer", "publish", { id: "pr-one" });
  await assert.rejects(
    request("reviewer", "publish", { id: "pr-two" }),
    /STALE_VERSION/,
  );
});

test("untrusted page metadata cannot widen source scope or invent source evidence", async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(
    request("alice", "push", {
      mutationId: "one",
      baseVersion: 0,
      page: {
        ...draft("bad"),
        sourceRefs: [{ id: "secret", version: 1, location: "L1" }],
      },
    }),
    /EVIDENCE_UNAVAILABLE/,
  );
  await assert.rejects(
    request("alice", "push", {
      mutationId: "two",
      baseVersion: 0,
      page: {
        ...draft("bad"),
        upstream: { spaceId: "other", pageId: "hidden", version: 1 },
      },
    }),
    /FORBIDDEN/,
  );
});

test("store locks concurrent writers, survives reopening, preserves corrupt state", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wiki-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  await assert.rejects(openStore(dir), /WORKSPACE_LOCKED/);
  await store.write({ hello: "한국어" });
  await store.close();
  const reopened = await openStore(dir);
  assert.deepEqual(await reopened.read(), { hello: "한국어" });
  await reopened.close();
  await writeFile(path.join(dir, "state.json"), "{bad");
  const corrupt = await openStore(dir);
  await assert.rejects(corrupt.read(), /CORRUPT_STATE/);
  assert.equal(await readFile(path.join(dir, "state.json"), "utf8"), "{bad");
  await corrupt.close();
});

test("reserved identifiers cannot address prototype properties", async (t) => {
  const { request } = await fixture(t);
  await assert.rejects(
    request("alice", "push", {
      mutationId: "one",
      baseVersion: 0,
      page: { ...draft("bad"), id: "__proto__" },
    }),
    /VALIDATION_FAILED/,
  );
});

test("personal updates cannot drop inherited provenance", async (t) => {
  const { request } = await fixture(t);
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: draft("first"),
  });
  const detached = draft("detached");
  delete detached.upstream;
  await assert.rejects(
    request("alice", "push", {
      mutationId: "two",
      baseVersion: 1,
      page: detached,
    }),
    /FORBIDDEN/,
  );
});

test("an unrelated private page cannot replace an existing shared page without lineage", async (t) => {
  const { request } = await fixture(t);
  const unrelated = draft("unrelated");
  delete unrelated.upstream;
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: unrelated,
  });
  await assert.rejects(
    request("alice", "propose", {
      id: "pr-one",
      pageId: "guide",
      targetSpaceId: "team-a",
      baseVersion: 1,
      personalVersion: 1,
    }),
    /SOURCE_SCOPE_CONFLICT/,
  );
});

test("proposal viewing requires current scope and cannot leak to another author", async (t) => {
  const { request } = await fixture(t);
  await request("alice", "push", {
    mutationId: "one",
    baseVersion: 0,
    page: draft("proposal"),
  });
  await request("alice", "propose", {
    id: "pr-one",
    pageId: "guide",
    targetSpaceId: "team-a",
    baseVersion: 1,
    personalVersion: 1,
  });
  assert.equal(
    (await request("reviewer", "proposal", { id: "pr-one" })).page.content,
    "proposal",
  );
  await assert.rejects(
    request("bob", "proposal", { id: "pr-one" }),
    /FORBIDDEN/,
  );
});
