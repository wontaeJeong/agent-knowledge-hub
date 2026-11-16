import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { PoolClient } from "pg";
import type { Role } from "../../src/domain/types";
import type { Context } from "../service";
type DB = Pick<PoolClient, "query">;
/** Snapshot only proves prior membership; current DB state and fresh subject still narrow it. */
export async function legacyVerifiedRole(
  db: DB,
  workspaceId: string,
  principalId: string,
  issuer: string,
  subject: string,
): Promise<Role | null> {
  if (
    createHash("sha256")
      .update(issuer + "\0" + subject)
      .digest("hex") !== principalId
  )
    return null;
  const r = await db.query(
    `SELECT b.role FROM legacy_compat_memberships b
    JOIN memberships m ON m.workspace_id=b.workspace_id AND m.principal_id=b.principal_id AND m.role=b.role
    JOIN access_principals p ON p.id=b.principal_id AND p.active AND p.kind='human' AND p.issuer=$3 AND p.subject=$4
    WHERE b.workspace_id=$1 AND b.principal_id=$2 AND b.subject=$4 AND NOT b.revoked
    AND NOT EXISTS(SELECT 1 FROM access_spaces s WHERE s.workspace_id=b.workspace_id) FOR SHARE OF b,m,p`,
    [workspaceId, principalId, issuer, subject],
  );
  return r.rows[0]?.role ?? null;
}
export async function legacySessionRole(
  db: DB,
  ctx: Context,
  sessionId?: string,
): Promise<Role | null> {
  if (ctx.agent) return null;
  if (ctx.credentialId) {
    const g = await db.query(
      "SELECT g.parent_session_id FROM runtime_execution_grants g JOIN access_credentials c ON c.id=g.credential_id AND NOT c.revoked AND c.expires_at>clock_timestamp() WHERE g.credential_id=$1 AND g.workspace_id=$2 AND g.principal_id=$3 AND NOT g.revoked AND g.expires_at>clock_timestamp() AND g.parent_credential_id IS NULL AND g.parent_session_id IS NOT NULL",
      [ctx.credentialId, ctx.workspaceId, ctx.principalId],
    );
    sessionId = g.rows[0]?.parent_session_id;
  }
  if (!sessionId || !/^[a-f0-9]{64}$/.test(sessionId)) return null;
  // The authenticated caller or job authority already checks its configured
  // session policy; this query additionally requires the recent verified proof.
  const r = await db.query(
    `SELECT s.subject,s.legacy_role_ceiling,p.issuer FROM runtime_sessions s JOIN access_principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
    JOIN identity_session_activity a ON a.session_id=s.id WHERE s.id=$1 AND s.principal_id=$2 AND s.expires_at>clock_timestamp() AND s.legacy_verified_at>clock_timestamp()-interval '30 seconds' FOR SHARE OF s,p`,
    [sessionId, ctx.principalId],
  );
  const row = r.rows[0];
  if (!row?.issuer || !row.legacy_role_ceiling) return null;
  const captured = await legacyVerifiedRole(
    db,
    ctx.workspaceId,
    ctx.principalId,
    row.issuer,
    row.subject,
  );
  if (!captured) return null;
  const order: Role[] = ["reader", "editor", "reviewer"];
  return (
    order[
      Math.min(order.indexOf(captured), order.indexOf(row.legacy_role_ceiling))
    ] ?? null
  );
}
/** DB-only historical actor recheck for an existing proposal/approval; never opens a request session. */
export async function legacyStoredRole(
  db:DB, workspaceId:string, principalId:string, verifiedIssuer?:string,
):Promise<Role|null>{
  const row=(await db.query(`SELECT p.issuer,p.subject,b.subject AS captured_subject,b.role
    FROM access_principals p JOIN legacy_compat_memberships b ON b.principal_id=p.id AND b.workspace_id=$1 AND NOT b.revoked
    JOIN memberships m ON m.workspace_id=b.workspace_id AND m.principal_id=b.principal_id AND m.role=b.role
    WHERE p.id=$2 AND p.active AND p.kind='human' AND NOT EXISTS(SELECT 1 FROM access_spaces s WHERE s.workspace_id=b.workspace_id)
    FOR SHARE OF p,b,m`,[workspaceId,principalId])).rows[0];
  if(!row)return null;
  const issuer=row.issuer ?? verifiedIssuer;
  if(!issuer || (row.issuer && row.subject!==row.captured_subject))return null;
  if(createHash('sha256').update(issuer+'\0'+row.captured_subject).digest('hex')!==principalId)return null;
  return row.role;
}

/** Offline operator command: signature authenticates a historical-backup attestation, not the backup's independent truth. */
export async function importLegacyManifest(
  pool: Pool,
  bytes: Buffer,
  signature: Buffer,
  pinnedPublicKey: string,
  expectedInstallationId: string,
): Promise<{ imported: number }> {
  const reject = () => {
    throw Error("LEGACY_MANIFEST_INVALID");
  };
  if (
    bytes.length < 2 ||
    bytes.length > 1000000 ||
    signature.length !== 64 ||
    pinnedPublicKey.length > 10000
  )
    return reject();
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pinnedPublicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, bytes, key, signature)
    )
      return reject();
  } catch {
    return reject();
  }
  const schema = z
    .object({
      version: z.literal(1),
      statement: z.literal("pre-010-backup"),
      installationId: z.uuid(),
      backupHash: z.string().regex(/^[a-f0-9]{64}$/),
      capturedAt: z.iso.datetime(),
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      entries: z
        .array(
          z
            .object({
              workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
              principalId: z.string().regex(/^[a-f0-9]{64}$/),
              role: z.enum(["reader", "editor", "reviewer"]),
              issuer: z.url().max(1000),
              subject: z.string().min(1).max(500),
            })
            .strict(),
        )
        .min(1)
        .max(1000),
    })
    .strict();
  let manifest: z.infer<typeof schema>;
  try {
    manifest = schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return reject();
  }
  const now = Date.now(),
    issued = Date.parse(manifest.issuedAt),
    expires = Date.parse(manifest.expiresAt),
    captured = Date.parse(manifest.capturedAt);
  if (
    captured > issued ||
    issued > now + 5000 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 7 * 86400000
  )
    return reject();
  const entries = new Set(
    manifest.entries.map((e) => e.workspaceId + "\0" + e.principalId),
  );
  if (entries.size !== manifest.entries.length) return reject();
  const fingerprint = createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "LOCK TABLE memberships,access_principals,access_spaces,legacy_compat_memberships IN SHARE ROW EXCLUSIVE MODE",
    );
    const installation = (
      await db.query(
        "SELECT installation_id,import_key_fingerprint FROM legacy_compat_installation WHERE singleton=true FOR UPDATE",
      )
    ).rows[0];
    if (
      !installation ||
      installation.installation_id !== expectedInstallationId ||
      installation.installation_id !== manifest.installationId ||
      (installation.import_key_fingerprint &&
        installation.import_key_fingerprint !== fingerprint)
    )
      return reject();
    if (
      !(
        await db.query(
          "SELECT to_regclass('legacy_v1_identity_subjects') AS found",
        )
      ).rows[0].found
    )
      return reject();
    let imported = 0;
    for (const e of manifest.entries) {
      const issuer = new URL(e.issuer);
      if (
        issuer.protocol !== "https:" ||
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash ||
        createHash("sha256")
          .update(e.issuer + "\0" + e.subject)
          .digest("hex") !== e.principalId
      )
        return reject();
      const eligible = await db.query(
        `SELECT 1 FROM memberships m JOIN access_principals p ON p.id=m.principal_id AND p.active AND p.kind='human'
        JOIN legacy_v1_access_principals old ON old.id=m.principal_id AND old.enabled
        JOIN legacy_v1_identity_subjects sub ON sub.principal_id=m.principal_id AND sub.subject=$4
        WHERE m.workspace_id=$1 AND m.principal_id=$2 AND m.role=$3 AND (p.issuer IS NULL OR (p.issuer=$5 AND p.subject=$4))
        AND NOT EXISTS(SELECT 1 FROM access_spaces s WHERE s.workspace_id=m.workspace_id)`,
        [e.workspaceId, e.principalId, e.role, e.subject, e.issuer],
      );
      if (!eligible.rowCount) return reject();
      const existing = (
        await db.query(
          "SELECT role,subject,revoked FROM legacy_compat_memberships WHERE workspace_id=$1 AND principal_id=$2 FOR UPDATE",
          [e.workspaceId, e.principalId],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.revoked ||
          existing.role !== e.role ||
          existing.subject !== e.subject
        )
          return reject();
        continue;
      }
      await db.query(
        "INSERT INTO legacy_compat_memberships(workspace_id,principal_id,role,subject) VALUES($1,$2,$3,$4)",
        [e.workspaceId, e.principalId, e.role, e.subject],
      );
      imported++;
    }
    await db.query(
      "UPDATE legacy_compat_installation SET import_key_fingerprint=coalesce(import_key_fingerprint,$1) WHERE singleton=true",
      [fingerprint],
    );
    await db.query(
      "INSERT INTO legacy_compat_manifest_imports(manifest_hash,backup_hash,key_fingerprint,captured_at,issued_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        manifestHash,
        manifest.backupHash,
        fingerprint,
        manifest.capturedAt,
        manifest.issuedAt,
      ],
    );
    await db.query("COMMIT");
    return { imported };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
