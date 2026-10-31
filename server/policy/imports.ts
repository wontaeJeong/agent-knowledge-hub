import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { fingerprint, type InputEnvelope, assertEnvelope } from "../provenance";
import { loadState } from "../repository";
import { authorize, policyEvent, assertPolicyTransaction } from "./common";
import { assertFeature } from "./features";
import {
  assertModelTransmission,
  canonicalDestinationUrl,
  sourcePolicyHash,
} from "./model";
import type { ModelOptions } from "../runtime/model";
import { configuredModelEndpoint } from "./binding";

const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((v) => !Object.hasOwn(Object.prototype, v) && v !== "prototype");
const grant = z
  .object({
    destinationId: id,
    purpose: z.literal("organize"),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const policy = z
  .object({
    importId: id,
    expectedRevision: z.number().int().nonnegative(),
    expectedImportRevision: z.number().int().positive(),
    classification: id,
    grants: z.array(grant).max(100),
    impactAcknowledged: z.literal(true),
  })
  .strict();
export type PrivateImportPolicyInput = z.infer<typeof policy>;
export type PrivateImportRef = { importId: string; inputRevision: number };

async function rawImport(db: PoolClient, ctx: Context, ref: PrivateImportRef) {
  await authorize(db, ctx, "source.create");
  const r = (
    await db.query(
      "SELECT id,principal_id,revision,status,selection,parsed FROM imports WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, id.parse(ref.importId)],
    )
  ).rows[0];
  if (!r || r.principal_id !== ctx.principalId) throw Error("NOT_FOUND");
  if (r.revision !== ref.inputRevision) throw Error("STALE_VERSION");
  const files = (
    await db.query(
      "SELECT id,size,sha256,received FROM import_files WHERE workspace_id=$1 AND import_id=$2 ORDER BY id",
      [ctx.workspaceId, ref.importId],
    )
  ).rows;
  return {
    row: r,
    hash: fingerprint({
      revision: r.revision,
      selection: r.selection,
      parsed: r.parsed,
      files,
    }),
  };
}
export async function readPrivateImportPolicy(
  db: PoolClient,
  ctx: Context,
  importId: string,
) {
  await authorize(db, ctx, "source.create");
  const r = (
    await db.query(
      "SELECT revision FROM imports WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
      [ctx.workspaceId, id.parse(importId), ctx.principalId],
    )
  ).rows[0];
  if (!r) throw Error("NOT_FOUND");
  await rawImport(db, ctx, { importId, inputRevision: r.revision });
  const p = (
    await db.query(
      "SELECT revision,import_revision,input_hash,classification,grants FROM policy_private_import_sources WHERE workspace_id=$1 AND import_id=$2",
      [ctx.workspaceId, importId],
    )
  ).rows[0];
  return {
    importId,
    importRevision: r.revision,
    revision: p?.revision ?? 0,
    classification: p?.classification ?? "unknown",
    grants: p?.grants ?? [],
    approvedInputRevision: p?.import_revision ?? null,
  };
}
export async function setPrivateImportPolicy(
  db: PoolClient,
  ctx: Context,
  raw: PrivateImportPolicyInput,
) {
  const p = policy.parse(raw);
  await assertPolicyTransaction(db);
  await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
    ctx.workspaceId,
  ]);
  if (ctx.credentialId) throw Error("FORBIDDEN");
  const current = await rawImport(db, ctx, {
    importId: p.importId,
    inputRevision: p.expectedImportRevision,
  });
  const human = (
    await db.query(
      "SELECT 1 FROM access_principals WHERE id=$1 AND kind='human' AND active",
      [ctx.principalId],
    )
  ).rowCount;
  if (!human) throw Error("FORBIDDEN");
  for (const g of p.grants) {
    const d = (
      await db.query("SELECT * FROM model_destinations WHERE id=$1", [
        g.destinationId,
      ])
    ).rows[0];
    if (
      !d?.active ||
      d.fingerprint !== g.fingerprint ||
      !d.purposes.includes("organize") ||
      !d.classifications.includes(p.classification)
    )
      throw Error("MODEL_TRANSMISSION_DENIED");
  }
  const old = (
    await db.query(
      "SELECT revision FROM policy_private_import_sources WHERE workspace_id=$1 AND import_id=$2",
      [ctx.workspaceId, p.importId],
    )
  ).rows[0];
  if ((old?.revision ?? 0) !== p.expectedRevision) throw Error("STALE_VERSION");
  await db.query(
    "INSERT INTO policy_private_import_sources VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,import_id) DO UPDATE SET revision=excluded.revision,import_revision=excluded.import_revision,input_hash=excluded.input_hash,classification=excluded.classification,grants=excluded.grants",
    [
      ctx.workspaceId,
      p.importId,
      p.expectedRevision + 1,
      p.expectedImportRevision,
      current.hash,
      p.classification,
      JSON.stringify(p.grants),
    ],
  );
  await policyEvent(
    db,
    ctx,
    "import.model-policy",
    p.importId,
    p.expectedRevision + 1,
    {
      importRevision: p.expectedImportRevision,
      inputHash: current.hash,
      classification: p.classification,
      grants: p.grants,
      impact:
        "개인 원본 정리 전송만 허용하며 공유·발행·사내 승인을 부여하지 않습니다.",
    },
  );
}
async function assertImport(
  db: PoolClient,
  ctx: Context,
  ref: PrivateImportRef,
  destinationId: string,
  endpoint: string,
  envelope: InputEnvelope,
) {
  await assertFeature(db, ctx, "imports", undefined, "source.create");
  await assertFeature(db, ctx, "models", undefined, "source.create");
  const raw = await rawImport(db, ctx, ref);
  const p = (
    await db.query(
      "SELECT * FROM policy_private_import_sources WHERE workspace_id=$1 AND import_id=$2",
      [ctx.workspaceId, ref.importId],
    )
  ).rows[0];
  const d = (
    await db.query("SELECT * FROM model_destinations WHERE id=$1", [
      id.parse(destinationId),
    ])
  ).rows[0];
  if (
    !d?.active ||
    d.canonical_url !== canonicalDestinationUrl(endpoint) ||
    !d.purposes.includes("organize") ||
    !p ||
    p.input_hash !== raw.hash ||
    p.import_revision !== ref.inputRevision ||
    !d.classifications.includes(p.classification) ||
    !p.grants.some(
      (g: z.infer<typeof grant>) =>
        g.destinationId === destinationId &&
        g.purpose === "organize" &&
        g.fingerprint === d.fingerprint,
    )
  )
    throw Error("MODEL_TRANSMISSION_DENIED");
  if (envelope.pageIds.length || envelope.sourceIds.length) {
    await assertModelTransmission(db, ctx, {
      destinationId,
      purpose: "organize",
      pageIds: envelope.pageIds,
      sourceIds: envelope.sourceIds,
    });
    await assertEnvelope(
      db,
      ctx,
      await loadState(db, ctx.workspaceId),
      envelope,
    );
  }
  return fingerprint({
    importPolicy: p,
    rawHash: raw.hash,
    policyEpoch: await sourcePolicyHash(
      db,
      ctx,
      { pageIds: envelope.pageIds, sourceIds: envelope.sourceIds },
      "source.create",
    ),
  });
}
/** Only the imports worker can supply this ref after binding its current run/lease.
 * Call once per ACTUAL extraction/consolidation transmission, never at enqueue only.
 */
export async function bindPrivateImportTransmission(
  pool: Pool,
  ctx: Context,
  ref: PrivateImportRef,
  envelope: InputEnvelope,
  options: ModelOptions = {},
  endpoint = configuredModelEndpoint(),
) {
  const destinationId = process.env.AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID;
  if (!destinationId) throw Error("MODEL_TRANSMISSION_DENIED");
  const prepare = async (url: string) => {
    await ctx.authorization?.revalidate();
    const epoch = await transaction(pool, ctx.workspaceId, (db) =>
      assertImport(db, ctx, ref, destinationId, url, envelope),
    );
    return async (db: PoolClient) => {
      if (
        (await assertImport(db, ctx, ref, destinationId, url, envelope)) !==
        epoch
      )
        throw Error("STALE_VERSION");
    };
  };
  let check = await prepare(endpoint);
  return {
    options: {
      ...options,
      beforeTransmission: async (url: string) => {
        await options.beforeTransmission?.(url);
        check = await prepare(url);
      },
    } satisfies ModelOptions,
    recheck: async (db: PoolClient) => check(db),
  };
}
