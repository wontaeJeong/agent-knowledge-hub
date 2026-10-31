import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import { effectiveAccess } from "../access/index";
import {
  identityEvent,
  identityTransaction,
  sessionBinding,
  type DB,
} from "./sessions";
import type { Pool } from "pg";

/** These objects are minted only after the host's verified UserInfo call. JSON
 * posted by a browser cannot be converted into a trusted proof by casting. */
export type GroupProof = Readonly<{
  issuer: string;
  subject: string;
  groups: readonly string[];
  verifiedAt: string;
  validUntil: string;
}>;
const verifiedProofs = new WeakSet<object>();
function approvedIssuer(value: string, allowLoopbackHttp = false) {
  const issuer = new URL(value);
  const local =
    allowLoopbackHttp &&
    process.env.NODE_ENV !== "production" &&
    issuer.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  if (
    (issuer.protocol !== "https:" && !local) ||
    issuer.username ||
    issuer.password ||
    issuer.hash
  )
    throw Error("INVALID_DIRECTORY_AUTHORITY");
}
export type VerifiedUserInfo = {
  issuer: string;
  subject: string;
  groups: readonly string[];
  validUntil?: string;
};
export class DirectoryAuthority {
  constructor(
    private readonly config: {
      issuer: string;
      maxAgeSeconds: number;
      allowLoopbackHttp?: boolean;
      fetchVerifiedUserInfo: (subject: string) => Promise<VerifiedUserInfo>;
    },
  ) {
    approvedIssuer(config.issuer, config.allowLoopbackHttp);
    if (
      !Number.isSafeInteger(config.maxAgeSeconds) ||
      config.maxAgeSeconds < 1 ||
      config.maxAgeSeconds > 300
    )
      throw Error("INVALID_DIRECTORY_AUTHORITY");
  }
  async verify(subject: string): Promise<GroupProof> {
    // This adapter is injected by server construction, never by HTTP request.
    // Host callback uses authenticated OIDC fetchUserInfo with expected subject,
    // verified issuer/non-repudiation, timeout and response-size policy.
    const started = Date.now(),
      info = await this.config.fetchVerifiedUserInfo(subject);
    if (Date.now() - started > 10000) throw Error("DIRECTORY_PROOF_TIMEOUT");
    if (
      info.issuer !== this.config.issuer ||
      info.subject !== subject ||
      !Array.isArray(info.groups) ||
      info.groups.length > 1000 ||
      info.groups.some(
        (g) => typeof g !== "string" || g.length < 1 || g.length > 256,
      )
    )
      throw Error("DIRECTORY_IDENTITY_MISMATCH");
    const until = Math.min(
      started + this.config.maxAgeSeconds * 1000,
      info.validUntil ? Date.parse(info.validUntil) : Infinity,
    );
    if (!Number.isFinite(until) || until <= Date.now())
      throw Error("STALE_DIRECTORY_PROOF");
    const proof = Object.freeze({
      issuer: info.issuer,
      subject: info.subject,
      groups: Object.freeze([...new Set(info.groups)]),
      verifiedAt: new Date(started).toISOString(),
      validUntil: new Date(until).toISOString(),
    });
    verifiedProofs.add(proof);
    return proof;
  }
}
/** Must run inside the host's transaction before effectiveAccess/current rights.
 * Advisory serialization prevents two verified proofs racing their projection.
 * Never changes admission, principal active status, or a direct/revoked grant. */
export async function projectDirectoryMemberships(
  db: DB,
  principalId?: string,
): Promise<void> {
  if ("connect" in db && !("release" in db))
    return identityTransaction(db as Pool, (client) =>
      projectDirectoryMemberships(client, principalId),
    );
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
  await db.query("SELECT set_config('akh.identity_projection','on',true)");
  try {
    const removed = await db.query(
      `DELETE FROM access_group_members gm WHERE ($1::text IS NULL OR gm.principal_id=$1)
   AND NOT EXISTS(SELECT 1 FROM identity_manual_group_members m WHERE m.group_id=gm.group_id AND m.principal_id=gm.principal_id)
   AND NOT EXISTS(SELECT 1 FROM identity_directory_edges e JOIN identity_directory_bindings b ON b.id=e.binding_id AND b.active AND b.revision=e.binding_revision
    JOIN access_principals p ON p.id=e.principal_id AND p.active AND p.issuer=b.issuer
    WHERE b.group_id=gm.group_id AND e.principal_id=gm.principal_id AND e.valid_until>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM identity_group_denies d WHERE d.group_id=gm.group_id AND d.principal_id=gm.principal_id)) RETURNING gm.group_id`,
      [principalId ?? null],
    );
    const denied = await db.query(
      `DELETE FROM access_group_members gm USING identity_group_denies d WHERE gm.group_id=d.group_id AND gm.principal_id=d.principal_id AND ($1::text IS NULL OR gm.principal_id=$1) RETURNING gm.group_id`,
      [principalId ?? null],
    );
    const inserted = await db.query(
      `INSERT INTO access_group_members(group_id,principal_id)
   SELECT m.group_id,m.principal_id FROM identity_manual_group_members m JOIN access_principals p ON p.id=m.principal_id AND p.active
   WHERE ($1::text IS NULL OR m.principal_id=$1) AND NOT EXISTS(SELECT 1 FROM identity_group_denies d WHERE d.group_id=m.group_id AND d.principal_id=m.principal_id)
   UNION SELECT b.group_id,e.principal_id FROM identity_directory_edges e JOIN identity_directory_bindings b ON b.id=e.binding_id AND b.active AND b.revision=e.binding_revision
   JOIN access_principals p ON p.id=e.principal_id AND p.active AND p.issuer=b.issuer
   WHERE ($1::text IS NULL OR e.principal_id=$1) AND e.valid_until>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM identity_group_denies d WHERE d.group_id=b.group_id AND d.principal_id=e.principal_id)
    ON CONFLICT DO NOTHING RETURNING group_id`,
      [principalId ?? null],
    );
    const changed = [
      ...new Set(
        [...removed.rows, ...denied.rows, ...inserted.rows].map(
          (r) => r.group_id as string,
        ),
      ),
    ];
    if (changed.length)
      await db.query(
        "UPDATE access_spaces SET policy_version=policy_version+1 WHERE namespace_id IN (SELECT team_id FROM access_groups WHERE id=ANY($1::text[]))",
        [changed],
      );
  } finally {
    await db.query("SELECT set_config('akh.identity_projection','off',true)");
  }
}
export async function syncDirectoryMemberships(
  db: DB,
  proof: GroupProof,
): Promise<void> {
  if (!proof || !verifiedProofs.has(proof))
    throw Error("UNVERIFIED_DIRECTORY_PROOF");
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
  const result = await db.query(
    `SELECT id FROM access_principals WHERE issuer=$1 AND subject=$2 AND active AND kind='human'
  AND $3::timestamptz<=clock_timestamp()+interval '1 second' AND $4::timestamptz>clock_timestamp() FOR SHARE`,
    [proof.issuer, proof.subject, proof.verifiedAt, proof.validUntil],
  );
  const principalId = result.rows[0]?.id;
  if (!principalId) throw Error("DIRECTORY_IDENTITY_MISMATCH");
  const recorded = await db.query(
    `INSERT INTO identity_directory_proofs(principal_id,issuer,verified_at,valid_until) VALUES($1,$2,$3,$4)
  ON CONFLICT(principal_id,issuer) DO UPDATE SET verified_at=EXCLUDED.verified_at,valid_until=EXCLUDED.valid_until
  WHERE identity_directory_proofs.verified_at<=EXCLUDED.verified_at RETURNING principal_id`,
    [principalId, proof.issuer, proof.verifiedAt, proof.validUntil],
  );
  if (!recorded.rowCount) throw Error("STALE_DIRECTORY_PROOF");
  await db.query(
    `DELETE FROM identity_directory_edges e USING identity_directory_bindings b WHERE e.binding_id=b.id AND e.principal_id=$1 AND b.issuer=$2`,
    [principalId, proof.issuer],
  );
  await db.query(
    `INSERT INTO identity_directory_edges(binding_id,principal_id,binding_revision,valid_until)
  SELECT id,$1,revision,$4 FROM identity_directory_bindings WHERE issuer=$2 AND external_group_id=ANY($3::text[]) AND active`,
    [principalId, proof.issuer, [...proof.groups], proof.validUntil],
  );
  await projectDirectoryMemberships(db, principalId);
  await identityEvent(db, principalId, "directory.sync", principalId, {
    issuer: proof.issuer,
    validUntil: proof.validUntil,
  });
}
export type GroupBindingInput = {
  issuer: string;
  externalGroupId: string;
  groupId: string;
  expectedRevision: number;
  active?: boolean;
};
export type AssertGroupAdmin = (
  db: DB,
  ctx: Context,
  groupId: string,
  teamId: string,
) => Promise<void>;
/** Default production authorizer: current canonical Admin in this exact
 * namespace, or explicit active team Owner. Neither reviewer nor another
 * namespace's Admin is inferred to own the group. */
export const canonicalGroupAdmin: AssertGroupAdmin = async (
  db,
  ctx,
  _groupId,
  teamId,
) => {
  if (ctx.credentialId) throw Error("FORBIDDEN");
  const owner = await db.query(
    `SELECT 1 FROM access_team_members m JOIN access_principals p ON p.id=m.principal_id AND p.active AND p.kind='human'
  WHERE m.team_id=$1 AND m.principal_id=$2 AND m.active AND m.role='owner'`,
    [teamId, ctx.principalId],
  );
  if (owner.rowCount) return;
  const access = await effectiveAccess(db, ctx);
  if (
    access.space.namespaceId !== teamId ||
    !access.capabilities.includes("space.admin") ||
    ctx.credentialId
  )
    throw Error("FORBIDDEN");
};
export async function assertFreshDirectoryHuman(
  db: DB,
  ctx: Context,
): Promise<void> {
  const current = await db.query(
    `SELECT p.id FROM access_principals p JOIN identity_directory_proofs d ON d.principal_id=p.id AND d.issuer=p.issuer
  WHERE p.id=$1 AND p.active AND p.kind='human' AND d.valid_until>clock_timestamp()
  AND d.verified_at>clock_timestamp()-interval '5 minutes' FOR SHARE OF p,d`,
    [ctx.principalId],
  );
  if (!current.rowCount || ctx.credentialId)
    throw Error("FRESH_DIRECTORY_HUMAN_REQUIRED");
}
/** Authorizer MUST assert current human space.admin for a space whose
 * namespace equals teamId; explicit team owner is also allowed by host policy.
 * An unrelated space Admin never qualifies. No browser role/identity input. */
export async function bindDirectoryGroup(
  db: DB,
  ctx: Context,
  input: GroupBindingInput,
  assertGroupAdmin: AssertGroupAdmin,
  options: { allowLoopbackHttp?: boolean } = {},
) {
  sessionBinding(ctx);
  await ctx.authorization!.assertSession(db as PoolClient);
  approvedIssuer(input.issuer, options.allowLoopbackHttp);
  if (
    !input.externalGroupId ||
    input.externalGroupId.length > 256 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw Error("INVALID_DIRECTORY_BINDING");
  const group = (
    await db.query("SELECT team_id FROM access_groups WHERE id=$1", [
      input.groupId,
    ])
  ).rows[0];
  if (!group) throw Error("NOT_FOUND");
  const actor = await db.query(
    "SELECT id FROM access_principals WHERE id=$1 AND active AND kind='human' FOR SHARE",
    [ctx.principalId],
  );
  if (!actor.rowCount) throw Error("FORBIDDEN");
  await assertGroupAdmin(db, ctx, input.groupId, group.team_id);
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
  const old = (
    await db.query(
      "SELECT id,revision FROM identity_directory_bindings WHERE issuer=$1 AND external_group_id=$2 AND group_id=$3 FOR UPDATE",
      [input.issuer, input.externalGroupId, input.groupId],
    )
  ).rows[0];
  if ((old?.revision ?? 0) !== input.expectedRevision)
    throw Error("STALE_VERSION");
  const id = old?.id ?? randomUUID();
  await db.query(
    `INSERT INTO identity_directory_bindings(id,issuer,external_group_id,group_id,active,approved_by)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET active=EXCLUDED.active,revision=identity_directory_bindings.revision+1,approved_by=EXCLUDED.approved_by`,
    [
      id,
      input.issuer,
      input.externalGroupId,
      input.groupId,
      input.active ?? true,
      ctx.principalId,
    ],
  );
  await projectDirectoryMemberships(db);
  await db.query(
    "UPDATE access_spaces SET policy_version=policy_version+1 WHERE namespace_id=$1",
    [group.team_id],
  );
  await identityEvent(db, ctx.principalId, "directory.binding", id, {
    ...input,
    revision: input.expectedRevision + 1,
  });
  return { id, revision: input.expectedRevision + 1 };
}
/** Call from every manual remove endpoint even if canonical row is absent.
 * Clearing this tombstone requires a separate explicit human-approved regrant. */
export async function denyGroupMembership(
  db: DB,
  groupId: string,
  principalId: string,
) {
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
  await db.query(
    "INSERT INTO identity_group_denies(group_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [groupId, principalId],
  );
  await db.query(
    "DELETE FROM identity_manual_group_members WHERE group_id=$1 AND principal_id=$2",
    [groupId, principalId],
  );
  await projectDirectoryMemberships(db, principalId);
}
/** Use for explicit product changes, including an INSERT that would otherwise
 * be an ON CONFLICT no-op on an existing directory-projected membership. Only
 * this independently authorized human action can clear a manual denial. */
export async function setManualGroupMembership(
  db: DB,
  ctx: Context,
  groupId: string,
  principalId: string,
  active: boolean,
  assertGroupAdmin: AssertGroupAdmin = canonicalGroupAdmin,
  options: { canonicalMutation?: boolean } = {},
) {
  if (ctx.authorization) {
    sessionBinding(ctx);
    await ctx.authorization.assertSession(db as PoolClient);
  } else if (!options.canonicalMutation) throw Error("UNAUTHENTICATED");
  const group = (
    await db.query("SELECT team_id FROM access_groups WHERE id=$1", [groupId])
  ).rows[0];
  if (!group || ctx.credentialId) throw Error("FORBIDDEN");
  const human = await db.query(
    "SELECT id FROM access_principals WHERE id=$1 AND active AND kind='human' FOR SHARE",
    [ctx.principalId],
  );
  if (!human.rowCount) throw Error("FORBIDDEN");
  await assertGroupAdmin(db, ctx, groupId, group.team_id);
  await db.query("SELECT pg_advisory_xact_lock(7203101)");
  if (active) {
    const target = await db.query(
      `SELECT p.id FROM access_principals p JOIN access_team_members m ON m.principal_id=p.id AND m.active
   WHERE p.id=$1 AND p.active AND m.team_id=$2 FOR SHARE OF p,m`,
      [principalId, group.team_id],
    );
    if (!target.rowCount) throw Error("FORBIDDEN");
    await db.query(
      "DELETE FROM identity_group_denies WHERE group_id=$1 AND principal_id=$2",
      [groupId, principalId],
    );
    await db.query(
      "INSERT INTO identity_manual_group_members VALUES($1,$2) ON CONFLICT DO NOTHING",
      [groupId, principalId],
    );
    await projectDirectoryMemberships(db, principalId);
  } else await denyGroupMembership(db, groupId, principalId);
  await identityEvent(
    db,
    ctx.principalId,
    "directory.manual-membership",
    groupId,
    { principalId, active },
  );
}
