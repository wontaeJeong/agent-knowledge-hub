import { randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../database";
import type { Context } from "../service";
import { authorizeInTransaction } from "../access";
import { loadState, membership } from "../repository";
import { captureEnvelope, fingerprint, versionProvenance } from "../provenance";
import { assertDraftNotRetired } from "./drafts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const metadata = z.object({
  id,
  pageId: id,
  baseVersion: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
  sourceIds: z.array(id).max(100).default([]),
  dependencyVersions: z.record(id, z.number().int().positive()).default({}),
});
const bindingSchema = metadata
  .extend({
    principalId: id,
    workspaceId: id,
    lineageHash: z.string().regex(/^[a-f0-9]{64}$/),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int(),
    cacheBinding: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RecoveryBinding = z.infer<typeof bindingSchema>;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");

/** Deliberately separate from configurable WorkflowAuthorizer: canonical local.copy
 * is mandatory, including when an embedding host supplies a permissive test adapter.
 * This opaque binding is not an authentication token and contains no roles/grants.
 */
export class DraftRecoveryService {
  constructor(
    readonly pool: Pool,
    readonly clock = Date.now,
  ) {}
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      return work(db);
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async ancestry(
    db: PoolClient,
    ctx: Context,
    d: z.infer<typeof metadata>,
  ) {
    await assertDraftNotRetired(db, ctx, d.id);
    await authorizeInTransaction(db, ctx, "draft.write", {
      kind: "page",
      id: d.pageId,
    });
    const state = await loadState(db, ctx.workspaceId);
    const page = state.pages.find((p) => p.id === d.pageId);
    if (!page || page.versions.at(-1)?.number !== d.baseVersion)
      throw Error("STALE_VERSION");
    for (const [id, version] of Object.entries(d.dependencyVersions))
      if (
        state.pages.find((p) => p.id === id)?.versions.at(-1)?.number !==
        version
      )
        throw Error("STALE_VERSION");
    const history = (
      await db.query(
        "SELECT data FROM workflow_draft_revision_history WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 UNION ALL SELECT data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.principalId, d.id],
      )
    ).rows;
    const historyPages = history
      .flatMap((r) => [
        r.data.pageId,
        ...Object.keys(r.data.dependencyVersions ?? {}),
      ])
      .filter((p): p is string => typeof p === "string");
    const historySources: string[] = history.flatMap(
      (r) => r.data.sourceIds ?? [],
    );
    const envelope = await captureEnvelope(
      db,
      ctx,
      state,
      [d.pageId, ...Object.keys(d.dependencyVersions), ...historyPages],
      [...d.sourceIds, ...historySources],
    );
    for (const pageId of envelope.pageIds) {
      await authorizeInTransaction(db, ctx, "local.copy", {
        kind: "page",
        id: pageId,
      });
      // Current and ALL historical source lineage, not merely the head version.
      for (const v of state.pages.find((p) => p.id === pageId)!.versions)
        for (const sid of [...v.sourceIds, ...versionProvenance(v).sourceIds])
          if (!envelope.sourceIds.includes(sid))
            throw Error("POLICY_UNAVAILABLE");
    }
    const policies = [];
    for (const sourceId of envelope.sourceIds) {
      await authorizeInTransaction(db, ctx, "local.copy", {
        kind: "source",
        id: sourceId,
      });
      const p = (
        await db.query(
          "SELECT local_copy_allowed,revision FROM access_source_policy WHERE workspace_id=$1 AND source_id=$2",
          [ctx.workspaceId, sourceId],
        )
      ).rows[0];
      if (p?.local_copy_allowed !== true) throw Error("FORBIDDEN");
      policies.push({ sourceId, ...p });
    }
    return {
      lineageHash: fingerprint(envelope),
      policyHash: fingerprint(policies),
    };
  }
  async permission(ctx: Context, input: unknown): Promise<RecoveryBinding> {
    const d = metadata.parse(input);
    if (Object.keys(d.dependencyVersions).length > 100)
      throw Error("VALIDATION_FAILED");
    return this.run(ctx, async (db) => {
      const ancestry = await this.ancestry(db, ctx, d);
      const cacheBinding = randomBytes(32).toString("hex");
      const binding = {
        ...d,
        ...ancestry,
        principalId: ctx.principalId,
        workspaceId: ctx.workspaceId,
        expiresAt: this.clock() + 300000,
        cacheBinding,
      };
      // Expiry invalidates further writes, not a promise of retroactive physical erasure.
      await db.query(
        "DELETE FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2 AND expires_at < $3",
        [ctx.workspaceId, ctx.principalId, new Date(this.clock())],
      );
      const count = await db.query(
        "SELECT count(*)::int AS n FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2",
        [ctx.workspaceId, ctx.principalId],
      );
      if (count.rows[0].n >= 100) throw Error("RECOVERY_GRANT_BOUND");
      await db.query(
        "INSERT INTO workflow_draft_recovery_grants(workspace_id,owner_id,nonce_hash,binding,expires_at) VALUES($1,$2,$3,$4,$5)",
        [
          ctx.workspaceId,
          ctx.principalId,
          hash(cacheBinding),
          { ...binding, cacheBinding: undefined },
          new Date(binding.expiresAt),
        ],
      );
      return binding;
    });
  }
  async validate(ctx: Context, input: unknown) {
    const { binding } = z
      .object({ binding: bindingSchema })
      .strict()
      .parse(input);
    return this.run(ctx, async (db) => {
      if (
        binding.principalId !== ctx.principalId ||
        binding.workspaceId !== ctx.workspaceId
      )
        throw Error("FORBIDDEN");
      if (binding.expiresAt <= this.clock()) throw Error("RECOVERY_EXPIRED");
      const row = (
        await db.query(
          "SELECT binding FROM workflow_draft_recovery_grants WHERE workspace_id=$1 AND owner_id=$2 AND nonce_hash=$3 AND expires_at>$4",
          [
            ctx.workspaceId,
            ctx.principalId,
            hash(binding.cacheBinding),
            new Date(this.clock()),
          ],
        )
      ).rows[0];
      const { cacheBinding: _, ...bound } = binding;
      if (!row || fingerprint(row.binding) !== fingerprint(bound))
        throw Error("FORBIDDEN");
      const fresh = await this.ancestry(db, ctx, metadata.parse(binding));
      if (
        fresh.policyHash !== binding.policyHash ||
        fresh.lineageHash !== binding.lineageHash
      )
        throw Error("RECOVERY_POLICY_CHANGED");
      const draft = (
        await db.query(
          "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
          [ctx.workspaceId, ctx.principalId, binding.id],
        )
      ).rows[0];
      const revision = draft?.revision ?? 0;
      // No automatic last-writer-wins. The caller must explicitly select/merge then submit a new CAS.
      return {
        status:
          revision === binding.expectedRevision
            ? ("ready" as const)
            : ("conflict" as const),
        revision,
        serverDraft: draft ? { ...draft.data, revision } : null,
      };
    });
  }
}
