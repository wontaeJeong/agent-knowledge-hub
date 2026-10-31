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
import { hashHasLiveReference } from "../../scripts/k8s/operations-storage-graph.mjs";
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
/** Canonical authorization, including EVERY historical page version and its complete input ancestry. */
export async function authorizeAuditResources(
  db: PoolClient,
  ctx: Context,
  rows: AuditRow[],
  authorize: WorkflowAuthorizer,
  seen = new Set<string>(),
) {
  for (const row of rows) {
    const r = (row.event as { resource?: WorkflowResource }).resource;
    if (!r || seen.has(`${r.kind}:${r.id}`)) continue;
    seen.add(`${r.kind}:${r.id}`);
    await authorize(db, ctx, "knowledge.read", r);
    await authorize(db, ctx, "data.export", r);
    if (r.kind === "page")
      for (const v of (
        await db.query(
          "SELECT number FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number",
          [ctx.workspaceId, r.id],
        )
      ).rows) {
        const historical = { ...r, version: v.number };
        await authorize(db, ctx, "knowledge.read", historical);
        await authorize(db, ctx, "data.export", historical);
      }
  }
}
export function verifyAudit(
  rows: AuditRow[],
  checkpoint?: { sequence: string; hash: string },
): boolean {
  let previous = checkpoint?.hash ?? "0".repeat(64),
    sequence = BigInt(checkpoint?.sequence ?? 0);
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
        "SELECT sequence,hash FROM (SELECT sequence,hash FROM operations_audit_chain WHERE workspace_id=$1 UNION ALL SELECT last_sequence AS sequence,head_hash AS hash FROM operations_audit_archives WHERE workspace_id=$1) s ORDER BY sequence DESC LIMIT 1",
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
  /** Trusted server orchestration only; no SQL/function/path input is exposed through HTTP. */
  async withAdminTransaction<T>(
    ctx: Context,
    work: (db: PoolClient) => Promise<T>,
    exclusive = false,
  ) {
    return this.run(ctx, "space.admin", undefined, work, exclusive);
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
  async status(ctx: Context) {
    return this.withAdminTransaction(ctx, async (db) => {
      const row = (
        await db.query(
          "SELECT (SELECT max(completed_at) FROM operations_backups WHERE status='complete') AS last_backup,(SELECT count(*) FROM durable_jobs WHERE workspace_id=$1 AND status IN('queued','running','cancel_requested'))::text AS queue_depth,(SELECT sum(size) FROM storage_blobs WHERE workspace_id=$1) AS blob_bytes",
          [ctx.workspaceId],
        )
      ).rows[0];
      let importDepth = 0;
      if (
        (await db.query("SELECT to_regclass('public.import_runs') AS t"))
          .rows[0].t
      )
        importDepth = Number(
          (
            await db.query(
              "SELECT count(*)::text AS n FROM import_runs WHERE workspace_id=$1 AND status IN('queued','running')",
              [ctx.workspaceId],
            )
          ).rows[0].n,
        );
      return {
        lastBackup: row.last_backup,
        queueDepth: Number(row.queue_depth) + importDepth,
        blobBytes: row.blob_bytes === null ? null : Number(row.blob_bytes),
      };
    });
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
      const checkpoint = (
        await db.query(
          "SELECT last_sequence AS sequence,head_hash AS hash FROM operations_audit_archives WHERE workspace_id=$1 ORDER BY last_sequence DESC LIMIT 1",
          [ctx.workspaceId],
        )
      ).rows[0];
      if (!verifyAudit(rows, checkpoint)) throw Error("AUDIT_TAMPER_DETECTED");
      await authorizeAuditResources(db, ctx, rows, this.authorize);
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
    if (d.deleteContent) throw Error("ERASURE_PREVIEW_REQUIRED");
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
            "SELECT * FROM operations_tombstones WHERE workspace_id=$1 AND approved_by=$2 ORDER BY created_at,id",
            [ctx.workspaceId, ctx.principalId],
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
            "SELECT DISTINCT value AS sha256 FROM operations_tombstones t CROSS JOIN LATERAL jsonb_array_elements_text(t.blob_hashes) WHERE t.workspace_id=$1 AND t.approved_by=$2 AND t.delete_content UNION SELECT DISTINCT value AS sha256 FROM operations_erased_artifacts a CROSS JOIN LATERAL jsonb_array_elements_text(a.hashes) WHERE a.workspace_id=$1 AND a.approved_by=$2",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows;
        let removed = 0;
        for (const { sha256 } of candidates) {
          if (await hashHasLiveReference(db, sha256)) continue;
          // Exclusive global gate also prevents a new deduplicated reference racing physical removal.
          await remove(sha256); // irreversible ONLY after a committed, explicit tombstone approval.
          // Keep immutable metadata/FK history as the deletion receipt; content is inaccessible.
          // Backup manifests exclude explicitly deleted parent references, so erased bytes are not required.
          removed++;
        }
        const finalized: { id: string; previewHash: string }[] = [];
        const pending = (
          await db.query(
            "SELECT * FROM operations_erasure_receipts WHERE workspace_id=$1 AND approved_by=$2 AND status='blocked' AND error_code IN('PHYSICAL_BLOB_PURGE_REQUIRED','SHARED_LIVE_BLOB_RETAINED') AND coalesce((counts->>'unresolved_unlineaged_rows')::integer,0)=0 ORDER BY created_at",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows;
        for (const receipt of pending) {
          const hashes = (
            await db.query(
              "SELECT DISTINCT value AS hash FROM operations_tombstones t CROSS JOIN LATERAL jsonb_array_elements_text(t.blob_hashes) WHERE t.workspace_id=$1 AND t.approved_by=$2 AND t.delete_content AND t.created_at=(SELECT created_at FROM operations_erasure_receipts WHERE workspace_id=$1 AND id=$3) UNION SELECT DISTINCT value AS hash FROM operations_erased_artifacts a CROSS JOIN LATERAL jsonb_array_elements_text(a.hashes) WHERE a.workspace_id=$1 AND a.approved_by=$2 AND a.preview_hash=$4",
              [
                ctx.workspaceId,
                ctx.principalId,
                receipt.id,
                receipt.preview_hash,
              ],
            )
          ).rows;
          if (
            !hashes.length ||
            hashes.length !== receipt.counts.pending_blob_hashes
          )
            continue;
          let live = false;
          for (const { hash } of hashes)
            if (await hashHasLiveReference(db, hash)) {
              live = true;
              break;
            }
          if (live) continue;
          if (
            (
              await db.query(
                "SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND preview_hash=$2 AND status='completed' LIMIT 1",
                [ctx.workspaceId, receipt.preview_hash],
              )
            ).rowCount
          )
            continue;
          const id = randomUUID(),
            counts = {
              ...receipt.counts,
              pending_blob_hashes: 0,
              shared_live_blob_hashes: 0,
              physically_absent_hashes: hashes.length,
            };
          await db.query(
            "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,resource_kind,resource_id,approved_by,status,counts) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8)",
            [
              ctx.workspaceId,
              id,
              receipt.preview_hash,
              receipt.scope,
              receipt.resource_kind,
              receipt.resource_id,
              ctx.principalId,
              JSON.stringify(counts),
            ],
          );
          finalized.push({ id, previewHash: receipt.preview_hash });
        }
        await this.append(db, ctx, { operation: "content.blob-purge" });
        return { removed, finalized, allCopiesErased: false };
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
