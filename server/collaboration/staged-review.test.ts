import { afterEach, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture, adoptFixture, page } from "../test-support";
import { KnowledgeService } from "../service";
import { authorizeInTransaction } from "../access";
import { CollaborationService, resolveGovernanceResponsibility } from "./index";
import { RuntimeService } from "../runtime/knowledge";
import { approveInProcessModelFixture } from "../policy/test-fixture";
import { migrate, transaction } from "../database";
const pools: Awaited<ReturnType<typeof fixture>>["pool"][] = [];
const update = {
  id: "topic",
  title: page.title,
  summary: page.summary,
  content: "변경 내용",
  sourceIds: ["source-a"],
  baseVersion: 1,
  scope: "team" as const,
  links: [],
  facts: [],
};
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const service = new CollaborationService(
    f.pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async () => {},
      verifyRecipient: async () => {
        throw Error("UNCONFIGURED");
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: "https://knowledge.example.test" },
  );
  await service.subscribe(f.ctx, { scope: "space", enabled: true });
  return { ...f, service, core: new KnowledgeService(f.pool) };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});
async function staged(f: Fixture) {
  return f.core.propose(f.editor, [update], ["source-a"], {
    mode: "model",
    requestAuthorizationPending: true,
  });
}
async function events(f: Fixture) {
  return (
    await f.pool.query(
      "SELECT *,created_at::text AS exact_created_at FROM collaboration_events WHERE workspace_id=$1 AND kind='change-review-request'",
      [f.workspaceId],
    )
  ).rows;
}
async function release(f: Fixture, id: string) {
  await transaction(f.pool, f.workspaceId, (db) =>
    db.query(
      "UPDATE batches SET data=data-'requestAuthorizationPending' WHERE workspace_id=$1 AND id=$2",
      [f.workspaceId, id],
    ),
  );
}
async function notices(f: Fixture) {
  return (await f.service.notifications(f.ctx)).items.flatMap(
    (item) => item.events,
  );
}
async function legacyCapture(f: Fixture) {
  const sql = await readFile(
    new URL(
      "../migrations/120-collaboration-subscriptions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await f.pool.query(
    sql
      .slice(sql.indexOf("CREATE FUNCTION"), sql.indexOf("CREATE TRIGGER"))
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
  );
  // The only schema change in 130 is the function above plus a data repair.
  // Restoring 120's function and migration ledger recreates the pre-upgrade DB.
  await f.pool.query("DELETE FROM schema_migrations WHERE version=130");
}
async function currentCapture(f: Fixture) {
  // Exercise the real checksum-aware upgrade runner, then its no-op retry.
  await migrate(f.pool);
}

test("staged proposals create no event until release, then concurrent retries deliver exactly one currently authorized review notice", async () => {
  const f = await setup();
  const b = await staged(f);
  expect(await events(f)).toEqual([]);
  expect(await f.service.scanEvents()).toBe(0);
  expect(await notices(f)).toEqual([]);
  await release(f, b.id);
  expect(await events(f)).toHaveLength(1);
  await Promise.all([f.service.scanEvents(), f.service.scanEvents()]);
  expect(await notices(f)).toMatchObject([{ kind: "change-review-request" }]);
  const created = (await events(f))[0].exact_created_at;
  await release(f, b.id);
  expect(await f.service.scanEvents()).toBe(0);
  expect((await events(f))[0].exact_created_at).toBe(created);
  expect(await notices(f)).toHaveLength(1);
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
    [f.workspaceId],
  );
  expect(await notices(f)).toEqual([]);
});
for (const projected of [false, true])
  test(`legacy ${projected ? "consumed" : "unconsumed"} staged event survives upgrade and is requeued at actual release`, async () => {
    const f = await setup();
    await legacyCapture(f);
    const b = await staged(f);
    await f.pool.query(
      "UPDATE collaboration_events SET created_at='2020-01-01Z',projected_at=CASE WHEN $2 THEN now() END WHERE workspace_id=$1",
      [f.workspaceId, projected],
    );
    await currentCapture(f);
    expect(await f.service.scanEvents()).toBe(0);
    expect((await events(f))[0].projected_at !== null).toBe(projected);
    expect(await notices(f)).toEqual([]);
    await release(f, b.id);
    const [event] = await events(f);
    expect(event).toMatchObject({
      id: `review:${b.id}:${b.hash}`,
      projected_at: null,
    });
    expect(new Date(event.created_at).getUTCFullYear()).toBeGreaterThan(2020);
    await Promise.all([f.service.scanEvents(), f.service.scanEvents()]);
    expect(await notices(f)).toMatchObject([{ kind: "change-review-request" }]);
    expect(await f.service.scanEvents()).toBe(0);
  });
for (const fail of [false, true])
  test(`runtime final authorization barrier ${fail ? "discards staged batch with zero events/notices" : "releases one review event after a pre-release scan"}`, async () => {
    const f = await setup();
    await approveInProcessModelFixture(f.pool, f.workspaceId);
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      resume = r;
    });
    let rejectSession = false;
    const runtime = new RuntimeService(f.pool, async () => ({
      updates: [update],
    }));
    const pending = runtime
      .ingest(
        {
          ...f.editor,
          authorization: {
            revalidate: async () => {
              if (
                (
                  await f.pool.query(
                    "SELECT 1 FROM batches WHERE workspace_id=$1 AND data->>'requestAuthorizationPending'='true'",
                    [f.workspaceId],
                  )
                ).rowCount
              ) {
                entered();
                await hold;
              }
            },
            assertSession: async () => {
              if (rejectSession) throw Error("UNAUTHENTICATED");
            },
          },
        },
        ["source-a"],
        "model",
      )
      .then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
    try {
      await waiting;
      expect(await runtime.changesets(f.ctx)).toEqual([]);
      expect(await events(f)).toEqual([]);
      expect(await f.service.scanEvents()).toBe(0);
      expect(await notices(f)).toEqual([]);
      rejectSession = fail;
      resume();
      const result = await pending;
      if (fail) {
        expect(result).toMatchObject({ error: { message: "UNAUTHENTICATED" } });
        expect(
          (
            await f.pool.query("SELECT id FROM batches WHERE workspace_id=$1", [
              f.workspaceId,
            ])
          ).rows,
        ).toEqual([]);
        expect(await events(f)).toEqual([]);
      } else {
        expect(result).toHaveProperty("value.id");
        await Promise.all([f.service.scanEvents(), f.service.scanEvents()]);
        expect(await notices(f)).toMatchObject([
          { kind: "change-review-request" },
        ]);
        await f.pool.query(
          "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
          [f.workspaceId],
        );
      }
      expect(await f.service.scanEvents()).toBe(0);
      expect(await notices(f)).toEqual([]);
    } finally {
      resume();
      await pending;
    }
  });
for (const scenario of [
  "released",
  "stale",
  "rejected",
  "staged",
  "missing",
  "already-notified",
  "offline",
] as const)
  test(`upgrade repair bounds: ${scenario}, preserving historical subscription cutoff`, async () => {
    const f = await setup();
    await legacyCapture(f);
    const b =
      scenario === "offline"
        ? await f.core.propose(f.editor, [update], ["source-a"])
        : await staged(f);
    if (scenario !== "staged") await release(f, b.id);
    if (scenario === "already-notified") await f.service.scanEvents();
    if (scenario === "stale") {
      await f.pool.query(
        "UPDATE batches SET hash='later-revision' WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      );
      await f.pool.query(
        "DELETE FROM collaboration_events WHERE workspace_id=$1 AND revision='later-revision'",
        [f.workspaceId],
      );
    }
    if (scenario === "rejected")
      await f.pool.query(
        "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      );
    if (scenario === "missing")
      await f.pool.query(
        "DELETE FROM collaboration_events WHERE workspace_id=$1",
        [f.workspaceId],
      );
    await f.pool.query(
      "UPDATE collaboration_events SET created_at='2020-01-01Z',projected_at=now() WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const before = await events(f);
    await currentCapture(f);
    await currentCapture(f);
    const rows = await events(f);
    if (scenario === "released") {
      expect(rows[0].projected_at).toBeNull();
      expect(rows[0].exact_created_at).toBe(before[0].exact_created_at);
    } else expect(rows).toEqual(before);
    // A subscription created after the original event must not become historical.
    expect(await f.service.scanEvents()).toBe(0);
    expect(await notices(f)).toHaveLength(
      scenario === "already-notified" ? 1 : 0,
    );
  });

test("repair recovers an eligible historical subscriber once and preserves existing notification IDs on repeated projection", async () => {
  const f = await setup();
  await f.pool.query(
    "UPDATE collaboration_subscriptions SET created_at='2019-01-01Z' WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await legacyCapture(f);
  const b = await staged(f);
  await release(f, b.id);
  await f.pool.query(
    "UPDATE collaboration_events SET created_at='2020-01-01Z',projected_at=now() WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await currentCapture(f);
  expect((await events(f))[0].projected_at).toBeNull();
  await Promise.all([f.service.scanEvents(), f.service.scanEvents()]);
  const [notice] = await notices(f);
  expect(notice).toMatchObject({ kind: "change-review-request" });
  await f.pool.query(
    "UPDATE collaboration_events SET projected_at=null WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect(await f.service.scanEvents()).toBe(0);
  expect((await notices(f)).map((n) => n.id)).toEqual([notice.id]);
});
for (const revocation of ["source", "reviewer"] as const)
  test(`released review checks current ${revocation} authorization before creating a notification`, async () => {
    const f = await setup();
    const b = await staged(f);
    await release(f, b.id);
    if (revocation === "source")
      await f.pool.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
        [f.workspaceId],
      );
    else
      await f.pool.query(
        "DELETE FROM access_reviewers WHERE workspace_id=$1 AND principal_id='reviewer'",
        [f.workspaceId],
      );
    expect(await f.service.scanEvents()).toBe(0);
    expect(await notices(f)).toEqual([]);
    expect(
      (
        await f.pool.query(
          "SELECT id FROM workflow_notifications WHERE workspace_id=$1 AND kind='change-review-request'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([]);
  });
test("authorization release rollback cannot leak an event from its transaction", async () => {
  const f = await setup();
  const b = await staged(f);
  await expect(
    transaction(f.pool, f.workspaceId, async (db) => {
      await db.query(
        "UPDATE batches SET data=data-'requestAuthorizationPending' WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      );
      throw Error("FINAL_POLICY_REJECTED");
    }),
  ).rejects.toThrow("FINAL_POLICY_REJECTED");
  expect(await events(f)).toEqual([]);
  expect(await f.service.scanEvents()).toBe(0);
  expect(await notices(f)).toEqual([]);
  await release(f, b.id);
  expect(await f.service.scanEvents()).toBe(1);
  expect(await notices(f)).toHaveLength(1);
});
