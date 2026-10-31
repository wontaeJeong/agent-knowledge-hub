import type { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  healthSnapshot,
  metricsText,
  requireMetricsToken,
  capacitySnapshot,
  type ShutdownController,
} from "./monitoring";
import type { OperationsService } from "./service";
export async function operationalTelemetry(pool: Pool) {
  const query = {
    text: `SELECT pg_database_size(current_database())::text AS bytes,
 (SELECT count(*) FROM durable_jobs WHERE status IN ('queued','running','cancel_requested'))::text AS queue_depth,
 (SELECT count(*) FROM durable_jobs WHERE status='running' AND lease_until<now())::text AS expired_leases,
 (SELECT max(completed_at) FROM operations_backups WHERE status='complete') AS last_backup,
 (SELECT sum(input_tokens) FROM durable_model_calls) AS input_tokens,
 (SELECT sum(output_tokens) FROM durable_model_calls) AS output_tokens,
 (SELECT sum(cost_micros) FROM durable_model_calls) AS cost_micros,
 (SELECT count(*) FROM durable_model_calls WHERE input_tokens IS NULL OR output_tokens IS NULL OR cost_micros IS NULL)::text AS incomplete_calls,
 (SELECT count(*) FROM usage_events WHERE at>now()-interval '1 hour')::text AS requests_hour,
 (SELECT count(*) FROM usage_events WHERE at>now()-interval '1 hour' AND NOT succeeded)::text AS errors_hour,
 (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms) FROM usage_events WHERE at>now()-interval '1 hour') AS request_p95_ms`,
    query_timeout: 3000,
  };
  const db = await pool.query(query);
  const r = db.rows[0];
  let importQueueDepth = 0,
    importExpiredLeases = 0;
  if (
    (await pool.query("SELECT to_regclass('public.import_runs') AS t")).rows[0]
      .t
  ) {
    const native = (
      await pool.query(
        "SELECT count(*) FILTER(WHERE status IN('queued','running'))::text AS depth,count(*) FILTER(WHERE status='running' AND lease_until<clock_timestamp())::text AS expired FROM import_runs",
      )
    ).rows[0];
    importQueueDepth = Number(native.depth);
    importExpiredLeases = Number(native.expired);
  }
  return {
    databaseBytes: Number(r.bytes),
    queueDepth: Number(r.queue_depth) + importQueueDepth,
    expiredLeases: Number(r.expired_leases) + importExpiredLeases,
    durableQueueDepth: Number(r.queue_depth),
    importQueueDepth,
    lastBackup: r.last_backup as Date | null,
    inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    costMicros: r.cost_micros === null ? null : Number(r.cost_micros),
    incompleteCalls: Number(r.incomplete_calls),
    requestsHour: Number(r.requests_hour),
    errorsHour: Number(r.errors_hour),
    requestP95Ms: r.request_p95_ms === null ? null : Number(r.request_p95_ms),
  };
}
export interface ProbeConfig {
  pool: Pool;
  shutdown: ShutdownController;
  metricsToken?: string;
  modelProbe: () => Promise<boolean | null>;
  contentDirectory: string;
  minimumAvailableBytes: number;
  maxBackupAgeMs?: number;
}
export function operationsProbeHandler(c: ProbeConfig) {
  return async function handleOperationsProbe(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const path = req.url?.split("?")[0];
    if (
      req.method !== "GET" ||
      !["/healthz", "/readyz", "/metrics"].includes(path ?? "")
    )
      return false;
    if (path === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end('{"live":true}');
      return true;
    }
    if (path === "/metrics")
      try {
        requireMetricsToken(req.headers.authorization, c.metricsToken);
      } catch {
        res.writeHead(403);
        res.end();
        return true;
      }
    let t: Awaited<ReturnType<typeof operationalTelemetry>> | null = null;
    try {
      t = await operationalTelemetry(c.pool);
    } catch {}
    const health = await healthSnapshot({
      database: async () => t !== null,
      model: path === "/readyz" ? async () => null : c.modelProbe,
      queue: async () => t?.queueDepth ?? null,
      backup: async () => t?.lastBackup ?? null,
      draining: c.shutdown.draining,
      maxBackupAgeMs: c.maxBackupAgeMs,
    });
    if (path === "/readyz") {
      res.writeHead(health.ready ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ready: health.ready }));
      return true;
    }
    const capacity = await capacitySnapshot(
      c.contentDirectory,
      c.minimumAvailableBytes,
    );
    let text = metricsText(health);
    for (const [name, value] of Object.entries({
      database_bytes: t?.databaseBytes ?? null,
      expired_leases: t?.expiredLeases ?? null,
      durable_queue_depth: t?.durableQueueDepth ?? null,
      import_queue_depth: t?.importQueueDepth ?? null,
      model_input_tokens: t?.inputTokens ?? null,
      model_output_tokens: t?.outputTokens ?? null,
      model_cost_micros: t?.costMicros ?? null,
      model_incomplete_calls: t?.incompleteCalls ?? null,
      requests_last_hour: t?.requestsHour ?? null,
      errors_last_hour: t?.errorsHour ?? null,
      request_p95_ms: t?.requestP95Ms ?? null,
      content_available_bytes: capacity.availableBytes,
    })) {
      text += `akh_${name}_known ${Number(value !== null)}\n`;
      if (value !== null) text += `akh_${name} ${value}\n`;
    }
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4",
      "cache-control": "no-store",
    });
    res.end(text);
    return true;
  };
}
/** Called by a durable scheduler/worker. Stable alert keys suppress duplicates for the configured interval. */
export async function monitorOnce(
  service: OperationsService,
  c: ProbeConfig,
  options: {
    suppressionSeconds: number;
    queueLimit: number;
    deliver: (a: { id: string; code: string }) => Promise<void>;
  },
) {
  if (
    !Number.isInteger(options.suppressionSeconds) ||
    options.suppressionSeconds < 60 ||
    !Number.isInteger(options.queueLimit) ||
    options.queueLimit < 1
  )
    throw Error("INVALID_ALERT_THRESHOLDS");
  let t: Awaited<ReturnType<typeof operationalTelemetry>> | null = null;
  try {
    t = await operationalTelemetry(c.pool);
  } catch {}
  const health = await healthSnapshot({
    database: async () => t !== null,
    model: c.modelProbe,
    queue: async () => t?.queueDepth ?? null,
    backup: async () => t?.lastBackup ?? null,
    draining: c.shutdown.draining,
    maxBackupAgeMs: c.maxBackupAgeMs,
  });
  const capacity = await capacitySnapshot(
      c.contentDirectory,
      c.minimumAvailableBytes,
    ),
    codes: string[] = [];
  if (!health.database) codes.push("DATABASE_UNAVAILABLE");
  if (health.model === false) codes.push("MODEL_UNAVAILABLE");
  if (health.backupHealthy !== true)
    codes.push(
      health.backupHealthy === null ? "BACKUP_UNKNOWN" : "BACKUP_STALE",
    );
  if (t && t.queueDepth > options.queueLimit) codes.push("QUEUE_CAPACITY");
  if (t?.expiredLeases) codes.push("QUEUE_LEASE_EXPIRED");
  if (!capacity.acceptingWrites) codes.push("CONTENT_CAPACITY");
  const interval = Math.floor(Date.now() / (options.suppressionSeconds * 1000));
  for (const code of codes)
    await service.queueAlert(code, `${code}:${interval}`);
  await service.deliverAlerts(options.deliver);
  return { codes, health, capacity };
}
