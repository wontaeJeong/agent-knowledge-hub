import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access";
import { RuntimeService } from "../runtime/knowledge";
import { WorkflowService } from "../workflows/service";
import { GovernanceService } from "../workflows/governance/service";
import { transaction } from "../database";
const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
afterEach(async () => {
  delete process.env.IMPORT_DISCLOSURE_REVIEWERS;
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const workflows = new WorkflowService(
    f.pool,
    new RuntimeService(f.pool),
    authorizeInTransaction,
  );
  const governance = new GovernanceService(f.pool, authorizeInTransaction);
  const m = await import(/* @vite-ignore */ String("./home")).catch(() => ({
    HomeService: undefined,
  }));
  expect(m.HomeService, "personal home service").toBeDefined();
  return {
    ...f,
    workflows,
    governance,
    home: new m.HomeService!(f.pool, workflows, governance),
  };
}
async function draft(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  who = f.editor,
) {
  return f.workflows.saveDraft(who, {
    id,
    expectedRevision: 0,
    title: id,
    content: "private",
    pageId: "topic",
    baseVersion: 1,
  });
}
test("home contains only own drafts, own review requests and own access metadata without creating visits", async () => {
  const f = await setup();
  await draft(f, "own-draft");
  await draft(f, "other-draft", f.ctx);
  const proposal = await f.workflows.proposeEdit(f.editor, "topic", {
    baseVersion: 1,
    content: "edit",
    reason: "fix",
  });
  await f.pool.query(
    "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,reason,resource_type) VALUES('own-access',$1,'editor','topic','reason','page'),('other-access',$1,'reader','topic','reason','page')",
    [f.workspaceId],
  );
  const h = await f.home.read(f.editor);
  expect(h.drafts.items.map((x: any) => x.id)).toEqual(["own-draft"]);
  expect(h.requests.items.map((x: any) => x.id)).toEqual([proposal.id]);
  expect(h.accessRequests.items.map((x: any) => x.id)).toEqual(["own-access"]);
  expect(h.drafts.items[0].href).toBe(
    `/?app=1&space=${f.workspaceId}&section=compose&draft=own-draft`,
  );
  expect(h.requests.items[0].href).toBe(
    `/?app=1&space=${f.workspaceId}&section=tasks&targetKind=review&targetId=${proposal.id}`,
  );
  expect(JSON.stringify(h)).not.toContain("private");
  expect(
    (await f.workflows.personalSnapshot(f.editor, "recent")).items,
  ).toEqual([]);
  expect((await f.home.read(f.reader)).drafts.status).toBe("error");
});
test("assigned review requires current canonical qualification and approval remains distinct from publication", async () => {
  const f = await setup();
  const p = await f.workflows.proposeEdit(f.editor, "topic", {
    baseVersion: 1,
    content: "edit",
    reason: "fix",
  });
  const h = await f.home.read(f.ctx);
  expect(h.reviews.status).toBe("ready");
  expect(h.reviews.items.map((x: any) => x.id)).toEqual([p.id]);
  expect(h.reviews.items[0].assigned).toBe(false);
  await f.pool.query(
    "INSERT INTO governance_review_assignments(workspace_id,batch_id,revision,assignee_ids,backup_id,deadline,absent_ids,batch_hash) VALUES($1,$2,1,ARRAY['reviewer'],'editor',now()+interval '1 day',ARRAY[]::text[],$3)",
    [f.workspaceId, p.id, p.hash],
  );
  expect((await f.home.read(f.ctx)).reviews.items[0].assigned).toBe(true);
  expect((await f.home.read(f.editor)).reviews.items).toEqual([]);
  await f.pool.query(
    "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect((await f.home.read(f.ctx)).reviews.items).toEqual([]);
  expect(
    (
      await f.pool.query(
        "SELECT data->>'status' status FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, p.id],
      )
    ).rows[0].status,
  ).toBe("pending");
});
test("bounded cursors progress past hidden rows and bind actor, widget, current data and authority", async () => {
  const f = await setup();
  for (let i = 0; i < 28; i++) await draft(f, `d${String(i).padStart(2, "0")}`);
  const first = await f.home.widget(f.editor, "drafts");
  expect(first.items).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  expect(
    (await f.home.widget(f.editor, "drafts", first.nextCursor)).items,
  ).toHaveLength(3);
  await expect(
    f.home.widget(f.ctx, "drafts", first.nextCursor),
  ).rejects.toThrow("STALE_CURSOR");
  await expect(
    f.home.widget(f.editor, "requests", first.nextCursor),
  ).rejects.toThrow("STALE_CURSOR");
  await draft(f, "new");
  await expect(
    f.home.widget(f.editor, "drafts", first.nextCursor),
  ).rejects.toThrow("STALE_CURSOR");
  const renewed = await f.home.widget(f.editor, "drafts");
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  await expect(
    f.home.widget(f.editor, "drafts", renewed.nextCursor),
  ).rejects.toThrow("STALE_CURSOR");
  const hidden = await f.home.widget(f.editor, "drafts");
  expect(hidden.items).toEqual([]);
  expect(hidden.nextCursor).toBeTruthy();
  expect(
    (await f.home.widget(f.editor, "drafts", hidden.nextCursor)).nextCursor,
  ).toBeNull();
});
test("a failed widget transaction preserves ready siblings and a session failure fails closed globally", async () => {
  const f = await setup();
  await draft(f, "survives");
  f.governance.ownAccessRequests = async (ctx: any) =>
    transaction(f.pool, ctx.workspaceId, async (db) => {
      await db.query("SELECT 1/0");
      return { items: [], nextAfter: null };
    });
  const h = await f.home.read(f.editor);
  expect(h.accessRequests).toMatchObject({
    status: "error",
    items: [],
    nextCursor: null,
  });
  expect(h.drafts.items[0].id).toBe("survives");
  expect(h.favorites).toMatchObject({ status: "ready", items: [] });
  await expect(
    f.home.read({
      ...f.editor,
      authorization: {
        revalidate: async () => {
          throw Error("UNAUTHENTICATED");
        },
        assertSession: async () => {},
      },
    }),
  ).rejects.toThrow("UNAUTHENTICATED");
});

test("own disclosure requests resume exact draft as a distinct pre-knowledge review stage without bodies", async () => {
  process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
  const f = await setup();
  await f.workflows.saveDraft(f.editor, {
    id: "manual",
    expectedRevision: 0,
    title: "공개 검토할 초안",
    content: "DO NOT DOWNLOAD",
  });
  const { randomUUID } = await import("node:crypto");
  const d = await f.workflows.manualDisclosures.request(f.editor, "manual", {
    expectedRevision: 1,
    title: "공개 검토할 초안",
    parentId: null,
    readers: ["editor", "reviewer"],
    reviewerId: "reviewer",
    reason: "공개 범위 검토",
    mutationId: randomUUID(),
  });
  const h = await f.home.read(f.editor);
  expect(h.requests.items).toContainEqual(
    expect.objectContaining({
      id: d.id,
      state: "disclosure-pending",
      href: `/?app=1&space=${f.workspaceId}&section=compose&draft=manual`,
    }),
  );
  expect(JSON.stringify(h)).not.toContain("DO NOT DOWNLOAD");
  expect(
    (await f.home.read(f.ctx)).requests.items.some((x: any) => x.id === d.id),
  ).toBe(false);
});

test("failure feed reads only own canonical jobs and current input ACL, never successful or other-owner records", async () => {
  const f = await setup();
  const { JobService } = await import("../jobs/service");
  const { requireRead } = await import("../repository");
  const jobs = new JobService(f.pool, {
    authorize: async (db, ctx) =>
      authorizeInTransaction(
        db,
        { ...ctx, credentialId: undefined },
        "knowledge.read",
      ),
    resolveIdentity: async (_db, i) => ({ ...i }),
    policyFingerprint: async () => "home-test",
    validateScope: async (db, ctx, input) => {
      for (const id of input.pageIds) await requireRead(db, ctx, "page", id);
      for (const id of input.sourceIds)
        await requireRead(db, ctx, "source", id);
    },
  });
  const input = {
    kind: "lint",
    key: "failed",
    payload: {},
    pageIds: ["topic"],
    sourceIds: ["source-a"],
    reservation: { tokens: 0, costMicros: 0 },
    timeoutMs: 1000,
    maxAttempts: 1,
  };
  const own = await jobs.enqueue({ ...f.editor, credentialId: "test" }, input),
    other = await jobs.enqueue(
      { ...f.ctx, credentialId: "test" },
      { ...input, key: "other" },
    );
  await f.pool.query(
    "UPDATE durable_jobs SET status='dead',error_code='EXECUTION_FAILED' WHERE id=ANY($1::text[])",
    [[own.id, other.id]],
  );
  await jobs.enqueue(
    { ...f.editor, credentialId: "test" },
    { ...input, key: "healthy" },
  );
  const m = await import("./home");
  const home = new m.HomeService(f.pool, f.workflows, f.governance, jobs);
  const failures = await home.widget(f.editor, "failedJobs");
  expect(failures.items.map((x) => x.id)).toEqual([own.id]);
  expect(failures.items[0].href).toBe(
    `/?app=1&space=${f.workspaceId}&section=tasks&targetKind=job&targetId=${own.id}`,
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await home.widget(f.editor, "failedJobs")).items).toEqual([]);
});

test("current capability downgrade denies drafts without converting successful authorized siblings to zero failures", async () => {
  const f = await setup();
  await draft(f, "private-before-revoke");
  await f.pool.query(
    "UPDATE access_grants SET role='read' WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  const h = await f.home.read(f.editor);
  expect(h.drafts).toMatchObject({ status: "error", items: [] });
  expect(h.favorites).toMatchObject({ status: "ready", items: [] });
  expect(h.recent.status).toBe("ready");
});

test("own revision requests remain actionable and an approved review never becomes a published version by reading Home", async () => {
  const f = await setup();
  const runtime = new RuntimeService(f.pool);
  const { approve } = await import("../publication");
  const approved = await f.workflows.proposeEdit(f.editor, "topic", {
    baseVersion: 1,
    content: "approved content",
    reason: "review",
  });
  await approve(f.pool, f.ctx, approved.id, approved.hash);
  const h = await f.home.read(f.editor);
  expect(h.requests.items.find((x: any) => x.id === approved.id)?.state).toBe(
    "approved",
  );
  expect(
    (
      await f.pool.query(
        "SELECT max(number)::integer n FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(1);
  const rejected = approved;
  await runtime.reject(f.ctx, rejected.id, rejected.hash, "수정 필요");
  expect(
    (await f.home.read(f.editor)).revisions.items.map((x: any) => x.id),
  ).toEqual([rejected.id]);
});

test("unavailable own-access/disclosure data stays local while common authority unavailability fails closed", async () => {
  const f = await setup();
  await draft(f, "sibling");
  for (const table of [
    "workflow_access_requests",
    "workflow_draft_disclosures",
  ]) {
    await f.pool.query(`ALTER TABLE ${table} RENAME TO akh_c4_unavailable`);
    try {
      const h = await f.home.read(f.editor);
      expect(h.drafts).toMatchObject({
        status: "ready",
        items: [expect.objectContaining({ id: "sibling" })],
      });
      expect(h.favorites.status).toBe("ready");
      if (table === "workflow_access_requests") {
        expect(h.accessRequests.status).toBe("error");
        expect(h.requests.status).toBe("ready");
      } else {
        expect(h.requests.status).toBe("error");
        expect(h.revisions.status).toBe("error");
        expect(h.accessRequests.status).toBe("ready");
      }
    } finally {
      await f.pool.query(`ALTER TABLE akh_c4_unavailable RENAME TO ${table}`);
    }
  }
  await f.pool.query("ALTER TABLE access_grants RENAME TO akh_c4_unavailable");
  try {
    await expect(f.home.read(f.editor)).rejects.toThrow();
  } finally {
    await f.pool.query(
      "ALTER TABLE akh_c4_unavailable RENAME TO access_grants",
    );
  }
});
test("request cursors bind only server-chosen feed dependencies and reject relevant request changes", async () => {
  const f = await setup();
  await f.pool.query(
    "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,reason,resource_type) SELECT 'access-'||i,$1,'editor','topic','reason','page' FROM generate_series(1,27) i",
    [f.workspaceId],
  );
  const first = await f.home.widget(f.editor, "accessRequests");
  expect(first.items).toHaveLength(25);
  expect(
    (await f.home.widget(f.editor, "accessRequests", first.nextCursor)).items,
  ).toHaveLength(2);
  await f.pool.query(
    "UPDATE workflow_access_requests SET status='approved',revision=revision+1 WHERE workspace_id=$1 AND id='access-1'",
    [f.workspaceId],
  );
  await expect(
    f.home.widget(f.editor, "accessRequests", first.nextCursor),
  ).rejects.toThrow("STALE_CURSOR");
});
