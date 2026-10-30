import { createHash, randomUUID } from "node:crypto";
import type { Context } from "../service";
import type { PoolClient } from "pg";
import {
  sealExport,
  openExport,
  verifyAudit,
  authorizeAuditResources,
  type AuditRow,
  type OperationsService,
} from "./service";
import {
  prepareAuditAnchorOnClient,
  commitAuditAnchorOnClient,
  type AuditHeadStore,
} from "./audit-protocol";
export interface AuditArchiveTarget {
  put: (name: string, body: string) => Promise<unknown>;
  get: (name: string) => Promise<string>;
  list?: () => Promise<{ name: string }[]>;
}
interface Segment {
  version: 1;
  workspaceId: string;
  firstSequence: string;
  lastSequence: string;
  previousHash: string;
  headHash: string;
  rows: AuditRow[];
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function verifyArchivedSegment(
  encrypted: string,
  key: string,
  signingKey: string,
  receipt: {
    workspace_id: string;
    first_sequence: string;
    last_sequence: string;
    previous_hash: string;
    head_hash: string;
    encrypted_hash: string;
  },
) {
  const d = openExport(encrypted, key, signingKey) as Segment;
  return (
    digest(encrypted) === receipt.encrypted_hash &&
    d.version === 1 &&
    d.workspaceId === receipt.workspace_id &&
    d.firstSequence === receipt.first_sequence &&
    d.lastSequence === receipt.last_sequence &&
    d.previousHash === receipt.previous_hash &&
    d.headHash === receipt.head_hash &&
    d.rows.length > 0 &&
    d.rows[0].sequence === d.firstSequence &&
    d.rows.at(-1)?.sequence === d.lastSequence &&
    d.rows.at(-1)?.hash === d.headHash &&
    verifyAudit(d.rows, {
      sequence: (BigInt(d.firstSequence) - 1n).toString(),
      hash: d.previousHash,
    })
  );
}
/** Bounded export/read-back-authenticate, immutable receipt, THEN scoped hot pruning in one DB transaction. */
export async function archiveAudit(
  service: OperationsService,
  ctx: Context,
  config: {
    target: AuditArchiveTarget;
    key: string;
    signingKey: string;
    batchSize?: number;
    confirm: string;
    readAnchor: AuditHeadStore["readAnchor"];
    anchor: AuditHeadStore["anchor"];
    includeUnexpired?: boolean;
  },
) {
  const size = config.batchSize ?? 1000;
  if (
    typeof config.readAnchor !== "function" ||
    typeof config.anchor !== "function"
  )
    throw Error("AUDIT_INDEPENDENT_HEAD_STORE_REQUIRED");
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 1000 ||
    config.confirm !==
      (config.includeUnexpired
        ? "ARCHIVE_ACTIVE_AUDIT"
        : "ARCHIVE_AND_PRUNE_EXPIRED_AUDIT")
  )
    throw Error("ARCHIVE_CONFIRMATION_REQUIRED");
  let archived = 0,
    segments = 0;
  await verifyArchiveHistory(service, ctx, config);
  for (;;) {
    const n = await service.withAdminTransaction(ctx, async (db) => {
      await service.authorize(db, ctx, "data.export");
      const commitment = await prepareAuditAnchorOnClient(
        service,
        ctx,
        db,
        config,
        true,
      );
      const days =
        (
          await db.query(
            "SELECT audit_days FROM operations_policy WHERE workspace_id=$1",
            [ctx.workspaceId],
          )
        ).rows[0]?.audit_days ?? 365;
      const checkpoint = (
        await db.query(
          "SELECT last_sequence AS sequence,head_hash AS hash FROM operations_audit_archives WHERE workspace_id=$1 ORDER BY last_sequence DESC LIMIT 1",
          [ctx.workspaceId],
        )
      ).rows[0];
      const candidates = (
        await db.query(
          "SELECT sequence,event,previous_hash,hash,created_at FROM operations_audit_chain WHERE workspace_id=$1 ORDER BY sequence LIMIT $2",
          [ctx.workspaceId, size],
        )
      ).rows;
      const cutoff = Date.now() - days * 86400000,
        rows: AuditRow[] = [];
      for (const { created_at, ...row } of candidates) {
        if (!config.includeUnexpired && new Date(created_at).getTime() > cutoff)
          break;
        rows.push(row as AuditRow);
      }
      if (!rows.length) return 0;
      if (!verifyAudit(rows, checkpoint)) throw Error("AUDIT_TAMPER_DETECTED");
      await authorizeAuditResources(db, ctx, rows, service.authorize);
      const first = rows[0],
        last = rows.at(-1)!,
        segment: Segment = {
          version: 1,
          workspaceId: ctx.workspaceId,
          firstSequence: first.sequence,
          lastSequence: last.sequence,
          previousHash: first.previous_hash,
          headHash: last.hash,
          rows,
        };
      const encrypted = sealExport(segment, config.key, config.signingKey),
        name = `audit-${ctx.workspaceId}-${first.sequence}-${last.sequence}-${digest(encrypted).slice(0, 16)}.akh-backup`;
      await config.target.put(name, encrypted);
      const returned = await config.target.get(name),
        receipt = {
          workspace_id: ctx.workspaceId,
          first_sequence: first.sequence,
          last_sequence: last.sequence,
          previous_hash: first.previous_hash,
          head_hash: last.hash,
          encrypted_hash: digest(encrypted),
        };
      if (
        !verifyArchivedSegment(returned, config.key, config.signingKey, receipt)
      )
        throw Error("AUDIT_ARCHIVE_TARGET_TAMPERED");
      await commitAuditAnchorOnClient(
        service,
        ctx,
        db,
        commitment.encrypted,
        config,
      );
      await db.query(
        "INSERT INTO operations_audit_archives(workspace_id,id,first_sequence,last_sequence,previous_hash,head_hash,target_name,encrypted_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          ctx.workspaceId,
          randomUUID(),
          first.sequence,
          last.sequence,
          first.previous_hash,
          last.hash,
          name,
          receipt.encrypted_hash,
        ],
      );
      await db.query(
        "DELETE FROM operations_audit_chain WHERE workspace_id=$1 AND sequence BETWEEN $2 AND $3",
        [ctx.workspaceId, first.sequence, last.sequence],
      );
      return rows.length;
    });
    if (!n) break;
    archived += n;
    segments++;
  }
  return { archived, segments };
}
export async function auditArchives(
  service: OperationsService,
  ctx: Context,
  offset = 0,
) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw Error("INVALID_OFFSET");
  return service.withAdminTransaction(ctx, async (db) => ({
    items: (
      await db.query(
        "SELECT id,first_sequence,last_sequence,previous_hash,head_hash,target_name,encrypted_hash,archived_at FROM operations_audit_archives WHERE workspace_id=$1 ORDER BY first_sequence LIMIT 25 OFFSET $2",
        [ctx.workspaceId, offset],
      )
    ).rows,
    nextOffset: offset + 25,
  }));
}
export async function verifyArchiveHistory(
  service: OperationsService,
  ctx: Context,
  config: { target: AuditArchiveTarget; key: string; signingKey: string },
) {
  return service.withAdminTransaction(ctx, (db) =>
    verifyArchiveHistoryOnClient(service, ctx, db, config),
  );
}
export async function verifyArchiveHistoryOnClient(
  service: OperationsService,
  ctx: Context,
  db: PoolClient,
  config: { target: AuditArchiveTarget; key: string; signingKey: string },
) {
  const seen = new Set<string>();
  let checkpoint = { sequence: "0", hash: "0".repeat(64) };
  const receipts = (
    await db.query(
      "SELECT * FROM operations_audit_archives WHERE workspace_id=$1 ORDER BY first_sequence",
      [ctx.workspaceId],
    )
  ).rows;
  if (!config.target.list)
    throw Error("AUDIT_INDEPENDENT_HISTORY_LIST_REQUIRED");
  const external = await config.target.list();
  if (external.length > 100000) throw Error("AUDIT_ARCHIVE_INDEX_BOUND");
  const receiptNames = new Set(receipts.map((r) => r.target_name));
  const prefix = `audit-${ctx.workspaceId}-`;
  for (const entry of external) {
    if (
      !entry.name.startsWith(prefix) ||
      !/^\d+-\d+-[a-f0-9]{16}\.akh-backup$/.test(
        entry.name.slice(prefix.length),
      ) ||
      receiptNames.has(entry.name)
    )
      continue;
    const raw = await config.target.get(entry.name),
      d = openExport(raw, config.key, config.signingKey) as Segment;
    if (
      d.version !== 1 ||
      d.workspaceId !== ctx.workspaceId ||
      !verifyArchivedSegment(raw, config.key, config.signingKey, {
        workspace_id: ctx.workspaceId,
        first_sequence: d.firstSequence,
        last_sequence: d.lastSequence,
        previous_hash: d.previousHash,
        head_hash: d.headHash,
        encrypted_hash: digest(raw),
      })
    )
      throw Error("AUDIT_EXTERNAL_ANCHOR_INVALID");
    const overlapping = (
      await db.query(
        "SELECT hash FROM operations_audit_chain WHERE workspace_id=$1 AND sequence=$2",
        [ctx.workspaceId, d.lastSequence],
      )
    ).rows[0];
    const archived = (
      await db.query(
        "SELECT head_hash FROM operations_audit_archives WHERE workspace_id=$1 AND last_sequence=$2",
        [ctx.workspaceId, d.lastSequence],
      )
    ).rows[0];
    if ((overlapping?.hash ?? archived?.head_hash) !== d.headHash)
      throw Error("AUDIT_EXTERNAL_HISTORY_MISSING_FROM_DATABASE");
    await authorizeAuditResources(db, ctx, d.rows, service.authorize, seen);
  }
  for (const receipt of receipts) {
    const encrypted = await config.target.get(receipt.target_name);
    if (
      BigInt(receipt.first_sequence) !== BigInt(checkpoint.sequence) + 1n ||
      receipt.previous_hash !== checkpoint.hash ||
      !verifyArchivedSegment(encrypted, config.key, config.signingKey, receipt)
    )
      throw Error("AUDIT_ARCHIVE_ROOT_MISMATCH");
    checkpoint = { sequence: receipt.last_sequence, hash: receipt.head_hash };
    await authorizeAuditResources(
      db,
      ctx,
      (openExport(encrypted, config.key, config.signingKey) as Segment).rows,
      service.authorize,
      seen,
    );
  }
  const archivedCheckpoint = { ...checkpoint };
  for (;;) {
    const rows = (
      await db.query(
        "SELECT sequence,event,previous_hash,hash FROM operations_audit_chain WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1000",
        [ctx.workspaceId, checkpoint.sequence],
      )
    ).rows as AuditRow[];
    if (!verifyAudit(rows, checkpoint)) throw Error("AUDIT_TAMPER_DETECTED");
    await authorizeAuditResources(db, ctx, rows, service.authorize, seen);
    if (!rows.length) break;
    const last = rows.at(-1)!;
    checkpoint = { sequence: last.sequence, hash: last.hash };
    if (rows.length < 1000) break;
  }
  return {
    verified: true,
    segments: receipts.length,
    rootHash: checkpoint.hash,
    checkpoint: archivedCheckpoint,
    head: { ...checkpoint },
  };
}
export async function auditHashAt(
  db: PoolClient,
  workspaceId: string,
  sequence: string,
  config: { target: AuditArchiveTarget; key: string; signingKey: string },
) {
  if (sequence === "0") return "0".repeat(64);
  const hot = (
    await db.query(
      "SELECT hash FROM operations_audit_chain WHERE workspace_id=$1 AND sequence=$2",
      [workspaceId, sequence],
    )
  ).rows[0];
  if (hot) return hot.hash as string;
  const receipt = (
    await db.query(
      "SELECT * FROM operations_audit_archives WHERE workspace_id=$1 AND first_sequence<=$2 AND last_sequence>=$2 LIMIT 1",
      [workspaceId, sequence],
    )
  ).rows[0];
  if (!receipt) throw Error("AUDIT_ANCHOR_HISTORY_MISSING");
  const encrypted = await config.target.get(receipt.target_name);
  if (!verifyArchivedSegment(encrypted, config.key, config.signingKey, receipt))
    throw Error("AUDIT_ARCHIVE_ROOT_MISMATCH");
  const segment = openExport(
    encrypted,
    config.key,
    config.signingKey,
  ) as Segment;
  const row = segment.rows.find((r) => r.sequence === sequence);
  if (!row) throw Error("AUDIT_ANCHOR_HISTORY_MISSING");
  return row.hash;
}
