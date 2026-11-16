import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { AccessService, authorizeInTransaction } from "../access/index";
import { ContentRetentionService } from "./service";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsService } from "../operations/service";
import { createHash } from "node:crypto";
import { replayRetentionTombstones } from "./drafts";
let f: Awaited<ReturnType<typeof fixture>>, service: ContentRetentionService;
const actor = () => ({
  workspaceId: f.workspaceId,
  principalId: "fixture-owner",
});
const reviewer = () => ({ ...f.ctx });
beforeEach(async () => {
  f = await fixture();
  await adoptFixture(f.pool, f.workspaceId);
  await f.pool.query(
    "INSERT INTO memberships VALUES($1,'fixture-owner','editor') ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  const access = new AccessService(f.pool),
    state = await access.effective(actor());
  await access.setGrant(actor(), {
    principalId: "reviewer",
    role: "admin",
    expectedVersion: state.space.policyVersion,
  });
  await f.pool.query(
    "INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",
    [f.workspaceId],
  );
  service = new ContentRetentionService(f.pool, authorizeInTransaction);
});
afterEach(async () => {
  await f?.pool.end();
});
const blobHash = (s: string) =>
  createHash("sha256")
    .update(f.workspaceId + s)
    .digest("hex");
async function attachment() {
  for (const [id, hash] of [
    ["old-file", "a"],
    ["head-file", "b"],
  ])
    await f.pool.query(
      "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'page','topic',$3,5,'text/plain','PRIVATE_FILENAME','clean','editor')",
      [f.workspaceId, id, blobHash(hash)],
    );
  await f.pool.query(
    "INSERT INTO storage_attachment_slots VALUES($1,'file-slot','page','topic','head-file',2,false)",
    [f.workspaceId],
  );
  await f.pool.query(
    "INSERT INTO storage_attachment_versions VALUES($1,'file-slot',1,'old-file'),($1,'file-slot',2,'head-file')",
    [f.workspaceId],
  );
  return {
    kind: "attachment-version" as const,
    slotId: "file-slot",
    revision: 1,
  };
}
async function plan(selection: unknown[]) {
  const preview = await service.previewPruning(actor(), { selection });
  expect(preview.records.every((r) => r.eligible)).toBe(true);
  const p = await service.planPruning(actor(), {
    selection,
    previewHash: preview.hash,
    policyRevision: preview.policyRevision,
  });
  await service.reviewPruning(reviewer(), {
    planId: p.id,
    previewHash: preview.hash,
    decision: "approve",
  });
  return p;
}
test("exact attachment retirement needs independent approval, preserves head and fences old blob/version resurrection", async () => {
  const selected = await attachment(),
    preview = await service.previewPruning(actor(), { selection: [selected] });
  expect(JSON.stringify(preview)).not.toContain("PRIVATE_FILENAME");
  const p = await service.planPruning(actor(), {
    selection: [selected],
    previewHash: preview.hash,
    policyRevision: 0,
  });
  await expect(
    service.executePruning(actor(), {
      planId: p.id,
      previewHash: preview.hash,
    }),
  ).rejects.toThrow("RETENTION_REVIEW_REQUIRED");
  await expect(
    service.reviewPruning(actor(), {
      planId: p.id,
      previewHash: preview.hash,
      decision: "approve",
    }),
  ).rejects.toThrow("INDEPENDENT_REVIEW_REQUIRED");
  await service.reviewPruning(reviewer(), {
    planId: p.id,
    previewHash: preview.hash,
    decision: "approve",
  });
  const receipt = await service.executePruning(actor(), {
    planId: p.id,
    previewHash: preview.hash,
  });
  expect(receipt).toMatchObject({
    status: "blocked",
    deleted: 1,
    physicalPurgePending: 1,
    allCopiesErased: false,
  });
  expect(
    (
      await f.pool.query(
        "SELECT blob_id FROM storage_attachment_versions WHERE workspace_id=$1 AND slot_id='file-slot'",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([{ blob_id: "head-file" }]);
  expect(
    (
      await f.pool.query(
        "SELECT head_id,revision FROM storage_attachment_slots WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([{ head_id: "head-file", revision: 2 }]);
  expect(
    await service.executePruning(actor(), {
      planId: p.id,
      previewHash: preview.hash,
    }),
  ).toEqual(receipt);
  await expect(
    f.pool.query(
      "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,'old-file','page','topic',$2,5,'text/plain','x','clean','editor')",
      [f.workspaceId, blobHash("a")],
    ),
  ).rejects.toThrow("RETENTION_ARTIFACT_RETIRED");
});
test("typed runtime answers and finished jobs can be individually retired without deleting other actors records", async () => {
  await f.pool.query(
    "INSERT INTO runtime_answers VALUES($1,'answer-old','editor',$2),($1,'answer-other','reader',$3)",
    [
      f.workspaceId,
      {
        id: "answer-old",
        answer: "PRIVATE_BODY",
        citations: [],
        inputEnvelope: { pageIds: [], sourceIds: [] },
      },
      {
        id: "answer-other",
        answer: "other",
        citations: [],
        inputEnvelope: { pageIds: [], sourceIds: [] },
      },
    ],
  );
  await f.pool.query(
    "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status,result_id) VALUES('job-old',$1,'editor','query','succeeded','answer-old')",
    [f.workspaceId],
  );
  const p = await plan([
    { kind: "runtime-answer", id: "answer-old" },
    { kind: "runtime-job", id: "job-old" },
  ]);
  const r = await service.executePruning(actor(), {
    planId: p.id,
    previewHash: p.previewHash,
  });
  expect(r).toMatchObject({
    status: "completed",
    deleted: 2,
    physicalPurgePending: 0,
    allCopiesErased: false,
  });
  expect(
    (
      await f.pool.query(
        "SELECT id FROM runtime_answers WHERE workspace_id=$1",
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([{ id: "answer-other" }]);
  await expect(
    f.pool.query(
      "INSERT INTO runtime_answers VALUES($1,'answer-old','editor','{}')",
      [f.workspaceId],
    ),
  ).rejects.toThrow("RETENTION_ARTIFACT_RETIRED");
});
test.each(["head", "shared", "hold", "opaque", "snapshot"])(
  "attachment %s references block explicit retirement",
  async (condition) => {
    const selected = await attachment();
    if (condition === "head") selected.revision = 2;
    if (condition === "shared")
      await f.pool.query(
        "INSERT INTO access_shares(workspace_id,id,page_id,version,principal_id,actions,expires_at) VALUES($1,'shared','topic',1,'reader',ARRAY['knowledge.read'],now()+interval '1 day')",
        [f.workspaceId],
      );
    if (condition === "hold")
      await f.pool.query(
        "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'hold','source','source-a','fixture-owner')",
        [f.workspaceId],
      );
    if (condition === "opaque")
      await f.pool.query(
        "INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,'private','editor','voc','private','private','copied content')",
        [f.workspaceId],
      );
    if (condition === "snapshot")
      await f.pool.query(
        "INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,'protected','source-a','old-file',$2)",
        [f.workspaceId, blobHash("a")],
      );
    const p = await service.previewPruning(actor(), { selection: [selected] });
    expect(p.records[0].eligible).toBe(false);
    await expect(
      service.planPruning(actor(), {
        selection: [selected],
        previewHash: p.hash,
        policyRevision: 0,
      }),
    ).rejects.toThrow("RETENTION_SELECTION_BLOCKED");
  },
);
test("postapproval policy, hold and graph changes invalidate deletion; reviewer revocation cannot reuse approval", async () => {
  const selected = await attachment(),
    p = await plan([selected]);
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'late','page','topic','fixture-owner')",
    [f.workspaceId],
  );
  await expect(
    service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    }),
  ).rejects.toThrow("RETENTION_PREVIEW_STALE");
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
});
test("recovery replay deletes exact restored attachment history but refuses current head or newly held ancestry", async () => {
  await attachment();
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(822025)");
    await db.query(
      "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'attachment-version','file-slot/1/old-file',$2,$3,'fixture-owner')",
      [f.workspaceId, JSON.stringify([blobHash("a")]), "c".repeat(64)],
    );
    await replayRetentionTombstones(db, f.workspaceId);
    expect(
      (
        await db.query(
          "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("revoking independent reviewer or historical source access blocks an approved plan", async () => {
  const selected = await attachment(),
    p = await plan([selected]);
  await f.pool.query(
    "UPDATE access_grants SET revoked=true WHERE workspace_id=$1 AND principal_id='reviewer'",
    [f.workspaceId],
  );
  await expect(
    service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    }),
  ).rejects.toThrow("NOT_FOUND");
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
});
test("active download tickets and historical ancestor shares block pruning", async () => {
  const selected = await attachment();
  await f.pool.query(
    "INSERT INTO storage_tickets(workspace_id,blob_id,principal_id,token_hash,expires_at) VALUES($1,'old-file','editor','opaque',now()+interval '1 hour')",
    [f.workspaceId],
  );
  const p = await service.previewPruning(actor(), { selection: [selected] });
  expect(p.records[0].reasons).toContain("ACTIVE_DOWNLOAD_TICKET");
});
test("new content columns on review plans fail closed rather than escape the graph", async () => {
  await attachment();
  await f.pool.query(
    "ALTER TABLE content_retention_plans ADD COLUMN untracked_body text",
  );
  try {
    await expect(
      service.previewPruning(actor(), {
        selection: [
          { kind: "attachment-version", slotId: "file-slot", revision: 1 },
        ],
      }),
    ).rejects.toThrow("RETENTION_GRAPH_UNSUPPORTED");
  } finally {
    await f.pool.query(
      "ALTER TABLE content_retention_plans DROP COLUMN untracked_body",
    );
  }
});

test("committed granular tombstone authorizes only its unreferenced CAS file and finalizes the pruning receipt after physical removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "akh-granular-cas-"));
  try {
    const selected = await attachment(),
      p = await plan([selected]);
    await writeFile(join(root, blobHash("a")), "owned synthetic old file");
    await writeFile(join(root, blobHash("b")), "owned synthetic head file");
    const receipt = await service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    });
    const operations = new OperationsService(f.pool, authorizeInTransaction, {
      physicalDeletionGateConfirmed: true,
    });
    const purged = await operations.purgeApprovedBlobs(
      actor(),
      async (hash) => {
        await rm(join(root, hash), { force: true });
      },
    );
    expect(purged.removed).toBe(1);
    await expect(readFile(join(root, blobHash("a")))).rejects.toThrow();
    expect(await readFile(join(root, blobHash("b")), "utf8")).toBe(
      "owned synthetic head file",
    );
    const stored = (
      await f.pool.query(
        "SELECT status,details FROM content_retention_receipts WHERE workspace_id=$1 AND id=$2",
        [f.workspaceId, receipt.id],
      )
    ).rows[0];
    expect(stored).toMatchObject({
      status: "completed",
      details: { physicalPurgePending: 0, allCopiesErased: false },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "refinement_evidence",
  "refinement_claims",
  "refinement_outcomes",
] as const)(
  "retained %s blocks answer retirement without returning its private body",
  async (table) => {
    await f.pool.query(
      "INSERT INTO runtime_answers VALUES($1,'pinned-answer','editor',$2)",
      [
        f.workspaceId,
        {
          id: "pinned-answer",
          answer: "private",
          citations: [],
          inputEnvelope: { pageIds: [], sourceIds: [] },
        },
      ],
    );
    await f.pool.query(
      `INSERT INTO ${table}(workspace_id,id,data) VALUES($1,'retained-consumer',$2)`,
      [
        f.workspaceId,
        { answerId: "pinned-answer", content: "PRIVATE_RETAINED_BODY" },
      ],
    );
    const p = await service.previewPruning(actor(), {
      selection: [{ kind: "runtime-answer", id: "pinned-answer" }],
    });
    expect(p.records[0].eligible).toBe(false);
    expect(p.records[0].reasons).toContain("RETAINED_REFERENCE");
    expect(JSON.stringify(p)).not.toContain("PRIVATE_RETAINED_BODY");
  },
);
test("changed policy and blocked execution produce an explicit failure receipt and preserve the selected artifact", async () => {
  const s = await attachment(),
    p = await plan([s]);
  await service.setPolicy(actor(), {
    expectedRevision: 0,
    policy: {
      enabled: false,
      drafts: null,
      publishedVersions: null,
      sourceVersions: null,
      runtimeResults: null,
    },
  });
  await expect(
    service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    }),
  ).rejects.toThrow("RETENTION_PREVIEW_STALE");
  const receipt = (
    await f.pool.query(
      "SELECT status,details FROM content_retention_receipts WHERE workspace_id=$1 AND details->>'planId'=$2",
      [f.workspaceId, p.id],
    )
  ).rows[0];
  expect(receipt).toMatchObject({
    status: "failed",
    details: { code: "RETENTION_PREVIEW_STALE", allCopiesErased: false },
  });
  expect(
    (
      await f.pool.query(
        "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
        [f.workspaceId],
      )
    ).rowCount,
  ).toBe(1);
});
test("direct granular recovery hook also requires the exclusive quarantine mutation gate", async () => {
  const { replayGranularPruning } = await import("./granular");
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await expect(replayGranularPruning(db, f.workspaceId)).rejects.toThrow(
      "RETENTION_EXCLUSIVE_GATE_REQUIRED",
    );
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});

test("explicit manual selection cannot shorten an existing configured minimum retention period", async () => {
  await f.pool.query(
    "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES('young-job',$1,'editor','query','succeeded')",
    [f.workspaceId],
  );
  await service.setPolicy(actor(), {
    expectedRevision: 0,
    policy: {
      enabled: false,
      drafts: null,
      publishedVersions: null,
      sourceVersions: null,
      runtimeResults: 30,
    },
  });
  const p = await service.previewPruning(actor(), {
    selection: [{ kind: "runtime-job", id: "young-job" }],
  });
  expect(p.records[0].eligible).toBe(false);
  expect(p.records[0].reasons).toContain("MINIMUM_RETENTION_PERIOD");
});

test.each([false, true])(
  "signed current artifact ledger replays restored attachment history; current hold=%s keeps recovery fenced",
  async (held) => {
    const { captureRecoveryLedger, readRecoveryLedger } =
      await import("../operations/recovery");
    const selected = await attachment();
    const old = (
      await f.pool.query(
        "SELECT * FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
        [f.workspaceId],
      )
    ).rows[0];
    const p = await plan([selected]);
    await service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    });
    const encryption = "owned-granular-encryption".repeat(3),
      signing = "independent-granular-signature".repeat(3);
    const ledger = readRecoveryLedger(
      await captureRecoveryLedger(f.pool, encryption, signing),
      encryption,
      signing,
    );
    const artifact = ledger.erasedArtifacts!.find(
      (a) =>
        a.workspace_id === f.workspaceId &&
        a.artifact_kind === "attachment-version",
    )!;
    expect(artifact.artifact_id).toBe("file-slot/1/old-file");
    const db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(822025)");
      await db.query(
        "DELETE FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='attachment-version'",
        [f.workspaceId],
      );
      await db.query(
        "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          f.workspaceId,
          old.id,
          old.parent_kind,
          old.parent_id,
          old.sha256,
          old.size,
          old.mime,
          old.filename,
          old.scan_state,
          old.created_by,
          old.created_at,
        ],
      );
      await db.query(
        "INSERT INTO storage_attachment_versions VALUES($1,'file-slot',1,'old-file')",
        [f.workspaceId],
      );
      await db.query(
        "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          artifact.workspace_id,
          artifact.artifact_kind,
          artifact.artifact_id,
          JSON.stringify(artifact.hashes),
          artifact.preview_hash,
          artifact.approved_by,
        ],
      );
      if (held)
        await db.query(
          "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'restored-hold','source','source-a','fixture-owner')",
          [f.workspaceId],
        );
      if (held) {
        await expect(
          replayRetentionTombstones(db, f.workspaceId),
        ).rejects.toThrow("RETENTION_REPLAY_REFERENCE_CONFLICT");
        expect(
          (
            await db.query(
              "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
              [f.workspaceId],
            )
          ).rowCount,
        ).toBe(1);
      } else {
        await replayRetentionTombstones(db, f.workspaceId);
        expect(
          (
            await db.query(
              "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
              [f.workspaceId],
            )
          ).rowCount,
        ).toBe(0);
      }
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  },
);
