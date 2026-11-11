import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "./service";
import type { State } from "../src/domain/types";
import { acquireSharedMutationGate } from "./operations/gate";
import { membership, readers } from "./repository";
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

async function candidateRows(
  db: PoolClient,
  ctx: Context,
  aggregate: boolean,
  from: string,
  to: string,
) {
  const args = [ctx.workspaceId, aggregate ? null : ctx.principalId, from, to];
  const filter = `workspace_id=$1 AND ($2::text IS NULL OR principal_id=$2)
    AND data->>'at' >= $3 AND data->>'at' <= $4
    AND COALESCE(data->>'requestAuthorizationPending','false') <> 'true'`;
  const size = (
    await db.query(
      `SELECT count(*)::int AS count, COALESCE(sum(octet_length(data::text)),0)::text AS bytes FROM
    (SELECT data FROM runtime_answers WHERE ${filter} ORDER BY data->>'at' DESC, id LIMIT 2001) AS bounded_answers`,
      args,
    )
  ).rows[0];
  if (size.count > 2000 || Number(size.bytes) > 4 * 1024 * 1024)
    throw Error("DISCOVERY_CAPACITY");
  return (
    await db.query(
      `SELECT id, principal_id, data->>'at' AS at,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('pageId',c->'pageId','version',c->'version')),'[]'::jsonb)
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data->'citations')='array' THEN data->'citations' ELSE '[]'::jsonb END) c) AS citations,
    data->'inputEnvelope' AS envelope FROM runtime_answers WHERE ${filter}
    ORDER BY data->>'at' DESC, id LIMIT 2001`,
      args,
    )
  ).rows;
}

/** Acquire a workspace discovery gate before the ordinary workspace lock. */
async function discoveryTransaction<T>(
  pool: Pool,
  workspaceId: string,
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL lock_timeout = '5s'");
    await acquireSharedMutationGate(db);
    const gate = await db.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held",
      [`akh:discovery:${workspaceId}`],
    );
    if (!gate.rows[0].held) throw Error("DISCOVERY_CAPACITY");
    const workspace = await db.query(
      "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
      [workspaceId],
    );
    if (!workspace.rowCount) throw Error("NOT_FOUND");
    const result = await bounded(db, () => work(db));
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "55P03"
    )
      throw Error("DISCOVERY_CAPACITY");
    throw error;
  } finally {
    db.release();
  }
}

/** Limit data transferred and synchronously hashed before loading the state. */
async function preflightState(db: PoolClient, workspaceId: string) {
  const result = await db.query(
    `SELECT COALESCE(sum(bytes),0)::text AS bytes,
    (SELECT count(*) FROM pages WHERE workspace_id=$1)::text AS page_count,
    (SELECT count(*) FROM versions WHERE workspace_id=$1)::text AS version_count,
    (SELECT count(*) FROM sources WHERE workspace_id=$1)::text AS source_count,
    (SELECT count(*) FROM batches WHERE workspace_id=$1)::text AS batch_count,
    (SELECT count(*) FROM resource_readers WHERE workspace_id=$1)::text AS acl_count
    FROM (
    SELECT octet_length(data::text) AS bytes FROM pages WHERE workspace_id=$1
    UNION ALL SELECT octet_length(data::text) FROM versions WHERE workspace_id=$1
    UNION ALL SELECT octet_length(data::text) FROM sources WHERE workspace_id=$1
    UNION ALL SELECT octet_length(data::text) FROM batches WHERE workspace_id=$1
    UNION ALL SELECT octet_length(to_jsonb(d)::text) FROM workflow_document_state d WHERE workspace_id=$1
    UNION ALL SELECT octet_length(to_jsonb(s)::text) FROM workflow_source_state s WHERE workspace_id=$1
    UNION ALL SELECT octet_length(kind)+octet_length(resource_id)+octet_length(principal_id)+64 FROM resource_readers WHERE workspace_id=$1
  ) AS sizes`,
    [workspaceId],
  );
  const row = result.rows[0];
  const pages = Number(row.page_count),
    versions = Number(row.version_count);
  if (
    Number(row.bytes) > 16 * 1024 * 1024 ||
    pages > 1000 ||
    versions > 10000 ||
    pages * versions > 1000000 ||
    Number(row.source_count) > 10000 ||
    Number(row.batch_count) > 10000 ||
    Number(row.acl_count) > 20000
  )
    throw Error("DISCOVERY_CAPACITY");
}

/** Compare only resources visible to this caller across the final live IdP check. */
async function scopedGuard(
  db: PoolClient,
  ctx: Context,
  state: State,
  rows: unknown[],
  aggregate: boolean,
) {
  const pageIds = state.pages.map((p) => p.id),
    sourceIds = state.sources.map((s) => s.id);
  const acl: { kind: string; id: string; readers: string[] }[] = [];
  for (const id of pageIds)
    acl.push({
      kind: "page",
      id,
      readers: (await readers(db, ctx.workspaceId, "page", id)).sort(),
    });
  for (const id of sourceIds)
    acl.push({
      kind: "source",
      id,
      readers: (await readers(db, ctx.workspaceId, "source", id)).sort(),
    });
  const documents = (
    await db.query(
      "SELECT * FROM workflow_document_state WHERE workspace_id=$1 AND page_id=ANY($2::text[]) ORDER BY page_id",
      [ctx.workspaceId, pageIds],
    )
  ).rows;
  const sources = (
    await db.query(
      "SELECT * FROM workflow_source_state WHERE workspace_id=$1 AND source_id=ANY($2::text[]) ORDER BY source_id",
      [ctx.workspaceId, sourceIds],
    )
  ).rows;
  return fingerprint({
    pages: state.pages,
    sources: state.sources,
    acl,
    documents,
    sourceStates: sources,
    rows,
    aggregate,
  });
}

/** Cooperative wall-time budget, including nested ACL queries. Restore the client before rollback/release. */
async function bounded<T>(db: PoolClient, work: () => Promise<T>): Promise<T> {
  await db.query("SET LOCAL statement_timeout = '1s'");
  const deadline = performance.now() + 3000;
  const holder = db as unknown as { query: (...args: unknown[]) => unknown };
  const original = holder.query;
  holder.query = (...args: unknown[]) => {
    if (performance.now() >= deadline)
      return Promise.reject(Error("DISCOVERY_CAPACITY"));
    return original.apply(db, args);
  };
  try {
    const result = await work();
    if (performance.now() >= deadline) throw Error("DISCOVERY_CAPACITY");
    return result;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "57014"
    )
      throw Error("DISCOVERY_CAPACITY");
    throw error;
  } finally {
    holder.query = original;
  }
}

/** Read derived counts only. Never return answers, prompts, authors, ACLs or inaccessible inputs. */
export async function discoveryReport(
  pool: Pool,
  runtime: RuntimeService,
  ctx: Context,
  days: 7 | 14 | 30 | 90,
): Promise<DiscoveryReport> {
  if (![7, 14, 30, 90].includes(days)) throw Error("VALIDATION_FAILED");
  await ctx.authorization?.revalidate();
  const report = await discoveryTransaction(
    pool,
    ctx.workspaceId,
    async (db) => {
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
      await preflightState(db, ctx.workspaceId);
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
      const rows = await candidateRows(
        db,
        ctx,
        !!aggregate,
        from.toISOString(),
        now.toISOString(),
      );
      if (rows.length > 2000) throw Error("DISCOVERY_CAPACITY");
      const citations: DiscoveryCitation[] = [];
      const checked = new Map<string, boolean>();
      for (const row of rows) {
        const raw = row.envelope;
        if (
          raw &&
          ((Array.isArray(raw.pageIds) && raw.pageIds.length > 500) ||
            (Array.isArray(raw.sourceIds) && raw.sourceIds.length > 500))
        )
          throw Error("DISCOVERY_CAPACITY");
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
      const report: DiscoveryReport = {
        ...discoveryMetrics(visible, citations, now, days),
        scope: aggregate ? "workspace" : "self",
      };
      const guard = ctx.authorization
        ? await scopedGuard(db, ctx, state, rows, !!aggregate)
        : null;
      return { report, guard };
    },
  );
  await ctx.authorization?.revalidate();
  if (ctx.authorization) {
    await discoveryTransaction(pool, ctx.workspaceId, async (db) => {
      const role = await membership(db, ctx);
      await ctx.authorization!.assertSession(db);
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
      await preflightState(db, ctx.workspaceId);
      const { state } = await runtime.view(db, ctx);
      const rows = await candidateRows(
        db,
        ctx,
        !!aggregate,
        report.report.from,
        report.report.to,
      );
      if (
        (await scopedGuard(db, ctx, state, rows, !!aggregate)) !== report.guard
      )
        throw Error("STALE_VERSION");
    });
  }
  return report.report;
}
