import { afterEach, beforeEach, expect, test } from "vitest";
import { KnowledgeService } from "./service";
import { fixture, source } from "./test-support";
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
