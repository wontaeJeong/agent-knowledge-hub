import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import type { RuntimeExecution } from "../runtime/knowledge";
import { transaction } from "../database";
import { audit } from "../repository";
export const SEARCH_INDEX_NAME = "versions_content_trgm_idx";
/** SQL identifiers are derived and quoted by PostgreSQL, never caller input. */
async function indexNames(db: PoolClient) {
  const row = (
    await db.query(
      "SELECT format('%I.%I',n.nspname,'versions_content_trgm_idx') AS index_name,format('%I.%I',n.nspname,'versions') AS table_name,format('%I.gin_trgm_ops',x.nspname) AS opclass FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_extension e JOIN pg_namespace x ON x.oid=e.extnamespace WHERE c.oid='versions'::regclass AND e.extname='pg_trgm'",
    )
  ).rows[0];
  if (!row) throw Error("SEARCH_INDEX_NOT_CONFIGURED");
  return row as { index_name: string; table_name: string; opclass: string };
}
const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;
export class SearchIndexService {
  constructor(
    readonly pool: Pool,
    readonly authorize: (db: PoolClient, ctx: Context) => Promise<void>,
  ) {}
  async status(ctx: Context) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx);
      const names = await indexNames(db);
      const catalog = (
        await db.query(
          "SELECT i.indisvalid,i.indisready,pg_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.oid=to_regclass($1)",
          [names.index_name],
        )
      ).rows[0];
      const state = (
        await db.query(
          "SELECT *,clock_timestamp() AS observed_at FROM search_index_state WHERE id='versions-content-v1'",
        )
      ).rows[0];
      const own = (
        await db.query(
          "SELECT observed_mutation_at,revision::text FROM search_index_workspace_state WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows[0];
      const progress = (
        await db.query(
          "SELECT command,phase FROM pg_stat_progress_create_index WHERE index_relid=to_regclass($1)",
          [names.index_name],
        )
      ).rows;
      return {
        status:
          catalog?.indisvalid && catalog?.indisready ? "ready" : "degraded",
        engine: "postgresql-gin-trigram",
        observedAt: iso(state.observed_at),
        indexBytes: catalog?.bytes ?? null,
        freshness: {
          mode: "transaction-synchronous",
          lastContentMutationObservedAt: iso(own?.observed_mutation_at),
          workspaceRevision: own?.revision ?? null,
          lagSeconds: null,
        },
        lastSuccess: {
          at: iso(state.last_success_at),
          kind: state.last_success_kind,
        },
        lastAttemptAt: iso(state.last_attempt_at),
        lastFailure: state.last_failure_at
          ? { at: iso(state.last_failure_at), code: state.last_failure_code }
          : null,
        progress,
      };
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  async rebuild(ctx: Context, jobId: string, execution: RuntimeExecution) {
    const done = await execution.completed("search-index");
    if (done !== undefined) return done;
    try {
      return await transaction(this.pool, ctx.workspaceId, async (db) => {
        await execution.beforeWrite(db);
        await this.authorize(db, ctx);
        await db.query("SELECT pg_advisory_xact_lock(822121)");
        return execution.persist(db, "search-index", async () => {
          await db.query(
            "UPDATE search_index_state SET last_attempt_at=clock_timestamp() WHERE id='versions-content-v1'",
          );
          const names = await indexNames(db);
          const exists = (
            await db.query("SELECT to_regclass($1) AS name", [names.index_name])
          ).rows[0].name;
          if (exists) await db.query("REINDEX INDEX " + names.index_name);
          else
            await db.query(
              "CREATE INDEX versions_content_trgm_idx ON " +
                names.table_name +
                " USING gin (lower(data->>'content') " +
                names.opclass +
                ")",
            );
          // Checkpoint and metadata commit in the same transaction as the native index swap.
          const row = (
            await db.query(
              "UPDATE search_index_state SET last_success_at=clock_timestamp(),last_success_kind='rebuild',last_success_job_id=$1 WHERE id='versions-content-v1' RETURNING last_success_at",
              [jobId],
            )
          ).rows[0];
          await audit(db, ctx, "search.index.rebuild", jobId);
          return {
            rebuilt: true,
            at: iso(row.last_success_at),
            engine: "postgresql-gin-trigram",
          };
        });
      });
    } catch (error) {
      const driverCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const code =
        driverCode === "55P03"
          ? "SEARCH_INDEX_LOCK_TIMEOUT"
          : driverCode === "57014"
            ? "SEARCH_INDEX_TIMEOUT"
            : "SEARCH_INDEX_REBUILD_FAILED";
      // The failed REINDEX transaction has rolled back. Record no source text or raw SQL.
      try {
        await transaction(this.pool, ctx.workspaceId, async (db) => {
          await this.authorize(db, ctx);
          await db.query(
            "UPDATE search_index_state SET last_attempt_at=clock_timestamp(),last_failure_at=clock_timestamp(),last_failure_code=$1,last_failure_job_id=$2 WHERE id='versions-content-v1'",
            [code, jobId],
          );
        });
      } catch {
        /* Revoked authority must not acquire a new metadata-write capability. Queue failure remains visible. */
      }
      throw Error(code);
    }
  }
}
