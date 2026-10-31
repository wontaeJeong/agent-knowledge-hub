import { z } from "zod";
import type { Context } from "../service";
import type { DraftRecoveryService } from "./recovery";
import type { ContentRetentionService } from "./service";
export const retentionErrorStatuses: Record<string, number> = {
  RECOVERY_EXPIRED: 403,
  RECOVERY_POLICY_CHANGED: 409,
  RECOVERY_GRANT_BOUND: 429,
  RETENTION_PREVIEW_STALE: 409,
  RETENTION_GRAPH_BOUND: 503,
  RETENTION_GRAPH_UNSUPPORTED: 503,
  RETENTION_WORKER_NOT_AUTHORIZED: 403,
};

/** Mount after authenticated identity, CSRF, bounded body and selected-space checks.
 * No caller ID, role, SQL, filesystem path, or worker authority is accepted here.
 */
export async function handleRetentionRoute(
  input: {
    method: string;
    path: string;
    body: unknown;
    ctx: Context;
    send: (status: number, data: unknown) => void;
  },
  services: {
    recovery: DraftRecoveryService;
    retention: ContentRetentionService;
  },
): Promise<boolean> {
  const { method, path, body, ctx, send } = input;
  let result: unknown;
  try {
    if (method === "POST" && path === "/api/v1/workflows/recovery/permission")
      result = await services.recovery.permission(ctx, body);
    else if (
      method === "POST" &&
      path === "/api/v1/workflows/recovery/validate"
    )
      result = await services.recovery.validate(ctx, body);
    else if (method === "GET" && path === "/api/v1/retention/policy")
      result = await services.retention.policy(ctx);
    else if (method === "POST" && path === "/api/v1/retention/policy")
      result = await services.retention.setPolicy(ctx, body);
    else if (method === "POST" && path === "/api/v1/retention/holds")
      result = await services.retention.setHold(ctx, body);
    else if (method === "POST" && path === "/api/v1/retention/preview") {
      z.object({}).strict().parse(body);
      result = await services.retention.previewRetention(ctx);
    } else if (method === "POST" && path === "/api/v1/retention/execute")
      result = await services.retention.executeRetention(ctx, body);
    else if (method === "GET" && path === "/api/v1/retention/receipts")
      result = await services.retention.receipts(ctx);
    else return false;
    send(200, result);
    return true;
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (!retentionErrorStatuses[code]) throw e;
    send(retentionErrorStatuses[code], { code });
    return true;
  }
}
