import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, adoptFixture, page } from "../../test-support";
import { draftOf } from "../../../src/domain/wiki";
import { propose, approve, publish } from "../../publication";
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
});
afterEach(async () => {
  await f?.pool.end();
});
async function policy(mode: string, type = "기술 설계") {
  await f.pool.query(
    "INSERT INTO governance_type_policies VALUES($1,$2,1,ARRAY['environment'],$3,NULL) ON CONFLICT(workspace_id,document_type) DO UPDATE SET mode=excluded.mode,revision=governance_type_policies.revision+1",
    [f.workspaceId, type, mode],
  );
}
test("publication requires actual current workflow properties before approval and publication", async () => {
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  await policy("block");
  await expect(approve(f.pool, f.ctx, b.id, b.hash)).rejects.toThrow(
    "PROPERTY_REQUIRED",
  );
  await f.pool.query(
    "INSERT INTO workflow_document_state(workspace_id,page_id,data) VALUES($1,'topic',$2)",
    [f.workspaceId, { properties: { environment: "Ubuntu" } }],
  );
  await approve(f.pool, f.ctx, b.id, b.hash);
  await f.pool.query(
    "UPDATE workflow_document_state SET data='{}',revision=revision+1 WHERE workspace_id=$1",
    [f.workspaceId],
  );
  await expect(publish(f.pool, f.ctx, b.id, b.hash, "publish")).rejects.toThrow(
    "PROPERTY_REQUIRED",
  );
});
test("warn metadata is returned and policy change invalidates the existing content approval", async () => {
  await policy("warn");
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  expect(b).toMatchObject({
    warnings: [
      { pageId: "topic", key: "environment", code: "PROPERTY_REQUIRED" },
    ],
  });
  await approve(f.pool, f.ctx, b.id, b.hash);
  await policy("warn");
  await expect(publish(f.pool, f.ctx, b.id, b.hash, "publish")).rejects.toThrow(
    "APPROVAL_STALE",
  );
});
test("new pages use the default connected-knowledge type rather than bypassing required metadata", async () => {
  await policy("block", "연결된 지식");
  const d = { ...draftOf(page), id: "new-page", baseVersion: 0 };
  const b = await propose(f.pool, f.editor, [d], ["source-a"]);
  await expect(approve(f.pool, f.ctx, b.id, b.hash)).rejects.toThrow(
    "PROPERTY_REQUIRED",
  );
});
test("warning-only publication returns current warnings without changing the approved hash", async () => {
  await policy("warn");
  const b = await propose(f.pool, f.editor, [draftOf(page)], ["source-a"]);
  expect(await approve(f.pool, f.ctx, b.id, b.hash)).toMatchObject({
    warnings: [{ key: "environment" }],
  });
  expect(
    (
      await f.pool.query(
        "SELECT hash,data FROM batches WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, b.id],
      )
    ).rows[0],
  ).toMatchObject({
    hash: b.hash,
    data: { reviewWarnings: [{ key: "environment" }] },
  });
  const result = await publish(f.pool, f.ctx, b.id, b.hash, "warn-publish");
  expect(result).toMatchObject({
    versions: { topic: 2 },
    warnings: [{ pageId: "topic", key: "environment" }],
  });
});
