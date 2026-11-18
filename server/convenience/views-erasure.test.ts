import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import {
  executeErasure,
  previewErasure,
  replayProductErasure,
} from "../operations/erasure";
import { OperationsService } from "../operations/service";
import { authorizeInTransaction } from "../access";
import { inventory, unknownPrivateReference } from "../retention/inventory";
import { SavedViewService } from "./views";
import { transaction } from "../database";

test("private definitions participate in held, resource, workspace and recovery erasure without exporting text", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await f.pool.query(
      "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
    const owner = { workspaceId: f.workspaceId, principalId: "fixture-owner" },
      views = new SavedViewService(f.pool),
      ops = new OperationsService(f.pool, authorizeInTransaction);
    const draft = {
      name: "synthetic-sensitive-name",
      filters: { query: "synthetic-sensitive-query" },
      sort: "recent",
      expectedRevision: 0,
      mutationId: randomUUID(),
    };
    const first = await views.save(f.reader, draft);
    const rows = await transaction(f.pool, f.workspaceId, (db) =>
      inventory(db, f.workspaceId),
    );
    const priv = rows.find((row) => row.table === "personal_saved_views")!;
    expect(unknownPrivateReference(priv)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("synthetic-sensitive");
    const resource = { kind: "source" as const, id: "source-a" };
    const targeted = { scope: "resource", resource };
    const partial = await previewErasure(ops, owner, targeted);
    expect(partial.unresolvedUnlineagedRows).toBeGreaterThan(0);
    expect(JSON.stringify(partial)).not.toContain("synthetic-sensitive");
    const result = await executeErasure(ops, owner, {
      ...targeted,
      previewHash: partial.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    });
    expect(result).toMatchObject({
      status: "blocked",
      errorCode: "UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW",
    });
    expect(await views.read(f.reader, first.id)).toMatchObject({
      name: draft.name,
    });
    await expect(
      transaction(f.pool, f.workspaceId, (db) =>
        replayProductErasure(db, f.workspaceId, [resource], false),
      ),
    ).rejects.toThrow("RECOVERY_ERASURE_INCOMPLETE");
    const full = { scope: "workspace" };
    await f.pool.query(
      "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','workspace',$1,'fixture-owner')",
      [f.workspaceId],
    );
    const held = await previewErasure(ops, owner, full);
    await expect(
      executeErasure(ops, owner, {
        ...full,
        previewHash: held.previewHash,
        confirm: "ERASE_ENTIRE_WORKSPACE",
      }),
    ).rejects.toThrow("LEGAL_HOLD");
    await expect(
      views.remove(f.reader, first.id, {
        expectedRevision: 1,
        mutationId: randomUUID(),
      }),
    ).rejects.toThrow("LEGAL_HOLD");
    await f.pool.query(
      "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
      [f.workspaceId],
    );
    const whole = await previewErasure(ops, owner, full);
    await executeErasure(ops, owner, {
      ...full,
      previewHash: whole.previewHash,
      confirm: "ERASE_ENTIRE_WORKSPACE",
    });
    for (const table of [
      "personal_saved_views",
      "personal_saved_view_mutations",
    ])
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM " + table + " WHERE workspace_id=$1",
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    await expect(
      views.save(f.reader, { ...draft, mutationId: randomUUID() }),
    ).rejects.toThrow();
  } finally {
    await f.pool.end();
  }
});

test("approved full-workspace recovery erases only the restored space's private definitions and receipts", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await adoptFixture(a.pool, a.workspaceId);
    await adoptFixture(b.pool, b.workspaceId);
    const views = new SavedViewService(a.pool);
    const data = {
      name: "복원 확인",
      filters: { query: "private restore fixture" },
      sort: "recent",
      expectedRevision: 0,
      mutationId: randomUUID(),
    };
    await views.save(a.reader, data);
    const unaffected = await views.save(b.reader, data);
    await transaction(a.pool, a.workspaceId, (db) =>
      replayProductErasure(db, a.workspaceId, [], true),
    );
    for (const table of [
      "personal_saved_views",
      "personal_saved_view_mutations",
    ]) {
      expect(
        (
          await a.pool.query(
            "SELECT 1 FROM " + table + " WHERE workspace_id=$1",
            [a.workspaceId],
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(await views.read(b.reader, unaffected.id)).toMatchObject({
      name: data.name,
    });
  } finally {
    await Promise.all([a.pool.end(), b.pool.end()]);
  }
});
