import { z } from "zod";
import type { PoolClient } from "pg";
import type { Source, State } from "../../src/domain/types";
import type { Draft, Batch } from "../../src/domain/wiki";
import type { Context } from "../service";
import {
  proposalCandidateInput,
  type ProposalCandidate,
} from "../refinement/logic";
import { digest } from "../publication";
import type { InputEnvelope } from "../provenance";

/** The server binds model claims to immutable source bytes; model timestamps never verify them. */
export function bindCandidates(
  data: unknown,
  sources: Source[],
  updates: Draft[],
): ProposalCandidate[] {
  return z
    .array(proposalCandidateInput)
    .max(100)
    .parse((data as { candidates?: unknown }).candidates ?? [])
    .map((candidate) => {
      const source = sources.find((s) => s.id === candidate.sourceId),
        update = updates.find((d) => d.id === candidate.pageId);
      const start = source?.content.indexOf(candidate.quote) ?? -1;
      if (
        !source ||
        !update ||
        !update.sourceIds.includes(source.id) ||
        start < 0
      )
        throw Error("MODEL_INVALID");
      return {
        ...candidate,
        sourceVersion: digest(source),
        location: {
          start,
          end: start + candidate.quote.length,
          quote: candidate.quote,
        },
        verifiedAt: null,
      };
    });
}
type Rejected = Batch & {
  requestAuthorizationPending?: boolean;
  inputEnvelope?: InputEnvelope;
  contextDependencyIds?: string[];
  reviewFeedback?: { reason: string; recordedBy: string; recordedAt: string };
};
export async function rejectedFeedback(
  db: PoolClient,
  ctx: Context,
  state: State,
  relevantPageIds: string[],
  sourceIds: string[],
) {
  const sourceSet = new Set(state.sources.map((s) => s.id)),
    pageSet = new Set(state.pages.map((p) => p.id));
  const rows = await db.query(
    "SELECT id,data FROM batches WHERE workspace_id=$1 AND data->>'status'='rejected' ORDER BY id",
    [ctx.workspaceId],
  );
  const result = rows.rows.filter((row) => {
    const b = row.data as Rejected;
    return (
      !b.requestAuthorizationPending &&
      (b.snapshots.some((s) => sourceIds.includes(s.id)) ||
        b.updates.some((d) => relevantPageIds.includes(d.id))) &&
      [
        ...b.snapshots.map((s) => s.id),
        ...(b.inputEnvelope?.sourceIds ?? []),
        ...b.updates.flatMap((d) => d.sourceIds),
      ].every((s) => sourceSet.has(s)) &&
      [
        ...(b.inputEnvelope?.pageIds ?? []),
        ...(b.contextDependencyIds ?? []),
        ...b.updates.filter((d) => d.baseVersion > 0).map((d) => d.id),
      ].every((p) => pageSet.has(p))
    );
  });
  if (result.length > 100) throw Error("MODEL_CONTEXT_LIMIT");
  return result.map((row) => ({
    batchId: row.id,
    batch: row.data as Rejected,
    reason:
      (row.data as Rejected).reviewFeedback?.reason ??
      "이전 검토에서 반려됨 (사유 미기록)",
  }));
}
export function assertChangedAfterRejection(
  previous: Awaited<ReturnType<typeof rejectedFeedback>>,
  updates: Draft[],
  sources: Source[],
) {
  for (const { batch } of previous) {
    // Newly selected source bytes permit a fresh review. Array ordering alone does not revise a rejected proposal.
    const old = new Map(batch.snapshots.map((s) => [s.id, digest(s)]));
    if (sources.some((s) => old.get(s.id) !== digest(s))) continue;
    const signature = (drafts: Draft[]) =>
      digest(
        drafts
          .map((d) => ({
            ...d,
            sourceIds: [...d.sourceIds].sort(),
            links: [...d.links].sort(),
            facts: [...d.facts].sort((a, b) =>
              digest(a).localeCompare(digest(b)),
            ),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    if (signature(batch.updates) === signature(updates))
      throw Error("REJECTED_PROPOSAL_UNCHANGED");
  }
}

export async function sourceCorrections(
  db: PoolClient,
  ctx: Context,
  state: State,
  selected: string[],
) {
  const byId = new Map(state.sources.map((s) => [s.id, s]));
  const rows = await db.query(
    "SELECT resource_id,data FROM workflow_events WHERE workspace_id=$1 AND kind='source.correct' AND (resource_id=ANY($2::text[]) OR data->>'replacementId'=ANY($2::text[])) ORDER BY created_at,id",
    [ctx.workspaceId, selected],
  );
  const visible = rows.rows.filter(
    (r) => byId.has(r.resource_id) && byId.has(r.data.replacementId),
  );
  if (visible.length > 100) throw Error("MODEL_CONTEXT_LIMIT");
  return visible.map((r) => ({
    original: byId.get(r.resource_id)!,
    replacement: byId.get(r.data.replacementId)!,
    reason: String(r.data.reason),
  }));
}

/** Only published edits and current page protection enter the model's human decision context. */
export async function humanDecisions(
  db: PoolClient,
  ctx: Context,
  pageIds: string[],
) {
  const edits = await db.query(
    "SELECT e.data,e.created_at,e.principal_id,b.data AS batch FROM workflow_events e JOIN batches b ON b.workspace_id=e.workspace_id AND b.id=e.resource_id WHERE e.workspace_id=$1 AND e.kind='page.edit.propose' AND e.data->>'pageId'=ANY($2::text[]) AND b.data->>'status'='published' ORDER BY e.created_at,e.id LIMIT 101",
    [ctx.workspaceId, pageIds],
  );
  const flags = await db.query(
    "SELECT page_id,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=ANY($2::text[]) AND data->>'protected'='true' ORDER BY page_id",
    [ctx.workspaceId, pageIds],
  );
  if (edits.rows.length > 100) throw Error("MODEL_CONTEXT_LIMIT");
  return [
    ...edits.rows.map((e) => ({
      kind: "published-edit",
      pageId: e.data.pageId,
      reason: e.data.reason,
      recordedBy: e.principal_id,
      recordedAt: e.created_at,
      pageVersion:
        e.batch.updates.find((d: Draft) => d.id === e.data.pageId)
          ?.baseVersion + 1,
    })),
    ...flags.rows.map((f) => ({
      kind: "protection",
      pageId: f.page_id,
      reason: f.data.reason ?? "보호된 내용",
      protected: true,
    })),
  ];
}
