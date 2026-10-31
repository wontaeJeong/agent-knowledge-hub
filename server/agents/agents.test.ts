import { beforeEach, afterEach, test, expect } from "vitest";
import { fixture, source } from "../test-support";
import { membership } from "../repository";
import { RuntimeService } from "../runtime/knowledge";
import { AgentService } from "./service";
let f: Awaited<ReturnType<typeof fixture>>, agents: AgentService;
beforeEach(async () => {
  f = await fixture();
  agents = new AgentService(
    f.pool,
    new RuntimeService(f.pool),
    async (db, ctx, action) => {
      const role = await membership(db, ctx);
      if (
        !["knowledge.read", "local.copy"].includes(action) &&
        role === "reader"
      )
        throw Error("FORBIDDEN");
    },
  );
});
afterEach(async () => {
  await f?.pool.end();
});
test("bounded context returns fixed versions, explicit omissions and no inaccessible page count", async () => {
  const result = await agents.context(f.reader, {
    task: "기존 내용",
    token_budget: 64,
  });
  expect(result.items).toEqual([]);
  expect(result.omitted[0]).toMatchObject({
    pageId: "topic",
    reason: "budget",
    readTool: "wiki_read",
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  const revoked = await agents.context(f.reader, {
    task: "기존 내용",
    token_budget: 10000,
  });
  expect(revoked.items).toEqual([]);
  expect(revoked.omitted).toEqual([]);
});
test("artifact submission is atomic and idempotent without automatically ingesting or publishing", async () => {
  const input = {
    artifact: {
      title: "추가 자료",
      content: "새 원본 내용",
      scope: "team",
      targetPageId: "topic",
      readers: ["editor", "reviewer"],
    },
    idempotency_key: "artifact-1",
  };
  const one = await agents.submitArtifact(f.editor, input),
    two = await agents.submitArtifact(f.editor, input);
  expect(two).toEqual(one);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM sources WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await agents.read(f.reader, { page_id: "topic", version: 1 })).content,
  ).toBe("기존 내용");
  await expect(
    agents.submitArtifact(f.editor, {
      ...input,
      artifact: { ...input.artifact, content: "다른 자료" },
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
test("agent proposal batches retain source audiences and duplicate requests do not duplicate batches", async () => {
  const input = {
    updates: [
      {
        id: "topic",
        title: "주제",
        summary: "시험 주제",
        content: "새 제안",
        scope: "team",
        baseVersion: 1,
        links: [],
        sourceIds: [source.id],
        facts: [],
      },
    ],
    source_refs: [{ id: source.id, version: 1, location: "content" }],
    idempotency_key: "change-1",
  };
  expect(await agents.proposeChange(f.editor, input)).toEqual(
    await agents.proposeChange(f.editor, input),
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  await expect(
    agents.proposeChange(f.reader, { ...input, idempotency_key: "reader-1" }),
  ).rejects.toThrow("FORBIDDEN");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(agents.proposeChange(f.editor, input)).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("connector synchronizes private revisions and proposes the exact selected revision, not a later edit", async () => {
  const snapshot = (await agents.connector(f.editor, "snapshot", {})) as {
    shared: {
      id: string;
      spaceId: string;
      version: number;
      title: string;
      content: string;
      links: string[];
      sourceRefs: unknown[];
      localCopyAllowed: true;
    }[];
  };
  expect(snapshot.shared[0].spaceId).toBe(f.workspaceId);
  const shared = snapshot.shared[0];
  const personal = {
    ...shared,
    spaceId: "personal",
    content: "개인 작업본",
    upstream: { spaceId: f.workspaceId, pageId: "topic", version: 1 },
  };
  const first = await agents.connector(f.editor, "push", {
    mutationId: "push-one",
    baseVersion: 0,
    page: personal,
  });
  expect(first).toMatchObject({ version: 1, spaceId: "personal" });
  expect(
    ((await agents.connector(f.ctx, "snapshot", {})) as { personal: unknown[] })
      .personal,
  ).toEqual([]);
  await agents.connector(f.editor, "push", {
    mutationId: "push-two",
    baseVersion: 1,
    page: { ...personal, version: 1, content: "다음 개인 작업본" },
  });
  await expect(
    agents.connector(f.editor, "propose", {
      id: "proposal-old",
      pageId: "topic",
      targetSpaceId: f.workspaceId,
      baseVersion: 1,
      personalVersion: 1,
    }),
  ).rejects.toThrow("STALE_PERSONAL_VERSION");
  const proposal = await agents.connector(f.editor, "propose", {
    id: "proposal-new",
    pageId: "topic",
    targetSpaceId: f.workspaceId,
    baseVersion: 1,
    personalVersion: 2,
  });
  expect(proposal).toMatchObject({ status: "pending" });
  expect(
    (await agents.read(f.reader, { page_id: "topic", version: 1 })).content,
  ).toBe("기존 내용");
});
test("connector rejects invented source locations and removes revoked private upstream copies", async () => {
  await expect(
    agents.connector(f.editor, "push", {
      mutationId: "bad",
      baseVersion: 0,
      page: {
        id: "private",
        title: "작업",
        content: "본문",
        spaceId: "personal",
        version: 0,
        localCopyAllowed: true,
        links: [],
        sourceRefs: [{ id: source.id, version: 99, location: "content" }],
      },
    }),
  ).rejects.toThrow("EVIDENCE_MISSING");
  const snapshot = (await agents.connector(f.editor, "snapshot", {})) as {
    shared: Record<string, unknown>[];
  };
  await agents.connector(f.editor, "push", {
    mutationId: "copy",
    baseVersion: 0,
    page: {
      ...snapshot.shared[0],
      spaceId: "personal",
      upstream: { spaceId: f.workspaceId, pageId: "topic", version: 1 },
    },
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect(await agents.connector(f.editor, "snapshot", {})).toMatchObject({
    shared: [],
    personal: [],
  });
});
test("reported success remains an unverified observation and cannot impersonate independent evidence", async () => {
  const input = {
    used_versions: [{ page_id: "topic", version: 1 }],
    result: "success",
    observations: "명령 실행 성공 주장",
    evidence: [{ id: source.id, version: 1, location: "content" }],
    idempotency_key: "outcome-1",
  };
  const result = await agents.reportOutcome(f.editor, input);
  expect(result).toMatchObject({ verified: false, status: "needs_review" });
  expect(await agents.reportOutcome(f.editor, input)).toEqual(result);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM agent_outcomes WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
});
test("personal revision is checked again inside the proposal commit transaction", async () => {
  const snapshot = (await agents.connector(f.editor, "snapshot", {})) as {
    shared: Record<string, unknown>[];
  };
  await agents.connector(f.editor, "push", {
    mutationId: "racing-copy",
    baseVersion: 0,
    page: {
      ...snapshot.shared[0],
      spaceId: "personal",
      upstream: { spaceId: f.workspaceId, pageId: "topic", version: 1 },
    },
  });
  let checks = 0;
  const racing = new AgentService(
    f.pool,
    agents.runtime,
    async (db, ctx, action, resource) => {
      await agents.authorize(db, ctx, action, resource);
      if (action === "changeset.propose" && ++checks === 2)
        await db.query(
          "UPDATE agent_personal_pages SET revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2",
          [f.workspaceId, ctx.principalId],
        );
    },
  );
  await expect(
    racing.connector(f.editor, "propose", {
      id: "racing-proposal",
      pageId: "topic",
      targetSpaceId: f.workspaceId,
      baseVersion: 1,
      personalVersion: 1,
    }),
  ).rejects.toThrow("STALE_PERSONAL_VERSION");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
test("connector copies require resource-specific policy checks, not an unscoped export permission", async () => {
  const scoped = new AgentService(
    f.pool,
    agents.runtime,
    async (db, ctx, action, resource) => {
      await membership(db, ctx);
      if (action === "local.copy" && !resource) throw Error("FORBIDDEN");
    },
  );
  expect(await scoped.connector(f.editor, "snapshot", {})).toMatchObject({
    shared: [{ id: "topic" }],
  });
});
test("archived and future-effective documents are readable snapshots, never current agent recommendations", async () => {
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,state,data) VALUES($1,'topic','archived','{}')",
    [f.workspaceId],
  );
  expect((await agents.search(f.reader, { query: "기존 내용" })).items).toEqual(
    [],
  );
  expect(
    (await agents.read(f.reader, { page_id: "topic", version: 1 })).content,
  ).toBe("기존 내용");
  await f.pool.query(
    "UPDATE workflow_document_state SET state='active',data=$2 WHERE workspace_id=$1",
    [f.workspaceId, { effectiveFrom: "2099-01-01T00:00:00Z" }],
  );
  expect(
    (await agents.context(f.reader, { task: "기존 내용", token_budget: 10000 }))
      .items,
  ).toEqual([]);
  expect(
    (
      await agents.search(f.reader, {
        query: "기존 내용",
        include_history: true,
      })
    ).items[0],
  ).toMatchObject({
    conditions: {
      effectiveFrom: "2099-01-01T00:00:00Z",
      currentRecommendation: false,
    },
  });
});
