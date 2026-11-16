import type { Pool, PoolClient } from "pg";
import type { Context } from "../service";
import type { Claim, Evidence } from "./logic";
import type { State } from "../../src/domain/types";
import { current, draftOf, type Draft } from "../../src/domain/wiki";
import { transaction } from "../database";
import { captureEnvelope, fingerprint } from "../provenance";
import { digest, propose } from "../publication";
import { bindModelTransmission } from "../policy/binding";
import { drafts } from "../runtime/schema";
import {
  currentRecommendation,
  type RuntimeExecution,
  type RuntimeService,
} from "../runtime/knowledge";
import { z } from "zod";

export type MaintenanceFinding = {
  kind:
    | "topic-consolidation"
    | "duplicate-page"
    | "duplicate-claim"
    | "conflicting-claim"
    | "connection-gap"
    | "evidence-gap"
    | "stale-review";
  pageIds: string[];
  claimIds?: string[];
  reason: string;
  authority: "review-candidate";
};
/** Calendar boundaries are derived in the approved IANA timezone. Midnight gaps
 * use the first representable minute of that local day; folds use the first. */
function dayStart(day: string, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const rough = Date.parse(day + "T00:00:00Z");
  for (let t = rough - 15 * 3600000; t <= rough + 36 * 3600000; t += 60000)
    if (fmt.format(new Date(t)) === day) return new Date(t);
  throw Error("INVALID_SCHEDULE");
}
export function maintenanceWindow(
  cadence: "weekly" | "monthly",
  at: Date,
  timezone: string,
) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const endDay =
    cadence === "monthly"
      ? `${p.year}-${p.month}-01`
      : `${p.year}-${p.month}-${p.day}`;
  const end = dayStart(endDay, timezone);
  const startDay = new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      cadence === "monthly" ? 1 : Number(p.day) - 7,
    ),
  );
  if (cadence === "monthly") startDay.setUTCMonth(startDay.getUTCMonth() - 1);
  return {
    from: dayStart(startDay.toISOString().slice(0, 10), timezone).toISOString(),
    to: end.toISOString(),
    timezone,
    coverage:
      cadence === "monthly"
        ? "previous-calendar-month"
        : "previous-seven-local-days",
  };
}

type Flag = {
  page_id: string;
  state: string;
  revision: number;
  data: Record<string, any>;
};
type ClaimProjection = Pick<
  Claim,
  | "id"
  | "pageId"
  | "pageVersion"
  | "key"
  | "value"
  | "kind"
  | "conditions"
  | "exceptions"
  | "validFrom"
  | "validTo"
  | "uncertainty"
  | "protected"
> & {
  evidence: {
    id: string;
    kind: string;
    sourceId: string | null;
    sourceVersion: string | null;
    parentIds: string[];
    location: Evidence["location"] | null;
  }[];
  verification: "not-assessed";
};
/** Every included claim's entire evidence ancestry must fit the sealed source
 * ceiling. No review/proof badge is promoted to independent verification here. */
async function claimsFor(
  db: PoolClient,
  ctx: Context,
  state: State,
): Promise<ClaimProjection[]> {
  const pages = new Set(state.pages.map((p) => p.id)),
    sources = new Set(state.sources.map((s) => s.id));
  const all = (
    await db.query(
      "SELECT data FROM refinement_evidence WHERE workspace_id=$1",
      [ctx.workspaceId],
    )
  ).rows.map((r) => r.data as Evidence);
  const byId = new Map(all.map((e) => [e.id, e]));
  const rows = (
    await db.query(
      "SELECT data FROM refinement_claims WHERE workspace_id=$1 AND data->>'pageId'=ANY($2::text[]) ORDER BY id LIMIT 101",
      [ctx.workspaceId, [...pages]],
    )
  ).rows;
  if (rows.length > 100) throw Error("INPUT_LIMIT");
  const result: ClaimProjection[] = [];
  for (const { data: c } of rows as { data: Claim }[]) {
    const ancestors = new Map<string, Evidence>(),
      visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (ancestors.has(id)) return true;
      const e = byId.get(id);
      if (
        !e ||
        visiting.has(id) ||
        visiting.size >= 100 ||
        (e.sourceId && !sources.has(e.sourceId))
      )
        return false;
      if (!e.sourceId && !e.parentIds.length) return false;
      visiting.add(id);
      if (!e.parentIds.every(visit)) return false;
      visiting.delete(id);
      ancestors.set(id, e);
      return true;
    };
    if (!c.evidenceIds.every(visit)) continue;
    result.push({
      id: c.id,
      pageId: c.pageId,
      pageVersion: c.pageVersion,
      key: c.key,
      value: c.value,
      kind: c.kind,
      conditions: c.conditions,
      exceptions: c.exceptions,
      validFrom: c.validFrom,
      validTo: c.validTo,
      uncertainty: c.uncertainty,
      protected: c.protected,
      evidence: [...ancestors.values()].map((e) => ({
        id: e.id,
        kind: e.kind,
        sourceId: e.sourceId ?? null,
        sourceVersion: e.sourceVersion ?? null,
        parentIds: e.parentIds,
        location: e.location ?? null,
      })),
      verification: "not-assessed",
    });
  }
  return result;
}
export function weeklyFindings(
  state: State,
  claims: ClaimProjection[],
  flags: Flag[],
  at: Date,
): MaintenanceFinding[] {
  const findings: MaintenanceFinding[] = [],
    seen = new Set<string>();
  const add = (
    kind: MaintenanceFinding["kind"],
    pageIds: string[],
    reason: string,
    claimIds?: string[],
  ) => {
    const f = {
      kind,
      pageIds: [...new Set(pageIds)].sort(),
      reason,
      authority: "review-candidate" as const,
      ...(claimIds ? { claimIds: [...claimIds].sort() } : {}),
    };
    const key = fingerprint(f);
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };
  for (const p of state.pages) {
    if (
      !(p.links ?? []).length &&
      !state.pages.some((other) => (other.links ?? []).includes(p.id))
    )
      add(
        "connection-gap",
        [p.id],
        "No incoming or outgoing connection in the approved visible corpus; omitted context may exist.",
      );
    if (!current(p).sourceIds.length)
      add("evidence-gap", [p.id], "Published version has no source reference.");
    const f = flags.find((f) => f.page_id === p.id);
    if (
      (f?.data.reviewDue && Date.parse(f.data.reviewDue) < +at) ||
      +at - Date.parse(current(p).at) > 90 * 86400000
    )
      add(
        "stale-review",
        [p.id],
        "Review date overdue or published version older than 90 days; age alone does not prove incorrect knowledge.",
      );
  }
  for (let i = 0; i < state.pages.length; i++)
    for (const b of state.pages.slice(i + 1)) {
      const a = state.pages[i];
      if (a.scope !== b.scope) continue;
      if (current(a).content.trim() === current(b).content.trim())
        add(
          "duplicate-page",
          [a.id, b.id],
          "Exact published content matches; human review must preserve distinct applicability and provenance.",
        );
      else if (
        a.tags.some((t) => b.tags.includes(t)) ||
        (a.category && a.category === b.category)
      )
        add(
          "topic-consolidation",
          [a.id, b.id],
          "Shared tag or document category; candidate for topic review, not semantic equivalence.",
        );
    }
  for (let i = 0; i < claims.length; i++)
    for (const b of claims.slice(i + 1)) {
      const a = claims[i];
      if (
        a.key !== b.key ||
        fingerprint(a.conditions) !== fingerprint(b.conditions)
      )
        continue;
      add(
        a.value === b.value ? "duplicate-claim" : "conflicting-claim",
        [a.pageId, b.pageId],
        "Same explicit claim key and conditions; check exceptions, time and source lineage before consolidation.",
        [a.id, b.id],
      );
    }
  for (const c of claims)
    if (
      c.pageVersion !==
        current(state.pages.find((p) => p.id === c.pageId)!).number ||
      (c.validTo && Date.parse(c.validTo) <= +at)
    )
      add(
        "stale-review",
        [c.pageId],
        "Claim references another page version or has an expired validity interval.",
        [c.id],
      );
  if (findings.length > 1000) throw Error("OUTPUT_LIMIT");
  return findings;
}
export class MaintenanceService {
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
  ) {}
  async run(
    ctx: Context,
    cadence: "weekly" | "monthly",
    mode: "offline" | "model",
    execution: RuntimeExecution,
    at: Date,
    timezone: string,
  ) {
    const done = await execution.completed(cadence);
    if (done !== undefined) return done;
    const window = maintenanceWindow(cadence, new Date(at), timezone);
    if (cadence === "monthly") {
      if (mode !== "offline") throw Error("INVALID_MAINTENANCE_MODE");
      return transaction(this.pool, ctx.workspaceId, async (db) => {
        await execution.beforeWrite(db);
        const { state } = await this.runtime.view(db, ctx, execution);
        await execution.captureInputs(
          db,
          state.pages.map((p) => p.id),
          state.sources.map((s) => s.id),
        );
        const owners = (
          await db.query(
            "SELECT o.page_id,o.revision,o.owner_id,o.backup_id,p.active AS owner_active,b.active AS backup_active FROM governance_business_owners o LEFT JOIN access_principals p ON p.id=o.owner_id LEFT JOIN access_principals b ON b.id=o.backup_id WHERE o.workspace_id=$1 AND o.page_id=ANY($2::text[]) ORDER BY o.page_id",
            [ctx.workspaceId, state.pages.map((p) => p.id)],
          )
        ).rows;
        const policy = (
          await db.query(
            "SELECT revision,policy FROM content_retention_policies WHERE workspace_id=$1",
            [ctx.workspaceId],
          )
        ).rows[0];
        const holds = (
          await db.query(
            "SELECT content_class FROM content_retention_holds WHERE workspace_id=$1 ORDER BY content_class",
            [ctx.workspaceId],
          )
        ).rows.map((r) => r.content_class);
        // Preserve the usage API's non-admin actor ceiling. Export only actor totals,
        // never actor, credential, provider/model labels or private question text.
        const aggregate = async (from: string, to: string) =>
          (
            await db.query(
              "SELECT count(*)::int AS calls,COALESCE(sum(cost_usd),0)::float8 AS known_cost,count(*) FILTER(WHERE cost_usd IS NULL)::int AS unknown_cost,count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::int AS unknown_tokens,COALESCE(sum(input_tokens),0)::float8 AS input_tokens,COALESCE(sum(output_tokens),0)::float8 AS output_tokens FROM model_usage_events WHERE workspace_id=$1 AND at >= $2 AND at < $3 AND principal_id=$4",
              [ctx.workspaceId, from, to, ctx.principalId],
            )
          ).rows[0];
        const usage = await aggregate(window.from, window.to);
        const priorWindow = maintenanceWindow(
          "monthly",
          new Date(window.from),
          timezone,
        );
        const priorUsage = await aggregate(priorWindow.from, priorWindow.to);
        const complete =
          usage.unknown_cost === 0 && priorUsage.unknown_cost === 0;
        const trend = {
          window: priorWindow,
          previous: {
            calls: priorUsage.calls,
            knownCostUsd: priorUsage.known_cost,
            unknownCostCalls: priorUsage.unknown_cost,
          },
          knownCostDeltaUsd: complete
            ? usage.known_cost - priorUsage.known_cost
            : null,
          status: complete ? "complete-measurement" : "incomplete-measurement",
        };
        return execution.persist(db, cadence, async () => ({
          cadence,
          engine: "structural",
          window,
          humanReviewRequired: true,
          proposalOnly: true,
          proposals: [
            {
              kind: "ownership-review",
              pages: state.pages.map((p) => {
                const o = owners.find((o) => o.page_id === p.id);
                return {
                  pageId: p.id,
                  pageVersion: current(p).number,
                  owner: o?.owner_id ?? null,
                  backup: o?.backup_id ?? null,
                  revision: o?.revision ?? null,
                  status: !o
                    ? "unknown"
                    : o.owner_active && o.backup_active
                      ? "recorded"
                      : "inactive-owner-or-backup",
                };
              }),
              action:
                "Review recorded business responsibility. Page author and authorization role are not ownership evidence.",
            },
            {
              kind: "retention-review",
              classifications: state.pages.map((p) => ({
                pageId: p.id,
                pageVersion: current(p).number,
                category: p.category,
                scope: p.scope,
                retainedVersionCount: p.versions.length,
                sourceIds: current(p).sourceIds,
                action:
                  "Review classification and current retention policy; no discard decision inferred.",
              })),
              policyRevision: policy?.revision ?? null,
              policy: policy?.policy ?? null,
              holds,
              action:
                "Review current policy and legal holds in the retention workflow; no deletion or policy update is performed.",
            },
            {
              kind: "cost-review",
              trend,
              usage: {
                scope: "execution-principal-in-authorized-space",
                calls: usage.calls,
                knownCostUsd: usage.known_cost,
                unknownCostCalls: usage.unknown_cost,
                unknownTokenCalls: usage.unknown_tokens,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              },
              action:
                "Review measured usage and missing metering. Missing prices are unknown, not zero cost.",
            },
          ],
        }));
      });
    }
    const captured = await transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        await execution.beforeWrite(db);
        const snapshot = await this.runtime.view(db, ctx, execution),
          state = snapshot.state;
        await execution.captureInputs(
          db,
          state.pages.map((p) => p.id),
          state.sources.map((s) => s.id),
        );
        const envelope = await captureEnvelope(
          db,
          ctx,
          state,
          state.pages.map((p) => p.id),
          state.sources.map((s) => s.id),
        );
        const flags = (
          await db.query(
            "SELECT page_id,state,revision,data FROM workflow_document_state WHERE workspace_id=$1 AND page_id=ANY($2::text[]) ORDER BY page_id",
            [ctx.workspaceId, state.pages.map((p) => p.id)],
          )
        ).rows as Flag[];
        const claims = await claimsFor(db, ctx, state);
        const eligible = [];
        for (const p of state.pages)
          if (await currentRecommendation(db, ctx, p.id)) eligible.push(p);
        return { ...snapshot, envelope, flags, claims, eligible };
      },
    );
    const { state, envelope, flags, claims, eligible } = captured;
    const findings = weeklyFindings(state, claims, flags, new Date(at));
    const input = {
      phase: "weekly-maintenance",
      window,
      pages: eligible.map((p) => ({
        ...p,
        versions: undefined,
        content: current(p).content,
        baseVersion: current(p).number,
        documentProtection:
          flags.find((f) => f.page_id === p.id)?.data.protected ?? false,
      })),
      sources: state.sources,
      claims,
      findings,
    };
    const contextFingerprint = fingerprint(input);
    if (Buffer.byteLength(JSON.stringify(input)) > 750000)
      throw Error("INPUT_LIMIT");
    const sealed = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await execution.beforeWrite(db);
      return execution.persist(db, "weekly-input", async () => input);
    });
    if (fingerprint(sealed) !== contextFingerprint)
      throw Error("STALE_VERSION");
    const check = async (db: PoolClient) => {
      await execution.beforeWrite(db);
      const fresh = (await this.runtime.view(db, ctx, execution)).state;
      const freshClaims = await claimsFor(db, ctx, fresh);
      if (fingerprint(freshClaims) !== fingerprint(claims))
        throw Error("STALE_VERSION");
      for (const p of eligible)
        if (!(await currentRecommendation(db, ctx, p.id)))
          throw Error("STALE_VERSION");
    };
    let proposal: null | { id: string; hash: string } = null;
    let reason =
      "Structural checks only; no semantic synthesis or automatic page rewrite was performed.";
    let binding: Awaited<ReturnType<typeof bindModelTransmission>> | undefined;
    if (mode === "model" && eligible.length && state.sources.length) {
      if (new Set(state.sources.map((s) => s.scope)).size !== 1)
        throw Error("SOURCE_SCOPE_CONFLICT");
      binding = await bindModelTransmission(
        this.pool,
        ctx,
        "ingest",
        envelope,
        {
          ...execution.modelOptions,
          pool: this.pool,
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
        },
      );
      const raw = await execution.modelResult("ingest", () =>
        this.runtime.model("ingest", input, binding!.options),
      );
      const output = z
        .object({
          updates: z.array(z.unknown()).max(execution.maxChanges),
          reason: z.string().min(1).max(2000),
          noChanges: z.boolean().optional(),
        })
        .strict()
        .parse(raw);
      if (output.noChanges && output.updates.length)
        throw Error("MODEL_INVALID");
      reason = output.reason;
      let updates: Draft[] = output.updates.length
        ? drafts.parse(output.updates)
        : [];
      const allSources = state.sources.map((s) => s.id),
        allowedPages = new Set(eligible.map((p) => p.id));
      for (const d of updates) {
        if (claims.some((c) => c.pageId === d.id && c.protected))
          throw Error("DOCUMENT_PROTECTED");
        if (d.baseVersion > 0 && !allowedPages.has(d.id))
          throw Error("EXECUTION_SCOPE_CONFLICT");
        if (d.sourceIds.some((id) => !allSources.includes(id)))
          throw Error("EXECUTION_SCOPE_CONFLICT");
        if (
          d.links.some(
            (id) => !allowedPages.has(id) && !updates.some((u) => u.id === id),
          )
        )
          throw Error("EXECUTION_SCOPE_CONFLICT");
      }
      // All transmitted context can influence prose, even when the model omits it.
      updates = updates.map((d) => ({
        ...d,
        sourceIds: [...new Set([...d.sourceIds, ...allSources])],
      }));
      updates = updates.filter((d) => {
        const p = state.pages.find((p) => p.id === d.id);
        if (!p) return true;
        if (d.baseVersion !== current(p).number) throw Error("STALE_VERSION");
        return digest(d) !== digest(draftOf(p));
      });
      const prior = await execution.completed("ingest");
      if (prior !== undefined)
        proposal = z.object({ id: z.string(), hash: z.string() }).parse(prior);
      else if (updates.length)
        proposal = await propose(
          this.pool,
          ctx,
          drafts.parse(updates),
          allSources,
          {
            expectedStateHash: captured.fingerprint,
            mode: "model",
            dependencyIds: state.pages.map((p) => p.id),
            inputEnvelope: envelope,
            producer: await execution.producer("model"),
            onCreated: async (db, result) => {
              await binding!.recheck(db);
              await check(db);
              await execution.proposalCreated(db, result, updates);
            },
          },
        );
    } else if (mode === "model")
      reason =
        "No eligible published knowledge with source context; no model call or semantic synthesis was performed.";
    await ctx.authorization?.revalidate();
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await binding?.recheck(db);
      await check(db);
      return execution.persist(db, cadence, async () => ({
        cadence,
        engine: execution.modelWasUsed() ? "model" : "structural",
        window,
        findings,
        proposal,
        reason,
        input,
        contextFingerprint,
        humanReviewRequired: true,
        proposalOnly: true,
        noChanges: proposal === null,
        semanticQuality: "not-evaluated",
      }));
    });
  }
}
