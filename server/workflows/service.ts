import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type { Page } from "../../src/domain/types";
import { current, draftOf } from "../../src/domain/wiki";
import { transaction } from "../database";
import {
  audit,
  loadState,
  membership,
  readers,
  requireRead,
} from "../repository";
import {
  visiblePageIds,
  captureEnvelope,
  inheritedProvenance,
} from "../provenance";
import { digest, propose } from "../publication";
import type { RuntimeService } from "../runtime/knowledge";
import {
  assertDraftNotRetired,
  isDraftRetired,
  draftRetirementId,
} from "../retention/drafts";
import { fingerprint } from "../provenance";

export type WorkflowResource = { kind: "page" | "source"; id: string };
export type WorkflowAuthorizer = (
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: WorkflowResource,
) => Promise<void>;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().trim().min(1).max(100000);
const revision = z.number().int().min(0);
const dependencyVersions = z
  .record(id, z.number().int().positive())
  .refine((v) => Object.keys(v).length <= 100);
const draftSchema = z
  .object({
    id,
    expectedRevision: revision,
    title: z.string().trim().min(1).max(300),
    content: text,
    pageId: id.optional(),
    baseVersion: z.number().int().min(1).optional(),
    originSpaceId: id.optional(),
    sourceIds: z.array(id).max(100).optional(),
    dependencyVersions: dependencyVersions.optional(),
    mutationId: z.string().uuid().optional(),
  })
  .strict();
const editSchema = z
  .object({
    baseVersion: z.number().int().positive(),
    content: text,
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
const commentSchema = z
  .object({
    content: z.string().trim().min(1).max(20000),
    version: z.number().int().positive(),
    anchor: z.string().max(1000).default(""),
    mentions: z.array(z.string().min(1).max(200)).max(50).default([]),
  })
  .strict();
const docSchema = z
  .object({
    expectedRevision: revision,
    state: z.enum(["active", "archived", "trash"]).optional(),
    parentId: id.nullable().optional(),
    reason: z.string().trim().min(1).max(2000),
    properties: z.record(z.string().max(100), z.string().max(2000)).optional(),
    reviewDue: z.iso.datetime().nullable().optional(),
    effectiveFrom: z.iso.datetime().nullable().optional(),
    replacementId: id.nullable().optional(),
    protected: z.boolean().optional(),
  })
  .strict();

export class WorkflowService {
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
    readonly authorize: WorkflowAuthorizer,
  ) {}
  private async run<T>(
    ctx: Context,
    action: string,
    resource: WorkflowResource | undefined,
    work: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action, resource);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async page(
    db: PoolClient,
    ctx: Context,
    pageId: string,
    allowTrash = false,
  ): Promise<Page> {
    id.parse(pageId);
    const state = await loadState(db, ctx.workspaceId);
    if (!(await visiblePageIds(db, ctx, state)).has(pageId))
      throw Error("NOT_FOUND");
    const p = state.pages.find((p) => p.id === pageId);
    if (!p) throw Error("NOT_FOUND");
    const flags = await db.query(
      "SELECT state,parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
      [ctx.workspaceId, pageId],
    );
    if (flags.rows[0]?.state === "trash" && !allowTrash)
      throw Error("NOT_FOUND");
    const visited = new Set([pageId]);
    let parent = flags.rows[0]?.parent_id;
    while (parent) {
      if (visited.has(parent)) throw Error("POLICY_UNAVAILABLE");
      visited.add(parent);
      await requireRead(db, ctx, "page", parent);
      const row = await db.query(
        "SELECT parent_id,state FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
        [ctx.workspaceId, parent],
      );
      if (row.rows[0]?.state === "trash") throw Error("NOT_FOUND");
      parent = row.rows[0]?.parent_id;
    }
    for (const sourceId of current(p).sourceIds) {
      const status = await db.query(
        "SELECT state FROM workflow_source_state WHERE workspace_id=$1 AND source_id=$2",
        [ctx.workspaceId, sourceId],
      );
      if (status.rows[0] && status.rows[0].state !== "active")
        throw Error("NOT_FOUND");
    }
    return p;
  }
  private async requireVersion(
    db: PoolClient,
    ctx: Context,
    p: Page,
    version: number,
  ) {
    const v = p.versions.find((v) => v.number === version);
    if (!v) throw Error("NOT_FOUND");
    for (const sourceId of v.sourceIds)
      await requireRead(db, ctx, "source", sourceId);
    return v;
  }
  /** Management metadata only: ignore this page's trash flag, never its ACL, ancestors or inputs. */
  private async manageableTrash(
    db: PoolClient,
    ctx: Context,
    pageId: string,
  ): Promise<Page> {
    if (
      !(
        await readers(db, ctx.workspaceId, "page", pageId, {
          includeSelfTrash: true,
        })
      ).includes(ctx.principalId)
    )
      throw Error("NOT_FOUND");
    const state = await loadState(db, ctx.workspaceId),
      p = state.pages.find((p) => p.id === pageId);
    if (!p) throw Error("NOT_FOUND");
    const provenance = inheritedProvenance(p);
    for (const sid of new Set([
      ...current(p).sourceIds,
      ...provenance.sourceIds,
    ]))
      await requireRead(db, ctx, "source", sid);
    const visible = await visiblePageIds(db, ctx, state);
    if (
      provenance.pageIds.some((id) => id !== pageId && !visible.has(id)) ||
      (p.links ?? []).some(
        (id) =>
          id !== pageId &&
          state.pages.some((p) => p.id === id) &&
          !visible.has(id),
      )
    )
      throw Error("NOT_FOUND");
    return p;
  }
  async drafts(ctx: Context) {
    return this.run(ctx, "draft.write", undefined, async (db) => {
      const rows = await db.query(
        "SELECT id,revision,data,updated_at FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 ORDER BY updated_at DESC",
        [ctx.workspaceId, ctx.principalId],
      );
      const items = [];
      for (const row of rows.rows) {
        try {
          if (await isDraftRetired(db, ctx, row.id)) continue;
          await this.draftHistoryAccess(db, ctx, row.id);
          if (row.data.pageId) await this.page(db, ctx, row.data.pageId);
          for (const sid of row.data.sourceIds ?? [])
            await requireRead(db, ctx, "source", sid);
          for (const dependency of Object.keys(
            row.data.dependencyVersions ?? {},
          ))
            await this.page(db, ctx, dependency);
          items.push({
            id: row.id,
            revision: row.revision,
            ...row.data,
            updatedAt: row.updated_at,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      return { items };
    });
  }
  private async draftHistoryAccess(
    db: PoolClient,
    ctx: Context,
    draftId: string,
  ) {
    const history = await db.query(
      "SELECT data FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 UNION ALL SELECT data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
      [ctx.workspaceId, ctx.principalId, draftId],
    );
    for (const row of history.rows) {
      const d = row.data;
      if (d.pageId) await this.page(db, ctx, d.pageId);
      for (const sid of d.sourceIds ?? [])
        await requireRead(db, ctx, "source", sid);
      for (const dependency of Object.keys(d.dependencyVersions ?? {}))
        await this.page(db, ctx, dependency);
    }
  }
  async saveDraft(ctx: Context, input: unknown) {
    const d = draftSchema.parse(input);
    return this.run(
      ctx,
      "draft.write",
      d.pageId ? { kind: "page", id: d.pageId } : undefined,
      async (db) => {
        if (d.originSpaceId && d.originSpaceId !== ctx.workspaceId)
          throw Error("SOURCE_SCOPE_CONFLICT");
        await assertDraftNotRetired(db, ctx, d.id);
        await this.draftHistoryAccess(db, ctx, d.id);
        if (d.pageId) {
          const p = await this.page(db, ctx, d.pageId);
          if (!d.baseVersion) throw Error("VALIDATION_FAILED");
          await this.requireVersion(db, ctx, p, d.baseVersion);
        }
        for (const sid of d.sourceIds ?? [])
          await requireRead(db, ctx, "source", sid);
        for (const [dependency, version] of Object.entries(
          d.dependencyVersions ?? {},
        )) {
          const p = await this.page(db, ctx, dependency);
          await this.requireVersion(db, ctx, p, version);
        }
        if (d.mutationId) {
          const previous = await db.query(
            "SELECT input_hash,result FROM workflow_draft_save_mutations WHERE workspace_id=$1 AND owner_id=$2 AND mutation_id=$3",
            [ctx.workspaceId, ctx.principalId, d.mutationId],
          );
          if (previous.rowCount) {
            if (previous.rows[0].input_hash !== fingerprint(d))
              throw Error("IDEMPOTENCY_CONFLICT");
            return previous.rows[0].result;
          }
        }
        const before = await db.query(
          "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, d.id],
        );
        if ((before.rows[0]?.revision ?? 0) !== d.expectedRevision)
          throw Error("STALE_VERSION");
        const next = d.expectedRevision + 1;
        const { expectedRevision: _, mutationId: __, ...submitted } = d;
        const previous = before.rows[0]?.data;
        // Removing client labels is not removal of inherited evidence. Keep
        // provenance in the current row too, so submitDraft's existing envelope
        // and commitGuard cannot publish a lineage-stripped private revision.
        const sourceIds = [
          ...new Set<string>([
            ...(previous?.sourceIds ?? []),
            ...(d.sourceIds ?? []),
          ]),
        ];
        const dependencies = {
          ...(previous?.dependencyVersions ?? {}),
          ...(d.dependencyVersions ?? {}),
        };
        if (
          previous?.pageId &&
          previous.pageId !== d.pageId &&
          previous.baseVersion
        )
          dependencies[previous.pageId] = previous.baseVersion;
        const data = {
          ...submitted,
          ...(sourceIds.length ? { sourceIds } : {}),
          ...(Object.keys(dependencies).length
            ? { dependencyVersions: dependencies }
            : {}),
          ...(previous?.originSpaceId
            ? { originSpaceId: previous.originSpaceId }
            : {}),
        };
        await db.query(
          "INSERT INTO workflow_drafts(workspace_id,owner_id,id,revision,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=now()",
          [ctx.workspaceId, ctx.principalId, d.id, next, data],
        );
        await audit(db, ctx, "draft.save", d.id);
        await db.query(
          "INSERT INTO workflow_draft_revision_history(workspace_id,owner_id,draft_id,revision,data) VALUES($1,$2,$3,$4,$5)",
          [ctx.workspaceId, ctx.principalId, d.id, next, data],
        );
        if (d.mutationId)
          await db.query(
            "INSERT INTO workflow_draft_save_mutations(workspace_id,owner_id,mutation_id,draft_id,input_hash,result) VALUES($1,$2,$3,$4,$5,$6)",
            [
              ctx.workspaceId,
              ctx.principalId,
              d.mutationId,
              d.id,
              fingerprint(d),
              { ...data, revision: next },
            ],
          );
        return { ...data, revision: next };
      },
    );
  }
  async deleteDraft(ctx: Context, draftId: string, expectedRevision: number) {
    id.parse(draftId);
    revision.parse(expectedRevision);
    return this.run(ctx, "draft.write", undefined, async (db) => {
      const r = await db.query(
        "DELETE FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3 AND revision=$4 RETURNING id",
        [ctx.workspaceId, ctx.principalId, draftId, expectedRevision],
      );
      if (!r.rowCount) throw Error("STALE_VERSION");
      await db.query(
        "INSERT INTO operations_erased_artifacts(workspace_id,artifact_kind,artifact_id,hashes,preview_hash,approved_by) VALUES($1,'draft',$2,'[]',$3,$4) ON CONFLICT DO NOTHING",
        [
          ctx.workspaceId,
          draftRetirementId(ctx.principalId, draftId),
          fingerprint([draftId, expectedRevision, "manual-delete"]),
          ctx.principalId,
        ],
      );
      await db.query(
        "DELETE FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [ctx.workspaceId, ctx.principalId, draftId],
      );
      await db.query(
        "DELETE FROM workflow_draft_save_mutations WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3",
        [ctx.workspaceId, ctx.principalId, draftId],
      );
      await db.query(
        "DELETE FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2 AND binding->>'id'=$3",
        [ctx.workspaceId, ctx.principalId, draftId],
      );
      await audit(db, ctx, "draft.delete", draftId);
      return { id: draftId };
    });
  }
  async proposeEdit(
    ctx: Context,
    pageId: string,
    input: unknown,
    additionalSourceIds: string[] = [],
    dependencies: Record<string, number> = {},
    commitGuard?: (db: PoolClient) => Promise<void>,
  ) {
    const edit = editSchema.parse(input);
    const prepared = await this.run(
      ctx,
      "changeset.propose",
      { kind: "page", id: pageId },
      async (db) => {
        const p = await this.page(db, ctx, pageId);
        const flags = await db.query(
          "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, pageId],
        );
        if (flags.rows[0]?.state === "archived")
          throw Error("DOCUMENT_PROTECTED");
        if (current(p).number !== edit.baseVersion)
          throw Error("STALE_VERSION");
        const state = await loadState(db, ctx.workspaceId);
        for (const [dependency, version] of Object.entries(
          dependencyVersions.parse(dependencies),
        )) {
          const p = await this.page(db, ctx, dependency);
          if (current(p).number !== version) throw Error("STALE_VERSION");
        }
        const sourceIds = [
          ...new Set([
            ...current(p).sourceIds,
            ...z.array(id).max(100).parse(additionalSourceIds),
          ]),
        ];
        const envelope = await captureEnvelope(
          db,
          ctx,
          state,
          [...new Set([pageId, ...Object.keys(dependencies)])],
          sourceIds,
        );
        return {
          draft: {
            ...draftOf(p),
            content: edit.content,
            sourceIds: envelope.sourceIds,
          },
          fingerprint: digest(state),
          envelope,
        };
      },
    );
    const result = await propose(
      this.pool,
      ctx,
      [prepared.draft],
      prepared.draft.sourceIds,
      {
        expectedStateHash: prepared.fingerprint,
        inputEnvelope: prepared.envelope,
        producer: {
          kind: ctx.credentialId ? "api-submission" : "user-submission",
          principalId: ctx.principalId,
        },
        dependencyIds: prepared.envelope.pageIds,
        onCreated: async (db, batch) => {
          await commitGuard?.(db);
          await db.query(
            "INSERT INTO workflow_events VALUES($1,$2,$3,'page.edit.propose',$4,$5,now())",
            [
              ctx.workspaceId,
              randomUUID(),
              ctx.principalId,
              batch.id,
              { pageId, reason: edit.reason },
            ],
          );
        },
      },
    );
    return result;
  }
  async submitDraft(
    ctx: Context,
    draftId: string,
    expectedRevision: number,
    reason: string,
  ) {
    const d = await this.run(
      ctx,
      "changeset.propose",
      undefined,
      async (db) => {
        await assertDraftNotRetired(db, ctx, draftId);
        await this.draftHistoryAccess(db, ctx, draftId);
        const row = await db.query(
          "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, id.parse(draftId)],
        );
        if (!row.rowCount) throw Error("NOT_FOUND");
        if (row.rows[0].revision !== expectedRevision)
          throw Error("STALE_VERSION");
        return row.rows[0].data;
      },
    );
    if (!d.pageId) throw Error("SOURCE_REGISTRATION_REQUIRED");
    return this.proposeEdit(
      ctx,
      d.pageId,
      { content: d.content, baseVersion: d.baseVersion, reason },
      d.sourceIds ?? [],
      d.dependencyVersions ?? {},
      async (db) => {
        await assertDraftNotRetired(db, ctx, draftId);
        const row = await db.query(
          "SELECT revision FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, draftId],
        );
        if (row.rows[0]?.revision !== expectedRevision)
          throw Error("STALE_VERSION");
      },
    );
  }
  async proposeRestore(
    ctx: Context,
    pageId: string,
    version: number,
    baseVersion: number,
    reason: string,
  ) {
    const content = await this.run(
      ctx,
      "changeset.propose",
      { kind: "page", id: pageId },
      async (db) => {
        const p = await this.page(db, ctx, pageId);
        return (await this.requireVersion(db, ctx, p, version)).content;
      },
    );
    return this.proposeEdit(ctx, pageId, { content, baseVersion, reason });
  }
  async withdrawChangeset(
    ctx: Context,
    batchId: string,
    hash: string,
    reason: string,
  ) {
    id.parse(batchId);
    text.parse(reason);
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const row = await db.query(
        "SELECT hash,data FROM batches WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, batchId],
      );
      if (!row.rowCount) throw Error("NOT_FOUND");
      if (row.rows[0].hash !== hash) throw Error("APPROVAL_STALE");
      const author = await db.query(
        "SELECT principal_id FROM audit WHERE workspace_id=$1 AND operation='batch.propose' AND resource_id=$2 ORDER BY at LIMIT 1",
        [ctx.workspaceId, batchId],
      );
      if (author.rows[0]?.principal_id !== ctx.principalId)
        throw Error("FORBIDDEN");
      if (
        !["pending", "approved", "conflict"].includes(row.rows[0].data.status)
      )
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, batchId],
      );
      await db.query(
        "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, batchId],
      );
      await audit(db, ctx, "batch.withdraw", batchId);
      return { id: batchId, status: "rejected" };
    });
  }
  async document(ctx: Context, pageId: string) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        const p = await this.page(db, ctx, pageId);
        const settings = await db.query(
          "SELECT revision,state,parent_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, pageId],
        );
        await db.query(
          "INSERT INTO workflow_activity VALUES($1,$2,$3,'recent',now()) ON CONFLICT(workspace_id,principal_id,page_id,kind) DO UPDATE SET at=now()",
          [ctx.workspaceId, ctx.principalId, pageId],
        );
        return {
          page: p,
          settings: settings.rows[0] ?? {
            revision: 0,
            state: "active",
            parent_id: null,
            data: {},
          },
        };
      },
    );
  }
  async setDocumentState(ctx: Context, pageId: string, input: unknown) {
    const d = docSchema.parse(input);
    return this.run(
      ctx,
      d.state ? "lifecycle.manage" : "knowledge.protect",
      { kind: "page", id: pageId },
      async (db) => {
        if (
          d.state &&
          Object.keys(d).some(
            (key) => !["expectedRevision", "state", "reason"].includes(key),
          )
        )
          await this.authorize(db, ctx, "knowledge.protect", {
            kind: "page",
            id: pageId,
          });
        // Restoration must not require an already-visible trashed page. Still check all underlying ACLs.
        const state = await loadState(db, ctx.workspaceId),
          p = state.pages.find((p) => p.id === pageId);
        if (!p) throw Error("NOT_FOUND");
        const r = await db.query(
          "SELECT revision,state,parent_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, pageId],
        );
        if (r.rows[0]?.state === "trash" && d.state === "active") {
          await this.manageableTrash(db, ctx, pageId);
        } else await this.page(db, ctx, pageId);
        for (const sid of current(p).sourceIds)
          await requireRead(db, ctx, "source", sid);
        if ((r.rows[0]?.revision ?? 0) !== d.expectedRevision)
          throw Error("STALE_VERSION");
        const nextParent =
          d.parentId === undefined
            ? (r.rows[0]?.parent_id ?? null)
            : d.parentId;
        const visited = new Set([pageId]);
        let parent = nextParent;
        while (parent) {
          if (visited.has(parent)) throw Error("VALIDATION_FAILED");
          visited.add(parent);
          await this.page(db, ctx, parent);
          const a = await db.query(
            "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
            [ctx.workspaceId, parent],
          );
          parent = a.rows[0]?.parent_id;
        }
        if (d.replacementId) await this.page(db, ctx, d.replacementId);
        const {
          expectedRevision: _,
          parentId: __,
          state: ___,
          ...settings
        } = d;
        const next = { ...(r.rows[0]?.data ?? {}), ...settings };
        if (
          d.parentId !== undefined &&
          nextParent !== (r.rows[0]?.parent_id ?? null)
        ) {
          const previousAudience = await readers(
            db,
            ctx.workspaceId,
            "page",
            pageId,
            { includeSelfTrash: true },
          );
          await db.query(
            "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id=$2 AND NOT(principal_id=ANY($3::text[]))",
            [ctx.workspaceId, pageId, previousAudience],
          );
        }
        await db.query(
          "INSERT INTO workflow_document_state VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,page_id) DO UPDATE SET parent_id=excluded.parent_id,state=excluded.state,revision=excluded.revision,data=excluded.data",
          [
            ctx.workspaceId,
            pageId,
            nextParent,
            d.state ?? r.rows[0]?.state ?? "active",
            d.expectedRevision + 1,
            next,
          ],
        );
        if (d.state === "trash" || d.protected !== undefined) {
          const batches = await db.query(
            "SELECT id,data FROM batches WHERE workspace_id=$1 AND data->>'status' IN ('pending','approved')",
            [ctx.workspaceId],
          );
          for (const b of batches.rows)
            if (b.data.updates.some((u: { id: string }) => u.id === pageId)) {
              await db.query(
                "UPDATE batches SET data=jsonb_set(data,'{status}','\"conflict\"') WHERE workspace_id=$1 AND id=$2",
                [ctx.workspaceId, b.id],
              );
              await db.query(
                "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
                [ctx.workspaceId, b.id],
              );
            }
        }
        await audit(db, ctx, "page.lifecycle", pageId);
        return {
          id: pageId,
          revision: d.expectedRevision + 1,
          state: d.state ?? r.rows[0]?.state ?? "active",
          parentId: nextParent,
          ...next,
        };
      },
    );
  }
  async trash(ctx: Context) {
    return this.run(ctx, "lifecycle.manage", undefined, async (db) => {
      const rows = await db.query(
        "SELECT page_id,revision,data FROM workflow_document_state WHERE workspace_id=$1 AND state='trash'",
        [ctx.workspaceId],
      );
      const items = [];
      for (const r of rows.rows) {
        try {
          await this.authorize(db, ctx, "lifecycle.manage", {
            kind: "page",
            id: r.page_id,
          });
          const p = await this.manageableTrash(db, ctx, r.page_id);
          items.push({
            id: r.page_id,
            title: p.title,
            revision: r.revision,
            ...r.data,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      return { items };
    });
  }
  async comments(ctx: Context, pageId: string) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        const p = await this.page(db, ctx, pageId);
        const rows = await db.query(
          "SELECT id,principal_id,revision,version,anchor,data,resolved,deleted,created_at,updated_at FROM workflow_comments WHERE workspace_id=$1 AND page_id=$2 ORDER BY created_at,id",
          [ctx.workspaceId, pageId],
        );
        const items = [];
        for (const c of rows.rows) {
          try {
            await this.requireVersion(db, ctx, p, c.version);
            items.push({
              ...c,
              content: c.deleted ? "[삭제된 댓글]" : c.data.content,
              mentions: c.deleted ? [] : c.data.mentions,
              data: undefined,
            });
          } catch (e) {
            if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
          }
        }
        return { items };
      },
    );
  }
  async addComment(ctx: Context, pageId: string, input: unknown) {
    const c = commentSchema.parse(input);
    return this.run(
      ctx,
      "comment.write",
      { kind: "page", id: pageId },
      async (db) => {
        const p = await this.page(db, ctx, pageId);
        const v = await this.requireVersion(db, ctx, p, c.version);
        if (c.anchor && !v.content.includes(c.anchor))
          throw Error("STALE_VERSION");
        const commentId = randomUUID();
        const validMentions = [];
        for (const who of [...new Set(c.mentions)]) {
          const exists = await db.query(
            "SELECT 1 FROM memberships WHERE workspace_id=$1 AND principal_id=$2",
            [ctx.workspaceId, who],
          );
          if (!exists.rowCount) throw Error("VALIDATION_FAILED");
          try {
            await this.authorize(
              db,
              { workspaceId: ctx.workspaceId, principalId: who },
              "knowledge.read",
              { kind: "page", id: pageId },
            );
            await this.page(
              db,
              { workspaceId: ctx.workspaceId, principalId: who },
              pageId,
            );
            validMentions.push(who);
          } catch (e) {
            if (!(
              e instanceof Error &&
              ["NOT_FOUND", "FORBIDDEN"].includes(e.message)
            ))
              throw e;
          }
        }
        await db.query(
          "INSERT INTO workflow_comments(workspace_id,id,page_id,principal_id,revision,version,anchor,data) VALUES($1,$2,$3,$4,1,$5,$6,$7)",
          [
            ctx.workspaceId,
            commentId,
            pageId,
            ctx.principalId,
            c.version,
            c.anchor,
            { content: c.content, mentions: validMentions },
          ],
        );
        const subscribers = await db.query(
          "SELECT principal_id FROM workflow_subscriptions WHERE workspace_id=$1 AND page_id=$2",
          [ctx.workspaceId, pageId],
        );
        const recipients = new Set([
          ...validMentions,
          ...subscribers.rows.map((r) => r.principal_id),
        ]);
        for (const who of recipients)
          if (who !== ctx.principalId) {
            const prefs = await db.query(
              "SELECT data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
              [ctx.workspaceId, who],
            );
            const settings = prefs.rows[0]?.data ?? {};
            if (!(
              (validMentions.includes(who) && settings.mentions !== false) ||
              (subscribers.rows.some((r) => r.principal_id === who) &&
                settings.subscriptions !== false)
            ))
              continue;
            try {
              await this.authorize(
                db,
                { workspaceId: ctx.workspaceId, principalId: who },
                "knowledge.read",
                { kind: "page", id: pageId },
              );
              await this.page(
                db,
                { workspaceId: ctx.workspaceId, principalId: who },
                pageId,
              );
              await this.requireVersion(
                db,
                { workspaceId: ctx.workspaceId, principalId: who },
                p,
                c.version,
              );
            } catch (e) {
              if (
                e instanceof Error &&
                ["NOT_FOUND", "FORBIDDEN"].includes(e.message)
              )
                continue;
              throw e;
            }
            await db.query(
              "INSERT INTO workflow_notifications(workspace_id,id,principal_id,page_id,version,kind,data) VALUES($1,$2,$3,$4,$5,'comment',$6)",
              [
                ctx.workspaceId,
                randomUUID(),
                who,
                pageId,
                c.version,
                { commentId },
              ],
            );
          }
        await audit(db, ctx, "comment.create", commentId);
        return { id: commentId, revision: 1, ...c, mentions: validMentions };
      },
    );
  }
  async editComment(
    ctx: Context,
    commentId: string,
    expectedRevision: number,
    content: string,
  ) {
    z.string().trim().min(1).max(20000).parse(content);
    return this.run(ctx, "comment.write", undefined, async (db) => {
      const row = await db.query(
        "SELECT * FROM workflow_comments WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id.parse(commentId)],
      );
      if (!row.rowCount) throw Error("NOT_FOUND");
      const c = row.rows[0];
      await this.page(db, ctx, c.page_id);
      if (c.principal_id !== ctx.principalId) throw Error("FORBIDDEN");
      if (c.revision !== expectedRevision || c.deleted)
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE workflow_comments SET data=jsonb_set(data,'{content}',to_jsonb($3::text)),revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, commentId, content],
      );
      await audit(db, ctx, "comment.edit", commentId);
      return { id: commentId, revision: expectedRevision + 1, content };
    });
  }
  async resolveComment(ctx: Context, commentId: string, resolved: boolean) {
    return this.run(ctx, "triage.manage", undefined, async (db) => {
      const r = await db.query(
        "SELECT page_id FROM workflow_comments WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id.parse(commentId)],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      await this.page(db, ctx, r.rows[0].page_id);
      await db.query(
        "UPDATE workflow_comments SET resolved=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, commentId, z.boolean().parse(resolved)],
      );
      await audit(db, ctx, "comment.resolve", commentId);
      return { id: commentId, resolved };
    });
  }
  async deleteComment(
    ctx: Context,
    commentId: string,
    expectedRevision: number,
  ) {
    return this.run(ctx, "comment.write", undefined, async (db) => {
      const row = await db.query(
        "SELECT page_id,principal_id,revision FROM workflow_comments WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id.parse(commentId)],
      );
      if (!row.rowCount) throw Error("NOT_FOUND");
      const c = row.rows[0];
      await this.page(db, ctx, c.page_id);
      if (c.principal_id !== ctx.principalId) throw Error("FORBIDDEN");
      if (c.revision !== expectedRevision) throw Error("STALE_VERSION");
      await db.query(
        "UPDATE workflow_comments SET deleted=true,data='{}',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, commentId],
      );
      await audit(db, ctx, "comment.delete", commentId);
      return { id: commentId };
    });
  }
  async subscribe(ctx: Context, pageId: string, enabled: boolean) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        await this.page(db, ctx, pageId);
        if (enabled)
          await db.query(
            "INSERT INTO workflow_subscriptions VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        else
          await db.query(
            "DELETE FROM workflow_subscriptions WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        return { pageId, enabled };
      },
    );
  }
  async notifications(ctx: Context) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await db.query(
        "SELECT id,page_id,version,kind,data,read_at,created_at FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at DESC LIMIT 500",
        [ctx.workspaceId, ctx.principalId],
      );
      const items = [];
      for (const r of rows.rows) {
        try {
          const p = await this.page(db, ctx, r.page_id);
          if (r.version) await this.requireVersion(db, ctx, p, r.version);
          items.push({ ...r, title: p.title });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      return { items };
    });
  }
  async readNotification(ctx: Context, notificationId: string) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const row = await db.query(
        "SELECT page_id,version FROM workflow_notifications WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
        [ctx.workspaceId, id.parse(notificationId), ctx.principalId],
      );
      if (!row.rowCount) throw Error("NOT_FOUND");
      const p = await this.page(db, ctx, row.rows[0].page_id);
      if (row.rows[0].version)
        await this.requireVersion(db, ctx, p, row.rows[0].version);
      await db.query(
        "UPDATE workflow_notifications SET read_at=now() WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
        [ctx.workspaceId, notificationId, ctx.principalId],
      );
      return { id: notificationId };
    });
  }
  async favorite(ctx: Context, pageId: string, enabled: boolean) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        await this.page(db, ctx, pageId);
        if (enabled)
          await db.query(
            "INSERT INTO workflow_activity VALUES($1,$2,$3,'favorite',now()) ON CONFLICT DO NOTHING",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        else
          await db.query(
            "DELETE FROM workflow_activity WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3 AND kind='favorite'",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        return { pageId, enabled };
      },
    );
  }
  async activity(ctx: Context, kind: "favorite" | "recent") {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await db.query(
        "SELECT page_id,at FROM workflow_activity WHERE workspace_id=$1 AND principal_id=$2 AND kind=$3 ORDER BY at DESC LIMIT 100",
        [ctx.workspaceId, ctx.principalId, kind],
      );
      const items = [];
      for (const r of rows.rows) {
        try {
          const p = await this.page(db, ctx, r.page_id);
          items.push({
            id: p.id,
            title: p.title,
            version: current(p).number,
            at: r.at,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      return { items };
    });
  }
  async saveTemplate(ctx: Context, input: unknown) {
    const t = z
      .object({
        id,
        expectedRevision: revision,
        title: z.string().trim().min(1).max(300),
        content: text,
        originPageId: id.optional(),
      })
      .strict()
      .parse(input);
    return this.run(
      ctx,
      "draft.write",
      t.originPageId ? { kind: "page", id: t.originPageId } : undefined,
      async (db) => {
        const origin = t.originPageId
          ? await this.page(db, ctx, t.originPageId)
          : undefined;
        const row = await db.query(
          "SELECT revision FROM workflow_templates WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, t.id],
        );
        if ((row.rows[0]?.revision ?? 0) !== t.expectedRevision)
          throw Error("STALE_VERSION");
        const { expectedRevision: _, ...rest } = t;
        const data = {
          ...rest,
          ...(origin ? { originVersion: current(origin).number } : {}),
        };
        await db.query(
          "INSERT INTO workflow_templates VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
          [
            ctx.workspaceId,
            ctx.principalId,
            t.id,
            t.expectedRevision + 1,
            data,
          ],
        );
        return { ...data, revision: t.expectedRevision + 1 };
      },
    );
  }
  async templates(ctx: Context) {
    return this.run(ctx, "draft.write", undefined, async (db) => {
      const rows = await db.query(
        "SELECT id,revision,data FROM workflow_templates WHERE workspace_id=$1 AND owner_id=$2",
        [ctx.workspaceId, ctx.principalId],
      );
      const items = [];
      for (const r of rows.rows) {
        try {
          if (r.data.originPageId)
            await this.page(db, ctx, r.data.originPageId);
          items.push({ id: r.id, revision: r.revision, ...r.data });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      }
      return { items };
    });
  }
  async preferences(ctx: Context, input?: unknown) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      if (input !== undefined) {
        const p = z
          .object({
            expectedRevision: revision,
            mentions: z.boolean(),
            subscriptions: z.boolean(),
            dailyDigest: z.boolean(),
            weeklyDigest: z.boolean(),
            timezone: z.string().max(100),
          })
          .strict()
          .parse(input);
        try {
          new Intl.DateTimeFormat("en", { timeZone: p.timezone }).format();
        } catch {
          throw Error("VALIDATION_FAILED");
        }
        const old = await db.query(
          "SELECT revision FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
          [ctx.workspaceId, ctx.principalId],
        );
        if ((old.rows[0]?.revision ?? 0) !== p.expectedRevision)
          throw Error("STALE_VERSION");
        const { expectedRevision: _, ...data } = p;
        await db.query(
          "INSERT INTO workflow_preferences VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
          [ctx.workspaceId, ctx.principalId, p.expectedRevision + 1, data],
        );
        return { ...data, revision: p.expectedRevision + 1 };
      }
      const row = await db.query(
        "SELECT revision,data FROM workflow_preferences WHERE workspace_id=$1 AND principal_id=$2",
        [ctx.workspaceId, ctx.principalId],
      );
      return row.rows[0]
        ? { revision: row.rows[0].revision, ...row.rows[0].data }
        : {
            revision: 0,
            mentions: true,
            subscriptions: true,
            dailyDigest: false,
            weeklyDigest: false,
            timezone: "UTC",
          };
    });
  }
  async correctSource(ctx: Context, sourceId: string, input: unknown) {
    const d = z
      .object({ id, content: text, reason: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(input);
    const original = await this.run(
      ctx,
      "source.create",
      { kind: "source", id: sourceId },
      async (db) => {
        await requireRead(db, ctx, "source", sourceId);
        const r = await db.query(
          "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, sourceId],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        return {
          data: r.rows[0].data,
          readers: await readers(db, ctx.workspaceId, "source", sourceId),
        };
      },
    );
    const next = {
      ...original.data,
      id: d.id,
      content: d.content,
      verification: "미검증",
      createdAt: new Date().toISOString(),
      processed: false,
    };
    await this.runtime.core.registerSource(
      ctx,
      next,
      original.readers,
      async (db) => {
        await this.authorize(db, ctx, "source.create", {
          kind: "source",
          id: sourceId,
        });
        await requireRead(db, ctx, "source", sourceId);
        const audience = await readers(db, ctx.workspaceId, "source", sourceId);
        if (original.readers.some((who) => !audience.includes(who)))
          throw Error("SOURCE_SCOPE_CONFLICT");
        await db.query(
          "INSERT INTO workflow_events VALUES($1,$2,$3,'source.correct',$4,$5,now())",
          [
            ctx.workspaceId,
            randomUUID(),
            ctx.principalId,
            sourceId,
            { replacementId: d.id, reason: d.reason },
          ],
        );
      },
    );
    return next;
  }
  async withdrawSource(ctx: Context, sourceId: string, reason: string) {
    text.parse(reason);
    return this.run(
      ctx,
      "lifecycle.manage",
      { kind: "source", id: sourceId },
      async (db) => {
        await requireRead(db, ctx, "source", sourceId);
        await db.query(
          "INSERT INTO workflow_source_state VALUES($1,$2,'withdrawn',1,$3) ON CONFLICT(workspace_id,source_id) DO UPDATE SET state='withdrawn',revision=workflow_source_state.revision+1,data=excluded.data",
          [
            ctx.workspaceId,
            sourceId,
            { reason, at: new Date().toISOString(), actor: ctx.principalId },
          ],
        );
        const rows = await db.query(
          "SELECT id,data FROM batches WHERE workspace_id=$1 AND data->>'status' IN ('pending','approved')",
          [ctx.workspaceId],
        );
        for (const b of rows.rows)
          if (
            b.data.snapshots.some((s: { id: string }) => s.id === sourceId) ||
            b.data.updates.some((d: { sourceIds: string[] }) =>
              d.sourceIds.includes(sourceId),
            )
          ) {
            await db.query(
              "UPDATE batches SET data=jsonb_set(data,'{status}','\"conflict\"') WHERE workspace_id=$1 AND id=$2",
              [ctx.workspaceId, b.id],
            );
            await db.query(
              "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
              [ctx.workspaceId, b.id],
            );
          }
        await audit(db, ctx, "source.withdraw", sourceId);
        return { id: sourceId, state: "withdrawn" };
      },
    );
  }
  async requestAccess(ctx: Context, resourceId: string, reason: string) {
    id.parse(resourceId);
    z.string().trim().min(1).max(2000).parse(reason);
    const requestId = randomUUID();
    // Same acknowledgement for valid/unknown resources; never return protected titles or owners.
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      await db.query(
        "INSERT INTO workflow_access_requests(id,workspace_id,principal_id,resource_id,reason) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM workflow_access_requests WHERE workspace_id=$2 AND principal_id=$3 AND resource_id=$4 AND status='pending')",
        [requestId, ctx.workspaceId, ctx.principalId, resourceId, reason],
      );
      await audit(db, ctx, "access.request", requestId);
      return { accepted: true };
    });
  }
}
