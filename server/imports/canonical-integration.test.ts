import { afterAll, test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture, adoptFixture } from "../test-support";
import { RuntimeService } from "../runtime/knowledge";
import { ImportService } from "./service";
import { hash } from "./parser";
const pools: Awaited<ReturnType<typeof fixture>>[] = [];
afterAll(async () => {
  await Promise.all(pools.map((f) => f.pool.end()));
});
async function setup() {
  const f = await fixture();
  pools.push(f);
  await adoptFixture(f.pool, f.workspaceId);
  return {
    ...f,
    imports: new ImportService(f.pool, new RuntimeService(f.pool)),
  };
}
const input = () => ({
  title: "private upload",
  files: [
    {
      id: "file",
      name: "chat.txt",
      size: 4,
      sha256: hash(Buffer.from("test")),
    },
  ],
});
test("canonical team Owner is not classified as a personal namespace owner", async () => {
  const f = await setup();
  const config = await f.imports.config({
    workspaceId: f.workspaceId,
    principalId: "fixture-owner",
  });
  expect(config.personal).toBe(false);
});
test("canonical Read cannot create/upload input; own creator read remains distinct from Write", async () => {
  const f = await setup();
  await expect(
    f.imports.create(f.reader, input(), randomUUID()),
  ).rejects.toThrow();
  const created = await f.imports.create(f.editor, input(), randomUUID());
  await f.pool.query(
    "UPDATE access_grants SET role='read' WHERE workspace_id=$1 AND principal_id='editor'",
    [f.workspaceId],
  );
  expect((await f.imports.view(f.editor, created.id)).id).toBe(created.id);
  await expect(
    f.imports.uploadPart(f.editor, created.id, "file", 0, {
      data: Buffer.from("test").toString("base64"),
      sha256: hash(Buffer.from("test")),
    }),
  ).rejects.toThrow();
});
test("erased original cannot finalize/select/resume/requeue and does not consume count/byte quota", async () => {
  const f = await setup(),
    created = await f.imports.create(f.editor, input(), randomUUID());
  await f.pool.query(
    "UPDATE imports SET status='erased',parsed=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, created.id],
  );
  await expect(
    f.imports.finalize(f.editor, created.id, randomUUID()),
  ).rejects.toThrow("LEGAL_ERASURE");
  await expect(f.imports.view(f.editor, created.id)).rejects.toThrow(
    "LEGAL_ERASURE",
  );
  for (let i = 0; i < 100; i++)
    await f.pool.query(
      "INSERT INTO imports(workspace_id,id,principal_id,title,status,selection,request_key,request_hash) VALUES($1,$2,'editor','retired','erased','{}',$2,$2)",
      [f.workspaceId, randomUUID()],
    );
  expect(
    (await f.imports.create(f.editor, input(), randomUUID())).id,
  ).toBeTruthy();
});
test("ordinary remove revokes grants/raw input and redacts approved source snapshots without purging unrelated wiki", async () => {
  const f = await setup(),
    created = await f.imports.create(f.editor, input(), randomUUID()),
    batchId = randomUUID(),
    secret = "PRIVATE_REMOVE_SNAPSHOT";
  await f.pool.query(
    "UPDATE sources SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='source-a'",
    [
      f.workspaceId,
      { importId: created.id, importOwnerId: "editor", content: secret },
    ],
  );
  await f.pool.query(
    "INSERT INTO batches(workspace_id,id,data,hash) VALUES($1,$2,$3,$4)",
    [
      f.workspaceId,
      batchId,
      { snapshots: [{ id: "source-a", content: secret }] },
      "a".repeat(64),
    ],
  );
  await f.pool.query(
    "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash) VALUES($1,$2,$3,$4)",
    [f.workspaceId, batchId, "reviewer", "a".repeat(64)],
  );
  const before = (
    await f.pool.query(
      "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic'",
      [f.workspaceId],
    )
  ).rows;
  await f.imports.remove(f.editor, created.id);
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
        [f.workspaceId, batchId],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
          [f.workspaceId, batchId],
        )
      ).rows,
    ),
  ).not.toContain(secret);
  expect(
    (
      await f.pool.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual(before);
});
