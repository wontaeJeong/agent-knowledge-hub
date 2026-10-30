import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const time = z.iso.datetime();
export const conditions = z
  .record(z.string().min(1).max(100), z.string().min(1).max(500))
  .refine((v) => Object.keys(v).length <= 30);
export const evidenceInput = z
  .object({
    id,
    kind: z.enum([
      "claim",
      "inference",
      "hypothesis",
      "independent-execution",
      "review",
    ]),
    sourceId: id.optional(),
    sourceVersion: z.string().max(100).optional(),
    location: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        quote: z.string().min(1).max(20000),
      })
      .strict()
      .optional(),
    parentIds: z.array(id).max(100),
    assertedAt: time,
    verifiedAt: time.nullable(),
    conditions,
    executionId: id.optional(),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceInput> & {
  root: string | null;
  recordedAt: string;
  recordedBy: string;
};
export const claimInput = z
  .object({
    id,
    pageId: id,
    pageVersion: z.number().int().positive(),
    key: z.string().min(1).max(300),
    value: z.string().min(1).max(10000),
    kind: z.enum(["claim", "inference", "hypothesis"]),
    conditions,
    exceptions: z.array(z.string().min(1).max(2000)).max(50),
    assertedAt: time,
    validFrom: time.nullable(),
    validTo: time.nullable(),
    verifiedAt: time.nullable(),
    evidenceIds: z.array(id).min(1).max(100),
    protected: z.boolean(),
    uncertainty: z.string().min(1).max(2000),
    supersedes: z.array(id).max(100),
  })
  .strict()
  .refine(
    (c) =>
      !c.validTo ||
      (!!c.validFrom && Date.parse(c.validFrom) < Date.parse(c.validTo)),
    "invalid validity interval",
  );
export type Claim = z.infer<typeof claimInput> & {
  recordedAt: string;
  recordedBy: string;
};
export function lineageRoots(nodes: Evidence[], target: string): string[] {
  const byId = new Map(nodes.map((e) => [e.id, e]));
  const memo = new Map<string, string[]>(),
    visiting = new Set<string>();
  const visit = (key: string): string[] => {
    if (visiting.has(key)) throw Error("CIRCULAR_EVIDENCE");
    const prior = memo.get(key);
    if (prior) return prior;
    const e = byId.get(key);
    if (!e) throw Error("EVIDENCE_MISSING");
    if (!e.parentIds.length && !e.root) throw Error("EVIDENCE_MISSING");
    if (visiting.size >= 256) throw Error("EVIDENCE_DEPTH_LIMIT");
    visiting.add(key);
    const roots = [
      ...new Set([...(e.root ? [e.root] : []), ...e.parentIds.flatMap(visit)]),
    ].sort();
    visiting.delete(key);
    memo.set(key, roots);
    return roots;
  };
  return visit(target);
}
export function compareClaims(a: Claim, b: Claim) {
  if (a.key !== b.key) return "unrelated";
  if (
    Object.keys(a.conditions).some(
      (k) =>
        b.conditions[k] !== undefined && a.conditions[k] !== b.conditions[k],
    )
  )
    return "different-environment";
  if (
    (a.validTo &&
      b.validFrom &&
      Date.parse(a.validTo) <= Date.parse(b.validFrom)) ||
    (b.validTo &&
      a.validFrom &&
      Date.parse(b.validTo) <= Date.parse(a.validFrom))
  )
    return "different-time";
  if (!a.validFrom || !b.validFrom) return "unknown-time";
  return a.value === b.value ? "agreement" : "contradiction";
}
export function selectContext(
  claims: Claim[],
  asOf: string,
  environment: Record<string, string>,
) {
  time.parse(asOf);
  conditions.parse(environment);
  const eligible = claims.filter(
    (c) =>
      !Object.entries(environment).some(
        ([k, v]) => c.conditions[k] !== undefined && c.conditions[k] !== v,
      ),
  );
  return {
    items: eligible.filter(
      (c) =>
        c.validFrom &&
        Date.parse(c.validFrom) <= Date.parse(asOf) &&
        (!c.validTo || Date.parse(asOf) < Date.parse(c.validTo)),
    ),
    unknownTime: eligible.filter((c) => !c.validFrom).map((c) => c.id),
  };
}
