import { z } from "zod";
import type { PoolClient } from "pg";
import type { StorageService, StorageResource } from "./service";
import { KnowledgeService, type Context } from "../service";
import { loadState, audit } from "../repository";
import { captureEnvelope, inheritedProvenance } from "../provenance";
import { digest } from "../publication";
import { current, draftOf } from "../../src/domain/wiki";
import { inspectContent } from "./content";
import { randomUUID } from "node:crypto";
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
type Slot = {
  id: string;
  parent_kind: "page" | "source";
  parent_id: string;
  head_id: string;
  revision: number;
  withdrawn: boolean;
};
export class AttachmentWorkflow {
  constructor(readonly host: StorageService) {}
  async writableParent(db: PoolClient, ctx: Context, parent: StorageResource) {
    await this.host.parent(db, ctx, parent);
    await this.host.authorize(db, ctx, "changeset.propose", parent);
    if (parent.kind === "page") {
      const r = await db.query(
        "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, parent.id],
      );
      if (r.rows[0] && r.rows[0].state !== "active")
        throw Error("DOCUMENT_PROTECTED");
      if (r.rows[0]?.data?.protected)
        await this.host.authorize(db, ctx, "knowledge.protect", parent);
    }
  }
  async slot(
    db: PoolClient,
    ctx: Context,
    slotId: string,
    allowWithdrawn = false,
  ): Promise<Slot> {
    const r = await db.query(
      "SELECT * FROM storage_attachment_slots WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, id.parse(slotId)],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    const slot = r.rows[0] as Slot;
    await this.host.parent(db, ctx, {
      kind: slot.parent_kind,
      id: slot.parent_id,
    });
    if (slot.withdrawn && !allowWithdrawn) throw Error("NOT_FOUND");
    return slot;
  }
  async expectedSlot(
    db: PoolClient,
    ctx: Context,
    slotId: string,
    head: string,
    revision: number,
    parent?: StorageResource,
  ) {
    const slot = await this.slot(db, ctx, slotId);
    if (slot.head_id !== head || slot.revision !== revision)
      throw Error("STALE_VERSION");
    if (
      parent &&
      (parent.kind !== slot.parent_kind || parent.id !== slot.parent_id)
    )
      throw Error("SOURCE_SCOPE_CONFLICT");
    return slot;
  }
  async download(ctx: Context, slotId: string, revision?: number) {
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const selected = await this.host.run(
      ctx,
      "knowledge.read",
      undefined,
      async (db) => {
        const slot = await this.slot(db, ctx, slotId);
        const r = await db.query(
          "SELECT blob_id FROM storage_attachment_versions WHERE workspace_id=$1 AND slot_id=$2 AND revision=$3",
          [ctx.workspaceId, slotId, revision ?? slot.revision],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        return { slot, blobId: r.rows[0].blob_id as string };
      },
    );
    const result = await this.host.download(ctx, selected.blobId);
    await this.host.run(ctx, "knowledge.read", undefined, async (db) => {
      const now = await this.slot(db, ctx, slotId);
      if (
        revision === undefined &&
        (now.head_id !== selected.slot.head_id ||
          now.revision !== selected.slot.revision)
      )
        throw Error("STALE_VERSION");
    });
    return result;
  }
  async preview(ctx: Context, slotId: string, revision?: number) {
    const result = await this.download(ctx, slotId, revision);
    const checked = inspectContent(result.bytes, result.mime, result.filename);
    if (checked.extraction !== "text") throw Error("UNSUPPORTED_PREVIEW");
    const text = checked.text ?? "";
    return {
      text: text.slice(0, 100000),
      totalCharacters: text.length,
      omittedCharacters: Math.max(0, text.length - 100000),
      mime: result.mime,
      sha256: result.sha256,
      render: "plain-text",
      complete: text.length <= 100000,
    };
  }
  async history(ctx: Context, slotId: string, offset = 0) {
    z.number().int().min(0).max(1000000).parse(offset);
    return this.host.run(ctx, "knowledge.read", undefined, async (db) => {
      const slot = await this.slot(db, ctx, slotId, true);
      const r = await db.query(
        "SELECT v.revision,v.blob_id,b.filename,b.mime,b.size,b.scan_state FROM storage_attachment_versions v JOIN storage_blobs b ON b.workspace_id=v.workspace_id AND b.id=v.blob_id WHERE v.workspace_id=$1 AND v.slot_id=$2 ORDER BY v.revision DESC LIMIT 25 OFFSET $3",
        [ctx.workspaceId, slotId, offset],
      );
      return {
        slotId,
        headId: slot.head_id,
        revision: slot.revision,
        withdrawn: slot.withdrawn,
        parent: { kind: slot.parent_kind, id: slot.parent_id },
        total: (
          await db.query(
            "SELECT count(*)::int n FROM storage_attachment_versions WHERE workspace_id=$1 AND slot_id=$2",
            [ctx.workspaceId, slotId],
          )
        ).rows[0].n as number,
        offset,
        limit: 25,
        items: r.rows.map((row) => ({
          ...row,
          isHead: row.blob_id === slot.head_id,
          downloadPath: slot.withdrawn
            ? null
            : `/api/v1/storage/blobs/${row.blob_id}`,
        })),
      };
    });
  }
  async withdraw(ctx: Context, slotId: string, raw: unknown) {
    const input = z
      .object({
        expectedRevision: z.number().int().positive(),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(raw);
    return this.host.run(ctx, "source.create", undefined, async (db) => {
      const slot = await this.slot(db, ctx, slotId);
      await this.writableParent(db, ctx, {
        kind: slot.parent_kind,
        id: slot.parent_id,
      });
      if (slot.revision !== input.expectedRevision)
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE storage_attachment_slots SET withdrawn=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, slotId],
      );
      const dependent = await db.query(
        "SELECT batch_id FROM storage_attachment_links WHERE workspace_id=$1 AND slot_id=$2 UNION SELECT e.batch_id FROM storage_import_effects e WHERE e.workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_each_text(e.result->'blobMap') value JOIN storage_attachment_versions v ON v.workspace_id=$1 AND v.slot_id=$2 AND v.blob_id=value.value)",
        [ctx.workspaceId, slotId],
      );
      const batchIds = dependent.rows.map((row) => row.batch_id);
      const invalidated = await db.query(
        "UPDATE batches SET data=jsonb_set(data,'{status}','\"conflict\"') WHERE workspace_id=$1 AND id=ANY($2::text[]) AND data->>'status' IN ('pending','approved') RETURNING id",
        [ctx.workspaceId, batchIds],
      );
      await db.query(
        "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=ANY($2::text[])",
        [ctx.workspaceId, invalidated.rows.map((row) => row.id)],
      );
      await db.query(
        "INSERT INTO workflow_events VALUES($1,$2,$3,'attachment.withdraw',$4,$5,now())",
        [
          ctx.workspaceId,
          randomUUID(),
          ctx.principalId,
          slotId,
          { reason: input.reason, headId: slot.head_id },
        ],
      );
      await audit(db, ctx, "attachment.withdraw", slotId);
      return { slotId, withdrawn: true, revision: slot.revision + 1 };
    });
  }
  async proposeLink(ctx: Context, slotId: string, raw: unknown) {
    const input = z
      .object({
        baseVersion: z.number().int().positive(),
        expectedHead: id,
        pageId: id.optional(),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(raw);
    const read = async (db: PoolClient) => {
      const slot = await this.slot(db, ctx, slotId);
      const targetPage =
        slot.parent_kind === "page" ? slot.parent_id : input.pageId;
      if (!targetPage) throw Error("PAGE_ATTACHMENT_REQUIRED");
      if (
        slot.parent_kind === "page" &&
        input.pageId &&
        input.pageId !== slot.parent_id
      )
        throw Error("SOURCE_SCOPE_CONFLICT");
      await this.writableParent(db, ctx, { kind: "page", id: targetPage });
      if (slot.head_id !== input.expectedHead) throw Error("STALE_VERSION");
      const blob = await this.host.blob(db, ctx, slot.head_id);
      if (blob.scan_state !== "clean") throw Error("SCAN_REQUIRED");
      const state = await loadState(db, ctx.workspaceId),
        page = state.pages.find((p) => p.id === targetPage);
      if (!page) throw Error("NOT_FOUND");
      if (
        slot.parent_kind === "source" &&
        !inheritedProvenance(page).sourceIds.includes(slot.parent_id)
      )
        throw Error("SOURCE_SCOPE_CONFLICT");
      return { slot, blob, state, page };
    };
    const key = [ctx.workspaceId, slotId, input.expectedHead];
    const existing = () =>
      this.host.run(ctx, "changeset.propose", undefined, async (db) => {
        const p = await read(db);
        const result = await db.query(
          "SELECT batch_id AS id,batch_hash AS hash FROM storage_attachment_links WHERE workspace_id=$1 AND slot_id=$2 AND blob_id=$3 AND page_id=$4 AND base_version=$5",
          [...key, p.page.id, input.baseVersion],
        );
        return result.rows[0] as { id: string; hash: string } | undefined;
      });
    const saved = await existing();
    if (saved) return saved;
    const prepared = await this.host.run(
      ctx,
      "changeset.propose",
      undefined,
      async (db) => {
        const p = await read(db);
        if (current(p.page).number !== input.baseVersion)
          throw Error("STALE_VERSION");
        const label = p.blob.filename.replace(/[\\\[\]()]/g, "_");
        const markdown = `[${label}](/api/v1/storage/blobs/${p.blob.id})`;
        const sourceIds = [
          ...new Set([
            ...current(p.page).sourceIds,
            ...inheritedProvenance(p.page).sourceIds,
            ...(p.slot.parent_kind === "source" ? [p.slot.parent_id] : []),
          ]),
        ];
        return {
          ...p,
          draft: {
            ...draftOf(p.page),
            sourceIds,
            content: current(p.page).content + "\n\n" + markdown,
          },
          envelope: await captureEnvelope(
            db,
            ctx,
            p.state,
            [p.page.id],
            sourceIds,
          ),
        };
      },
    );
    try {
      return await new KnowledgeService(this.host.pool).propose(
        ctx,
        [prepared.draft],
        prepared.draft.sourceIds,
        {
          expectedStateHash: digest(prepared.state),
          inputEnvelope: prepared.envelope,
          dependencyIds: [prepared.page.id],
          onCreated: async (db, result) => {
            await read(db);
            const old = await db.query(
              "SELECT 1 FROM storage_attachment_links WHERE workspace_id=$1 AND slot_id=$2 AND blob_id=$3 AND page_id=$4 AND base_version=$5",
              [...key, prepared.page.id, input.baseVersion],
            );
            if (old.rowCount) throw Error("ATTACHMENT_ALREADY_PROPOSED");
            await db.query(
              "INSERT INTO storage_attachment_links VALUES($1,$2,$3,$4,$5,$6,$7)",
              [
                ...key,
                prepared.page.id,
                input.baseVersion,
                result.id,
                result.hash,
              ],
            );
            await audit(db, ctx, "attachment.link.propose", slotId);
            await db.query(
              "INSERT INTO workflow_events VALUES($1,$2,$3,'attachment.link.propose',$4,$5,now())",
              [
                ctx.workspaceId,
                randomUUID(),
                ctx.principalId,
                slotId,
                {
                  reason: input.reason,
                  blobId: input.expectedHead,
                  pageId: prepared.page.id,
                  batchId: result.id,
                },
              ],
            );
          },
        },
      );
    } catch (error) {
      const recovered = await existing();
      if (recovered) return recovered;
      throw error;
    }
  }
}
