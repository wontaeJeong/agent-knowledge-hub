import { beforeEach, afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { WorkflowService } from "./service";
import { RuntimeService } from "../runtime/knowledge";
import { handleWorkflowRoute } from "./http";
let f: Awaited<ReturnType<typeof fixture>>, s: WorkflowService;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  s = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  await s.saveDraft(f.editor, {
    id: "private",
    expectedRevision: 0,
    title: "원본",
    content: "고정 비공개 본문",
  });
});
afterEach(async () => {
  await f?.pool.end();
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
});
async function call(
  ctx: typeof f.editor,
  path: string,
  body?: unknown,
): Promise<any> {
  let result: unknown;
  expect(
    await handleWorkflowRoute(
      {
        ctx,
        path: "/api/v1/workflows" + path.split("?")[0],
        query: new URLSearchParams(path.split("?")[1]),
        method: body === undefined ? "GET" : "POST",
        body,
        send: (_s, d) => {
          result = d;
        },
      },
      s,
    ),
    "manual disclosure endpoint",
  ).toBe(true);
  return result;
}
const input = () => ({
  expectedRevision: 1,
  title: "원본",
  parentId: null,
  readers: ["editor", "reviewer"],
  reviewerId: "reviewer",
  reason: "공유",
  mutationId: randomUUID(),
});
test("assigned reviewer sees only the frozen requested snapshot, never generic private drafts", async () => {
  const d = await call(f.editor, "/drafts/private/disclosure", input());
  const list = await call(f.ctx, "/draft-disclosures");
  expect(list.items[0]).toMatchObject({
    id: d.id,
    content: "고정 비공개 본문",
    status: "pending",
  });
  expect((await s.drafts(f.ctx)).items).toHaveLength(0);
  expect((await call(f.reader, "/draft-disclosures")).items).toHaveLength(0);
});
test("rejection and client personal-mode claims never create a source or proposal", async () => {
  await expect(
    call(f.editor, "/drafts/private/disclosure", {
      ...input(),
      policyMode: "personal",
    }),
  ).rejects.toThrow();
  const d = await call(f.editor, "/drafts/private/disclosure", input());
  await expect(
    call(f.editor, `/draft-disclosures/${d.id}/decision`, {
      hash: d.hash,
      decision: "approve",
      reason: "자기 승인",
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow();
  await call(f.ctx, `/draft-disclosures/${d.id}/decision`, {
    hash: d.hash,
    decision: "reject",
    reason: "수정 필요",
    mutationId: randomUUID(),
  });
  expect((await call(f.editor, "/draft-disclosures")).items[0].status).toBe(
    "rejected",
  );
  expect(
    (
      await f.pool.query("SELECT 1 FROM batches WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test("request and rejection reasons survive restart and exact idempotent replay for only authorized participants", async () => {
  const requestInput = {
    ...input(),
    reason: "운영 절차를 팀에서 검증해야 합니다",
  };
  const d = await call(f.editor, "/drafts/private/disclosure", requestInput);
  const { ManualDraftDisclosureService } = await import("./manual-disclosure");
  const restarted = new ManualDraftDisclosureService(s);
  for (const ctx of [f.editor, f.ctx])
    expect((await restarted.list(ctx)).items[0]).toMatchObject({
      requestReason: requestInput.reason,
    });
  expect(await restarted.request(f.editor, "private", requestInput)).toEqual(d);
  await expect(
    restarted.request(f.editor, "private", {
      ...requestInput,
      reason: "다른 사유",
    }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  const decision = {
    hash: d.hash,
    decision: "reject",
    reason: "롤백 담당자와 확인 절차를 보완해 주세요",
    mutationId: randomUUID(),
  };
  const decided = await restarted.decide(f.ctx, d.id, decision);
  expect(await restarted.decide(f.ctx, d.id, decision)).toEqual(decided);
  await expect(
    restarted.decide(f.ctx, d.id, { ...decision, reason: "다른 결정 사유" }),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  for (const ctx of [f.editor, f.ctx])
    expect(
      (await new ManualDraftDisclosureService(s).list(ctx)).items[0],
    ).toMatchObject({
      requestReason: requestInput.reason,
      decision: {
        decision: "reject",
        reason: decision.reason,
        principalId: "reviewer",
      },
    });
  expect((await restarted.list(f.reader)).items).toHaveLength(0);
  await s.deleteDraft(f.editor, "private", 1);
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT snapshot,decisions FROM workflow_draft_disclosures WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ),
  ).not.toContain(decision.reason);
});
test("revoked snapshots are hidden but unexpected policy and program failures are surfaced", async () => {
  await s.saveDraft(f.editor, {
    id: "private",
    expectedRevision: 1,
    title: "원본",
    content: "고정 비공개 본문",
    sourceIds: ["source-a"],
  });
  await call(f.editor, "/drafts/private/disclosure", {
    ...input(),
    expectedRevision: 2,
  });
  const { ManualDraftDisclosureService } = await import("./manual-disclosure");
  const service = new ManualDraftDisclosureService(s);
  const { vi } = await import("vitest");
  for (const error of [
    new Error("POLICY_UNAVAILABLE"),
    new Error("database dependency failed"),
    new TypeError("invalid policy shape"),
  ]) {
    const mock = vi.spyOn(service, "current").mockRejectedValueOnce(error);
    try {
      await expect(service.list(f.editor)).rejects.toThrow(error.message);
    } finally {
      mock.mockRestore();
    }
  }
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await service.list(f.editor)).items).toHaveLength(0);
});

async function queued(count: number, approve = false, sourceBound = false) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const draftId = `queue-${i}`;
    await s.saveDraft(f.editor, {
      id: draftId,
      expectedRevision: 0,
      title: draftId,
      content: `private ${i}`,
      sourceIds: sourceBound ? ["source-a"] : [],
    });
    const d = await s.manualDisclosures.request(f.editor, draftId, {
      ...input(),
      title: draftId,
    });
    if (approve && i > 0)
      await s.manualDisclosures.decide(f.ctx, d.id, {
        hash: d.hash,
        decision: "approve",
        reason: "검토",
        mutationId: randomUUID(),
      });
    result.push({ ...d, draftId });
  }
  return result;
}
test(
  "older pending and exact approved disclosures remain reachable behind completed and hidden raw prefixes",
  { timeout: 30000 },
  async () => {
    const rows = await queued(28, true);
    for (const ctx of [f.editor, f.ctx]) {
      const first = await s.manualDisclosures.list(ctx);
      expect(first.items).toHaveLength(25);
      const last = await s.manualDisclosures.list(ctx, {
        cursor: first.nextCursor,
      });
      expect(last.items.some((x) => x.id === rows[0].id)).toBe(true);
      expect(
        (await s.manualDisclosures.list(ctx, { draftId: rows[1].draftId }))
          .items[0].id,
      ).toBe(rows[1].id);
    }
    for (let i = 1; i < 28; i++)
      await s.saveDraft(f.editor, {
        id: rows[i].draftId,
        expectedRevision: 1,
        title: rows[i].draftId,
        content: "stale",
      });
    for (const ctx of [f.editor, f.ctx])
      expect(
        (await s.manualDisclosures.list(ctx)).items.map((x) => x.id),
      ).toEqual([rows[0].id]);
  },
);
test(
  "assigned pending cursor traverses timestamp ties and rejects identity filter data or authority changes",
  { timeout: 30000 },
  async () => {
    const rows = await queued(28);
    await f.pool.query(
      "UPDATE workflow_draft_disclosures SET created_at='2026-01-01T00:00:00Z' WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const q = { queue: "assigned-pending" as const };
    const first = await s.manualDisclosures.list(f.ctx, q),
      second = await s.manualDisclosures.list(f.ctx, {
        ...q,
        cursor: first.nextCursor,
      });
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(28);
    expect([...first.items, ...second.items].map((x) => x.id)).toEqual(
      rows
        .map((x) => x.id)
        .sort()
        .reverse(),
    );
    await expect(
      s.manualDisclosures.list(f.editor, { ...q, cursor: first.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    await expect(
      s.manualDisclosures.list(f.ctx, { cursor: first.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    await f.pool.query(
      "UPDATE access_principals SET team_create=NOT team_create WHERE id='editor'",
    );
    await expect(
      s.manualDisclosures.list(f.ctx, { ...q, cursor: first.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    const renewed = await s.manualDisclosures.list(f.ctx, q);
    await s.saveDraft(f.editor, {
      id: rows[0].draftId,
      expectedRevision: 1,
      title: rows[0].draftId,
      content: "changed",
    });
    await expect(
      s.manualDisclosures.list(f.ctx, { ...q, cursor: renewed.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
  },
);

test(
  "bounded scan reports continuation through hidden requests without IDs or counts and exact submitted resume works",
  { timeout: 60000 },
  async () => {
    const old = await s.manualDisclosures.request(f.editor, "private", input());
    await s.manualDisclosures.decide(f.ctx, old.id, {
      hash: old.hash,
      decision: "approve",
      reason: "검토",
      mutationId: randomUUID(),
    });
    const submitted = await s.submitNewDraft(f.editor, "private", {
      expectedRevision: 1,
      title: "원본",
      parentId: null,
      reason: "제출",
      disclosureId: old.id,
      disclosureHash: old.hash,
      mutationId: randomUUID(),
    });
    // Repeated real requests on one revision become stale together after a save.
    await s.saveDraft(f.editor, {
      id: "hidden-prefix",
      expectedRevision: 0,
      title: "숨은 요청",
      content: "hidden secret",
    });
    for (let i = 0; i < 101; i++)
      await s.manualDisclosures.request(f.editor, "hidden-prefix", {
        ...input(),
        title: "숨은 요청",
      });
    await s.saveDraft(f.editor, {
      id: "hidden-prefix",
      expectedRevision: 1,
      title: "숨은 요청",
      content: "changed",
    });
    for (const ctx of [f.editor, f.ctx]) {
      const first = await s.manualDisclosures.list(ctx);
      expect(first.items).toEqual([]);
      expect(first.partial).toBe(true);
      expect(first.nextCursor).toBeTruthy();
      expect(Object.keys(first).sort()).toEqual([
        "items",
        "nextCursor",
        "partial",
      ]);
      expect(JSON.stringify(first)).not.toContain("hidden-prefix");
      const next = await s.manualDisclosures.list(ctx, {
        cursor: first.nextCursor,
      });
      expect(next.items[0].id).toBe(old.id);
      expect(next.nextCursor).toBeNull();
      const exact = await s.manualDisclosures.list(ctx, { draftId: "private" });
      expect(exact.items[0].submission?.batchId).toBe(submitted.batchId);
    }
  },
);
test(
  "source ACL, reviewer configuration, issued credential and workspace/filter changes invalidate continuations",
  { timeout: 30000 },
  async () => {
    await queued(27, false, true);
    const { AccessService } = await import("../access/index");
    const access = new AccessService(f.pool);
    const credential = await access.issueCredential(f.ctx, {
      actions: ["knowledge.read"],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const credentialCtx = await access.authenticateCredential(
      credential.secret,
      f.workspaceId,
    );
    const first = await s.manualDisclosures.list(f.ctx);
    await expect(
      s.manualDisclosures.list(credentialCtx, { cursor: first.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    await expect(
      s.manualDisclosures.list(f.ctx, {
        draftId: "private",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("STALE_CURSOR");
    process.env.IMPORT_DISCLOSURE_REVIEWERS = "";
    await expect(
      s.manualDisclosures.list(f.ctx, { cursor: first.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
    const fresh = await s.manualDisclosures.list(f.ctx);
    await f.pool.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
      [f.workspaceId],
    );
    await expect(
      s.manualDisclosures.list(f.ctx, { cursor: fresh.nextCursor }),
    ).rejects.toThrow("STALE_CURSOR");
    expect((await s.manualDisclosures.list(f.ctx)).items).toEqual([]);
  },
);

test("HTTP disclosure query is strict and exact lookup preserves author scope", async () => {
  const d = await call(f.editor, "/drafts/private/disclosure", input());
  expect(
    (await call(f.editor, "/draft-disclosures?draftId=private")).items[0].id,
  ).toBe(d.id);
  expect(
    (await call(f.reader, "/draft-disclosures?draftId=private")).items,
  ).toEqual([]);
  await expect(
    call(f.ctx, "/draft-disclosures?queue=unknown"),
  ).rejects.toThrow();
  await expect(call(f.ctx, "/draft-disclosures?limit=1000")).rejects.toThrow();
  await expect(call(f.ctx, "/draft-disclosures?cursor=forged")).rejects.toThrow(
    "STALE_CURSOR",
  );
});
