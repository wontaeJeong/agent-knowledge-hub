import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../database";
import { internalReferences, referenceOrigin } from "../workflows/references";
import { assertProductWritesNotErased } from "../operations/product-erasure";
export const linkPageQuery = z
  .object({
    cursor: z.string().max(4096).nullable().optional(),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict();
export type PublishedReference = {
  targetPageId: string;
  label: string;
  sourceBlockId: string | null;
};
/** Text-only [[title]] remains unresolved. Block identity is unknown, never guessed from a heading. */
export function publishedReferences(
  content: string,
  workspaceId: string,
  relations: string[] = [],
  origin?: string,
): PublishedReference[] {
  const refs = internalReferences(content, workspaceId, origin);
  for (const id of relations)
    if (!refs.some((r) => r.targetPageId === id))
      refs.push({ targetPageId: id, label: id, sourceBlockId: null });
  return refs;
}
/** Trusted publication/rebuild hook in the same gated workspace transaction. */
export async function replacePublishedLinks(
  db: PoolClient,
  input: {
    workspaceId: string;
    pageId: string;
    version: number;
    refs: PublishedReference[];
  },
) {
  const { workspaceId, pageId, version, refs } = input;
  await assertProductWritesNotErased(db, workspaceId, pageId);
  const current = (
    await db.query(
      "SELECT number,data FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number DESC LIMIT 1",
      [workspaceId, pageId],
    )
  ).rows[0];
  if (
    !current ||
    current.number !== version ||
    !isDeepStrictEqual(current.data.linkReferences, refs)
  )
    throw Error("STALE_VERSION");
  await db.query(
    "DELETE FROM published_page_links WHERE workspace_id=$1 AND page_id=$2",
    [workspaceId, pageId],
  );
  await db.query(
    "INSERT INTO published_page_links SELECT $1,$2,$3,unnest($4::text[])",
    [
      workspaceId,
      pageId,
      version,
      [...new Set(refs.map((r) => r.targetPageId))],
    ],
  );
}
/** Operator-owned, bounded and resumable. Serialization with publication prevents edge regression. */
export async function rebuildPublishedLinks(
  pool: Pool,
  workspaceId: string,
  input: { after?: string; limit?: number; origin?: string } = {},
) {
  const q = z
    .object({
      after: z.string().max(100).default(""),
      limit: z.number().int().min(1).max(100).default(100),
      origin: z.string().optional(),
    })
    .strict()
    .parse(input);
  const origin = referenceOrigin(q.origin);
  return transaction(pool, workspaceId, async (db) => {
    const rows = (
      await db.query(
        `SELECT p.id,p.data,v.number,v.data AS version FROM pages p JOIN LATERAL(SELECT number,data FROM versions WHERE workspace_id=p.workspace_id AND page_id=p.id ORDER BY number DESC LIMIT 1)v ON true WHERE p.workspace_id=$1 AND p.id>$2 ORDER BY p.id LIMIT $3`,
        [workspaceId, q.after, q.limit + 1],
      )
    ).rows;
    let skipped = 0;
    for (const row of rows.slice(0, q.limit)) {
      // Deleted product must never be repopulated by repair/restart.
      const erased = (
        await db.query(
          "SELECT 1 FROM operations_tombstones WHERE workspace_id=$1 AND resource_kind='page' AND resource_id=$2 AND delete_content",
          [workspaceId, row.id],
        )
      ).rowCount;
      if (erased) {
        skipped++;
        continue;
      }
      await assertProductWritesNotErased(db, workspaceId, row.id);
      const refs: PublishedReference[] =
        row.version.linkReferences ??
        publishedReferences(
          row.version.content ?? "",
          workspaceId,
          row.data.links ?? [],
          origin,
        );
      if (!row.version.linkReferences)
        await db.query(
          "UPDATE versions SET data=jsonb_set(data,'{linkReferences}',$4) WHERE workspace_id=$1 AND page_id=$2 AND number=$3",
          [workspaceId, row.id, row.number, JSON.stringify(refs)],
        );
      await replacePublishedLinks(db, {
        workspaceId,
        pageId: row.id,
        version: row.number,
        refs,
      });
    }
    return {
      processed: Math.min(q.limit, rows.length),
      skipped,
      nextAfter: rows.length > q.limit ? rows[q.limit - 1].id : null,
    };
  });
}

export async function assertLinkReadNotErased(
  db: PoolClient,
  workspaceId: string,
  p: import("../../src/domain/types").Page,
  ancestors: string[] = [],
) {
  const { inheritedProvenance } = await import("../provenance");
  const v = p.versions.at(-1)!,
    provenance = inheritedProvenance(p);
  const blocked = (
    await db.query(
      `SELECT 1 FROM operations_tombstones WHERE workspace_id=$1 AND delete_content AND ((resource_kind='page' AND resource_id=ANY($2::text[])) OR (resource_kind='source' AND resource_id=ANY($3::text[]))) UNION ALL SELECT 1 FROM operations_erasure_receipts WHERE workspace_id=$1 AND scope='workspace' AND (status='completed' OR (status='blocked' AND error_code IN ('PHYSICAL_BLOB_PURGE_REQUIRED','SHARED_LIVE_BLOB_RETAINED'))) LIMIT 1`,
      [
        workspaceId,
        [p.id, ...ancestors, ...provenance.pageIds],
        [...v.sourceIds, ...provenance.sourceIds],
      ],
    )
  ).rowCount;
  if (blocked) throw Error("NOT_FOUND");
}
export async function assertPublishedLinksSchema(
  db: PoolClient,
  errorCode: string,
) {
  const rows = (
    await db.query(
      "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='published_page_links' ORDER BY column_name",
    )
  ).rows;
  if (!rows.length) return;
  if (
    JSON.stringify(
      rows.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`),
    ) !==
    JSON.stringify([
      "page_id:text:NO",
      "target_page_id:text:NO",
      "version:integer:NO",
      "workspace_id:text:NO",
    ])
  )
    throw Error(errorCode);
}
