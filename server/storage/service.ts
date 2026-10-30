import { randomUUID, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { ImportWorkflow, readImportArchive } from "./imports";
import { AttachmentWorkflow } from "./attachments";
import { acquireSharedMutationGate } from "../operations/gate";
import { statfs } from "node:fs/promises";
import { transaction } from "../database";
import {
  membership,
  requireRead,
  loadState,
  audit,
  readers,
  addResource,
} from "../repository";
import { visiblePageIds, inheritedProvenance } from "../provenance";
import {
  FileBlobStore,
  bounded,
  inspectContent,
  sha256,
  MAX_BYTES,
} from "./content";

export type StorageResource = { kind: "source" | "page"; id: string };
export type StorageAuthorizer = (
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: StorageResource,
) => Promise<void>;
export interface StorageOptions {
  minimumAvailableBytes?: number;
  /** Trusted test/deployment adapter, never a request field. */ capacityProbe?: (
    root: string,
  ) => Promise<bigint>;
}
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const resource = z.object({ kind: z.enum(["source", "page"]), id }).strict();
const uploadSchema = z
  .object({
    parent: resource,
    filename: z.string().max(200),
    mime: z.string().max(100),
    slotId: id.optional(),
    expectedHead: id.optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
type BlobRow = {
  id: string;
  parent_kind: "source" | "page";
  parent_id: string;
  sha256: string;
  size: number;
  mime: string;
  filename: string;
  scan_state: string;
  attachment?: {
    slotId: string;
    revision: number;
    headId: string;
    headRevision: number;
  } | null;
};
const manifestSchema = z
  .object({
    format: z.literal("akh-export"),
    version: z.literal(1),
    workspaceId: id,
    exportedAt: z.iso.datetime(),
    pages: z
      .array(
        z
          .object({
            id,
            data: z.record(z.string(), z.unknown()),
            versions: z.array(z.record(z.string(), z.unknown())).max(100),
            operational: z
              .record(z.string(), z.unknown())
              .nullable()
              .optional(),
            readers: z.array(z.string().min(1).max(200)).max(100),
          })
          .strict(),
      )
      .max(100),
    sources: z
      .array(
        z
          .object({
            id,
            data: z.record(z.string(), z.unknown()),
            operational: z
              .record(z.string(), z.unknown())
              .nullable()
              .optional(),
            readers: z.array(z.string().min(1).max(200)).max(100),
          })
          .strict(),
      )
      .max(100),
    blobs: z
      .array(
        z
          .object({
            id,
            parent: resource,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            mime: z.string(),
            filename: z.string(),
            base64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
            scanState: z.literal("clean"),
            attachment: z
              .object({
                slotId: id,
                revision: z.number().int().positive(),
                headId: id,
                headRevision: z.number().int().positive(),
              })
              .strict()
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type StorageManifest = z.infer<typeof manifestSchema>;

/** Host must authenticate and resolve selected space before constructing Context. */
export class StorageService {
  constructor(
    readonly pool: Pool,
    readonly files: FileBlobStore,
    readonly authorize: StorageAuthorizer,
    readonly options: StorageOptions = {},
  ) {
    if (typeof authorize !== "function") throw Error("AUTHORIZER_REQUIRED");
    if (
      options.minimumAvailableBytes !== undefined &&
      (!Number.isSafeInteger(options.minimumAvailableBytes) ||
        options.minimumAvailableBytes < MAX_BYTES)
    )
      throw Error("INVALID_STORAGE_RESERVE");
  }
  async writeContent(db: PoolClient, bytes: Buffer) {
    await acquireSharedMutationGate(db);
    await this.files.prepareRoot();
    let available: bigint;
    try {
      available = this.options.capacityProbe
        ? await this.options.capacityProbe(this.files.root)
        : await statfs(this.files.root, { bigint: true }).then(
            (s) => s.bavail * s.bsize,
          );
      if (typeof available !== "bigint" || available < 0n)
        throw Error("UNKNOWN");
    } catch {
      throw Error("STORAGE_CAPACITY_UNKNOWN");
    }
    if (
      available <
      BigInt(this.options.minimumAvailableBytes ?? 64 * 1024 * 1024) +
        BigInt(bytes.length)
    )
      throw Error("STORAGE_CAPACITY_LOW");
    return this.files.put(
      (async function* () {
        yield bytes;
      })(),
    );
  }
  async recheck(
    db: PoolClient,
    ctx: Context,
    action: string,
    parent?: StorageResource,
  ) {
    await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await this.authorize(db, ctx, action, parent);
    if (parent) await this.parent(db, ctx, parent);
  }
  async run<T>(
    ctx: Context,
    action: string,
    parent: StorageResource | undefined,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await acquireSharedMutationGate(db);
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action, parent);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  async parent(db: PoolClient, ctx: Context, p: StorageResource) {
    resource.parse(p);
    await requireRead(db, ctx, p.kind, p.id);
    if (
      p.kind === "page" &&
      !(
        await visiblePageIds(db, ctx, await loadState(db, ctx.workspaceId))
      ).has(p.id)
    )
      throw Error("NOT_FOUND");
    const r = await db.query(
      `SELECT id FROM ${p.kind === "source" ? "sources" : "pages"} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, p.id],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
  }
  private async authorizeParent(
    db: PoolClient,
    ctx: Context,
    action: string,
    p: StorageResource,
  ) {
    await this.authorize(db, ctx, action, p);
    if (!["data.export", "local.copy"].includes(action) || p.kind !== "page")
      return;
    const state = await loadState(db, ctx.workspaceId),
      pending = [p.id],
      seen = new Set<string>();
    while (pending.length) {
      const pageId = pending.pop()!;
      if (seen.has(pageId)) continue;
      seen.add(pageId);
      const page = state.pages.find((page) => page.id === pageId);
      if (!page) throw Error("NOT_FOUND");
      await this.authorize(db, ctx, action, { kind: "page", id: pageId });
      const ancestry = inheritedProvenance(page);
      for (const sid of ancestry.sourceIds)
        await this.authorize(db, ctx, action, { kind: "source", id: sid });
      pending.push(
        ...ancestry.pageIds,
        ...(page.links ?? []).filter((link) =>
          state.pages.some((p) => p.id === link),
        ),
      );
      const parent = await db.query(
        "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, pageId],
      );
      if (parent.rows[0]?.parent_id) pending.push(parent.rows[0].parent_id);
    }
  }
  async blob(db: PoolClient, ctx: Context, blobId: string): Promise<BlobRow> {
    const r = await db.query(
      "SELECT * FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, id.parse(blobId)],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    const b = r.rows[0] as BlobRow;
    await this.parent(db, ctx, { kind: b.parent_kind, id: b.parent_id });
    const slot = await db.query(
      "SELECT s.withdrawn FROM storage_attachment_versions v JOIN storage_attachment_slots s ON s.workspace_id=v.workspace_id AND s.id=v.slot_id WHERE v.workspace_id=$1 AND v.blob_id=$2",
      [ctx.workspaceId, blobId],
    );
    if (slot.rows[0]?.withdrawn) throw Error("NOT_FOUND");
    return b;
  }
  async preflightUpload(ctx: Context, parent: StorageResource) {
    return this.run(ctx, "source.create", parent, (db) =>
      this.parent(db, ctx, parent),
    );
  }
  async ingestText(ctx: Context, input: unknown) {
    const d = z
      .object({
        title: z.string().trim().min(1).max(300),
        content: z.string().min(1).max(100000),
        project: z.string().min(1).max(200),
        tool: z.string().min(1).max(100),
        targetPageId: id.optional(),
        collection: z
          .object({
            format: z.string().max(100),
            kind: z.enum(["author-statement", "tool-output", "mixed-artifact"]),
            omitted: z.record(
              z.string().max(100),
              z.number().int().min(0).max(10000),
            ),
          })
          .strict()
          .optional(),
        external: z
          .object({
            id: z.string().min(1).max(200),
            version: z.number().int().positive(),
            sessionId: z.string().max(200),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input);
    await this.run(ctx, "source.create", undefined, async (db) => {
      if (d.targetPageId)
        await this.parent(db, ctx, { kind: "page", id: d.targetPageId });
    });
    const bytes = Buffer.from(d.content);
    inspectContent(bytes, "text/plain", "source.txt");
    return this.run(ctx, "source.create", undefined, async (db) => {
      if (d.targetPageId)
        await this.parent(db, ctx, { kind: "page", id: d.targetPageId });
      const key = sha256(
        JSON.stringify({
          tool: d.tool,
          external: d.external ?? null,
          hash: sha256(bytes),
        }),
      );
      if (d.external) {
        const prior = await db.query(
          "SELECT manifest FROM storage_imports WHERE workspace_id=$1 AND principal_id=$2 AND manifest->>'type'='collected-source' AND manifest->>'tool'=$3 AND manifest->'external'->>'id'=$4 ORDER BY (manifest->'external'->>'version')::bigint DESC LIMIT 1",
          [ctx.workspaceId, ctx.principalId, d.tool, d.external.id],
        );
        if (prior.rowCount) {
          const p = prior.rows[0].manifest;
          await this.parent(db, ctx, { kind: "source", id: p.sourceId });
          if (p.external.version > d.external.version)
            return { id: p.sourceId, duplicate: true, stale: true };
          if (p.external.version === d.external.version) {
            if (p.hash !== sha256(bytes)) throw Error("EVENT_CONFLICT");
            return { id: p.sourceId, duplicate: true, stale: false };
          }
        }
      }
      const saved = await this.writeContent(db, bytes);
      await this.recheck(db, ctx, "source.create");
      if (d.targetPageId)
        await this.parent(db, ctx, { kind: "page", id: d.targetPageId });
      const sourceId = randomUUID(),
        blobId = randomUUID(),
        snapshotId = randomUUID();
      const source = {
        id: sourceId,
        title: d.title,
        tool: d.tool,
        project: d.project,
        content: d.content,
        scope: "private",
        verification: "미검증",
        createdAt: new Date().toISOString(),
        processed: false,
        targetPageId: d.targetPageId ?? "",
        authorPrincipalId: ctx.principalId,
        projectVerified: false,
        collection: d.collection ?? null,
        external: d.external ?? null,
      };
      await addResource(db, ctx.workspaceId, "source", sourceId, [
        ctx.principalId,
      ]);
      await db.query(
        "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
        [ctx.workspaceId, sourceId, source],
      );
      await db.query(
        "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'source',$3,$4,$5,'text/plain','source.txt','clean',$6)",
        [
          ctx.workspaceId,
          blobId,
          sourceId,
          saved.sha256,
          saved.size,
          ctx.principalId,
        ],
      );
      await db.query(
        "INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,$2,$3,$4,$5)",
        [ctx.workspaceId, snapshotId, sourceId, blobId, saved.sha256],
      );
      if (d.external)
        await db.query(
          "INSERT INTO storage_imports(workspace_id,id,principal_id,digest,manifest) VALUES($1,$2,$3,$4,$5)",
          [
            ctx.workspaceId,
            randomUUID(),
            ctx.principalId,
            key,
            {
              type: "collected-source",
              tool: d.tool,
              external: d.external,
              sourceId,
              hash: saved.sha256,
            },
          ],
        );
      await audit(db, ctx, "source.collect", sourceId);
      return {
        id: sourceId,
        blobId,
        snapshotId,
        duplicate: false,
        stale: false,
      };
    });
  }
  async upload(
    ctx: Context,
    metadata: unknown,
    stream: AsyncIterable<Uint8Array>,
  ) {
    const d = uploadSchema.parse(metadata);
    if (
      (d.slotId !== undefined) !== (d.expectedHead !== undefined) ||
      (d.slotId !== undefined) !== (d.expectedRevision !== undefined)
    )
      throw Error("UPLOAD_CAS_REQUIRED");
    const attachments = new AttachmentWorkflow(this);
    await this.run(ctx, "source.create", d.parent, async (db) => {
      await attachments.writableParent(db, ctx, d.parent);
      if (d.slotId)
        await attachments.expectedSlot(
          db,
          ctx,
          d.slotId,
          d.expectedHead!,
          d.expectedRevision!,
          d.parent,
        );
    });
    const bytes = await bounded(stream);
    const check = inspectContent(bytes, d.mime, d.filename);
    return this.run(ctx, "source.create", d.parent, async (db) => {
      await attachments.writableParent(db, ctx, d.parent);
      if (d.slotId)
        await attachments.expectedSlot(
          db,
          ctx,
          d.slotId,
          d.expectedHead!,
          d.expectedRevision!,
          d.parent,
        );
      const saved = await this.writeContent(db, bytes);
      await this.recheck(db, ctx, "source.create", d.parent);
      await attachments.writableParent(db, ctx, d.parent);
      if (d.slotId)
        await attachments.expectedSlot(
          db,
          ctx,
          d.slotId,
          d.expectedHead!,
          d.expectedRevision!,
          d.parent,
        );
      const blobId = randomUUID();
      await db.query(
        "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          ctx.workspaceId,
          blobId,
          d.parent.kind,
          d.parent.id,
          saved.sha256,
          saved.size,
          d.mime,
          d.filename,
          check.scanState,
          ctx.principalId,
        ],
      );
      const slotId = d.slotId ?? randomUUID(),
        revision = (d.expectedRevision ?? 0) + 1;
      if (d.slotId)
        await db.query(
          "UPDATE storage_attachment_slots SET head_id=$3,revision=$4 WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, slotId, blobId, revision],
        );
      else
        await db.query(
          "INSERT INTO storage_attachment_slots(workspace_id,id,parent_kind,parent_id,head_id,revision) VALUES($1,$2,$3,$4,$5,1)",
          [ctx.workspaceId, slotId, d.parent.kind, d.parent.id, blobId],
        );
      await db.query(
        "INSERT INTO storage_attachment_versions VALUES($1,$2,$3,$4)",
        [ctx.workspaceId, slotId, revision, blobId],
      );
      await audit(db, ctx, "blob.upload", blobId);
      return {
        id: blobId,
        slotId,
        revision,
        downloadPath: `/api/v1/storage/blobs/${blobId}`,
        ...saved,
        ...check,
        text: undefined,
      };
    });
  }
  async list(ctx: Context, parent: StorageResource, offset = 0) {
    z.number().int().min(0).max(1000000).parse(offset);
    return this.run(ctx, "knowledge.read", parent, async (db) => {
      await this.parent(db, ctx, parent);
      const r = await db.query(
        "SELECT b.id,b.filename,b.mime,b.size,b.scan_state,b.created_at,v.slot_id,v.revision AS file_revision,s.revision AS head_revision,s.head_id,s.withdrawn,(s.head_id=b.id) AS is_head FROM storage_blobs b LEFT JOIN storage_attachment_versions v ON v.workspace_id=b.workspace_id AND v.blob_id=b.id LEFT JOIN storage_attachment_slots s ON s.workspace_id=v.workspace_id AND s.id=v.slot_id WHERE b.workspace_id=$1 AND b.parent_kind=$2 AND b.parent_id=$3 ORDER BY b.created_at DESC,b.id DESC LIMIT 25 OFFSET $4",
        [ctx.workspaceId, parent.kind, parent.id, offset],
      );
      const count = await db.query(
        "SELECT count(*)::int AS total FROM storage_blobs WHERE workspace_id=$1 AND parent_kind=$2 AND parent_id=$3",
        [ctx.workspaceId, parent.kind, parent.id],
      );
      return {
        items: r.rows,
        total: count.rows[0].total as number,
        offset,
        limit: 25,
      };
    });
  }
  async download(ctx: Context, blobId: string, action = "knowledge.read") {
    const b = await this.run(ctx, "knowledge.read", undefined, async (db) => {
      const b = await this.blob(db, ctx, blobId);
      await this.authorizeParent(db, ctx, action, {
        kind: b.parent_kind,
        id: b.parent_id,
      });
      if (action === "local.copy")
        await this.authorizeParent(db, ctx, "data.export", {
          kind: b.parent_kind,
          id: b.parent_id,
        });
      if (b.scan_state !== "clean") throw Error("SCAN_REQUIRED");
      return b;
    });
    const bytes = await this.files.get(b.sha256);
    await this.run(ctx, "knowledge.read", undefined, async (db) => {
      const now = await this.blob(db, ctx, blobId);
      await this.authorizeParent(db, ctx, action, {
        kind: b.parent_kind,
        id: b.parent_id,
      });
      if (action === "local.copy")
        await this.authorizeParent(db, ctx, "data.export", {
          kind: b.parent_kind,
          id: b.parent_id,
        });
      if (now.scan_state !== "clean") throw Error("SCAN_REQUIRED");
      await audit(
        db,
        ctx,
        action === "data.export" || action === "local.copy"
          ? "blob.export"
          : "blob.download",
        blobId,
      );
    });
    return { bytes, filename: b.filename, mime: b.mime, sha256: b.sha256 };
  }
  async extract(ctx: Context, blobId: string) {
    const b = await this.download(ctx, blobId);
    const check = inspectContent(b.bytes, b.mime, b.filename);
    if (check.extraction !== "text") throw Error("UNSUPPORTED_CONVERSION");
    return { text: check.text, extraction: "complete", sha256: b.sha256 };
  }
  /** Called only by a trusted deployment scanner adapter, never exposed as an HTTP action. */
  async recordScan(
    ctx: Context,
    blobId: string,
    expectedHash: string,
    verdict: "clean" | "rejected",
  ) {
    if (!["clean", "rejected"].includes(verdict))
      throw Error("VALIDATION_FAILED");
    return this.run(ctx, "scan.manage", undefined, async (db) => {
      const b = await this.blob(db, ctx, blobId);
      if (b.sha256 !== expectedHash) throw Error("STALE_VERSION");
      await db.query(
        "UPDATE storage_blobs SET scan_state=$3 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, blobId, verdict],
      );
      await audit(db, ctx, "blob.scan." + verdict, blobId);
      return { id: blobId, scanState: verdict };
    });
  }
  async snapshot(ctx: Context, sourceId: string) {
    const p: StorageResource = { kind: "source", id: id.parse(sourceId) };
    const source = await this.run(ctx, "source.create", p, async (db) => {
      await this.parent(db, ctx, p);
      const s = await db.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, sourceId],
      );
      return s.rows[0].data;
    });
    const bytes = Buffer.from(JSON.stringify(source));
    inspectContent(bytes, "application/json", "source.json");
    return this.run(ctx, "source.create", p, async (db) => {
      await this.parent(db, ctx, p);
      const s = await db.query(
        "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, sourceId],
      );
      if (JSON.stringify(s.rows[0].data) !== JSON.stringify(source))
        throw Error("STALE_VERSION");
      const old = await db.query(
        "SELECT id,blob_id FROM storage_snapshots WHERE workspace_id=$1 AND source_id=$2 AND content_hash=$3",
        [ctx.workspaceId, sourceId, sha256(bytes)],
      );
      if (old.rowCount) return old.rows[0];
      const saved = await this.writeContent(db, bytes);
      await this.recheck(db, ctx, "source.create", p);
      const blobId = randomUUID(),
        snapshotId = randomUUID();
      await db.query(
        "INSERT INTO storage_blobs(workspace_id,id,parent_kind,parent_id,sha256,size,mime,filename,scan_state,created_by) VALUES($1,$2,'source',$3,$4,$5,'application/json','source.json','clean',$6)",
        [
          ctx.workspaceId,
          blobId,
          sourceId,
          saved.sha256,
          saved.size,
          ctx.principalId,
        ],
      );
      await db.query(
        "INSERT INTO storage_snapshots(workspace_id,id,source_id,blob_id,content_hash) VALUES($1,$2,$3,$4,$5)",
        [ctx.workspaceId, snapshotId, sourceId, blobId, saved.sha256],
      );
      await audit(db, ctx, "source.snapshot", snapshotId);
      return { id: snapshotId, blob_id: blobId };
    });
  }
  async ticket(ctx: Context, blobId: string, seconds = 60) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300)
      throw Error("VALIDATION_FAILED");
    const token = randomBytes(32).toString("base64url");
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const b = await this.blob(db, ctx, blobId);
      if (b.scan_state !== "clean") throw Error("SCAN_REQUIRED");
      await db.query(
        "INSERT INTO storage_tickets(workspace_id,token_hash,blob_id,principal_id,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second')",
        [ctx.workspaceId, sha256(token), blobId, ctx.principalId, seconds],
      );
      return { token, expiresIn: seconds };
    });
  }
  async redeem(ctx: Context, token: string) {
    const get = () =>
      this.run(ctx, "knowledge.read", undefined, async (db) => {
        const r = await db.query(
          "SELECT blob_id FROM storage_tickets WHERE workspace_id=$1 AND token_hash=$2 AND principal_id=$3 AND NOT revoked AND expires_at>now()",
          [ctx.workspaceId, sha256(token), ctx.principalId],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        return r.rows[0].blob_id as string;
      });
    const blobId = await get();
    const result = await this.download(ctx, blobId);
    await get();
    return result;
  }
  async revokeTicket(ctx: Context, token: string) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      await db.query(
        "UPDATE storage_tickets SET revoked=true WHERE workspace_id=$1 AND token_hash=$2 AND principal_id=$3",
        [ctx.workspaceId, sha256(token), ctx.principalId],
      );
      return { revoked: true };
    });
  }
  async export(ctx: Context, input: unknown) {
    const request = z
      .object({
        pageIds: z.array(id).max(100).default([]),
        sourceIds: z.array(id).max(100).default([]),
      })
      .strict()
      .parse(input);
    if (!request.pageIds.length && !request.sourceIds.length)
      throw Error("VALIDATION_FAILED");
    const prepared = await this.run(
      ctx,
      "knowledge.read",
      undefined,
      async (db) => {
        const state = await loadState(db, ctx.workspaceId);
        const visible = await visiblePageIds(db, ctx, state);
        const pageIds = new Set(request.pageIds),
          sourceIds = new Set(request.sourceIds);
        // Include complete historical/transitive ancestry or reject, never silently omit protected inputs.
        for (const pageId of pageIds) {
          if (!visible.has(pageId)) throw Error("NOT_FOUND");
          const p = state.pages.find((p) => p.id === pageId)!;
          const inputs = inheritedProvenance(p);
          for (const sid of inputs.sourceIds) sourceIds.add(sid);
          for (const pid of [...inputs.pageIds, ...(p.links ?? [])])
            pageIds.add(pid);
          const tree = await db.query(
            "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
            [ctx.workspaceId, pageId],
          );
          if (tree.rows[0]?.parent_id) pageIds.add(tree.rows[0].parent_id);
          if (pageIds.size > 100 || sourceIds.size > 100)
            throw Error("PAYLOAD_TOO_LARGE");
        }
        const pages = [];
        for (const pageId of pageIds) {
          const parent: StorageResource = { kind: "page", id: pageId };
          await this.parent(db, ctx, parent);
          await this.authorizeParent(db, ctx, "data.export", parent);
          const { versions, ...data } = state.pages.find(
            (p) => p.id === pageId,
          )!;
          const operational = await db.query(
            "SELECT revision,state,parent_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
            [ctx.workspaceId, pageId],
          );
          pages.push({
            id: pageId,
            data,
            versions,
            readers: await readers(db, ctx.workspaceId, "page", pageId),
            operational: operational.rows[0] ?? null,
          });
        }
        const sources = [];
        for (const sid of sourceIds) {
          const parent: StorageResource = { kind: "source", id: sid };
          await this.parent(db, ctx, parent);
          await this.authorizeParent(db, ctx, "data.export", parent);
          const operational = await db.query(
            "SELECT revision,state,data FROM workflow_source_state WHERE workspace_id=$1 AND source_id=$2",
            [ctx.workspaceId, sid],
          );
          sources.push({
            id: sid,
            data: state.sources.find((s) => s.id === sid)!,
            readers: await readers(db, ctx.workspaceId, "source", sid),
            operational: operational.rows[0] ?? null,
          });
        }
        const blobs = await db.query(
          "SELECT b.*,CASE WHEN v.slot_id IS NOT NULL THEN jsonb_build_object('slotId',v.slot_id,'revision',v.revision,'headId',s.head_id,'headRevision',s.revision) ELSE NULL END AS attachment FROM storage_blobs b LEFT JOIN storage_attachment_versions v ON v.workspace_id=b.workspace_id AND v.blob_id=b.id LEFT JOIN storage_attachment_slots s ON s.workspace_id=v.workspace_id AND s.id=v.slot_id WHERE b.workspace_id=$1 AND ((b.parent_kind='page' AND b.parent_id=ANY($2::text[])) OR (b.parent_kind='source' AND b.parent_id=ANY($3::text[])))",
          [ctx.workspaceId, [...pageIds], [...sourceIds]],
        );
        if (blobs.rows.some((b) => b.scan_state !== "clean"))
          throw Error("SCAN_REQUIRED");
        return { pages, sources, blobs: blobs.rows as BlobRow[] };
      },
    );
    const blobs = [];
    let size = Buffer.byteLength(JSON.stringify(prepared));
    for (const b of prepared.blobs) {
      size += Math.ceil(b.size / 3) * 4;
      if (size > MAX_BYTES) throw Error("PAYLOAD_TOO_LARGE");
      const bytes = await this.files.get(b.sha256);
      blobs.push({
        id: b.id,
        parent: { kind: b.parent_kind, id: b.parent_id },
        sha256: b.sha256,
        mime: b.mime,
        filename: b.filename,
        base64: bytes.toString("base64"),
        scanState: "clean" as const,
        attachment: b.attachment ?? null,
      });
    }
    await this.run(ctx, "knowledge.read", undefined, async (db) => {
      for (const p of [
        ...prepared.pages.map((p) => ({ kind: "page" as const, id: p.id })),
        ...prepared.sources.map((s) => ({ kind: "source" as const, id: s.id })),
      ]) {
        await this.parent(db, ctx, p);
        await this.authorizeParent(db, ctx, "data.export", p);
        const expected = (
          p.kind === "page" ? prepared.pages : prepared.sources
        ).find((item) => item.id === p.id)!.readers;
        const currentReaders = await readers(db, ctx.workspaceId, p.kind, p.id);
        if (
          JSON.stringify([...expected].sort()) !==
          JSON.stringify([...currentReaders].sort())
        )
          throw Error("STALE_VERSION");
      }
      for (const b of prepared.blobs) {
        const current = await this.blob(db, ctx, b.id);
        if (current.scan_state !== "clean" || current.sha256 !== b.sha256)
          throw Error("SCAN_REQUIRED");
      }
      await audit(db, ctx, "data.export", sha256(JSON.stringify(prepared)));
    });
    const manifest = {
      format: "akh-export" as const,
      version: 1 as const,
      workspaceId: ctx.workspaceId,
      exportedAt: new Date().toISOString(),
      pages: prepared.pages,
      sources: prepared.sources,
      blobs,
    };
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_BYTES)
      throw Error("PAYLOAD_TOO_LARGE");
    if (!manifestSchema.safeParse(manifest).success)
      throw Error("EXPORT_FORMAT_LIMIT");
    return manifest;
  }
  /** Quarantined import proposal. IDs, ACL and history remain evidence; never applied to live tables. */
  async import(ctx: Context, input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES)
      throw Error("PAYLOAD_TOO_LARGE");
    const d = manifestSchema.parse(input);
    if (d.workspaceId !== ctx.workspaceId) throw Error("SOURCE_SCOPE_CONFLICT");
    const keys = new Set<string>();
    for (const p of [
      ...d.pages.map((p) => ({ ...p, kind: "page" as const })),
      ...d.sources.map((s) => ({ ...s, kind: "source" as const })),
    ]) {
      const key = p.kind + ":" + p.id;
      if (keys.has(key)) throw Error("DUPLICATE_ID");
      keys.add(key);
      if (p.data.id !== p.id) throw Error("INVALID_MANIFEST");
    }
    if (!keys.size) throw Error("INVALID_MANIFEST");
    for (const p of d.pages) {
      if (p.operational?.parent_id) {
        const pid = id.parse(p.operational.parent_id);
        if (!keys.has("page:" + pid)) throw Error("INCOMPLETE_PROVENANCE");
      }
    }
    for (const p of d.pages) {
      const numbers = new Set<number>();
      for (const v of p.versions) {
        const n = z.number().int().positive().parse(v.number);
        if (numbers.has(n)) throw Error("DUPLICATE_VERSION");
        numbers.add(n);
        z.string().max(100000).parse(v.content);
        const refs = z.array(id).max(100).parse(v.sourceIds);
        for (const sid of refs)
          if (!keys.has("source:" + sid)) throw Error("INCOMPLETE_PROVENANCE");
        if (v.provenance) {
          const ancestry = z
            .object({
              pageIds: z.array(id).max(100),
              sourceIds: z.array(id).max(100),
            })
            .parse(v.provenance);
          for (const sid of ancestry.sourceIds)
            if (!keys.has("source:" + sid))
              throw Error("INCOMPLETE_PROVENANCE");
          for (const pid of ancestry.pageIds)
            if (!keys.has("page:" + pid)) throw Error("INCOMPLETE_PROVENANCE");
        }
      }
      for (const pid of z
        .array(id)
        .max(100)
        .parse(p.data.links ?? []))
        if (!keys.has("page:" + pid)) throw Error("INCOMPLETE_PROVENANCE");
      if (!numbers.size) throw Error("INVALID_MANIFEST");
    }
    const blobIds = new Set<string>();
    for (const b of d.blobs) {
      if (blobIds.has(b.id)) throw Error("DUPLICATE_ID");
      blobIds.add(b.id);
      if (!keys.has(b.parent.kind + ":" + b.parent.id))
        throw Error("INVALID_MANIFEST");
      const bytes = Buffer.from(b.base64, "base64");
      if (bytes.toString("base64") !== b.base64 || sha256(bytes) !== b.sha256)
        throw Error("HASH_MISMATCH");
      inspectContent(bytes, b.mime, b.filename);
    }
    for (const b of d.blobs) {
      if (!b.attachment) continue;
      const group = d.blobs.filter(
        (other) => other.attachment?.slotId === b.attachment!.slotId,
      );
      const head = group.find((other) => other.id === b.attachment!.headId);
      const revisions = group.map((other) => other.attachment!.revision);
      if (
        !head ||
        new Set(revisions).size !== revisions.length ||
        Math.max(...revisions) !== b.attachment.headRevision ||
        head.attachment!.revision !== b.attachment.headRevision ||
        group.some(
          (other) =>
            other.attachment!.headId !== head.id ||
            other.attachment!.headRevision !== b.attachment!.headRevision ||
            other.parent.kind !== b.parent.kind ||
            other.parent.id !== b.parent.id,
        )
      )
        throw Error("INCOMPLETE_ATTACHMENT_HISTORY");
    }
    await this.run(ctx, "source.create", undefined, (db) =>
      this.authorize(db, ctx, "changeset.propose"),
    );
    const digest = sha256(JSON.stringify(d));
    return this.run(ctx, "source.create", undefined, async (db) => {
      await this.authorize(db, ctx, "changeset.propose");
      const boundResources: StorageResource[] = [];
      // Even proposals must not become an exfiltration cache after current source grants change.
      for (const item of [
        ...d.pages.map((p) => ({ ...p, kind: "page" as const })),
        ...d.sources.map((s) => ({ ...s, kind: "source" as const })),
      ]) {
        if (!item.readers.includes(ctx.principalId))
          throw Error("SOURCE_SCOPE_CONFLICT");
        const existing = await db.query(
          "SELECT 1 FROM resources WHERE workspace_id=$1 AND kind=$2 AND id=$3",
          [ctx.workspaceId, item.kind, item.id],
        );
        if (existing.rowCount) {
          await this.parent(db, ctx, { kind: item.kind, id: item.id });
          boundResources.push({ kind: item.kind, id: item.id });
          const current = await readers(
            db,
            ctx.workspaceId,
            item.kind,
            item.id,
          );
          if (item.readers.some((who) => !current.includes(who)))
            throw Error("SOURCE_SCOPE_CONFLICT");
        }
      }
      const previous = await db.query(
        "SELECT id FROM storage_imports WHERE workspace_id=$1 AND principal_id=$2 AND digest=$3",
        [ctx.workspaceId, ctx.principalId, digest],
      );
      if (previous.rowCount)
        return { id: previous.rows[0].id, status: "proposed", duplicate: true };
      const stagedBlobs: {
        id: string;
        sha256: string;
        size: number;
        scanState: "clean" | "pending";
      }[] = [];
      for (const b of d.blobs) {
        const bytes = Buffer.from(b.base64, "base64");
        const saved = await this.writeContent(db, bytes);
        stagedBlobs.push({
          id: b.id,
          ...saved,
          scanState: inspectContent(bytes, b.mime, b.filename).scanState,
        });
      }
      await this.recheck(db, ctx, "source.create");
      await this.authorize(db, ctx, "changeset.propose");
      for (const bound of boundResources) await this.parent(db, ctx, bound);
      const proposalId = randomUUID();
      await db.query(
        "INSERT INTO storage_imports(workspace_id,id,principal_id,digest,manifest) VALUES($1,$2,$3,$4,$5)",
        [
          ctx.workspaceId,
          proposalId,
          ctx.principalId,
          digest,
          {
            type: "import-proposal",
            manifest: d,
            effectiveReaders: [ctx.principalId],
            scanApprovalTrusted: false,
            verificationTrusted: false,
            boundResources,
            stagedBlobs,
          },
        ],
      );
      await audit(db, ctx, "data.import.propose", proposalId);
      return { id: proposalId, status: "proposed", duplicate: false };
    });
  }
  async importProposal(ctx: Context, proposalId: string) {
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const archive = await readImportArchive(
        this,
        db,
        ctx,
        id.parse(proposalId),
      );
      const blobs = [];
      for (const b of archive.manifest.blobs) {
        const check = inspectContent(
          Buffer.from(b.base64, "base64"),
          b.mime,
          b.filename,
        );
        const registered = await db.query(
          "SELECT scan_state,sha256 FROM storage_blobs WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, b.id],
        );
        const approved =
          check.scanState === "clean" ||
          (registered.rows[0]?.scan_state === "clean" &&
            registered.rows[0]?.sha256 === b.sha256);
        blobs.push({
          ...b,
          base64: approved ? b.base64 : "",
          contentOmitted: !approved,
          effectiveScanState: approved ? "clean" : "pending",
          omissionReason: approved ? null : "SCAN_REQUIRED",
        });
      }
      return { ...archive, manifest: { ...archive.manifest, blobs } };
    });
  }
  proposeImport(ctx: Context, proposalId: string, input: unknown) {
    return new ImportWorkflow(this).propose(ctx, proposalId, input);
  }
  downloadAttachment(ctx: Context, slotId: string, revision?: number) {
    return new AttachmentWorkflow(this).download(ctx, slotId, revision);
  }
  previewAttachment(ctx: Context, slotId: string, revision?: number) {
    return new AttachmentWorkflow(this).preview(ctx, slotId, revision);
  }
  withdrawAttachment(ctx: Context, slotId: string, input: unknown) {
    return new AttachmentWorkflow(this).withdraw(ctx, slotId, input);
  }
  attachmentHistory(ctx: Context, slotId: string, offset = 0) {
    return new AttachmentWorkflow(this).history(ctx, slotId, offset);
  }
  proposeAttachmentLink(ctx: Context, slotId: string, input: unknown) {
    return new AttachmentWorkflow(this).proposeLink(ctx, slotId, input);
  }
}
