import { z } from "zod";
/** Form and server validation project the canonical version/governance metadata. */
export const documentPropertiesSchema = z
  .object({
    category: z.string().trim().min(1).max(100),
    summary: z.string().trim().max(10000),
    tags: z
      .array(z.string().trim().min(1).max(100))
      .max(30)
      .transform((v) => [...new Set(v)]),
    properties: z.record(z.string().max(100), z.string().max(2000)),
    environment: z
      .union([
        z.string().trim().max(2000),
        z.record(z.string().max(100), z.string().max(2000)),
      ])
      .nullable(),
    reviewDue: z.iso.datetime().nullable(),
  })
  .strict();
export type DocumentProperties = z.input<typeof documentPropertiesSchema>;
export type PropertyPolicy = {
  document_type: string;
  required_keys: string[];
  mode: "warn" | "block";
};
export function propertyWarnings(
  value: DocumentProperties,
  policies: PropertyPolicy[],
  ownerId?: string | null,
) {
  const p =
    policies.find((p) => p.document_type === value.category) ??
    policies.find((p) => p.document_type === "*");
  return (p?.required_keys ?? [])
    .filter((key) => {
      const v =
        key === "businessOwner"
          ? ownerId
          : key === "tags"
            ? value.tags
            : key === "summary"
              ? value.summary
              : key === "reviewDue"
                ? value.reviewDue
                : key === "environment"
                  ? value.environment
                  : value.properties[key];
      return (
        v == null ||
        (typeof v === "string" && !v.trim()) ||
        (Array.isArray(v) && !v.length)
      );
    })
    .map((key) => ({ key, mode: p!.mode }));
}
