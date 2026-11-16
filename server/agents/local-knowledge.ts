import { z } from "zod";
import type { AgentService } from "./service";
import type { Context } from "../service";
import type { RuntimeJobsBridge } from "../jobs/runtime";
import { ingestInput, queryInput } from "../runtime/schema";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const key = z.string().min(1).max(100);
/** Portable connector returns references only. Protected bodies stay in the server review UI;
 * copying those bodies requires the existing local.copy and source-policy paths. */
export async function localKnowledge(
  agents: AgentService,
  ctx: Context,
  action: string,
  input: unknown,
  jobs?: RuntimeJobsBridge,
): Promise<unknown> {
  if (!ctx.credentialId) throw Error("SCOPED_CREDENTIAL_REQUIRED");
  await ctx.authorization?.revalidate();
  if (action === "knowledge-capabilities") {
    z.object({}).strict().parse(input);
    return {
      schemaVersion: "1.0",
      connectedOnly: true,
      referenceOnly: true,
      executionConfigured: Boolean(jobs),
    };
  }
  if (action === "knowledge-register") {
    const artifact = (
      input as { artifact?: { scope?: unknown; readers?: unknown } }
    )?.artifact;
    if (
      artifact?.scope === "private" &&
      (!Array.isArray(artifact.readers) ||
        artifact.readers.length !== 1 ||
        artifact.readers[0] !== ctx.principalId)
    )
      throw Error("SOURCE_SCOPE_CONFLICT");
    return {
      ...(await agents.submitArtifact(ctx, input)),
      sourceVersion: 1,
      verification: "unverified",
    };
  }
  if (!jobs) throw Error("EXECUTION_NOT_CONFIGURED");
  if (action === "knowledge-job") {
    const q = z.object({ id }).strict().parse(input);
    const job = await jobs.read(ctx, q.id);
    const value = job.result as Record<string, any> | null;
    const proposal =
      value?.id && job.kind === "ingest"
        ? (
            await agents.pool.query(
              "SELECT data FROM batches WHERE workspace_id=$1 AND id=$2",
              [ctx.workspaceId, value.id],
            )
          ).rows[0]?.data
        : null;
    const result = !value
      ? null
      : job.kind === "query"
        ? {
            kind: "derived-answer",
            id: value.id,
            mode: value.mode,
            insufficient: value.insufficient,
            citations: Array.isArray(value.citations)
              ? value.citations.map((c: any) => ({
                  pageId: c.pageId,
                  version: c.version,
                }))
              : [],
          }
        : job.kind === "lint"
          ? {
              kind: "lint-review",
              id: value.id,
              findings: Array.isArray(value.issues)
                ? value.issues.map((f: any) => ({
                    id: f.id,
                    kind: f.kind,
                    pageIds: f.pageIds,
                    sourceIds: f.sourceIds,
                  }))
                : [],
            }
          : {
              id: value.id,
              hash: value.hash,
              status: proposal?.status ?? value.status,
              published: proposal?.status === "published",
              outcome: value.outcome,
            };
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      error: job.error,
      result,
      humanReviewRequired: true,
      reviewPath: "/?app=1",
    };
  }
  if (action === "knowledge-file-answer")
    return reference(await agents.fileAnswer(ctx, input));
  const kind = action.slice("knowledge-".length);
  if (!["ingest", "query", "lint"].includes(kind))
    throw Error("UNSUPPORTED_OPERATION");
  const q = z
    .object({
      payload:
        kind === "ingest"
          ? ingestInput
          : kind === "query"
            ? queryInput
            : z.object({}).strict(),
      idempotency_key: key,
    })
    .strict()
    .parse(input);
  const receipt = await jobs.submitInteractive(
    ctx,
    kind as "ingest" | "query" | "lint",
    q.payload,
    "local-" + q.idempotency_key,
  );
  // enqueue may replay a completed full DTO. Never copy its result/checkpoint.
  return {
    id: receipt.id,
    kind: receipt.kind,
    status: receipt.status,
    error: receipt.error,
    humanReviewRequired: true,
    reviewPath: "/?app=1",
  };
}
function reference(result: any) {
  return {
    id: result.id,
    hash: result.hash,
    status: result.outcome ?? result.status ?? "pending",
    published: false,
    ...(result.outcome ? { outcome: result.outcome } : {}),
    humanReviewRequired: true,
    reviewPath: "/?app=1",
  };
}
