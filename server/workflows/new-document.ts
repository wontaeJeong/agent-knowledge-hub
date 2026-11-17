import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "./service";
import type { DisclosureRow } from "./manual-disclosure";
import {
  ManualDraftDisclosureService,
  manualTargetSchema,
} from "./manual-disclosure";
import { transaction } from "../database";
import { authorizeInTransaction } from "../access";
import { addResource, audit, membership } from "../repository";
import { fingerprint } from "../provenance";
import { propose } from "../publication";
import type { Draft } from "../../src/domain/wiki";
const schema = manualTargetSchema
  .extend({
    disclosureId: z.string().uuid(),
    disclosureHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function submitNewDraft(
  workflows: WorkflowService,
  ctx: Context,
  draftId: string,
  input: unknown,
) {
  const body = schema.parse(input),
    disclosures = new ManualDraftDisclosureService(workflows),
    inputHash = fingerprint({ draftId, ...body, mutationId: undefined });
  const check = async (db: import("pg").PoolClient) => {
    await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await authorizeInTransaction(db, ctx, "source.create");
    await authorizeInTransaction(db, ctx, "draft.write");
    await authorizeInTransaction(db, ctx, "changeset.propose");
    const row = (
      await db.query(
        "SELECT * FROM workflow_draft_disclosures WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND draft_id=$4 FOR UPDATE",
        [ctx.workspaceId, body.disclosureId, ctx.principalId, draftId],
      )
    ).rows[0] as DisclosureRow | undefined;
    if (!row) throw Error("NOT_FOUND");
    const mutation = (
      await db.query(
        "SELECT id,submission FROM workflow_draft_disclosures WHERE workspace_id=$1 AND owner_id=$2 AND submission->>'mutationId'=$3",
        [ctx.workspaceId, ctx.principalId, body.mutationId],
      )
    ).rows[0];
    if (
      mutation &&
      (mutation.id !== row.id || mutation.submission.inputHash !== inputHash)
    )
      throw Error("IDEMPOTENCY_CONFLICT");

    if (
      row.hash !== body.disclosureHash ||
      row.draft_revision !== body.expectedRevision ||
      row.snapshot.title !== body.title ||
      row.parent_id !== body.parentId
    )
      throw Error("APPROVAL_STALE");
    await disclosures.current(db, ctx, row);
    if (row.status !== "approved") throw Error("DISCLOSURE_REQUIRED");
    if (row.source_id)
      await authorizeInTransaction(db, ctx, "knowledge.read", {
        kind: "source",
        id: row.source_id,
      });
    if (row.submission && row.submission.inputHash !== inputHash)
      throw Error("IDEMPOTENCY_CONFLICT");
    const other = (
      await db.query(
        "SELECT id FROM workflow_draft_disclosures WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 AND batch_id IS NOT NULL",
        [ctx.workspaceId, ctx.principalId, draftId],
      )
    ).rows[0];
    if (other && other.id !== row.id) throw Error("ALREADY_PROPOSED");
    return row;
  };
  await ctx.authorization?.revalidate();
  const prepared = await transaction(workflows.pool, ctx.workspaceId, check);
  const sourceId = "manual-" + prepared.id,
    pageId = "document-" + prepared.id;
  const draft: Draft = {
    id: pageId,
    title: prepared.snapshot.title,
    summary: prepared.snapshot.title,
    content: prepared.snapshot.content,
    scope: prepared.policy_mode === "personal-owner" ? "private" : "team",
    sourceIds: [sourceId, ...prepared.dependency_envelope.sourceIds],
    links: [],
    facts: [],
    baseVersion: 0,
  };
  const batch = await propose(workflows.pool, ctx, [draft], draft.sourceIds, {
    referenceOrigin: workflows.origin,
    producer: {
      kind: ctx.credentialId ? "api-submission" : "user-submission",
      principalId: ctx.principalId,
    },
    dependencyIds: prepared.dependency_envelope.pageIds,
    inputEnvelope: prepared.dependency_envelope,
    initialDocument: { pageId, parentId: prepared.parent_id },
    evolutionReason: body.reason,
    onBeforeCreate: async (db) => {
      const row = await check(db);
      if (row.submission)
        return {
          id: row.submission.result.batchId,
          hash: row.submission.result.hash,
        };
      await addResource(db, ctx.workspaceId, "source", sourceId, row.audience);
      await db.query(
        "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
        [
          ctx.workspaceId,
          sourceId,
          {
            id: sourceId,
            title: row.snapshot.title,
            tool: "manual",
            project: ctx.workspaceId,
            scope: draft.scope,
            verification: "미검증",
            content: row.snapshot.content,
            createdAt: new Date().toISOString(),
            processed: false,
            targetPageId: pageId,
            manualProvenance: {
              pageIds: row.dependency_envelope.pageIds,
              sourceIds: row.dependency_envelope.sourceIds,
            },
            manualDisclosureId: row.id,
            manualRevision: row.draft_revision,
          },
        ],
      );
    },
    onCreated: async (db, result) => {
      const response = {
        status: "knowledge-review-pending",
        sourceId,
        batchId: result.id,
        hash: result.hash,
      };
      await db.query(
        "UPDATE workflow_draft_disclosures SET source_id=$3,batch_id=$4,submission=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [
          ctx.workspaceId,
          prepared.id,
          sourceId,
          result.id,
          { inputHash, mutationId: body.mutationId, result: response },
        ],
      );
      await audit(db, ctx, "draft.submit-new", draftId);
    },
  });
  await ctx.authorization?.revalidate();
  return {
    status: "knowledge-review-pending" as const,
    sourceId,
    batchId: batch.id,
    hash: batch.hash,
  };
}
