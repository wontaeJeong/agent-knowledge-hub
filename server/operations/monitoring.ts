import { timingSafeEqual } from "node:crypto";
import { statfs } from "node:fs/promises";
export async function capacitySnapshot(
  directory: string,
  minimumAvailableBytes: number,
) {
  if (!Number.isSafeInteger(minimumAvailableBytes) || minimumAvailableBytes < 1)
    throw Error("INVALID_CAPACITY_LIMIT");
  try {
    const s = await statfs(directory, { bigint: true }),
      available = s.bavail * s.bsize;
    if (available > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error("CAPACITY_OVERFLOW");
    return {
      availableBytes: Number(available),
      acceptingWrites: available >= BigInt(minimumAvailableBytes),
    };
  } catch {
    return { availableBytes: null, acceptingWrites: false };
  }
}
export interface HealthInputs {
  database: () => Promise<boolean>;
  model: () => Promise<boolean | null>;
  queue: () => Promise<number | null>;
  backup: () => Promise<Date | null>;
  draining: boolean;
  maxBackupAgeMs?: number;
  timeoutMs?: number;
}
export async function healthSnapshot(i: HealthInputs) {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), i.timeoutMs ?? 3000);
          timer.unref();
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const [database, model, queue, backup] = await Promise.all([
    safe(i.database),
    safe(i.model),
    safe(i.queue),
    safe(i.backup),
  ]);
  const backupAgeSeconds = backup
    ? Math.max(0, (Date.now() - backup.getTime()) / 1000)
    : null;
  // Dependency degradation must not take existing wiki reads offline (OPS-010).
  return {
    live: true,
    ready: !i.draining && database === true,
    automationReady:
      !i.draining && database === true && model === true && queue !== null,
    backupHealthy:
      backupAgeSeconds === null
        ? null
        : backupAgeSeconds * 1000 <= (i.maxBackupAgeMs ?? 900000),
    database,
    model,
    queueDepth: queue,
    backupAgeSeconds,
    draining: i.draining,
  };
}
export type Health = Awaited<ReturnType<typeof healthSnapshot>>;
export function metricsText(h: Health) {
  const lines = [
    "# No principal, resource, content or URL labels",
    "akh_live 1",
    `akh_ready ${Number(h.ready)}`,
  ];
  for (const [name, value] of Object.entries({
    database_available: h.database,
    model_available: h.model,
    queue_depth: h.queueDepth,
    backup_age_seconds: h.backupAgeSeconds,
  })) {
    lines.push(`akh_${name}_known ${Number(value !== null)}`);
    if (value !== null) lines.push(`akh_${name} ${Number(value)}`);
  }
  return lines.join("\n") + "\n";
}
export function requireMetricsToken(
  actual: string | undefined,
  expected: string | undefined,
) {
  if (!expected || expected.length < 32 || !actual) throw Error("FORBIDDEN");
  const a = Buffer.from(actual),
    b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw Error("FORBIDDEN");
}
export class ShutdownController {
  draining = false;
  private active = 0;
  enter() {
    if (this.draining) throw Error("DRAINING");
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  async drain(timeoutMs: number) {
    this.draining = true;
    const end = Date.now() + timeoutMs;
    while (this.active && Date.now() < end)
      await new Promise((r) => setTimeout(r, Math.min(10, timeoutMs)));
    return this.active === 0;
  }
}
/** Adapter URL is trusted configuration, never supplied by resources or model output. */
export function webhookAdapter(config: {
  url: string;
  allowedOrigins: string[];
  token: string;
  timeoutMs?: number;
}) {
  const u = new URL(config.url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !config.allowedOrigins.includes(u.origin) ||
    !config.token
  )
    throw Error("ALERT_TARGET_NOT_APPROVED");
  return async (alert: { id: string; code: string }) => {
    const response = await fetch(u, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(config.timeoutMs ?? 5000, 10000)),
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "idempotency-key": alert.id,
      },
      body: JSON.stringify(alert),
    });
    if (!response.ok) throw Error("ALERT_DELIVERY_FAILED");
    await response.body?.cancel();
  };
}
/** Company-approved HTTPS mail relay contract; no direct SMTP or arbitrary external recipient input. */
export function emailGatewayAdapter(config: {
  url: string;
  allowedOrigins: string[];
  token: string;
  recipients: string[];
  timeoutMs?: number;
}) {
  const deliver = webhookAdapter(config); // Validate policy before retaining any configured addresses.
  if (
    !config.recipients.length ||
    config.recipients.length > 20 ||
    config.recipients.some(
      (r) =>
        r.length > 254 ||
        !/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(
          r,
        ),
    )
  )
    throw Error("INVALID_CONFIGURED_EMAIL_RECIPIENT");
  void deliver;
  return async (alert: { id: string; code: string }) => {
    const response = await fetch(config.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(config.timeoutMs ?? 5000, 10000)),
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "idempotency-key": alert.id,
      },
      body: JSON.stringify({
        to: config.recipients,
        subject: `agent-knowledge-hub: ${alert.code}`,
        text: `운영 알림 ${alert.code}; incident ${alert.id}`,
        incidentId: alert.id,
      }),
    });
    if (!response.ok) throw Error("EMAIL_DELIVERY_FAILED");
    await response.body?.cancel();
  };
}
