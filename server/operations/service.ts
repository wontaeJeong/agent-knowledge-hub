import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../database";
import type { Context } from "../service";
import type {
  WorkflowAuthorizer,
  WorkflowResource,
} from "../workflows/service";
import { membership, requireRead } from "../repository";
import { MUTATION_GATE } from "./gate";
export { MUTATION_GATE } from "./gate";
const resourceSchema = z
  .object({
    kind: z.enum(["source", "page"]),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  })
  .strict();
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function canonical(v: unknown): string {
  if (Array.isArray(v))
    return `[${v.map((value) => (value === undefined ? "null" : canonical(value))).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export interface AuditRow {
  sequence: string;
  event: unknown;
  previous_hash: string;
  hash: string;
}
export function verifyAudit(rows: AuditRow[]): boolean {
  let previous = "0".repeat(64),
    sequence = 0n;
  for (const row of rows) {
    sequence++;
    if (
      BigInt(row.sequence) !== sequence ||
      row.previous_hash !== previous ||
      row.hash !== hash(`${previous}\n${row.sequence}\n${canonical(row.event)}`)
    )
      return false;
    previous = row.hash;
  }
  return true;
}
export function verifyAuditAnchor(
  rows: AuditRow[],
  encrypted: string,
  key: string,
  signingKey: string,
) {
  const anchored = openExport(encrypted, key, signingKey) as AuditRow[];
  if (
    !Array.isArray(anchored) ||
    !verifyAudit(anchored) ||
    !verifyAudit(rows) ||
    rows.length < anchored.length
  )
    return false;
  return anchored.every((r, i) => r.hash === rows[i].hash);
}
/** Call from repository.audit inside its transaction. Only bounded metadata, never raw source/model content. */
export async function appendOperationalAudit(
  db: PoolClient,
  ctx: Context,
  event: { operation: string; resource?: WorkflowResource },
) {
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(event.operation))
    throw Error("INVALID_AUDIT_OPERATION");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7203025))", [
    ctx.workspaceId,
  ]);
  const last = (
      await db.query(
        "SELECT sequence,hash FROM operations_audit_chain WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1",
        [ctx.workspaceId],
      )
    ).rows[0],
    sequence = (BigInt(last?.sequence ?? 0) + 1n).toString(),
    previous = last?.hash ?? "0".repeat(64);
  const body = {
    ...event,
    at: new Date().toISOString(),
    actorHash: hash(ctx.principalId),
  };
  await db.query(
    "INSERT INTO operations_audit_chain(workspace_id,sequence,event,previous_hash,hash) VALUES($1,$2,$3,$4,$5)",
    [
      ctx.workspaceId,
      sequence,
      body,
      previous,
      hash(`${previous}\n${sequence}\n${canonical(body)}`),
    ],
  );
}
/** Separate encryption and signing keys; the signed head must be independently anchored to detect truncation/rewrite. */
export function sealExport(
  body: unknown,
  key: string,
  signingKey: string,
): string {
  if (key.length < 32 || signingKey.length < 32 || key === signingKey)
    throw Error("INDEPENDENT_STRONG_KEYS_REQUIRED");
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", scryptSync(key, salt, 32), iv);
  const ciphertext = Buffer.concat([
    cipher.update(canonical(body), "utf8"),
    cipher.final(),
  ]);
  const payload = {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify({
    payload,
    signature: createHmac("sha256", signingKey)
      .update(canonical(payload))
      .digest("hex"),
  });
}
export function openExport(
  envelope: string,
  key: string,
  signingKey: string,
): unknown {
  const { payload, signature } = JSON.parse(envelope),
    expected = createHmac("sha256", signingKey)
      .update(canonical(payload))
      .digest();
  const actual = Buffer.from(signature, "hex");
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    payload.version !== 1
  )
    throw Error("EXPORT_SIGNATURE_INVALID");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(key, Buffer.from(payload.salt, "base64"), 32),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString(),
  );
}
export interface Tombstone {
  workspace_id: string;
  id: string;
  resource_kind: "source" | "page";
  resource_id: string;
  blob_hashes: string[];
  allowed_readers: string[];
  delete_content: boolean;
  approved_by: string;
}
async function applyTombstone(db: PoolClient, t: Tombstone) {
  // Intersection only: restored grants are never used as authority to add readers.
  await db.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND NOT(principal_id=ANY($4::text[]))",
    [t.workspace_id, t.resource_kind, t.resource_id, t.allowed_readers],
  );
  if (t.delete_content) {
    // Quarantine the entire workspace because free-form derived artifacts may retain old content.
    // Reopening requires external deletion review; do not represent this as all-copy physical erasure.
    await db.query("DELETE FROM resource_readers WHERE workspace_id=$1", [
      t.workspace_id,
    ]);
    await db.query(
      "UPDATE sources SET data=jsonb_set(data,'{content}','\"\"'::jsonb) WHERE workspace_id=$1 AND id=$2 AND $3='source'",
      [t.workspace_id, t.resource_id, t.resource_kind],
    );
    await db.query(
      "UPDATE versions SET data=jsonb_set(data,'{content}','\"\"'::jsonb) WHERE workspace_id=$1 AND page_id=$2 AND $3='page'",
      [t.workspace_id, t.resource_id, t.resource_kind],
    );
    await db.query(
      "UPDATE storage_tickets SET revoked=true WHERE workspace_id=$1",
      [t.workspace_id],
    );
  }
}
/** Restore-only trusted orchestration input from a verified current signed ledger, never an HTTP DTO. */
export async function replayTombstones(pool: Pool, records: Tombstone[]) {
  for (const t of records) {
    // A current ledger may include spaces created after this backup was captured.
    if (
      !(
        await pool.query("SELECT 1 FROM workspaces WHERE id=$1", [
          t.workspace_id,
        ])
      ).rowCount
    )
      continue;
    await transaction(pool, t.workspace_id, async (db) => {
      await applyTombstone(db, t);
      await db.query(
        "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [
          t.workspace_id,
          t.id,
          t.resource_kind,
          t.resource_id,
          JSON.stringify(t.blob_hashes),
          JSON.stringify(t.allowed_readers),
          t.delete_content,
          t.approved_by,
        ],
      );
    });
  }
}
export class OperationsService {
  constructor(
    readonly pool: Pool,
    readonly authorize: WorkflowAuthorizer,
    readonly options: { physicalDeletionGateConfirmed?: boolean } = {},
  ) {
    if (typeof authorize !== "function") throw Error("AUTHORIZER_REQUIRED");
  }
  private async run<T>(
    ctx: Context,
    action: string,
    resource: WorkflowResource | undefined,
    work: (db: PoolClient) => Promise<T>,
    exclusive = false,
  ) {
    await ctx.authorization?.revalidate();
    if (exclusive)
      await transaction(this.pool, ctx.workspaceId, async (db) => {
        await membership(db, ctx);
        await ctx.authorization?.assertSession(db);
        await this.authorize(db, ctx, action, resource);
        if (resource) await requireRead(db, ctx, resource.kind, resource.id);
      });
    const db = await this.pool.connect();
    let result: T;
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      await db.query(
        exclusive
          ? "SELECT pg_advisory_xact_lock($1)"
          : "SELECT pg_advisory_xact_lock_shared($1)",
        [MUTATION_GATE],
      );
      if (
        !(
          await db.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
            ctx.workspaceId,
          ])
        ).rowCount
      )
        throw Error("NOT_FOUND");
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action, resource);
      if (resource) await requireRead(db, ctx, resource.kind, resource.id);
      result = await work(db);
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    await ctx.authorization?.revalidate();
    return result;
  }
  async policy(ctx: Context) {
    return this.run(
      ctx,
      "space.admin",
      undefined,
      async (db) =>
        (
          await db.query(
            "SELECT revision,audit_days,telemetry_days,backup_days FROM operations_policy WHERE workspace_id=$1",
            [ctx.workspaceId],
          )
        ).rows[0] ?? {
          revision: 0,
          audit_days: 365,
          telemetry_days: 30,
          backup_days: 30,
        },
    );
  }
  async setPolicy(ctx: Context, input: unknown) {
    const d = z
      .object({
        expectedRevision: z.number().int().min(0),
        auditDays: z.number().int().min(1).max(3650),
        telemetryDays: z.number().int().min(1).max(365),
        backupDays: z.number().int().min(1).max(3650),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "space.admin", undefined, async (db) => {
      const row = await db.query(
        "SELECT revision FROM operations_policy WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      if ((row.rows[0]?.revision ?? 0) !== d.expectedRevision)
        throw Error("STALE_VERSION");
      await db.query(
        "INSERT INTO operations_policy VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,audit_days=excluded.audit_days,telemetry_days=excluded.telemetry_days,backup_days=excluded.backup_days",
        [
          ctx.workspaceId,
          d.expectedRevision + 1,
          d.auditDays,
          d.telemetryDays,
          d.backupDays,
        ],
      );
      await this.append(db, ctx, { operation: "policy.change" });
      return { revision: d.expectedRevision + 1 };
    });
  }
  private async append(
    db: PoolClient,
    ctx: Context,
    event: { operation: string; resource?: WorkflowResource },
  ) {
    await appendOperationalAudit(db, ctx, event);
  }
  async appendAudit(ctx: Context, input: unknown) {
    const d = z
      .object({
        operation: z.string().regex(/^[a-z.]{1,80}$/),
        resource: resourceSchema.optional(),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "space.admin", d.resource, (db) =>
      this.append(db, ctx, d),
    );
  }
  async auditRows(ctx: Context) {
    return this.run(ctx, "data.export", undefined, async (db) => {
      await this.authorize(db, ctx, "space.admin");
      const rows = (
        await db.query(
          "SELECT sequence,event,previous_hash,hash FROM operations_audit_chain WHERE workspace_id=$1 ORDER BY sequence LIMIT 10001",
          [ctx.workspaceId],
        )
      ).rows as AuditRow[];
      if (rows.length > 10000)
        throw Error("AUDIT_EXPORT_LIMIT_REQUIRES_ARCHIVE");
      if (!verifyAudit(rows)) throw Error("AUDIT_TAMPER_DETECTED");
      for (const row of rows) {
        const r = (row.event as { resource?: WorkflowResource }).resource;
        if (r) await requireRead(db, ctx, r.kind, r.id);
      }
      return rows;
    });
  }
  async tombstone(ctx: Context, input: unknown) {
    const d = z
      .object({
        resource: resourceSchema,
        readers: z.array(z.string().min(1).max(200)).max(1000),
        deleteContent: z.boolean(),
        confirm: z.enum(["APPLY", "DELETE_CONTENT_AND_QUARANTINE"]),
      })
      .strict()
      .parse(input);
    if (d.deleteContent && d.confirm !== "DELETE_CONTENT_AND_QUARANTINE")
      throw Error("EXPLICIT_DELETE_CONFIRMATION_REQUIRED");
    return this.run(ctx, "policy.strengthen", d.resource, async (db) => {
      await this.authorize(db, ctx, "space.admin", d.resource);
      const hashes = (
        await db.query(
          "SELECT DISTINCT sha256 FROM storage_blobs WHERE workspace_id=$1 AND parent_kind=$2 AND parent_id=$3",
          [ctx.workspaceId, d.resource.kind, d.resource.id],
        )
      ).rows.map((r) => r.sha256 as string);
      const t: Tombstone = {
        workspace_id: ctx.workspaceId,
        id: randomUUID(),
        resource_kind: d.resource.kind,
        resource_id: d.resource.id,
        blob_hashes: hashes,
        allowed_readers: d.readers,
        delete_content: d.deleteContent,
        approved_by: ctx.principalId,
      };
      await db.query(
        "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          t.workspace_id,
          t.id,
          t.resource_kind,
          t.resource_id,
          JSON.stringify(hashes),
          JSON.stringify(t.allowed_readers),
          t.delete_content,
          t.approved_by,
        ],
      );
      await applyTombstone(db, t);
      await this.append(db, ctx, {
        operation: d.deleteContent ? "content.quarantine" : "access.narrow",
        resource: d.resource,
      });
      return {
        id: t.id,
        quarantined: d.deleteContent,
        physicalErasureComplete: false,
        blobHashes: hashes,
      };
    });
  }
  async tombstones(ctx: Context) {
    return this.run(
      ctx,
      "space.admin",
      undefined,
      async (db) =>
        (
          await db.query(
            "SELECT * FROM operations_tombstones WHERE workspace_id=$1 ORDER BY created_at,id",
            [ctx.workspaceId],
          )
        ).rows as Tombstone[],
    );
  }
  /** Explicit legal deletion follow-up; adapter must be idempotent on missing files. No caller-supplied hash/path. */
  async purgeApprovedBlobs(
    ctx: Context,
    remove: (hash: string) => Promise<void>,
  ) {
    if (!this.options.physicalDeletionGateConfirmed)
      throw Error("BLOB_REFERENCE_GATE_NOT_CONFIRMED");
    return this.run(
      ctx,
      "space.admin",
      undefined,
      async (db) => {
        await this.authorize(db, ctx, "policy.strengthen");
        const candidates = (
          await db.query(
            "SELECT DISTINCT b.sha256 FROM storage_blobs b JOIN operations_tombstones t ON t.workspace_id=b.workspace_id AND t.resource_kind=b.parent_kind AND t.resource_id=b.parent_id AND t.delete_content WHERE t.workspace_id=$1 AND t.approved_by=$2 AND t.blob_hashes ? b.sha256",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows;
        let removed = 0;
        for (const { sha256 } of candidates) {
          const live = await db.query(
            "SELECT 1 FROM storage_blobs b WHERE b.sha256=$1 AND NOT EXISTS(SELECT 1 FROM operations_tombstones t WHERE t.workspace_id=b.workspace_id AND t.resource_kind=b.parent_kind AND t.resource_id=b.parent_id AND t.delete_content AND t.blob_hashes ? b.sha256) LIMIT 1",
            [sha256],
          );
          if (live.rowCount) continue;
          // Exclusive global gate also prevents a new deduplicated reference racing physical removal.
          await remove(sha256); // irreversible ONLY after a committed, explicit tombstone approval.
          // Keep immutable metadata/FK history as the deletion receipt; content is inaccessible.
          // Backup manifests exclude explicitly deleted parent references, so erased bytes are not required.
          removed++;
        }
        await this.append(db, ctx, { operation: "content.blob-purge" });
        return { removed, allCopiesErased: false };
      },
      true,
    );
  }
  async pruneTelemetry(ctx: Context) {
    return this.run(ctx, "space.admin", undefined, async (db) => {
      const p = (
        await db.query(
          "SELECT telemetry_days FROM operations_policy WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows[0];
      if (!p) throw Error("RETENTION_NOT_CONFIGURED");
      const result = await db.query(
        "DELETE FROM usage_events WHERE workspace_id=$1 AND at < now()-($2 * interval '1 day')",
        [ctx.workspaceId, p.telemetry_days],
      );
      await this.append(db, ctx, { operation: "telemetry.retention" });
      return { deleted: result.rowCount };
    });
  }
  async queueAlert(code: string, dedupeKey: string) {
    if (
      !/^[A-Z_]{1,80}$/.test(code) ||
      !/^[-a-zA-Z0-9_:]{1,200}$/.test(dedupeKey)
    )
      throw Error("INVALID_ALERT");
    await this.pool.query(
      "INSERT INTO operations_alert_outbox(id,dedupe_key,code) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING",
      [randomUUID(), dedupeKey, code],
    );
  }
  async deliverAlerts(
    deliver: (alert: { id: string; code: string }) => Promise<void>,
  ) {
    for (let i = 0; i < 25; i++) {
      const db = await this.pool.connect();
      let row;
      try {
        await db.query("BEGIN");
        row = (
          await db.query(
            "SELECT id,code,attempts FROM operations_alert_outbox WHERE (state='pending' AND next_attempt_at<=now()) OR (state='sending' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
          )
        ).rows[0];
        if (row)
          await db.query(
            "UPDATE operations_alert_outbox SET state='sending',lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id=$1",
            [row.id],
          );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      } finally {
        db.release();
      }
      if (!row) break;
      try {
        await deliver({ id: row.id, code: row.code });
        await this.pool.query(
          "UPDATE operations_alert_outbox SET state='sent',delivered_at=now(),lease_until=NULL WHERE id=$1",
          [row.id],
        );
      } catch {
        await this.pool.query(
          "UPDATE operations_alert_outbox SET state='pending',lease_until=NULL,next_attempt_at=now()+($2 * interval '1 second') WHERE id=$1",
          [row.id, Math.min(3600, 2 ** Math.min(row.attempts + 1, 12))],
        );
      }
    }
  }
}
