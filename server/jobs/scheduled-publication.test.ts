import { afterEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../test-support";
import { draftOf } from "../../src/domain/wiki";
import { propose, approve } from "../publication";
import { ScheduledPublicationService } from "./scheduled-publication";
import { initializeSessionPolicy } from "../identity/sessions";
import { sessionHash } from "../runtime/auth";
import type { Context } from "../service";
import { inventory } from "../retention/inventory";
import { selectErasureRows, replayProductErasure } from "../operations/erasure";
const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const sessionId = sessionHash(crypto.randomUUID());
  await f.pool.query(
    "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '20 minutes','reviewer','unused')",
    [sessionId, f.workspaceId],
  );
  await initializeSessionPolicy(f.pool, {
    sessionId,
    principalId: "reviewer",
    workspaceId: f.workspaceId,
  });
  const ctx: Context = {
    ...f.ctx,
    authorization: {
      sessionId,
      verifiedIssuer: "fixture",
      revalidate: async () => {},
      assertSession: async (db) => {
        if (
          !(
            await db.query(
              "SELECT 1 FROM runtime_sessions WHERE id=$1 AND expires_at>clock_timestamp()",
              [sessionId],
            )
          ).rowCount
        )
          throw Error("AUTHORIZATION_REQUIRED");
      },
    },
  };
  const b = await propose(
    f.pool,
    f.editor,
    [{ ...draftOf(page), content: "예약 검토 내용" }],
    ["source-a"],
  );
  await approve(f.pool, ctx, b.id, b.hash);
  const service = new ScheduledPublicationService(f.pool, async (row) => {
    if (row.session_id !== sessionId) throw Error("AUTHORIZATION_REQUIRED");
    return ctx;
  });
  const dueAt = new Date(Date.now() + 60000).toISOString();
  const input = { hash: b.hash, dueAt };
  const preview = await service.preview(ctx, b.id, input);
  return { ...f, ctx, b, service, input, preview, sessionId };
}
async function schedule(f: Awaited<ReturnType<typeof setup>>) {
  return f.service.create(
    f.ctx,
    f.b.id,
    {
      ...f.input,
      previewHash: f.preview.previewHash,
      confirm: "SCHEDULE_APPROVED_PUBLICATION",
    },
    "test-schedule",
  );
}
async function due(f: Awaited<ReturnType<typeof setup>>) {
  await f.pool.query(
    "UPDATE scheduled_publications SET due_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
    [f.workspaceId],
  );
}
test("preview performs no publication effects; consent is fixed, duplicate create and restarted due workers publish once", async () => {
  const f = await setup();
  expect(
    (
      await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(f.preview).toMatchObject({
    dueAt: f.input.dueAt,
    versions: { topic: 2 },
  });
  const s = await schedule(f);
  expect((await schedule(f)).id).toBe(s.id);
  expect(
    (
      await f.pool.query(
        "SELECT session_id FROM scheduled_publications WHERE id=$1",
        [s.id],
      )
    ).rows[0].session_id,
  ).toMatch(/^[a-f0-9]{64}$/);
  await due(f);
  await Promise.all([
    f.service.runDue(),
    new ScheduledPublicationService(f.pool, async () => f.ctx).runDue(),
  ]);
  expect(await f.service.read(f.ctx, s.id)).toMatchObject({
    status: "published",
    result: { versions: { topic: 2 } },
  });
  await f.service.runDue();
  expect(
    (
      await f.pool.query(
        "SELECT number FROM versions WHERE workspace_id=$1 AND page_id='topic' ORDER BY number",
        [f.workspaceId],
      )
    ).rows.map((r) => r.number),
  ).toEqual([1, 2]);
});
test("cancel wins atomically even after worker fetched consent, and remains available when feature disabled", async () => {
  const f = await setup();
  const s = await schedule(f);
  await due(f);
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => (begin = r));
  const paused = new Promise<void>((r) => (finish = r));
  const worker = new ScheduledPublicationService(f.pool, async () => {
    begin();
    await paused;
    return f.ctx;
  });
  const work = worker.runDue();
  await started;
  await f.pool.query(
    "INSERT INTO feature_policies VALUES($1,'scheduledPublication',false,1)",
    [f.workspaceId],
  );
  expect(await f.service.cancel(f.ctx, s.id)).toMatchObject({
    status: "cancelled",
  });
  finish();
  await work;
  expect(await f.service.read(f.ctx, s.id)).toMatchObject({
    status: "cancelled",
  });
  expect(
    (
      await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});
test.each([
  "hash",
  "base",
  "policy",
  "reviewer",
  "source",
  "protected",
  "session",
  "feature",
])(
  "due execution fails honestly after %s changes without publishing",
  async (change) => {
    const f = await setup();
    const s = await schedule(f);
    await due(f);
    if (change === "hash")
      await f.pool.query(
        "UPDATE batches SET data=jsonb_set(data,'{updates,0,content}','\"changed\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (change === "base")
      await f.pool.query(
        "UPDATE pages SET data=jsonb_set(data,'{title}','\"changed\"') WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (change === "policy")
      await f.pool.query(
        "UPDATE access_spaces SET policy_version=policy_version+1 WHERE workspace_id=$1",
        [f.workspaceId],
      );
    if (change === "reviewer")
      await f.pool.query(
        "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
        [f.workspaceId],
      );
    if (change === "source")
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
        [f.workspaceId],
      );
    if (change === "protected")
      await f.pool.query(
        "INSERT INTO workflow_document_state(workspace_id,page_id,state,revision,data) VALUES($1,'topic','active',1,'{\"protected\":true}') ON CONFLICT(workspace_id,page_id) DO UPDATE SET data=excluded.data",
        [f.workspaceId],
      );
    if (change === "session")
      await f.pool.query("DELETE FROM runtime_sessions WHERE id=$1", [
        f.sessionId,
      ]);
    if (change === "feature")
      await f.pool.query(
        "INSERT INTO feature_policies VALUES($1,'scheduledPublication',false,1)",
        [f.workspaceId],
      );
    await f.service.runDue();
    expect(
      (
        await f.pool.query(
          "SELECT status FROM scheduled_publications WHERE id=$1",
          [s.id],
        )
      ).rows[0],
    ).toMatchObject({ status: "failed" });
    expect(
      (
        await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
          f.workspaceId,
        ])
      ).rowCount,
    ).toBe(0);
  },
);
test("refuses schedules beyond current session horizon and all machine credentials", async () => {
  const f = await setup();
  await expect(
    f.service.preview(f.ctx, f.b.id, {
      ...f.input,
      dueAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  ).rejects.toThrow("SCHEDULE_AUTHORIZATION_EXPIRES");
  await expect(
    f.service.preview({ ...f.ctx, credentialId: "machine" }, f.b.id, f.input),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    f.service.create(
      f.ctx,
      f.b.id,
      {
        ...f.input,
        previewHash: "0".repeat(64),
        confirm: "SCHEDULE_APPROVED_PUBLICATION",
      },
      "x",
    ),
  ).rejects.toThrow("SCHEDULE_PREVIEW_STALE");
});
test("typed source to batch scheduling lineage survives erasure preview and recovery retires pending execution", async () => {
  const f = await setup();
  const s = await schedule(f);
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    const rows = await inventory(db, f.workspaceId);
    expect(
      selectErasureRows(rows, { kind: "source", id: "source-a" }).some(
        (r) => r.table === "scheduled_publications" && r.data.id === s.id,
      ),
    ).toBe(true);
    await db.query("ROLLBACK");
    await db.query("BEGIN");
    await replayProductErasure(db, f.workspaceId, [
      { kind: "source", id: "source-a" },
    ]);
    await db.query("COMMIT");
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  expect(
    (
      await f.pool.query(
        "SELECT status FROM scheduled_publications WHERE id=$1",
        [s.id],
      )
    ).rows[0].status,
  ).toBe("cancelled");
  await f.service.runDue();
  expect(
    (
      await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
});

test("publication effect failure rolls back versions and receipts, then records terminal failure; completed execution cannot be cancelled", async () => {
  const f = await setup();
  const s = await schedule(f);
  await due(f);
  await f.pool.query(
    "CREATE FUNCTION task14_fail_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_WRITE_FAILURE'; END $$; CREATE TRIGGER task14_fail_version BEFORE INSERT ON versions FOR EACH ROW EXECUTE FUNCTION task14_fail_version()",
  );
  try {
    await f.service.runDue();
  } finally {
    await f.pool.query(
      "DROP TRIGGER task14_fail_version ON versions; DROP FUNCTION task14_fail_version()",
    );
  }
  expect(
    (
      await f.pool.query(
        "SELECT status,error_code FROM scheduled_publications WHERE id=$1",
        [s.id],
      )
    ).rows[0],
  ).toEqual({ status: "failed", error_code: "SYNTHETIC_WRITE_FAILURE" });
  expect(
    (
      await f.pool.query("SELECT number FROM versions WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rows.map((r) => r.number),
  ).toEqual([1]);
  expect(
    (
      await f.pool.query("SELECT 1 FROM publications WHERE workspace_id=$1", [
        f.workspaceId,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM requests WHERE workspace_id=$1 AND key LIKE 'scheduled-publication:%'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(0);
  await expect(f.service.cancel(f.ctx, s.id)).rejects.toThrow(
    "SCHEDULE_FINISHED",
  );
});
test("expired consent and substituted worker identity fail closed; site disable rejects creation without hiding accepted records", async () => {
  const f = await setup();
  const s = await schedule(f);
  await due(f);
  await f.pool.query(
    "UPDATE scheduled_publications SET grant_expires_at=now()-interval '1 second' WHERE id=$1",
    [s.id],
  );
  await f.service.runDue();
  expect(await f.service.read(f.ctx, s.id)).toMatchObject({
    status: "failed",
    errorCode: "AUTHORIZATION_REQUIRED",
  });
  const g = await setup();
  const other = await schedule(g);
  await due(g);
  await new ScheduledPublicationService(g.pool, async () => ({
    ...g.ctx,
    principalId: "editor",
  })).runDue();
  expect(await g.service.read(g.ctx, other.id)).toMatchObject({
    status: "failed",
    errorCode: "AUTHORIZATION_REQUIRED",
  });
  await f.pool.query(
    "INSERT INTO feature_policies VALUES($1,'scheduledPublication',false,1)",
    [f.workspaceId],
  );
  await expect(f.service.preview(f.ctx, f.b.id, f.input)).rejects.toThrow(
    "FEATURE_DISABLED",
  );
});
