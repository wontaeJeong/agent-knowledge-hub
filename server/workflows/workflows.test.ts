import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, page, source, adoptFixture } from "../test-support";
import { membership } from "../repository";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "./service";
import { handleWorkflowRoute } from "./http";
let f: Awaited<ReturnType<typeof fixture>>, service: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  service = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    async (db, ctx, action) => {
      const role = await membership(db, ctx);
      if (["knowledge.read", "comment.write", "draft.write"].includes(action))
        return;
      if (
        role === "reader" ||
        (["lifecycle.manage", "knowledge.protect", "triage.manage"].includes(
          action,
        ) &&
          role !== "reviewer")
      )
        throw Error("FORBIDDEN");
    },
  );
});
afterEach(async () => {
  await f?.pool.end();
});

test("private drafts use revision CAS and never expose another author's text", async () => {
  const created = await service.saveDraft(f.editor, {
    id: "draft-one",
    expectedRevision: 0,
    title: "개인 작업",
    content: "비공유 초안",
    pageId: "topic",
    baseVersion: 1,
  });
  expect(created.revision).toBe(1);
  expect((await service.drafts(f.ctx)).items).toHaveLength(0);
  await expect(
    service.saveDraft(f.editor, {
      id: "draft-one",
      expectedRevision: 0,
      title: "충돌",
      content: "덮어쓰기",
      pageId: "topic",
      baseVersion: 1,
    }),
  ).rejects.toThrow("STALE_VERSION");
  expect((await service.drafts(f.editor)).items[0].content).toBe("비공유 초안");
});
test("manual editing produces a reviewed proposal and leaves the published version untouched", async () => {
  const proposal = await service.proposeEdit(f.editor, "topic", {
    baseVersion: 1,
    content: "사람이 수정한 본문",
    reason: "업무 절차 정정",
  });
  expect(proposal.id).toBeTruthy();
  expect(
    (await service.runtime.core.readPage(f.ctx, "topic")).version.content,
  ).toBe(page.versions[0].content);
  await expect(
    service.proposeEdit(f.reader, "topic", {
      baseVersion: 1,
      content: "변경",
      reason: "독자 우회",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    service.proposeEdit(f.editor, "topic", {
      baseVersion: 9,
      content: "변경",
      reason: "충돌",
    }),
  ).rejects.toThrow("STALE_VERSION");
});
test("comments are version anchored, revision checked and notifications obey current source permission", async () => {
  await service.subscribe(f.ctx, "topic", true);
  const comment = await service.addComment(f.editor, "topic", {
    content: "내용 확인 부탁합니다.",
    version: 1,
    anchor: "기존 내용",
    mentions: ["reviewer"],
  });
  expect((await service.notifications(f.ctx)).items).toHaveLength(1);
  await expect(
    service.editComment(f.ctx, comment.id, 1, "남의 댓글 변경"),
  ).rejects.toThrow("FORBIDDEN");
  await service.editComment(f.editor, comment.id, 1, "추가 근거를 확인하세요.");
  await expect(
    service.editComment(f.editor, comment.id, 1, "오래된 수정"),
  ).rejects.toThrow("STALE_VERSION");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect((await service.notifications(f.ctx)).items).toHaveLength(0);
  await expect(service.comments(f.ctx, "topic")).rejects.toThrow("NOT_FOUND");
});
test("page hierarchy refuses cycles and trash/restore preserve ACL rather than copying historical readers", async () => {
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 0,
    state: "trash",
    reason: "정리",
  });
  await expect(service.comments(f.editor, "topic")).rejects.toThrow(
    "NOT_FOUND",
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
    [f.workspaceId],
  );
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 1,
    state: "active",
    reason: "복구",
  });
  await expect(service.comments(f.reader, "topic")).rejects.toThrow(
    "NOT_FOUND",
  );
  await expect(
    service.setDocumentState(f.ctx, "topic", {
      expectedRevision: 2,
      parentId: "topic",
      reason: "순환",
    }),
  ).rejects.toThrow("VALIDATION_FAILED");
});
test("source correction creates another immutable source and withdrawal never overwrites original evidence", async () => {
  const correction = await service.correctSource(f.editor, source.id, {
    id: "source-corrected",
    content: "정정된 별도 원본",
    reason: "잘못된 환경 정정",
  });
  expect(correction.id).toBe("source-corrected");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, source.id],
      )
    ).rows[0].data.content,
  ).toBe(source.content);
  await service.withdrawSource(f.ctx, source.id, "원본 철회");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, source.id],
      )
    ).rows[0].data.content,
  ).toBe(source.content);
  await expect(
    service.proposeEdit(f.editor, "topic", {
      baseVersion: 1,
      content: "우회",
      reason: "철회 원본",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
test("document detail never returns inaccessible historical version bodies", async () => {
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'source','historical-private')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','historical-private','editor')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,'historical-private',$2)",
    [
      f.workspaceId,
      { ...source, id: "historical-private", content: "과거 제한 본문" },
    ],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{sourceIds}','[\"historical-private\"]') WHERE workspace_id=$1 AND page_id='topic'",
    [f.workspaceId],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, content: "현재 허용 본문" },
  ]);
  await expect(service.document(f.reader, "topic")).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("management trash listing retains restorable metadata but never bypasses revoked source access", async () => {
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 0,
    state: "trash",
    reason: "정리",
  });
  expect((await service.trash(f.ctx)).items.map((x) => x.id)).toEqual([
    "topic",
  ]);
  await expect(service.trash(f.reader)).rejects.toThrow("FORBIDDEN");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect((await service.trash(f.ctx)).items).toEqual([]);
  await expect(
    service.setDocumentState(f.ctx, "topic", {
      expectedRevision: 1,
      state: "active",
      reason: "철회 이후 복구",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
test("trash restoration checks historical input lineage as well as the latest version", async () => {
  await f.pool.query("INSERT INTO versions VALUES($1,'topic',2,$2)", [
    f.workspaceId,
    { ...page.versions[0], number: 2, sourceIds: [] },
  ]);
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 0,
    state: "trash",
    reason: "정리",
  });
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect((await service.trash(f.ctx)).items).toEqual([]);
  await expect(
    service.setDocumentState(f.ctx, "topic", {
      expectedRevision: 1,
      state: "active",
      reason: "과거 계보 제한",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
test("protected edits and mixed lifecycle metadata never bypass protection authorization", async () => {
  await service.setDocumentState(f.ctx, "topic", {
    expectedRevision: 0,
    protected: true,
    reason: "수동 보호",
  });
  await expect(
    service.proposeEdit(f.editor, "topic", {
      baseVersion: 1,
      content: "보호 우회",
      reason: "편집",
    }),
  ).rejects.toThrow();
  const weakLifecycle = new WorkflowService(
    f.pool,
    service.runtime,
    async (_db, _ctx, action) => {
      if (action === "knowledge.protect") throw Error("FORBIDDEN");
    },
  );
  await expect(
    weakLifecycle.setDocumentState(f.editor, "topic", {
      expectedRevision: 1,
      state: "archived",
      protected: false,
      reason: "혼합 우회",
    }),
  ).rejects.toThrow("FORBIDDEN");
});
test("workflow route validates private CAS submit and withdrawal without publishing live content", async () => {
  let response: unknown;
  const call = async (method: string, path: string, body: unknown = {}) => {
    const handled = await handleWorkflowRoute(
      {
        method,
        path: "/api/v1/workflows" + path,
        body,
        ctx: f.editor,
        send: (_status, data) => {
          response = data;
        },
      },
      service,
    );
    expect(handled).toBe(true);
    return response;
  };
  await call("POST", "/drafts", {
    id: "route-draft",
    expectedRevision: 0,
    title: "본문 수정",
    content: "수정 제안",
    pageId: "topic",
    baseVersion: 1,
  });
  const proposal = (await call("POST", "/drafts/route-draft/submit", {
    expectedRevision: 1,
    reason: "정정 요청",
  })) as { id: string; hash: string };
  await call("POST", `/changesets/${proposal.id}/withdraw`, {
    hash: proposal.hash,
    reason: "추가 확인 필요",
  });
  expect(
    (await service.runtime.core.readPage(f.ctx, "topic")).version.content,
  ).toBe("기존 내용");
  expect(
    (
      await f.pool.query(
        "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, proposal.id],
      )
    ).rows[0].data.status,
  ).toBe("rejected");
  await call("POST", "/drafts/route-draft/delete", { expectedRevision: 1 });
  expect(await call("GET", "/drafts")).toEqual({ items: [] });
  await expect(
    call("POST", "/drafts", {
      id: "bad",
      expectedRevision: 0,
      title: "제목",
      content: "본문",
      principalId: "reviewer",
    }),
  ).rejects.toThrow();
});
test("comment edit, resolve and tombstone deletion retain anchors without leaking deleted content", async () => {
  const c = await service.addComment(f.editor, "topic", {
    content: "첫 댓글",
    version: 1,
    anchor: "기존",
    mentions: [],
  });
  await service.editComment(f.editor, c.id, 1, "수정 댓글");
  await service.resolveComment(f.ctx, c.id, true);
  expect((await service.comments(f.reader, "topic")).items[0]).toMatchObject({
    content: "수정 댓글",
    version: 1,
    anchor: "기존",
    resolved: true,
    revision: 3,
  });
  await service.deleteComment(f.editor, c.id, 3);
  expect((await service.comments(f.reader, "topic")).items[0]).toMatchObject({
    content: "[삭제된 댓글]",
    deleted: true,
    revision: 4,
  });
});
test("templates, favorites, recents and notification acknowledgement obey current page access", async () => {
  await service.saveTemplate(f.editor, {
    id: "template-one",
    expectedRevision: 0,
    title: "업무 템플릿",
    content: "형식",
    originPageId: "topic",
  });
  expect((await service.templates(f.editor)).items).toHaveLength(1);
  expect((await service.templates(f.reader)).items).toHaveLength(0);
  await service.favorite(f.editor, "topic", true);
  await service.document(f.editor, "topic");
  expect((await service.activity(f.editor, "favorite")).items[0].id).toBe(
    "topic",
  );
  expect((await service.activity(f.editor, "recent")).items[0].version).toBe(1);
  await service.subscribe(f.editor, "topic", true);
  await service.addComment(f.ctx, "topic", {
    content: "확인 요청",
    version: 1,
    mentions: [],
  });
  const notification = (await service.notifications(f.editor)).items[0];
  await expect(
    service.readNotification(f.reader, notification.id),
  ).rejects.toThrow("NOT_FOUND");
  await service.readNotification(f.editor, notification.id);
  expect((await service.notifications(f.editor)).items[0].read_at).toBeTruthy();
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await service.templates(f.editor)).items).toEqual([]);
  expect((await service.activity(f.editor, "favorite")).items).toEqual([]);
  expect((await service.activity(f.editor, "recent")).items).toEqual([]);
  expect((await service.notifications(f.editor)).items).toEqual([]);
});
test("notification preferences validate timezone and reject stale independent updates", async () => {
  expect(await service.preferences(f.editor)).toMatchObject({
    revision: 0,
    timezone: "UTC",
  });
  const input = {
    expectedRevision: 0,
    mentions: false,
    subscriptions: true,
    dailyDigest: true,
    weeklyDigest: false,
    timezone: "Asia/Seoul",
  };
  expect(await service.preferences(f.editor, input)).toMatchObject({
    revision: 1,
    mentions: false,
  });
  await expect(service.preferences(f.editor, input)).rejects.toThrow(
    "STALE_VERSION",
  );
  await expect(
    service.preferences(f.editor, {
      ...input,
      expectedRevision: 1,
      timezone: "Not/A_Zone",
    }),
  ).rejects.toThrow("VALIDATION_FAILED");
});
test("disabled mention and subscription notifications do not enqueue unwanted notices", async () => {
  await service.preferences(f.ctx, {
    expectedRevision: 0,
    mentions: false,
    subscriptions: false,
    dailyDigest: false,
    weeklyDigest: false,
    timezone: "UTC",
  });
  await service.subscribe(f.ctx, "topic", true);
  await service.addComment(f.editor, "topic", {
    content: "알림 설정 확인",
    version: 1,
    mentions: ["reviewer"],
  });
  expect((await service.notifications(f.ctx)).items).toEqual([]);
});
test("access requests acknowledge unknown resources identically and never grant permissions", async () => {
  expect(
    await service.requestAccess(f.reader, "unknown-page", "업무에 필요"),
  ).toEqual({ accepted: true });
  expect(
    await service.requestAccess(f.reader, "unknown-page", "업무에 필요"),
  ).toEqual({ accepted: true });
  const requests = await f.pool.query(
    "SELECT id FROM workflow_access_requests WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect(requests.rowCount).toBe(1);
  await expect(
    service.requestAccess(
      { ...f.reader, principalId: "outsider" },
      "topic",
      "요청",
    ),
  ).rejects.toThrow("NOT_FOUND");
});
test("submitting a draft retains every explicitly attached source in publication audience checks", async () => {
  await service.runtime.core.registerSource(
    f.editor,
    { ...source, id: "private-extra" },
    ["editor"],
  );
  await service.saveDraft(f.editor, {
    id: "derived-draft",
    expectedRevision: 0,
    title: "추가 원본 기반",
    content: "제한 원본으로 작성",
    pageId: "topic",
    baseVersion: 1,
    sourceIds: ["private-extra"],
  });
  await expect(
    service.submitDraft(f.editor, "derived-draft", 1, "추가 근거"),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
});
test("template-derived drafts retain page restrictions and fixed dependency versions", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id!='editor'",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'page','public-target')",
    [f.workspaceId],
  );
  for (const who of ["editor", "reviewer", "reader"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','public-target',$2)",
      [f.workspaceId, who],
    );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'public-target',$2)",
    [f.workspaceId, { ...page, id: "public-target", versions: undefined }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'public-target',1,$2)", [
    f.workspaceId,
    page.versions[0],
  ]);
  const template = await service.saveTemplate(f.editor, {
    id: "derived-template",
    expectedRevision: 0,
    title: "제한 형식",
    content: "제한 문서 유래 내용",
    originPageId: "topic",
  });
  expect(template).toMatchObject({ originVersion: 1 });
  await service.saveDraft(f.editor, {
    id: "template-draft",
    expectedRevision: 0,
    title: "대상",
    content: template.content,
    pageId: "public-target",
    baseVersion: 1,
    dependencyVersions: { topic: 1 },
  });
  await expect(
    service.submitDraft(f.editor, "template-draft", 1, "형식 적용"),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
});
test("a draft changed after selection cannot be submitted under the old revision", async () => {
  await service.saveDraft(f.editor, {
    id: "racing-draft",
    expectedRevision: 0,
    title: "선택한 초안",
    content: "선택 본문",
    pageId: "topic",
    baseVersion: 1,
  });
  let checks = 0;
  const racing = new WorkflowService(
    f.pool,
    service.runtime,
    async (db, ctx, action, resource) => {
      await service.authorize(db, ctx, action, resource);
      if (action === "changeset.propose" && ++checks === 2)
        await db.query(
          "UPDATE workflow_drafts SET revision=revision+1,data=jsonb_set(data,'{content}','\"다른 기기의 수정\"') WHERE workspace_id=$1 AND id='racing-draft'",
          [f.workspaceId],
        );
    },
  );
  await expect(
    racing.submitDraft(f.editor, "racing-draft", 1, "선택한 수정 제출"),
  ).rejects.toThrow("STALE_VERSION");
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM batches WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
});
test("source correction rechecks the original audience inside registration and rolls back on narrowing", async () => {
  let checks = 0;
  const racing = new WorkflowService(
    f.pool,
    service.runtime,
    async (db, ctx, action, resource) => {
      await service.authorize(db, ctx, action, resource);
      if (
        action === "source.create" &&
        resource?.id === source.id &&
        ++checks === 2
      )
        await db.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reviewer'",
          [f.workspaceId, source.id],
        );
    },
  );
  await expect(
    racing.correctSource(f.editor, source.id, {
      id: "racing-correction",
      content: "정정된 원본",
      reason: "권한 경쟁",
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  expect(
    (
      await f.pool.query(
        "SELECT id FROM sources WHERE workspace_id=$1 AND id='racing-correction'",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([]);
});
test("a corrected source never inherits verification of the changed original content", async () => {
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{verification}','\"실행 증거 첨부\"') WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, source.id],
  );
  expect(
    await service.correctSource(f.editor, source.id, {
      id: "unverified-correction",
      content: "새 환경으로 정정",
      reason: "조건 변경",
    }),
  ).toMatchObject({ verification: "미검증" });
});
test("detaching a child from a restricted parent never resurrects previously excluded readers", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='reader'",
    [f.workspaceId],
  );
  await f.pool.query("INSERT INTO resources VALUES($1,'page','child-page')", [
    f.workspaceId,
  ]);
  for (const who of ["editor", "reviewer", "reader"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','child-page',$2)",
      [f.workspaceId, who],
    );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) VALUES($1,'child-page',$2)",
    [f.workspaceId, { ...page, id: "child-page", versions: undefined }],
  );
  await f.pool.query("INSERT INTO versions VALUES($1,'child-page',1,$2)", [
    f.workspaceId,
    page.versions[0],
  ]);
  await service.setDocumentState(f.ctx, "child-page", {
    expectedRevision: 0,
    parentId: "topic",
    reason: "제한된 상위 문서로 이동",
  });
  await expect(service.document(f.reader, "child-page")).rejects.toThrow(
    "NOT_FOUND",
  );
  await service.setDocumentState(f.ctx, "child-page", {
    expectedRevision: 1,
    parentId: null,
    reason: "최상위로 이동",
  });
  await expect(service.document(f.reader, "child-page")).rejects.toThrow(
    "NOT_FOUND",
  );
});
test("mentions do not treat retained raw ACL rows as an active space grant", async () => {
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND principal_id='reader'",
    [f.workspaceId],
  );
  const comment = await service.addComment(f.editor, "topic", {
    content: "현재 참여자만 알림",
    version: 1,
    mentions: ["reader"],
  });
  expect(comment.mentions).toEqual([]);
  expect(
    (
      await f.pool.query(
        "SELECT id FROM workflow_notifications WHERE workspace_id=$1 AND principal_id='reader'",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([]);
});
