import { z } from "zod";
import type { PoolClient } from "pg";
import type { Context } from "../service";
import type { StorageManifest } from "./service";
import {
  currentMetadata,
  type MetadataSnapshot,
  type RestorePlan,
} from "../workflows/versions/metadata";
import { fingerprint } from "../provenance";
import type { Draft } from "../../src/domain/wiki";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const record = z.record(z.string(), z.unknown());
export const historySchema = z
  .object({
    snapshots: z.array(record).max(100),
    events: z.array(record).max(1000),
    importedEvidence: z.array(record).max(100),
  })
  .strict();
export type ExportHistory = z.infer<typeof historySchema>;
/** Every historical reference remains subject to current authorization. Missing history stays unknown. */
export function historicalReferences(history: ExportHistory) {
  const pageIds = new Set<string>(),
    sourceIds = new Set<string>();
  const snapshot = (raw: unknown) => {
    const s = record.parse(raw);
    if (s.parentId) pageIds.add(id.parse(s.parentId));
    for (const p of z.array(id).parse(s.relations ?? [])) pageIds.add(p);
    for (const p of Object.keys(record.parse(s.versions ?? {})))
      pageIds.add(id.parse(p));
    for (const src of z.array(z.object({ id })).parse(s.sources ?? []))
      sourceIds.add(src.id);
  };
  const pending = [history];
  let count = 0;
  while (pending.length) {
    if (++count > 100) throw Error("IMPORT_HISTORY_LIMIT");
    const h = historySchema.parse(pending.pop());
    for (const s of h.snapshots) snapshot(s.snapshot);
    for (const e of h.events) {
      snapshot(e.before_snapshot);
      snapshot(e.after_snapshot);
    }
    for (const e of h.importedEvidence) {
      for (const s of z.array(id).parse(e.sourceIds ?? [])) sourceIds.add(s);
      for (const mapped of Object.values(record.parse(e.sourceMap ?? {})))
        sourceIds.add(id.parse(mapped));
      const p = record.parse(e.page),
        data = record.parse(p.data),
        operational = record.nullable().optional().parse(p.operational);
      for (const link of z.array(id).parse(data.links ?? [])) pageIds.add(link);
      if (operational?.parent_id) pageIds.add(id.parse(operational.parent_id));
      for (const raw of z.array(record).max(100).parse(p.versions)) {
        for (const s of z.array(id).parse(raw.sourceIds)) sourceIds.add(s);
        if (raw.provenance) {
          const a = z
            .object({ pageIds: z.array(id), sourceIds: z.array(id) })
            .parse(raw.provenance);
          for (const p of a.pageIds) pageIds.add(p);
          for (const s of a.sourceIds) sourceIds.add(s);
        }
      }
      if (p.history) pending.push(historySchema.parse(p.history));
    }
  }
  return { pageIds: [...pageIds], sourceIds: [...sourceIds] };
}
export async function exportHistory(
  db: PoolClient,
  ctx: Context,
  pageId: string,
): Promise<ExportHistory> {
  const snapshots = (
    await db.query(
      "SELECT number,snapshot,snapshot_hash,anchors,actor_id,captured_at FROM version_metadata WHERE workspace_id=$1 AND page_id=$2 ORDER BY number",
      [ctx.workspaceId, pageId],
    )
  ).rows;
  const events = (
    await db.query(
      "SELECT id::text,actor_id,reason,before_snapshot,after_snapshot,at FROM version_metadata_events WHERE workspace_id=$1 AND page_id=$2 ORDER BY id",
      [ctx.workspaceId, pageId],
    )
  ).rows;
  const imports = (
    await db.query(
      `WITH RECURSIVE lineage(root,batch_id,path) AS (
  SELECT batch_id,batch_id,ARRAY[batch_id] FROM storage_import_effects WHERE workspace_id=$1
  UNION ALL SELECT l.root,d.derived_batch_id,l.path||d.derived_batch_id FROM lineage l
  JOIN versions_decisions d ON d.workspace_id=$1 AND d.original_batch_id=l.batch_id
  WHERE d.derived_batch_id IS NOT NULL AND NOT d.derived_batch_id=ANY(l.path)
 ) SELECT DISTINCT i.id,i.digest,i.manifest,e.result FROM lineage l
 JOIN publications p ON p.workspace_id=$1 AND p.batch_id=l.batch_id
 JOIN storage_import_effects e ON e.workspace_id=$1 AND e.batch_id=l.root
 JOIN storage_imports i ON i.workspace_id=e.workspace_id AND i.id=e.import_id
 WHERE p.result->'versions' ? $2 ORDER BY i.id`,
      [ctx.workspaceId, pageId],
    )
  ).rows;
  const importedEvidence = imports.map((row) => {
    const m = row.manifest.manifest as StorageManifest;
    const blobs = m.blobs.filter(
      (b) => b.parent.kind === "source" || b.parent.id === pageId,
    );
    const blobMap = Object.fromEntries(
      blobs.map((b) => [b.id, row.result.blobMap[b.id]]),
    );
    const slotMap = Object.fromEntries(
      blobs.map((b) => {
        const key = b.attachment?.slotId ?? b.id;
        return [key, row.result.slotMap[key]];
      }),
    );
    return {
      trust: "unverified-import",
      importId: row.id,
      archiveDigest: row.digest,
      workspaceId: m.workspaceId,
      exportedAt: m.exportedAt,
      sourceIds: m.sources.map((s) => s.id),
      sources: m.sources,
      sourceMap: row.result.sourceMap,
      blobs: blobs.map(({ base64: _bytes, ...metadata }) => metadata),
      blobMap,
      slotMap,
      page: m.pages.find((p) => p.id === pageId)!,
    };
  });
  return historySchema.parse(
    JSON.parse(JSON.stringify({ snapshots, events, importedEvidence })),
  );
}
/** Only the allowlisted content metadata is proposed. Never import workflow policy, lifecycle or authority. */
export async function importMetadataPlans(
  db: PoolClient,
  ctx: Context,
  manifest: StorageManifest,
  drafts: Draft[],
): Promise<RestorePlan[]> {
  if (manifest.version === 1) return [];
  const policy = (
    await db.query(
      "SELECT policy_version FROM access_spaces WHERE workspace_id=$1 AND active",
      [ctx.workspaceId],
    )
  ).rows[0];
  const plans: RestorePlan[] = [];
  for (const draft of drafts) {
    const page = manifest.pages.find((p) => p.id === draft.id)!,
      op = record.parse(page.operational?.data ?? {});
    const base: MetadataSnapshot = draft.baseVersion
      ? await currentMetadata(db, ctx, draft.id)
      : {
          pageId: draft.id,
          number: 0,
          title: draft.title,
          summary: draft.summary,
          category: "연결된 지식",
          tags: [],
          properties: {},
          environment: null,
          parentId: null,
          lifecycle: "active",
          settingsRevision: 0,
          workflowData: {},
          sources: [],
          versions: {},
          relations: [],
          attribution: {},
          bodyHash: fingerprint(""),
        };
    const next: MetadataSnapshot = {
      ...base,
      title: draft.title,
      summary: draft.summary,
      relations: draft.links,
      category: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .parse(page.data.category ?? base.category),
      tags: z
        .array(z.string().max(100))
        .max(100)
        .parse(page.data.tags ?? []),
      properties: z
        .record(z.string().max(100), z.string().max(2000))
        .parse(op.properties ?? {}),
      environment: z
        .union([
          z.string().max(2000),
          z.record(z.string().max(100), z.string().max(2000)),
        ])
        .nullable()
        .parse(
          op.environment ??
            (op.properties as Record<string, unknown> | undefined)
              ?.environment ??
            null,
        ),
      parentId: id.nullable().parse(page.operational?.parent_id ?? null),
    };
    const fields = [
      "category",
      "tags",
      "properties",
      "environment",
      "parentId",
    ].filter(
      (key) =>
        fingerprint(base[key as keyof MetadataSnapshot]) !==
        fingerprint(next[key as keyof MetadataSnapshot]),
    );
    if (!policy) {
      if (fields.length) throw Error("IMPORT_METADATA_MANAGED_SPACE_REQUIRED");
      continue;
    }
    if (draft.baseVersion === 0 && !fields.length) fields.push("category");
    plans.push({
      pageId: draft.id,
      targetVersion: Math.max(...page.versions.map((v) => Number(v.number))),
      baseVersion: draft.baseVersion,
      settingsRevision: base.settingsRevision,
      policyVersion: policy.policy_version,
      fields,
      next,
      currentHash: draft.baseVersion
        ? fingerprint(base)
        : fingerprint(["absent", draft.id]),
      content: draft.content,
      sourceIds: draft.sourceIds,
      dependencies: next.parentId ? [next.parentId] : [],
    });
  }
  return plans;
}

/** Canonical commit hook after independent approval and all page inserts. Staged new-page
 * attachments use a source ceiling until publication can bind them to the actual page. */
export async function applyPublishedImportAttachments(
  db: PoolClient,
  ctx: Context,
  batchId: string,
  versions: Record<string, number>,
) {
  const rows = (
    await db.query(
      `WITH RECURSIVE ancestors(id,path) AS (
  SELECT $2::text,ARRAY[$2::text]
  UNION ALL SELECT d.original_batch_id,a.path||d.original_batch_id FROM ancestors a
  JOIN versions_decisions d ON d.workspace_id=$1 AND d.derived_batch_id=a.id
  WHERE NOT d.original_batch_id=ANY(a.path)
 ) SELECT e.result,i.manifest FROM ancestors a JOIN storage_import_effects e ON e.workspace_id=$1 AND e.batch_id=a.id
 JOIN storage_imports i ON i.workspace_id=e.workspace_id AND i.id=e.import_id
 WHERE i.manifest->'manifest'->>'version'='2'`,
      [ctx.workspaceId, batchId],
    )
  ).rows;
  if (!rows.length) return;
  const moves: { blobId: string; slot: string; pageId: string }[] = [];
  const { readers } = await import("../repository");
  const { authorizeActionDb } = await import("../access/index");
  for (const row of rows) {
    const manifest = row.manifest.manifest as StorageManifest,
      effect = row.result;
    for (const original of manifest.blobs) {
      const blobId = id.parse(effect.blobMap[original.id]);
      const blob = (
        await db.query(
          "SELECT * FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, blobId],
        )
      ).rows[0];
      if (
        !blob ||
        blob.sha256 !== original.sha256 ||
        blob.mime !== original.mime ||
        blob.filename !== original.filename
      )
        throw Error("IMMUTABLE_BLOB_MISMATCH");
      if (blob.scan_state !== "clean") throw Error("SCAN_REQUIRED");
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: blob.parent_kind,
        id: blob.parent_id,
      });
      const slotValue =
        effect.slotMap[original.attachment?.slotId ?? original.id];
      // Immutable source snapshots predate/do not use logical attachment slots.
      if (!slotValue) {
        if (original.attachment || blobId !== original.id)
          throw Error("IMMUTABLE_ATTACHMENT_MISMATCH");
      }
      const slot = slotValue ? id.parse(slotValue) : "";
      if (slot) {
        const head = (
          await db.query(
            "SELECT * FROM storage_attachment_slots WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, slot],
          )
        ).rows[0];
        if (
          !head ||
          head.withdrawn ||
          head.head_id !==
            effect.blobMap[original.attachment?.headId ?? original.id] ||
          head.revision !== (original.attachment?.headRevision ?? 1) ||
          head.parent_kind !== blob.parent_kind ||
          head.parent_id !== blob.parent_id
        )
          throw Error("STALE_VERSION");
      }

      if (original.parent.kind !== "page" || !versions[original.parent.id])
        continue;
      if (blob.parent_kind === "page" && blob.parent_id === original.parent.id)
        continue;
      if (
        blobId === original.id ||
        blob.parent_kind !== "source" ||
        !Object.values(effect.sourceMap).includes(blob.parent_id)
      )
        throw Error("SOURCE_SCOPE_CONFLICT");
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: original.parent.id,
      });
      const upper = await readers(
          db,
          ctx.workspaceId,
          blob.parent_kind,
          blob.parent_id,
        ),
        audience = await readers(
          db,
          ctx.workspaceId,
          "page",
          original.parent.id,
        );
      if (audience.some((who) => !upper.includes(who)))
        throw Error("SOURCE_SCOPE_CONFLICT");
      if (!slot) throw Error("IMMUTABLE_ATTACHMENT_MISMATCH");
      moves.push({ blobId, slot, pageId: original.parent.id });
    }
  }
  // Check every immutable revision before changing any parent; logical heads move once.
  for (const move of moves)
    await db.query(
      "UPDATE storage_blobs SET parent_kind='page',parent_id=$3 WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, move.blobId, move.pageId],
    );
  for (const move of new Map(moves.map((m) => [m.slot, m])).values())
    await db.query(
      "UPDATE storage_attachment_slots SET parent_kind='page',parent_id=$3 WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, move.slot, move.pageId],
    );
}
