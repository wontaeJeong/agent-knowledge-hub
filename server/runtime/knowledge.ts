import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { State, Source, Page, Version } from "../../src/domain/types";
import {
  compileOffline,
  answerOffline,
  fileAnswer,
  memory,
  current,
  draftOf,
  lintWiki,
  saveAnswer,
  retrieve,
  type Mode,
  type Answer,
  type Draft,
  type Batch,
} from "../../src/domain/wiki";
import { transaction } from "../database";
import { loadState, membership, readers, audit } from "../repository";
import { KnowledgeService, type Context } from "../service";
import { digest, propose } from "../publication";
import { answerOutput, drafts } from "./schema";
import { callModel, type ModelCall, type ModelOptions } from "./model";
import { authorizeManaged } from "../access/index";
import {
  captureEnvelope,
  assertEnvelope,
  visiblePageIds,
  type InputEnvelope,
} from "../provenance";

export type ProposalReference = { id: string; hash: string };
export type NoChanges = {
  noChanges: true;
  outcome: "no-changes";
  sourceIds: string[];
  checkedPageIds: string[];
  processedSourceIds: [];
};
export type IngestResult = ProposalReference | NoChanges;
function contentFingerprint(d: Draft) {
  return digest({
    title: d.title,
    summary: d.summary,
    content: d.content,
    scope: d.scope,
    links: [...d.links].sort(),
    facts: [...d.facts].sort((a, b) => digest(a).localeCompare(digest(b))),
    sourceIds: [...d.sourceIds].sort(),
  });
}
export interface RuntimeExecution {
  modelWasUsed: () => boolean;
  producer: (
    mode: "offline" | "model",
    db?: PoolClient,
  ) => Promise<NonNullable<Version["producer"]>>;
  modelResult: (
    operation: "ingest" | "query" | "semantic-lint",
    call: () => Promise<unknown>,
  ) => Promise<unknown>;
  selectState?: (state: State) => State;
  captureInputs: (
    db: PoolClient,
    pageIds: string[],
    sourceIds: string[],
  ) => Promise<void>;
  beforeWrite: (db: PoolClient) => Promise<void>;
  completed: (stage: string) => Promise<unknown | undefined>;
  persist: <T>(
    db: PoolClient,
    stage: string,
    write: () => Promise<T>,
  ) => Promise<T>;
  proposalCreated: (
    db: PoolClient,
    result: { id: string; hash: string },
    updates: Draft[],
  ) => Promise<void>;
  maxChanges: number;
  modelOptions: ModelOptions;
}
/** Recommendation eligibility narrows retrieval, not explicit read/history ACLs. */
export async function currentRecommendation(
  db: PoolClient,
  ctx: Context,
  pageId: string,
  at = new Date(),
): Promise<boolean> {
  await authorizeManaged(db, ctx, "knowledge.read", {
    kind: "page",
    id: pageId,
  });
  const row = (
    await db.query(
      "SELECT state,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
      [ctx.workspaceId, pageId],
    )
  ).rows[0];
  const date = row?.data.effectiveFrom;
  return (
    (!row || row.state === "active") &&
    !row?.data.replacementId &&
    (!date || (Number.isFinite(Date.parse(date)) && Date.parse(date) <= +at))
  );
}

export class RuntimeService {
  readonly core: KnowledgeService;
  constructor(
    readonly pool: Pool,
    readonly model: ModelCall = callModel,
  ) {
    this.core = new KnowledgeService(pool);
  }
  async view(db: PoolClient, ctx: Context, execution?: RuntimeExecution) {
    await membership(db, ctx);
    const state = await loadState(db, ctx.workspaceId);
    const fingerprint = digest(state);
    const allowed = async (kind: string, id: string) =>
      (await readers(db, ctx.workspaceId, kind, id)).includes(ctx.principalId);
    const sources: Source[] = [];
    for (const src of state.sources)
      if (await allowed("source", src.id)) sources.push(src);
    const sourceIds = new Set(sources.map((s) => s.id));
    const pages: Page[] = [];
    for (const p of state.pages)
      if (
        (await allowed("page", p.id)) &&
        current(p).sourceIds.every((id) => sourceIds.has(id))
      )
        pages.push({
          ...p,
          versions: p.versions.filter((v) =>
            v.sourceIds.every((id) => sourceIds.has(id)),
          ),
        });
    // The domain's demo role filter is not the server ACL. The filtered view is authoritative.
    // Revoke transitive link consumers too: their summaries/body can contain copied target titles.
    const knownIds = new Set(state.pages.map((p) => p.id));
    let visible = pages;
    for (;;) {
      const visibleIds = new Set(visible.map((p) => p.id));
      const next = visible.filter((p) =>
        (p.links ?? []).every((id) => !knownIds.has(id) || visibleIds.has(id)),
      );
      if (next.length === visible.length) break;
      visible = next;
    }
    const visibleIds = await visiblePageIds(db, ctx, state);
    const filtered: State = {
      ...state,
      role: "editor",
      sources,
      pages: visible.filter((p) => visibleIds.has(p.id)),
      knowledge: { batches: [], answers: [], issues: [] },
    };
    return {
      state: execution?.selectState
        ? execution.selectState(filtered)
        : filtered,
      fingerprint,
    };
  }
  async snapshot(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, (db) => this.view(db, ctx));
  }
  async sources(ctx: Context) {
    await transaction(this.pool, ctx.workspaceId, (db) =>
      authorizeManaged(db, ctx, "changeset.propose"),
    );
    return (await this.snapshot(ctx)).state.sources;
  }
  async pages(ctx: Context) {
    await transaction(this.pool, ctx.workspaceId, (db) =>
      authorizeManaged(db, ctx, "knowledge.read"),
    );
    const flags = (
      await this.pool.query(
        "SELECT page_id,state,data FROM workflow_document_state WHERE workspace_id=$1",
        [ctx.workspaceId],
      )
    ).rows;
    return (await this.snapshot(ctx)).state.pages.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      scope: p.scope,
      version: current(p).number,
      content: current(p).content,
      ...(() => {
        const f = flags.find((f) => f.page_id === p.id),
          d = f?.data ?? {},
          at = Date.now();
        return {
          lifecycle: f?.state ?? "active",
          effectiveFrom: d.effectiveFrom ?? null,
          replacementId: d.replacementId ?? null,
          reviewDue: d.reviewDue ?? null,
          reviewOverdue: !!d.reviewDue && Date.parse(d.reviewDue) < at,
          currentRecommendation:
            (!f || f.state === "active") &&
            !d.replacementId &&
            (!d.effectiveFrom ||
              (Number.isFinite(Date.parse(d.effectiveFrom)) &&
                Date.parse(d.effectiveFrom) <= at)),
        };
      })(),
    }));
  }
  async changesets(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await authorizeManaged(db, ctx, "queue.triage");
      const { state } = await this.view(db, ctx);
      const ids = new Set(state.sources.map((s) => s.id));
      const pageIds = new Set(state.pages.map((p) => p.id));
      const result = await db.query(
        "SELECT id,hash,data FROM batches WHERE workspace_id=$1 ORDER BY id",
        [ctx.workspaceId],
      );
      return result.rows
        .filter(
          (r) =>
            !r.data.requestAuthorizationPending &&
            (r.data as Batch).snapshots.every((s) => ids.has(s.id)) &&
            (
              (r.data as Batch & { contextDependencyIds?: string[] })
                .contextDependencyIds ?? []
            ).every((id) => pageIds.has(id)) &&
            (r.data as Batch).updates.every(
              (d) =>
                d.sourceIds.every((id) => ids.has(id)) &&
                (d.baseVersion === 0 || pageIds.has(d.id)) &&
                d.links.every(
                  (id) =>
                    pageIds.has(id) ||
                    (r.data as Batch).updates.some((x) => x.id === id),
                ),
            ),
        )
        .map((r) => ({
          id: r.id,
          hash: r.hash,
          status: r.data.status,
          updates: r.data.updates,
        }));
    });
  }
  async job<T>(
    ctx: Context,
    operation: string,
    run: () => Promise<T>,
    execution?: RuntimeExecution,
  ): Promise<T> {
    if (execution) return run(); // Durable queue owns lifecycle; legacy HTTP fixtures retain old history.
    const id = randomUUID();
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await authorizeManaged(
        db,
        ctx,
        operation === "ingest" ? "changeset.propose" : "knowledge.read",
      );
      const active = await db.query(
        "SELECT count(*)::integer AS n FROM runtime_jobs WHERE workspace_id=$1 AND status='running'",
        [ctx.workspaceId],
      );
      if (active.rows[0].n >= 2) throw Error("JOB_CAPACITY");
      await db.query(
        "INSERT INTO runtime_jobs(id,workspace_id,principal_id,operation,status) VALUES($1,$2,$3,$4,'running')",
        [id, ctx.workspaceId, ctx.principalId, operation],
      );
    });
    try {
      const result = await run();
      await this.pool.query(
        "UPDATE runtime_jobs SET status='succeeded',finished_at=now() WHERE id=$1",
        [id],
      );
      return result;
    } catch (e) {
      const code =
        e instanceof Error && /^[A-Z_]+$/.test(e.message)
          ? e.message
          : "VALIDATION_FAILED";
      await this.pool.query(
        "UPDATE runtime_jobs SET status='failed',finished_at=now(),error_code=$2 WHERE id=$1",
        [id, code],
      );
      throw e;
    }
  }
  async ingest(
    ctx: Context,
    sourceIds: string[],
    mode: Mode,
  ): Promise<ProposalReference>;
  async ingest(
    ctx: Context,
    sourceIds: string[],
    mode: Mode,
    execution: RuntimeExecution,
  ): Promise<IngestResult>;
  async ingest(
    ctx: Context,
    sourceIds: string[],
    mode: Mode,
    execution?: RuntimeExecution,
  ) {
    return this.job(
      ctx,
      "ingest",
      async () => {
        const done = await execution?.completed("ingest");
        if (done !== undefined) return done as IngestResult;
        const { state, fingerprint } = await transaction(
          this.pool,
          ctx.workspaceId,
          async (db) => {
            const snapshot = await this.view(db, ctx, execution);
            await execution?.captureInputs(
              db,
              snapshot.state.pages.map((p) => p.id),
              snapshot.state.sources.map((s) => s.id),
            );
            return snapshot;
          },
        );
        await transaction(this.pool, ctx.workspaceId, async (db) => {
          if ((await membership(db, ctx)) === "reader")
            throw Error("FORBIDDEN");
        });
        const sources = sourceIds.map((id) =>
          state.sources.find((s) => s.id === id),
        );
        if (sources.some((s) => !s)) throw Error("NOT_FOUND");
        if (
          sources.some((s) => s!.scope === "private") &&
          !(state as State & { serverPersonalSpace?: boolean })
            .serverPersonalSpace
        )
          throw Error("SOURCE_SCOPE_CONFLICT");
        let updates: Draft[];
        let dependencyIds: string[] = [];
        let inputEnvelope: InputEnvelope | undefined;
        if (mode === "model") {
          if (new Set(sources.map((s) => s!.scope)).size !== 1)
            throw Error("SOURCE_SCOPE_CONFLICT");
          const eligible = await transaction(
            this.pool,
            ctx.workspaceId,
            async (db) => {
              const ids = [];
              for (const p of state.pages)
                if (await currentRecommendation(db, ctx, p.id)) ids.push(p.id);
              return new Set(ids);
            },
          );
          const contextPages = state.pages.filter(
            (p) => p.scope === sources[0]!.scope && eligible.has(p.id),
          );
          dependencyIds = contextPages.map((p) => p.id);
          inputEnvelope = await transaction(this.pool, ctx.workspaceId, (db) =>
            captureEnvelope(db, ctx, state, dependencyIds, sourceIds),
          );
          const modelInput = {
            sources,
            pages: contextPages.map((p) => ({
              ...p,
              versions: undefined,
              content: current(p).content,
              baseVersion: current(p).number,
            })),
          };
          const modelOptions = {
            ...execution?.modelOptions,
            privatePersonalSpace:
              Boolean(
                (state as State & { serverPersonalSpace?: boolean })
                  .serverPersonalSpace,
              ) && sources.every((s) => s?.scope === "private"),
          };
          const data = execution
            ? await execution.modelResult("ingest", () =>
                this.model("ingest", modelInput, modelOptions),
              )
            : await this.model("ingest", modelInput, modelOptions);
          const proposed = (data as { updates: unknown }).updates;
          updates =
            Array.isArray(proposed) && proposed.length === 0
              ? []
              : drafts.parse(proposed);
          // All supplied context can influence prose. Preserve its source lineage even when the model omits it.
          const lineage = [
            ...sourceIds,
            ...contextPages.flatMap((p) => current(p).sourceIds),
          ];
          updates = updates.map((d) => ({
            ...d,
            sourceIds: [...new Set([...d.sourceIds, ...lineage])],
          }));
        } else {
          // An empty workspace has no target topic. Bootstrap it as a proposal, never a direct publication.
          const synthetic = new Map<string, Page>();
          for (const s of sources as Source[])
            if (!state.pages.some((p) => p.id === s.targetPageId)) {
              synthetic.set(s.targetPageId, {
                id: s.targetPageId,
                title: s.project || "기본",
                summary: "편입 자료의 연결 주제",
                category: "주제",
                scope: s.scope,
                status: "미검증",
                owner: ctx.principalId,
                tags: [],
                favorite: false,
                reused: 0,
                links: [],
                facts: [],
                versions: [
                  {
                    id: randomUUID(),
                    number: 0,
                    content: "# " + (s.project || "기본"),
                    sourceIds: [],
                    author: ctx.principalId,
                    reason: "bootstrap proposal",
                    at: new Date().toISOString(),
                  },
                ],
              });
            }
          updates = compileOffline(
            { ...state, pages: [...state.pages, ...synthetic.values()] },
            sourceIds,
          );
        }
        updates = updates.filter((d) => {
          const p = state.pages.find((p) => p.id === d.id);
          if (!p) return true;
          if (d.baseVersion !== current(p).number) throw Error("STALE_VERSION");
          return contentFingerprint(d) !== contentFingerprint(draftOf(p));
        });
        if (mode === "model" || execution)
          await ctx.authorization?.revalidate();
        if (!updates.length) {
          if (!execution) {
            await transaction(this.pool, ctx.workspaceId, async (db) => {
              await ctx.authorization?.assertSession(db);
              const fresh = await loadState(db, ctx.workspaceId);
              if (inputEnvelope)
                await assertEnvelope(db, ctx, fresh, inputEnvelope);
              if (digest(fresh) !== fingerprint) throw Error("STALE_VERSION");
              for (const id of dependencyIds)
                if (!(await currentRecommendation(db, ctx, id)))
                  throw Error("STALE_VERSION");
            });
            throw Error("NO_CHANGES");
          }
          const noChanges: NoChanges = {
            noChanges: true,
            outcome: "no-changes",
            sourceIds: [...sourceIds],
            checkedPageIds: state.pages.map((p) => p.id),
            processedSourceIds: [],
          };
          return transaction(this.pool, ctx.workspaceId, (db) =>
            execution.persist(db, "ingest", async () => noChanges),
          );
        }
        if (execution && updates.length > execution.maxChanges)
          throw Error("CHANGE_LIMIT");
        const producer = execution
          ? await execution.producer(mode)
          : mode === "model"
            ? { kind: "model" as const, provider: null, model: null }
            : { kind: "structural" as const };
        let result: { id: string; hash: string };
        try {
          result = await propose(
            this.pool,
            ctx,
            drafts.parse(updates),
            sourceIds,
            {
              expectedStateHash: fingerprint,
              mode,
              dependencyIds,
              inputEnvelope,
              producer,
              requestAuthorizationPending:
                mode === "model" && Boolean(ctx.authorization) && !execution,
              onCreated: async (db, result) => {
                if (mode === "model")
                  for (const id of dependencyIds)
                    if (!(await currentRecommendation(db, ctx, id)))
                      throw Error("STALE_VERSION");
                await execution?.proposalCreated(db, result, updates);
              },
            },
          );
        } catch (e) {
          if (
            execution &&
            e instanceof Error &&
            e.message === "RUNTIME_EFFECT_EXISTS"
          ) {
            const prior = await execution.completed("ingest");
            if (prior !== undefined) return prior as IngestResult;
          }
          throw e;
        }
        if (mode === "model" && ctx.authorization && !execution)
          await this.releaseAuthorizedResult(ctx, "batch", result.id);
        return result;
      },
      execution,
    );
  }
  async query(
    ctx: Context,
    question: string,
    mode: Mode,
    execution?: RuntimeExecution,
  ) {
    return this.job(
      ctx,
      "query",
      async () => {
        const done = await execution?.completed("query");
        if (done !== undefined) return done as Answer;
        const { state, envelope } = await transaction(
          this.pool,
          ctx.workspaceId,
          async (db) => {
            const { state } = await this.view(db, ctx, execution);
            await execution?.captureInputs(
              db,
              state.pages.map((p) => p.id),
              state.sources.map((s) => s.id),
            );
            const eligible = [];
            for (const p of state.pages)
              if (await currentRecommendation(db, ctx, p.id)) eligible.push(p);
            state.pages = eligible;
            const pages = retrieve(state, question);
            return {
              state,
              envelope: await captureEnvelope(
                db,
                ctx,
                state,
                pages.map((p) => p.id),
              ),
            };
          },
        );
        let answer: Answer;
        if (mode === "model") {
          const pages = retrieve(state, question);
          const modelInput = {
            question,
            pages: pages.map((p) => ({
              id: p.id,
              title: p.title,
              version: current(p).number,
              content: current(p).content,
            })),
          };
          const raw = execution
            ? await execution.modelResult("query", () =>
                this.model("query", modelInput, execution.modelOptions),
              )
            : await this.model("query", modelInput);
          const data = answerOutput.parse(raw);
          answer = {
            ...data,
            id: randomUUID(),
            question,
            mode,
            at: new Date().toISOString(),
          };
        } else answer = answerOffline(state, question);
        if (mode === "model" || execution)
          await ctx.authorization?.revalidate();
        const persisted = await transaction(
          this.pool,
          ctx.workspaceId,
          async (db) => {
            await execution?.beforeWrite(db);
            if (mode === "model") await ctx.authorization?.assertSession(db);
            const fresh = (await this.view(db, ctx, execution)).state;
            await assertEnvelope(db, ctx, fresh, envelope);
            for (const citation of answer.citations) {
              const p = fresh.pages.find((p) => p.id === citation.pageId);
              if (
                !p ||
                current(p).number !== citation.version ||
                p.title !== citation.title
              )
                throw Error("STALE_VERSION");
            }
            for (const citation of answer.citations)
              if (!(await currentRecommendation(db, ctx, citation.pageId)))
                throw Error("STALE_VERSION");
            const write = async () => {
              saveAnswer(fresh, answer);
              await db.query(
                "INSERT INTO runtime_answers VALUES($1,$2,$3,$4)",
                [
                  ctx.workspaceId,
                  answer.id,
                  ctx.principalId,
                  {
                    ...answer,
                    producer: execution
                      ? await execution.producer(mode, db)
                      : mode === "model"
                        ? { kind: "model", provider: null, model: null }
                        : { kind: "structural" },
                    inputEnvelope: envelope,
                    ...(mode === "model" && ctx.authorization && !execution
                      ? { requestAuthorizationPending: true }
                      : {}),
                  },
                ],
              );
              await audit(db, ctx, "query", answer.id);
              return answer;
            };
            return execution ? execution.persist(db, "query", write) : write();
          },
        );
        if (mode === "model" && ctx.authorization && !execution)
          await this.releaseAuthorizedResult(ctx, "answer", answer.id);
        return persisted;
      },
      execution,
    );
  }
  async file(ctx: Context, id: string) {
    const { state, fingerprint } = await this.snapshot(ctx);
    const row = await this.pool.query(
      "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
      [ctx.workspaceId, id, ctx.principalId],
    );
    if (!row.rowCount) throw Error("NOT_FOUND");
    if (row.rows[0].data.requestAuthorizationPending) throw Error("NOT_FOUND");
    const answer = row.rows[0].data as Answer & {
      inputEnvelope?: InputEnvelope;
      producer?: NonNullable<Version["producer"]>;
    };
    if (answer.mode === "model" && !answer.inputEnvelope)
      throw Error("STALE_VERSION");
    if (answer.inputEnvelope)
      await transaction(this.pool, ctx.workspaceId, (db) =>
        assertEnvelope(db, ctx, state, answer.inputEnvelope!),
      );
    saveAnswer(state, answer);
    state.knowledge!.answers = [answer];
    const next = fileAnswer(state, id);
    const batch = memory(next).batches[0];
    return propose(
      this.pool,
      ctx,
      drafts.parse(
        batch.updates.map((d) => ({
          ...d,
          sourceIds: [
            ...new Set([
              ...d.sourceIds,
              ...(answer.inputEnvelope?.sourceIds ?? []),
            ]),
          ],
        })),
      ),
      [
        ...new Set([
          ...batch.snapshots.map((s) => s.id),
          ...(answer.inputEnvelope?.sourceIds ?? []),
        ]),
      ],
      {
        expectedStateHash: fingerprint,
        mode: answer.mode,
        producer: answer.producer,
        dependencyIds:
          answer.inputEnvelope?.pageIds ??
          answer.citations.map((c) => c.pageId),
        inputEnvelope: answer.inputEnvelope,
        answerId: answer.id,
      },
    );
  }
  async lint(ctx: Context, execution?: RuntimeExecution) {
    if (execution) await ctx.authorization?.revalidate(); // Live identity I/O outside DB locks.
    const done = await execution?.completed("lint");
    if (done !== undefined)
      return done as { issues: ReturnType<typeof lintWiki> };
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await authorizeManaged(db, ctx, "lint.run");
      const { state } = await this.view(db, ctx, execution);
      await execution?.captureInputs(
        db,
        state.pages.map((p) => p.id),
        state.sources.map((s) => s.id),
      );
      await execution?.beforeWrite(db);
      const flags = (
        await db.query(
          "SELECT page_id,state,data FROM workflow_document_state WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows.filter((f) => state.pages.some((p) => p.id === f.page_id));
      const data = {
        issues: lintWiki(state),
        documentFlags: flags.map((f) => ({
          pageId: f.page_id,
          lifecycle: f.state,
          effectiveFrom: f.data.effectiveFrom ?? null,
          replacementId: f.data.replacementId ?? null,
          reviewDue: f.data.reviewDue ?? null,
          reviewOverdue:
            !!f.data.reviewDue && Date.parse(f.data.reviewDue) < Date.now(),
        })),
      };
      for (const flag of data.documentFlags)
        if (flag.reviewOverdue)
          data.issues.push({
            id: "review-due:" + flag.pageId,
            kind: "stale",
            pageIds: [flag.pageId],
            detail: `검토 기한이 지났습니다: ${flag.reviewDue}. 기한 경과는 자동 폐기나 주장 거짓 판정이 아닙니다.`,
          });
      const write = async () => {
        await db.query(
          "INSERT INTO runtime_lints VALUES($1,$2,$3) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET data=excluded.data",
          [ctx.workspaceId, ctx.principalId, data],
        );
        await audit(db, ctx, "lint", "workspace");
        return data;
      };
      return execution ? execution.persist(db, "lint", write) : write();
    });
  }
  async jobs(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await authorizeManaged(db, ctx, "knowledge.read");
      return (
        await db.query(
          "SELECT id,operation,status,created_at,finished_at,error_code FROM runtime_jobs WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at",
          [ctx.workspaceId, ctx.principalId],
        )
      ).rows;
    });
  }
  async reject(ctx: Context, id: string, hash: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      if ((await membership(db, ctx)) !== "reviewer") throw Error("FORBIDDEN");
      if (!(await this.changesetsForDb(db, ctx)).includes(id))
        throw Error("NOT_FOUND");
      const r = await db.query(
        "SELECT data,hash FROM batches WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id],
      );
      if (r.rows[0].hash !== hash) throw Error("APPROVAL_STALE");
      if (!["pending", "approved", "rejected"].includes(r.rows[0].data.status))
        throw Error("STALE_VERSION");
      await db.query(
        "UPDATE batches SET data=jsonb_set(data,'{status}','\"rejected\"') WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id],
      );
      await db.query(
        "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
        [ctx.workspaceId, id],
      );
      await audit(db, ctx, "batch.reject", id);
      return { id, hash };
    });
  }
  private async changesetsForDb(db: PoolClient, ctx: Context) {
    const r = await db.query(
      "SELECT id,data FROM batches WHERE workspace_id=$1",
      [ctx.workspaceId],
    );
    const ids = [];
    for (const row of r.rows) {
      if (row.data.requestAuthorizationPending) continue;
      let ok = true;
      for (const s of row.data.snapshots)
        if (
          !(await readers(db, ctx.workspaceId, "source", s.id)).includes(
            ctx.principalId,
          )
        )
          ok = false;
      if (ok) ids.push(row.id);
    }
    return ids;
  }
  /** Results stay invisible/unapprovable until a final live IdP + originating-session check succeeds. */
  private async releaseAuthorizedResult(
    ctx: Context,
    kind: "batch" | "answer",
    id: string,
  ) {
    const table = kind === "batch" ? "batches" : "runtime_answers";
    try {
      await ctx.authorization!.revalidate(); // Network I/O is outside every DB transaction.
      await transaction(this.pool, ctx.workspaceId, async (db) => {
        await ctx.authorization!.assertSession(db);
        const row = await db.query(
          `SELECT data FROM ${table} WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId, id],
        );
        if (!row.rowCount || !row.rows[0].data.requestAuthorizationPending)
          throw Error("NOT_FOUND");
        const envelope = row.rows[0].data.inputEnvelope as InputEnvelope;
        await assertEnvelope(
          db,
          ctx,
          await loadState(db, ctx.workspaceId),
          envelope,
        );
        await db.query(
          `UPDATE ${table} SET data=data-'requestAuthorizationPending' WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId, id],
        );
      });
    } catch (error) {
      // A failed final check discards the private staged result, never a published/approved object.
      await transaction(this.pool, ctx.workspaceId, (db) =>
        db.query(
          `DELETE FROM ${table} WHERE workspace_id=$1 AND id=$2 AND data->>'requestAuthorizationPending'='true'`,
          [ctx.workspaceId, id],
        ),
      );
      throw error;
    }
  }
}
