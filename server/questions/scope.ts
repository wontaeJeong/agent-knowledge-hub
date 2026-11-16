import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import type { State } from "../../src/domain/types";
import { currentRecommendation } from "../runtime/knowledge";
import { current, retrieve } from "../../src/domain/wiki";
import { queryScope, type QueryScope } from "../runtime/schema";
import { ScopedSearch } from "./search";
import { RefinementService } from "../refinement/service";
import { authorizeInTransaction } from "../access/index";
import { captureEnvelope, type InputEnvelope } from "../provenance";
import type { WorkflowAuthorizer } from "../workflows/service";

/** Server-only composition. Search scope never grants access or adds resources outside the admitted view. */
export async function querySelectionDb(
  pool: Pool,
  db: PoolClient,
  ctx: Context,
  state: State,
  question: string,
  raw: QueryScope | undefined,
  asOf: string,
  authorize: WorkflowAuthorizer = authorizeInTransaction,
  kind: "answer" | "context" = "answer",
) {
  const scope = queryScope.parse(raw ?? {});
  // Preserve the preexisting trusted, in-process legacy offline API. Public hosts always supply authorization.
  if (
    !raw &&
    !ctx.authorization &&
    !ctx.credentialId &&
    !(
      await db.query("SELECT 1 FROM access_spaces WHERE workspace_id=$1", [
        ctx.workspaceId,
      ])
    ).rowCount
  ) {
    const eligible = [];
    for (const page of state.pages)
      if (await currentRecommendation(db, ctx, page.id)) eligible.push(page);
    const selected = retrieve({ ...state, pages: eligible }, question),
      envelope = await captureEnvelope(
        db,
        ctx,
        state,
        selected.map((p) => p.id),
      );
    const pageEnvelopes: Record<string, InputEnvelope> = {};
    for (const page of selected)
      pageEnvelopes[`${page.id}:${current(page).number}`] =
        await captureEnvelope(db, ctx, state, [page.id]);
    return {
      pageEnvelopes,
      scope,
      asOf,
      temporalMode: "current-recommendation",
      timeBasis: "current published knowledge",
      envelope,
      state: { ...state, pages: selected },
      omitted: 0,
      pages: selected.map((p) => ({
        id: p.id,
        title: p.title,
        version: current(p).number,
        content: current(p).content,
        metadata: null,
        metadataStatus: "unknown",
        unknownMetadataKeys: [],
        currentRecommendation: true,
        recordedAt: current(p).at,
        claims: {
          items: [],
          asOf,
          omitted: 0,
          unknownTime: [],
          conflicts: [],
          acl: "current",
          temporalMode: "as-of",
          more: "",
        },
      })),
    };
  }

  const searcher = new ScopedSearch(pool, {
    runtime: { view: async () => ({ state, fingerprint: "admitted-view" }) },
    authorize,
  });
  const found = await searcher.searchDb(
    db,
    ctx,
    {
      query: kind === "context" ? question : "",
      type: scope.topic,
      project: scope.project,
      environment: scope.environment.environment,
      historical: scope.historical,
      periodFrom: scope.periodFrom,
      periodTo: scope.periodTo,
      limit: 100,
    },
    0,
    true,
  );
  const virtual = found.items.map((i) => {
    const p = state.pages.find((p) => p.id === i.pageId)!;
    return {
      ...p,
      title: i.title ?? i.pageId,
      summary: i.metadata?.summary ?? "",
      versions: [p.versions.find((v) => v.number === i.version)!],
    };
  });
  const selected =
    kind === "context"
      ? virtual.slice(0, 100)
      : retrieve({ ...state, pages: virtual }, question);
  const entries = selected.map((p) =>
    found.items.find(
      (i) => i.pageId === p.id && i.version === current(p).number,
    )!,
  );
  const pageIds = new Set<string>(),
    sourceIds = new Set<string>();
  const pageEnvelopes: Record<string, InputEnvelope> = {};
  const snapshots = scope.historical
    ? (
        await db.query(
          "SELECT page_id,number,snapshot FROM version_metadata WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows
    : [];
  for (const item of entries) {
    const roots = new Set([item.pageId]),
      sources = new Set<string>();
    if (scope.historical) {
      const p = state.pages.find((p) => p.id === item.pageId)!,
        v = p.versions.find((v) => v.number === item.version)!;
      for (const id of v.sourceIds) sources.add(id);
      const snap = snapshots.find(
        (s) => s.page_id === item.pageId && s.number === item.version,
      )?.snapshot;
      if (snap) {
        for (const id of [
          ...Object.keys(snap.versions ?? {}),
          ...(snap.relations ?? []),
          ...(snap.parentId ? [snap.parentId] : []),
        ])
          roots.add(id);
        for (const source of snap.sources ?? []) sources.add(source.id);
      }
    }
    const entry = await captureEnvelope(
      db,
      ctx,
      state,
      [...roots],
      [...sources],
    );
    pageEnvelopes[`${item.pageId}:${item.version}`] = entry;
    for (const id of entry.pageIds) pageIds.add(id);
    for (const id of entry.sourceIds) sourceIds.add(id);
  }
  const envelope = await captureEnvelope(
    db,
    ctx,
    state,
    [...pageIds],
    [...sourceIds],
  );
  for (const id of envelope.pageIds)
    await authorize(db, ctx, "knowledge.read", { kind: "page", id });
  for (const id of envelope.sourceIds)
    await authorize(db, ctx, "knowledge.read", { kind: "source", id });
  const refinement = new RefinementService(pool, authorize);
  const pages = [];
  for (const i of entries)
    pages.push({
      id: i.pageId,
      title: i.title ?? i.pageId,
      version: i.version,
      content: i.content,
      metadata: i.metadata,
      metadataStatus: i.metadataStatus,
      unknownMetadataKeys: i.unknownMetadataKeys,
      currentRecommendation: i.currentRecommendation,
      recordedAt: i.at,
      claims: await refinement.queryClaimsDb(
        db,
        ctx,
        i.pageId,
        i.version,
        pageEnvelopes[`${i.pageId}:${i.version}`],
        scope.historical ? i.at : asOf,
        scope.environment,
        scope.historical ? i.at : undefined,
        scope.historical
          ? state.pages
              .find((p) => p.id === i.pageId)
              ?.versions.find((v) => v.number === i.version)?.batchId
          : undefined,
      ),
    });
  return {
    pageEnvelopes,
    scope,
    asOf,
    temporalMode: scope.historical
      ? "documented-history-not-current-recommendation"
      : "current-recommendation",
    timeBasis:
      "periodFrom/periodTo bound publication recording time; claim validity is evaluated at each version recording time in history and at query time for current scope; unknown historical metadata is never inferred from current metadata",
    pages,
    envelope,
    state: { ...state, pages: selected },
    omitted:
      kind === "context" ? Math.max(0, virtual.length - selected.length) : 0,
  };
}
