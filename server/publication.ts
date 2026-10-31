import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Context } from "./service";
import type { Source } from "../src/domain/types";
import type { Batch, Draft } from "../src/domain/wiki";
import {
  createBatch,
  decideBatch,
  enqueueBatch,
  memory,
  current,
} from "../src/domain/wiki";
import { transaction } from "./database";
import { authorizeActionDb, effectiveAccess } from "./access/index";
import { assertReleasedImportContext } from "./operations/released-imports";
import {
  publicationRequirements,
  type PropertyWarning,
} from "./workflows/governance/requirements";
import {
  addResource,
  audit,
  loadState,
  membership,
  readers,
  requireRead,
} from "./repository";
import {
  assertEnvelope,
  inheritedProvenance,
  versionProvenance,
  type InputEnvelope,
  type Provenance,
} from "./provenance";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const batchHash = ({
  status: _s,
  approvedFingerprint: _f,
  requestAuthorizationPending: _pending,
  reviewWarnings: _warnings,
  ...content
}: Batch & {
  requestAuthorizationPending?: boolean;
  reviewWarnings?: PropertyWarning[];
}) => digest(content);
type RuntimeBatch = Batch & {
  producer?: NonNullable<import("../src/domain/types").Version["producer"]>;
  responsibleUserId?: string;
  proposedBy?: string;
  importRunId?: string;
  importAuthorId?: string;
  contextDependencyIds?: string[];
  inputEnvelope?: InputEnvelope;
};

async function permissions(
  db: PoolClient,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
  dependencyIds: string[] = [],
  enforceRequirements = false,
) {
  const acl: Record<string, unknown> = {};
  const requirements = await publicationRequirements(db, ctx, updates);
  acl.requiredProperties = requirements.policy;
  const policy = await db.query(
    "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
  if (policy.rowCount) acl.policyVersion = policy.rows[0].policy_version;
  const workflowTables = await db.query(
    "SELECT to_regclass('workflow_document_state') AS documents,to_regclass('workflow_source_state') AS sources",
  );
  if (workflowTables.rows[0].documents)
    acl.documentPolicies = (
      await db.query(
        "SELECT page_id,parent_id,state,revision,data FROM workflow_document_state WHERE workspace_id=$1 ORDER BY page_id",
        [ctx.workspaceId],
      )
    ).rows;
  if (workflowTables.rows[0].sources)
    acl.sourcePolicies = (
      await db.query(
        "SELECT source_id,state,revision,data FROM workflow_source_state WHERE workspace_id=$1 ORDER BY source_id",
        [ctx.workspaceId],
      )
    ).rows;
  const canonicalState = await loadState(db, ctx.workspaceId);
  const retainedDependencies = new Set(dependencyIds);
  const audienceOf = async (kind: string, id: string) => {
    const list = (await readers(db, ctx.workspaceId, kind, id)).sort();
    acl[`${kind}:${id}`] = list;
    return list;
  };
  const allSources = [
    ...new Set([...sourceIds, ...updates.flatMap((d) => d.sourceIds)]),
  ];
  for (const id of allSources) {
    if (!(await audienceOf("source", id)).includes(ctx.principalId))
      throw Error("NOT_FOUND");
  }
  const audiences = new Map<string, string[]>();
  for (const d of updates) {
    const existing = canonicalState.pages.find((p) => p.id === d.id);
    if (existing?.status === "공식 기준") {
      const official = await db.query(
        "SELECT minimum_approvals,reviewer_ids FROM access_review_rules WHERE workspace_id=$1 AND document_type='official-standard'",
        [ctx.workspaceId],
      );
      const rule = official.rows[0];
      if (
        !rule ||
        rule.minimum_approvals < 2 ||
        new Set(rule.reviewer_ids).size < 2
      )
        throw Error("OFFICIAL_REVIEW_REQUIRED");
      acl[`official:${d.id}`] = rule;
    }
    const workflow = await db.query(
      "SELECT to_regclass('workflow_document_state') AS present",
    );
    if (workflow.rows[0].present) {
      const p = await db.query(
        "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, d.id],
      );
      if (p.rowCount && p.rows[0].state !== "active") throw Error("FORBIDDEN");
      if (p.rows[0]?.data?.protected === true) {
        const a = await effectiveAccess(db, ctx);
        if (!a.capabilities.includes("knowledge.protect"))
          throw Error("FORBIDDEN");
      }
    }
    const sourceAudiences = await Promise.all(
      d.sourceIds.map((id) => audienceOf("source", id)),
    );
    const intersection =
      sourceAudiences[0]?.filter((who) =>
        sourceAudiences.every((a) => a.includes(who)),
      ) ?? [];
    const exists = await db.query(
      "SELECT id FROM pages WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, d.id],
    );
    if (exists.rowCount) {
      await requireRead(db, ctx, "page", d.id);
      const audience = await audienceOf("page", d.id);
      if (audience.some((p) => !intersection.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
      audiences.set(d.id, audience);
    } else audiences.set(d.id, intersection);
    if (!intersection.includes(ctx.principalId)) throw Error("NOT_FOUND");
    const old = canonicalState.pages.find((p) => p.id === d.id);
    if (old) {
      const inherited = inheritedProvenance(old);
      for (const id of inherited.pageIds) retainedDependencies.add(id);
      for (const id of inherited.sourceIds) {
        const a = await audienceOf("source", id);
        if (audiences.get(d.id)!.some((p) => !a.includes(p)))
          throw Error("SOURCE_SCOPE_CONFLICT");
      }
    }
  }
  for (const d of updates) {
    for (const link of d.links) {
      let audience = audiences.get(link);
      if (!audience) {
        audience = await audienceOf("page", link);
        const target = await db.query(
          "SELECT data,number FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
          [ctx.workspaceId, link],
        );
        if (!target.rowCount) throw Error("NOT_FOUND");
        acl[`dependency:${link}`] = target.rows[0].number;
        for (const sourceId of target.rows[0].data.sourceIds) {
          const sourceAudience = await audienceOf("source", sourceId);
          audience = audience.filter((p) => sourceAudience.includes(p));
        }
      }
      if (!audience.includes(ctx.principalId)) throw Error("NOT_FOUND");
      if (audiences.get(d.id)!.some((p) => !audience.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
    }
  }
  for (const id of retainedDependencies) {
    const dependencyAudience = await audienceOf("page", id);
    if (!dependencyAudience.includes(ctx.principalId)) throw Error("NOT_FOUND");
    const r = await db.query(
      "SELECT data,number FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
      [ctx.workspaceId, id],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    acl[`dependency:${id}`] = r.rows[0].number;
    let effective = dependencyAudience;
    for (const sourceId of r.rows[0].data.sourceIds) {
      const a = await audienceOf("source", sourceId);
      effective = effective.filter((p) => a.includes(p));
    }
    const retained = versionProvenance(r.rows[0].data);
    for (const nested of retained.pageIds) retainedDependencies.add(nested);
    for (const sourceId of retained.sourceIds) {
      const a = await audienceOf("source", sourceId);
      effective = effective.filter((p) => a.includes(p));
    }
    if (!effective.includes(ctx.principalId)) throw Error("NOT_FOUND");
    for (const audience of audiences.values())
      if (audience.some((p) => !effective.includes(p)))
        throw Error("SOURCE_SCOPE_CONFLICT");
  }
  if (enforceRequirements && requirements.blockers.length)
    throw Error("PROPERTY_REQUIRED");
  return { audiences, hash: digest(acl), warnings: requirements.warnings };
}

export async function propose(
  pool: Pool,
  ctx: Context,
  updates: Draft[],
  sourceIds: string[],
  options?: {
    expectedStateHash?: string;
    mode?: "offline" | "model";
    dependencyIds?: string[];
    answerId?: string;
    inputEnvelope?: InputEnvelope;
    requestAuthorizationPending?: boolean;
    producer?: NonNullable<import("../src/domain/types").Version["producer"]>;
    /** Trusted server-only DB hook for pending-record preparation. No DTO/context override/network.
     * Runs only for a new proposal, after session admission and before permission/envelope/state capture.
     * Any later failure rolls this preparation back with the canonical proposal transaction.
     */
    onBeforeCreate?: (db: PoolClient) => Promise<void>;
    /** Trusted integration hook; never accepted in request DTOs. Runs before the same transaction commits. */
    onCreated?: (
      db: PoolClient,
      result: { id: string; hash: string },
    ) => Promise<void>;
    importRunId?: string;
    importAuthorId?: string;
  },
) {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      if ((await membership(db, ctx)) === "reader") throw Error("FORBIDDEN");
      const accessSpace = await db.query(
        "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
        [ctx.workspaceId],
      );
      if (accessSpace.rowCount)
        await authorizeActionDb(db, ctx, "changeset.propose");
      await ctx.authorization?.assertSession(db);
      if (options?.importRunId) {
        const run = await db.query(
          "SELECT import_id FROM import_runs WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, options.importRunId],
        );
        if (!run.rowCount) throw Error("NOT_FOUND");
        await assertReleasedImportContext(db, ctx, run.rows[0].import_id);
        const previous = await db.query(
          "SELECT id,hash,data FROM batches WHERE workspace_id=$1 AND data->>'importRunId'=$2",
          [ctx.workspaceId, options.importRunId],
        );
        if (previous.rowCount) {
          const old = previous.rows[0];
          const replayPermissions = await permissions(
            db,
            ctx,
            old.data.updates,
            old.data.snapshots.map((s: Source) => s.id),
            old.data.contextDependencyIds,
          );
          return {
            id: old.id,
            hash: old.hash,
            ...(replayPermissions.warnings.length ? { warnings: replayPermissions.warnings } : {}),
          };
        }
      }
      await options?.onBeforeCreate?.(db);
      const initialPermissions = await permissions(
        db,
        ctx,
        updates,
        sourceIds,
        options?.dependencyIds,
      );
      if (options?.inputEnvelope)
        await assertEnvelope(
          db,
          ctx,
          await loadState(db, ctx.workspaceId),
          options.inputEnvelope,
        );
      const state = await loadState(db, ctx.workspaceId);
      if (
        options?.expectedStateHash &&
        digest(state) !== options.expectedStateHash
      )
        throw Error("STALE_VERSION");
      let batch: Batch;
      try {
        batch = createBatch(
          state,
          updates,
          sourceIds,
          options?.mode ?? "offline",
        );
        (batch as RuntimeBatch).proposedBy = ctx.principalId;
        if (initialPermissions.warnings.length)
          Object.assign(batch, { reviewWarnings: initialPermissions.warnings });
        for (const id of options?.dependencyIds ?? []) {
          const p = state.pages.find((p) => p.id === id);
          if (!p) throw Error("NOT_FOUND");
          batch.baseSnapshots[id] = JSON.stringify([
            p.title,
            p.summary,
            p.scope,
            p.links,
            p.facts,
            current(p),
          ]);
        }
        if (options?.answerId) batch.answerId = options.answerId;
        (batch as RuntimeBatch).producer =
          options?.producer ??
          (options?.mode === "model"
            ? { kind: "model", provider: null, model: null }
            : options?.mode === "offline"
              ? { kind: "structural" }
              : { kind: "unknown" });
        (batch as RuntimeBatch).responsibleUserId =
          (
            await db.query(
              "SELECT sponsor_id FROM access_service_accounts WHERE principal_id=$1",
              [ctx.principalId],
            )
          ).rows[0]?.sponsor_id ?? options?.importAuthorId ?? ctx.principalId;
        if (options?.importRunId)
          Object.assign(batch, {
            importRunId: options.importRunId,
            importAuthorId: options.importAuthorId,
          });
        if (options?.dependencyIds)
          (batch as RuntimeBatch).contextDependencyIds = options.dependencyIds;
        if (options?.inputEnvelope)
          (batch as RuntimeBatch).inputEnvelope = options.inputEnvelope;
        if (options?.requestAuthorizationPending)
          Object.assign(batch, { requestAuthorizationPending: true });
        enqueueBatch(state, batch);
      } catch {
        throw Error("VALIDATION_FAILED");
      }
      const hash = batchHash(batch);
      await db.query("INSERT INTO batches VALUES($1,$2,$3,$4)", [
        ctx.workspaceId,
        batch.id,
        batch,
        hash,
      ]);
      if (accessSpace.rowCount)
        await db.query("INSERT INTO access_batch_authors VALUES($1,$2,$3)", [
          ctx.workspaceId,
          batch.id,
          options?.importAuthorId ?? ctx.principalId,
        ]);
      await audit(db, ctx, "batch.propose", batch.id);
      await options?.onCreated?.(db, { id: batch.id, hash });
      return { id: batch.id, hash, ...(initialPermissions.warnings.length ? { warnings: initialPermissions.warnings } : {}) };
    },
    { principalId: ctx.principalId, operation: "batch.propose" },
  );
}

async function checkedBatch(
  db: PoolClient,
  ctx: Context,
  id: string,
  hash: string,
) {
  if ((await membership(db, ctx)) !== "reviewer") throw Error("FORBIDDEN");
  const r = await db.query(
    "SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, id],
  );
  if (!r.rowCount) throw Error("NOT_FOUND");
  const batch = r.rows[0].data as Batch;
  const managed = await db.query(
    "SELECT n.kind,n.owner_id FROM access_spaces s JOIN access_namespaces n ON n.id=s.namespace_id WHERE s.workspace_id=$1",
    [ctx.workspaceId],
  );
  const personal = managed.rows[0]?.kind === "personal" &&
    managed.rows[0]?.owner_id === ctx.principalId;
  if (managed.rowCount && !personal) {
    if (
      !(
        await db.query(
          "SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
          [ctx.workspaceId, ctx.principalId],
        )
      ).rowCount
    )
      throw Error("FORBIDDEN");
    const authorId =
      (batch as RuntimeBatch).importAuthorId ??
      (batch as RuntimeBatch).proposedBy ??
      (await db.query(
        "SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, id],
      )).rows[0]?.principal_id;
    if (!authorId || authorId === ctx.principalId) throw Error("FORBIDDEN");
    if (
      (await membership(db, {
        workspaceId: ctx.workspaceId,
        principalId: authorId,
      })) === "reader"
    )
      throw Error("FORBIDDEN");
    await authorizeActionDb(db,
      { workspaceId: ctx.workspaceId, principalId: authorId },
      "changeset.propose",
    );
  }
  if (
    (batch as RuntimeBatch).importRunId &&
    batch.status !== "published" &&
    !personal
  ) {
    const disclosure = await db.query(
      "SELECT d.status,d.reviewer_id,effective_membership(m.workspace_id,m.principal_id) AS role FROM import_disclosures d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.principal_id=d.reviewer_id WHERE d.workspace_id=$1 AND d.run_id=$2",
      [ctx.workspaceId, (batch as RuntimeBatch).importRunId],
    );
    const allowed = new Set(
      (process.env.IMPORT_DISCLOSURE_REVIEWERS || "")
        .split(",")
        .map((s) => s.trim()),
    );
    if (
      !disclosure.rowCount ||
      disclosure.rows[0].status !== "approved" ||
      disclosure.rows[0].role !== "reviewer" ||
      !allowed.has(disclosure.rows[0].reviewer_id)
    )
      throw Error("APPROVAL_STALE");
    const reviewer = disclosure.rows[0].reviewer_id;
    await authorizeActionDb(db,
      { workspaceId: ctx.workspaceId, principalId: reviewer },
      "changeset.approve",
    );
    if (!(await db.query(
      "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
      [reviewer],
    )).rowCount) throw Error("APPROVAL_STALE");
  }
  if ((batch as RuntimeBatch).importAuthorId === ctx.principalId && !personal)
    throw Error("FORBIDDEN");
  if ((batch as RuntimeBatch).importAuthorId) {
    const author = {
      workspaceId: ctx.workspaceId,
      principalId: (batch as RuntimeBatch).importAuthorId!,
    };
    if ((await membership(db, author)) === "reader") throw Error("FORBIDDEN");
    if (managed.rowCount) await authorizeActionDb(db, author, "changeset.propose");
    await permissions(
      db,
      author,
      batch.updates,
      batch.snapshots.map((s) => s.id),
      (batch as RuntimeBatch).contextDependencyIds,
    );
  }
  if ((batch as RuntimeBatch).importRunId && batch.status !== "published") {
    const run = await db.query(
      "SELECT import_id FROM import_runs WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, (batch as RuntimeBatch).importRunId],
    );
    if (!run.rowCount) throw Error("APPROVAL_STALE");
    await assertReleasedImportContext(db, ctx, run.rows[0].import_id);
  }
  if (
    (batch as Batch & { requestAuthorizationPending?: boolean })
      .requestAuthorizationPending
  )
    throw Error("NOT_FOUND");
  if (batch.status !== "published" && (batch as RuntimeBatch).inputEnvelope)
    await assertEnvelope(
      db,
      ctx,
      await loadState(db, ctx.workspaceId),
      (batch as RuntimeBatch).inputEnvelope!,
    );
  await permissions(
    db,
    ctx,
    batch.updates,
    batch.snapshots.map((s) => s.id),
    (batch as RuntimeBatch).contextDependencyIds,
    true,
  );
  if (hash !== r.rows[0].hash || hash !== batchHash(batch))
    throw Error("APPROVAL_STALE");
  return batch;
}

async function reviewQualification(
  db: PoolClient,
  ctx: Context,
  id: string,
  approval: boolean,
) {
  const s = await db.query(
    "SELECT policy_version,minimum_approvals FROM access_spaces WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
  if (!s.rowCount) return null; // Historical service-only fixtures are not runtime-authorized.
  const a = await authorizeActionDb(
    db,
    ctx,
    approval ? "changeset.approve" : "changeset.publish",
  );
  if (ctx.credentialId) throw Error("FORBIDDEN");
  const human = await db.query(
    "SELECT 1 FROM access_principals WHERE id=$1 AND kind='human' AND active",
    [ctx.principalId],
  );
  if (!human.rowCount) throw Error("FORBIDDEN");
  const author = await db.query(
    "SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",
    [ctx.workspaceId, id],
  );
  if (!author.rowCount) throw Error("APPROVAL_STALE");
  const types = await db.query(
    `SELECT DISTINCT coalesce(p.data->>'category','연결된 지식') AS document_type,p.data->>'status'='공식 기준' AS official FROM batches b CROSS JOIN LATERAL jsonb_array_elements(b.data->'updates') u LEFT JOIN pages p ON p.workspace_id=b.workspace_id AND p.id=u->>'id' WHERE b.workspace_id=$1 AND b.id=$2`,
    [ctx.workspaceId, id],
  );
  const rules = await db.query(
    "SELECT * FROM access_review_rules WHERE workspace_id=$1 AND document_type=ANY($2::text[])",
    [
      ctx.workspaceId,
      [
        ...types.rows.map((r) => r.document_type),
        ...(types.rows.some((r) => r.official) ? ["official-standard"] : []),
      ],
    ],
  );
  if (
    types.rows.some((r) => r.official) &&
    a.space.namespaceKind === "personal"
  )
    throw Error("OFFICIAL_REVIEW_REQUIRED");
  if (approval && a.space.namespaceKind !== "personal") {
    if (author.rows[0].principal_id === ctx.principalId)
      throw Error("FORBIDDEN");
    const designated = await db.query(
      "SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
      [ctx.workspaceId, ctx.principalId],
    );
    if (!designated.rowCount) throw Error("FORBIDDEN");
    if (rules.rows.some((r) => !r.reviewer_ids.includes(ctx.principalId)))
      throw Error("FORBIDDEN");
  }
  return {
    ...s.rows[0],
    minimum_approvals: Math.max(
      s.rows[0].minimum_approvals,
      ...rules.rows.map((r) => r.minimum_approvals),
    ),
    authorId: author.rows[0].principal_id,
    personal: a.space.namespaceKind === "personal",
  };
}

export async function approve(
  pool: Pool,
  ctx: Context,
  id: string,
  hash: string,
) {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      await checkedBatch(db, ctx, id, hash);
      const qualification = await reviewQualification(db, ctx, id, true);
      const state = await loadState(db, ctx.workspaceId);
      // Additional reviewers and re-review after a policy change sign the same fixed content.
      // Domain demo permits only one approval, so reset only this transaction-local candidate.
      if (qualification) {
        const candidate = memory(state).batches.find((b) => b.id === id);
        if (candidate?.status === "approved") candidate.status = "pending";
      }
      let batch: Batch;
      try {
        batch = memory(decideBatch(state, id, "approve")).batches.find(
          (b) => b.id === id,
        )!;
      } catch {
        throw Error("APPROVAL_STALE");
      }
      if (batch.status !== "approved") throw Error("STALE_VERSION");
      const permissionSnapshot = await permissions(
        db,
        ctx,
        batch.updates,
        batch.snapshots.map((s) => s.id),
        (batch as RuntimeBatch).contextDependencyIds,
      );
      Object.assign(batch, { reviewWarnings: permissionSnapshot.warnings });
      await db.query(
        "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id, batch],
      );
      await db.query(
        "INSERT INTO approvals(workspace_id,batch_id,principal_id,hash,acl_hash,policy_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,batch_id,principal_id) DO UPDATE SET hash=excluded.hash,acl_hash=excluded.acl_hash,policy_version=excluded.policy_version,at=clock_timestamp()",
        [
          ctx.workspaceId,
          id,
          ctx.principalId,
          hash,
          permissionSnapshot.hash,
          qualification?.policy_version ?? null,
        ],
      );
      await audit(
        db,
        ctx,
        qualification?.personal ? "personal.save.review-free" : "batch.approve",
        id,
      );
      if (permissionSnapshot.warnings.length) return { warnings: permissionSnapshot.warnings };
    },
    { principalId: ctx.principalId, operation: "batch.approve" },
  );
}

export async function publish(
  pool: Pool,
  ctx: Context,
  id: string,
  hash: string,
  key: string,
): Promise<{
  batchId: string;
  versions: Record<string, number>;
  warnings?: PropertyWarning[];
}> {
  return transaction(
    pool,
    ctx.workspaceId,
    async (db) => {
      if (!key.trim() || key.length > 200) throw Error("VALIDATION_FAILED");
      const batch = await checkedBatch(db, ctx, id, hash);
      const qualification = await reviewQualification(db, ctx, id, false);
      const requestHash = digest([id, hash]);
      const replay = await db.query(
        "SELECT hash,result FROM requests WHERE workspace_id=$1 AND principal_id=$2 AND key=$3",
        [ctx.workspaceId, ctx.principalId, key],
      );
      if (replay.rowCount) {
        if (replay.rows[0].hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return replay.rows[0].result;
      }
      const receipt = await db.query(
        "SELECT result FROM publications WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, id],
      );
      let result: {
        batchId: string;
        versions: Record<string, number>;
        warnings?: PropertyWarning[];
      };
      if (receipt.rowCount) result = receipt.rows[0].result;
      else {
        const approval = await db.query(
          "SELECT hash,acl_hash,principal_id,policy_version FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, id],
        );
        if (!approval.rowCount || approval.rows[0].hash !== hash)
          throw Error("APPROVAL_STALE");
        const permissionSnapshot = await permissions(
          db,
          ctx,
          batch.updates,
          batch.snapshots.map((s) => s.id),
          (batch as RuntimeBatch).contextDependencyIds,
        );
        if (permissionSnapshot.hash !== approval.rows[0].acl_hash)
          throw Error("APPROVAL_STALE");
        if (qualification) {
          let valid = 0;
          for (const ap of approval.rows) {
            if (
              ap.hash !== hash ||
              ap.acl_hash !== permissionSnapshot.hash ||
              ap.policy_version !== qualification.policy_version
            )
              continue;
            if (
              !qualification.personal &&
              ap.principal_id === qualification.authorId
            )
              continue;
            try {
              await reviewQualification(
                db,
                { workspaceId: ctx.workspaceId, principalId: ap.principal_id },
                id,
                true,
              );
              await permissions(
                db,
                { workspaceId: ctx.workspaceId, principalId: ap.principal_id },
                batch.updates,
                batch.snapshots.map((s) => s.id),
                (batch as RuntimeBatch).contextDependencyIds,
              );
              valid++;
            } catch {
              /* Revoked or newly restricted approvals never qualify. */
            }
          }
          if (
            valid <
            (qualification.personal ? 1 : qualification.minimum_approvals)
          )
            throw Error("APPROVAL_STALE");
          await authorizeActionDb(
            db,
            {
              workspaceId: ctx.workspaceId,
              principalId: qualification.authorId,
            },
            "changeset.propose",
          );
        }
        const state = await loadState(db, ctx.workspaceId);
        let next;
        try {
          next = decideBatch(state, id, "publish");
        } catch {
          throw Error("APPROVAL_STALE");
        }
        const published = memory(next).batches.find((b) => b.id === id)!;
        if (published.status !== "published") throw Error("STALE_VERSION");
        const versions: Record<string, number> = {};
        const proposerRow = await db.query(
          "SELECT principal_id FROM access_batch_authors WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, id],
        );
        const originalAuthor =
          proposerRow.rows[0]?.principal_id ??
          (
            await db.query(
              "SELECT principal_id FROM audit WHERE workspace_id=$1 AND operation='batch.propose' AND resource_id=$2 ORDER BY at LIMIT 1",
              [ctx.workspaceId, id],
            )
          ).rows[0]?.principal_id ??
          null;
        for (const d of batch.updates) {
          const p = next.pages.find((p) => p.id === d.id)!;
          const { versions: history, ...metadata } = p;
          delete metadata.verifiedAt;
          if (qualification?.personal) {
            metadata.status = "미검증";
            metadata.owner = qualification.authorId;
          }
          const old = state.pages.find((p) => p.id === d.id);
          if (old?.status === "공식 기준") metadata.status = "공식 기준";
          const inherited = old
            ? inheritedProvenance(old)
            : { pageIds: [], sourceIds: [] };
          const dependencyIds = [
            ...new Set([
              ...inherited.pageIds,
              ...d.links,
              ...((batch as RuntimeBatch).contextDependencyIds ?? []),
            ]),
          ].filter((id) => id !== d.id);
          const provenance: Provenance = {
            pageIds: dependencyIds,
            sourceIds: [
              ...new Set([
                ...inherited.sourceIds,
                ...d.sourceIds,
                ...dependencyIds.flatMap((id) => {
                  const p = state.pages.find((p) => p.id === id);
                  return p ? inheritedProvenance(p).sourceIds : [];
                }),
              ]),
            ],
          };
          const v = {
            ...history.at(-1)!,
            author: ctx.principalId,
            batchId: id,
            proposedBy: originalAuthor,
            responsibleUserId:
              (batch as RuntimeBatch).responsibleUserId ?? originalAuthor,
            publishedBy: ctx.principalId,
            producer: (batch as RuntimeBatch).producer ?? { kind: "unknown" },
            provenance,
            sourceIds: [
              ...new Set([
                ...history.at(-1)!.sourceIds,
                ...provenance.sourceIds,
              ]),
            ],
          };
          if (d.baseVersion === 0)
            await addResource(
              db,
              ctx.workspaceId,
              "page",
              d.id,
              permissionSnapshot.audiences.get(d.id)!,
            );
          await db.query(
            "INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3) ON CONFLICT(workspace_id,id) DO UPDATE SET data=excluded.data",
            [ctx.workspaceId, d.id, metadata],
          );
          await db.query("INSERT INTO versions VALUES($1,$2,$3,$4)", [
            ctx.workspaceId,
            d.id,
            v.number,
            v,
          ]);
          versions[d.id] = v.number;
        }
        // Source bodies remain unchanged; processing state is separate from the immutable input.
        await db.query(
          "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id, published],
        );
        result = {
          batchId: id,
          versions,
          ...(permissionSnapshot.warnings.length ? { warnings: permissionSnapshot.warnings } : {}),
        };
        await db.query("INSERT INTO publications VALUES($1,$2,$3)", [
          ctx.workspaceId,
          id,
          result,
        ]);
        await audit(db, ctx, "batch.publish", id);
      }
      await db.query("INSERT INTO requests VALUES($1,$2,$3,$4,$5)", [
        ctx.workspaceId,
        ctx.principalId,
        key,
        requestHash,
        result,
      ]);
      return result;
    },
    { principalId: ctx.principalId, operation: "batch.publish" },
  );
}
