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
type PolicyFields = {
  environment?: unknown;
  properties: Record<string, unknown>;
  tags?: unknown;
  summary?: unknown;
  reviewDue?: unknown;
  businessOwner?: unknown;
};

export function canonicalEnvironment(data: {
  environment?: unknown;
  properties?: Record<string, unknown>;
}) {
  return Object.hasOwn(data, "environment")
    ? data.environment
    : (data.properties?.environment ?? null);
}

export function missingRequiredProperty(key: string, fields: PolicyFields) {
  if (key === "environment") {
    const env = canonicalEnvironment(fields);
    return typeof env === "string"
      ? !env.trim()
      : !env ||
          typeof env !== "object" ||
          Array.isArray(env) ||
          !Object.values(env).some(
            (value) => typeof value === "string" && value.trim(),
          );
  }
  const value =
    key === "businessOwner" ||
    key === "reviewDue" ||
    key === "tags" ||
    key === "summary"
      ? fields[key]
      : fields.properties[key];
  return (
    value == null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}

export function propertyWarnings(
  value: DocumentProperties,
  policies: PropertyPolicy[],
  ownerId?: string | null,
) {
  const p =
    policies.find((p) => p.document_type === value.category) ??
    policies.find((p) => p.document_type === "*");
  return (p?.required_keys ?? [])
    .filter((key) =>
      missingRequiredProperty(key, { ...value, businessOwner: ownerId }),
    )
    .map((key) => ({ key, mode: p!.mode }));
}
