import type { Pool,PoolClient } from "pg";
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
      model: await modelUsageSummary(db,filter,args),
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


async function modelUsageSummary(db:PoolClient,filter:string,args:(string|null)[]){
 const count=await db.query(
  "SELECT count(*)::int AS calls,count(*) FILTER(WHERE NOT succeeded)::int AS failed,count(input_tokens)::int AS input_measured,count(output_tokens)::int AS output_measured,count(cost_usd)::int AS priced_calls,sum(input_tokens)::text AS input_tokens,sum(output_tokens)::text AS output_tokens,sum(cache_read_tokens)::text AS cache_read_tokens,sum(cache_write_tokens)::text AS cache_write_tokens,sum(cost_usd)::text AS cost FROM model_usage_events WHERE "+filter,
  args,
 );
 const n=(v:unknown):number|null=>{
  if(v===null||v===undefined)return null;
  const value=Number(v);
  return Number.isFinite(value)&&value>=0?value:null;
 };
 const grouped=await db.query(
  'SELECT provider,backend,model,count(*)::int AS calls,count(*) FILTER(WHERE NOT succeeded)::int AS failed,count(input_tokens)::int AS "measuredCalls",count(cost_usd)::int AS "pricedCalls",sum(input_tokens)::text AS "inputTokens",sum(output_tokens)::text AS "outputTokens",sum(cache_read_tokens)::text AS "cacheReadTokens",sum(cache_write_tokens)::text AS "cacheWriteTokens",sum(cost_usd)::text AS cost,avg(latency_ms)::float8 AS "averageDurationMs" FROM model_usage_events WHERE '+filter+" GROUP BY provider,backend,model ORDER BY count(*) DESC,model LIMIT 100",
  args,
 );
 const groups=grouped.rows.map(row=>({
  ...row,inputTokens:n(row.inputTokens),outputTokens:n(row.outputTokens),
  cacheReadTokens:n(row.cacheReadTokens),cacheWriteTokens:n(row.cacheWriteTokens),cost:n(row.cost),
 }));
 const row=count.rows[0];
 return {calls:row.calls,failed:row.failed,measuredCalls:row.input_measured,outputMeasuredCalls:row.output_measured,
  pricedCalls:row.priced_calls,inputTokens:n(row.input_tokens),outputTokens:n(row.output_tokens),
  cacheReadTokens:n(row.cache_read_tokens),cacheWriteTokens:n(row.cache_write_tokens),cost:n(row.cost),byProvider:groups};
}

/** Model usage CSV contains no prompt/response content, raw URLs, tokens or keys. */
export async function exportModelUsageCsv(pool:Pool,ctx:Context,days:number):Promise<string>{
 if(![7,14,30,90].includes(days))throw Error("VALIDATION_FAILED");
 const quote=(input:unknown)=>{
  const value=String(input??"");
  const safe=/^[=+\-@\t\r]/.test(value)?"'"+value:value;
  return '"'+safe.replace(/"/g,'""')+'"';
 };
 return transaction(pool,ctx.workspaceId,async db=>{
  const role=await membership(db,ctx);
  const r=await db.query("SELECT access_role(workspace_id,$2) AS role FROM access_spaces WHERE workspace_id=$1",[ctx.workspaceId,ctx.principalId]);
  const all=r.rowCount?r.rows[0].role==="Admin":role==="reviewer";
  const now=new Date((await db.query("SELECT clock_timestamp() AS now")).rows[0].now);
  const from=new Date(now);from.setUTCHours(0,0,0,0);from.setUTCDate(from.getUTCDate()-days+1);
  const events=await db.query(
   "SELECT at,principal_id,operation,provider,backend,model,succeeded,latency_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd FROM model_usage_events WHERE workspace_id=$1 AND ($2::text IS NULL OR principal_id=$2) AND at>=$3 AND at<=$4 ORDER BY at DESC LIMIT 100001",
   [ctx.workspaceId,all?null:ctx.principalId,from.toISOString(),now.toISOString()],
  );
  if(events.rows.length>100000)throw Error("EXPORT_TOO_LARGE");
  const cols=["at","principal_id","operation","provider","backend","model","succeeded","latency_ms","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","cost_usd"];
  return [cols.join(","),...events.rows.map(v=>cols.map(c=>quote(c==="at"?new Date(v.at).toISOString():v[c])).join(","))].join("\r\n")+"\r\n";
 });
}
