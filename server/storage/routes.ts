import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "../service";
import { StorageService } from "./service";
import { UrlCollector } from "./collection";
import { z } from "zod";
import { collectArtifact, collectorSupport } from "./collectors";
const parent = z
  .object({
    kind: z.enum(["source", "page"]),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  })
  .strict();
export interface StorageRouteInput {
  method: string;
  path: string;
  body: unknown;
  ctx: Context;
  send: (status: number, body: unknown) => void;
  req?: IncomingMessage;
  res?: ServerResponse;
}
/** Mount ONLY after authenticated session, CSRF, selected-space and host body-size checks.
 * For PUT raw stream: skip host JSON parsing and pass req; metadata comes only from fixed headers.
 * Returning false means not handled. Errors intentionally propagate to the host error mapper.
 */
export function storageRoutes(
  service: StorageService,
  collector?: UrlCollector,
) {
  return async function handleStorageRoute({
    method,
    path,
    body,
    ctx,
    send,
    req,
    res,
  }: StorageRouteInput): Promise<boolean> {
    if (!path.startsWith("/api/v1/storage/")) return false;
    const suffix = path.slice("/api/v1/storage/".length);
    if (method === "PUT" && suffix === "blobs") {
      if (!req) throw Error("RAW_STREAM_REQUIRED");
      const header = z.string().max(1000).parse(req.headers["x-filename"]);
      const d = {
        parent: {
          kind: req.headers["x-parent-kind"],
          id: req.headers["x-parent-id"],
        },
        filename: decodeURIComponent(header),
        mime: req.headers["content-type"],
        slotId: req.headers["x-attachment-slot"],
        expectedHead: req.headers["x-expected-head"],
        expectedRevision:
          req.headers["x-expected-revision"] === undefined
            ? undefined
            : Number(
                z
                  .string()
                  .regex(/^[1-9][0-9]{0,8}$/)
                  .parse(req.headers["x-expected-revision"]),
              ),
      };
      send(201, await service.upload(ctx, d, req));
      return true;
    }
    const attachment =
      /^attachments\/([a-zA-Z0-9_-]+)(?:\/(preview|history|withdraw|propose-link|versions\/([1-9][0-9]{0,8})(?:\/(preview))?))?$/.exec(
        suffix,
      );
    if (attachment) {
      if (
        method === "GET" &&
        (attachment[2] === "preview" || attachment[4] === "preview")
      ) {
        send(
          200,
          await service.previewAttachment(
            ctx,
            attachment[1],
            attachment[3] ? Number(attachment[3]) : undefined,
          ),
        );
        return true;
      }
      if (method === "GET" && (!attachment[2] || attachment[3])) {
        const result = await service.downloadAttachment(
          ctx,
          attachment[1],
          attachment[3] ? Number(attachment[3]) : undefined,
        );
        if (!res) throw Error("RAW_RESPONSE_REQUIRED");
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": result.bytes.length,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        });
        res.end(result.bytes);
        return true;
      }
      if (method === "GET" && attachment[2] === "history") {
        send(200, await service.attachmentHistory(ctx, attachment[1]));
        return true;
      }
      if (method === "POST" && attachment[2] === "history") {
        const d = z
          .object({ offset: z.number().int().min(0).max(1000000).default(0) })
          .strict()
          .parse(body);
        send(
          200,
          await service.attachmentHistory(ctx, attachment[1], d.offset),
        );
        return true;
      }
      if (method === "POST" && attachment[2] === "withdraw") {
        send(200, await service.withdrawAttachment(ctx, attachment[1], body));
        return true;
      }
      if (method === "POST" && attachment[2] === "propose-link") {
        send(
          201,
          await service.proposeAttachmentLink(ctx, attachment[1], body),
        );
        return true;
      }
    }
    const match =
      /^blobs\/([a-zA-Z0-9_-]+)(?:\/(extract|ticket|local-copy))?$/.exec(
        suffix,
      );
    if (match && method === "GET" && (!match[2] || match[2] === "local-copy")) {
      const result = await service.download(
        ctx,
        match[1],
        match[2] === "local-copy" ? "local.copy" : "knowledge.read",
      );
      if (!res) throw Error("RAW_RESPONSE_REQUIRED");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": result.bytes.length,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(result.bytes);
      return true;
    }
    if (match && method === "POST" && match[2] === "extract") {
      send(200, await service.extract(ctx, match[1]));
      return true;
    }
    if (match && method === "POST" && match[2] === "ticket") {
      const d = z
        .object({ seconds: z.number().int().min(1).max(300).default(60) })
        .strict()
        .parse(body);
      send(201, await service.ticket(ctx, match[1], d.seconds));
      return true;
    }
    if (method === "POST" && suffix === "list") {
      const d = parent
        .extend({ offset: z.number().int().min(0).max(1000000).default(0) })
        .parse(body);
      send(200, await service.list(ctx, { kind: d.kind, id: d.id }, d.offset));
      return true;
    }
    if (method === "POST" && suffix === "sources") {
      const manual = z
        .object({
          title: z.string(),
          content: z.string(),
          project: z.string(),
          tool: z.literal("manual"),
          targetPageId: z.string().optional(),
        })
        .strict()
        .parse(body);
      send(201, await service.ingestText(ctx, manual));
      return true;
    }
    if (method === "GET" && suffix === "collectors") {
      send(200, { items: collectorSupport });
      return true;
    }
    if (method === "POST" && suffix === "collect-artifact") {
      const d = z
        .object({
          artifact: z.unknown(),
          tool: z.string(),
          version: z.string(),
          format: z.string(),
          selectedIds: z.array(z.string()).max(100),
          excludedSessionIds: z.array(z.string()).max(100),
          sessionId: z.string().max(200).optional(),
          selectedToolIds: z.array(z.string().max(200)).max(100).optional(),
          title: z.string(),
          project: z.string(),
          targetPageId: z.string().optional(),
        })
        .strict()
        .parse(body);
      let artifact: ReturnType<typeof collectArtifact>;
      try {
        artifact = collectArtifact(d.artifact, d);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "ARTIFACT_SESSION_UNVERIFIED"
        ) {
          send(409, {
            code: "ARTIFACT_SESSION_UNVERIFIED",
            message:
              "원본과 세션의 신뢰 가능한 연결 및 제외 정책을 확인할 수 없어 자동 수집이 중단되었습니다.",
          });
          return true;
        }
        throw error;
      }
      send(
        201,
        await service.ingestText(ctx, {
          title: d.title,
          project: d.project,
          targetPageId: d.targetPageId,
          tool: `${artifact.tool}@${artifact.toolVersion}`,
          content: artifact.content,
          collection: {
            format: d.format,
            kind: artifact.kind,
            omitted: artifact.omitted,
          },
          external: {
            id: artifact.externalId,
            sessionId: artifact.sessionId,
            version: artifact.version,
          },
        }),
      );
      return true;
    }
    if (method === "POST" && suffix === "snapshot") {
      const d = z.object({ sourceId: z.string() }).strict().parse(body);
      send(201, await service.snapshot(ctx, d.sourceId));
      return true;
    }
    if (method === "POST" && suffix === "export") {
      send(200, await service.export(ctx, body));
      return true;
    }
    if (method === "POST" && suffix === "import") {
      send(201, await service.import(ctx, body));
      return true;
    }
    const proposal = /^imports\/([a-zA-Z0-9_-]+)$/.exec(suffix);
    const submitImport = /^imports\/([a-zA-Z0-9_-]+)\/propose$/.exec(suffix);
    if (method === "POST" && submitImport) {
      send(201, await service.proposeImport(ctx, submitImport[1], body));
      return true;
    }
    if (method === "GET" && proposal) {
      send(200, await service.importProposal(ctx, proposal[1]));
      return true;
    }
    if (method === "POST" && suffix === "collect-url") {
      if (!collector) throw Error("EXTERNAL_COLLECTION_DISABLED");
      const d = z
        .object({ url: z.string().url().max(2048), parent })
        .strict()
        .parse(body);
      // Preflight permission before any network; upload revalidates again after collection.
      await service.preflightUpload(ctx, d.parent);
      const result = await collector.collect(d.url);
      send(
        201,
        await service.upload(
          ctx,
          { parent: d.parent, filename: result.filename, mime: result.mime },
          (async function* () {
            yield result.bytes;
          })(),
        ),
      );
      return true;
    }
    if (method === "POST" && suffix === "tickets/revoke") {
      const d = z
        .object({ token: z.string().max(100) })
        .strict()
        .parse(body);
      send(200, await service.revokeTicket(ctx, d.token));
      return true;
    }
    if (method === "POST" && suffix === "tickets/redeem") {
      const d = z
        .object({ token: z.string().max(100) })
        .strict()
        .parse(body);
      const result = await service.redeem(ctx, d.token);
      if (!res) throw Error("RAW_RESPONSE_REQUIRED");
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": "attachment",
      });
      res.end(result.bytes);
      return true;
    }
    return false;
  };
}
