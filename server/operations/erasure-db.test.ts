import { test, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure } from "./erasure";
import { operationsAuthorizer } from "./authorization";
const pools: Pool[] = [];
test("administrative audit metadata export is explicit opt-in, never reader escalation or raw-source export fallback", async () => {
  const f = await setup();
  const enabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: true,
      }),
    ),
    disabled = new OperationsService(
      f.pool,
      operationsAuthorizer(authorizeInTransaction, {
        adminAuditMetadataExport: false,
      }),
    );
  await expect(disabled.auditRows(f.ctx)).rejects.toThrow(
    "ADMIN_AUDIT_EXPORT_POLICY_DISABLED",
  );
  await expect(enabled.auditRows(f.reader)).rejects.toThrow("FORBIDDEN");
  expect((await enabled.auditRows(f.ctx)).length).toBeGreaterThan(0);
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  return {
    ...f,
    ctx: { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    s: new OperationsService(f.pool, authorizeInTransaction),
  };
}
test("actual append-only refinement/draft/answer copies are erased by approved transitive lineage, roots/receipts persist", async () => {
  const f = await setup(),
    secret = "LEGAL_SECRET_72819";
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1",
    [f.workspaceId, secret],
  );
  await f.pool.query(
    "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,'editor','derived-draft',1,$2)",
    [f.workspaceId, { pageId: "topic", content: secret }],
  );
  await f.pool.query(
    "INSERT INTO refinement_claims(workspace_id,id,data) VALUES($1,'derived-claim',$2)",
    [
      f.workspaceId,
      { id: "derived-claim", sourceIds: ["source-a"], claim: secret },
    ],
  );
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  const request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    preview = await previewErasure(f.s, f.ctx, request);
  expect(preview.counts.refinement_claims).toBe(1);
  expect(preview.counts.workflow_drafts).toBe(1);
  await expect(
    executeErasure(f.s, f.editor, {
      ...request,
      previewHash: preview.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow();
  const result = await executeErasure(f.s, f.ctx, {
    ...request,
    previewHash: preview.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(["completed", "blocked"]).toContain(result.status);
  expect(result.allCopiesErased).toBe(false);
  for (const table of [
    "sources",
    "versions",
    "workflow_drafts",
    "refinement_claims",
  ])
    expect(
      JSON.stringify(
        (
          await f.pool.query(
            `SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=$1`,
            [f.workspaceId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
  await expect(
    f.pool.query(
      "UPDATE refinement_claims SET data='{}' WHERE workspace_id=$1",
      [f.workspaceId],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        "SELECT status,counts FROM operations_erasure_receipts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  expect(
    (
      await f.pool.query(
        "SELECT count(*) FROM operations_audit_chain WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].count,
  ).not.toBe("0");
});
test("legal hold and stale preview block writes; separate explicit workspace Owner preview required", async () => {
  const f = await setup(),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    };
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','page','topic','fixture-owner')",
    [f.workspaceId],
  );
  const held = await previewErasure(f.s, f.ctx, request);
  expect(held.legalHold).toBe(true);
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: held.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("LEGAL_HOLD");
  await f.pool.query(
    "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1",
    [f.workspaceId],
  );
  const p = await previewErasure(f.s, f.ctx, request);
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(data,'{content}','\"changed\"') WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(
    executeErasure(f.s, f.ctx, {
      ...request,
      previewHash: p.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_PREVIEW_STALE");
  const all = await previewErasure(f.s, f.ctx, { scope: "workspace" });
  await expect(
    executeErasure(f.s, f.ctx, {
      scope: "workspace",
      previewHash: all.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    }),
  ).rejects.toThrow("ERASURE_CONFIRMATION_REQUIRED");
  expect(
    (
      await executeErasure(f.s, f.ctx, {
        scope: "workspace",
        previewHash: all.previewHash,
        confirm: "ERASE_ENTIRE_WORKSPACE",
      })
    ).status,
  ).toBe("completed");
});
