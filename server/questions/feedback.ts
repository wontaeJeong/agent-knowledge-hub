import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import { transaction } from "../database";
import { assertEnvelope, fingerprint, type InputEnvelope } from "../provenance";
import { current } from "../../src/domain/wiki";
import type { Answer } from "../../src/domain/wiki";
import type { State } from "../../src/domain/types";
import type { RuntimeService } from "../runtime/knowledge";
import { authorizeActionDb } from "../access/index";
import { audit } from "../repository";
import type { QuestionAuthorizer } from "./service";
import { assertQuestionWritesNotErased } from "./erasure-fence";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const reportInput = z
  .object({
    answerId: id,
    version: z.literal(1),
    nonce: id,
    category: z.enum(["incorrect", "citationmissing", "exposure"]),
    reason: z.string().trim().min(1).max(5000),
  })
  .strict();
type Work = {
  pageId: string;
  version: number;
  ownerRevision: number | null;
  recipientIds: string[];
  status: "pending" | "pending-unassigned";
  evidenceKeys: {
    pageId: string;
    version: number;
    sourceIds: string[];
    citationIndexes: number[];
  };
};
type Saved = Answer & {
  inputEnvelope: InputEnvelope;
  requestAuthorizationPending?: boolean;
};
export class QuestionFeedback {
  constructor(
    readonly pool: Pool,
    readonly options: {
      authorize: QuestionAuthorizer;
      runtime: RuntimeService;
    },
    readonly guard: (db: PoolClient, ctx: Context) => Promise<void>,
  ) {}
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.guard(db, ctx);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async check(
    db: PoolClient,
    ctx: Context,
    state: State,
    envelope: InputEnvelope,
  ) {
    await assertEnvelope(db, ctx, state, envelope);
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
  private async answer(
    db: PoolClient,
    ctx: Context,
    answerId: string,
    state: State,
  ) {
    const row = (
      await db.query(
        "SELECT principal_id,data FROM runtime_answers WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, answerId],
      )
    ).rows[0];
    const answer = row?.data as Saved | undefined;
    if (!answer || answer.requestAuthorizationPending || !answer.inputEnvelope)
      throw Error("NOT_FOUND");
    if (row.principal_id !== ctx.principalId) {
      // Only a real publication receipt permits reporting another author's answer.
      // Existence/title of private answer-* candidates is never sufficient.
      const published = state.pages.find((p) => p.id === `answer-${answerId}`);
      const version = published && current(published);
      if (!published || !version?.batchId) throw Error("NOT_FOUND");
      const receipt = (
        await db.query(
          "SELECT b.data FROM publications p JOIN batches b ON b.workspace_id=p.workspace_id AND b.id=p.batch_id WHERE p.workspace_id=$1 AND p.batch_id=$2",
          [ctx.workspaceId, version.batchId],
        )
      ).rows[0];
      if (receipt?.data.answerId !== answerId) throw Error("NOT_FOUND");
      await authorizeActionDb(db, ctx, "knowledge.read", {
        kind: "page",
        id: published.id,
      });
      await this.options.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: published.id,
      });
    }
    await this.check(db, ctx, state, answer.inputEnvelope);
    return answer;
  }
  async report(ctx: Context, raw: unknown) {
    const input = reportInput.parse(raw);
    return this.run(ctx, async (db) => {
      await assertQuestionWritesNotErased(db, ctx.workspaceId);
      const state = (await this.options.runtime.view(db, ctx)).state;
      const answer = await this.answer(db, ctx, input.answerId, state);
      const requestHash = fingerprint(input);
      const existing = (
        await db.query(
          "SELECT * FROM question_feedback WHERE workspace_id=$1 AND principal_id=$2 AND nonce=$3",
          [ctx.workspaceId, ctx.principalId, input.nonce],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        return this.result(db, ctx, existing.id, input.answerId);
      }
      const work: Work[] = [];
      for (const pageId of answer.inputEnvelope.pageIds) {
        const page = state.pages.find((p) => p.id === pageId);
        if (!page) throw Error("STALE_VERSION");
        const version = current(page);
        const owner = (
          await db.query(
            "SELECT * FROM governance_business_owners WHERE workspace_id=$1 AND page_id=$2 FOR SHARE",
            [ctx.workspaceId, pageId],
          )
        ).rows[0];
        const candidates: string[] = [];
        const activeOwner =
          owner &&
          (
            await db.query(
              "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
              [owner.owner_id],
            )
          ).rowCount;
        if (activeOwner) {
          candidates.push(owner.owner_id);
          if (version.batchId) {
            const assignment = (
              await db.query(
                "SELECT a.* FROM governance_review_assignments a JOIN batches b ON b.workspace_id=a.workspace_id AND b.id=a.batch_id AND b.hash=a.batch_hash WHERE a.workspace_id=$1 AND a.batch_id=$2 FOR SHARE OF a,b",
                [ctx.workspaceId, version.batchId],
              )
            ).rows[0];
            if (assignment)
              candidates.push(
                ...assignment.assignee_ids.filter(
                  (p: string) => !assignment.absent_ids.includes(p),
                ),
              );
          }
        }
        const recipientIds: string[] = [];
        for (const principalId of new Set(candidates)) {
          const recipient = { workspaceId: ctx.workspaceId, principalId };
          try {
            if (
              !(
                await db.query(
                  "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
                  [principalId],
                )
              ).rowCount
            )
              continue;
            if (principalId !== owner.owner_id) {
              await authorizeActionDb(db, recipient, "changeset.approve");
              await this.options.authorize(db, recipient, "changeset.approve");
              if (
                !(
                  await db.query(
                    "SELECT 1 FROM access_reviewers WHERE workspace_id=$1 AND principal_id=$2",
                    [ctx.workspaceId, principalId],
                  )
                ).rowCount
              )
                continue;
              const batch = (
                await db.query(
                  "SELECT b.data,a.principal_id AS author FROM batches b LEFT JOIN access_batch_authors a ON a.workspace_id=b.workspace_id AND a.batch_id=b.id WHERE b.workspace_id=$1 AND b.id=$2",
                  [ctx.workspaceId, version.batchId],
                )
              ).rows[0];
              if (
                !batch ||
                !batch.author ||
                [
                  batch.author,
                  batch.data.proposedBy,
                  batch.data.importAuthorId,
                ].includes(principalId)
              )
                continue;
              const rules = (
                await db.query(
                  "SELECT reviewer_ids FROM access_review_rules WHERE workspace_id=$1 AND (document_type=$2 OR (document_type='official-standard' AND $3='공식 기준'))",
                  [ctx.workspaceId, page.category, page.status],
                )
              ).rows;
              if (rules.some((r) => !r.reviewer_ids.includes(principalId)))
                continue;
            }
            await authorizeActionDb(db, recipient, "knowledge.read", {
              kind: "page",
              id: pageId,
            });
            await this.options.authorize(db, recipient, "knowledge.read", {
              kind: "page",
              id: pageId,
            });
            await this.check(db, recipient, state, answer.inputEnvelope);
            recipientIds.push(principalId);
          } catch (e) {
            if (!(
              e instanceof Error &&
              ["NOT_FOUND", "FORBIDDEN", "STALE_VERSION"].includes(e.message)
            ))
              throw e;
          }
        }
        const evidenceKeys = {
          pageId,
          version: version.number,
          sourceIds: [...version.sourceIds],
          citationIndexes: answer.citations.flatMap((c, i) =>
            c.pageId === pageId && c.version === version.number ? [i] : [],
          ),
        };
        work.push({
          pageId,
          version: version.number,
          ownerRevision: owner?.revision ?? null,
          recipientIds: recipientIds.sort(),
          status: recipientIds.length ? "pending" : "pending-unassigned",
          evidenceKeys,
        });
      }
      // Re-read after qualified routing callbacks. Claims never approve a document or
      // become independent execution evidence; exact input ancestry remains binding.
      await this.check(
        db,
        ctx,
        (await this.options.runtime.view(db, ctx)).state,
        answer.inputEnvelope,
      );
      const currentAnswer = await this.answer(
        db,
        ctx,
        input.answerId,
        (await this.options.runtime.view(db, ctx)).state,
      );
      if (fingerprint(currentAnswer) !== fingerprint(answer))
        throw Error("STALE_VERSION");
      const feedbackId = randomUUID();
      await db.query(
        "INSERT INTO question_feedback(workspace_id,id,principal_id,nonce,request_hash,answer_id,answer_version,category,reason,evidence,input_envelope) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
        [
          ctx.workspaceId,
          feedbackId,
          ctx.principalId,
          input.nonce,
          requestHash,
          input.answerId,
          input.category,
          input.reason,
          { citations: answer.citations, claim: true, verified: false },
          answer.inputEnvelope,
        ],
      );
      for (const w of work)
        await db.query(
          "INSERT INTO question_feedback_work(workspace_id,feedback_id,page_id,page_version,owner_revision,recipient_ids,status,evidence_keys) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ctx.workspaceId,
            feedbackId,
            w.pageId,
            w.version,
            w.ownerRevision,
            w.recipientIds,
            w.status,
            w.evidenceKeys,
          ],
        );
      await audit(db, ctx, "question.feedback", feedbackId);
      return this.result(db, ctx, feedbackId, input.answerId);
    });
  }
  private async result(
    db: PoolClient,
    ctx: Context,
    feedbackId: string,
    answerId: string,
  ) {
    const rows = (
      await db.query(
        "SELECT * FROM question_feedback_work WHERE workspace_id=$1 AND feedback_id=$2 ORDER BY page_id,page_version",
        [ctx.workspaceId, feedbackId],
      )
    ).rows;
    return {
      id: feedbackId,
      answerId,
      version: 1,
      claim: true,
      verified: false,
      work: rows.map((r) => ({
        pageId: r.page_id,
        version: r.page_version,
        ownerRevision: r.owner_revision,
        recipientIds: r.recipient_ids as string[],
        status: r.status,
        evidenceKeys: r.evidence_keys,
      })),
    };
  }
  async list(ctx: Context, raw: unknown = {}) {
    const input = z
      .object({
        cursor: id.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict()
      .parse(raw);
    return this.run(ctx, async (db) => {
      const state = (await this.options.runtime.view(db, ctx)).state;
      const rows = (
        await db.query(
          "SELECT f.* FROM question_feedback f WHERE workspace_id=$1 AND ($3::text IS NULL OR f.id>$3) AND (principal_id=$2 OR EXISTS(SELECT 1 FROM question_feedback_work w WHERE w.workspace_id=f.workspace_id AND w.feedback_id=f.id AND $2=ANY(w.recipient_ids))) ORDER BY f.id",
          [ctx.workspaceId, ctx.principalId, input.cursor ?? null],
        )
      ).rows;
      const items = [];
      for (const row of rows) {
        try {
          await this.check(db, ctx, state, row.input_envelope);
          items.push({
            category: row.category,
            reason: row.reason,
            ...(await this.result(db, ctx, row.id, row.answer_id)),
          });
          if (items.length > input.limit) break;
        } catch (e) {
          if (!(
            e instanceof Error &&
            ["NOT_FOUND", "FORBIDDEN", "STALE_VERSION"].includes(e.message)
          ))
            throw e;
        }
      }
      return {
        items: items.slice(0, input.limit),
        nextCursor:
          items.length > input.limit ? items[input.limit - 1].id : null,
      };
    });
  }
}
