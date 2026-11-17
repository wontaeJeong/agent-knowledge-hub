import { beforeEach, afterEach, expect, test } from "vitest";
import { fixture, adoptFixture } from "../test-support";
import { AccessService, authorizeInTransaction } from "../access/index";
import { ContentRetentionService } from "./service";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationsService } from "../operations/service";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runTestPgTool as run } from "../operations/test-pg-tools";
import {
  captureRecoveryLedger,
  readRecoveryLedger,
  secureRestoredDatabase,
  assertOperationalStartup,
} from "../operations/recovery";
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
test("a legal-hold blocked selection request leaves an explicit scoped blocked receipt", async () => {
  const selected = await attachment();
  await f.pool.query(
    "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,'selected-hold','source','source-a','fixture-owner')",
    [f.workspaceId],
  );
  const preview = await service.previewPruning(actor(), {
    selection: [selected],
  });
  await expect(
    service.planPruning(actor(), {
      selection: [selected],
      previewHash: preview.hash,
      policyRevision: preview.policyRevision,
    }),
  ).rejects.toThrow("RETENTION_SELECTION_BLOCKED");
  const receipt = (
    await f.pool.query(
      "SELECT status,details FROM content_retention_receipts WHERE workspace_id=$1",
      [f.workspaceId],
    )
  ).rows[0];
  expect(receipt).toMatchObject({
    status: "blocked",
    details: {
      code: "RETENTION_SELECTION_BLOCKED",
      selection: [
        { kind: "attachment-version", slotId: "file-slot", revision: 1 },
      ],
      allCopiesErased: false,
    },
  });
});

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
test.each(["content_retention_plans", "operations_erased_artifacts"])(
  "new content columns on %s fail closed rather than escape the graph",
  async (table) => {
    await attachment();
    await f.pool.query(`ALTER TABLE ${table} ADD COLUMN untracked_body text`);
    try {
      await expect(
        service.previewPruning(actor(), {
          selection: [
            { kind: "attachment-version", slotId: "file-slot", revision: 1 },
          ],
        }),
      ).rejects.toThrow("RETENTION_GRAPH_UNSUPPORTED");
    } finally {
      await f.pool.query(`ALTER TABLE ${table} DROP COLUMN untracked_body`);
    }
  },
);

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
    expect(p.records[0].reasons).toContain("UNKNOWN_REFERENCE");
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

test.each([false, true])(
  "private consumer identifiers remain hidden in preview, status, blocked errors and receipts; mentions=%s",
  async (mentions) => {
    const selected = await attachment();
    const privateId = "private-consumer-identifier-78231";
    await f.pool.query(
      "INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,$2,'editor','voc','private','PRIVATE_CONSUMER_TITLE',$3)",
      [
        f.workspaceId,
        privateId,
        mentions ? "old-file" : "unrelated private text",
      ],
    );
    const preview = await service.previewPruning(actor(), {
      selection: [selected],
    });
    expect(preview.records[0].eligible).toBe(false);
    expect(preview.records[0].reasons).toContain("UNKNOWN_REFERENCE");
    expect(preview.records[0].retainedBy).toEqual([]);
    let blocked: unknown;
    try {
      await service.planPruning(actor(), {
        selection: [selected],
        previewHash: preview.hash,
        policyRevision: preview.policyRevision,
      });
    } catch (error) {
      blocked = error instanceof Error ? error.message : error;
    }
    expect(blocked).toBe("RETENTION_SELECTION_BLOCKED");
    const responses = [
      preview,
      await service.listPruning(actor()),
      await service.receipts(actor()),
      blocked,
    ];
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(privateId);
      expect(JSON.stringify(response)).not.toContain("PRIVATE_CONSUMER_TITLE");
      expect(JSON.stringify(response)).not.toContain("board_posts");
    }
    expect(
      (
        await f.pool.query(
          "SELECT 1 FROM storage_blobs WHERE workspace_id=$1 AND id='old-file'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(1);
  },
);

test.each(["attachment-version", "runtime-answer", "runtime-job"] as const)(
  "signed %s ledger fences restored identity changes and conflicting artifact tombstones",
  async (kind) => {
    const selected =
      kind === "attachment-version"
        ? await attachment()
        : { kind, id: "restore-runtime" };
    if (kind === "runtime-answer")
      await f.pool.query(
        "INSERT INTO runtime_answers VALUES($1,'restore-runtime','editor',$2)",
        [
          f.workspaceId,
          {
            id: "restore-runtime",
            answer: "ORIGINAL_PRIVATE_ANSWER",
            citations: [],
            inputEnvelope: { pageIds: [], sourceIds: [] },
          },
        ],
      );
    if (kind === "runtime-job")
      await f.pool.query(
        "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES('restore-runtime',$1,'editor','query','succeeded')",
        [f.workspaceId],
      );
    const sourceDatabase = (
      await f.pool.query("SELECT current_database() AS name")
    ).rows[0].name;
    const dump = run(["pg_dump", "-d", sourceDatabase, "-Fc"]);
    const p = await plan([selected]);
    await service.executePruning(actor(), {
      planId: p.id,
      previewHash: p.previewHash,
    });
    const encryption = "owned-granular-restore-encryption".repeat(3),
      signing = "independent-granular-restore-signature".repeat(3);
    const ledger = readRecoveryLedger(
      await captureRecoveryLedger(f.pool, encryption, signing),
      encryption,
      signing,
    );
    const artifact = ledger.erasedArtifacts!.find(
      (a) => a.workspace_id === f.workspaceId && a.artifact_kind === kind,
    )!;
    const table =
      kind === "attachment-version"
        ? "storage_blobs"
        : kind === "runtime-answer"
          ? "runtime_answers"
          : "runtime_jobs";
    const restoredId =
      kind === "attachment-version" ? "old-file" : "restore-runtime";
    for (const checkpoint of [
      "exact",
      "changed-identity",
      "conflicting-ledger",
      ...(kind === "runtime-answer" ? (["unsigned-extra"] as const) : []),
    ] as const) {
      const database = "akh_ops_restore_" + randomUUID().replaceAll("-", "");
      let restored: Pool | undefined,
        created = false;
      try {
        run(["createdb", database]);
        created = true;
        run(
          ["pg_restore", "--no-owner", "--exit-on-error", "-d", database],
          dump,
        );
        const url = new URL(process.env.TEST_DATABASE_URL!);
        url.pathname = "/" + database;
        restored = new Pool({ connectionString: url.href });
        if (checkpoint !== "exact" && checkpoint !== "unsigned-extra") {
          if (kind === "attachment-version")
            await restored.query(
              "UPDATE storage_blobs SET sha256=$2 WHERE workspace_id=$1 AND id='old-file'",
              [f.workspaceId, "e".repeat(64)],
            );
          if (kind === "runtime-answer")
            await restored.query(
              "UPDATE runtime_answers SET data=jsonb_set(data,'{answer}','\"DIFFERENT_PRIVATE_ANSWER\"') WHERE workspace_id=$1 AND id='restore-runtime'",
              [f.workspaceId],
            );
          if (kind === "runtime-job")
            await restored.query(
              "UPDATE runtime_jobs SET error_code='DIFFERENT_RESTORED_RECORD' WHERE workspace_id=$1 AND id='restore-runtime'",
              [f.workspaceId],
            );
        }
        if (checkpoint === "conflicting-ledger") {
          const changedHash =
            kind === "attachment-version"
              ? "e".repeat(64)
              : (
                  await restored.query(
                    `SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS hash FROM "${table}" t WHERE workspace_id=$1 AND id=$2`,
                    [f.workspaceId, restoredId],
                  )
                ).rows[0].hash;
          await restored.query(
            "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by,identity_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              artifact.workspace_id,
              artifact.artifact_kind,
              artifact.artifact_id,
              JSON.stringify(
                kind === "attachment-version" ? [changedHash] : [],
              ),
              artifact.preview_hash,
              artifact.approved_by,
              kind === "attachment-version" ? null : changedHash,
            ],
          );
        }
        if (checkpoint === "unsigned-extra") {
          await restored.query(
            "INSERT INTO runtime_answers VALUES($1,'unsigned-extra-runtime','editor',$2)",
            [
              f.workspaceId,
              {
                id: "unsigned-extra-runtime",
                answer: "UNAPPROVED_CURRENT_CONTENT",
                citations: [],
                inputEnvelope: { pageIds: [], sourceIds: [] },
              },
            ],
          );
          await restored.query(
            "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by,identity_hash) SELECT workspace_id,'runtime-answer',id,'[]',$2,'fixture-owner',encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') FROM runtime_answers t WHERE workspace_id=$1 AND id='unsigned-extra-runtime'",
            [f.workspaceId, "e".repeat(64)],
          );
        }
        if (checkpoint === "exact") {
          const restoredRecord = (
            await restored.query(
              `SELECT to_jsonb(t) AS data FROM "${table}" t WHERE workspace_id=$1 AND id=$2`,
              [f.workspaceId, restoredId],
            )
          ).rows[0].data;
          const secured = await secureRestoredDatabase(restored, ledger);
          if (kind !== "attachment-version") {
            expect(artifact.hashes).toEqual([]);
            expect(artifact.identity_hash).toMatch(/^[a-f0-9]{64}$/);
            expect(secured.deletedHashes).not.toContain(artifact.identity_hash);
          }
          expect(
            (
              await restored.query(
                `SELECT 1 FROM "${table}" WHERE workspace_id=$1 AND id=$2`,
                [f.workspaceId, restoredId],
              )
            ).rowCount,
          ).toBe(0);
          expect(
            (
              await restored.query(
                "SELECT hashes FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind=$2 AND artifact_id=$3",
                [artifact.workspace_id, kind, artifact.artifact_id],
              )
            ).rows[0].hashes,
          ).toEqual(artifact.hashes);
          await expect(
            restored.query(
              `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)`,
              [JSON.stringify(restoredRecord)],
            ),
          ).rejects.toThrow("RETENTION_ARTIFACT_RETIRED");
          await restored.query(
            `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)`,
            [
              JSON.stringify({
                ...restoredRecord,
                id: restoredId + "-unretired",
              }),
            ],
          );
          await expect(
            restored.query(
              `UPDATE "${table}" SET id=$3 WHERE workspace_id=$1 AND id=$2`,
              [f.workspaceId, restoredId + "-unretired", restoredId],
            ),
          ).rejects.toThrow("RETENTION_ARTIFACT_RETIRED");
        } else {
          await expect(
            secureRestoredDatabase(restored, ledger),
          ).rejects.toThrow(
            checkpoint === "conflicting-ledger" ||
              checkpoint === "unsigned-extra"
              ? "RECOVERY_ARTIFACT_LEDGER_CONFLICT"
              : "RETENTION_REPLAY_REFERENCE_CONFLICT",
          );
          expect(
            (
              await restored.query(
                `SELECT 1 FROM "${table}" WHERE workspace_id=$1 AND id=$2`,
                [f.workspaceId, restoredId],
              )
            ).rowCount,
          ).toBe(1);
        }
        expect(
          (
            await restored.query(
              "SELECT 1 FROM operations_tombstones WHERE workspace_id=$1 AND id='restore-quarantine'",
              [f.workspaceId],
            )
          ).rowCount,
        ).toBe(1);
        await expect(assertOperationalStartup(restored)).rejects.toThrow(
          "RESTORED_DATABASE_QUARANTINED_CURRENT_IDENTITY_IMPORT_REQUIRED",
        );
      } finally {
        await restored?.end();
        if (created) run(["dropdb", "--force", database]);
      }
    }
  },
  // This test performs pg_dump plus up to four real pg_restore checkpoints.
  30000,
);

test("opaque consumer body matches do not create a reference metadata oracle", async () => {
  const selected = await attachment();
  await f.pool.query(
    "INSERT INTO board_posts(workspace_id,id,author_id,kind,visibility,title,body) VALUES($1,'opaque-oracle','editor','voc','private','private','unrelated')",
    [f.workspaceId],
  );
  const before = await service.previewPruning(actor(), {
    selection: [selected],
  });
  await f.pool.query(
    "UPDATE board_posts SET body='old-file' WHERE workspace_id=$1 AND id='opaque-oracle'",
    [f.workspaceId],
  );
  const after = await service.previewPruning(actor(), {
    selection: [selected],
  });
  expect(after.records[0].reasons).toEqual(before.records[0].reasons);
  expect(after.records[0].retainedBy).toEqual(before.records[0].retainedBy);
  expect(after.records[0].eligible).toBe(false);
});

test.each(["runtime-answer", "runtime-job"] as const)(
  "legacy unbound %s tombstone retains restored content behind the replay fence",
  async (kind) => {
    if (kind === "runtime-answer")
      await f.pool.query(
        "INSERT INTO runtime_answers VALUES($1,'unbound-runtime','editor',$2)",
        [
          f.workspaceId,
          {
            id: "unbound-runtime",
            answer: "restored",
            citations: [],
            inputEnvelope: { pageIds: [], sourceIds: [] },
          },
        ],
      );
    else
      await f.pool.query(
        "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES('unbound-runtime',$1,'editor','query','succeeded')",
        [f.workspaceId],
      );
    const db = await f.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(822025)");
      await db.query(
        "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,$2,'unbound-runtime','[]',$3,'fixture-owner')",
        [f.workspaceId, kind, "b".repeat(64)],
      );
      await expect(
        replayRetentionTombstones(db, f.workspaceId),
      ).rejects.toThrow("RETENTION_REPLAY_REFERENCE_CONFLICT");
      const table =
        kind === "runtime-answer" ? "runtime_answers" : "runtime_jobs";
      expect(
        (
          await db.query(
            `SELECT 1 FROM "${table}" WHERE workspace_id=$1 AND id='unbound-runtime'`,
            [f.workspaceId],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
  },
);

test("restored terminal job identity is independent of the recovery session timezone", async () => {
  await f.pool.query(
    "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES('timezone-job',$1,'editor','query','succeeded')",
    [f.workspaceId],
  );
  const original = (
    await f.pool.query(
      "SELECT to_jsonb(t) AS data FROM runtime_jobs t WHERE workspace_id=$1 AND id='timezone-job'",
      [f.workspaceId],
    )
  ).rows[0].data;
  const p = await plan([{ kind: "runtime-job", id: "timezone-job" }]);
  await service.executePruning(actor(), {
    planId: p.id,
    previewHash: p.previewHash,
  });
  const db = await f.pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(822025)");
    const tombstone = (
      await db.query(
        "DELETE FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind='runtime-job' AND artifact_id='timezone-job' RETURNING to_jsonb(operations_erased_artifacts) AS data",
        [f.workspaceId],
      )
    ).rows[0].data;
    await db.query(
      "INSERT INTO runtime_jobs SELECT * FROM jsonb_populate_record(NULL::runtime_jobs,$1::jsonb)",
      [JSON.stringify(original)],
    );
    await db.query(
      "INSERT INTO operations_erased_artifacts SELECT * FROM jsonb_populate_record(NULL::operations_erased_artifacts,$1::jsonb)",
      [JSON.stringify(tombstone)],
    );
    await db.query("SET LOCAL timezone='Pacific/Honolulu'");
    await replayRetentionTombstones(db, f.workspaceId);
    expect(
      (
        await db.query(
          "SELECT 1 FROM runtime_jobs WHERE workspace_id=$1 AND id='timezone-job'",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});
