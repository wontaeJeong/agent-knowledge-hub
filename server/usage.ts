import type { Pool } from "pg";
import type { Context } from "./service";
import type { UsageSummary } from "../src/domain/usage";
import { transaction } from "./database";
import { membership } from "./repository";

export async function usageSummary(
  pool: Pool,
  ctx: Context,
  days: number,
): Promise<UsageSummary> {
  if (![7, 14, 30, 90].includes(days)) throw Error("VALIDATION_FAILED");
  return transaction(pool, ctx.workspaceId, async (db) => {
    const role = await membership(db, ctx);
    const now = new Date(
      (await db.query("SELECT clock_timestamp() AS now")).rows[0].now,
    );
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - days + 1);
    const access = await db.query(
      "SELECT access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",
      [ctx.workspaceId, ctx.principalId],
    );
    const aggregate = access.rowCount
      ? access.rows[0].role === "Admin"
      : role === "reviewer";
    const principal = aggregate ? null : ctx.principalId;
    const args = [
      ctx.workspaceId,
      principal,
      from.toISOString(),
      now.toISOString(),
    ];
    const filter =
      "workspace_id=$1 AND ($2::text IS NULL OR principal_id=$2) AND at >= $3::timestamptz AND at <= $4::timestamptz";
    const counts = (
      await db.query(
        `SELECT count(*)::int AS total, count(*) FILTER(WHERE succeeded)::int AS succeeded, count(*) FILTER(WHERE NOT succeeded)::int AS failed, count(DISTINCT principal_id)::int AS users FROM usage_events WHERE ${filter}`,
        args,
      )
    ).rows[0];
    const grouped = await db.query(
      `SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, count(*) FILTER(WHERE succeeded)::int AS succeeded, count(*) FILTER(WHERE NOT succeeded)::int AS failed FROM usage_events WHERE ${filter} GROUP BY day ORDER BY day`,
      args,
    );
    const daily = Array.from({ length: days }, (_, i) => {
      const date = new Date(from);
      date.setUTCDate(date.getUTCDate() + i);
      const day = date.toISOString().slice(0, 10);
      return (
        grouped.rows.find((r) => r.day === day) ?? {
          day,
          succeeded: 0,
          failed: 0,
        }
      );
    });
    const operations = (
      await db.query(
        `SELECT operation, count(*)::int AS total, count(*) FILTER(WHERE NOT succeeded)::int AS failed, avg(duration_ms) AS "averageDurationMs" FROM usage_events WHERE ${filter} GROUP BY operation ORDER BY count(*) DESC, operation`,
        args,
      )
    ).rows;
    const published = await db.query(
      `SELECT count(*)::int AS count FROM audit WHERE ${filter} AND operation='batch.publish'`,
      args,
    );
    return {
      scope: aggregate ? "workspace" : "self",
      from: from.toISOString(),
      to: now.toISOString(),
      timezone: "UTC",
      total: counts.total,
      succeeded: counts.succeeded,
      failed: counts.failed,
      activeUsers: counts.users,
      publications: published.rows[0].count,
      daily,
      operations,
      model: { inputTokens: null, outputTokens: null, cost: null },
    };
  });
}


/** CSV includes recorded operations only, never source content or prompts. */
export async function exportUsageCsv(pool: Pool, ctx: Context, days: number): Promise<string> {
  if (![7, 14, 30, 90].includes(days)) throw Error("VALIDATION_FAILED");
  const escapeCsv = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const raw = String(value);
    const safe = /^[=+\-@\t\r]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replace(/"/g, '""') + '"';
  };
  return transaction(pool, ctx.workspaceId, async (db) => {
    const role = await membership(db, ctx);
    const managed = await db.query(
      "SELECT access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",
      [ctx.workspaceId, ctx.principalId],
    );
    const all = managed.rowCount ? managed.rows[0].role === "Admin" : role === "reviewer";
    const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - days + 1);
    const events = await db.query(
      "SELECT at,operation,succeeded,duration_ms,principal_id FROM usage_events WHERE workspace_id=$1 AND ($2::text IS NULL OR principal_id=$2) AND at >= $3::timestamptz AND at <= $4::timestamptz ORDER BY at DESC,id DESC LIMIT 100001",
      [ctx.workspaceId, all ? null : ctx.principalId, from.toISOString(), now.toISOString()],
    );
    if (events.rows.length > 100000) throw Error("EXPORT_TOO_LARGE");
    const headers = ["at_utc", "operation", "succeeded", "duration_ms", "principal_id"];
    return [
      headers.join(","),
      ...events.rows.map((row) =>
        [new Date(row.at).toISOString(), row.operation, row.succeeded, row.duration_ms, row.principal_id]
          .map(escapeCsv).join(","),
      ),
    ].join("\r\n") + "\r\n";
  });
}
