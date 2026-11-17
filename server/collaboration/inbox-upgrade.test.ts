import { test, expect } from "vitest";
import { fixture } from "../test-support";
import { migrate, assertSchemaCurrent } from "../database";
/** test-server gives this file its own disposable DB; reconstruct only the
 * pre140 additive schema, preserving all released migrations and product rows. */
test("legacy inbox backfills in bounded batches and survives migration restart without renumbering", async () => {
  const f = await fixture();
  try {
    await f.pool
      .query(`DROP TRIGGER workflow_inbox_assign ON workflow_notifications;DROP FUNCTION collaboration_inbox_assign();DROP FUNCTION collaboration_capture_outcome() CASCADE;DROP TABLE collaboration_inbox_state;DROP TABLE collaboration_inbox_mutations;
   ALTER TABLE workflow_notifications DROP COLUMN sequence,DROP COLUMN revision,DROP COLUMN state_revision,DROP COLUMN archived_at,DROP COLUMN event_key,DROP COLUMN target_kind,DROP COLUMN target_id;
   ALTER TABLE collaboration_events DROP CONSTRAINT collaboration_events_kind_check;
   ALTER TABLE collaboration_events ADD CONSTRAINT collaboration_events_kind_check CHECK(kind IN ('publication','change-review-request','expiry','job-failure'));
   DELETE FROM schema_migrations WHERE version=140;`);
    await f.pool.query(
      "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data,read_at) SELECT $1,'legacy-'||n,'reader','topic',1,'publication','{}',CASE WHEN n=1 THEN now() END FROM generate_series(1,601)n",
      [f.workspaceId],
    );
    await expect(assertSchemaCurrent(f.pool)).rejects.toThrow(
      "SCHEMA_NOT_CURRENT",
    );
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    const read = () =>
      f.pool.query(
        "SELECT id,event_key,sequence,revision,read_at,target_kind,target_id FROM workflow_notifications WHERE workspace_id=$1 ORDER BY sequence",
        [f.workspaceId],
      );
    const first = (await read()).rows;
    expect(first).toHaveLength(601);
    expect(
      first.every(
        (r) =>
          r.event_key === r.id &&
          r.target_kind === "document" &&
          r.target_id === "topic",
      ),
    ).toBe(true);
    expect(first.map((r) => Number(r.sequence))).toEqual(
      Array.from({ length: 601 }, (_, n) => n + 1),
    );
    expect(first.find((r) => r.id === "legacy-1")?.read_at).toBeTruthy();
    await migrate(f.pool);
    await assertSchemaCurrent(f.pool);
    expect((await read()).rows).toEqual(first);
  } finally {
    await f.pool.end();
  }
});
