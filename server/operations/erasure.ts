import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import { effectiveAccess } from "../access/index";
import { requireRead } from "../repository";
import { MUTATION_GATE } from "./gate";
import { appendOperationalAudit, type OperationsService } from "./service";
import {
  allContentReferences,
  hashHasLiveReference,
} from "../../scripts/k8s/operations-storage-graph.mjs";
import {
  releasedImportTables,
  redactReleasedImportRow,
  unmappedReleasedImports,
  releasedImportProjection,
} from "./released-imports";
type Resource = { kind: "source" | "page"; id: string };
export interface ProductRow {
  table: string;
  locator: string;
  data: Record<string, unknown>;
}
const tablePattern =
  /^(sources|pages|versions|batches|requests|publications|approvals|workflow_[a-z_]+|runtime_(answers|lints|jobs)|agent_[a-z_]+|refinement_[a-z_]+|durable_(jobs|job_outbox|model_calls)|storage_(imports|import_sources|import_effects|snapshots|attachment_links))$/;
const identityColumns =
  /^(id|workspace_id|principal_id|owner_id|created_by|recorded_by|reviewed_by|approved_by|actor_id|kind|state|status|operation|role|scope|parent_kind|[a-z_]+_id|[a-z_]+_hash|sha256|mime|provider|model|key|token_hash)$/;
const referenceKeys: Record<string, string> = {
  sourceId: "source",
  source_id: "source",
  sourceIds: "source",
  source_ids: "source",
  sources: "source",
  pages: "page",
  pageId: "page",
  page_id: "page",
  pageIds: "page",
  page_ids: "page",
  dependencyVersions: "page",
  baseVersions: "page",
  usedVersions: "page",
  batchId: "batch",
  batch_id: "batch",
  answerId: "answer",
  answer_id: "answer",
  jobId: "job",
  job_id: "job",
  outcomeId: "outcome",
  outcome_id: "outcome",
  claimId: "claim",
  claim_id: "claim",
  claimIds: "claim",
  evidenceId: "evidence",
  evidence_id: "evidence",
  evidenceIds: "evidence",
  import_id: "import",
  importId: "released-import",
  importRunId: "released-run",
  draftId: "draft",
  draft_id: "draft",
  template_id: "template",
  comment_id: "comment",
};
function refs(value: unknown, result = new Set<string>(), key = "") {
  if (referenceKeys[key]) {
    const kind = referenceKeys[key];
    if (typeof value === "string") result.add(`${kind}:${value}`);
    else if (Array.isArray(value))
      for (const v of value) {
        if (typeof v === "string") result.add(`${kind}:${v}`);
        else if (
          v &&
          typeof v === "object" &&
          "id" in v &&
          typeof v.id === "string"
        )
          result.add(`${kind}:${v.id}`);
        else if (v && typeof v === "object" && "pageId" in v)
          result.add(`page:${(v as { pageId: string }).pageId}`);
      }
    else if (value && typeof value === "object")
      for (const k of Object.keys(value)) result.add(`${kind}:${k}`);
  }
  if (Array.isArray(value)) for (const v of value) refs(v, result);
  else if (value && typeof value === "object") {
    const d = value as Record<string, unknown>;
    if ((d.kind === "source" || d.kind === "page") && typeof d.id === "string")
      result.add(`${d.kind}:${d.id}`);
    if (
      (d.parent_kind === "source" || d.parent_kind === "page") &&
      typeof d.parent_id === "string"
    )
      result.add(`${d.parent_kind}:${d.parent_id}`);
    if (
      (d.rootKind === "source" || d.rootKind === "page") &&
      typeof d.rootId === "string"
    )
      result.add(`${d.rootKind}:${d.rootId}`);
    for (const [k, v] of Object.entries(d)) refs(v, result, k);
  }
  return result;
}
async function recordStorageErasure(
  db: PoolClient,
  ctx: Context,
  selected: ProductRow[],
  explicitResources: Resource[],
  previewHash: string,
) {
  const graph = await allContentReferences(db),
    resourceMap = new Map(
      explicitResources.map((r) => [`${r.kind}:${r.id}`, r]),
    );
  for (const row of selected)
    if (
      (row.table === "sources" || row.table === "pages") &&
      typeof row.data.id === "string"
    ) {
      const kind = row.table === "sources" ? "source" : "page";
      resourceMap.set(`${kind}:${row.data.id}`, { kind, id: row.data.id });
    }
  const imports = new Set(
    selected
      .filter((r) => r.table === "storage_imports")
      .map((r) => String(r.data.id)),
  );
  // A mapped derivative does not retroactively make its independent original archive a descendant.
  // Keep original/private staged bytes unless that archive's actual input lineage is selected too.
  const hashes = new Set<string>();
  for (const r of resourceMap.values()) {
    const ownHashes = [
      ...new Set(
        graph
          .filter(
            (g) =>
              g.workspace_id === ctx.workspaceId &&
              g.owner_kind === "resource" &&
              g.parent_kind === r.kind &&
              g.owner_id === r.id,
          )
          .map((g) => g.sha256),
      ),
    ];
    for (const h of ownHashes) hashes.add(h);
    await db.query(
      "INSERT INTO operations_tombstones(workspace_id,id,resource_kind,resource_id,blob_hashes,allowed_readers,delete_content,approved_by) VALUES($1,$2,$3,$4,$5,'[]',true,$6)",
      [
        ctx.workspaceId,
        randomUUID(),
        r.kind,
        r.id,
        JSON.stringify(ownHashes),
        ctx.principalId,
      ],
    );
    await db.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind=$2 AND resource_id=$3",
      [ctx.workspaceId, r.kind, r.id],
    );
    await db.query(
      "UPDATE storage_blobs SET filename='[법정 삭제]' WHERE workspace_id=$1 AND parent_kind=$2 AND parent_id=$3",
      [ctx.workspaceId, r.kind, r.id],
    );
  }
  for (const id of imports) {
    const ownHashes = [
      ...new Set(
        graph
          .filter(
            (g) =>
              g.workspace_id === ctx.workspaceId &&
              g.owner_kind === "import" &&
              g.owner_id === id,
          )
          .map((g) => g.sha256),
      ),
    ];
    for (const h of ownHashes) hashes.add(h);
    await db.query(
      "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'import',$2,$3,$4,$5) ON CONFLICT(workspace_id,artifact_kind,artifact_id) DO UPDATE SET hashes=operations_erased_artifacts.hashes||excluded.hashes,preview_hash=excluded.preview_hash,approved_by=excluded.approved_by,created_at=now()",
      [
        ctx.workspaceId,
        id,
        JSON.stringify(ownHashes),
        previewHash,
        ctx.principalId,
      ],
    );
  }
  let shared = 0;
  for (const h of hashes) if (await hashHasLiveReference(db, h)) shared++;
  return { shared, hashes: [...hashes] };
}
function own(row: ProductRow) {
  const t = row.table,
    d = row.data,
    id = d.id;
  const result = new Set<string>();
  let kind: string | undefined;
  if (t === "imports") kind = "released-import";
  else if (t === "import_runs") kind = "released-run";
  else if (t === "sources") kind = "source";
  else if (t === "pages" || t === "versions") kind = "page";
  else if (t === "batches") kind = "batch";
  else if (/draft/.test(t)) kind = "draft";
  else if (/answer/.test(t)) kind = "answer";
  else if (/claim/.test(t) && !t.includes("review")) kind = "claim";
  else if (/evidence/.test(t) && !t.includes("review")) kind = "evidence";
  else if (/outcome/.test(t)) kind = "outcome";
  else if (t === "durable_jobs" || t === "runtime_jobs") kind = "job";
  else if (t === "storage_imports") kind = "import";
  if (kind && typeof (id ?? d.page_id) === "string")
    result.add(`${kind}:${id ?? d.page_id}`);
  return result;
}
function lineageRefs(row: ProductRow) {
  if (releasedImportTables.has(row.table))
    return refs({
      ...row.data,
      import_id: undefined,
      importId: row.data.import_id,
      importRunId: row.data.run_id,
    });
  return refs(
    row.table === "storage_import_sources"
      ? { ...row.data, sourceId: row.data.target_id }
      : row.data,
  );
}
export function selectErasureRows(
  rows: ProductRow[],
  resource?: Resource | Resource[],
) {
  if (!resource) return rows;
  const affected = new Set(
      (Array.isArray(resource) ? resource : [resource]).map(
        (r) => `${r.kind}:${r.id}`,
      ),
    ),
    selected = new Set<ProductRow>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row)) continue;
      const tokens = new Set([...own(row), ...lineageRefs(row)]);
      if ([...tokens].some((t) => affected.has(t))) {
        selected.add(row);
        for (const t of own(row)) affected.add(t);
        if (row.table === "sources" || row.table === "import_runs")
          for (const ref of lineageRefs(row))
            if (
              ref.startsWith("released-import:") ||
              ref.startsWith("released-run:")
            )
              affected.add(ref);
        changed = true;
      }
    }
  }
  return rows.filter((r) => selected.has(r));
}
const lineageKeys = new Set([
  ...Object.keys(referenceKeys),
  "id",
  "kind",
  "rootKind",
  "rootId",
  "sha256",
  "hash",
  "scope",
  "version",
  "number",
  "revision",
  "state",
  "status",
  "recordedAt",
  "createdAt",
  "effectiveFrom",
  "effectiveTo",
]);
export function scrubProductValue(
  value: unknown,
  key = "",
  force = false,
): unknown {
  const content =
    force ||
    /^(content|body|text|answer|message|summary|description|claim|conditions?|context|notes?|reason|comments?|title|result|checkpoint|value|excerpt|quote|snippet|prompt|completion|payload)$/i.test(
      key,
    );
  if (Array.isArray(value))
    return value.map((v) => scrubProductValue(v, key, content));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        scrubProductValue(v, k, content),
      ]),
    );
  if (content && value !== null) return "[법정 삭제]";
  if (typeof value === "string")
    return lineageKeys.has(key) ? value : "[법정 삭제]";
  return value === null || lineageKeys.has(key) ? value : "[법정 삭제]";
}
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
}
const fingerprint = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const requestBase = z
  .object({
    scope: z.enum(["resource", "workspace"]),
    resource: z
      .object({
        kind: z.enum(["source", "page"]),
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
const request = requestBase.refine((d) =>
  d.scope === "resource" ? !!d.resource : !d.resource,
);
interface Inventory {
  rows: ProductRow[];
  columns: Map<string, { name: string; type: string }[]>;
}
/** Temporary fail-closed boundary. Follow-up must implement credential redaction/revocation,
 * usage retention and attribution, restore replay, and safe retirement of the write fence. */
async function hasAgentData(db: PoolClient, workspaceId: string) {
  const result = await db.query(`SELECT EXISTS (
    SELECT 1 FROM agent_api_keys WHERE workspace_id=$1
    UNION ALL SELECT 1 FROM agent_device_clients WHERE workspace_id=$1
    UNION ALL SELECT 1 FROM agent_device_grants WHERE workspace_id=$1 OR client_id IN (SELECT id FROM agent_device_clients WHERE workspace_id=$1)
    UNION ALL SELECT 1 FROM agent_key_audit WHERE workspace_id=$1 OR key_id IN (SELECT id FROM agent_api_keys WHERE workspace_id=$1)
    UNION ALL SELECT 1 FROM model_usage_events WHERE workspace_id=$1
  ) AS present`, [workspaceId]);
  return result.rows[0].present as boolean;
}
/** Presence only: these workspace-wide records have no reliable resource lineage. */
async function agentDataBoundary(db: PoolClient, workspaceId: string) {
  const result = await db.query(`SELECT
    EXISTS(SELECT 1 FROM agent_api_keys WHERE workspace_id=$1) AS "apiKeys",
    EXISTS(SELECT 1 FROM agent_device_clients WHERE workspace_id=$1) AS "deviceClients",
    EXISTS(SELECT 1 FROM agent_device_grants WHERE workspace_id=$1) AS "deviceGrants",
    EXISTS(SELECT 1 FROM agent_key_audit WHERE workspace_id=$1) AS "keyAudit",
    EXISTS(SELECT 1 FROM model_usage_events WHERE workspace_id=$1) AS "modelUsage"`, [workspaceId]);
  const { apiKeys, deviceClients, deviceGrants, keyAudit, modelUsage } = result.rows[0];
  return { scope: "workspace" as const, resourceRelationship: "unknown" as const, apiKeys: apiKeys as boolean, deviceClients: deviceClients as boolean, deviceGrants: deviceGrants as boolean, keyAudit: keyAudit as boolean, modelUsage: modelUsage as boolean };
}
async function assertNoAgentData(db: PoolClient, workspaceId: string) {
  if (await hasAgentData(db, workspaceId)) throw Error("ERASURE_AGENT_DATA_UNSUPPORTED");
}
async function hasQuestionData(db: PoolClient, workspaceId: string) {
  const result = await db.query(`SELECT EXISTS (
    SELECT 1 FROM question_threads WHERE workspace_id=$1
    UNION ALL SELECT 1 FROM question_turns WHERE workspace_id=$1
    UNION ALL SELECT 1 FROM question_feedback WHERE workspace_id=$1
    UNION ALL SELECT 1 FROM question_feedback_work WHERE workspace_id=$1
  ) AS present`, [workspaceId]);
  return result.rows[0].present as boolean;
}
async function assertNoQuestionData(db: PoolClient, workspaceId: string) {
  if (await hasQuestionData(db, workspaceId)) throw Error("ERASURE_QUESTION_DATA_UNSUPPORTED");
}
/** These append-only workflow records are not yet covered by erasure or recovery replay. */
export async function hasVersionWorkflowData(db: PoolClient, workspaceId: string) {
  const result = await db.query(`SELECT
    EXISTS(SELECT 1 FROM version_metadata WHERE workspace_id=$1) OR
    EXISTS(SELECT 1 FROM version_metadata_events WHERE workspace_id=$1) OR
    EXISTS(SELECT 1 FROM versions_decisions WHERE workspace_id=$1) OR
    EXISTS(SELECT 1 FROM version_restore_previews WHERE workspace_id=$1) OR
    EXISTS(SELECT 1 FROM version_restore_plans WHERE workspace_id=$1) OR
    EXISTS(SELECT 1 FROM version_restore_applications WHERE workspace_id=$1) AS present`, [workspaceId]);
  return result.rows[0].present as boolean;
}
async function assertNoVersionWorkflowData(db: PoolClient, workspaceId: string) {
  if (await hasVersionWorkflowData(db, workspaceId)) throw Error("ERASURE_VERSION_METADATA_UNSUPPORTED");
}
async function inventory(db: PoolClient, ctx: Context): Promise<Inventory> {
  const metadata = (
      await db.query(
        "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
      )
    ).rows,
    columns = new Map<string, { name: string; type: string }[]>();
  for (const r of metadata)
    if (
      tablePattern.test(r.table_name) ||
      releasedImportTables.has(r.table_name)
    ) {
      const arr = columns.get(r.table_name) ?? [];
      arr.push({ name: r.column_name, type: r.data_type });
      columns.set(r.table_name, arr);
    }
  const rows: ProductRow[] = [];
  for (const [table, cols] of columns) {
    const scoped = cols.some((c) => c.name === "workspace_id"),
      jobScoped = cols.some((c) => c.name === "job_id"),
      keyScoped = table === "agent_key_requests" && cols.some((c) => c.name === "key_id");
    if (!scoped && !jobScoped && !keyScoped)
      throw Error(`ERASURE_SCOPE_UNSUPPORTED:${table}`);
    let offset = 0;
    for (;;) {
      const result = await db.query(
        `SELECT t.ctid::text AS locator,${releasedImportProjection(table) ?? "to_jsonb(t)"} AS data FROM "${table}" t WHERE ${scoped ? "t.workspace_id=$1" : jobScoped ? "t.job_id IN(SELECT id FROM durable_jobs WHERE workspace_id=$1)" : "t.key_id IN(SELECT id FROM agent_api_keys WHERE workspace_id=$1)"} ORDER BY t.ctid LIMIT 1000 OFFSET $2 FOR UPDATE OF t`,
        [ctx.workspaceId, offset],
      );
      for (const r of result.rows)
        rows.push({ table, locator: r.locator, data: r.data });
      if (rows.length > 100000) throw Error("ERASURE_INVENTORY_BOUND");
      if (result.rows.length < 1000) break;
      offset += 1000;
    }
  }
  return { rows, columns };
}
/** Trusted restore-only replay of independently signed, previously approved deletion records. Never an HTTP input. */
export async function replayProductErasure(
  db: PoolClient,
  workspaceId: string,
  resources: Resource[],
  entireWorkspace = false,
) {
  if (!resources.length && !entireWorkspace) return;
  await db.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_GATE]);
  await assertNoAgentData(db, workspaceId);
  await assertNoQuestionData(db, workspaceId);
  await assertNoVersionWorkflowData(db, workspaceId);
  const ctx = { workspaceId, principalId: "signed-recovery-ledger" },
    all = await inventory(db, ctx),
    selected = selectErasureRows(
      all.rows,
      entireWorkspace ? undefined : resources,
    ),
    selectedRefs = new Set(
      selected.flatMap((r) => [...own(r), ...refs(r.data)]),
    );
  const held = (
    await db.query(
      "SELECT resource_kind,resource_id FROM operations_legal_holds WHERE workspace_id=$1 AND active",
      [workspaceId],
    )
  ).rows;
  if (
    held.some(
      (h) =>
        h.resource_kind === "workspace" ||
        entireWorkspace ||
        selectedRefs.has(`${h.resource_kind}:${h.resource_id}`),
    )
  )
    throw Error("LEGAL_HOLD_BLOCKS_RECOVERY_ERASURE");
  const counts: Record<string, number> = {};
  const storage = await recordStorageErasure(
    db,
    ctx,
    selected,
    entireWorkspace
      ? (
          await db.query(
            "SELECT kind,id FROM resources WHERE workspace_id=$1",
            [workspaceId],
          )
        ).rows
      : resources,
    fingerprint(resources),
  );
  for (const row of selected) {
    if (await redactReleasedImportRow(db, row)) {
      counts[row.table] = (counts[row.table] ?? 0) + 1;
      continue;
    }
    const replacements: Record<string, unknown> = {};
    for (const c of all.columns.get(row.table) ?? []) {
      if (identityColumns.test(c.name)) continue;
      const value = row.data[c.name];
      if (c.type === "jsonb" || c.type === "json")
        replacements[c.name] = scrubProductValue(value);
      else if (
        (c.type === "text" || c.type === "character varying") &&
        value !== null
      )
        replacements[c.name] = "[법정 삭제]";
    }
    if (Object.keys(replacements).length)
      await db.query(
        "SELECT operations_privileged_product_redaction($1,$2::tid,$3::jsonb)",
        [row.table, row.locator, JSON.stringify(replacements)],
      );
    counts[row.table] = (counts[row.table] ?? 0) + 1;
  }
  const opaque = entireWorkspace
    ? 0
    : all.rows.filter(
        (r) =>
          !selected.includes(r) &&
          own(r).size === 0 &&
          lineageRefs(r).size === 0 &&
          Object.values(r.data).some(
            (v) =>
              typeof v === "object" ||
              (typeof v === "string" && v.length > 100),
          ),
      ).length + unmappedReleasedImports(all.rows, selected);
  if (opaque || storage.shared) throw Error("RECOVERY_ERASURE_INCOMPLETE");
  counts.unresolved_unlineaged_rows = opaque;
  counts.shared_live_blob_hashes = storage.shared;
  await db.query(
    "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,approved_by,status,counts,error_code) VALUES($1,$2,$3,$4,'signed-recovery-ledger',$5,$6,$7)",
    [
      workspaceId,
      randomUUID(),
      fingerprint(resources),
      entireWorkspace ? "workspace" : "resource",
      opaque || storage.shared ? "blocked" : "completed",
      JSON.stringify(counts),
      opaque
        ? "UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW"
        : storage.shared
          ? "SHARED_LIVE_BLOB_RETAINED"
          : null,
    ],
  );
  await appendOperationalAudit(db, ctx, {
    operation: "recovery.privileged-erasure-replay",
  });
}
async function calculate(db: PoolClient, ctx: Context, input: unknown) {
  const d = request.parse(input),
    all = await inventory(db, ctx),
    selected = selectErasureRows(all.rows, d.resource),
    counts: Record<string, number> = {};
  for (const r of selected) counts[r.table] = (counts[r.table] ?? 0) + 1;
  const held = (
    await db.query(
      "SELECT resource_kind,resource_id FROM operations_legal_holds WHERE workspace_id=$1 AND active",
      [ctx.workspaceId],
    )
  ).rows;
  const selectedRefs = new Set(
    selected.flatMap((r) => [...own(r), ...refs(r.data)]),
  );
  const blocked = held.some(
    (h) =>
      h.resource_kind === "workspace" ||
      d.scope === "workspace" ||
      selectedRefs.has(`${h.resource_kind}:${h.resource_id}`),
  );
  const opaque =
    all.rows.filter(
      (r) =>
        !selected.includes(r) &&
        own(r).size === 0 &&
        refs(r.data).size === 0 &&
        Object.values(r.data).some(
          (v) =>
            typeof v === "object" || (typeof v === "string" && v.length > 100),
        ),
    ).length + unmappedReleasedImports(all.rows, selected);
  const graph = await allContentReferences(db),
    resourceIds = new Set(
      selected
        .filter((r) => r.table === "sources" || r.table === "pages")
        .map(
          (r) => `${r.table === "sources" ? "source" : "page"}:${r.data.id}`,
        ),
    ),
    importIds = new Set(
      selected
        .filter((r) => r.table === "storage_imports")
        .map((r) => String(r.data.id)),
    );
  if (d.resource) resourceIds.add(`${d.resource.kind}:${d.resource.id}`);
  const ownHashes = new Set(
    graph
      .filter(
        (r) =>
          r.workspace_id === ctx.workspaceId &&
          (r.owner_kind === "resource"
            ? resourceIds.has(`${r.parent_kind}:${r.owner_id}`)
            : importIds.has(r.owner_id)),
      )
      .map((r) => r.sha256),
  );
  const previewHash = fingerprint({
    workspaceId: ctx.workspaceId,
    scope: d.scope,
    resource: d.resource,
    rows: selected,
    held,
    storageReferences: graph.filter((r) => ownHashes.has(r.sha256)),
  });
  return { d, all, selected, counts, blocked, opaque, previewHash };
}
export async function previewErasure(
  service: OperationsService,
  ctx: Context,
  input: unknown,
) {
  return service.withAdminTransaction(ctx, async (db) => {
    const d = request.parse(input);
    await service.authorize(db, ctx, "policy.strengthen", d.resource);
    if (d.resource) await requireRead(db, ctx, d.resource.kind, d.resource.id);
    if (
      d.scope === "workspace" &&
      !(await effectiveAccess(db, ctx)).space.owner
    )
      throw Error("OWNER_REQUIRED");
    const p = await calculate(db, ctx, d), boundary = await agentDataBoundary(db, ctx.workspaceId);
    return {
      scope: p.d.scope,
      resource: p.d.resource,
      previewHash: p.previewHash,
      counts: p.counts,
      total: p.selected.length,
      legalHold: p.blocked,
      unresolvedUnlineagedRows: p.opaque,
      agentDataUnsupported: await hasAgentData(db, ctx.workspaceId),
      questionDataUnsupported: await hasQuestionData(db, ctx.workspaceId),
      versionWorkflowDataUnsupported: await hasVersionWorkflowData(db, ctx.workspaceId),
      agentDataBoundary: boundary,
      allCopiesErased: false,
    };
  });
}
export async function executeErasure(
  service: OperationsService,
  ctx: Context,
  input: unknown,
) {
  const d = requestBase
    .extend({
      previewHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirm: z.enum([
        "ERASE_PREVIEWED_RESOURCE_LINEAGE",
        "ERASE_ENTIRE_WORKSPACE",
      ]),
    })
    .refine((d) => (d.scope === "resource" ? !!d.resource : !d.resource))
    .parse(input);
  let status: "completed" | "failed" | "blocked" = "failed",
    counts: Record<string, number> = {},
    code: string | undefined;
  try {
    return await service.withAdminTransaction(
      ctx,
      async (db) => {
        const base = { scope: d.scope, resource: d.resource };
        await service.authorize(db, ctx, "policy.strengthen", d.resource);
        if (!(await effectiveAccess(db, ctx)).space.owner)
          throw Error("OWNER_REQUIRED");
        if (d.resource)
          await requireRead(db, ctx, d.resource.kind, d.resource.id);
        if (
          d.confirm !==
          (d.scope === "workspace"
            ? "ERASE_ENTIRE_WORKSPACE"
            : "ERASE_PREVIEWED_RESOURCE_LINEAGE")
        )
          throw Error("ERASURE_CONFIRMATION_REQUIRED");
        const p = await calculate(db, ctx, base);
        counts = p.counts;
        if (p.previewHash !== d.previewHash)
          throw Error("ERASURE_PREVIEW_STALE");
        if (p.blocked) {
          status = "blocked";
          throw Error("LEGAL_HOLD");
        }
        await assertNoAgentData(db, ctx.workspaceId);
        if (await hasQuestionData(db, ctx.workspaceId)) {
          status = "blocked";
          throw Error("ERASURE_QUESTION_DATA_UNSUPPORTED");
        }
        if (await hasVersionWorkflowData(db, ctx.workspaceId)) {
          // Preflight occurs before tombstones or redaction. A failed receipt is
          // audit evidence, not a partially executed deletion or write fence.
          throw Error("ERASURE_VERSION_METADATA_UNSUPPORTED");
        }
        const resources: Resource[] =
          d.scope === "workspace"
            ? (
                await db.query(
                  "SELECT kind,id FROM resources WHERE workspace_id=$1",
                  [ctx.workspaceId],
                )
              ).rows
            : [d.resource!];
        if (d.scope === "resource")
          for (const row of p.selected)
            if (
              (row.table === "sources" || row.table === "pages") &&
              typeof row.data.id === "string"
            )
              await requireRead(
                db,
                ctx,
                row.table === "sources" ? "source" : "page",
                row.data.id,
              );
        const storage = await recordStorageErasure(
          db,
          ctx,
          p.selected,
          resources,
          d.previewHash,
        );
        // Privileged append-only refinement redaction happens only inside this explicit, preview-bound operation.
        for (const row of p.selected) {
          if (await redactReleasedImportRow(db, row)) continue;
          const replacements: Record<string, unknown> = {};
          for (const c of p.all.columns.get(row.table) ?? []) {
            if (identityColumns.test(c.name)) continue;
            const value = row.data[c.name];
            if (c.type === "jsonb" || c.type === "json")
              replacements[c.name] = scrubProductValue(value);
            else if (
              (c.type === "text" || c.type === "character varying") &&
              value !== null
            )
              replacements[c.name] = "[법정 삭제]";
          }
          if (!Object.keys(replacements).length) continue;
          await db.query(
            "SELECT operations_privileged_product_redaction($1,$2::tid,$3::jsonb)",
            [row.table, row.locator, JSON.stringify(replacements)],
          );
        }
        const jobs = p.selected
          .filter((r) => r.table === "durable_jobs")
          .map((r) => r.data.id);
        if (jobs.length)
          await db.query(
            "UPDATE durable_jobs SET status='cancelled',fence=fence+1,lease_until=NULL,checkpoint=NULL,result=NULL,error_code='LEGAL_ERASURE' WHERE workspace_id=$1 AND id=ANY($2::text[])",
            [ctx.workspaceId, jobs],
          );
        const legacyJobs = p.selected
          .filter((r) => r.table === "runtime_jobs")
          .map((r) => r.data.id);
        if (legacyJobs.length)
          await db.query(
            "UPDATE runtime_jobs SET status='failed',error_code='LEGAL_ERASURE',finished_at=now() WHERE workspace_id=$1 AND id=ANY($2::text[])",
            [ctx.workspaceId, legacyJobs],
          );
        await db.query(
          "UPDATE storage_tickets SET revoked=true WHERE workspace_id=$1",
          [ctx.workspaceId],
        );
        counts.shared_live_blob_hashes = storage.shared;
        counts.pending_blob_hashes = storage.hashes.length;
        counts.unresolved_unlineaged_rows = p.opaque;
        status =
          (p.opaque && d.scope === "resource") || storage.hashes.length
            ? "blocked"
            : "completed";
        code =
          status === "blocked"
            ? p.opaque && d.scope === "resource"
              ? "UNLINEAGED_CONTENT_REQUIRES_SEPARATE_PREVIEW"
              : storage.shared
                ? "SHARED_LIVE_BLOB_RETAINED"
                : "PHYSICAL_BLOB_PURGE_REQUIRED"
            : undefined;
        const id = randomUUID();
        await db.query(
          "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,resource_kind,resource_id,approved_by,status,counts,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            ctx.workspaceId,
            id,
            d.previewHash,
            d.scope,
            d.resource?.kind,
            d.resource?.id,
            ctx.principalId,
            status,
            JSON.stringify(counts),
            code,
          ],
        );
        await appendOperationalAudit(db, ctx, {
          operation: "content.privileged-erasure",
        });
        return { id, status, counts, errorCode: code, allCopiesErased: false };
      },
      true,
    );
  } catch (e) {
    code =
      e instanceof Error && /^[A-Z_]+$/.test(e.message)
        ? e.message
        : "ERASURE_FAILED";
    await service.withAdminTransaction(ctx, async (db) => {
      await db.query(
        "INSERT INTO operations_erasure_receipts(workspace_id,id,preview_hash,scope,resource_kind,resource_id,approved_by,status,counts,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          ctx.workspaceId,
          randomUUID(),
          d.previewHash,
          d.scope,
          d.resource?.kind,
          d.resource?.id,
          ctx.principalId,
          status,
          JSON.stringify(counts),
          code,
        ],
      );
      await appendOperationalAudit(db, ctx, {
        operation: "content.erasure-blocked",
      });
    });
    throw e;
  }
}
