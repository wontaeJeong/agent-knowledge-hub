import { z } from "zod";
import type { Context } from "../service";
import { OperationsService, sealExport, verifyAuditAnchor } from "./service";
export interface OperationsRouteInput {
  method: string;
  path: string;
  body: unknown;
  ctx: Context;
  send: (status: number, body: unknown) => void;
}
export interface AuditExportConfig {
  encryptionKey: string;
  signingKey: string;
  anchor: (name: string, body: string) => Promise<void>;
  readAnchor: () => Promise<string | null>;
}
/** Mount after authenticated selected-space resolution and CSRF. Never expose raw backup/DB dump over web. */
export function operationsRoutes(
  service: OperationsService,
  exportConfig?: AuditExportConfig,
  deletionAdapter?: { remove: (hash: string) => Promise<void> },
) {
  return async function handleOperationsRoute({
    method,
    path,
    body,
    ctx,
    send,
  }: OperationsRouteInput): Promise<boolean> {
    if (!path.startsWith("/api/v1/operations/")) return false;
    const route = path.slice("/api/v1/operations/".length);
    if (method === "GET" && route === "policy") {
      send(200, await service.policy(ctx));
      return true;
    }
    if (method === "PUT" && route === "policy") {
      send(200, await service.setPolicy(ctx, body));
      return true;
    }
    if (method === "POST" && route === "tombstones") {
      send(201, await service.tombstone(ctx, body));
      return true;
    }
    if (method === "POST" && route === "tombstones/purge-blobs") {
      if (!deletionAdapter) throw Error("PHYSICAL_DELETION_NOT_CONFIGURED");
      z.object({ confirm: z.literal("PURGE_PREVIOUSLY_APPROVED_BLOBS") })
        .strict()
        .parse(body);
      send(
        200,
        await service.purgeApprovedBlobs(ctx, (h) => deletionAdapter.remove(h)),
      );
      return true;
    }
    if (method === "GET" && route === "tombstones") {
      send(200, { items: await service.tombstones(ctx) });
      return true;
    }
    if (method === "POST" && route === "retention/telemetry") {
      z.object({ confirm: z.literal("PRUNE_TELEMETRY") })
        .strict()
        .parse(body);
      send(200, await service.pruneTelemetry(ctx));
      return true;
    }
    if (method === "POST" && route === "audit/export") {
      if (!exportConfig) throw Error("AUDIT_EXPORT_NOT_CONFIGURED");
      z.object({ confirm: z.literal("EXPORT_ENCRYPTED_AUDIT") })
        .strict()
        .parse(body);
      const rows = await service.auditRows(ctx);
      const previous = await exportConfig.readAnchor();
      if (
        previous !== null &&
        !verifyAuditAnchor(
          rows,
          previous,
          exportConfig.encryptionKey,
          exportConfig.signingKey,
        )
      )
        throw Error("AUDIT_ANCHOR_MISMATCH");
      const encrypted = sealExport(
        rows,
        exportConfig.encryptionKey,
        exportConfig.signingKey,
      );
      const name = `audit-${ctx.workspaceId}-${Date.now()}.akh-backup`;
      // An independently retained signed encrypted copy detects later DB rewrite/truncation.
      await exportConfig.anchor(name, encrypted);
      send(200, { encrypted, anchored: true, count: rows.length });
      return true;
    }
    return false;
  };
}
