import { test, expect, afterAll } from "vitest";
import { mkdtemp, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture, adoptFixture, source } from "../test-support";
import { authorizeInTransaction } from "../access";
import { FileBlobStore } from "../storage/content";
import { StorageService } from "../storage/service";
import { OperationsService } from "./service";
import { PhysicalDeletionStore } from "./filesystem";
import { previewErasure, executeErasure } from "./erasure";
import { backupReferenceRows } from "../../scripts/k8s/operations-storage-graph.mjs";
const pools: Pool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
async function setup() {
  const bytes = Buffer.from(`legally scoped content ${randomUUID()}`),
    sha = createHash("sha256").update(bytes).digest("hex");
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const root =
      process.env.OPERATIONS_TEST_BLOB_ROOT ??
      (await mkdtemp(join(await realpath(tmpdir()), "akh-graph-"))),
    ctx = { workspaceId: f.workspaceId, principalId: "fixture-owner" };
  await f.pool.query(
    "INSERT INTO resources VALUES($1,'source','independent')",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
    [
      f.workspaceId,
      "independent",
      { ...source, id: "independent", content: "unrelated independent source" },
    ],
  );
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const files = new FileBlobStore(root),
    storage = new StorageService(f.pool, files, authorizeInTransaction),
    ops = new OperationsService(f.pool, authorizeInTransaction, {
      physicalDeletionGateConfirmed: true,
    });
  const blob = await storage.upload(
    ctx,
    {
      parent: { kind: "source", id: "source-a" },
      mime: "text/plain",
      filename: "secret.txt",
    },
    (async function* () {
      yield bytes;
    })(),
  );
  return {
    bytes,
    sha,
    ...f,
    ctx,
    root,
    files,
    storage,
    ops,
    blob,
    purge: new PhysicalDeletionStore(root),
  };
}
async function erase(f: Awaited<ReturnType<typeof setup>>, id: string) {
  const request = { scope: "resource", resource: { kind: "source", id } },
    p = await previewErasure(f.ops, f.ctx, request);
  return executeErasure(f.ops, f.ctx, {
    ...request,
    previewHash: p.previewHash,
    confirm: "ERASE_PREVIEWED_RESOURCE_LINEAGE",
  });
}
test("private staged import absent from storage_blobs is backed up and prevents unrelated-parent purge; archive erasure explicitly releases it", async () => {
  const f = await setup(),
    { bytes, sha } = f,
    archive = randomUUID();
  await f.pool.query(
    "INSERT INTO storage_imports(workspace_id,id,principal_id,digest,manifest) VALUES($1,$2,$3,$4,$5)",
    [
      f.workspaceId,
      archive,
      "fixture-owner",
      randomUUID(),
      {
        type: "import-proposal",
        boundResources: [{ kind: "source", id: "independent" }],
        manifest: {
          sources: [
            { id: "independent", data: { content: "private import copy" } },
          ],
          pages: [],
          blobs: [
            { id: "staged", sha256: sha, base64: bytes.toString("base64") },
          ],
        },
        stagedBlobs: [{ id: "staged", sha256: sha, size: bytes.length }],
      },
    ],
  );
  expect((await erase(f, "source-a")).status).toBe("blocked");
  expect(
    await f.ops.purgeApprovedBlobs(f.ctx, (h) => f.purge.remove(h)),
  ).toMatchObject({ removed: 0 });
  expect(await readFile(join(f.root, sha))).toEqual(bytes);
  const db = await f.pool.connect();
  try {
    expect(await backupReferenceRows(db)).toContainEqual({
      sha256: sha,
      size: bytes.length,
    });
  } finally {
    db.release();
  }
  await erase(f, "independent");
  expect(
    JSON.stringify(
      (
        await f.pool.query(
          "SELECT manifest FROM storage_imports WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rows,
    ),
  ).not.toContain(bytes.toString("base64"));
  expect(
    await f.ops.purgeApprovedBlobs(f.ctx, (h) => f.purge.remove(h)),
  ).toMatchObject({ removed: 1 });
  await expect(readFile(join(f.root, sha))).rejects.toThrow();
});
test("old immutable slot version and mapped import effect retain shared bytes even when head has changed", async () => {
  const f = await setup(),
    { bytes, sha } = f,
    newBytes = Buffer.from("new head"),
    saved = await f.files.put(
      (async function* () {
        yield newBytes;
      })(),
    );
  await f.pool.query(
    "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'head','source','independent',$2,$3,'text/plain','head.txt','clean','fixture-owner')",
    [f.workspaceId, saved.sha256, saved.size],
  );
  await f.pool.query(
    "UPDATE storage_attachment_slots SET parent_id='independent',head_id='head',revision=2 WHERE workspace_id=$1 AND id=$2",
    [f.workspaceId, f.blob.slotId],
  );
  await f.pool.query(
    "INSERT INTO storage_attachment_versions VALUES($1,$2,2,'head')",
    [f.workspaceId, f.blob.slotId],
  );
  await erase(f, "source-a");
  expect(
    await f.ops.purgeApprovedBlobs(f.ctx, (h) => f.purge.remove(h)),
  ).toMatchObject({ removed: 0 });
  expect(await readFile(join(f.root, sha))).toEqual(bytes);
});
test("actual StorageService CAS upload and metadata transaction cannot race exclusive physical unlink", async () => {
  const f = await setup();
  const { bytes, sha } = f;
  const pending = await erase(f, "source-a");
  expect(pending).toMatchObject({
    status: "blocked",
    errorCode: "PHYSICAL_BLOB_PURGE_REQUIRED",
  });
  let entered!: () => void, release!: () => void;
  const deleting = new Promise<void>((r) => (entered = r)),
    continueDelete = new Promise<void>((r) => (release = r));
  const purge = f.ops.purgeApprovedBlobs(f.ctx, async (h) => {
    entered();
    await continueDelete;
    await f.purge.remove(h);
  });
  await deleting;
  let finished = false;
  const upload = f.storage
    .upload(
      f.ctx,
      {
        parent: { kind: "source", id: "independent" },
        mime: "text/plain",
        filename: "new.txt",
      },
      (async function* () {
        yield bytes;
      })(),
    )
    .then((r) => {
      finished = true;
      return r;
    });
  await new Promise((r) => setTimeout(r, 20));
  expect(finished).toBe(false);
  release();
  const purged = await purge;
  expect(purged.removed).toBe(1);
  expect(purged.finalized.length).toBe(1);
  const result = await upload;
  expect(result.sha256).toBe(sha);
  expect(await f.files.get(sha)).toEqual(bytes);
});
test("private import blobMap and slotMap references survive unrelated root tombstones without a storage_blobs parent grant", async () => {
  const f = await setup(),
    archive = randomUUID(),
    batch = randomUUID();
  await f.pool.query(
    "INSERT INTO storage_imports(workspace_id,id,principal_id,digest,manifest) VALUES($1,$2,$3,$4,$5)",
    [
      f.workspaceId,
      archive,
      "fixture-owner",
      randomUUID(),
      {
        type: "import-proposal",
        boundResources: [{ kind: "source", id: "independent" }],
        manifest: { sources: [{ id: "independent" }], pages: [], blobs: [] },
        stagedBlobs: [],
      },
    ],
  );
  await f.pool.query(
    "INSERT INTO batches(workspace_id,id,data,hash) VALUES($1,$2,$3,$4)",
    [f.workspaceId, batch, {}, "a".repeat(64)],
  );
  await f.pool.query(
    "INSERT INTO storage_import_effects(workspace_id,import_id,principal_id,request_hash,batch_id,batch_hash,result) VALUES($1,$2,$3,$4,$5,$4,$6)",
    [
      f.workspaceId,
      archive,
      "fixture-owner",
      "b".repeat(64),
      batch,
      {
        blobMap: { original: f.blob.id },
        slotMap: { original: f.blob.slotId },
      },
    ],
  );
  await erase(f, "source-a");
  expect(
    await f.ops.purgeApprovedBlobs(f.ctx, (h) => f.purge.remove(h)),
  ).toMatchObject({ removed: 0 });
  expect(await f.files.get(f.sha)).toEqual(f.bytes);
});
