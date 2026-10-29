import { afterEach, beforeEach, expect, test } from "vitest";
import { fixture, source } from "./test-support";
import { KnowledgeService } from "./service";
import { usageSummary } from "./usage";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f?.pool.end();
});

test("records reads, writes and failures without source contents and distinguishes actual publications", async () => {
  const s = new KnowledgeService(f.pool);
  await s.readPage(f.reader, "topic");
  await expect(s.readPage(f.reader, "missing")).rejects.toThrow("NOT_FOUND");
  await s.registerSource(f.editor, { ...source, id: "new" }, [
    "editor",
    "reviewer",
  ]);
  const summary = await usageSummary(f.pool, f.ctx, 7);
  expect(summary).toMatchObject({
    scope: "workspace",
    total: 3,
    succeeded: 2,
    failed: 1,
    activeUsers: 2,
    publications: 0,
    timezone: "UTC",
    model: { inputTokens: null, outputTokens: null, cost: null },
  });
  expect(summary.daily).toHaveLength(7);
  expect(summary.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: "page.read", total: 2, failed: 1 }),
      expect.objectContaining({
        operation: "source.register",
        total: 1,
        failed: 0,
      }),
    ]),
  );
  const events = await f.pool.query(
    "SELECT * FROM usage_events WHERE workspace_id=$1",
    [f.workspaceId],
  );
  expect(events.rowCount).toBe(3);
  expect(JSON.stringify(events.rows)).not.toContain(source.content);
  expect(events.rows.every((r) => r.duration_ms >= 0)).toBe(true);
});

test("members only see their own use and unauthorized identities receive no metrics", async () => {
  const s = new KnowledgeService(f.pool);
  await s.readPage(f.reader, "topic");
  await s.readPage(f.editor, "topic");
  expect(await usageSummary(f.pool, f.reader, 7)).toMatchObject({
    scope: "self",
    total: 1,
    activeUsers: 1,
  });
  await expect(
    usageSummary(f.pool, { ...f.ctx, principalId: "outsider" }, 7),
  ).rejects.toThrow("NOT_FOUND");
  await expect(usageSummary(f.pool, f.ctx, 36500)).rejects.toThrow(
    "VALIDATION_FAILED",
  );
});

test("empty periods contain zero measured requests, not invented model costs", async () => {
  expect(await usageSummary(f.pool, f.ctx, 30)).toMatchObject({
    total: 0,
    failed: 0,
    activeUsers: 0,
    model: { cost: null },
  });
  expect((await usageSummary(f.pool, f.ctx, 30)).daily).toHaveLength(30);
});

test("usage persistence failure rolls back successful business changes rather than reporting a false success", async () => {
  await f.pool.query(
    "ALTER TABLE usage_events ADD CONSTRAINT reject_test_usage CHECK (operation <> 'source.register') NOT VALID",
  );
  try {
    await expect(
      new KnowledgeService(f.pool).registerSource(
        f.editor,
        { ...source, id: "no-metrics" },
        ["editor"],
      ),
    ).rejects.toThrow();
    expect(
      (
        await f.pool.query(
          "SELECT * FROM sources WHERE workspace_id=$1 AND id='no-metrics'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.pool.query(
      "ALTER TABLE usage_events DROP CONSTRAINT reject_test_usage",
    );
  }
});
