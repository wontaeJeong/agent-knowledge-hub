import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { State, Source, Page } from "../../src/domain/types";
import {
  compileOffline,
  answerOffline,
  fileAnswer,
  memory,
  current,
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
import { callModel, type ModelCall } from "./model";
import { ImportService } from "../imports/service";
import {
  captureEnvelope,
  assertEnvelope,
  visiblePageIds,
  type InputEnvelope,
} from "../provenance";

export class RuntimeService {
  readonly core: KnowledgeService;
  readonly imports: ImportService;
  constructor(
    readonly pool: Pool,
    readonly model: ModelCall = callModel,
  ) {
    this.core = new KnowledgeService(pool);
    this.imports = new ImportService(pool, this);
  }
  async view(db: PoolClient, ctx: Context) {
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
    return { state: filtered, fingerprint };
  }
  async snapshot(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, (db) => this.view(db, ctx));
  }
  async sources(ctx: Context) {
    return (await this.snapshot(ctx)).state.sources;
  }
  async pages(ctx: Context) {
    return (await this.snapshot(ctx)).state.pages.map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary,
      scope: p.scope,
      version: current(p).number,
      content: current(p).content,
    }));
  }
  async changesets(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
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
  ): Promise<T> {
    const id = randomUUID();
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
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
  async ingest(ctx: Context, sourceIds: string[], mode: Mode) {
    return this.job(ctx, "ingest", async () => {
      const { state, fingerprint } = await this.snapshot(ctx);
      await transaction(this.pool, ctx.workspaceId, async (db) => {
        if ((await membership(db, ctx)) === "reader") throw Error("FORBIDDEN");
      });
      const sources = sourceIds.map((id) =>
        state.sources.find((s) => s.id === id),
      );
      if (sources.some((s) => !s)) throw Error("NOT_FOUND");
      if (sources.some((s) => s!.scope === "private"))
        throw Error("SOURCE_SCOPE_CONFLICT");
      let updates: Draft[];
      let dependencyIds: string[] = [];
      let inputEnvelope: InputEnvelope | undefined;
      if (mode === "model") {
        if (new Set(sources.map((s) => s!.scope)).size !== 1)
          throw Error("SOURCE_SCOPE_CONFLICT");
        const contextPages = state.pages.filter(
          (p) => p.scope === sources[0]!.scope,
        );
        dependencyIds = contextPages.map((p) => p.id);
        inputEnvelope = await transaction(this.pool, ctx.workspaceId, (db) =>
          captureEnvelope(db, ctx, state, dependencyIds, sourceIds),
        );
        const data = await this.model("ingest", {
          sources,
          pages: contextPages.map((p) => ({
            ...p,
            versions: undefined,
            content: current(p).content,
            baseVersion: current(p).number,
          })),
        });
        updates = drafts.parse((data as { updates: unknown }).updates);
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
      if (mode === "model") await ctx.authorization?.revalidate();
      const result = await propose(
        this.pool,
        ctx,
        drafts.parse(updates),
        sourceIds,
        {
          expectedStateHash: fingerprint,
          mode,
          dependencyIds,
          inputEnvelope,
          requestAuthorizationPending:
            mode === "model" && Boolean(ctx.authorization),
        },
      );
      if (mode === "model" && ctx.authorization)
        await this.releaseAuthorizedResult(ctx, "batch", result.id);
      return result;
    });
  }
  async query(ctx: Context, question: string, mode: Mode) {
    return this.job(ctx, "query", async () => {
      const { state, envelope } = await transaction(
        this.pool,
        ctx.workspaceId,
        async (db) => {
          const { state } = await this.view(db, ctx);
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
        const data = answerOutput.parse(
          await this.model("query", {
            question,
            pages: pages.map((p) => ({
              id: p.id,
              title: p.title,
              version: current(p).number,
              content: current(p).content,
            })),
          }),
        );
        answer = {
          ...data,
          id: randomUUID(),
          question,
          mode,
          at: new Date().toISOString(),
        };
      } else answer = answerOffline(state, question);
      if (mode === "model") await ctx.authorization?.revalidate();
      await transaction(this.pool, ctx.workspaceId, async (db) => {
        if (mode === "model") await ctx.authorization?.assertSession(db);
        const fresh = (await this.view(db, ctx)).state;
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
        saveAnswer(fresh, answer);
        await db.query("INSERT INTO runtime_answers VALUES($1,$2,$3,$4)", [
          ctx.workspaceId,
          answer.id,
          ctx.principalId,
          {
            ...answer,
            inputEnvelope: envelope,
            ...(mode === "model" && ctx.authorization
              ? { requestAuthorizationPending: true }
              : {}),
          },
        ]);
        await audit(db, ctx, "query", answer.id);
      });
      if (mode === "model" && ctx.authorization)
        await this.releaseAuthorizedResult(ctx, "answer", answer.id);
      return answer;
    });
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
        dependencyIds:
          answer.inputEnvelope?.pageIds ??
          answer.citations.map((c) => c.pageId),
        inputEnvelope: answer.inputEnvelope,
        answerId: answer.id,
      },
    );
  }
  async lint(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const { state } = await this.view(db, ctx);
      const data = { issues: lintWiki(state) };
      await db.query(
        "INSERT INTO runtime_lints VALUES($1,$2,$3) ON CONFLICT(workspace_id,principal_id) DO UPDATE SET data=excluded.data",
        [ctx.workspaceId, ctx.principalId, data],
      );
      await audit(db, ctx, "lint", "workspace");
      return data;
    });
  }
  async jobs(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
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
