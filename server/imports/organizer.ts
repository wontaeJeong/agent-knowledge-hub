import { z } from "zod";
import type {
  ImportRecord,
  ImportResult,
  ImportTopic,
} from "../../src/domain/imports";
import { statementKinds } from "../../src/domain/imports";
import type { ModelCall } from "../runtime/model";

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
export type ContextPage = {
  id: string;
  title: string;
  content: string;
  version: number;
};
export async function organizeRecords(
  records: ImportRecord[],
  pages: ContextPage[],
  model: ModelCall,
  mode: "model" | "offline",
  check: () => Promise<void>,
  checkpoint: (calls: number) => Promise<void>,
  maxCalls = 20,
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
    if (size + bytes > 100_000 && chunk.length) {
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
    calls++;
    await checkpoint(calls);
    outputs.push(validate(await model("organize", context), part));
    await check();
  }
  let output = outputs[0] || { topics: [], excluded: [] };
  if (outputs.length > 1) {
    await check();
    const context = {
      phase: "consolidate",
      recordIds: records.map((r) => r.id),
      pages,
      candidates: outputs,
      instruction:
        "Reconcile ALL chunks: preserve negations, later corrections, environment differences and failed attempts. Account for every input record.",
    };
    if (Buffer.byteLength(JSON.stringify(context)) > 290_000)
      throw Error("MODEL_CONTEXT_LIMIT");
    calls++;
    await checkpoint(calls);
    output = validate(await model("organize", context), records);
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
