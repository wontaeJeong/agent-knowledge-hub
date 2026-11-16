import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import { authorizeActionDb, effectiveAccess } from "../access/index";
import { fingerprint } from "../provenance";
import { appendOperationalAudit } from "../operations/service";
import { selectErasureRows, type ProductRow } from "../operations/erasure";
import { inventory, unknownPrivateReference } from "./inventory";
import { allContentReferences } from "../../scripts/k8s/operations-storage-graph.mjs";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const selectionItem = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attachment-version"),
      slotId: id,
      revision: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("runtime-answer"), id }).strict(),
  z.object({ kind: z.literal("runtime-job"), id }).strict(),
]);
export const selectionSchema = z
  .object({ selection: z.array(selectionItem).min(1).max(100) })
  .strict()
  .superRefine((d, ctx) => {
    if (
      new Set(d.selection.map((x) => fingerprint(x))).size !==
      d.selection.length
    )
      ctx.addIssue({ code: "custom", message: "DUPLICATE_SELECTION" });
  });
type Selection = z.infer<typeof selectionItem>;
type Resource = { kind: "page" | "source"; id: string };
type Candidate = {
  selection: Selection;
  eligible: boolean;
  reasons: string[];
  ownerId: string;
  resource?: Resource;
  blobId?: string;
  contentHash?: string;
  artifactId: string;
  lineage: Resource[];
  retainedBy: { table: string; id: string }[];
};
const opaqueTables = new Set([
  "board_posts",
  "board_comments",
  "question_turns",
  "question_feedback",
  "question_feedback_work",
  "agent_outcomes",
  "agent_personal_pages",
  "agent_personal_revisions",
  "agent_requests",
  "imports",
]);
function targetRow(r: ProductRow, s: Selection) {
  return s.kind === "attachment-version"
    ? r.table === "storage_attachment_versions" &&
        r.data.slot_id === s.slotId &&
        Number(r.data.revision) === s.revision
    : r.table ===
        (s.kind === "runtime-answer" ? "runtime_answers" : "runtime_jobs") &&
        r.data.id === s.id;
}
function rowIdentity(r: ProductRow) {
  return {
    table: r.table,
    id: String(r.data.id ?? r.data.page_id ?? r.data.slot_id ?? "unattributed"),
  };
}
/** Bodies remain inside PostgreSQL. IDs in private bodies are conservatively treated as references. */
async function privateMentions(
  db: PoolClient,
  workspaceId: string,
  rows: ProductRow[],
  tokens: string[],
  excluded: ProductRow[],
) {
  const result: ProductRow[] = [];
  for (const table of new Set(
    rows.filter((r) => !excluded.includes(r)).map((r) => r.table),
  )) {
    // inventory has already validated the explicit table/scope set; inspect only
    // rows with workspace_id here. Non-workspace child rows are handled in inventory.
    const locators = rows
      .filter((r) => r.table === table && !excluded.includes(r))
      .map((r) => r.locator);
    const found = await db.query(
      `SELECT t.ctid::text AS locator FROM "${table}" t WHERE t.ctid::text=ANY($1::text[]) AND EXISTS(SELECT 1 FROM unnest($2::text[]) token WHERE position(token in to_jsonb(t)::text)>0)`,
      [locators, tokens],
    );
    for (const f of found.rows) {
      const row = rows.find(
        (r) => r.table === table && r.locator === f.locator,
      );
      if (row) result.push(row);
    }
  }
  return result;
}
async function currentPolicy(db: PoolClient, workspaceId: string) {
  const r = (
    await db.query(
      "SELECT revision,policy FROM content_retention_policies WHERE workspace_id=$1",
      [workspaceId],
    )
  ).rows[0];
  return r ?? { revision: 0, policy: null };
}
async function assertAccess(db: PoolClient, ctx: Context, c: Candidate) {
  for (const r of c.lineage) {
    await authorizeActionDb(db, ctx, "knowledge.read", r);
    if (r.kind === "page")
      for (const v of (
        await db.query(
          "SELECT number FROM versions WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, r.id],
        )
      ).rows)
        await authorizeActionDb(db, ctx, "knowledge.read", {
          ...r,
          version: v.number,
        });
  }
}
async function pruningGraph(db: PoolClient, ctx: Context) {
  const rows = (await inventory(db, ctx.workspaceId)).filter(
      (r) => r.table !== "content_retention_plans",
    ),
    storage = await allContentReferences(db);
  const policy = await currentPolicy(db, ctx.workspaceId),
    holds = (
      await db.query(
        "SELECT * FROM operations_legal_holds WHERE workspace_id=$1 AND active ORDER BY id",
        [ctx.workspaceId],
      )
    ).rows;
  const classHolds = (
    await db.query(
      "SELECT content_class FROM content_retention_holds WHERE workspace_id=$1 ORDER BY content_class",
      [ctx.workspaceId],
    )
  ).rows;
  const shares = (
    await db.query(
      "SELECT * FROM access_shares WHERE workspace_id=$1 ORDER BY id",
      [ctx.workspaceId],
    )
  ).rows;
  const acl = (
    await db.query(
      "SELECT * FROM resource_readers WHERE workspace_id=$1 ORDER BY kind,resource_id,principal_id",
      [ctx.workspaceId],
    )
  ).rows;
  const accessPolicy = (
    await db.query("SELECT * FROM access_spaces WHERE workspace_id=$1", [
      ctx.workspaceId,
    ])
  ).rows;
  return {
    rows,
    storage,
    policy,
    holds,
    classHolds,
    shares,
    acl,
    accessPolicy,
  };
}
/** Exact supported artifact classes only. All unknown schemas and unlineaged private consumers fail closed. */
export async function previewPruning(
  db: PoolClient,
  ctx: Context,
  input: unknown,
  recovery = false,
  graph?: Awaited<ReturnType<typeof pruningGraph>>,
) {
  if (!recovery) await authorizeActionDb(db, ctx, "space.admin");
  const d = selectionSchema.parse(input);
  const {
    rows,
    storage,
    policy,
    holds,
    classHolds,
    shares,
    acl,
    accessPolicy,
  } = graph ?? (await pruningGraph(db, ctx));
  const chosen = rows.filter((r) => d.selection.some((s) => targetRow(r, s)));
  const records: Candidate[] = [];
  for (const s of d.selection) {
    const row = rows.find((r) => targetRow(r, s));
    if (!row) throw Error("NOT_FOUND");
    const reasons: string[] = [],
      lineage: Resource[] = [];
    let retainedAt: unknown = row.data.created_at;
    let blobId: string | undefined,
      contentHash: string | undefined,
      resource: Resource | undefined;
    let ownerId = String(row.data.principal_id ?? ""),
      artifactId = s.kind === "attachment-version" ? "" : s.id;
    let excluded = [row],
      tokens = s.kind === "attachment-version" ? [s.slotId] : [s.id];
    if (s.kind === "attachment-version") {
      const slot = rows.find(
          (r) =>
            r.table === "storage_attachment_slots" && r.data.id === s.slotId,
        ),
        blob = rows.find(
          (r) => r.table === "storage_blobs" && r.data.id === row.data.blob_id,
        );
      if (
        !slot ||
        !blob ||
        slot.data.parent_kind !== blob.data.parent_kind ||
        slot.data.parent_id !== blob.data.parent_id
      )
        throw Error("RETENTION_GRAPH_UNSUPPORTED");
      resource = {
        kind: z.enum(["page", "source"]).parse(slot.data.parent_kind),
        id: id.parse(slot.data.parent_id),
      };
      lineage.push(resource);
      ownerId = String(blob.data.created_by);
      retainedAt = blob.data.created_at;
      blobId = String(blob.data.id);
      contentHash = String(blob.data.sha256);
      artifactId = `${s.slotId}/${s.revision}/${blobId}`;
      tokens = [blobId, contentHash];
      excluded = [row, blob, slot];
      if (
        slot.data.head_id === blobId ||
        Number(slot.data.revision) <= s.revision
      )
        reasons.push("CURRENT_VERSION");
      if (
        (
          await db.query(
            "SELECT 1 FROM storage_tickets WHERE workspace_id=$1 AND blob_id=$2 AND NOT revoked LIMIT 1",
            [ctx.workspaceId, blobId],
          )
        ).rowCount
      )
        reasons.push("ACTIVE_DOWNLOAD_TICKET");
      const affected = selectErasureRows(rows, resource);
      if (
        resource.kind === "source" &&
        affected.some((r) => r.table === "versions")
      )
        reasons.push("RETAINED_SOURCE_EVIDENCE");
      if (
        shares.some((sh) =>
          affected.some(
            (r) =>
              r.table === "versions" &&
              r.data.page_id === sh.page_id &&
              Number(r.data.number) === sh.version,
          ),
        )
      )
        reasons.push("FIXED_SHARED_ANCESTRY");
      if (
        rows.some(
          (r) =>
            r.table === "storage_blobs" &&
            r !== blob &&
            r.data.sha256 === contentHash,
        ) ||
        storage.some(
          (ref) =>
            ref.sha256 === contentHash &&
            (ref.workspace_id !== ctx.workspaceId ||
              ref.owner_kind !== "resource" ||
              ref.parent_kind !== resource!.kind ||
              ref.owner_id !== resource!.id),
        )
      )
        reasons.push("SHARED_LIVE_BLOB");
      // All historical page dependencies remain part of source ceilings and legal holds.
      if (resource.kind === "page")
        for (const v of rows.filter(
          (r) => r.table === "versions" && r.data.page_id === resource!.id,
        )) {
          const data = v.data.data as {
            sourceIds?: string[];
            provenance?: { sourceIds?: string[]; pageIds?: string[] };
            pageIds?: string[];
            dependencyVersions?: Record<string, number>;
          };
          for (const src of new Set([
            ...(data.sourceIds ?? []),
            ...(data.provenance?.sourceIds ?? []),
          ]))
            lineage.push({ kind: "source", id: src });
          for (const p of new Set([
            ...(data.pageIds ?? []),
            ...(data.provenance?.pageIds ?? []),
            ...Object.keys(data.dependencyVersions ?? {}),
          ]))
            lineage.push({ kind: "page", id: p });
        }
    } else if (s.kind === "runtime-answer") {
      const data = (
        await db.query(
          `SELECT jsonb_build_object('at',data->'at','pageIds',data->'inputEnvelope'->'pageIds','sourceIds',data->'inputEnvelope'->'sourceIds','citations',(SELECT coalesce(jsonb_agg(jsonb_build_object('pageId',c->'pageId','version',c->'version')),'[]') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'citations')='array' THEN data->'citations' ELSE '[]'::jsonb END) c)) AS lineage FROM runtime_answers WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId, s.id],
        )
      ).rows[0].lineage;
      retainedAt = data.at;
      const parsed = z
        .object({
          pageIds: z.array(id),
          sourceIds: z.array(id),
          citations: z.array(
            z.object({ pageId: id, version: z.number().int().positive() }),
          ),
        })
        .safeParse(data);
      if (!parsed.success) reasons.push("UNKNOWN_LINEAGE");
      else {
        for (const pageId of new Set([
          ...parsed.data.pageIds,
          ...parsed.data.citations.map((c) => c.pageId),
        ]))
          lineage.push({ kind: "page", id: pageId });
        for (const sourceId of parsed.data.sourceIds)
          lineage.push({ kind: "source", id: sourceId });
        if (!recovery)
          for (const c of parsed.data.citations)
            await authorizeActionDb(db, ctx, "knowledge.read", {
              kind: "page",
              id: c.pageId,
              version: c.version,
            });
      }
      excluded = chosen.filter(
        (r) => r.table === "runtime_answers" || r.table === "runtime_jobs",
      );
    } else {
      if (!["succeeded", "failed"].includes(String(row.data.status)))
        reasons.push("RUNNING_JOB");
      if (
        row.data.result_id &&
        !d.selection.some(
          (other) =>
            other.kind === "runtime-answer" && other.id === row.data.result_id,
        )
      )
        reasons.push("RETAINED_RESULT");
      excluded = chosen.filter((r) => r.table === "runtime_jobs");
    }
    const minimumClass =
      s.kind === "attachment-version"
        ? resource?.kind === "source"
          ? "sourceVersions"
          : "publishedVersions"
        : "runtimeResults";
    const minimum = policy.policy?.[minimumClass];
    if (typeof minimum === "number") {
      const at = new Date(String(retainedAt)).getTime();
      if (!Number.isFinite(at)) reasons.push("AGE_UNAVAILABLE");
      else if (Date.now() - at < minimum * 86400000)
        reasons.push("MINIMUM_RETENTION_PERIOD");
    }
    const expanded = new Set<string>();
    for (let n = 0; n < lineage.length; n++) {
      const ref = lineage[n],
        key = `${ref.kind}:${ref.id}`;
      if (expanded.has(key)) continue;
      expanded.add(key);
      if (lineage.length > 1000) throw Error("RETENTION_GRAPH_BOUND");
      if (ref.kind === "page")
        for (const r of rows.filter(
          (r) => r.table === "versions" && r.data.page_id === ref.id,
        )) {
          const data = r.data.data as {
            sourceIds?: string[];
            pageIds?: string[];
            provenance?: { sourceIds?: string[]; pageIds?: string[] };
            dependencyVersions?: Record<string, number>;
          };
          for (const src of new Set([
            ...(data.sourceIds ?? []),
            ...(data.provenance?.sourceIds ?? []),
          ]))
            if (!expanded.has(`source:${src}`))
              lineage.push({ kind: "source", id: src });
          for (const pageId of new Set([
            ...(data.pageIds ?? []),
            ...(data.provenance?.pageIds ?? []),
            ...Object.keys(data.dependencyVersions ?? {}),
          ]))
            if (!expanded.has(`page:${pageId}`))
              lineage.push({ kind: "page", id: pageId });
        }
    }
    const rawReferences = await privateMentions(
      db,
      ctx.workspaceId,
      rows,
      tokens,
      excluded,
    );
    const unknown = rows.filter(
      (r) =>
        !excluded.includes(r) &&
        (opaqueTables.has(r.table) ||
          (unknownPrivateReference(r) && r.table !== "runtime_answers")),
    );
    // Other structured answers have a complete typed input envelope; malformed ones remain unknown.
    const otherAnswers = (
      await db.query(
        "SELECT id FROM runtime_answers WHERE workspace_id=$1 AND NOT (coalesce(jsonb_typeof(data->'inputEnvelope'->'pageIds'),'null')='array' AND coalesce(jsonb_typeof(data->'inputEnvelope'->'sourceIds'),'null')='array' AND coalesce(jsonb_typeof(data->'citations'),'null')='array')",
        [ctx.workspaceId],
      )
    ).rows;
    if (
      otherAnswers.some(
        (a) =>
          !chosen.some(
            (r) => r.table === "runtime_answers" && r.data.id === a.id,
          ),
      )
    )
      reasons.push("UNKNOWN_REFERENCE");
    if (unknown.length) reasons.push("UNKNOWN_REFERENCE");
    if (rawReferences.length) reasons.push("RETAINED_REFERENCE");
    const selectedLineage = new Set(lineage.map((r) => `${r.kind}:${r.id}`));
    if (
      holds.some(
        (h) =>
          h.resource_kind === "workspace" ||
          selectedLineage.has(`${h.resource_kind}:${h.resource_id}`) ||
          selectErasureRows(rows, {
            kind: h.resource_kind,
            id: h.resource_id,
          }).includes(row),
      ) ||
      classHolds.some(
        (h) =>
          h.content_class ===
          (s.kind === "attachment-version"
            ? "sourceVersions"
            : "runtimeResults"),
      )
    )
      reasons.push("LEGAL_HOLD");
    const c: Candidate = {
      selection: s,
      eligible: !reasons.length,
      reasons: [...new Set(reasons)],
      ownerId,
      resource,
      blobId,
      contentHash,
      artifactId,
      lineage,
      retainedBy: [...new Set([...rawReferences, ...unknown])].map(rowIdentity),
    };
    if (!recovery) await assertAccess(db, ctx, c);
    records.push(c);
  }
  // Intent/review rows are not product evidence. Their own state transitions do
  // not invalidate the graph; all product content and current ACL/policy do.
  const graphRows = rows.filter((r) => r.table !== "content_retention_plans");
  const graphHash = fingerprint({
    selection: d.selection,
    rows: graphRows,
    storage,
    policy,
    holds,
    classHolds,
    shares,
    acl,
    accessPolicy,
    records,
  });
  return {
    hash: graphHash,
    policyRevision: Number(policy.revision),
    records,
    total: records.length,
    eligible: records.filter((r) => r.eligible).length,
    allCopiesErased: false as const,
  };
}
export async function planPruning(
  db: PoolClient,
  ctx: Context,
  input: unknown,
) {
  if (!(await effectiveAccess(db, ctx)).space.owner)
    throw Error("OWNER_REQUIRED");
  const d = z
    .object({
      selection: z.array(selectionItem).min(1).max(100),
      previewHash: hash,
      policyRevision: z.number().int().nonnegative(),
    })
    .strict()
    .parse(input);
  const p = await previewPruning(db, ctx, { selection: d.selection });
  if (p.hash !== d.previewHash || p.policyRevision !== d.policyRevision)
    throw Error("RETENTION_PREVIEW_STALE");
  if (p.records.some((r) => !r.eligible))
    throw Error("RETENTION_SELECTION_BLOCKED");
  const planId = randomUUID();
  await db.query(
    "INSERT INTO content_retention_plans(workspace_id,id,requested_by,selection,preview_hash,policy_revision,state) VALUES($1,$2,$3,$4,$5,$6,'pending')",
    [
      ctx.workspaceId,
      planId,
      ctx.principalId,
      JSON.stringify(d.selection),
      p.hash,
      p.policyRevision,
    ],
  );
  await appendOperationalAudit(db, ctx, {
    operation: "retention.pruning.plan",
  });
  return {
    id: planId,
    previewHash: p.hash,
    policyRevision: p.policyRevision,
    state: "pending",
  };
}
async function loadPlan(db: PoolClient, ctx: Context, planId: string) {
  const p = (
    await db.query(
      "SELECT * FROM content_retention_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [ctx.workspaceId, planId],
    )
  ).rows[0];
  if (!p) throw Error("NOT_FOUND");
  return p;
}
export async function reviewPruning(
  db: PoolClient,
  ctx: Context,
  input: unknown,
) {
  await authorizeActionDb(db, ctx, "space.admin");
  const d = z
      .object({
        planId: id,
        previewHash: hash,
        decision: z.enum(["approve", "reject"]),
      })
      .strict()
      .parse(input),
    p = await loadPlan(db, ctx, d.planId);
  if (p.state !== "pending") throw Error("RETENTION_REVIEW_REQUIRED");
  if (p.requested_by === ctx.principalId)
    throw Error("INDEPENDENT_REVIEW_REQUIRED");
  if (new Date(p.expires_at).getTime() <= Date.now())
    throw Error("RETENTION_PLAN_EXPIRED");
  const preview = await previewPruning(db, ctx, { selection: p.selection });
  if (preview.records.some((r) => r.ownerId === ctx.principalId))
    throw Error("INDEPENDENT_REVIEW_REQUIRED");
  if (preview.hash !== p.preview_hash || d.previewHash !== p.preview_hash)
    throw Error("RETENTION_PREVIEW_STALE");
  if (preview.records.some((r) => !r.eligible))
    throw Error("RETENTION_SELECTION_BLOCKED");
  await db.query(
    "UPDATE content_retention_plans SET state=$3,reviewed_by=$4,review_hash=$5 WHERE workspace_id=$1 AND id=$2",
    [
      ctx.workspaceId,
      p.id,
      d.decision === "approve" ? "approved" : "rejected",
      ctx.principalId,
      p.preview_hash,
    ],
  );
  await appendOperationalAudit(db, ctx, {
    operation: `retention.pruning.${d.decision}`,
  });
  return {
    id: p.id,
    state: d.decision === "approve" ? "approved" : "rejected",
    previewHash: p.preview_hash,
  };
}
async function removeCandidates(
  db: PoolClient,
  workspaceId: string,
  records: Candidate[],
) {
  for (const c of records) {
    const s = c.selection;
    if (s.kind === "attachment-version") {
      if (
        !(
          await db.query(
            "DELETE FROM storage_attachment_versions WHERE workspace_id=$1 AND slot_id=$2 AND revision=$3 AND blob_id=$4 RETURNING revision",
            [workspaceId, s.slotId, s.revision, c.blobId],
          )
        ).rowCount
      )
        throw Error("RETENTION_PREVIEW_STALE");
      await db.query(
        "DELETE FROM storage_tickets WHERE workspace_id=$1 AND blob_id=$2 AND revoked",
        [workspaceId, c.blobId],
      );
      if (
        !(
          await db.query(
            "DELETE FROM storage_blobs WHERE workspace_id=$1 AND id=$2 AND sha256=$3 RETURNING id",
            [workspaceId, c.blobId, c.contentHash],
          )
        ).rowCount
      )
        throw Error("RETENTION_PREVIEW_STALE");
    } else {
      const table =
        s.kind === "runtime-answer" ? "runtime_answers" : "runtime_jobs";
      if (
        !(
          await db.query(
            `DELETE FROM "${table}" WHERE workspace_id=$1 AND id=$2 RETURNING id`,
            [workspaceId, s.id],
          )
        ).rowCount
      )
        throw Error("RETENTION_PREVIEW_STALE");
    }
  }
}
export async function executePruning(
  db: PoolClient,
  ctx: Context,
  input: unknown,
) {
  await authorizeActionDb(db, ctx, "space.admin");
  if (!(await effectiveAccess(db, ctx)).space.owner)
    throw Error("OWNER_REQUIRED");
  const d = z.object({ planId: id, previewHash: hash }).strict().parse(input),
    p = await loadPlan(db, ctx, d.planId);
  if (p.requested_by !== ctx.principalId) throw Error("FORBIDDEN");
  if (
    !p.reviewed_by ||
    p.review_hash !== d.previewHash ||
    p.preview_hash !== d.previewHash ||
    !["approved", "executed"].includes(p.state)
  )
    throw Error("RETENTION_REVIEW_REQUIRED");
  await authorizeActionDb(
    db,
    { workspaceId: ctx.workspaceId, principalId: p.reviewed_by },
    "space.admin",
  );
  if (p.state === "executed") return p.receipt;
  if (new Date(p.expires_at).getTime() <= Date.now())
    throw Error("RETENTION_PLAN_EXPIRED");
  const preview = await previewPruning(db, ctx, { selection: p.selection });
  if (
    preview.hash !== p.preview_hash ||
    preview.policyRevision !== p.policy_revision
  )
    throw Error("RETENTION_PREVIEW_STALE");
  if (preview.records.some((r) => !r.eligible))
    throw Error("RETENTION_SELECTION_BLOCKED");
  for (const c of preview.records)
    await assertAccess(
      db,
      { workspaceId: ctx.workspaceId, principalId: p.reviewed_by },
      c,
    );
  for (const c of preview.records)
    await db.query(
      "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.workspaceId,
        c.selection.kind,
        c.artifactId,
        JSON.stringify(c.contentHash ? [c.contentHash] : []),
        p.preview_hash,
        ctx.principalId,
      ],
    );
  await removeCandidates(db, ctx.workspaceId, preview.records);
  const physicalPurgePending = preview.records.filter(
    (r) => r.contentHash,
  ).length;
  const receipt = {
    id: randomUUID(),
    status: physicalPurgePending ? "blocked" : "completed",
    deleted: preview.records.length,
    physicalPurgePending,
    allCopiesErased: false,
    previewHash: p.preview_hash,
    policyRevision: p.policy_revision,
    reviewedBy: p.reviewed_by,
    errorCode: physicalPurgePending ? "PHYSICAL_BLOB_PURGE_REQUIRED" : null,
  };
  await db.query(
    "INSERT INTO content_retention_receipts(workspace_id,id,preview_hash,policy_revision,status,actor,details) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      ctx.workspaceId,
      receipt.id,
      p.preview_hash,
      p.policy_revision,
      receipt.status,
      ctx.principalId,
      receipt,
    ],
  );
  await db.query(
    "UPDATE content_retention_plans SET state='executed',receipt=$3 WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, p.id, receipt],
  );
  await appendOperationalAudit(db, ctx, {
    operation: "retention.pruning.execute",
  });
  return receipt;
}
export async function listPruning(db: PoolClient, ctx: Context) {
  await authorizeActionDb(db, ctx, "space.admin");
  const graph = await pruningGraph(db, ctx),
    rows = graph.rows,
    selection: Selection[] = [];
  for (const r of rows) {
    if (r.table === "storage_attachment_versions")
      selection.push({
        kind: "attachment-version",
        slotId: String(r.data.slot_id),
        revision: Number(r.data.revision),
      });
    if (r.table === "runtime_answers")
      selection.push({ kind: "runtime-answer", id: String(r.data.id) });
    if (r.table === "runtime_jobs")
      selection.push({ kind: "runtime-job", id: String(r.data.id) });
  }
  const items = [];
  for (const s of selection.slice(0, 100))
    try {
      const p = await previewPruning(db, ctx, { selection: [s] }, false, graph);
      items.push(...p.records);
    } catch (e) {
      if (
        !(e instanceof Error) ||
        !["NOT_FOUND", "FORBIDDEN"].includes(e.message)
      )
        throw e;
    }
  const plans = (
    await db.query(
      "SELECT id,requested_by,preview_hash,policy_revision,state,reviewed_by,created_at,expires_at,selection FROM content_retention_plans WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",
      [ctx.workspaceId],
    )
  ).rows;
  const visiblePlans = [];
  for (const p of plans) {
    if (p.state === "executed") {
      if (
        p.requested_by === ctx.principalId ||
        p.reviewed_by === ctx.principalId
      )
        visiblePlans.push(p);
      continue;
    }
    try {
      await previewPruning(db, ctx, { selection: p.selection }, false, graph);
      visiblePlans.push(p);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !["NOT_FOUND", "FORBIDDEN"].includes(error.message)
      )
        throw error;
    }
  }
  return { items, plans: visiblePlans, truncated: selection.length > 100 };
}
/** Called only in restore quarantine after importing the current signed artifact ledger. */
export async function replayGranularPruning(
  db: PoolClient,
  workspaceId: string,
) {
  if (
    !(
      await db.query(
        "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND classid=0 AND objid=822025 AND mode='ExclusiveLock'",
      )
    ).rowCount
  )
    throw Error("RETENTION_EXCLUSIVE_GATE_REQUIRED");
  const retired = (
    await db.query(
      "SELECT artifact_kind,artifact_id,hashes FROM operations_erased_artifacts WHERE workspace_id=$1 AND artifact_kind IN('attachment-version','runtime-answer','runtime-job') ORDER BY artifact_kind,artifact_id",
      [workspaceId],
    )
  ).rows;
  const selection: Selection[] = [];
  for (const a of retired) {
    if (a.artifact_kind === "attachment-version") {
      const [slotId, revision, blobId] = String(a.artifact_id).split("/");
      const existing = (
        await db.query(
          "SELECT blob_id FROM storage_attachment_versions WHERE workspace_id=$1 AND slot_id=$2 AND revision=$3",
          [workspaceId, slotId, Number(revision)],
        )
      ).rows[0];
      const blob = (
        await db.query(
          "SELECT sha256 FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
          [workspaceId, blobId],
        )
      ).rows[0];
      if (!existing && !blob) continue;
      if (
        !existing ||
        existing.blob_id !== blobId ||
        !blob ||
        !a.hashes.includes(blob.sha256)
      )
        throw Error("RETENTION_REPLAY_REFERENCE_CONFLICT");
      selection.push(
        selectionItem.parse({
          kind: a.artifact_kind,
          slotId,
          revision: Number(revision),
        }),
      );
    } else {
      const table =
        a.artifact_kind === "runtime-answer"
          ? "runtime_answers"
          : "runtime_jobs";
      if (
        (
          await db.query(
            `SELECT 1 FROM "${table}" WHERE workspace_id=$1 AND id=$2`,
            [workspaceId, a.artifact_id],
          )
        ).rowCount
      )
        selection.push(
          selectionItem.parse({ kind: a.artifact_kind, id: a.artifact_id }),
        );
    }
  }
  if (!selection.length) return;
  if (selection.length > 100) throw Error("RETENTION_GRAPH_BOUND");
  const preview = await previewPruning(
    db,
    { workspaceId, principalId: "signed-recovery-ledger" },
    { selection },
    true,
  );
  if (preview.records.some((r) => !r.eligible))
    throw Error("RETENTION_REPLAY_REFERENCE_CONFLICT");
  await removeCandidates(db, workspaceId, preview.records);
}
