import { z } from "zod";
import type {
  ImportRecord,
  ImportResult,
  ImportTopic,
} from "../../src/domain/imports";
import { statementKinds } from "../../src/domain/imports";
import type { ModelCall, ModelOptions } from "../runtime/model";
import { createHash } from "node:crypto";

const short = z.string().trim().min(1).max(2000);
export const topicSchema = z
  .object({
    key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    title: short,
    summary: short,
    content: z.string().trim().min(1).max(50_000),
    targetPageId: z.string().max(100).nullable(),
    relatedPageIds: z.array(z.string().max(100)).max(20),
    statements: z
      .array(
        z
          .object({
            kind: z.enum(statementKinds),
            text: short,
            context: z.string().max(2000),
            recordId: z.string().max(100),
            quote: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
const outputSchema = z
  .object({
    topics: z.array(topicSchema).max(20),
    excluded: z
      .array(
        z.object({ recordId: z.string().max(100), reason: short }).strict(),
      )
      .max(20_000),
  })
  .strict();
const consolidationSchema = z
  .object({
    topics: z
      .array(
        topicSchema
          .omit({ statements: true })
          .extend({ candidateIds: z.array(z.string().max(40)).min(1).max(400) })
          .strict(),
      )
      .max(20),
    excludedCandidates: z
      .array(
        z.object({ candidateId: z.string().max(40), reason: short }).strict(),
      )
      .max(400),
  })
  .strict();
export type ContextPage = {
  id: string;
  title: string;
  content: string;
  version: number;
};
export interface OrganizeCall {
  index: number;
  phase: "extract" | "consolidate";
  inputHash: string;
  contextBytes: number;
}
export interface OrganizeHooks {
  modelOptions?: (call: OrganizeCall) => Promise<ModelOptions>;
  onCallError?: (call: OrganizeCall, error: unknown) => Promise<void>;
  onCallFinished?: (call: OrganizeCall) => Promise<void>;
}
export async function organizeRecords(
  records: ImportRecord[],
  pages: ContextPage[],
  model: ModelCall,
  mode: "model" | "offline",
  check: () => Promise<void>,
  checkpoint: (calls: number) => Promise<void>,
  maxCalls = 20,
  hooks: OrganizeHooks = {},
): Promise<ImportResult> {
  if (mode === "offline")
    return {
      topics: [],
      excluded: records.map((r) => ({
        recordId: r.id,
        reason:
          r.event === "deleted"
            ? "원본 삭제 이벤트"
            : "구조 미리보기: 모델 의미 종합을 실행하지 않았습니다.",
      })),
      calls: 0,
      mode,
      coverage: { selected: records.length, processed: records.length },
    };
  const chunks: ImportRecord[][] = [];
  let chunk: ImportRecord[] = [],
    size = 0;
  for (const r of records) {
    const bytes = Buffer.byteLength(JSON.stringify(r));
    if (bytes > 100_000) throw Error("MODEL_CONTEXT_LIMIT");
    if ((size + bytes > 100_000 || chunk.length >= 50) && chunk.length) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(r);
    size += bytes;
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length + (chunks.length > 1 ? 1 : 0) > maxCalls)
    throw Error("BUDGET_EXCEEDED");
  const pageIds = new Set(pages.map((p) => p.id));
  const byId = new Map(records.map((r) => [r.id, r]));
  let calls = 0;
  const invoke = async (context: unknown, phase: OrganizeCall["phase"]) => {
    const serialized = JSON.stringify(context),
      meta = {
        index: calls + 1,
        phase,
        inputHash: createHash("sha256").update(serialized).digest("hex"),
        contextBytes: Buffer.byteLength(serialized),
      };
    let options: ModelOptions | undefined;
    try {
      options = await hooks.modelOptions?.(meta);
      calls++;
      await checkpoint(calls);
      return await model("organize", context, options);
    } catch (error) {
      await hooks.onCallError?.(meta, error);
      throw error;
    } finally {
      await hooks.onCallFinished?.(meta);
    }
  };
  const validate = (raw: unknown, expected: ImportRecord[]) => {
    const data = outputSchema.parse(raw),
      accounted = new Set<string>();
    const allowed = new Set(expected.map((r) => r.id));
    for (const topic of data.topics) {
      if (
        (topic.targetPageId && !pageIds.has(topic.targetPageId)) ||
        topic.relatedPageIds.some((id) => !pageIds.has(id))
      )
        throw Error("INVALID_MODEL_EVIDENCE");
      for (const statement of topic.statements) {
        const record = byId.get(statement.recordId);
        if (
          !record ||
          !allowed.has(record.id) ||
          record.event === "deleted" ||
          !record.text.includes(statement.quote)
        )
          throw Error("INVALID_MODEL_EVIDENCE");
        accounted.add(record.id);
      }
    }
    for (const e of data.excluded) {
      if (!allowed.has(e.recordId)) throw Error("INVALID_MODEL_EVIDENCE");
      accounted.add(e.recordId);
    }
    if (accounted.size !== allowed.size) throw Error("CONTEXT_INCOMPLETE");
    if (new Set(data.topics.map((t) => t.key)).size !== data.topics.length)
      throw Error("INVALID_MODEL_EVIDENCE");
    return data;
  };
  const outputs: ReturnType<typeof validate>[] = [];
  for (const part of chunks) {
    await check();
    const context = {
      records: part,
      pages,
      phase: "extract",
      coverage: { part: outputs.length + 1, total: chunks.length },
    };
    if (Buffer.byteLength(JSON.stringify(context)) > 290_000)
      throw Error("MODEL_CONTEXT_LIMIT");
    outputs.push(validate(await invoke(context, "extract"), part));
    await check();
  }
  let output = outputs[0] || { topics: [], excluded: [] };
  if (outputs.length > 1) {
    await check();
    const candidates = outputs.flatMap((o, i) =>
      o.topics.map((topic, j) => ({ id: `c${i}-${j}`, topic })),
    );
    const context = {
      phase: "consolidate",
      pages,
      candidates: candidates.map(({ id, topic }) => ({
        id,
        key: topic.key,
        title: topic.title,
        summary: topic.summary,
        content: topic.content,
        targetPageId: topic.targetPageId,
        relatedPageIds: topic.relatedPageIds,
        signals: topic.statements.map(({ kind, text, context }) => ({
          kind,
          text,
          context,
        })),
      })),
      instruction:
        "Reconcile ALL candidates: preserve negations, later corrections, environment differences and failed attempts. Assign every candidate id exactly once, to a topic or excludedCandidates. The server carries forward validated source evidence; do not rewrite quotes or record IDs.",
    };
    if (Buffer.byteLength(JSON.stringify(context)) > 290_000)
      throw Error("MODEL_CONTEXT_LIMIT");
    const merged = consolidationSchema.parse(
      await invoke(context, "consolidate"),
    );
    const assigned = new Set<string>();
    const claim = (id: string) => {
      const candidate = candidates.find((c) => c.id === id);
      if (!candidate || assigned.has(id)) throw Error("INVALID_MODEL_EVIDENCE");
      assigned.add(id);
      return candidate.topic;
    };
    const exclusions = outputs.flatMap((o) => o.excluded);
    const topics = merged.topics.map(({ candidateIds, ...topic }) => {
      if (
        (topic.targetPageId && !pageIds.has(topic.targetPageId)) ||
        topic.relatedPageIds.some((id) => !pageIds.has(id))
      )
        throw Error("INVALID_MODEL_EVIDENCE");
      const statements = candidateIds.flatMap((id) => claim(id).statements);
      return {
        ...topic,
        statements: [
          ...new Map(statements.map((s) => [JSON.stringify(s), s])).values(),
        ],
      };
    });
    for (const e of merged.excludedCandidates)
      for (const s of claim(e.candidateId).statements)
        exclusions.push({ recordId: s.recordId, reason: e.reason });
    if (assigned.size !== candidates.length) throw Error("CONTEXT_INCOMPLETE");
    if (new Set(topics.map((t) => t.key)).size !== topics.length)
      throw Error("INVALID_MODEL_EVIDENCE");
    const used = new Set(
      topics.flatMap((t) => t.statements.map((s) => s.recordId)),
    );
    output = {
      topics,
      excluded: [
        ...new Map(
          exclusions
            .filter((e) => !used.has(e.recordId))
            .map((e) => [e.recordId, e]),
        ).values(),
      ],
    };
    await check();
  }
  // Page identity is server validated; two independent candidates cannot overwrite one existing page.
  const targets = output.topics.flatMap((t) =>
    t.targetPageId ? [t.targetPageId] : [],
  );
  if (new Set(targets).size !== targets.length)
    throw Error("INVALID_MODEL_EVIDENCE");
  return {
    ...output,
    topics: output.topics as ImportTopic[],
    calls,
    mode,
    coverage: { selected: records.length, processed: records.length },
  };
}
