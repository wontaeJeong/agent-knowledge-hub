import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type { State } from "../../src/domain/types";
import type { Answer } from "../../src/domain/wiki";
import type { RuntimeExecution, RuntimeService } from "../runtime/knowledge";
import { transaction } from "../database";
import { membership, audit } from "../repository";
import { authorizeActionDb, type Action } from "../access/index";
import {
  assertEnvelope,
  captureEnvelope,
  fingerprint,
  type InputEnvelope,
} from "../provenance";
import { sourcePolicyHash } from "../policy/model";
import { assertFeature } from "../policy/features";
import { ScopedSearch, type MetadataReader } from "./search";
import { QuestionFeedback } from "./feedback";
import { assertQuestionWritesNotErased } from "./erasure-fence";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const turnInput = z
  .object({
    expectedRevision: z.union([z.number().int().nonnegative(), z.string().regex(/^[a-f0-9]{64}$/)]),
    nonce: id,
    question: z.string().trim().min(1).max(20000),
    mode: z.enum(["offline", "model"]),
    sourceRefs: z.array(id).max(200).default([]),
  })
  .strict();
const ids = z.object({ threadId: id, turnId: id }).strict();
const preparedInput = z
  .object({
    threadId: id,
    turnId: id,
    sealHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(["offline", "model"]),
  })
  .strict();
type Message = { role: "user" | "assistant"; content: string };
/** Trusted callbacks, constructed only by the host. Never a public DTO. */
export interface TrustedQuestionContext {
  resolve(
    db: PoolClient,
    state: State,
  ): Promise<{ messages: Message[]; pageIds: string[]; sourceIds: string[] }>;
  onCreated(db: PoolClient, answer: Answer): Promise<void>;
}
export type QuestionRunner = (
  ctx: Context,
  question: string,
  mode: "offline" | "model",
  execution: RuntimeExecution,
  context: TrustedQuestionContext,
) => Promise<Answer>;
export type QuestionAuthorizer = (
  db: PoolClient,
  ctx: Context,
  action: Action,
  resource?: { kind: "page" | "source"; id: string },
) => Promise<void>;
type History = {
  turnId: string;
  answerId: string;
  answerVersion: 1;
  hash: string;
  envelope: InputEnvelope;
};
type Seal = {
  revision: number;
  envelope: InputEnvelope;
  history: History[];
  policyHash: string;
  contextOmitted: boolean;
};
type Turn = {
  id: string;
  thread_id: string;
  principal_id: string;
  ordinal: number;
  nonce: string;
  request_hash: string;
  question: string;
  mode: "offline" | "model";
  status: "pending" | "completed";
  sealed: Seal;
  answer_id: string | null;
  job_id: string | null;
};
const denied = (error: unknown) => {
  if (!(
    error instanceof Error &&
    [
      "NOT_FOUND",
      "FORBIDDEN",
      "STALE_VERSION",
      "MODEL_TRANSMISSION_DENIED",
      "FEATURE_DISABLED",
    ].includes(error.message)
  ))
    throw error;
};
export class QuestionsService {
  private readonly continuationKey = randomBytes(32);
  private readonly cursors = new Map<
    string,
    {
      workspace: string;
      principal: string;
      thread: string;
      revision: number;
      before: number;
      expires: number;
    }
  >();
  private async continuation(
    db: PoolClient,
    ctx: Context,
    thread: { id: string; revision: number },
  ) {
    const rows = await db.query(
      `SELECT count(*)::int AS count, encode(sha256(convert_to(COALESCE(string_agg(part, '|' ORDER BY part), ''), 'UTF8')), 'hex') AS digest FROM (
      SELECT 'p:' || p.id || ':' || encode(sha256(convert_to(p.data::text,'UTF8')),'hex') || ':' || COALESCE((SELECT string_agg(r.principal_id,',' ORDER BY r.principal_id) FROM resource_readers r WHERE r.workspace_id=p.workspace_id AND r.kind='page' AND r.resource_id=p.id),'') AS part FROM pages p WHERE p.workspace_id=$1 AND EXISTS (SELECT 1 FROM resource_readers r WHERE r.workspace_id=p.workspace_id AND r.kind='page' AND r.resource_id=p.id AND r.principal_id=$2)
      UNION ALL SELECT 's:' || s.id || ':' || encode(sha256(convert_to(s.data::text,'UTF8')),'hex') || ':' || COALESCE((SELECT string_agg(r.principal_id,',' ORDER BY r.principal_id) FROM resource_readers r WHERE r.workspace_id=s.workspace_id AND r.kind='source' AND r.resource_id=s.id),'') FROM sources s WHERE s.workspace_id=$1 AND EXISTS (SELECT 1 FROM resource_readers r WHERE r.workspace_id=s.workspace_id AND r.kind='source' AND r.resource_id=s.id AND r.principal_id=$2)
      UNION ALL SELECT 'v:' || v.page_id || ':' || v.number || ':' || encode(sha256(convert_to(v.data::text,'UTF8')),'hex') FROM versions v WHERE v.workspace_id=$1 AND EXISTS (SELECT 1 FROM resource_readers r WHERE r.workspace_id=v.workspace_id AND r.kind='page' AND r.resource_id=v.page_id AND r.principal_id=$2)
    LIMIT 10001) AS visible`,
      [ctx.workspaceId, ctx.principalId],
    );
    if (rows.rows[0].count > 10000) throw Error("QUESTION_HISTORY_LIMIT");
    return createHmac("sha256", this.continuationKey)
      .update(
        fingerprint({
          workspace: ctx.workspaceId,
          principal: ctx.principalId,
          thread: thread.id,
          revision: thread.revision,
          visible: rows.rows[0].digest,
        }),
      )
      .digest("hex");
  }
  private submit?: (
    ctx: Context,
    payload: { threadId: string; turnId: string },
    key: string,
  ) => Promise<{ id: string; status: string }>;
  readonly searcher: ScopedSearch;
  readonly reports: QuestionFeedback;
  constructor(
    readonly pool: Pool,
    readonly options: {
      authorize: QuestionAuthorizer;
      runtime: RuntimeService;
      runQuery: QuestionRunner;
      versionMetadata?: MetadataReader;
    },
  ) {
    if (!options.authorize || !options.runQuery)
      throw Error("QUESTIONS_NOT_CONFIGURED");
    this.searcher = new ScopedSearch(pool, options);
    this.reports = new QuestionFeedback(pool, options, async (db, ctx) =>
      this.guard(db, ctx),
    );
  }
  setSubmit(submit: NonNullable<QuestionsService["submit"]>) {
    this.submit = submit;
  }
  async guard(db: PoolClient, ctx: Context) {
    await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await authorizeActionDb(db, ctx, "knowledge.read");
    await this.options.authorize(db, ctx, "knowledge.read");
    await assertFeature(db, ctx, "query");
  }
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.guard(db, ctx);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async thread(db: PoolClient, ctx: Context, threadId: string) {
    id.parse(threadId);
    const row = (
      await db.query(
        "SELECT * FROM question_threads WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 FOR UPDATE",
        [ctx.workspaceId, threadId, ctx.principalId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    return row as { id: string; revision: number; created_at: Date };
  }
  private async turn(
    db: PoolClient,
    ctx: Context,
    threadId: string,
    turnId: string,
  ) {
    await this.thread(db, ctx, threadId);
    id.parse(turnId);
    const row = (
      await db.query(
        "SELECT * FROM question_turns WHERE workspace_id=$1 AND thread_id=$2 AND id=$3 AND principal_id=$4 FOR UPDATE",
        [ctx.workspaceId, threadId, turnId, ctx.principalId],
      )
    ).rows[0];
    if (!row) throw Error("NOT_FOUND");
    return row as Turn;
  }
  private policy(db: PoolClient, ctx: Context, envelope: InputEnvelope) {
    return sourcePolicyHash(db, ctx, envelope).then((policy) =>
      fingerprint({
        policy,
        endpoint: process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL ?? null,
        model: process.env.AGENT_KNOWLEDGE_HUB_LLM_MODEL ?? null,
      }),
    );
  }
  private async qualified(
    db: PoolClient,
    ctx: Context,
    envelope: InputEnvelope,
  ) {
    for (const p of envelope.pageIds)
      await this.options.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: p,
      });
    for (const s of envelope.sourceIds)
      await this.options.authorize(db, ctx, "knowledge.read", {
        kind: "source",
        id: s,
      });
  }
  private async valid(db: PoolClient, ctx: Context, state: State, turn: Turn) {
    await assertEnvelope(db, ctx, state, turn.sealed.envelope);
    await this.qualified(db, ctx, turn.sealed.envelope);
    if (
      (await this.policy(db, ctx, turn.sealed.envelope)) !==
      turn.sealed.policyHash
    )
      throw Error("STALE_VERSION");
  }
  private async answer(db: PoolClient, ctx: Context, answerId: string) {
    const data = (
      await db.query(
        "SELECT data FROM runtime_answers WHERE workspace_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.principalId, answerId],
      )
    ).rows[0]?.data;
    if (!data || data.requestAuthorizationPending || !data.inputEnvelope)
      throw Error("NOT_FOUND");
    return data as Answer & { inputEnvelope: InputEnvelope };
  }
  async createThread(ctx: Context) {
    return this.run(ctx, async (db) => {
      await assertQuestionWritesNotErased(db, ctx.workspaceId);
      const threadId = randomUUID();
      await db.query(
        "INSERT INTO question_threads(workspace_id,id,principal_id) VALUES($1,$2,$3)",
        [ctx.workspaceId, threadId, ctx.principalId],
      );
      return { id: threadId, revision: 0 };
    });
  }
  async listThreads(ctx: Context, raw: unknown = {}) {
    const page = z
      .object({
        cursor: id.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(raw);
    return this.run(ctx, async (db) => {
      const rows = page.cursor
        ? (
            await db.query(
              "SELECT id FROM question_threads WHERE workspace_id=$1 AND principal_id=$2 AND (created_at,id) > ((SELECT created_at FROM question_threads WHERE workspace_id=$1 AND principal_id=$2 AND id=$3),$3) ORDER BY created_at,id LIMIT $4",
              [ctx.workspaceId, ctx.principalId, page.cursor, page.limit + 1],
            )
          ).rows
        : (
            await db.query(
              "SELECT id FROM question_threads WHERE workspace_id=$1 AND principal_id=$2 ORDER BY created_at,id LIMIT $3",
              [ctx.workspaceId, ctx.principalId, page.limit + 1],
            )
          ).rows;
      return {
        // Never inspect histories for listing; null is not an optimistic-lock revision.
        items: rows
          .slice(0, page.limit)
          .map((row) => ({ id: row.id, revision: null })),
        nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
      };
    });
  }
  async readThread(ctx: Context, threadId: string, cursor?: string) {
    return this.run(ctx, (db) =>
      this.readThreadInTransaction(db, ctx, threadId, cursor),
    );
  }
  private async assertScopeBudget(
    db: PoolClient,
    ctx: Context,
    scope: { pageIds: string[]; sourceIds: string[] },
  ) {
    if (scope.pageIds.length + scope.sourceIds.length > 64)
      throw Error("QUESTION_HISTORY_LIMIT");
    const sizes = (
      await db.query(
        `SELECT octet_length(data::text) AS bytes FROM pages WHERE workspace_id=$1 AND id=ANY($2::text[]) UNION ALL SELECT octet_length(data::text) FROM versions WHERE workspace_id=$1 AND page_id=ANY($2::text[]) UNION ALL SELECT octet_length(data::text) FROM sources WHERE workspace_id=$1 AND id=ANY($3::text[]) LIMIT 129`,
        [ctx.workspaceId, scope.pageIds, scope.sourceIds],
      )
    ).rows as { bytes: number }[];
    if (
      sizes.length > 128 ||
      sizes.some((r) => r.bytes > 262144) ||
      sizes.reduce((sum, r) => sum + r.bytes, 0) > 2097152
    )
      throw Error("QUESTION_HISTORY_LIMIT");
  }
  private async readThreadInTransaction(
    db: PoolClient,
    ctx: Context,
    threadId: string,
    cursor?: string,
  ) {
    const thread = await this.thread(db, ctx, threadId);
    let before = 2147483647;
    if (cursor) {
      const item = this.cursors.get(cursor);
      if (
        !item ||
        item.expires < Date.now() ||
        item.workspace !== ctx.workspaceId ||
        item.principal !== ctx.principalId ||
        item.thread !== threadId ||
        item.revision !== thread.revision
      )
        throw Error("STALE_CURSOR");
      before = item.before;
    }
    const sizes = (
      await db.query(
        `SELECT q.id,q.ordinal,octet_length(q.question)+octet_length(q.sealed::text)+COALESCE(octet_length(a.data::text),0) AS bytes FROM (SELECT id,ordinal,question,sealed,answer_id FROM question_turns WHERE workspace_id=$1 AND thread_id=$2 AND principal_id=$3 AND ordinal<$4 ORDER BY ordinal DESC LIMIT 21) q LEFT JOIN runtime_answers a ON a.workspace_id=$1 AND a.principal_id=$3 AND a.id=q.answer_id ORDER BY q.ordinal DESC`,
        [ctx.workspaceId, threadId, ctx.principalId, before],
      )
    ).rows as { id: string; ordinal: number; bytes: number }[];
    let hasMore = sizes.length > 20;
    const page = sizes.slice(0, 20);
    if (page[0]?.bytes > 65536) throw Error("QUESTION_HISTORY_LIMIT");
    let bytes = 0;
    let count = 0;
    for (const row of page) {
      if (row.bytes > 65536 || bytes + row.bytes > 262144) break;
      bytes += row.bytes;
      count++;
    }
    if (count < page.length) {
      page.splice(count);
      hasMore = true;
    }
    const rows = (
      await db.query(
        "SELECT id,thread_id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed,answer_id,job_id FROM question_turns WHERE workspace_id=$1 AND thread_id=$2 AND principal_id=$3 AND id=ANY($4::text[]) ORDER BY ordinal",
        [ctx.workspaceId, threadId, ctx.principalId, page.map((row) => row.id)],
      )
    ).rows as Turn[];
    const pages = new Set<string>(),
      sources = new Set<string>();
    let processed = 0;
    for (const turn of [...rows].reverse()) {
      const envelopes = [turn.sealed.envelope];
      if (turn.answer_id)
        envelopes.push(
          (await this.answer(db, ctx, turn.answer_id)).inputEnvelope,
        );
      const nextPages = new Set(pages),
        nextSources = new Set(sources);
      for (const env of envelopes) {
        if (
          !env ||
          !Array.isArray(env.pageIds) ||
          !Array.isArray(env.sourceIds)
        )
          throw Error("QUESTION_HISTORY_LIMIT");
        for (const id of env.pageIds) nextPages.add(id);
        for (const id of env.sourceIds) nextSources.add(id);
      }
      if (nextPages.size + nextSources.size > 64) {
        if (!processed) throw Error("QUESTION_HISTORY_LIMIT");
        const index = rows.indexOf(turn);
        rows.splice(0, index + 1);
        page.splice(rows.length);
        hasMore = true;
        break;
      }
      for (const id of nextPages) pages.add(id);
      for (const id of nextSources) sources.add(id);
      processed++;
    }
    const scope = { pageIds: [...pages], sourceIds: [...sources] };
    await this.assertScopeBudget(db, ctx, scope);
    const result = await this.renderThread(
      db,
      ctx,
      thread,
      rows,
      async () =>
        (await this.options.runtime.view(db, ctx, undefined, scope)).state,
      !!cursor || hasMore,
    );
    let nextCursor: string | null = null;
    if (hasMore) {
      if (this.cursors.size >= 1000)
        this.cursors.delete(this.cursors.keys().next().value!);
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, {
        workspace: ctx.workspaceId,
        principal: ctx.principalId,
        thread: threadId,
        revision: thread.revision,
        before: page[page.length - 1].ordinal,
        expires: Date.now() + 900000,
      });
    }
    return { ...result, nextCursor };
  }
  private async renderThread(
    db: PoolClient,
    ctx: Context,
    thread: { id: string; revision: number },
    rows: Turn[],
    loadState: () => Promise<State>,
    paginated = false,
  ) {
    const turns = [];
    let contextOmitted = false;
    const roots = new Set<string>();
    const consume = (envelope: InputEnvelope) => {
      if (
        !envelope ||
        !Array.isArray(envelope.pageIds) ||
        !Array.isArray(envelope.sourceIds)
      )
        throw Error("QUESTION_HISTORY_LIMIT");
      for (const id of envelope.pageIds) roots.add("page:" + id);
      for (const id of envelope.sourceIds) roots.add("source:" + id);
      if (roots.size > 64) throw Error("QUESTION_HISTORY_LIMIT");
    };
    const state = rows.length ? await loadState() : undefined;
    for (const turn of rows) {
      try {
        consume(turn.sealed.envelope);
        await this.valid(db, ctx, state!, turn);
        const answer = turn.answer_id
          ? await this.answer(db, ctx, turn.answer_id)
          : null;
        if (answer) {
          consume(answer.inputEnvelope);
          await assertEnvelope(db, ctx, state!, answer.inputEnvelope);
        }
        turns.push({
          id: turn.id,
          ordinal: turn.ordinal,
          question: turn.question,
          mode: turn.mode,
          status: turn.status,
          jobId: turn.job_id,
          answer: answer
            ? {
                id: answer.id,
                version: 1,
                content: answer.content,
                citations: answer.citations,
                insufficient: answer.insufficient,
              }
            : null,
        });
      } catch (e) {
        denied(e);
        contextOmitted = true;
      }
    }
    return {
      id: thread.id,
      revision: contextOmitted || paginated ? null : thread.revision,
      ...(contextOmitted || paginated
        ? { continuation: await this.continuation(db, ctx, thread) }
        : {}),
      title: turns[0]?.question.slice(0, 80) ?? "접근 가능한 대화 없음",
      turns:
        contextOmitted || paginated
          ? turns.map((turn) => ({ ...turn, ordinal: null }))
          : turns,
      contextOmitted,
    };
  }
  async acceptTurn(ctx: Context, threadId: string, raw: unknown) {
    const input = turnInput.parse(raw);
    return this.run(ctx, async (db) => {
      await assertQuestionWritesNotErased(db, ctx.workspaceId);
      const thread = await this.thread(db, ctx, threadId);
      const requestHash = fingerprint(input);
      const previous = (
        await db.query(
          "SELECT * FROM question_turns WHERE workspace_id=$1 AND thread_id=$2 AND principal_id=$3 AND nonce=$4",
          [ctx.workspaceId, threadId, ctx.principalId, input.nonce],
        )
      ).rows[0] as Turn | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return this.acceptance(previous);
      }
      const state = (await this.options.runtime.view(db, ctx)).state;
      if (
        typeof input.expectedRevision === "number"
          ? thread.revision !== input.expectedRevision
          : !timingSafeEqual(
              Buffer.from(input.expectedRevision, "hex"),
              Buffer.from(await this.continuation(db, ctx, thread), "hex"),
            )
      )
        throw Error("STALE_VERSION");
      if (
        (
          await db.query(
            "SELECT 1 FROM question_turns t LEFT JOIN durable_jobs j ON j.workspace_id=t.workspace_id AND j.id=t.job_id AND j.principal_id=t.principal_id WHERE t.workspace_id=$1 AND t.thread_id=$2 AND t.status='pending' AND (j.id IS NULL OR j.status NOT IN ('dead','cancelled'))",
            [ctx.workspaceId, threadId],
          )
        ).rowCount
      )
        throw Error("TURN_PENDING");
      for (const sourceId of input.sourceRefs) {
        await authorizeActionDb(db, ctx, "knowledge.read", {
          kind: "source",
          id: sourceId,
        });
        await this.options.authorize(db, ctx, "knowledge.read", {
          kind: "source",
          id: sourceId,
        });
        if (!state.sources.some((s) => s.id === sourceId))
          throw Error("NOT_FOUND");
      }
      // Raw user text may contain copied protected quotes. Bind to the complete actual view,
      // not an untrusted caller's dependency subset. This is conservative, not DLP proof.
      const envelope = await captureEnvelope(
        db,
        ctx,
        state,
        state.pages.map((p) => p.id),
        state.sources.map((s) => s.id),
      );
      await this.qualified(db, ctx, envelope);
      const admittedScope = {
        pageIds: envelope.pageIds,
        sourceIds: envelope.sourceIds,
      };
      await this.assertScopeBudget(db, ctx, admittedScope);
      await this.options.runtime.view(db, ctx, undefined, admittedScope);
      const history: History[] = [];
      let contextOmitted = false;
      const recent = (
        await db.query(
          "SELECT * FROM question_turns WHERE workspace_id=$1 AND thread_id=$2 AND principal_id=$3 ORDER BY ordinal DESC LIMIT 21",
          [ctx.workspaceId, threadId, ctx.principalId],
        )
      ).rows as Turn[];
      if (recent.length > 20) contextOmitted = true;
      const prior = recent.slice(0, 20).reverse();
      for (const turn of prior) {
        try {
          await this.valid(db, ctx, state, turn);
          if (!turn.answer_id) continue;
          const answer = await this.answer(db, ctx, turn.answer_id);
          await assertEnvelope(db, ctx, state, answer.inputEnvelope);
          history.push({
            turnId: turn.id,
            answerId: answer.id,
            answerVersion: 1,
            hash: fingerprint({ question: turn.question, answer }),
            envelope: answer.inputEnvelope,
          });
        } catch (e) {
          denied(e);
          contextOmitted = true;
        }
      }
      if (history.length > 100) throw Error("CONTEXT_LIMIT");
      if (contextOmitted && typeof input.expectedRevision === "number")
        throw Error("STALE_VERSION");
      const seal: Seal = {
        revision: thread.revision + 1,
        envelope,
        history,
        contextOmitted,
        policyHash: await this.policy(db, ctx, envelope),
      };
      if (
        Buffer.byteLength(JSON.stringify(seal)) +
          Buffer.byteLength(input.question) >
        30000
      )
        throw Error("QUESTION_HISTORY_LIMIT");
      const turnId = randomUUID();
      const row = (
        await db.query(
          "INSERT INTO question_turns(workspace_id,thread_id,id,principal_id,ordinal,nonce,request_hash,question,mode,status,sealed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10) RETURNING *",
          [
            ctx.workspaceId,
            threadId,
            turnId,
            ctx.principalId,
            seal.revision,
            input.nonce,
            requestHash,
            input.question,
            input.mode,
            seal,
          ],
        )
      ).rows[0] as Turn;
      const changed = await db.query(
        "UPDATE question_threads SET revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND revision=$4",
        [ctx.workspaceId, threadId, ctx.principalId, thread.revision],
      );
      if (changed.rowCount !== 1) throw Error("STALE_VERSION");
      await audit(db, ctx, "question.accept", turnId);
      return this.acceptance(row);
    });
  }
  private acceptance(turn: Turn) {
    return {
      threadId: turn.thread_id,
      turnId: turn.id,
      revision: turn.sealed.revision,
      status: turn.status,
      contextOmitted: turn.sealed.contextOmitted,
    };
  }
  async submitTurn(ctx: Context, threadId: string, raw: unknown) {
    if (!this.submit) throw Error("QUESTION_QUEUE_NOT_CONFIGURED");
    const accepted = await this.acceptTurn(ctx, threadId, raw);
    return this.resumeTurn(ctx, threadId, accepted.turnId);
  }
  async resumeTurn(ctx: Context, threadId: string, turnId: string) {
    if (!this.submit) throw Error("QUESTION_QUEUE_NOT_CONFIGURED");
    await this.run(ctx, async (db) => {
      await assertQuestionWritesNotErased(db, ctx.workspaceId);
      const turn = await this.turn(db, ctx, threadId, turnId);
      await this.valid(
        db,
        ctx,
        (await this.options.runtime.view(db, ctx)).state,
        turn,
      );
    });
    const receipt = await this.submit(
      ctx,
      { threadId, turnId },
      `question:${turnId}`,
    );
    await this.run(ctx, async (db) => {
      await assertQuestionWritesNotErased(db, ctx.workspaceId);
      const turn = await this.turn(db, ctx, threadId, turnId);
      if (turn.job_id && turn.job_id !== receipt.id)
        throw Error("IDEMPOTENCY_CONFLICT");
      await db.query(
        "UPDATE question_turns SET job_id=$4 WHERE workspace_id=$1 AND thread_id=$2 AND id=$3 AND principal_id=$5",
        [ctx.workspaceId, threadId, turnId, receipt.id, ctx.principalId],
      );
    });
    return receipt;
  }
  questionJobAdapter() {
    return {
      prepare: async (db: PoolClient, ctx: Context, raw: unknown) => {
        await this.guard(db, ctx);
        await assertQuestionWritesNotErased(db, ctx.workspaceId);
        const input = preparedInput.safeParse(raw);
        const ref = input.success ? input.data : ids.parse(raw);
        const turn = await this.turn(db, ctx, ref.threadId, ref.turnId);
        if (!input.success && turn.status !== "pending")
          throw Error("TURN_ALREADY_COMPLETED");
        const thread = await this.thread(db, ctx, ref.threadId);
        if (
          turn.status === "pending" &&
          thread.revision !== turn.sealed.revision
        )
          throw Error("STALE_VERSION");
        const state = (await this.options.runtime.view(db, ctx)).state;
        await this.resolve(db, ctx, state, turn);
        const payload = {
          threadId: ref.threadId,
          turnId: ref.turnId,
          mode: turn.mode,
          sealHash: fingerprint(turn.sealed),
        };
        if (input.success && fingerprint(payload) !== fingerprint(input.data))
          throw Error("STALE_VERSION");
        return {
          payload,
          pageIds: turn.sealed.envelope.pageIds,
          sourceIds: turn.sealed.envelope.sourceIds,
        };
      },
      execute: async (
        ctx: Context,
        raw: Record<string, unknown>,
        execution: RuntimeExecution,
      ) => {
        const input = preparedInput.parse(raw);
        const turn = await this.run(ctx, async (db) => {
          const t = await this.turn(db, ctx, input.threadId, input.turnId);
          if (input.sealHash !== fingerprint(t.sealed) || input.mode !== t.mode)
            throw Error("STALE_VERSION");
          await this.resolve(
            db,
            ctx,
            (await this.options.runtime.view(db, ctx)).state,
            t,
          );
          return t;
        });
        return this.options.runQuery(ctx, turn.question, turn.mode, execution, {
          resolve: async (db, state) => {
            await this.guard(db, ctx);
            await assertQuestionWritesNotErased(db, ctx.workspaceId);
            const fresh = await this.turn(
              db,
              ctx,
              input.threadId,
              input.turnId,
            );
            if (fingerprint(fresh.sealed) !== input.sealHash)
              throw Error("STALE_VERSION");
            return this.resolve(db, ctx, state, fresh);
          },
          onCreated: async (db, answer) => {
            await this.guard(db, ctx);
            await assertQuestionWritesNotErased(db, ctx.workspaceId);
            const fresh = await this.turn(
              db,
              ctx,
              input.threadId,
              input.turnId,
            );
            await this.resolve(
              db,
              ctx,
              (await this.options.runtime.view(db, ctx)).state,
              fresh,
            );
            if (fresh.status !== "pending") throw Error("STALE_VERSION");
            const stored = await this.answer(db, ctx, answer.id);
            if (
              Buffer.byteLength(JSON.stringify(fresh.sealed)) +
                Buffer.byteLength(fresh.question) +
                Buffer.byteLength(JSON.stringify(stored)) >
              55000
            )
              throw Error("QUESTION_HISTORY_LIMIT");
            if (stored.id !== answer.id || stored.question !== turn.question)
              throw Error("ANSWER_SCOPE_CONFLICT");
            if (
              fingerprint(stored.inputEnvelope) !==
              fingerprint(turn.sealed.envelope)
            )
              throw Error("ANSWER_SCOPE_CONFLICT");
            for (const p of turn.sealed.envelope.pageIds)
              if (
                stored.inputEnvelope.pages[p] !== turn.sealed.envelope.pages[p]
              )
                throw Error("ANSWER_SCOPE_CONFLICT");
            for (const s of turn.sealed.envelope.sourceIds)
              if (
                stored.inputEnvelope.sources[s] !==
                turn.sealed.envelope.sources[s]
              )
                throw Error("ANSWER_SCOPE_CONFLICT");
            const changed = await db.query(
              "UPDATE question_turns SET status='completed',answer_id=$4,answer_version=1 WHERE workspace_id=$1 AND thread_id=$2 AND id=$3 AND principal_id=$5 AND status='pending'",
              [
                ctx.workspaceId,
                input.threadId,
                input.turnId,
                answer.id,
                ctx.principalId,
              ],
            );
            if (changed.rowCount !== 1) throw Error("STALE_VERSION");
            await audit(db, ctx, "question.complete", turn.id);
          },
        });
      },
    };
  }
  private async resolve(
    db: PoolClient,
    ctx: Context,
    state: State,
    turn: Turn,
  ) {
    const thread = await this.thread(db, ctx, turn.thread_id);
    if (turn.status === "pending" && thread.revision !== turn.sealed.revision)
      throw Error("STALE_VERSION");
    await this.valid(db, ctx, state, turn);
    const messages: Message[] = [];
    for (const h of turn.sealed.history) {
      const prior = await this.turn(db, ctx, turn.thread_id, h.turnId);
      if (
        prior.status !== "completed" ||
        prior.ordinal >= turn.ordinal ||
        prior.answer_id !== h.answerId
      )
        throw Error("STALE_VERSION");
      await this.valid(db, ctx, state, prior);
      const answer = await this.answer(db, ctx, h.answerId);
      await assertEnvelope(db, ctx, state, h.envelope);
      await assertEnvelope(db, ctx, state, answer.inputEnvelope);
      if (fingerprint({ question: prior.question, answer }) !== h.hash)
        throw Error("STALE_VERSION");
      messages.push(
        { role: "user", content: prior.question },
        { role: "assistant", content: answer.content },
      );
    }
    if (Buffer.byteLength(JSON.stringify(messages)) > 200000)
      throw Error("CONTEXT_LIMIT");
    return {
      messages,
      pageIds: turn.sealed.envelope.pageIds,
      sourceIds: turn.sealed.envelope.sourceIds,
    };
  }
  search(ctx: Context, raw: unknown = {}) {
    return this.searcher.search(ctx, raw);
  }
  reportFeedback(ctx: Context, raw: unknown) {
    return this.reports.report(ctx, raw);
  }
  feedback(ctx: Context, raw: unknown = {}) {
    return this.reports.list(ctx, raw);
  }
}
