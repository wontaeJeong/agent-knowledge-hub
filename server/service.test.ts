import { afterEach, beforeEach, expect, test } from "vitest";
import { KnowledgeService } from "./service";
import { fixture, source, adoptFixture } from "./test-support";
import { AccessService } from "./access";
import type { Draft } from "../src/domain/wiki";

let f: Awaited<ReturnType<typeof fixture>>;
let service: KnowledgeService;
beforeEach(async () => {
  f = await fixture();
  service = new KnowledgeService(f.pool);
});
afterEach(async () => {
  await f?.pool.end();
});

test("source registration preserves originals and refuses duplicate identity", async () => {
  const next = { ...source, id: "next" };
  await service.registerSource(f.editor, next, ["editor", "reviewer"]);
  await expect(
    service.registerSource(f.editor, { ...next, content: "overwrite" }, [
      "editor",
    ]),
  ).rejects.toThrow("ALREADY_EXISTS");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id='next'",
        [f.workspaceId],
      )
    ).rows[0].data.content,
  ).toBe(source.content);
});
test("domain writes append privacy-minimized operational audit events in the same transaction", async () => {
  await service.registerSource(f.editor, { ...source, id: "audited-source" }, [
    "editor",
    "reviewer",
  ]);
  const rows = (
    await f.pool.query(
      "SELECT event FROM operations_audit_chain WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].event).toMatchObject({
    operation: "source.register",
    resource: { kind: "source", id: "audited-source" },
  });
  expect(rows[0].event.actorHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(rows[0].event)).not.toContain(source.content);
});

test("readers cannot register sources and unknown identities cannot read", async () => {
  await expect(
    service.registerSource(f.reader, source, ["reader"]),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    service.readPage({ ...f.ctx, principalId: "unknown" }, "topic"),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    service.readPage({ ...f.ctx, workspaceId: "other" }, "topic"),
  ).rejects.toThrow("NOT_FOUND");
});

test("historical reads check current page and underlying source permission", async () => {
  expect(await service.readPage(f.reader, "topic", 1)).toMatchObject({
    id: "topic",
    version: { number: 1, content: "기존 내용" },
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(service.readPage(f.reader, "topic", 1)).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(service.readPage(f.reader, "missing")).rejects.toThrow(
    "NOT_FOUND",
  );
});

test("source readers must be nonempty known workspace members including the caller", async () => {
  for (const readers of [[], ["unknown"], ["reader"]]) {
    await expect(
      service.registerSource(f.editor, { ...source, id: "new" }, readers),
    ).rejects.toThrow("VALIDATION_FAILED");
  }
});

const drafts = (): Draft[] => [
  {
    id: "topic",
    title: "주제",
    summary: "개선",
    content: "새 연결 지식",
    scope: "team",
    links: ["concept"],
    sourceIds: ["source-a"],
    facts: [],
    baseVersion: 1,
  },
  {
    id: "concept",
    title: "개념",
    summary: "개념",
    content: "조건부 교훈",
    scope: "team",
    links: ["topic"],
    sourceIds: ["source-a"],
    facts: [],
    baseVersion: 0,
  },
];
async function approved() {
  const b = await service.propose(f.editor, drafts(), [source.id]);
  await service.approve(f.ctx, b.id, b.hash);
  return b;
}
test("official standards remain read-only until an explicit independent official review policy is configured", async () => {
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{status}','\"공식 기준\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    service.propose(f.editor, drafts(), [source.id]),
  ).rejects.toThrow("OFFICIAL_REVIEW_REQUIRED");
  expect((await service.readPage(f.reader, "topic")).version.content).toBe(
    "기존 내용",
  );
});
test("publishing changed text never inherits an old execution-verification timestamp", async () => {
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{verifiedAt}','\"2000-01-01T00:00:00Z\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const b = await approved();
  await service.publish(f.ctx, b.id, b.hash, "verification-reset");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM pages WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId],
      )
    ).rows[0].data.verifiedAt,
  ).toBeUndefined();
});
test("configured official changes require both designated independent humans and retain official classification", async () => {
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool);
  const second = `${f.workspaceId}-reviewer2`,
    ctx = { workspaceId: f.workspaceId, principalId: second };
  const owner = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  let a = await access.effective(owner);
  await f.pool.query(
    "INSERT INTO access_principals(id,kind,active) VALUES($1,'human',true)",
    [second],
  );
  await f.pool.query(
    "INSERT INTO access_team_members VALUES($1,$2,'member',true)",
    [a.space.namespaceId, second],
  );
  await access.setGrant(owner, {
    principalId: second,
    role: "maintain",
    expectedVersion: a.space.policyVersion,
  });
  for (const kind of ["page", "source"])
    await f.pool.query("INSERT INTO resource_readers VALUES($1,$2,$3,$4)", [
      f.workspaceId,
      kind,
      kind === "page" ? "topic" : source.id,
      second,
    ]);
  a = await access.effective(owner);
  await access.setReviewPolicy(owner, {
    minimumApprovals: 1,
    reviewerIds: ["reviewer", second],
    documentTypes: [
      {
        documentType: "official-standard",
        minimumApprovals: 2,
        reviewerIds: ["reviewer", second],
      },
    ],
    expectedVersion: a.space.policyVersion,
  });
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{status}','\"공식 기준\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const b = await service.propose(f.editor, drafts(), [source.id]);
  await service.approve(f.ctx, b.id, b.hash);
  await expect(
    service.publish(f.ctx, b.id, b.hash, "official-one-review"),
  ).rejects.toThrow("APPROVAL_STALE");
  await service.approve(ctx, b.id, b.hash);
  await service.publish(f.ctx, b.id, b.hash, "official-two-reviews");
  expect(
    (
      await f.pool.query(
        "SELECT data->>'status' AS status FROM pages WHERE workspace_id=$1 AND id='topic'",
        [f.workspaceId],
      )
    ).rows[0].status,
  ).toBe("공식 기준");
});

test("publishes an approved multi-page batch atomically with real audit identity", async () => {
  const b = await approved();
  expect(await service.readPage(f.reader, "topic")).toMatchObject({
    version: { number: 1 },
  });
  const result = await service.publish(f.ctx, b.id, b.hash, "request-1");
  expect(result).toEqual({ batchId: b.id, versions: { topic: 2, concept: 1 } });
  expect(await service.readPage(f.reader, "concept")).toMatchObject({
    version: { number: 1, author: "reviewer" },
  });
  expect(
    (
      await f.pool.query(
        "SELECT principal_id FROM audit WHERE workspace_id=$1 AND operation='batch.publish'",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([{ principal_id: "reviewer" }]);
  expect(
    (
      await f.pool.query(
        "SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].content,
  ).toBe(source.content);
});
test("published versions distinguish the responsible proposer and human publisher from unknown generation", async () => {
  const b = await approved();
  await service.publish(f.ctx, b.id, b.hash, "actor-attribution");
  expect((await service.readPage(f.reader, "topic")).version).toMatchObject({
    batchId: b.id,
    proposedBy: "editor",
    publishedBy: "reviewer",
    producer: { kind: "unknown" },
  });
});
test("a source-create token need not receive proposal authority, while a read-only token still cannot write", async () => {
  await adoptFixture(f.pool, f.workspaceId);
  const access = new AccessService(f.pool),
    expiresAt = new Date(Date.now() + 3600000).toISOString();
  const issued = await access.issueCredential(f.editor, {
      actions: ["knowledge.read", "source.create"],
      expiresAt,
    }),
    ctx = await access.authenticateCredential(issued.secret, f.workspaceId);
  await service.registerSource(ctx, { ...source, id: "scoped-create" }, [
    "editor",
  ]);
  await expect(service.propose(ctx, drafts(), [source.id])).rejects.toThrow(
    "FORBIDDEN",
  );
  const read = await access.issueCredential(f.editor, {
      actions: ["knowledge.read"],
      expiresAt,
    }),
    readCtx = await access.authenticateCredential(read.secret, f.workspaceId);
  await expect(
    service.registerSource(readCtx, { ...source, id: "forbidden-create" }, [
      "editor",
    ]),
  ).rejects.toThrow("FORBIDDEN");
});

test("concurrent publication and a new service instance replay exactly one version set", async () => {
  const b = await approved();
  const results = await Promise.all([
    service.publish(f.ctx, b.id, b.hash, "a"),
    service.publish(f.ctx, b.id, b.hash, "b"),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(
    await new KnowledgeService(f.pool).publish(f.ctx, b.id, b.hash, "a"),
  ).toEqual(results[0]);
  expect(
    (
      await f.pool.query("SELECT * FROM versions WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(3);
  expect(
    (
      await f.pool.query("SELECT * FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await f.pool.query(
        "SELECT * FROM audit WHERE workspace_id=$1 AND operation='batch.publish'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
});

test.each(["source", "base", "content", "policy"])(
  "rejects the entire batch after approved %s changes",
  async (kind) => {
    const b = await approved();
    if (kind === "source")
      await f.pool.query(
        "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (kind === "base")
      await f.pool.query(
        "UPDATE pages SET data=jsonb_set(data,'{summary}','\"changed\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (kind === "content")
      await f.pool.query(
        "UPDATE batches SET data=jsonb_set(data,'{updates,0,content}','\"tampered\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (kind === "policy")
      await f.pool.query(
        "UPDATE batches SET data=jsonb_set(data,'{policyVersion}','\"old\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    await expect(service.publish(f.ctx, b.id, b.hash, "stale")).rejects.toThrow(
      /STALE_VERSION|APPROVAL_STALE/,
    );
    expect(
      (
        await f.pool.query("SELECT * FROM versions WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.pool.query("SELECT * FROM requests WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
  },
);

test("rechecks membership and source permission even for publication replay", async () => {
  const b = await approved();
  await service.publish(f.ctx, b.id, b.hash, "ok");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  await expect(service.publish(f.ctx, b.id, b.hash, "ok")).rejects.toThrow(
    "NOT_FOUND",
  );
});

test("only reviewers can approve and publish; caller hashes cannot select new approved content", async () => {
  const b = await service.propose(f.editor, drafts(), [source.id]);
  await expect(service.approve(f.editor, b.id, b.hash)).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(service.approve(f.ctx, b.id, "forged")).rejects.toThrow(
    "APPROVAL_STALE",
  );
  await expect(
    service.publish(f.ctx, b.id, b.hash, "unapproved"),
  ).rejects.toThrow("APPROVAL_STALE");
  await service.approve(f.ctx, b.id, b.hash);
  await expect(
    service.publish(f.editor, b.id, b.hash, "editor"),
  ).rejects.toThrow("FORBIDDEN");
});

test("blocks source audience expansion and inaccessible link dependencies", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    service.propose(f.editor, drafts(), [source.id]),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  const next = drafts()
    .slice(1)
    .map((d) => ({ ...d, links: [] }));
  const b = await service.propose(f.editor, next, [source.id]);
  await service.approve(f.ctx, b.id, b.hash);
  await service.publish(f.ctx, b.id, b.hash, "private-audience");
  await expect(service.readPage(f.reader, "concept")).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(await service.readPage(f.editor, "concept")).toMatchObject({
    id: "concept",
  });
});

test("SQL failure during publication rolls back pages, versions, audit and receipts", async () => {
  const b = await approved();
  // A real database constraint fails the second version insert after the first has succeeded.
  await f.pool.query(
    "ALTER TABLE versions ADD CONSTRAINT reject_test_concept CHECK (page_id <> 'concept') NOT VALID",
  );
  try {
    await expect(
      service.publish(f.ctx, b.id, b.hash, "fail"),
    ).rejects.toThrow();
    expect(
      (
        await f.pool.query("SELECT * FROM versions WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.pool.query("SELECT * FROM pages WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.pool.query("SELECT * FROM publications WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          "SELECT * FROM audit WHERE workspace_id=$1 AND operation='batch.publish'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.query(
      "ALTER TABLE versions DROP CONSTRAINT reject_test_concept",
    );
  }
});

test("idempotency keys cannot be reused for a different publication request", async () => {
  const b = await approved();
  await service.publish(f.ctx, b.id, b.hash, "reuse");
  await expect(
    service.publish(f.ctx, b.id, "different-hash", "reuse"),
  ).rejects.toThrow(/IDEMPOTENCY_CONFLICT|APPROVAL_STALE/);
  await expect(service.publish(f.ctx, b.id, b.hash, " ")).rejects.toThrow(
    "VALIDATION_FAILED",
  );
});

test("source audience expansion after approval requires reapproval before publication", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const b = await service.propose(
    f.editor,
    drafts()
      .slice(1)
      .map((d) => ({ ...d, links: [] })),
    [source.id],
  );
  await service.approve(f.ctx, b.id, b.hash);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a','reader')",
    [f.workspaceId],
  );
  await expect(
    service.publish(f.ctx, b.id, b.hash, "expanded"),
  ).rejects.toThrow("APPROVAL_STALE");
  expect(
    (
      await f.pool.query(
        "SELECT * FROM pages WHERE workspace_id=$1 AND id='concept'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
});

test("linked pages require effective current source access for caller and publication audience", async () => {
  await service.registerSource(f.editor, { ...source, id: "second" }, [
    "editor",
    "reviewer",
    "reader",
  ]);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(service.readPage(f.editor, "topic")).rejects.toThrow(
    "NOT_FOUND",
  );
  const next = drafts()
    .slice(1)
    .map((d) => ({ ...d, sourceIds: ["second"] }));
  await expect(service.propose(f.editor, next, ["second"])).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(service.propose(f.ctx, next, ["second"])).rejects.toThrow(
    "SOURCE_SCOPE_CONFLICT",
  );
});

test("old version does not expose current title derived from an inaccessible source", async () => {
  await service.registerSource(f.editor, { ...source, id: "secret" }, [
    "editor",
    "reviewer",
  ]);
  await f.pool.query(
    "UPDATE pages SET data=jsonb_set(data,'{title}','\"Secret acquisition target: Acme\"') WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    { id: "v2", number: 2, content: "secret", sourceIds: ["secret"] },
  ]);
  await expect(service.readPage(f.reader, "topic", 1)).rejects.toThrow(
    "NOT_FOUND",
  );
});

test("multiple source readers intersect rather than union", async () => {
  await service.registerSource(f.editor, { ...source, id: "restricted" }, [
    "editor",
    "reviewer",
  ]);
  const updates = drafts()
    .slice(1)
    .map((d) => ({ ...d, links: [], sourceIds: [source.id, "restricted"] }));
  const b = await service.propose(f.editor, updates, [source.id, "restricted"]);
  await service.approve(f.ctx, b.id, b.hash);
  await service.publish(f.ctx, b.id, b.hash, "intersection");
  await expect(service.readPage(f.reader, "concept")).rejects.toThrow(
    "NOT_FOUND",
  );
  expect(await service.readPage(f.editor, "concept")).toMatchObject({
    id: "concept",
  });
});
