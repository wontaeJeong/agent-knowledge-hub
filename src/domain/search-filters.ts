import { z } from "zod";
const text = z.string().trim().min(1).max(200);
export const searchFilters = z
  .object({
    query: z.string().trim().max(2000).default(""),
    type: text.optional(),
    businessOwner: text.optional(),
    tags: z.array(text).max(20).default([]),
    state: text.optional(),
    reviewDateFrom: z.iso.datetime().optional(),
    reviewDateTo: z.iso.datetime().optional(),
    periodFrom: z.iso.datetime().optional(),
    periodTo: z.iso.datetime().optional(),
    project: text.optional(),
    environment: text.optional(),
    archived: z.boolean().optional(),
    historical: z.boolean().default(false),
    sort: z.enum(["recent", "title"]).default("recent"),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(4000).nullable().optional(),
  })
  .strict()
  .refine(
    (f) =>
      (!f.periodFrom ||
        !f.periodTo ||
        Date.parse(f.periodFrom) <= Date.parse(f.periodTo)) &&
      (!f.reviewDateFrom ||
        !f.reviewDateTo ||
        f.reviewDateFrom <= f.reviewDateTo),
  );

export type SearchFilters = z.infer<typeof searchFilters>;
export function normalizeSearchFilters(input: unknown): SearchFilters {
  return searchFilters.parse(input);
}
