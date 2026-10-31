import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import { z } from "zod";
import { transaction } from "../database";
import { fingerprint, assertEnvelope, type InputEnvelope } from "../provenance";
import { loadState } from "../repository";
import { acquireSharedMutationGate } from "../operations/gate";
import { authorize, policyAdmin, policyEvent } from "./common";
import { assertFeature } from "./features";
import type { Action } from "../access/index";

export const purposes = [
  "query",
  "ingest",
  "organize",
  "semantic-lint",
  "embedding",
  "conversion",
  "execution-verification",
] as const;
export type Purpose = (typeof purposes)[number];
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .refine((v) => !Object.hasOwn(Object.prototype, v) && v !== "prototype");
const inputSchema = z
  .object({
    destinationId: id,
    purpose: z.enum(purposes),
    pageIds: z.array(id).max(200),
    sourceIds: z.array(id).max(200),
  })
  .strict();
export type TransmissionInput = z.infer<typeof inputSchema>;
const grantSchema = z
  .object({
    destinationId: id,
    purpose: z.enum(purposes),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const policySchema = z
  .object({
    sourceId: id,
    expectedRevision: z.number().int().nonnegative(),
    classification: id,
    grants: z.array(grantSchema).max(100),
    impactAcknowledged: z.literal(true),
  })
  .strict();
export type SourcePolicyInput = z.infer<typeof policySchema>;

export function canonicalDestinationUrl(raw: string) {
  const u = new URL(raw);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw Error("POLICY_CONFIGURATION");
  return u.href;
}
/** Trusted startup/migration only. NEVER expose as a browser/REST/MCP mutation.
 * classifications is an explicit approved site allowlist; 'unknown' is blocked
 * unless this trusted configuration deliberately approves it for this address.
 */
export async function registerTrustedDestinations(pool: Pool, raw: unknown) {
  const entries = z
    .array(
      z
        .object({
          id,
          url: z.string().min(1).max(2048),
          purposes: z.array(z.enum(purposes)).min(1).max(purposes.length),
          classifications: z.array(id).min(1).max(100),
          active: z.boolean(),
        })
        .strict(),
    )
    .max(1000)
    .parse(raw);
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw Error("POLICY_CONFIGURATION");
  for (const e of entries) canonicalDestinationUrl(e.url);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireSharedMutationGate(client);
    await client.query("SELECT pg_advisory_xact_lock(7203100)");
    const workspaces = (
      await client.query("SELECT id FROM workspaces ORDER BY id FOR UPDATE")
    ).rows;
    const recordDestination = async (
      targetId: string,
      revision: number,
      data: unknown,
    ) => {
      for (const w of workspaces)
        await policyEvent(
          client,
          { workspaceId: w.id, principalId: "trusted-startup" },
          "model.destination",
          targetId,
          revision,
          data,
        );
    };
    const seen = new Set<string>();
    for (const e of entries) {
      id.parse(e.id);
      if (
        seen.has(e.id) ||
        !e.purposes.length ||
        e.purposes.some((p) => !purposes.includes(p)) ||
        !e.classifications.length ||
        e.classifications.some((c) => !id.safeParse(c).success) ||
        typeof e.active !== "boolean"
      )
        throw Error("POLICY_CONFIGURATION");
      seen.add(e.id);
      const url = canonicalDestinationUrl(e.url);
      const old = await client.query(
        "SELECT * FROM model_destinations WHERE id=$1 FOR UPDATE",
        [e.id],
      );
      const config = {
        url,
        purposes: [...new Set(e.purposes)].sort(),
        classifications: [...new Set(e.classifications)].sort(),
        active: e.active,
      };
      const previous = old.rows[0];
      if (
        previous &&
        previous.canonical_url === url &&
        fingerprint(previous.purposes) === fingerprint(config.purposes) &&
        fingerprint(previous.classifications) ===
          fingerprint(config.classifications) &&
        previous.active === e.active
      )
        continue;
      const revision = (previous?.revision ?? 0) + 1;
      // Revision binds grants even if an address is changed back later.
      const hash = fingerprint({ id: e.id, revision, ...config });
      await client.query(
        "INSERT INTO model_destinations VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET canonical_url=excluded.canonical_url,purposes=excluded.purposes,classifications=excluded.classifications,active=excluded.active,revision=excluded.revision,fingerprint=excluded.fingerprint",
        [
          e.id,
          url,
          JSON.stringify(config.purposes),
          JSON.stringify(config.classifications),
          e.active,
          revision,
          hash,
        ],
      );
      await recordDestination(e.id, revision, { ...config, fingerprint: hash });
    }
    // Removed configuration entries are revoked, never silently left usable.
    const removed = await client.query(
      "SELECT * FROM model_destinations WHERE active AND NOT(id=ANY($1::text[])) FOR UPDATE",
      [[...seen]],
    );
    for (const d of removed.rows) {
      const revision = d.revision + 1;
      const hash = fingerprint({
        previous: d.fingerprint,
        revision,
        active: false,
      });
      await client.query(
        "UPDATE model_destinations SET active=false,revision=$2,fingerprint=$3 WHERE id=$1",
        [d.id, revision, hash],
      );
      await recordDestination(d.id, revision, {
        canonicalUrl: d.canonical_url,
        active: false,
        fingerprint: hash,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Entire historical influencing lineage, not citations alone. Limits reject, never truncate. */
export async function transmissionClosure(
  db: PoolClient,
  ctx: Context,
  input: Pick<TransmissionInput, "pageIds" | "sourceIds">,
) {
  if (input.pageIds.length + input.sourceIds.length > 200)
    throw Error("POLICY_RESOURCE_LIMIT");
  const pages = new Set<string>(),
    sources = new Set(input.sourceIds);
  const pending = input.pageIds.map((id) => ({ id, depth: 0 }));
  while (pending.length) {
    const next = pending.shift()!;
    if (next.depth > 32) throw Error("POLICY_RESOURCE_LIMIT");
    if (pages.has(next.id)) continue;
    pages.add(next.id);
    if (pages.size + sources.size > 200) throw Error("POLICY_RESOURCE_LIMIT");
    const p = await db.query(
      "SELECT data FROM pages WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, next.id],
    );
    const versions = await db.query(
      "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2 ORDER BY number",
      [ctx.workspaceId, next.id],
    );
    if (!p.rowCount || !versions.rowCount) throw Error("NOT_FOUND");
    const ancestors = new Set<string>(p.rows[0].data.links ?? []);
    const parent = await db.query(
      "SELECT parent_id FROM workflow_document_state WHERE workspace_id=$1 AND page_id=$2",
      [ctx.workspaceId, next.id],
    );
    if (parent.rows[0]?.parent_id)
      ancestors.add(id.parse(parent.rows[0].parent_id));
    for (const { data } of versions.rows) {
      for (const s of [
        ...(data.sourceIds ?? []),
        ...(data.provenance?.sourceIds ?? []),
      ]) {
        id.parse(s);
        sources.add(s);
      }
      for (const a of data.provenance?.pageIds ?? [])
        ancestors.add(id.parse(a));
    }
    if (pages.size + sources.size > 200 || ancestors.size > 200)
      throw Error("POLICY_RESOURCE_LIMIT");
    for (const a of ancestors)
      if (!pages.has(a))
        pending.push({ id: id.parse(a), depth: next.depth + 1 });
    if (pending.length > 40000) throw Error("POLICY_RESOURCE_LIMIT");
  }
  // The existing canonical guard checks current ACL, lifecycle and source freshness.
  for (const p of [...pages].sort())
    await authorize(db, ctx, "knowledge.read", { kind: "page", id: p });
  for (const s of [...sources].sort())
    await authorize(db, ctx, "knowledge.read", {
      kind: "source",
      id: id.parse(s),
    });
  return { pageIds: [...pages].sort(), sourceIds: [...sources].sort() };
}

export async function sourcePolicyHash(
  db: PoolClient,
  ctx: Context,
  input: Pick<TransmissionInput, "pageIds" | "sourceIds">,
  action: Action = "knowledge.read",
): Promise<string> {
  await authorize(db, ctx, action);
  const closure = await transmissionClosure(db, ctx, input);
  const policies = await db.query(
    "SELECT * FROM model_source_policies WHERE workspace_id=$1 ORDER BY source_id",
    [ctx.workspaceId],
  );
  const destinations = await db.query(
    "SELECT * FROM model_destinations ORDER BY id",
  );
  const features = await db.query(
    "SELECT * FROM feature_policies WHERE workspace_id=$1 ORDER BY feature",
    [ctx.workspaceId],
  );
  const privateImports = await db.query(
    "SELECT * FROM policy_private_import_sources WHERE workspace_id=$1 ORDER BY import_id",
    [ctx.workspaceId],
  );
  return fingerprint({
    closure,
    policies: policies.rows,
    destinations: destinations.rows,
    features: features.rows,
    privateImports: privateImports.rows,
    siteDefaults: process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS ?? null,
  });
}

export async function assertModelTransmission(
  db: PoolClient,
  ctx: Context,
  raw: TransmissionInput,
): Promise<void> {
  const input = inputSchema.parse(raw);
  await assertFeature(db, ctx, "models");
  const feature =
    input.purpose === "query"
      ? "query"
      : input.purpose === "ingest"
        ? "ingest"
        : input.purpose === "organize" || input.purpose === "conversion"
          ? "imports"
          : input.purpose === "semantic-lint"
            ? "lint"
            : "models";
  await assertFeature(db, ctx, feature);
  const closure = await transmissionClosure(db, ctx, input);
  if (!closure.sourceIds.length) throw Error("MODEL_TRANSMISSION_DENIED");
  const dest = (
    await db.query("SELECT * FROM model_destinations WHERE id=$1", [
      input.destinationId,
    ])
  ).rows[0];
  if (!dest?.active || !dest.purposes.includes(input.purpose))
    throw Error("MODEL_TRANSMISSION_DENIED");
  for (const sourceId of closure.sourceIds) {
    const p = (
      await db.query(
        "SELECT * FROM model_source_policies WHERE workspace_id=$1 AND source_id=$2",
        [ctx.workspaceId, sourceId],
      )
    ).rows[0];
    if (
      !p ||
      !dest.classifications.includes(p.classification) ||
      !p.grants.some(
        (g: z.infer<typeof grantSchema>) =>
          g.destinationId === dest.id &&
          g.purpose === input.purpose &&
          g.fingerprint === dest.fingerprint,
      )
    )
      throw Error("MODEL_TRANSMISSION_DENIED");
  }
}

export async function setSourcePolicy(
  db: PoolClient,
  ctx: Context,
  raw: SourcePolicyInput,
) {
  const p = policySchema.parse(raw);
  await policyAdmin(db, ctx);
  await authorize(db, ctx, "knowledge.read", {
    kind: "source",
    id: p.sourceId,
  });
  for (const g of p.grants) {
    const d = (
      await db.query("SELECT * FROM model_destinations WHERE id=$1", [
        g.destinationId,
      ])
    ).rows[0];
    if (
      !d?.active ||
      d.fingerprint !== g.fingerprint ||
      !d.purposes.includes(g.purpose) ||
      !d.classifications.includes(p.classification)
    )
      throw Error("MODEL_TRANSMISSION_DENIED");
  }
  const previous = await db.query(
    "SELECT revision FROM model_source_policies WHERE workspace_id=$1 AND source_id=$2",
    [ctx.workspaceId, p.sourceId],
  );
  if ((previous.rows[0]?.revision ?? 0) !== p.expectedRevision)
    throw Error("STALE_VERSION");
  await db.query(
    "INSERT INTO model_source_policies VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,source_id) DO UPDATE SET revision=excluded.revision,classification=excluded.classification,grants=excluded.grants",
    [
      ctx.workspaceId,
      p.sourceId,
      p.expectedRevision + 1,
      p.classification,
      JSON.stringify(p.grants),
    ],
  );
  await policyEvent(
    db,
    ctx,
    "source.model-policy",
    p.sourceId,
    p.expectedRevision + 1,
    {
      classification: p.classification,
      grants: p.grants,
      impact:
        "전체 파생 페이지·대기 작업의 정책 지문이 변경됩니다. 사내 승인이 아닙니다.",
    },
  );
}

/** Perform directory/session network refresh outside transactions, then DB preflight
 * immediately before the real producer call. Returned recheck is DB-only for the
 * caller's existing fenced write transaction. No network while workspace is locked.
 */
export async function prepareTransmission(
  pool: Pool,
  ctx: Context,
  input: TransmissionInput,
  configuredUrl: string,
  envelope?: InputEnvelope,
) {
  if (!ctx.authorization && !ctx.credentialId) throw Error("UNAUTHENTICATED");
  await ctx.authorization?.revalidate();
  const epoch = await transaction(pool, ctx.workspaceId, async (db) => {
    await assertModelTransmission(db, ctx, input);
    if (envelope)
      await assertEnvelope(
        db,
        ctx,
        await loadState(db, ctx.workspaceId),
        envelope,
      );
    const dest = (
      await db.query(
        "SELECT canonical_url FROM model_destinations WHERE id=$1",
        [input.destinationId],
      )
    ).rows[0];
    if (dest.canonical_url !== canonicalDestinationUrl(configuredUrl))
      throw Error("MODEL_TRANSMISSION_DENIED");
    return sourcePolicyHash(db, ctx, input);
  });
  return async (db: PoolClient) => {
    if (envelope)
      await assertEnvelope(
        db,
        ctx,
        await loadState(db, ctx.workspaceId),
        envelope,
      );
    await assertModelTransmission(db, ctx, input);
    if ((await sourcePolicyHash(db, ctx, input)) !== epoch)
      throw Error("STALE_VERSION");
  };
}
