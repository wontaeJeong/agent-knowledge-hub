import type { PoolClient } from "pg";
import type { Context } from "../service";
import type { Action } from "../access/index";
import {
  authorize,
  policyAdmin,
  policyEvent,
  assertPolicyTransaction,
  type Resource,
} from "./common";

export const features = [
  "models",
  "ingest",
  "query",
  "lint",
  "sharing",
  "localcopy",
  "imports",
  "connectors",
  "export",
  "company",
  "guest",
  "anonymous",
] as const;
export type Feature = (typeof features)[number];
const defaults: Record<Feature, boolean> = {
  models: true,
  ingest: true,
  query: true,
  lint: true,
  sharing: true,
  localcopy: true,
  imports: true,
  connectors: true,
  export: true,
  company: false,
  guest: false,
  anonymous: false,
};
export function siteFeatureDefaults(): Record<Feature, boolean> {
  const raw = process.env.AGENT_KNOWLEDGE_HUB_FEATURE_DEFAULTS;
  if (!raw) return { ...defaults };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error("POLICY_CONFIGURATION");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.entries(parsed).some(
      ([k, v]) => !features.includes(k as Feature) || typeof v !== "boolean",
    )
  )
    throw Error("POLICY_CONFIGURATION");
  // Optional public/company identities are not implemented: configuration cannot enable them.
  if (
    ["company", "guest", "anonymous"].some(
      (k) => (parsed as Record<string, unknown>)[k] === true,
    )
  )
    throw Error("POLICY_CONFIGURATION");
  return { ...defaults, ...parsed };
}
export async function featureState(db: PoolClient, ctx: Context) {
  await authorize(db, ctx, "knowledge.read");
  return readFeatureState(db, ctx);
}
/** Internal projection only: caller has already authorized the exact operation/resource. */
async function readFeatureState(db: PoolClient, ctx: Context) {
  const rows = await db.query(
    "SELECT feature,enabled,revision FROM feature_policies WHERE workspace_id=$1",
    [ctx.workspaceId],
  );
  const site = siteFeatureDefaults();
  return features.map((feature) => {
    const p = rows.rows.find((r) => r.feature === feature);
    return {
      feature,
      enabled: site[feature] && (p?.enabled ?? true),
      revision: p?.revision ?? 0,
    };
  });
}
export async function assertFeature(
  db: PoolClient,
  ctx: Context,
  feature: string,
  resource?: Resource,
  action: Action = "knowledge.read",
): Promise<void> {
  await assertPolicyTransaction(db);
  if (!features.includes(feature as Feature)) throw Error("FEATURE_DISABLED");
  await authorize(db, ctx, action, resource);
  if (
    !(await readFeatureState(db, ctx)).find((p) => p.feature === feature)
      ?.enabled
  )
    throw Error("FEATURE_DISABLED");
}
export async function setFeature(
  db: PoolClient,
  ctx: Context,
  feature: Feature,
  enabled: boolean,
  expectedRevision: number,
) {
  await policyAdmin(db, ctx); // Deliberately NOT assertFeature: administrators can re-enable.
  if (
    !features.includes(feature) ||
    typeof enabled !== "boolean" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    throw Error("POLICY_INPUT");
  if (enabled && !siteFeatureDefaults()[feature])
    throw Error("FEATURE_DISABLED");
  const old = await db.query(
    "SELECT revision FROM feature_policies WHERE workspace_id=$1 AND feature=$2",
    [ctx.workspaceId, feature],
  );
  if ((old.rows[0]?.revision ?? 0) !== expectedRevision)
    throw Error("STALE_VERSION");
  await db.query(
    "INSERT INTO feature_policies VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,feature) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision",
    [ctx.workspaceId, feature, enabled, expectedRevision + 1],
  );
  await policyEvent(db, ctx, "feature.policy", feature, expectedRevision + 1, {
    enabled,
  });
}

// Exact operation tables. Unknown is deliberately null, never a guessed feature.
const lookup = (table: Record<string, Feature>, key: string): Feature | null =>
  Object.hasOwn(table, key) ? table[key] : null;
export const featureForMcpOperation = (operation: string): Feature | null =>
  lookup(
    {
      knowledge_search: "query",
      knowledge_query: "query",
      knowledge_ingest: "ingest",
      knowledge_lint: "lint",
      knowledge_import_text: "imports",
      knowledge_import_selection: "imports",
      knowledge_import_start: "imports",
      knowledge_import_resume: "imports",
      wiki_search: "query",
      wiki_read: "query",
      wiki_get_context: "query",
      wiki_submit_artifact: "ingest",
      wiki_propose_change: "ingest",
      wiki_report_outcome: "ingest",
    },
    operation,
  );
export const featureForJobOperation = (operation: string): Feature | null =>
  lookup(
    {
      ingest: "ingest",
      query: "query",
      lint: "lint",
      organize: "imports",
      "semantic-lint": "lint",
      embedding: "models",
      conversion: "imports",
      "execution-verification": "models",
    },
    operation,
  );
export function featureForRoute(method: string, path: string): Feature | null {
  const exact = lookup(
    {
      "POST /api/v1/ingest": "ingest",
      "POST /api/v1/query": "query",
      "POST /api/v1/lint": "lint",
      "POST /api/v1/refinement/semantic-lint": "lint",
      "POST /api/v1/sources": "ingest",
    },
    `${method} ${path}`,
  );
  if (exact) return exact;
  // Already accepted work must remain inspectable/cancellable while creation is disabled.
  if (
    (method === "GET" && /^\/api\/v1\/import-runs\//.test(path)) ||
    (method === "POST" &&
      /^\/api\/v1\/import-runs\/[a-zA-Z0-9_-]{1,100}\/cancel$/.test(path)) ||
    (method === "DELETE" &&
      /^\/api\/v1\/imports\/[a-zA-Z0-9_-]{1,100}$/.test(path))
  )
    return null;
  if (
    ["GET", "POST", "PATCH", "DELETE"].includes(method) &&
    (/^\/api\/v1\/imports(?:\/|$)/.test(path) ||
      /^\/api\/v1\/import-runs\//.test(path) ||
      path === "/api/v1/import-disclosures")
  )
    return "imports";
  if (
    ["GET", "POST", "DELETE"].includes(method) &&
    /^\/api\/v1\/(?:spaces\/[a-zA-Z0-9_-]{1,100}\/)?shares(?:\/[a-zA-Z0-9_-]{1,100})?$/.test(
      path,
    )
  )
    return "sharing";
  if (
    method === "POST" &&
    /^\/api\/v1\/changesets\/[a-zA-Z0-9_-]{1,100}\/save$/.test(path)
  )
    return "localcopy";
  if (
    method === "GET" &&
    /^\/api\/v1\/storage\/blobs\/[a-zA-Z0-9_-]+\/local-copy$/.test(path)
  )
    return "localcopy";
  if (method === "POST" && path === "/api/v1/storage/export") return "export";
  if (
    method === "POST" &&
    [
      "/api/v1/storage/collect-url",
      "/api/v1/storage/collect-artifact",
    ].includes(path)
  )
    return "connectors";
  if (method === "POST" && path === "/api/v1/storage/import") return "imports";
  return null;
}
/** daily/weekly run BOTH lint and ingest. A single guessed feature loses semantics. */
export async function assertJobFeatures(
  db: PoolClient,
  ctx: Context,
  operation: string,
) {
  if (operation === "daily" || operation === "weekly") {
    await assertFeature(db, ctx, "lint", undefined, "lint.run");
    await assertFeature(db, ctx, "ingest", undefined, "changeset.propose");
    return;
  }
  const feature = featureForJobOperation(operation);
  if (!feature) throw Error("FEATURE_DISABLED");
  const action: Action =
    operation === "ingest"
      ? "changeset.propose"
      : operation === "lint" || operation === "semantic-lint"
        ? "lint.run"
        : "knowledge.read";
  await assertFeature(db, ctx, feature, undefined, action);
}
