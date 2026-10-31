import { test, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture } from "../test-support";
import { authorizeInTransaction } from "../access/index";
import { OperationsService } from "./service";
import { previewErasure, executeErasure } from "./erasure";
import { assertReleasedImportUsable } from "./released-imports";
import { runTestPgTool as run } from "./test-pg-tools";
import {
  captureRecoveryLedger,
  readRecoveryLedger,
  secureRestoredDatabase,
} from "./recovery";
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
const secret = "RELEASED_PRIVATE_IMPORT_BODY_81291",
  sha = createHash("sha256").update(secret).digest("hex");
async function setup(mapped: boolean) {
  const f = await fixture();
  pools.push(f.pool);
  if (
    !(await f.pool.query("SELECT to_regclass('public.imports') AS table"))
      .rows[0].table
  )
    await f.pool.query(
      execFileSync(
        "git",
        ["show", "origin/main:server/migrations/006-imports.sql"],
        { encoding: "utf8" },
      ),
    );
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO imports(workspace_id,id,principal_id,title,selection,parsed,request_key,request_hash) VALUES($1,'released-upload','editor',$2,$3,$4,$5,$6)",
    [
      f.workspaceId,
      secret,
      { project: secret },
      { records: [{ text: secret }] },
      randomUUID(),
      sha,
    ],
  );
  await f.pool.query(
    "INSERT INTO import_files VALUES($1,'released-upload','file1',$2,$3,$4,$3)",
    [f.workspaceId, secret, Buffer.byteLength(secret), sha],
  );
  await f.pool.query(
    "INSERT INTO import_parts VALUES($1,'released-upload','file1',0,$2,$3)",
    [f.workspaceId, sha, Buffer.from(secret)],
  );
  await f.pool.query(
    "INSERT INTO import_runs(workspace_id,id,import_id,principal_id,input_revision,mode,status,stage,session_id,grant_role,grant_expires_at,result,input_envelope,changeset,request_key,request_hash) VALUES($1,'released-run','released-upload','editor',1,'model','running','compiling','old-session','editor',now()+interval '1 hour',$2,$3,$2,$4,$5)",
    [
      f.workspaceId,
      { text: secret },
      { sourceIds: mapped ? ["source-a"] : [], snapshot: secret },
      randomUUID(),
      sha,
    ],
  );
  await f.pool.query(
    "INSERT INTO import_observations(workspace_id,principal_id,source_key,content_hash,import_id,record_id,event) VALUES($1,'editor','original-record',$2,'released-upload','record1','created')",
    [f.workspaceId, sha],
  );
  await f.pool.query(
    "INSERT INTO import_disclosures(workspace_id,run_id,principal_id,reviewer_id,audience,hash,status) VALUES($1,'released-run','editor','reviewer',$2,$3,'approved')",
    [f.workspaceId, JSON.stringify(["editor", "reviewer"]), sha],
  );
  if (mapped)
    await f.pool.query(
      "UPDATE sources SET data=data||$2::jsonb WHERE workspace_id=$1 AND id='source-a'",
      [
        f.workspaceId,
        {
          tool: "web-import",
          importId: "released-upload",
          importRunId: "released-run",
          importOwnerId: "editor",
          content: secret,
        },
      ],
    );
  return {
    ...f,
    owner: { workspaceId: f.workspaceId, principalId: "fixture-owner" },
    ops: new OperationsService(f.pool, authorizeInTransaction),
  };
}
test("released006 raw chunks/parsed/results/disclosures are real source closure; old encrypted snapshot replay cannot regenerate source IDs", async () => {
  const f = await setup(true),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    database = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
  let created = false,
    restored: Pool | undefined;
  try {
    const sourceDb = (await f.pool.query("SELECT current_database() AS name"))
        .rows[0].name,
      dump = run(["pg_dump", "-U", "knowledge", "-d", sourceDb, "-Fc"]);
    const p = await previewErasure(f.ops, f.owner, request);
    expect(p.counts.import_parts).toBe(1);
    expect(p.counts.import_runs).toBe(1);
    await executeErasure(f.ops, f.owner, {
      ...request,
      previewHash: p.previewHash,
      confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
    });
    const row = (
      await f.pool.query(
        "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0];
    expect(row.n).toBe(0);
    await expect(
      assertReleasedImportUsable(f.pool, f.workspaceId, "released-upload"),
    ).rejects.toThrow("LEGAL_ERASURE");
    run(["createdb", "-U", "knowledge", database]);
    created = true;
    run(
      [
        "pg_restore",
        "-U",
        "knowledge",
        "--no-owner",
        "--exit-on-error",
        "-d",
        database,
      ],
      dump,
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    restored = new Pool({ connectionString: url.href });
    const key = "recovery-key".repeat(5),
      signing = "independent-recovery".repeat(4),
      ledger = readRecoveryLedger(
        await captureRecoveryLedger(f.pool, key, signing),
        key,
        signing,
      );
    await secureRestoredDatabase(restored, ledger);
    expect(
      (
        await restored.query(
          "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await restored.query(
          "SELECT parsed,status FROM imports WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0],
    ).toMatchObject({ parsed: null, status: "erased" });
    const state = (
      await restored.query(
        "SELECT status,cancel_requested,session_id,lease_token,grant_expires_at<clock_timestamp() AS expired,result,input_envelope,changeset FROM import_runs WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0];
    expect(state).toMatchObject({
      status: "cancelled",
      cancel_requested: true,
      session_id: null,
      expired: true,
      result: null,
      input_envelope: null,
      changeset: null,
    });
    expect(BigInt(state.lease_token)).toBeGreaterThan(0n);
    await expect(
      assertReleasedImportUsable(restored, f.workspaceId, "released-upload"),
    ).rejects.toThrow("LEGAL_ERASURE");
  } finally {
    await restored?.end();
    if (created) run(["dropdb", "-U", "knowledge", database]);
  }
}, 120000);
test("unmapped released private input stays BLOCKED until a separate explicit Owner workspace preview", async () => {
  const f = await setup(false),
    request = {
      scope: "resource",
      resource: { kind: "source", id: "source-a" },
    },
    p = await previewErasure(f.ops, f.owner, request);
  expect(p.unresolvedUnlineagedRows).toBeGreaterThan(0);
  const partial = await executeErasure(f.ops, f.owner, {
    ...request,
    previewHash: p.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
  expect(partial.status).toBe("blocked");
  expect(
    (
      await f.pool.query(
        "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBeGreaterThan(0);
  const sourceDb = (await f.pool.query("SELECT current_database() AS name"))
      .rows[0].name;
  const dump = run(["pg_dump", "-U", "knowledge", "-d", sourceDb, "-Fc"]);
  const all = await previewErasure(f.ops, f.owner, { scope: "workspace" });
  expect(
    (
      await executeErasure(f.ops, f.owner, {
        scope: "workspace",
        previewHash: all.previewHash,
        confirm: "ERASE_ENTIRE_WORKSPACE",
      })
    ).status,
  ).toBe("completed");
  expect(
    (
      await f.pool.query(
        "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows[0].n,
  ).toBe(0);
  const database = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
  let restored: Pool | undefined,
    created = false;
  try {
    run(["createdb", "-U", "knowledge", database]);
    created = true;
    run(
      [
        "pg_restore",
        "-U",
        "knowledge",
        "--no-owner",
        "--exit-on-error",
        "-d",
        database,
      ],
      dump,
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    restored = new Pool({ connectionString: url.href });
    const key = "workspace-recovery".repeat(4),
      signing = "independent-workspace".repeat(4),
      ledger = readRecoveryLedger(
        await captureRecoveryLedger(f.pool, key, signing),
        key,
        signing,
      );
    await secureRestoredDatabase(restored, ledger);
    expect(
      (
        await restored.query(
          "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      assertReleasedImportUsable(restored, f.workspaceId, "released-upload"),
    ).rejects.toThrow("LEGAL_ERASURE");
  } finally {
    await restored?.end();
    if (created) run(["dropdb", "-U", "knowledge", database]);
  }
}, 120000);
test("ordinary preserved import.remove is replayed for private chunks without blanket erasure of company wiki", async () => {
  const f = await setup(true),
    sourceDb = (await f.pool.query("SELECT current_database() AS n")).rows[0].n;
  const batchId = randomUUID();
  await f.pool.query(
    "INSERT INTO batches(workspace_id,id,data,hash) VALUES($1,$2,$3,$4)",
    [
      f.workspaceId,
      batchId,
      { snapshots: [{ id: "source-a", content: secret }] },
      sha,
    ],
  );
  await f.pool.query(
    "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash) VALUES($1,$2,$3,$4)",
    [f.workspaceId, batchId, "reviewer", sha],
  );
  const wikiBefore = (
      await f.pool.query(
        "SELECT data->>'content' AS content FROM versions WHERE workspace_id=$1 AND page_id='topic'",
        [f.workspaceId],
      )
    ).rows[0].content,
    dump = run(["pg_dump", "-U", "knowledge", "-d", sourceDb, "-Fc"]);
  await f.pool.query(
    "UPDATE sources SET data=jsonb_set(jsonb_set(data,'{content}',to_jsonb('[원본 소유자가 철회한 자료]'::text)),'{importWithdrawn}','true') WHERE workspace_id=$1 AND id='source-a'",
    [f.workspaceId],
  );
  await f.pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a'",
    [f.workspaceId],
  );
  await f.pool.query(
    "DELETE FROM imports WHERE workspace_id=$1 AND id='released-upload'",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO audit(workspace_id,principal_id,operation,resource_id) VALUES($1,'editor','import.remove','released-upload')",
    [f.workspaceId],
  );
  const database = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
  let restored: Pool | undefined,
    created = false;
  try {
    run(["createdb", "-U", "knowledge", database]);
    created = true;
    run(
      [
        "pg_restore",
        "-U",
        "knowledge",
        "--no-owner",
        "--exit-on-error",
        "-d",
        database,
      ],
      dump,
    );
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = "/" + database;
    restored = new Pool({ connectionString: url.href });
    const key = "private-removal-recovery".repeat(3),
      signing = "independent-private-remove".repeat(3);
    await secureRestoredDatabase(
      restored,
      readRecoveryLedger(
        await captureRecoveryLedger(f.pool, key, signing),
        key,
        signing,
      ),
    );
    expect(
      (
        await restored.query(
          "SELECT octet_length(data) AS n FROM import_parts WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      assertReleasedImportUsable(restored, f.workspaceId, "released-upload"),
    ).rejects.toThrow("LEGAL_ERASURE");
    expect(
      (
        await restored.query(
          "SELECT data->>'content' AS content FROM versions WHERE workspace_id=$1 AND page_id='topic'",
          [f.workspaceId],
        )
      ).rows[0].content,
    ).toBe(wikiBefore);
    expect(
      JSON.stringify(
        (
          await restored.query(
            "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
            [f.workspaceId, batchId],
          )
        ).rows,
      ),
    ).not.toContain(secret);
    expect(
      (
        await restored.query(
          "SELECT 1 FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
          [f.workspaceId, batchId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await restored?.end();
    if (created) run(["dropdb", "-U", "knowledge", database]);
  }
}, 120000);
