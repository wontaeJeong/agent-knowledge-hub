import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { MUTATION_GATE, openExport, appendOperationalAudit } from "./service";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
const role = z.enum(["read", "triage", "write", "maintain", "admin"]);
const schema = z
  .object({
    version: z.literal(2),
    collectedAt: z.iso.datetime(),
    maxAgeMs: z.number().int().min(1000).max(900000),
    organization: z
      .object({ id, active: z.literal(true), members: z.array(id).max(100000) })
      .strict(),
    source: z
      .object({ database: id, systemIdentifier: z.string().regex(/^\d+$/) })
      .strict(),
    target: z
      .object({
        database: z.string().regex(/^akh_ops_restore_[a-f0-9]{32}$/),
        systemIdentifier: z.string().regex(/^\d+$/),
      })
      .strict(),
    backup: z
      .object({ id, databaseSha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    operators: z.array(id).min(1).max(100),
    principals: z
      .array(
        z
          .object({
            principalId: id,
            issuer: z.url(),
            subject: z.string().min(1).max(500),
            active: z.boolean(),
            kind: z.literal("human"),
            teamCreate: z.boolean(),
          })
          .strict(),
      )
      .max(100000),
    teams: z
      .array(
        z
          .object({
            id,
            slug: id,
            name: z.string().min(1).max(100),
            members: z
              .array(
                z
                  .object({
                    principalId: id,
                    role: z.enum(["owner", "member"]),
                    active: z.boolean(),
                  })
                  .strict(),
              )
              .max(100000),
          })
          .strict(),
      )
      .max(10000),
    spaces: z
      .array(
        z
          .object({
            workspaceId: id,
            namespaceId: id,
            kind: z.enum(["team", "personal"]),
            slug: id,
            visibility: z.enum(["private", "team", "company"]),
            owners: z.array(id).min(1).max(100),
            grants: z
              .array(z.object({ principalId: id, role }).strict())
              .max(100000),
            reviewers: z
              .array(
                z
                  .object({
                    principalId: id,
                    qualified: z.literal(true),
                    qualifiedAt: z.iso.datetime(),
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
            minimumApprovals: z.number().int().min(1).max(100),
            readers: z
              .array(
                z
                  .object({
                    kind: z.enum(["source", "page"]),
                    id,
                    principalIds: z.array(id).max(100000),
                  })
                  .strict(),
              )
              .max(100000),
            sourceRules: z
              .array(
                z
                  .object({
                    sourceId: id,
                    localCopyAllowed: z.boolean(),
                    exportAllowed: z.boolean(),
                  })
                  .strict(),
              )
              .max(100000)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();
export type CurrentPolicy = z.infer<typeof schema>;
export interface RestoreIdentity {
  source: { database: string; systemIdentifier: string };
  target: { database: string; systemIdentifier: string };
  backup: { id: string; databaseSha256: string };
}
export function readCurrentPolicy(
  encrypted: string,
  key: string,
  signingKey: string,
  expected: RestoreIdentity,
): CurrentPolicy {
  if (key === signingKey || key.length < 32 || signingKey.length < 32)
    throw Error("INDEPENDENT_STRONG_KEYS_REQUIRED");
  const p = schema.parse(openExport(encrypted, key, signingKey)),
    age = Date.now() - Date.parse(p.collectedAt);
  if (age < -60000 || age > p.maxAgeMs) throw Error("CURRENT_POLICY_STALE");
  if (
    JSON.stringify(p.source) !== JSON.stringify(expected.source) ||
    JSON.stringify(p.target) !== JSON.stringify(expected.target) ||
    JSON.stringify(p.backup) !== JSON.stringify(expected.backup)
  )
    throw Error("RECOVERY_IDENTITY_MISMATCH");
  const principals = new Map(p.principals.map((v) => [v.principalId, v]));
  if (
    principals.size !== p.principals.length ||
    new Set(p.spaces.map((v) => v.workspaceId)).size !== p.spaces.length ||
    new Set(p.teams.map((v) => v.id)).size !== p.teams.length
  )
    throw Error("DUPLICATE_CURRENT_AUTHORITY");
  for (const v of p.principals)
    if (v.principalId !== hash(v.issuer + "\0" + v.subject))
      throw Error("UNKNOWN_STABLE_SUBJECT");
  const known = (principalId: string) => {
    const v = principals.get(principalId);
    if (!v || !v.active || !p.organization.members.includes(principalId))
      throw Error("UNKNOWN_OR_INACTIVE_SUBJECT");
    return v;
  };
  for (const v of p.organization.members) known(v);
  for (const v of p.operators) known(v);
  for (const team of p.teams) {
    if (
      new Set(team.members.map((m) => m.principalId)).size !==
        team.members.length ||
      !team.members.some((m) => m.active && m.role === "owner")
    )
      throw Error("CURRENT_OWNER_REQUIRED");
    for (const m of team.members) if (m.active) known(m.principalId);
  }
  for (const s of p.spaces) {
    const team = p.teams.find((t) => t.id === s.namespaceId);
    if (s.kind === "team" && !team) throw Error("UNKNOWN_CURRENT_TEAM");
    for (const owner of s.owners) {
      known(owner);
      if (
        s.kind === "team" &&
        !team!.members.some(
          (m) => m.principalId === owner && m.active && m.role === "owner",
        )
      )
        throw Error("EXPLICIT_CURRENT_OWNER_REQUIRED");
    }
    if (
      s.kind === "personal" &&
      (s.owners.length !== 1 || s.visibility !== "private")
    )
      throw Error("PERSONAL_POLICY_WIDENING");
    const member = (v: string) => {
      known(v);
      if (
        s.kind === "personal"
          ? !s.owners.includes(v)
          : !team!.members.some((m) => m.principalId === v && m.active)
      )
        throw Error("CROSS_SPACE_POLICY_WIDENING");
    };
    for (const g of s.grants) member(g.principalId);
    for (const r of s.reviewers) {
      member(r.principalId);
      if (
        !s.owners.includes(r.principalId) &&
        !s.grants.some(
          (g) =>
            g.principalId === r.principalId &&
            ["maintain", "admin"].includes(g.role),
        )
      )
        throw Error("UNQUALIFIED_CURRENT_REVIEWER");
      const qualifiedAge = Date.now() - Date.parse(r.qualifiedAt);
      if (qualifiedAge < -60000 || qualifiedAge > p.maxAgeMs)
        throw Error("REVIEWER_QUALIFICATION_STALE");
    }
    if (
      new Set(s.reviewers.map((r) => r.principalId)).size < s.minimumApprovals
    )
      throw Error("INSUFFICIENT_QUALIFIED_REVIEWERS");
    for (const r of s.readers) for (const who of r.principalIds) member(who);
  }
  return p;
}
export async function revokeHistoricalAuthority(db: PoolClient) {
  const existing = new Set(
    (
      await db.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      )
    ).rows.map((r) => r.table_name),
  );
  for (const table of [
    "runtime_sessions",
    "oidc_logins",
    "approvals",
    "access_reviewers",
    "access_review_rules",
    "access_group_members",
    "runtime_execution_grants",
  ])
    if (existing.has(table)) await db.query(`DELETE FROM "${table}"`);
  for (const table of ["access_credentials", "access_grants", "access_shares"])
    if (existing.has(table))
      await db.query(`UPDATE "${table}" SET revoked=true`);
  if (existing.has("access_principals"))
    await db.query("UPDATE access_principals SET active=false");
  if (existing.has("access_team_members"))
    await db.query("UPDATE access_team_members SET active=false");
  if (existing.has("access_spaces"))
    await db.query("UPDATE access_spaces SET active=false");
  if (existing.has("durable_schedules"))
    await db.query("UPDATE durable_schedules SET enabled=false");
  if (existing.has("durable_jobs"))
    await db.query(
      "UPDATE durable_jobs SET status='cancelled',fence=fence+1,lease_until=NULL,checkpoint=NULL WHERE status IN('queued','running','cancel_requested','paused')",
    );
  if (existing.has("runtime_jobs"))
    await db.query(
      "UPDATE runtime_jobs SET status='failed',error_code='RESTORE_REQUIRES_NEW_AUTHORIZATION',finished_at=now() WHERE status='running'",
    );
  if (existing.has("access_source_policy"))
    await db.query(
      "UPDATE access_source_policy SET local_copy_allowed=false,export_allowed=false,revision=revision+1",
    );
}
async function boundIdentity(db: PoolClient): Promise<RestoreIdentity> {
  const target = (
    await db.query(
      'SELECT current_database() AS database,(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"',
    )
  ).rows[0];
  if (!/^akh_ops_restore_[a-f0-9]{32}$/.test(target.database))
    throw Error("ISOLATED_RESTORE_DATABASE_REQUIRED");
  const binding = (
    await db.query(
      "SELECT * FROM operations_recovery_releases WHERE id='restore-binding'",
    )
  ).rows[0];
  if (!binding) throw Error("VERIFIED_BACKUP_BINDING_REQUIRED");
  return {
    source: {
      database: binding.source_database,
      systemIdentifier: binding.source_system_identifier,
    },
    target,
    backup: { id: binding.backup_id, databaseSha256: binding.preview_hash },
  };
}
export async function verifiedRestoreIdentity(pool: Pool) {
  const db = await pool.connect();
  try {
    return await boundIdentity(db);
  } finally {
    db.release();
  }
}
async function validateRawIntersection(db: PoolClient, p: CurrentPolicy) {
  const spaces = (
    await db.query("SELECT id FROM workspaces ORDER BY id")
  ).rows.map((r) => r.id);
  if (
    spaces.length !== p.spaces.length ||
    spaces.some((id) => !p.spaces.some((s) => s.workspaceId === id))
  )
    throw Error("CURRENT_POLICY_SPACE_SET_MISMATCH");
  for (const s of p.spaces)
    for (const r of s.readers)
      for (const who of r.principalIds)
        if (
          !(
            await db.query(
              "SELECT 1 FROM operations_recovery_acl a WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3 AND principal_id=$4 AND NOT EXISTS(SELECT 1 FROM operations_tombstones t WHERE t.workspace_id=a.workspace_id AND t.resource_kind=a.kind AND t.resource_id=a.resource_id AND t.delete_content)",
              [s.workspaceId, r.kind, r.id, who],
            )
          ).rowCount
        )
          throw Error("RAW_ACL_WIDENING");
  for (const v of p.principals) {
    const old = (
      await db.query(
        "SELECT issuer,subject FROM access_principals WHERE id=$1",
        [v.principalId],
      )
    ).rows[0];
    if (old && (old.issuer !== v.issuer || old.subject !== v.subject))
      throw Error("PRINCIPAL_SUBJECT_MISMATCH");
  }
}
async function locked<T>(pool: Pool, work: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout='10s'");
    await db.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
/** Operator-only, independently signed authority. No HTTP route accepts this bundle. */
export async function previewCurrentPolicyRelease(
  pool: Pool,
  config: {
    encrypted: string;
    key: string;
    signingKey: string;
    operatorId: string;
  },
) {
  return locked(pool, async (db) => {
    const identity = await boundIdentity(db),
      p = readCurrentPolicy(
        config.encrypted,
        config.key,
        config.signingKey,
        identity,
      );
    if (!p.operators.includes(config.operatorId))
      throw Error("RECOVERY_OPERATOR_NOT_AUTHORIZED");
    if (
      !(
        await db.query(
          "SELECT 1 FROM operations_tombstones WHERE id='restore-quarantine' LIMIT 1",
        )
      ).rowCount
    )
      throw Error("RESTORE_NOT_QUARANTINED");
    await validateRawIntersection(db, p);
    const policyHash = hash(config.encrypted),
      previewHash = hash(
        JSON.stringify({ identity, policyHash, spaces: p.spaces }),
      ),
      id = randomUUID();
    await db.query(
      "INSERT INTO operations_recovery_releases(id,backup_id,source_database,source_system_identifier,policy_hash,preview_hash,operator_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'previewed')",
      [
        id,
        p.backup.id,
        p.source.database,
        p.source.systemIdentifier,
        policyHash,
        previewHash,
        config.operatorId,
      ],
    );
    return {
      id,
      previewHash,
      policyHash,
      spaces: p.spaces.map((s) => ({
        workspaceId: s.workspaceId,
        owners: s.owners,
        reviewers: s.reviewers.map((r) => r.principalId),
        rawReadGrants: s.readers.reduce((n, r) => n + r.principalIds.length, 0),
      })),
      requiresNewSsoLogin: true,
    };
  });
}
export async function releaseCurrentPolicy(
  pool: Pool,
  config: {
    encrypted: string;
    key: string;
    signingKey: string;
    operatorId: string;
    previewId: string;
    previewHash: string;
    confirm: string;
    keepQuarantined?: boolean;
  },
) {
  return locked(pool, async (db) => {
    const identity = await boundIdentity(db),
      p = readCurrentPolicy(
        config.encrypted,
        config.key,
        config.signingKey,
        identity,
      ),
      policyHash = hash(config.encrypted),
      previewHash = hash(
        JSON.stringify({ identity, policyHash, spaces: p.spaces }),
      );
    if (
      config.confirm !==
        (config.keepQuarantined
          ? "IMPORT_CURRENT_POLICY_KEEP_QUARANTINE"
          : "RELEASE_VERIFIED_CURRENT_POLICY_NEW_SSO_ONLY") ||
      previewHash !== config.previewHash ||
      !p.operators.includes(config.operatorId)
    )
      throw Error("RECOVERY_RELEASE_CONFIRMATION_REQUIRED");
    const preview = (
      await db.query(
        "SELECT 1 FROM operations_recovery_releases WHERE id=$1 AND preview_hash=$2 AND policy_hash=$3 AND operator_id=$4 AND status='previewed'",
        [config.previewId, previewHash, policyHash, config.operatorId],
      )
    ).rowCount;
    if (!preview) throw Error("RECOVERY_PREVIEW_MISMATCH");
    if (
      !config.keepQuarantined &&
      (
        await db.query(
          "SELECT 1 FROM operations_erasure_receipts e WHERE e.status='blocked' AND e.error_code='UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW' AND NOT EXISTS(SELECT 1 FROM operations_erasure_receipts done WHERE done.workspace_id=e.workspace_id AND done.scope='workspace' AND done.created_at>=e.created_at AND (done.status='completed' OR done.error_code='SHARED_LIVE_BLOB_RETAINED')) LIMIT 1",
        )
      ).rowCount
    )
      throw Error("RECOVERY_ERASURE_REVIEW_REQUIRED");
    await validateRawIntersection(db, p);
    await revokeHistoricalAuthority(db);
    await db.query("DELETE FROM resource_readers");
    await db.query("UPDATE memberships SET role='reader'");
    for (const v of p.principals)
      await db.query(
        "INSERT INTO access_principals(id,issuer,subject,kind,active,company_reader,team_create) VALUES($1,$2,$3,'human',$4,$5,$6) ON CONFLICT(id) DO UPDATE SET issuer=excluded.issuer,subject=excluded.subject,kind='human',active=excluded.active,company_reader=excluded.company_reader,team_create=excluded.team_create",
        [
          v.principalId,
          v.issuer,
          v.subject,
          v.active,
          p.organization.members.includes(v.principalId),
          v.teamCreate,
        ],
      );
    for (const team of p.teams) {
      await db.query(
        "INSERT INTO access_namespaces(id,kind,slug,name) VALUES($1,'team',$2,$3) ON CONFLICT(id) DO UPDATE SET kind='team',slug=excluded.slug,name=excluded.name,owner_id=NULL",
        [team.id, team.slug, team.name],
      );
      for (const m of team.members)
        await db.query(
          "INSERT INTO access_team_members(team_id,principal_id,role,active) VALUES($1,$2,$3,$4) ON CONFLICT(team_id,principal_id) DO UPDATE SET role=excluded.role,active=excluded.active",
          [team.id, m.principalId, m.role, m.active],
        );
    }
    for (const s of p.spaces) {
      if (s.kind === "personal")
        await db.query(
          "INSERT INTO access_namespaces(id,kind,slug,name,owner_id) VALUES($1,'personal',$2,'Personal',$3) ON CONFLICT(id) DO UPDATE SET kind='personal',owner_id=excluded.owner_id",
          [s.namespaceId, s.slug, s.owners[0]],
        );
      await db.query(
        "INSERT INTO access_spaces(workspace_id,namespace_id,slug,visibility,minimum_approvals,active) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(workspace_id) DO UPDATE SET namespace_id=excluded.namespace_id,slug=excluded.slug,visibility=excluded.visibility,minimum_approvals=excluded.minimum_approvals,active=true,policy_version=access_spaces.policy_version+1",
        [
          s.workspaceId,
          s.namespaceId,
          s.slug,
          s.visibility,
          s.minimumApprovals,
        ],
      );
      const members = new Set([
        ...s.owners,
        ...s.grants.map((g) => g.principalId),
        ...s.readers.flatMap((r) => r.principalIds),
      ]);
      for (const who of members)
        await db.query(
          "INSERT INTO memberships VALUES($1,$2,'reader') ON CONFLICT DO NOTHING",
          [s.workspaceId, who],
        );
      for (const g of s.grants) {
        const updated = await db.query(
          "UPDATE access_grants SET role=$3,expires_at=NULL,revoked=false WHERE workspace_id=$1 AND principal_id=$2",
          [s.workspaceId, g.principalId, g.role],
        );
        if (!updated.rowCount)
          await db.query(
            "INSERT INTO access_grants(id,workspace_id,principal_id,role) VALUES($1,$2,$3,$4)",
            [randomUUID(), s.workspaceId, g.principalId, g.role],
          );
      }
      for (const r of s.reviewers)
        await db.query(
          "INSERT INTO access_reviewers(workspace_id,principal_id) VALUES($1,$2)",
          [s.workspaceId, r.principalId],
        );
      if (!config.keepQuarantined)
        for (const r of s.readers)
          for (const who of r.principalIds)
            await db.query(
              "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,$2,$3,$4)",
              [s.workspaceId, r.kind, r.id, who],
            );
      for (const r of s.sourceRules)
        await db.query(
          "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,source_id) DO UPDATE SET local_copy_allowed=excluded.local_copy_allowed,export_allowed=excluded.export_allowed,revision=access_source_policy.revision+1",
          [s.workspaceId, r.sourceId, r.localCopyAllowed, r.exportAllowed],
        );
      await appendOperationalAudit(
        db,
        { workspaceId: s.workspaceId, principalId: config.operatorId },
        { operation: "recovery.current-policy-release" },
      );
    }
    if (!config.keepQuarantined)
      await db.query(
        "DELETE FROM operations_tombstones WHERE id='restore-quarantine'",
      );
    await db.query(
      "UPDATE operations_recovery_releases SET status=$2,released_at=CASE WHEN $2='released' THEN now() ELSE NULL END WHERE id=$1",
      [config.previewId, config.keepQuarantined ? "previewed" : "released"],
    );
    return {
      released: !config.keepQuarantined,
      quarantined: !!config.keepQuarantined,
      requiresNewSsoLogin: true,
      historicalCredentialsRestored: false,
    };
  });
}
