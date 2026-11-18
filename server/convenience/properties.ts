import type { PoolClient } from "pg";
import { effectiveReferenceIds } from "../workflows/references";
import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "../workflows/service";
import { transaction } from "../database";
import { authorizeActionDb } from "../access";
import {
  currentMetadata,
  type RestorePlan,
} from "../workflows/versions/metadata";
import { documentPropertiesSchema } from "../../src/domain/document-properties";
import { captureEnvelope, fingerprint } from "../provenance";
import { loadState } from "../repository";
import { draftOf, current } from "../../src/domain/wiki";
import { propose } from "../publication";
const input = documentPropertiesSchema
  .extend({
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(2000),
    mutationId: z.string().uuid(),
  })
  .strict();
/** Reconstruct the same relation set that publication will review, including legacy Markdown. */
export async function propertyReferenceContext(
  db: PoolClient,
  ctx: Context,
  pageId: string,
  origin?: string,
) {
  const state = await loadState(db, ctx.workspaceId);
  const metadata = await currentMetadata(db, ctx, pageId);
  const page = state.pages.find((p) => p.id === pageId)!;
  const version = current(page);
  const relations = effectiveReferenceIds(
    version.content,
    ctx.workspaceId,
    metadata.relations,
    origin,
  );
  const versions = new Map(Object.entries(metadata.versions));
  const parents = new Map<string, string | null>();
  for (const target of new Set([pageId, ...relations])) {
    let id: string | null = target;
    const chain = new Set<string>();
    while (id) {
      if (chain.has(id)) throw Error("VALIDATION_FAILED");
      chain.add(id);
      if (!parents.has(id)) {
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "page",
          id,
        });
        const parent =
          (
            await db.query(
              "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
              [ctx.workspaceId, id],
            )
          ).rows[0]?.parent_id ?? null;
        parents.set(id, parent);
      }
      id = parents.get(id)!;
    }
    if (relations.includes(target))
      versions.set(
        target,
        current(state.pages.find((p) => p.id === target)!).number,
      );
  }
  const envelope = await captureEnvelope(db, ctx, state, [...parents.keys()]);
  const parentIds = Object.fromEntries(parents);
  const induced = relations.filter((id) => !metadata.relations.includes(id));
  const relationChanges = induced.length
    ? {
        before: metadata.relations,
        selected: metadata.relations,
        effective: relations,
        induced,
      }
    : undefined;
  return {
    state,
    metadata,
    page,
    version,
    relations,
    relationChanges,
    versions: Object.fromEntries(versions),
    envelope,
    parentIds,
    consentHash: fingerprint({ metadata, envelope, parentIds }),
  };
}
export class DocumentPropertiesService {
  constructor(readonly workflows: WorkflowService) {}
  async read(ctx: Context, pageId: string) {
    await ctx.authorization?.revalidate();
    const read = () =>
      transaction(this.workflows.pool, ctx.workspaceId, async (db) => {
        await ctx.authorization?.assertSession(db);
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "page",
          id: pageId,
        });
        return {
          metadata: await currentMetadata(db, ctx, pageId),
          policies: (
            await db.query(
              "SELECT document_type,required_keys,mode FROM governance_type_policies WHERE workspace_id=$1",
              [ctx.workspaceId],
            )
          ).rows,
          owner:
            (
              await db.query(
                "SELECT revision,owner_id,backup_id FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2",
                [ctx.workspaceId, pageId],
              )
            ).rows[0] ?? null,
        };
      });
    await read();
    await ctx.authorization?.revalidate();
    return read();
  }
  async propose(
    ctx: Context,
    pageId: string,
    raw: unknown,
    expectedMetadataHash?: string,
  ) {
    const d = input.parse(raw),
      digest = expectedMetadataHash
        ? fingerprint({
            pageId,
            mutationId: d.mutationId,
            expectedMetadataHash,
            tags: d.tags,
            reason: d.reason,
          })
        : fingerprint({ pageId, ...d }),
      receipt = "properties-" + d.mutationId;
    await ctx.authorization?.revalidate();
    const prepared = await transaction(
      this.workflows.pool,
      ctx.workspaceId,
      async (db) => {
        await ctx.authorization?.assertSession(db);
        await authorizeActionDb(db, ctx, "knowledge.protect", {
          kind: "page",
          id: pageId,
        });
        await authorizeActionDb(db, ctx, "changeset.propose");
        const context = await propertyReferenceContext(
          db,
          ctx,
          pageId,
          this.workflows.origin,
        );
        const previous = (
          await db.query(
            "SELECT data FROM workflow_events WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND kind='properties.propose'",
            [ctx.workspaceId, receipt, ctx.principalId],
          )
        ).rows[0]?.data;
        if (previous) {
          if (previous.inputHash !== digest)
            throw Error("IDEMPOTENCY_CONFLICT");
          return { previous };
        }
        const { metadata, page, version: v, envelope } = context;
        if (
          expectedMetadataHash &&
          context.consentHash !== expectedMetadataHash
        )
          throw Error("STALE_VERSION");
        if (
          metadata.number !== d.expectedVersion ||
          metadata.settingsRevision !== d.expectedRevision
        )
          throw Error("STALE_VERSION");
        const policy = (
          await db.query(
            "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
            [ctx.workspaceId],
          )
        ).rows[0];
        if (!policy) throw Error("NOT_FOUND");
        const { environment: _legacyEnvironment, ...properties } = d.properties;
        const next = {
          ...metadata,
          relations: context.relations,
          versions: context.versions,
          category: d.category,
          summary: d.summary,
          tags: d.tags,
          properties,
          environment: d.environment,
          workflowData: { ...metadata.workflowData, reviewDue: d.reviewDue },
        };
        const plan: RestorePlan = {
          pageId,
          targetVersion: v.number,
          baseVersion: v.number,
          settingsRevision: d.expectedRevision,
          policyVersion: policy.policy_version,
          fields: [
            "category",
            "summary",
            "tags",
            "properties",
            "environment",
            "reviewDue",
          ],
          next,
          ...(context.relationChanges && {
            relationChanges: context.relationChanges,
          }),
          currentHash: fingerprint(metadata),
          content: v.content,
          sourceIds: v.sourceIds,
          dependencies: envelope.pageIds,
        };
        return {
          plan,
          envelope,
          consentHash: context.consentHash,
          update: {
            ...draftOf(page),
            links: context.relations,
            summary: d.summary,
          },
        };
      },
    );
    if (prepared.previous)
      return {
        id: prepared.previous.id,
        hash: prepared.previous.hash,
        status: "needs-review" as const,
      };
    const result = await propose(
      this.workflows.pool,
      ctx,
      [prepared.update!],
      prepared.plan!.sourceIds,
      {
        referenceOrigin: this.workflows.origin,
        versionMetadataPlans: [prepared.plan!],
        inputEnvelope: prepared.envelope,
        dependencyIds: prepared.plan!.dependencies,
        evolutionReason: d.reason,
        onBeforeCreate: async (db) => {
          const current = await propertyReferenceContext(
            db,
            ctx,
            pageId,
            this.workflows.origin,
          );
          await authorizeActionDb(db, ctx, "knowledge.protect", {
            kind: "page",
            id: pageId,
          });
          const previous = (
            await db.query(
              "SELECT data FROM workflow_events WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND kind='properties.propose'",
              [ctx.workspaceId, receipt, ctx.principalId],
            )
          ).rows[0]?.data;
          if (previous) {
            if (previous.inputHash !== digest)
              throw Error("IDEMPOTENCY_CONFLICT");
            return { id: previous.id, hash: previous.hash };
          }
          if (current.consentHash !== prepared.consentHash)
            throw Error("STALE_VERSION");
        },
        onCreated: async (db, result) => {
          await db.query(
            "INSERT INTO workflow_events(workspace_id,id,principal_id,kind,resource_id,data) VALUES($1,$2,$3,'properties.propose',$4,$5)",
            [
              ctx.workspaceId,
              receipt,
              ctx.principalId,
              pageId,
              { ...result, inputHash: digest },
            ],
          );
        },
      },
    );
    await ctx.authorization?.revalidate();
    return { ...result, status: "needs-review" as const };
  }
}
