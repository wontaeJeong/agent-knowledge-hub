import type { PoolClient, Pool } from "pg";
import { randomUUID, createHash } from "node:crypto";
import type { Context } from "../service";
import {
  openExport,
  sealExport,
  verifyAudit,
  type AuditRow,
  type OperationsService,
} from "./service";
import {
  auditHashAt,
  verifyArchiveHistoryOnClient,
  type AuditArchiveTarget,
} from "./archive";
export interface AuditHead {
  sequence: string;
  hash: string;
}
export interface AuditAnchor {
  version: 2;
  type: "audit-anchor" | "audit-head";
  workspaceId: string;
  checkpoint: AuditHead;
  head: AuditHead;
  previousHead: AuditHead | null;
  rows?: AuditRow[];
  actorHash?: string;
}
export interface AuditHeadStore {
  target: AuditArchiveTarget;
  key: string;
  signingKey: string;
  readAnchor: (workspaceId: string) => Promise<string | null>;
  anchor: (
    name: string,
    encrypted: string,
    fence?: <T>(work: () => Promise<T>) => Promise<T>,
  ) => Promise<void>;
}
const zero = (): AuditHead => ({ sequence: "0", hash: "0".repeat(64) });
export const AUDIT_HEAD_FENCE_SEED = 822028;
/** Optional backend fence for ALL direct/offline store writers. No BEGIN, common transaction or workspace-row lock here. */
export async function withAuditHeadStoreFence<T>(
  pool: Pool,
  workspaceId: string,
  work: () => Promise<T>,
) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspaceId))
    throw Error("INVALID_SPACE_ID");
  const db = await pool.connect();
  let locked = false,
    previous: string | undefined,
    failed = false;
  try {
    previous = (await db.query("SHOW lock_timeout")).rows[0].lock_timeout;
    await db.query("SELECT set_config('lock_timeout','5s',false)");
    await db.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [
      workspaceId,
      AUDIT_HEAD_FENCE_SEED,
    ]);
    locked = true;
    return await work();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    try {
      if (locked)
        await db.query("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [
          workspaceId,
          AUDIT_HEAD_FENCE_SEED,
        ]);
      if (previous !== undefined)
        await db.query("SELECT set_config('lock_timeout',$1,false)", [
          previous,
        ]);
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      db.release(failed);
    }
  }
}
const valid = (v: unknown): v is AuditHead =>
  !!v &&
  typeof v === "object" &&
  "sequence" in v &&
  typeof v.sequence === "string" &&
  /^(0|[1-9][0-9]{0,18})$/.test(v.sequence) &&
  "hash" in v &&
  typeof v.hash === "string" &&
  /^[a-f0-9]{64}$/.test(v.hash);
export function decodeAuditAnchor(
  encrypted: string,
  key: string,
  signingKey: string,
  workspaceId: string,
): AuditAnchor {
  const data = openExport(encrypted, key, signingKey);
  if (Array.isArray(data)) {
    const rows = data as AuditRow[];
    if (!verifyAudit(rows)) throw Error("AUDIT_ANCHOR_INVALID");
    const last = rows.at(-1);
    return {
      version: 2,
      type: "audit-anchor",
      workspaceId,
      checkpoint: zero(),
      head: last ? { sequence: last.sequence, hash: last.hash } : zero(),
      previousHead: null,
      rows,
    };
  }
  const d = data as AuditAnchor;
  if (
    !d ||
    d.version !== 2 ||
    !["audit-anchor", "audit-head"].includes(d.type) ||
    d.workspaceId !== workspaceId ||
    !valid(d.head) ||
    !valid(d.checkpoint) ||
    BigInt(d.checkpoint.sequence) > BigInt(d.head.sequence) ||
    (d.previousHead !== null && !valid(d.previousHead))
  )
    throw Error("AUDIT_ANCHOR_INVALID");
  if (d.type === "audit-anchor") {
    if (
      !Array.isArray(d.rows) ||
      d.rows.length > 10000 ||
      !verifyAudit(d.rows, d.checkpoint)
    )
      throw Error("AUDIT_ANCHOR_INVALID");
    const last = d.rows.at(-1),
      end = last ? { sequence: last.sequence, hash: last.hash } : d.checkpoint;
    if (end.sequence !== d.head.sequence || end.hash !== d.head.hash)
      throw Error("AUDIT_ANCHOR_INVALID");
  }
  return d;
}
function required(config: AuditHeadStore) {
  if (
    typeof config.readAnchor !== "function" ||
    typeof config.anchor !== "function"
  )
    throw Error("AUDIT_INDEPENDENT_HEAD_STORE_REQUIRED");
}
async function priorHead(
  db: PoolClient,
  ctx: Context,
  config: AuditHeadStore,
  current: AuditHead,
) {
  required(config);
  const encrypted = await config.readAnchor(ctx.workspaceId);
  if (encrypted === null) return null;
  const prior = decodeAuditAnchor(
    encrypted,
    config.key,
    config.signingKey,
    ctx.workspaceId,
  );
  if (BigInt(prior.head.sequence) > BigInt(current.sequence))
    throw Error("AUDIT_ANCHOR_TRUNCATION");
  if (
    (await auditHashAt(db, ctx.workspaceId, prior.head.sequence, config)) !==
    prior.head.hash
  )
    throw Error("AUDIT_ANCHOR_MISMATCH");
  return { encrypted, anchor: prior };
}
export async function prepareAuditAnchorOnClient(
  service: OperationsService,
  ctx: Context,
  db: PoolClient,
  config: AuditHeadStore,
  headOnly = false,
) {
  required(config);
  await service.authorize(db, ctx, "data.export");
  const state = await verifyArchiveHistoryOnClient(service, ctx, db, config),
    prior = await priorHead(db, ctx, config, state.head);
  let rows: AuditRow[] | undefined;
  if (!headOnly) {
    rows = (
      await db.query(
        "SELECT sequence,event,previous_hash,hash FROM operations_audit_chain WHERE workspace_id=$1 ORDER BY sequence LIMIT 10001",
        [ctx.workspaceId],
      )
    ).rows as AuditRow[];
    if (rows.length > 10000) throw Error("AUDIT_EXPORT_LIMIT_REQUIRES_ARCHIVE");
  }
  const payload: AuditAnchor = {
    version: 2,
    type: headOnly ? "audit-head" : "audit-anchor",
    workspaceId: ctx.workspaceId,
    checkpoint: state.checkpoint,
    head: state.head,
    previousHead: prior?.anchor.head ?? null,
    ...(rows ? { rows } : {}),
    actorHash: createHash("sha256").update(ctx.principalId).digest("hex"),
  };
  return {
    encrypted: sealExport(payload, config.key, config.signingKey),
    head: payload.head,
    checkpoint: payload.checkpoint,
    count: rows?.length ?? 0,
  };
}
/** Caller holds workspace row lock; callback atomically CAS/persists HEAD and never starts a nested app transaction. */
export async function commitAuditAnchorOnClient(
  service: OperationsService,
  ctx: Context,
  db: PoolClient,
  encrypted: string,
  config: AuditHeadStore,
) {
  required(config);
  await service.authorize(db, ctx, "data.export");
  const candidate = decodeAuditAnchor(
      encrypted,
      config.key,
      config.signingKey,
      ctx.workspaceId,
    ),
    state = await verifyArchiveHistoryOnClient(service, ctx, db, config),
    raw = await config.readAnchor(ctx.workspaceId),
    known =
      raw === null
        ? null
        : decodeAuditAnchor(
            raw,
            config.key,
            config.signingKey,
            ctx.workspaceId,
          );
  if (known && BigInt(candidate.head.sequence) < BigInt(known.head.sequence))
    throw Error("AUDIT_ANCHOR_STALE");
  await priorHead(db, ctx, config, state.head);
  if (
    BigInt(candidate.head.sequence) > BigInt(state.head.sequence) ||
    (await auditHashAt(
      db,
      ctx.workspaceId,
      candidate.head.sequence,
      config,
    )) !== candidate.head.hash ||
    (await auditHashAt(
      db,
      ctx.workspaceId,
      candidate.checkpoint.sequence,
      config,
    )) !== candidate.checkpoint.hash
  )
    throw Error("AUDIT_ANCHOR_CANDIDATE_MISMATCH");
  const payload = {
      ...candidate,
      previousHead: known?.head ?? null,
      actorHash: createHash("sha256").update(ctx.principalId).digest("hex"),
    },
    body = sealExport(payload, config.key, config.signingKey),
    name = `audit-${ctx.workspaceId}-${Date.now()}-${randomUUID()}.akh-backup`;
  await config.anchor(name, body, async (work) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))", [
      ctx.workspaceId,
      AUDIT_HEAD_FENCE_SEED,
    ]);
    return work();
  });
  const stored = await config.readAnchor(ctx.workspaceId);
  if (stored === null) throw Error("AUDIT_HEAD_COMMIT_NOT_ACKNOWLEDGED");
  const acknowledged = decodeAuditAnchor(
    stored,
    config.key,
    config.signingKey,
    ctx.workspaceId,
  );
  if (
    acknowledged.head.sequence !== candidate.head.sequence ||
    acknowledged.head.hash !== candidate.head.hash
  )
    throw Error("AUDIT_HEAD_COMMIT_NOT_ACKNOWLEDGED");
  return {
    encrypted: stored,
    anchored: true,
    head: acknowledged.head,
    checkpoint: acknowledged.checkpoint,
    count: acknowledged.rows?.length ?? 0,
  };
}
export async function prepareAuditAnchor(
  service: OperationsService,
  ctx: Context,
  config: AuditHeadStore,
) {
  return service.withAdminTransaction(ctx, (db) =>
    prepareAuditAnchorOnClient(service, ctx, db, config),
  );
}
export async function commitAuditAnchor(
  service: OperationsService,
  ctx: Context,
  encrypted: string,
  config: AuditHeadStore,
) {
  return service.withAdminTransaction(ctx, (db) =>
    commitAuditAnchorOnClient(service, ctx, db, encrypted, config),
  );
}
export async function exportAuditAnchor(
  service: OperationsService,
  ctx: Context,
  config: AuditHeadStore,
) {
  return service.withAdminTransaction(ctx, async (db) => {
    const prepared = await prepareAuditAnchorOnClient(service, ctx, db, config);
    return commitAuditAnchorOnClient(
      service,
      ctx,
      db,
      prepared.encrypted,
      config,
    );
  });
}
export async function verifyAuditAnchorHistory(
  service: OperationsService,
  ctx: Context,
  config: AuditHeadStore,
) {
  return service.withAdminTransaction(ctx, async (db) => {
    const verified = await prepareAuditAnchorOnClient(
      service,
      ctx,
      db,
      config,
      true,
    );
    return {
      verified: true,
      head: verified.head,
      checkpoint: verified.checkpoint,
    };
  });
}
