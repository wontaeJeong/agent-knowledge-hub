import { beforeEach, afterEach, test, expect } from "vitest";
import { fixture, adoptFixture, page } from "../../test-support";
import { authorizeActionDb } from "../../access/index";
import { propose, approve, publish } from "../../publication";
import { draftOf } from "../../../src/domain/wiki";
import { GovernanceService } from "./service";
import { handleGovernanceRoute } from "./http";
import { dueReviewWork } from "./due-work";
let f: Awaited<ReturnType<typeof fixture>>, s: GovernanceService;
const owner = () => ({
  workspaceId: f.workspaceId,
  principalId: "fixture-owner",
});
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  // Ownership does not confer raw content access.
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,resource_id,'fixture-owner' FROM resource_readers WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO access_reviewers VALUES($1,'fixture-owner')",
    [f.workspaceId],
  );
  s = new GovernanceService(f.pool, async (db, ctx, action, resource) => {
    await authorizeActionDb(db, ctx, action, resource);
  });
});
afterEach(async () => {
  if (f) {
    await f.pool.query(
      "UPDATE access_principals SET active=true WHERE id='editor'",
    );
    await f.pool.end();
  }
});
test("business owner is explicit human responsibility, never inferred from namespace owner or reviewer", async () => {
  expect((await s.workbench(owner())).owners).toHaveLength(0);
  await s.assignBusinessOwner(owner(), "topic", {
    expectedRevision: 0,
    ownerId: "editor",
    backupId: "reviewer",
    reason: "운영 책임",
  });
  await expect(
    s.assignBusinessOwner(owner(), "topic", {
      expectedRevision: 0,
      ownerId: "reader",
      backupId: "reviewer",
      reason: "충돌",
    }),
  ).rejects.toThrow("STALE_VERSION");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    s.assignBusinessOwner(owner(), "topic", {
      expectedRevision: 1,
      ownerId: "reader",
      backupId: "reviewer",
      reason: "권한 없음",
    }),
  ).rejects.toThrow("NOT_FOUND");
  expect((await s.history(owner(), "topic")).items).toHaveLength(1);
  expect(
    (
      await f.pool.query(
        "SELECT owner_id FROM governance_business_owners WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].owner_id,
  ).toBe("editor");
});
test("inactive owner creates durable handoff with pending proposals, review assignment and due work without granting rights", async () => {
  await s.assignBusinessOwner(owner(), "topic", {
    expectedRevision: 0,
    ownerId: "editor",
    backupId: "reviewer",
    reason: "운영 책임",
  });
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  await s.assignReview(owner(), b.id, {
    expectedRevision: 0,
    assigneeIds: ["reviewer"],
    backupId: "fixture-owner",
    deadline: "2026-10-01T00:00:00Z",
    absentIds: [],
    reason: "검토",
  });
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [f.workspaceId, { reviewDue: "2026-10-01T00:00:00Z" }],
  );
  await f.pool.query(
    "UPDATE access_principals SET active=false WHERE id='editor'",
  );
  const first = await s.handoffInbox(owner());
  const second = await s.handoffInbox(owner());
  expect(first.items).toHaveLength(1);
  expect(second.items).toHaveLength(1);
  expect(first.items[0].work).toMatchObject({
    proposalIds: [b.id],
    reviewBatchIds: [b.id],
    reviewDue: "2026-10-01T00:00:00Z",
  });
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM governance_handoffs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).toBe("1");
});
test("access requests reveal no hidden metadata and approved page grants cannot expand source rights", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
    [f.workspaceId],
  );
  expect(
    await s.requestAccess(f.reader, {
      resourceId: "topic",
      reason: "업무 확인",
    }),
  ).toEqual(
    await s.requestAccess(f.reader, {
      resourceId: "unknown",
      reason: "업무 확인",
    }),
  );
  const inbox = await s.accessInbox(owner());
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).not.toHaveProperty("content");
  const request = inbox.items[0];
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    s.decideAccess(owner(), request.id, {
      expectedRevision: 1,
      expectedVersion: 1,
      decision: "approve",
      reason: "허용",
    }),
  ).rejects.toThrow("SOURCE_SCOPE_CONFLICT");
  expect((await s.accessInbox(owner())).items[0].status).toBe("pending");
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  await f.pool.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a','reader')",
    [f.workspaceId],
  );
  await s.decideAccess(owner(), request.id, {
    expectedRevision: 1,
    expectedVersion: 1,
    decision: "approve",
    reason: "원본 상한 내 승인",
  });
  const db = await f.pool.connect();
  try {
    await authorizeActionDb(db, f.reader, "knowledge.read", {
      kind: "page",
      id: "topic",
    });
  } finally {
    db.release();
  }
  expect(
    (await s.history(owner(), "topic")).items.some(
      (e) => e.kind === "access.decision",
    ),
  ).toBe(true);
  await expect(
    s.decideAccess(owner(), request.id, {
      expectedRevision: 1,
      expectedVersion: 1,
      decision: "reject",
      reason: "오래된 결정",
    }),
  ).rejects.toThrow("STALE_VERSION");
});
test("access approval checks broken inheritance and remains atomic on audit failure", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
    [f.workspaceId],
  );
  await s.requestAccess(f.reader, { resourceId: "topic", reason: "필요" });
  const req = (await s.accessInbox(owner())).items[0];
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','missing-parent')",
    [f.workspaceId],
  );
  await expect(
    s.decideAccess(owner(), req.id, {
      expectedRevision: 1,
      expectedVersion: 1,
      decision: "approve",
      reason: "시도",
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT status FROM workflow_access_requests WHERE id=$1",
        [req.id],
      )
    ).rows[0].status,
  ).toBe("pending");
  await f.pool.query(
    "DELETE FROM workflow_document_state WHERE workspace_id=$1",
    [f.workspaceId],
  );
  // Real database failure after the audience INSERT must roll back both grant and decision.
  await f.pool.query(
    "CREATE FUNCTION fail_governance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='access.decision' THEN RAISE EXCEPTION 'AUDIT_UNAVAILABLE'; END IF; RETURN NEW; END $$",
  );
  await f.pool.query(
    "CREATE TRIGGER fail_governance_audit BEFORE INSERT ON governance_events FOR EACH ROW EXECUTE FUNCTION fail_governance_audit()",
  );
  try {
    await expect(
      s.decideAccess(owner(), req.id, {
        expectedRevision: 1,
        expectedVersion: 1,
        decision: "approve",
        reason: "승인",
      }),
    ).rejects.toThrow("AUDIT_UNAVAILABLE");
    expect(
      (
        await f.pool.query(
          "SELECT status FROM workflow_access_requests WHERE id=$1",
          [req.id],
        )
      ).rows[0].status,
    ).toBe("pending");
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.query(
      "DROP TRIGGER fail_governance_audit ON governance_events",
    );
    await f.pool.query("DROP FUNCTION fail_governance_audit()");
  }
});
test("review assignment requires an independent qualified human and invalidates old approvals; absence differs from lateness", async () => {
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  await expect(
    s.assignReview(owner(), b.id, {
      expectedRevision: 0,
      assigneeIds: ["editor"],
      backupId: "reader",
      deadline: "2026-10-01T00:00:00Z",
      absentIds: [],
      reason: "자기 승인",
    }),
  ).rejects.toThrow("FORBIDDEN");
  await approve(f.pool, f.ctx, b.id, b.hash);
  await s.assignReview(owner(), b.id, {
    expectedRevision: 0,
    assigneeIds: ["reviewer"],
    backupId: "fixture-owner",
    deadline: "2026-10-01T00:00:00Z",
    absentIds: ["reviewer"],
    reason: "부재 재배정",
  });
  const work = (await s.reviewInbox(f.ctx)).items[0];
  expect(work).toMatchObject({ late: true, absent: true });
  expect((await s.reviewHistory(owner(), b.id)).items[0]).toMatchObject({
    kind: "review.assign",
    reason: "부재 재배정",
    revision: 1,
  });
  await expect(publish(f.pool, f.ctx, b.id, b.hash, "stale")).rejects.toThrow(
    "APPROVAL_STALE",
  );
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0].count,
  ).toBe("0");
});
test("strict HTTP contracts never accept actor/workspace overrides and authorize every route", async () => {
  let sent: unknown;
  const send = (_status: number, value: unknown) => {
    sent = value;
  };
  expect(
    await handleGovernanceRoute(
      {
        method: "POST",
        path: "/api/v1/governance/access-requests",
        body: { resourceId: "unknown", reason: "필요" },
        ctx: f.reader,
        send,
      },
      s,
    ),
  ).toBe(true);
  expect(sent).toEqual({ accepted: true });
  await expect(
    handleGovernanceRoute(
      {
        method: "POST",
        path: "/api/v1/governance/access-requests",
        body: {
          resourceId: "topic",
          reason: "필요",
          principalId: "fixture-owner",
        },
        ctx: f.reader,
        send,
      },
      s,
    ),
  ).rejects.toThrow();
  await expect(
    handleGovernanceRoute(
      {
        method: "GET",
        path: "/api/v1/governance/access-inbox",
        body: undefined,
        ctx: f.reader,
        send,
      },
      s,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
test("type policies validate safe keys, default to warning, use revision CAS and audit actual current settings", async () => {
  const d = {
    documentType: "기술 설계",
    requiredKeys: ["environment"],
    expectedRevision: 0,
    reason: "환경 필수",
  };
  await s.setTypePolicy(owner(), d);
  expect((await s.workbench(owner())).policies[0]).toMatchObject({
    mode: "warn",
    required_keys: ["environment"],
    revision: 1,
  });
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  expect(
    (await s.workbench(owner())).proposals.find((p) => p.id === b.id)
      ?.propertyWarnings,
  ).toMatchObject([{ key: "environment", mode: "warn" }]);
  expect((await s.reviewInbox(f.ctx)).items[0].propertyWarnings).toMatchObject([
    { key: "environment", mode: "warn" },
  ]);
  await expect(s.setTypePolicy(owner(), d)).rejects.toThrow("STALE_VERSION");
  await expect(
    s.setTypePolicy(owner(), {
      ...d,
      documentType: "다른 유형",
      requiredKeys: ["__proto__"],
    }),
  ).rejects.toThrow();
  await expect(s.setTypePolicy(f.reader, d)).rejects.toThrow("FORBIDDEN");
});
test("injected permissive authorizer cannot admit a reader to administrative mutations", async () => {
  const permissive = new GovernanceService(f.pool, async () => {});
  await expect(
    permissive.assignBusinessOwner(f.reader, "topic", {
      expectedRevision: 0,
      ownerId: "editor",
      backupId: "reviewer",
      reason: "권한 위조",
    }),
  ).rejects.toThrow("FORBIDDEN");
});
test("type cadence exposes actual due work without marking knowledge false and honors current visibility", async () => {
  await s.assignBusinessOwner(owner(), "topic", {
    expectedRevision: 0,
    ownerId: "editor",
    backupId: "reviewer",
    reason: "담당자",
  });
  await s.setTypePolicy(owner(), {
    documentType: "기술 설계",
    requiredKeys: [],
    mode: "warn",
    cadenceDays: 1,
    expectedRevision: 0,
    reason: "정기 검토",
  });
  const db = await f.pool.connect();
  try {
    const work = await dueReviewWork(
      db,
      f.ctx,
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(work).toMatchObject([
      {
        pageId: "topic",
        version: 1,
        ownerId: "editor",
        backupId: "reviewer",
        dueAt: "2026-10-30T00:00:00.000Z",
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT data->>'status' AS status FROM pages WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].status,
    ).toBe("미검증");
    await db.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    expect(
      await dueReviewWork(db, f.ctx, new Date("2026-11-01T00:00:00Z")),
    ).toEqual([]);
  } finally {
    db.release();
  }
});
test("access decisions cannot confer a missing team role or grant ancestral source access", async () => {
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND principal_id='reader'",
    [f.workspaceId],
  );
  await s.requestAccess(f.reader, { resourceId: "topic", reason: "권한 요청" });
  const req = (await s.accessInbox(owner())).items[0];
  await f.pool.query(
    "UPDATE access_team_members SET active=false WHERE team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1) AND principal_id='reader'",
    [f.workspaceId],
  );
  await expect(
    s.decideAccess(owner(), req.id, {
      expectedRevision: 1,
      expectedVersion: 1,
      decision: "approve",
      reason: "불가",
    }),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT status FROM workflow_access_requests WHERE id=$1",
        [req.id],
      )
    ).rows[0].status,
  ).toBe("pending");
  await s.decideAccess(owner(), req.id, {
    expectedRevision: 1,
    expectedVersion: 1,
    decision: "reject",
    reason: "현재 구성원 아님",
  });
  expect(
    (
      await f.pool.query(
        "SELECT decision_reason,status FROM workflow_access_requests WHERE id=$1",
        [req.id],
      )
    ).rows[0],
  ).toMatchObject({ status: "rejected", decision_reason: "현재 구성원 아님" });
});
test("review inbox and handoffs never expose private import proposal identifiers to page administrators", async () => {
  await s.assignBusinessOwner(owner(), "topic", {
    expectedRevision: 0,
    ownerId: "editor",
    backupId: "reviewer",
    reason: "담당자",
  });
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  await f.pool.query(
    "UPDATE batches SET data=data||$3::jsonb WHERE workspace_id=$1 AND id=$2",
    [
      f.workspaceId,
      b.id,
      { requestAuthorizationPending: true, importAuthorId: "editor" },
    ],
  );
  expect((await s.workbench(owner())).proposals).toEqual([]);
  expect((await s.reviewInbox(f.ctx)).items).toEqual([]);
  await f.pool.query(
    "UPDATE access_principals SET active=false WHERE id='editor'",
  );
  const handoffs = await s.handoffInbox(owner());
  expect(handoffs.items[0].work.proposalIds).toEqual([]);
});
test("policy/infrastructure errors are not converted to an empty successful inbox", async () => {
  const unavailable = new GovernanceService(
    f.pool,
    async (_db, _ctx, _action, resource) => {
      if (resource) throw Error("POLICY_UNAVAILABLE");
    },
  );
  await expect(unavailable.workbench(owner())).rejects.toThrow(
    "POLICY_UNAVAILABLE",
  );
});
test("company visibility is not current team membership for business responsibility", async () => {
  await f.pool.query(
    "UPDATE access_spaces SET visibility='company' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await f.pool.query(
    "UPDATE access_principals SET company_reader=true WHERE id='reader'",
  );
  await f.pool.query(
    "UPDATE access_team_members SET active=false WHERE team_id=(SELECT namespace_id FROM access_spaces WHERE workspace_id=$1) AND principal_id='reader'",
    [f.workspaceId],
  );
  try {
    await expect(
      s.assignBusinessOwner(owner(), "topic", {
        expectedRevision: 0,
        ownerId: "reader",
        backupId: "reviewer",
        reason: "구성원 아님",
      }),
    ).rejects.toThrow("NOT_FOUND");
  } finally {
    await f.pool.query(
      "UPDATE access_principals SET company_reader=false WHERE id='reader'",
    );
  }
});
test("business responsibility checks retained source ancestry of parent pages", async () => {
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'source','old-secret'),($1,'page','parent')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) SELECT workspace_id,'old-secret',jsonb_set(data,'{id}','\"old-secret\"') FROM sources WHERE workspace_id=$1 AND id='source-a'",
    [f.workspaceId],
  );
  for (const who of ["editor", "reviewer", "fixture-owner"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'source','old-secret',$2)",
      [f.workspaceId, who],
    );
  await f.pool.query(
    "INSERT INTO pages(workspace_id,id,data) SELECT workspace_id,'parent',jsonb_set(data,'{id}','\"parent\"') FROM pages WHERE workspace_id=$1 AND id='topic'",
    [f.workspaceId],
  );
  for (const who of ["editor", "reviewer", "reader", "fixture-owner"])
    await f.pool.query(
      "INSERT INTO resource_readers VALUES($1,'page','parent',$2)",
      [f.workspaceId, who],
    );
  await f.pool.query(
    "INSERT INTO versions VALUES($1,'parent',1,$2),($1,'parent',2,$3)",
    [
      f.workspaceId,
      { ...page.versions[0], sourceIds: ["old-secret"] },
      { ...page.versions[0], number: 2 },
    ],
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,parent_id) VALUES($1,'topic','parent')",
    [f.workspaceId],
  );
  await expect(
    s.assignBusinessOwner(owner(), "topic", {
      expectedRevision: 0,
      ownerId: "reader",
      backupId: "reviewer",
      reason: "부모 원본 검증",
    }),
  ).rejects.toThrow("NOT_FOUND");
});
