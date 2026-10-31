import { z } from "zod";
import type { Context } from "../service";
import { OperationsService, appendOperationalAudit } from "./service";
import {
  archiveAudit,
  auditArchives,
  type AuditArchiveTarget,
} from "./archive";
import {
  exportAuditAnchor,
  verifyAuditAnchorHistory,
  type AuditHeadStore,
} from "./audit-protocol";
import { previewErasure, executeErasure } from "./erasure";
import { effectiveAccess } from "../access/index";
import { requireRead } from "../repository";
import { randomUUID } from "node:crypto";
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
  anchor: AuditHeadStore["anchor"];
  readAnchor: (workspaceId: string) => Promise<string | null>;
  archiveTarget?: AuditArchiveTarget;
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
    if (method === "POST" && route === "audit/archives/verify") {
      if (!exportConfig?.archiveTarget)
        throw Error("AUDIT_ARCHIVE_TARGET_REQUIRED");
      z.object({ confirm: z.literal("VERIFY_INDEPENDENT_AUDIT_ROOTS") })
        .strict()
        .parse(body);
      send(
        200,
        await verifyAuditAnchorHistory(service, ctx, {
          target: exportConfig.archiveTarget,
          key: exportConfig.encryptionKey,
          signingKey: exportConfig.signingKey,
          readAnchor: exportConfig.readAnchor,
          anchor: exportConfig.anchor,
        }),
      );
      return true;
    }
    if (method === "POST" && route === "erasure/preview") {
      send(200, await previewErasure(service, ctx, body));
      return true;
    }
    if (method === "POST" && route === "erasure/execute") {
      const receipt = await executeErasure(service, ctx, body);
      if (deletionAdapter && service.options.physicalDeletionGateConfirmed) {
        const physical = await service.purgeApprovedBlobs(ctx, (h) =>
          deletionAdapter.remove(h),
        );
        const completion = physical.finalized.find(
          (r) =>
            r.previewHash === (body as { previewHash: string }).previewHash,
        );
        send(200, {
          ...receipt,
          ...(completion
            ? { status: "completed", completionReceiptId: completion.id }
            : {}),
          physical,
        });
      } else send(200, receipt);
      return true;
    }
    if (method === "POST" && route === "audit/archives") {
      const d = z
        .object({ offset: z.number().int().min(0).default(0) })
        .strict()
        .parse(body);
      send(200, await auditArchives(service, ctx, d.offset));
      return true;
    }
    if (method === "POST" && route === "audit/archive") {
      if (!exportConfig?.archiveTarget)
        throw Error("AUDIT_ARCHIVE_TARGET_REQUIRED");
      const d = z
        .object({
          includeUnexpired: z.boolean().default(false),
          confirm: z.enum([
            "ARCHIVE_ACTIVE_AUDIT",
            "ARCHIVE_AND_PRUNE_EXPIRED_AUDIT",
          ]),
        })
        .strict()
        .parse(body);
      send(
        200,
        await archiveAudit(service, ctx, {
          ...d,
          target: exportConfig.archiveTarget,
          key: exportConfig.encryptionKey,
          signingKey: exportConfig.signingKey,
          readAnchor: exportConfig.readAnchor,
          anchor: exportConfig.anchor,
        }),
      );
      return true;
    }
    if (method === "POST" && route === "erasure/receipts") {
      const d = z
        .object({ offset: z.number().int().min(0).default(0) })
        .strict()
        .parse(body);
      send(
        200,
        await service.withAdminTransaction(ctx, async (db) => ({
          items: (
            await db.query(
              "SELECT id,preview_hash,scope,status,counts,error_code,created_at FROM operations_erasure_receipts WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 25 OFFSET $2",
              [ctx.workspaceId, d.offset],
            )
          ).rows,
          nextOffset: d.offset + 25,
        })),
      );
      return true;
    }
    if (method === "POST" && route === "legal-holds") {
      const d = z
        .object({
          resource: z
            .object({
              kind: z.enum(["source", "page", "workspace"]),
              id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
            })
            .strict(),
          active: z.boolean(),
          confirm: z.literal("CHANGE_LEGAL_HOLD"),
        })
        .strict()
        .parse(body);
      send(
        200,
        await service.withAdminTransaction(ctx, async (db) => {
          if (!(await effectiveAccess(db, ctx)).space.owner)
            throw Error("OWNER_REQUIRED");
          if (d.resource.kind !== "workspace")
            await requireRead(db, ctx, d.resource.kind, d.resource.id);
          else if (d.resource.id !== ctx.workspaceId) throw Error("NOT_FOUND");
          const id = randomUUID();
          await db.query(
            "UPDATE operations_legal_holds SET active=false WHERE workspace_id=$1 AND resource_kind=$2 AND resource_id=$3",
            [ctx.workspaceId, d.resource.kind, d.resource.id],
          );
          if (d.active)
            await db.query(
              "INSERT INTO operations_legal_holds(workspace_id,id,resource_kind,resource_id,placed_by) VALUES($1,$2,$3,$4,$5)",
              [
                ctx.workspaceId,
                id,
                d.resource.kind,
                d.resource.id,
                ctx.principalId,
              ],
            );
          await appendOperationalAudit(db, ctx, {
            operation: "content.legal-hold-change",
          });
          return { id, active: d.active };
        }),
      );
      return true;
    }
    if (method === "GET" && route === "status") {
      send(200, await service.status(ctx));
      return true;
    }
    if (method === "POST" && route === "tombstones/list") {
      const d = z
        .object({ offset: z.number().int().min(0).default(0) })
        .strict()
        .parse(body);
      send(
        200,
        await service.withAdminTransaction(ctx, async (db) => ({
          items: (
            await db.query(
              "SELECT t.id,t.resource_kind,t.resource_id,t.delete_content,t.created_at FROM operations_tombstones t WHERE t.workspace_id=$1 AND t.approved_by=$2 ORDER BY t.created_at DESC,t.id LIMIT 25 OFFSET $3",
              [ctx.workspaceId, ctx.principalId, d.offset],
            )
          ).rows,
          nextOffset: d.offset + 25,
        })),
      );
      return true;
    }
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
      if (!exportConfig?.archiveTarget)
        throw Error("AUDIT_EXPORT_NOT_CONFIGURED");
      z.object({ confirm: z.literal("EXPORT_ENCRYPTED_AUDIT") })
        .strict()
        .parse(body);
      send(
        200,
        await exportAuditAnchor(service, ctx, {
          target: exportConfig.archiveTarget,
          key: exportConfig.encryptionKey,
          signingKey: exportConfig.signingKey,
          readAnchor: exportConfig.readAnchor,
          anchor: exportConfig.anchor,
        }),
      );
      return true;
    }
    return false;
  };
}
