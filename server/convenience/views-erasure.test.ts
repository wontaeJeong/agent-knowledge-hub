import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import {
  executeErasure,
  previewErasure,
  replayProductErasure,
} from "../operations/erasure";
import { operationsAuthorizer } from "../operations/authorization";
import { OperationsService } from "../operations/service";
import { authorizeInTransaction } from "../access";
import { inventory, unknownPrivateReference } from "../retention/inventory";
import { ContentRetentionService } from "../retention/service";
import { SavedViewService } from "./views";
import { transaction } from "../database";

// Reconstruct a v146 receipt using its original six columns. The exclusive DDL lock
// keeps this short fixture transaction isolated from concurrent test workspaces.
async function restoreLegacyReceipt(
  pool: Pool,
  workspaceId: string,
  mutationId: string,
) {
  await transaction(pool, workspaceId, async (db) => {
    await db.query(
      "ALTER TABLE personal_saved_view_mutations DROP CONSTRAINT personal_saved_view_audit_required",
    );
    await db.query(
      `WITH previous AS (
      DELETE FROM personal_saved_view_mutations WHERE workspace_id=$1 AND mutation_id=$2 RETURNING *
    ) INSERT INTO personal_saved_view_mutations(workspace_id,owner_id,mutation_id,payload_hash,view_id,revision)
      SELECT workspace_id,owner_id,mutation_id,payload_hash,view_id,revision FROM previous`,
      [workspaceId, mutationId],
    );
    await db.query(
      await readFile(
        new URL(
          "../migrations/148-private-view-audit-writes.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
}

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
      ops = new OperationsService(
        f.pool,
        operationsAuthorizer(authorizeInTransaction, {
          adminAuditMetadataExport: true,
        }),
      );
    const draft = {
      name: "synthetic-sensitive-name",
      filters: { query: "synthetic-sensitive-query" },
      sort: "recent",
      expectedRevision: 0,
      mutationId: randomUUID(),
    };
    const retention = new ContentRetentionService(
      f.pool,
      authorizeInTransaction,
    );
    await f.pool.query(
      "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','private-fixture-draft',1,'{}')",
      [f.workspaceId],
    );
    await expect(ops.auditRows(f.reader)).rejects.toThrow("FORBIDDEN");
    const auditBefore = await ops.auditRows(owner);
    const baseline = await previewErasure(ops, owner, { scope: "workspace" });
    const targeted = {
      scope: "resource",
      resource: { kind: "source" as const, id: "source-a" },
    };
    const beforeResource = await previewErasure(ops, owner, targeted);
    const first = await views.save(f.reader, draft);
    await restoreLegacyReceipt(f.pool, f.workspaceId, draft.mutationId);
    expect(await views.save(f.reader, draft)).toEqual(first);
    for (let count = 1; count <= 2; count++) {
      if (count === 2)
        await views.save(f.reader, { ...draft, mutationId: randomUUID() });
      const retained = await retention.previewRetention(owner);
      expect(JSON.stringify(retained)).not.toContain("personal_saved_view");
      expect(JSON.stringify(retained)).not.toContain(first.id);
      expect(
        retained.records.find((r) => r.id === "private-fixture-draft")?.reasons,
      ).toContain("RETAINED_REFERENCE");
      expect(await ops.auditRows(owner)).toEqual(auditBefore);
      for (const [query, prior] of [
        [{ scope: "workspace" }, baseline],
        [targeted, beforeResource],
      ] as const) {
        const current = await previewErasure(ops, owner, query);
        const { previewHash: currentHash, ...disclosed } = current;
        const { previewHash: priorHash, ...priorDisclosed } = prior;
        expect(disclosed).toEqual(priorDisclosed);
        expect(JSON.stringify(disclosed)).not.toContain(first.id);
        expect(currentHash).not.toBe(priorHash);
      }
    }
    const rows = await transaction(f.pool, f.workspaceId, (db) =>
      inventory(db, f.workspaceId),
    );
    const priv = rows.find((row) => row.table === "personal_saved_views")!;
    expect(unknownPrivateReference(priv)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("synthetic-sensitive");
    const resource = { kind: "source" as const, id: "source-a" };
    const partial = await previewErasure(ops, owner, targeted);
    expect(partial.unresolvedUnlineagedRows).toBe(
      beforeResource.unresolvedUnlineagedRows,
    );
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
    expect(await views.save(f.reader, draft)).toEqual(first);
    const legacy = () =>
      f.pool.query(
        "SELECT operation,applied_at FROM personal_saved_view_mutations WHERE workspace_id=$1 AND mutation_id=$2",
        [f.workspaceId, draft.mutationId],
      );
    expect((await legacy()).rows).toEqual([
      { operation: null, applied_at: null },
    ]);
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
    await views.remove(f.reader, first.id, {
      expectedRevision: 1,
      mutationId: randomUUID(),
    });
    expect((await legacy()).rows).toEqual([
      { operation: null, applied_at: null },
    ]);
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
    const restored = await views.save(a.reader, data);
    await restoreLegacyReceipt(a.pool, a.workspaceId, data.mutationId);
    expect(await views.save(a.reader, data)).toEqual(restored);
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

test("resource approval expires on another person's first definition and on removal leaving only receipts", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await f.pool.query(
      "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
      [f.workspaceId],
    );
    const owner = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
    const ops = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: true,
      }),
    );
    const views = new SavedViewService(f.pool);
    const targeted = {
      scope: "resource",
      resource: { kind: "source" as const, id: "source-a" },
    };
    const draft = {
      name: "another person's view",
      filters: { query: "synthetic private terms" },
      sort: "recent",
      expectedRevision: 0,
    };
    const beforeCreation = await previewErasure(ops, owner, targeted);
    const obsolete = await views.save(f.reader, {
      ...draft,
      mutationId: randomUUID(),
    });
    const execute = (hash: string) =>
      executeErasure(ops, owner, {
        ...targeted,
        previewHash: hash,
        confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
      });
    await expect(execute(beforeCreation.previewHash)).rejects.toThrow(
      "ERASURE_PREVIEW_STALE",
    );
    const beforeDelete = await previewErasure(ops, owner, targeted);
    await views.remove(f.reader, obsolete.id, {
      expectedRevision: 1,
      mutationId: randomUUID(),
    });
    await expect(execute(beforeDelete.previewHash)).rejects.toThrow(
      "ERASURE_PREVIEW_STALE",
    );

    const afterRemoval = await previewErasure(ops, owner, targeted);
    const { previewHash: oldHash, ...oldPublic } = beforeCreation;
    const { previewHash: newHash, ...newPublic } = afterRemoval;
    expect(oldPublic).toEqual(newPublic);
    expect(oldHash).not.toBe(newHash);
    await expect(execute(oldHash)).rejects.toThrow("ERASURE_PREVIEW_STALE");
    expect(
      (
        await f.pool.query(
          "SELECT data->>'content' AS content FROM sources WHERE workspace_id=$1 AND id='source-a'",
          [f.workspaceId],
        )
      ).rows[0].content,
    ).toContain("재시도");
    await views.save(f.reader, { ...draft, mutationId: randomUUID() });
    const fresh = await previewErasure(ops, owner, targeted);
    expect(await execute(fresh.previewHash)).toMatchObject({
      status: "blocked",
      errorCode: "UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW",
    });
  } finally {
    await f.pool.end();
  }
});
