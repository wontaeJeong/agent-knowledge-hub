import type { Pool } from "pg";
import { z } from "zod";
import type { Context } from "./service";
import { transaction } from "./database";
import { membership } from "./repository";
import { authorizeManaged, effectiveAccess } from "./access/index";
import { assertEnvelope, fingerprint } from "./provenance";
import {
  currentRecommendation,
  type RuntimeService,
} from "./runtime/knowledge";
import { current } from "../src/domain/wiki";
import {
  discoveryMetrics,
  type DiscoveryCitation,
  type DiscoveryPage,
  type DiscoveryReport,
} from "../src/domain/discovery";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const envelopeSchema = z
  .object({
    pageIds: z.array(identifier).max(500),
    sourceIds: z.array(identifier).max(500),
    pages: z.record(z.string(), z.string()),
    sources: z.record(z.string(), z.string()),
    acl: z.record(z.string(), z.array(z.string())),
  })
  .strict();
const citationsSchema = z
  .array(
    z
      .object({ pageId: identifier, version: z.number().int().positive() })
      .passthrough(),
  )
  .max(1000);
const inaccessible = (e: unknown) =>
  e instanceof Error &&
  ["NOT_FOUND", "FORBIDDEN", "STALE_VERSION"].includes(e.message);

/** Read derived counts only. Never return answers, prompts, authors, ACLs or inaccessible inputs. */
export async function discoveryReport(
  pool: Pool,
  runtime: RuntimeService,
  ctx: Context,
  days: 7 | 14 | 30 | 90,
): Promise<DiscoveryReport> {
  if (![7, 14, 30, 90].includes(days)) throw Error("VALIDATION_FAILED");
  await ctx.authorization?.revalidate();
  const report = await transaction(pool, ctx.workspaceId, async (db) => {
    const role = await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await authorizeManaged(db, ctx, "knowledge.read");
    const managed = await db.query(
      "SELECT 1 FROM access_spaces WHERE workspace_id=$1",
      [ctx.workspaceId],
    );
    const aggregate = managed.rowCount
      ? (await effectiveAccess(db, ctx)).capabilities.includes(
          "usage.read_aggregate",
        )
      : role === "reviewer" && !ctx.credentialId && !ctx.agent;
    const { state } = await runtime.view(db, ctx);
    const now = new Date(
      (await db.query("SELECT clock_timestamp() AS now")).rows[0].now,
    );
    const visible: DiscoveryPage[] = [];
    for (const page of state.pages) {
      try {
        await authorizeManaged(db, ctx, "knowledge.read", {
          kind: "page",
          id: page.id,
        });
        if (!(await currentRecommendation(db, ctx, page.id, now))) continue;
        visible.push({
          id: page.id,
          title: page.title,
          summary: page.summary,
          version: current(page).number,
          links: page.links ?? [],
          updatedAt: current(page).at,
        });
      } catch (e) {
        if (!inaccessible(e)) throw e;
      }
    }
    const pageMap = new Map(visible.map((p) => [p.id, p]));
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - days + 1);
    // A hard error, rather than an incomplete ranking, prevents silent truncation under load.
    const rows = (
      await db.query(
        `SELECT data->>'at' AS at, data->'citations' AS citations, data->'inputEnvelope' AS envelope
      FROM runtime_answers WHERE workspace_id=$1 AND ($2::text IS NULL OR principal_id=$2)
      AND data->>'at' >= $3 AND data->>'at' <= $4
      AND COALESCE(data->>'requestAuthorizationPending','false') <> 'true'
      ORDER BY data->>'at' DESC LIMIT 2001`,
        [
          ctx.workspaceId,
          aggregate ? null : ctx.principalId,
          from.toISOString(),
          now.toISOString(),
        ],
      )
    ).rows;
    if (rows.length > 2000) throw Error("DISCOVERY_CAPACITY");
    const citations: DiscoveryCitation[] = [];
    const checked = new Map<string, boolean>();
    for (const row of rows) {
      const envelope = envelopeSchema.safeParse(row.envelope);
      const refs = citationsSchema.safeParse(row.citations);
      if (!envelope.success || !refs.success || typeof row.at !== "string")
        continue;
      const key = fingerprint(envelope.data);
      let allowed = checked.get(key);
      if (allowed === undefined) {
        try {
          await assertEnvelope(db, ctx, state, envelope.data);
          for (const id of envelope.data.pageIds)
            await authorizeManaged(db, ctx, "knowledge.read", {
              kind: "page",
              id,
            });
          for (const id of envelope.data.sourceIds)
            await authorizeManaged(db, ctx, "knowledge.read", {
              kind: "source",
              id,
            });
          allowed = true;
        } catch (e) {
          if (!inaccessible(e)) throw e;
          allowed = false;
        }
        checked.set(key, allowed);
      }
      if (!allowed) continue;
      citations.push({
        at: row.at,
        pageIds: refs.data
          .filter(
            (c) =>
              envelope.data.pageIds.includes(c.pageId) &&
              pageMap.get(c.pageId)?.version === c.version,
          )
          .map((c) => c.pageId),
      });
    }
    return {
      ...discoveryMetrics(visible, citations, now, days),
      scope: aggregate ? ("workspace" as const) : ("self" as const),
    };
  });
  await ctx.authorization?.revalidate();
  return report;
}
