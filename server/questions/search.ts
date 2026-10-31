import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type { Page, State, Version } from "../../src/domain/types";
import { current } from "../../src/domain/wiki";
import { transaction } from "../database";
import { membership } from "../repository";
import { authorizeActionDb } from "../access/index";
import { captureEnvelope, fingerprint, versionProvenance } from "../provenance";
import {
  currentRecommendation,
  type RuntimeService,
} from "../runtime/knowledge";
import type { QuestionAuthorizer } from "./service";
export type SearchMetadata = {
  title?: string;
  type?: string;
  businessOwner?: string;
  tags?: string[];
  state?: string;
  reviewDate?: string | null;
  project?: string;
  environment?: string;
  archived?: boolean;
  properties?: Record<string, unknown>;
};
/** Host supplies immutable migration103 snapshots; null means unknown, never current fallback. */
export type MetadataReader = (
  db: PoolClient,
  ctx: Context,
  pageId: string,
  version: number,
) => Promise<SearchMetadata | null>;
const text = z.string().trim().min(1).max(200);
export const searchFilters = z
  .object({
    query: z.string().trim().max(2000).default(""),
    type: text.optional(),
    businessOwner: text.optional(),
    tags: z.array(text).max(20).default([]),
    state: text.optional(),
    reviewDateFrom: z.iso.datetime().optional(),
    reviewDateTo: z.iso.datetime().optional(),
    periodFrom: z.iso.datetime().optional(),
    periodTo: z.iso.datetime().optional(),
    project: text.optional(),
    environment: text.optional(),
    archived: z.boolean().optional(),
    historical: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(4000).nullable().optional(),
  })
  .strict()
  .refine(
    (f) =>
      (!f.periodFrom || !f.periodTo || f.periodFrom <= f.periodTo) &&
      (!f.reviewDateFrom ||
        !f.reviewDateTo ||
        f.reviewDateFrom <= f.reviewDateTo),
  );
type Item = {
  pageId: string;
  version: number;
  versionId: string;
  at: string;
  title: string | null;
  content: string;
  metadata: SearchMetadata | null;
  metadataStatus: "known" | "unknown";
  unknownMetadataKeys: string[];
  historical: boolean;
  currentRecommendation: boolean;
  href: string;
};
type Key = [string, string, number];
const key = (item: Item): Key => [item.at, item.pageId, item.version];
function compare(a: Key, b: Key) {
  return b[0].localeCompare(a[0]) || a[1].localeCompare(b[1]) || b[2] - a[2];
}
export class ScopedSearch {
  private readonly secret = randomBytes(32);
  constructor(
    readonly pool: Pool,
    readonly options: {
      authorize: QuestionAuthorizer;
      runtime: RuntimeService;
      versionMetadata?: MetadataReader;
    },
  ) {}
  private encode(value: unknown) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return (
      body + "." + createHmac("sha256", this.secret).update(body).digest("hex")
    );
  }
  private decode(raw: string) {
    try {
      const [body, mac, ...extra] = raw.split(".");
      const expected = createHmac("sha256", this.secret).update(body).digest();
      if (
        extra.length ||
        !mac ||
        !/^[a-f0-9]{64}$/.test(mac) ||
        !timingSafeEqual(expected, Buffer.from(mac, "hex"))
      )
        throw Error();
      return z
        .object({
          scope: z.string(),
          revision: z.string(),
          asof: z.iso.datetime(),
          last: z.tuple([z.string(), z.string(), z.number()]),
          expires: z.number(),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(body, "base64url").toString()));
    } catch {
      throw Error("STALE_CURSOR");
    }
  }
  async search(ctx: Context, raw: unknown = {}) {
    const filters = searchFilters.parse(raw);
    const { cursor, ...query } = filters;
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await authorizeActionDb(db, ctx, "knowledge.read");
      await this.options.authorize(db, ctx, "knowledge.read");
      const { state } = await this.options.runtime.view(db, ctx);
      const scope = fingerprint({
        workspace: ctx.workspaceId,
        principal: ctx.principalId,
        credential: ctx.credentialId ?? null,
        filters: query,
      });
      const old = cursor ? this.decode(cursor) : null;
      const flags = (
        await db.query(
          "SELECT * FROM workflow_document_state WHERE workspace_id=$1 ORDER BY page_id",
          [ctx.workspaceId],
        )
      ).rows;
      const owners = (
        await db.query(
          "SELECT * FROM governance_business_owners WHERE workspace_id=$1 ORDER BY page_id",
          [ctx.workspaceId],
        )
      ).rows;
      const envelope = await captureEnvelope(
        db,
        ctx,
        state,
        state.pages.map((p) => p.id),
        state.sources.map((s) => s.id),
      );
      // Includes actual body/metadata/ACL snapshots, not only wall time. ACL/index changes invalidate keysets.
      const hasSnapshots = (
        await db.query("SELECT to_regclass('version_metadata') AS table_name")
      ).rows[0].table_name;
      const snapshots = hasSnapshots
        ? (
            await db.query(
              "SELECT page_id,number,snapshot,snapshot_hash FROM version_metadata WHERE workspace_id=$1 ORDER BY page_id,number",
              [ctx.workspaceId],
            )
          ).rows
        : [];
      let revision = fingerprint({ envelope, flags, owners, snapshots });
      if (old && (old.scope !== scope || old.expires < Date.now()))
        throw Error("STALE_CURSOR");
      const asof = old?.asof ?? new Date().toISOString();
      const items: Item[] = [];
      // Literal substring search: never execute caller regex, SQL keys or wildcard fragments.
      const matches = new Set(
        (
          await db.query(
            "SELECT page_id,number FROM versions WHERE workspace_id=$1 AND (strpos(lower(data->>'content'),lower($2))>0 OR $2='')",
            [ctx.workspaceId, filters.query],
          )
        ).rows.map((r) => `${r.page_id}:${r.number}`),
      );
      for (const page of state.pages) {
        try {
          await this.options.authorize(db, ctx, "knowledge.read", {
            kind: "page",
            id: page.id,
          });
          for (const version of filters.historical
            ? page.versions
            : [current(page)]) {
            if (!Number.isFinite(Date.parse(version.at))) continue;
            const at = new Date(version.at).toISOString();
            if (at > asof) continue;
            await this.historyAccess(db, ctx, state, page, version);
            const stored = snapshots.find(
              (s) => s.page_id === page.id && s.number === version.number,
            );
            if (filters.historical && stored) {
              if (
                fingerprint(stored.snapshot) !== stored.snapshot_hash ||
                stored.snapshot.bodyHash !== fingerprint(version.content)
              )
                throw Error("STALE_VERSION");
              const root = await captureEnvelope(
                db,
                ctx,
                state,
                [
                  page.id,
                  ...Object.keys(stored.snapshot.versions ?? {}),
                  ...(stored.snapshot.relations ?? []),
                  ...(stored.snapshot.parentId
                    ? [stored.snapshot.parentId]
                    : []),
                ],
                (stored.snapshot.sources ?? []).map(
                  (s: { id: string }) => s.id,
                ),
              );
              for (const p of root.pageIds)
                await this.options.authorize(db, ctx, "knowledge.read", {
                  kind: "page",
                  id: p,
                });
              for (const s of root.sourceIds)
                await this.options.authorize(db, ctx, "knowledge.read", {
                  kind: "source",
                  id: s,
                });
            }
            const snapshot = stored?.snapshot;
            const historicalMetadata: SearchMetadata | null = snapshot
              ? {
                  title: snapshot.title,
                  type: snapshot.category,
                  tags: snapshot.tags,
                  state: snapshot.lifecycle,
                  archived: snapshot.lifecycle === "archived",
                  reviewDate: snapshot.workflowData?.reviewDue ?? null,
                  project: snapshot.properties?.project,
                  environment:
                    typeof snapshot.environment === "string"
                      ? snapshot.environment
                      : snapshot.properties?.environment,
                  properties: snapshot.properties,
                  businessOwner: snapshot.businessOwner,
                }
              : null;
            const metadata = filters.historical
              ? ((await this.options.versionMetadata?.(
                  db,
                  ctx,
                  page.id,
                  version.number,
                )) ?? historicalMetadata)
              : this.currentMetadata(
                  page,
                  flags.find((f) => f.page_id === page.id),
                  owners.find((o) => o.page_id === page.id),
                );
            if (
              filters.query &&
              !matches.has(`${page.id}:${version.number}`) &&
              !metadata?.title
                ?.toLocaleLowerCase()
                .includes(filters.query.toLocaleLowerCase())
            )
              continue;
            if (
              (filters.periodFrom && at < filters.periodFrom) ||
              (filters.periodTo && at > filters.periodTo)
            )
              continue;
            if (
              (filters.type && metadata?.type !== filters.type) ||
              (filters.businessOwner &&
                metadata?.businessOwner !== filters.businessOwner) ||
              (filters.state && metadata?.state !== filters.state) ||
              (filters.project && metadata?.project !== filters.project) ||
              (filters.environment &&
                metadata?.environment !== filters.environment)
            )
              continue;
            if (filters.tags.some((t) => !metadata?.tags?.includes(t)))
              continue;
            if (
              filters.archived !== undefined &&
              metadata?.archived !== filters.archived
            )
              continue;
            if (
              (filters.reviewDateFrom &&
                (!metadata?.reviewDate ||
                  metadata.reviewDate < filters.reviewDateFrom)) ||
              (filters.reviewDateTo &&
                (!metadata?.reviewDate ||
                  metadata.reviewDate > filters.reviewDateTo))
            )
              continue;
            items.push({
              pageId: page.id,
              version: version.number,
              versionId: version.id,
              at,
              title: metadata?.title ?? null,
              content: version.content,
              metadata,
              metadataStatus: metadata ? "known" : "unknown",
              unknownMetadataKeys: [
                "title",
                "type",
                "businessOwner",
                "tags",
                "state",
                "reviewDate",
                "project",
                "environment",
                "archived",
              ].filter(
                (k) =>
                  !metadata ||
                  metadata[k as keyof SearchMetadata] === undefined ||
                  metadata[k as keyof SearchMetadata] === null,
              ),
              historical: filters.historical,
              currentRecommendation: filters.historical
                ? false
                : await currentRecommendation(db, ctx, page.id),
              href: `/api/v1/pages/${encodeURIComponent(page.id)}/versions/${version.number}`,
            });
          }
        } catch (e) {
          if (!(
            e instanceof Error &&
            ["NOT_FOUND", "FORBIDDEN", "STALE_VERSION"].includes(e.message)
          ))
            throw e;
        }
      }
      items.sort((a, b) => compare(key(a), key(b)));
      revision = fingerprint({ base: revision, items });
      if (old && old.revision !== revision) throw Error("STALE_CURSOR");
      // Immutable snapshot metadata is part of the index revision, even when supplied by a host adapter.
      const accessible = old
        ? items.filter((i) => compare(key(i), old.last) > 0)
        : items;
      const page = accessible.slice(0, filters.limit);
      const nextCursor =
        accessible.length > filters.limit
          ? this.encode({
              scope,
              revision,
              asof,
              last: key(page[page.length - 1]),
              expires: old?.expires ?? Date.now() + 900000,
            })
          : null;
      return { items: page, nextCursor, asof };
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private currentMetadata(
    page: Page,
    flag?: { state: string; data: Record<string, unknown> },
    owner?: { owner_id: string },
  ): SearchMetadata {
    const properties = (flag?.data.properties ?? {}) as Record<string, unknown>;
    return {
      title: page.title,
      type: page.category,
      businessOwner: owner?.owner_id,
      tags: page.tags,
      state: flag?.state ?? "active",
      reviewDate:
        typeof flag?.data.reviewDue === "string" ? flag.data.reviewDue : null,
      project:
        typeof properties.project === "string" ? properties.project : undefined,
      environment:
        typeof properties.environment === "string"
          ? properties.environment
          : undefined,
      archived: flag?.state === "archived",
      properties,
    };
  }
  private async historyAccess(
    db: PoolClient,
    ctx: Context,
    state: State,
    page: Page,
    version: Version,
  ) {
    const roots = versionProvenance(version);
    const closure = await captureEnvelope(
      db,
      ctx,
      state,
      [page.id, ...roots.pageIds],
      [...version.sourceIds, ...roots.sourceIds],
    );
    for (const p of closure.pageIds)
      await this.options.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: p,
      });
    for (const s of closure.sourceIds)
      await this.options.authorize(db, ctx, "knowledge.read", {
        kind: "source",
        id: s,
      });
  }
}
