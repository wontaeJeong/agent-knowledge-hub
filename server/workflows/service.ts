import { recordDocumentVisit } from "./activity";
import { PersonalLibraryService } from "../convenience/personal";
import type { LibraryKind } from "../convenience/types";
import { bulkPreview, bulkApply } from "./bulk";
import { RefinementService } from "../refinement/service";
import {
  beginVersionMetadataChange,
  finishVersionMetadataChange,
} from "./versions/metadata";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  dependencyVersions,
  mergeDependencyVersions,
  internalReferenceIds,
  referenceOrigin,
} from "./references";
import type { Context } from "../service";
import type { Page, State } from "../../src/domain/types";
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
    restoreParentId: id.nullable().optional(),
    restoreTitle: z.string().trim().min(1).max(300).optional(),
    reason: z.string().trim().min(1).max(2000),
    tags: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    properties: z.record(z.string().max(100), z.string().max(2000)).optional(),
    reviewDue: z.iso.datetime().nullable().optional(),
    effectiveFrom: z.iso.datetime().nullable().optional(),
    effectiveUntil: z.iso.datetime().nullable().optional(),
    replacementId: id.nullable().optional(),
    protected: z.boolean().optional(),
  })
  .strict();

export class WorkflowService {
  readonly origin: string | undefined;
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
    readonly authorize: WorkflowAuthorizer,
    origin?: string,
  ) {
    this.origin = referenceOrigin(origin);
  }
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
    access?: { state: State; visible: Set<string> },
  ): Promise<Page> {
    id.parse(pageId);
    const state = access?.state ?? (await loadState(db, ctx.workspaceId));
    if (!(access?.visible ?? await visiblePageIds(db, ctx, state)).has(pageId))
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
  /** Resolve rendered same-space links server-side; client metadata is not an authority boundary. */
  private async referenceDependencies(
    db: PoolClient,
    ctx: Context,
    content: string,
    retained: Record<string, number>,
  ) {
    let dependencies = { ...retained };
    for (const target of internalReferenceIds(
      content,
      ctx.workspaceId,
      this.origin,
    )) {
      const p = await this.page(db, ctx, target);
      if (!Object.hasOwn(dependencies, target))
        dependencies = { ...dependencies, [target]: current(p).number };
    }
    dependencyVersions.parse(dependencies);
    for (const [target, version] of Object.entries(dependencies)) {
      const p = await this.page(db, ctx, target);
      await this.requireVersion(db, ctx, p, version);
    }
    return dependencies;
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
  bulkPreview(ctx: Context, input: unknown) {
    return bulkPreview(this, ctx, input);
  }
  bulkApply(ctx: Context, input: unknown) {
    return bulkApply(this, ctx, input);
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
          const lineage = await this.draftHistoryAccess(db, ctx, row.id);
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
            ...(Object.keys(lineage.dependencyVersions).length
              ? { dependencyVersions: lineage.dependencyVersions }
              : {}),
            updatedAt: row.updated_at,
          });
        } catch (e) {
          if (!(
            e instanceof Error &&
            ["NOT_FOUND", "STALE_VERSION"].includes(e.message)
          ))
            throw e;
        }
      }
      return { items };
    });
  }
  private async draftHistoryAccess(
    db: PoolClient,
    ctx: Context,
    draftId: string,
    maximumRevision?: number,
  ) {
    const history = await db.query(
      "SELECT data FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 AND ($4::integer IS NULL OR revision<=$4) UNION ALL SELECT data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3 AND ($4::integer IS NULL OR revision<=$4)",
      [ctx.workspaceId, ctx.principalId, draftId, maximumRevision ?? null],
    );
    // Recorded pins are authoritative regardless of physical history row order.
    let dependencies: Record<string, number> = {};
    for (const row of history.rows)
      dependencies = mergeDependencyVersions(
        dependencies,
        row.data.dependencyVersions ?? {},
      );
    const sources = new Set<string>();
    for (const row of history.rows) {
      const d = row.data;
      if (d.pageId) await this.page(db, ctx, d.pageId);
      for (const sid of d.sourceIds ?? []) {
        await requireRead(db, ctx, "source", sid);
        sources.add(sid);
      }
      dependencies = await this.referenceDependencies(
        db,
        ctx,
        d.content,
        dependencies,
      );
    }
    return { dependencyVersions: dependencies, sourceIds: [...sources] };
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
        const history = await this.draftHistoryAccess(db, ctx, d.id);
        if (d.pageId) {
          const p = await this.page(db, ctx, d.pageId);
          if (!d.baseVersion) throw Error("VALIDATION_FAILED");
          await this.requireVersion(db, ctx, p, d.baseVersion);
        }
        for (const sid of d.sourceIds ?? [])
          await requireRead(db, ctx, "source", sid);
        const before = await db.query(
          "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, d.id],
        );
        const previous = before.rows[0]?.data;
        const dependencies = await this.referenceDependencies(
          db,
          ctx,
          d.content,
          mergeDependencyVersions(
            history.dependencyVersions,
            previous?.dependencyVersions ?? {},
            d.dependencyVersions ?? {},
            previous?.pageId &&
              previous.pageId !== d.pageId &&
              previous.baseVersion
              ? { [previous.pageId]: previous.baseVersion }
              : {},
          ),
        );
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
        if ((before.rows[0]?.revision ?? 0) !== d.expectedRevision)
          throw Error("STALE_VERSION");
        const next = d.expectedRevision + 1;
        const { expectedRevision: _, mutationId: __, ...submitted } = d;
        // Removing client labels is not removal of inherited evidence. Keep
        // provenance in the current row too, so submitDraft's existing envelope
        // and commitGuard cannot publish a lineage-stripped private revision.
        const sourceIds = [
          ...new Set<string>([
            ...history.sourceIds,
            ...(previous?.sourceIds ?? []),
            ...(d.sourceIds ?? []),
          ]),
        ];
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
        const references = await this.referenceDependencies(
          db,
          ctx,
          edit.content,
          dependencyVersions.parse(dependencies),
        );
        for (const [dependency, version] of Object.entries(references)) {
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
          [...new Set([pageId, ...Object.keys(references)])],
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
        const lineage = await this.draftHistoryAccess(db, ctx, draftId);
        const row = await db.query(
          "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, id.parse(draftId)],
        );
        if (!row.rowCount) throw Error("NOT_FOUND");
        if (row.rows[0].revision !== expectedRevision)
          throw Error("STALE_VERSION");
        return { ...row.rows[0].data, ...lineage };
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
        await recordDocumentVisit(db, ctx, pageId);
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
  /** Navigation DTOs carry current metadata only. No historical bodies or hidden counts. */
  private async navigablePages(db: PoolClient, ctx: Context) {
    const state = await loadState(db, ctx.workspaceId);
    const visible = await visiblePageIds(db, ctx, state);
    // visiblePageIds includes current source lineage, ancestor ACLs, cycles and trash.
    return state.pages
      .filter((p) => visible.has(p.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  private linkedIds(p: Page, workspaceId: string) {
    return new Set([
      ...(p.links ?? []),
      ...internalReferenceIds(current(p).content, workspaceId, this.origin),
    ]);
  }

  async linkSearch(ctx: Context, input: unknown) {
    const { query } = z
      .object({ query: z.string().trim().min(1).max(200) })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const matches = (await this.navigablePages(db, ctx)).filter(
        (p) =>
          p.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ||
          p.id.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      );
      return {
        items: matches.slice(0, 20).map((p) => ({
          id: p.id,
          title: p.title,
          version: current(p).number,
        })),
        truncated: matches.length > 20,
      };
    });
  }
  async navigation(ctx: Context, pageId: string) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        const origin = await this.page(db, ctx, pageId);
        const candidates = (await this.navigablePages(db, ctx)).filter(
          (p) => p.id !== pageId,
        );
        const outgoing = this.linkedIds(origin, ctx.workspaceId);
        const links = candidates.filter((p) => outgoing.has(p.id));
        const backlinks = candidates.filter((p) =>
          this.linkedIds(p, ctx.workspaceId).has(pageId),
        );
        const related = candidates.filter(
          (p) =>
            !outgoing.has(p.id) &&
            !backlinks.some((b) => b.id === p.id) &&
            origin.tags.some((tag) => p.tags.includes(tag)),
        );
        const metadata = (items: Page[]) =>
          items.slice(0, 20).map((p) => ({
            id: p.id,
            title: p.title,
            version: current(p).number,
          }));
        return {
          pageId,
          version: current(origin).number,
          links: metadata(links),
          backlinks: metadata(backlinks),
          related: metadata(related),
          truncated: {
            links: links.length > 20,
            backlinks: backlinks.length > 20,
            related: related.length > 20,
          },
        };
      },
    );
  }
  async setDocumentState(
    ctx: Context,
    pageId: string,
    input: unknown,
    bulkReceiptId?: string,
  ) {
    const d = docSchema.parse(input);
    return this.run(
      ctx,
      d.state ? "lifecycle.manage" : "knowledge.protect",
      { kind: "page", id: pageId },
      async (db) => {
        if (
          d.state &&
          Object.keys(d).some(
            (key) =>
              ![
                "expectedRevision",
                "state",
                "reason",
                "restoreParentId",
                "restoreTitle",
              ].includes(key),
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
        if (bulkReceiptId) {
          const saved = await db.query(
            "SELECT data FROM workflow_events WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND kind='bulk.apply' AND resource_id=$4",
            [ctx.workspaceId, bulkReceiptId, ctx.principalId, pageId],
          );
          if (saved.rowCount)
            return {
              id: pageId,
              revision: Number(saved.rows[0].data.revision),
              state: r.rows[0]?.state ?? "active",
              parentId: r.rows[0]?.parent_id ?? null,
            };
        }
        if ((r.rows[0]?.revision ?? 0) !== d.expectedRevision)
          throw Error("STALE_VERSION");
        const restoring = r.rows[0]?.state === "trash" && d.state === "active";
        if (
          (d.restoreParentId !== undefined || d.restoreTitle !== undefined) &&
          !restoring
        )
          throw Error("VALIDATION_FAILED");
        const nextParent =
          restoring && d.restoreParentId !== undefined
            ? d.restoreParentId
            : d.parentId === undefined
              ? (r.rows[0]?.parent_id ?? null)
              : d.parentId;
        if (
          restoring &&
          ((d.restoreParentId !== undefined &&
            nextParent !== (r.rows[0]?.parent_id ?? null)) ||
            (d.restoreTitle !== undefined && d.restoreTitle !== p.title))
        ) {
          // run() already checked the page, its current provenance and ACL under
          // lifecycle.manage, which alone can resolve the trashed page. Check the
          // additional capability without resolving that page as active again.
          await this.authorize(db, ctx, "knowledge.protect");
        }
        if (restoring) {
          const conflict = await db.query(
            `SELECT 1 FROM pages p LEFT JOIN workflow_document_state s ON s.workspace_id=p.workspace_id AND s.page_id=p.id WHERE p.workspace_id=$1 AND p.id<>$2 AND coalesce(s.state,'active')<>'trash' AND s.parent_id IS NOT DISTINCT FROM $3 AND p.data->>'title'=$4 LIMIT 1`,
            [ctx.workspaceId, pageId, nextParent, d.restoreTitle ?? p.title],
          );
          if (conflict.rowCount) throw Error("RESTORE_PATH_CONFLICT");
        }
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
        if (
          restoring &&
          d.restoreParentId &&
          nextParent !== (r.rows[0]?.parent_id ?? null)
        )
          await this.authorize(db, ctx, "knowledge.protect", {
            kind: "page",
            id: d.restoreParentId,
          });
        if (d.replacementId) await this.page(db, ctx, d.replacementId);
        const {
          expectedRevision: _,
          parentId: __,
          state: ___,
          restoreParentId: ____,
          restoreTitle: _____,
          tags: ______,
          ...settings
        } = d;
        const next = { ...(r.rows[0]?.data ?? {}), ...settings };
        if (d.state === "trash" && r.rows[0]?.state !== "trash") {
          const policy = (
            await db.query(
              "SELECT policy FROM content_retention_policies WHERE workspace_id=$1",
              [ctx.workspaceId],
            )
          ).rows[0]?.policy;
          const grace =
            policy?.enabled &&
            Number.isSafeInteger(policy?.trashGraceDays) &&
            policy.trashGraceDays >= 1 &&
            policy.trashGraceDays <= 36500
              ? policy.trashGraceDays
              : null;
          const time = (await db.query("SELECT clock_timestamp() AS now"))
            .rows[0].now as Date;
          next.trashedAt = time.toISOString();
          next.purgeAfter =
            grace === null
              ? null
              : new Date(time.getTime() + grace * 86400000).toISOString();
        } else if (restoring) {
          next.trashedAt = null;
          next.purgeAfter = null;
        }
        const metadataChange = await beginVersionMetadataChange(
          db,
          ctx,
          pageId,
          this.authorize,
        );
        if (
          (d.parentId !== undefined || d.restoreParentId !== undefined) &&
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
        if (
          restoring &&
          d.restoreTitle !== undefined &&
          d.restoreTitle !== p.title
        ) {
          await db.query(
            "UPDATE pages SET data=jsonb_set(data,'{title}',to_jsonb($3::text)) WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, pageId, d.restoreTitle],
          );
          await db.query(
            "INSERT INTO workflow_events(workspace_id,id,principal_id,kind,resource_id,data) VALUES($1,$2,$3,'page.restore.rename',$4,$5)",
            [
              ctx.workspaceId,
              randomUUID(),
              ctx.principalId,
              pageId,
              { before: p.title, after: d.restoreTitle, reason: d.reason },
            ],
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
        if (
          d.state === "trash" ||
          d.protected !== undefined ||
          (restoring &&
            d.restoreTitle !== undefined &&
            d.restoreTitle !== p.title)
        ) {
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
        if (d.tags !== undefined)
          await db.query(
            "UPDATE pages SET data=jsonb_set(data,'{tags}',$3::jsonb) WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, pageId, JSON.stringify([...new Set(d.tags)])],
          );
        await finishVersionMetadataChange(
          db,
          ctx,
          metadataChange,
          d.reason,
          this.authorize,
        );
        await audit(db, ctx, "page.lifecycle", pageId);
        if (bulkReceiptId)
          await db.query(
            "INSERT INTO workflow_events(workspace_id,id,principal_id,kind,resource_id,data) VALUES($1,$2,$3,'bulk.apply',$4,$5)",
            [
              ctx.workspaceId,
              bulkReceiptId,
              ctx.principalId,
              pageId,
              { revision: d.expectedRevision + 1 },
            ],
          );
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
          `SELECT principal_id FROM workflow_subscriptions WHERE workspace_id=$1 AND page_id=$2
           UNION SELECT s.principal_id FROM collaboration_subscriptions s WHERE s.workspace_id=$1 AND (s.scope='space' OR s.target IN (SELECT data->>'category' FROM pages WHERE workspace_id=$1 AND id=$2))`,
          [ctx.workspaceId, pageId],
        );
        const recipients = new Set([
          ...validMentions,
          ...subscribers.rows.map((r) => r.principal_id),
        ]);
        for (const who of [...recipients].sort())
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
        "SELECT id,page_id,version,kind,data,read_at,created_at FROM workflow_notifications WHERE workspace_id=$1 AND principal_id=$2 AND page_id IS NOT NULL AND NOT(data ? 'eventId') ORDER BY created_at DESC LIMIT 500",
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
            "INSERT INTO workflow_activity(workspace_id,principal_id,page_id,kind,at) VALUES($1,$2,$3,'favorite',now()) ON CONFLICT DO NOTHING",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        else
          await db.query(
            "DELETE FROM workflow_activity WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3 AND kind='favorite'",
            [ctx.workspaceId, ctx.principalId, pageId],
          );
        await db.query(
          "INSERT INTO workflow_personal_library_state(workspace_id,principal_id,revision) VALUES($1,$2,1) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET revision=workflow_personal_library_state.revision+1",
          [ctx.workspaceId, ctx.principalId],
        );
        await audit(db, ctx, "favorite.state", pageId);
        return { pageId, enabled };
      },
    );
  }
  async activity(
    ctx: Context,
    kind: "favorite" | "recent",
    input: { cursor?: string | null; limit?: number } = {},
  ) {
    return new PersonalLibraryService(this).list(ctx, {
      kind: kind === "favorite" ? "favorites" : "recent",
      ...input,
    });
  }
  /** Canonical non-visit boundary; stored preferences never grant read access. */
  async personalDocumentState(ctx: Context, pageId: string) {
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "page", id: pageId },
      async (db) => {
        await this.page(db, ctx, pageId);
        const favorite = await db.query(
          "SELECT 1 FROM workflow_activity WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3 AND kind='favorite'",
          [ctx.workspaceId, ctx.principalId, pageId],
        );
        const subscribed = await db.query(
          "SELECT 1 FROM workflow_subscriptions WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3",
          [ctx.workspaceId, ctx.principalId, pageId],
        );
        return {
          favorite: !!favorite.rowCount,
          subscribed: !!subscribed.rowCount,
        };
      },
    );
  }
  private async personalRows(db: PoolClient, ctx: Context, kind: LibraryKind) {
    const rows =
      kind === "subscriptions"
        ? await db.query(
            "SELECT page_id,NULL::timestamptz AS at FROM workflow_subscriptions WHERE workspace_id=$1 AND principal_id=$2 ORDER BY page_id LIMIT 10001",
            [ctx.workspaceId, ctx.principalId],
          )
        : await db.query(
            "SELECT page_id,at FROM workflow_activity WHERE workspace_id=$1 AND principal_id=$2 AND kind=$3 ORDER BY CASE WHEN kind='favorite' THEN position END NULLS LAST,at DESC,page_id LIMIT 10001",
            [
              ctx.workspaceId,
              ctx.principalId,
              kind === "favorites" ? "favorite" : "recent",
            ],
          );
    if (rows.rows.length > 10000) throw Error("PERSONAL_LIBRARY_CAPACITY");
    const state = await loadState(db, ctx.workspaceId);
    const access = { state, visible: await visiblePageIds(db, ctx, state) };
    const items = [];
    for (const row of rows.rows) {
      try {
        // Reuse document/source/lineage/ancestor/trash checks without a recent write.
        const p = await this.page(db, ctx, row.page_id, false, access);
        items.push({
          id: p.id,
          title: p.title,
          version: current(p).number,
          at: row.at ? new Date(row.at).toISOString() : null,
        });
      } catch (e) {
        if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
      }
    }
    return items;
  }
  async personalSnapshot(ctx: Context, kind: LibraryKind) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const items = await this.personalRows(db, ctx, kind);
      const revision =
        (
          await db.query(
            "SELECT revision FROM workflow_personal_library_state WHERE workspace_id=$1 AND principal_id=$2",
            [ctx.workspaceId, ctx.principalId],
          )
        ).rows[0]?.revision ?? 0;
      const authorizationHash = fingerprint(
        await captureEnvelope(
          db,
          ctx,
          await loadState(db, ctx.workspaceId),
          items.map((item) => item.id),
        ),
      );
      return { items, revision: Number(revision), authorizationHash };
    });
  }
  async reorderPersonalFavorites(
    ctx: Context,
    input: { pageIds: string[]; expectedRevision: number; mutationId: string },
  ) {
    return this.run(ctx, "knowledge.read", undefined, (db) =>
      this.updatePersonalFavorites(db, ctx, input),
    );
  }
  async movePersonalFavorite(
    ctx: Context,
    input: {
      pageId: string;
      direction: "up" | "down";
      expectedRevision: number;
      mutationId: string;
    },
  ) {
    return this.run(ctx, "knowledge.read", undefined, (db) =>
      this.updatePersonalFavorites(db, ctx, input),
    );
  }
  private async updatePersonalFavorites(
    db: PoolClient,
    ctx: Context,
    input:
      | { pageIds: string[]; expectedRevision: number; mutationId: string }
      | {
          pageId: string;
          direction: "up" | "down";
          expectedRevision: number;
          mutationId: string;
        },
  ) {
    const items = await this.personalRows(db, ctx, "favorites");
    const requested = "pageIds" in input ? input.pageIds : [input.pageId];
    if (requested.some((id) => !items.some((item) => item.id === id)))
      throw Error("NOT_FOUND");
    const visibilityHash = fingerprint(
      await captureEnvelope(
        db,
        ctx,
        await loadState(db, ctx.workspaceId),
        items.map((item) => item.id).sort(),
      ),
    );
    const payloadHash = fingerprint(
      "pageIds" in input ? input : { operation: "move", ...input },
    );
    const old = (
      await db.query(
        "SELECT payload_hash,visibility_hash,revision FROM workflow_personal_library_mutations WHERE workspace_id=$1 AND principal_id=$2 AND mutation_id=$3",
        [ctx.workspaceId, ctx.principalId, input.mutationId],
      )
    ).rows[0];
    if (old) {
      if (old.payload_hash !== payloadHash) throw Error("MUTATION_CONFLICT");
      if (old.visibility_hash !== visibilityHash) throw Error("STALE_VERSION");
      return { revision: Number(old.revision) };
    }
    await db.query(
      "INSERT INTO workflow_personal_library_state(workspace_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [ctx.workspaceId, ctx.principalId],
    );
    const row = (
      await db.query(
        "SELECT revision FROM workflow_personal_library_state WHERE workspace_id=$1 AND principal_id=$2 FOR UPDATE",
        [ctx.workspaceId, ctx.principalId],
      )
    ).rows[0];
    if (Number(row.revision) !== input.expectedRevision)
      throw Error("STALE_VERSION");
    let order: string[];
    if ("pageIds" in input) {
      const selected = new Set(input.pageIds);
      let offset = 0;
      order = items.map((item) =>
        selected.has(item.id) ? input.pageIds[offset++] : item.id,
      );
    } else {
      order = items.map((item) => item.id);
      const index = order.indexOf(input.pageId),
        next = index + (input.direction === "up" ? -1 : 1);
      if (next < 0 || next >= order.length) throw Error("FAVORITE_BOUNDARY");
      [order[index], order[next]] = [order[next], order[index]];
    }
    for (const [position, pageId] of order.entries())
      await db.query(
        "UPDATE workflow_activity SET position=$4 WHERE workspace_id=$1 AND principal_id=$2 AND page_id=$3 AND kind='favorite'",
        [ctx.workspaceId, ctx.principalId, pageId, position],
      );
    const revision = input.expectedRevision + 1;
    await db.query(
      "UPDATE workflow_personal_library_state SET revision=$3 WHERE workspace_id=$1 AND principal_id=$2",
      [ctx.workspaceId, ctx.principalId, revision],
    );
    await db.query(
      "INSERT INTO workflow_personal_library_mutations(workspace_id,principal_id,mutation_id,payload_hash,visibility_hash,revision) VALUES($1,$2,$3,$4,$5,$6)",
      [
        ctx.workspaceId,
        ctx.principalId,
        input.mutationId,
        payloadHash,
        visibilityHash,
        revision,
      ],
    );
    await audit(db, ctx, "favorite.reorder", ctx.principalId);
    return { revision };
  }
  /** Templates currently carry one origin only. Additional draft lineage must
   * stay in a private draft until templates have a reviewed multi-root contract. */
  private async plainTemplateAccess(
    db: PoolClient,
    ctx: Context,
    t: {
      content: string;
      originPageId?: string;
      originVersion?: number;
      dependencyVersions?: Record<string, number>;
      sourceIds?: string[];
      sourceDraftId?: string;
      sourceDraftRevision?: number;
    },
  ) {
    const origin = t.originPageId
      ? await this.page(db, ctx, t.originPageId)
      : undefined;
    let dependencies = t.dependencyVersions ?? {};
    const sources = new Set(t.sourceIds ?? []);
    if (t.sourceDraftId) {
      await assertDraftNotRetired(db, ctx, t.sourceDraftId);
      if (!t.sourceDraftRevision) throw Error("NOT_FOUND");
      const exact = await db.query(
        "SELECT data FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 AND revision=$4 UNION ALL SELECT data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3 AND revision=$4",
        [
          ctx.workspaceId,
          ctx.principalId,
          t.sourceDraftId,
          t.sourceDraftRevision,
        ],
      );
      if (
        !exact.rowCount ||
        exact.rows.some(
          (row) =>
            row.data.content !== t.content ||
            row.data.pageId !== t.originPageId ||
            (t.originVersion && row.data.baseVersion !== t.originVersion),
        )
      )
        throw Error("NOT_FOUND");
      const lineage = await this.draftHistoryAccess(
        db,
        ctx,
        t.sourceDraftId,
        t.sourceDraftRevision,
      );
      dependencies = mergeDependencyVersions(
        dependencies,
        lineage.dependencyVersions,
      );
      for (const sid of lineage.sourceIds) sources.add(sid);
    } else {
      // Legacy unbound templates use exact owner-scoped copied-body evidence.
      // Merely sharing an origin is not evidence that another draft influenced it.
      const candidates = await db.query(
        "SELECT id FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND data->>'content'=$3 UNION SELECT draft_id AS id FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND data->>'content'=$3",
        [ctx.workspaceId, ctx.principalId, t.content],
      );
      for (const row of candidates.rows) {
        await assertDraftNotRetired(db, ctx, row.id);
        const lineage = await this.draftHistoryAccess(db, ctx, row.id);
        dependencies = mergeDependencyVersions(
          dependencies,
          lineage.dependencyVersions,
        );
        for (const sid of lineage.sourceIds) sources.add(sid);
      }
    }
    dependencies = await this.referenceDependencies(
      db,
      ctx,
      t.content,
      dependencies,
    );
    const originVersion = origin
      ? (t.originVersion ?? current(origin).number)
      : undefined;
    if (origin && originVersion)
      await this.requireVersion(db, ctx, origin, originVersion);
    const originSources = new Set(
      origin ? inheritedProvenance(origin).sourceIds : [],
    );
    if (
      Object.keys(dependencies).some(
        (target) =>
          target !== t.originPageId || dependencies[target] !== originVersion,
      ) ||
      [...sources].some((source) => !originSources.has(source))
    )
      throw Error("SOURCE_SCOPE_CONFLICT");
    return originVersion;
  }
  async saveTemplate(ctx: Context, input: unknown) {
    const t = z
      .object({
        id,
        expectedRevision: revision,
        title: z.string().trim().min(1).max(300),
        content: text,
        originPageId: id.optional(),
        sourceDraftId: id.optional(),
        sourceDraftRevision: z.number().int().positive().optional(),
      })
      .strict()
      .refine((t) => !!t.sourceDraftId === !!t.sourceDraftRevision)
      .parse(input);
    return this.run(
      ctx,
      "draft.write",
      t.originPageId ? { kind: "page", id: t.originPageId } : undefined,
      async (db) => {
        let draftOriginVersion: number | undefined;
        if (t.sourceDraftId) {
          await assertDraftNotRetired(db, ctx, t.sourceDraftId);
          await this.draftHistoryAccess(db, ctx, t.sourceDraftId);
          const draft = (
            await db.query(
              "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
              [ctx.workspaceId, ctx.principalId, t.sourceDraftId],
            )
          ).rows[0];
          if (!draft) throw Error("NOT_FOUND");
          if (
            draft.revision !== t.sourceDraftRevision ||
            draft.data.content !== t.content ||
            draft.data.pageId !== t.originPageId
          )
            throw Error("STALE_VERSION");
          draftOriginVersion = draft.data.baseVersion;
        }
        const row = await db.query(
          "SELECT revision,data FROM workflow_templates WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, t.id],
        );
        if ((row.rows[0]?.revision ?? 0) !== t.expectedRevision)
          throw Error("STALE_VERSION");
        const previous = row.rows[0]?.data;
        if (previous) {
          await this.plainTemplateAccess(db, ctx, previous);
          if (previous.originPageId && previous.originPageId !== t.originPageId)
            throw Error("SOURCE_SCOPE_CONFLICT");
        }
        const originVersion = await this.plainTemplateAccess(db, ctx, {
          ...t,
          originVersion: previous?.originVersion ?? draftOriginVersion,
        });
        const { expectedRevision: _, ...rest } = t;
        const data = {
          ...rest,
          ...(originVersion ? { originVersion } : {}),
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
          await this.plainTemplateAccess(db, ctx, r.data);
          items.push({ id: r.id, revision: r.revision, ...r.data });
        } catch (e) {
          if (!(
            e instanceof Error &&
            ["NOT_FOUND", "SOURCE_SCOPE_CONFLICT", "STALE_VERSION"].includes(
              e.message,
            )
          ))
            throw e;
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
        await new RefinementService(
          this.pool,
          this.authorize,
        ).sourceCorrectionDb(db, ctx, sourceId, d.id, d.reason);
        // Approval was based on superseded evidence; immutable original sources remain readable.
        const pending = await db.query(
          "SELECT id,data FROM batches WHERE workspace_id=$1 AND data->>'status' IN ('pending','approved') FOR UPDATE",
          [ctx.workspaceId],
        );
        for (const b of pending.rows)
          if (
            b.data.snapshots.some((s: { id: string }) => s.id === sourceId) ||
            b.data.updates.some((u: { sourceIds: string[] }) =>
              u.sourceIds.includes(sourceId),
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
