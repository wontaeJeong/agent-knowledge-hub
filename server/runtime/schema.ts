import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().trim().min(1).max(100000);
export const mode = z.enum(["offline", "model"]);
export const sourceInput = z
  .object({
    id: id.optional(),
    title: z.string().trim().min(1).max(300),
    tool: z.string().max(100).default("manual"),
    project: z.string().max(200).default(""),
    content: text,
    scope: z.enum(["team", "company", "private"]),
    verification: z
      .enum(["작성자 확인", "실행 증거 첨부", "미검증"])
      .default("미검증"),
    targetPageId: id,
    readers: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .strict();
export const drafts = z
  .array(
    z
      .object({
        id,
        title: z.string().trim().min(1).max(300),
        summary: z.string().max(2000),
        content: text,
        scope: z.enum(["team", "company", "private"]),
        baseVersion: z.number().int().min(0),
        links: z.array(id).max(100),
        sourceIds: z.array(id).min(1).max(100),
        facts: z
          .array(
            z
              .object({
                key: text,
                context: text,
                value: text,
                sourceId: id,
                quote: text,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  )
  .min(1)
  .max(20);
export const ingestInput = z
  .object({ sourceIds: z.array(id).min(1).max(20), mode })
  .strict();
export const queryScope = z
  .object({
    project: z.string().trim().min(1).max(200).optional(),
    topic: z.string().trim().min(1).max(200).optional(),
    historical: z.boolean().default(false),
    periodFrom: z.iso.datetime().optional(),
    periodTo: z.iso.datetime().optional(),
    environment: z
      .record(z.string().min(1).max(100), z.string().min(1).max(500))
      .refine((v) => Object.keys(v).length <= 30)
      .default({}),
  })
  .strict()
  .refine(
    (s) =>
      (!s.periodFrom && !s.periodTo) ||
      (s.historical &&
        (!s.periodFrom ||
          !s.periodTo ||
          Date.parse(s.periodFrom) <= Date.parse(s.periodTo))),
  );
export type QueryScope = z.input<typeof queryScope>;
export const queryInput = z
  .object({
    question: z.string().trim().min(1).max(2000),
    mode,
    scope: queryScope.optional(),
  })
  .strict();
export const approvalInput = z
  .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const answerOutput = z
  .object({
    content: text,
    insufficient: z.boolean(),
    citations: z
      .array(
        z
          .object({
            pageId: id,
            title: z.string().max(300),
            quote: text,
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
