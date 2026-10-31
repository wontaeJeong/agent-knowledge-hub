import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type {
  WorkflowAuthorizer,
  WorkflowResource,
} from "../workflows/service";
import { transaction } from "../database";
import { audit, loadState, membership, requireRead } from "../repository";
import {
  visiblePageIds,
  captureEnvelope,
  inheritedProvenance,
} from "../provenance";
import { digest } from "../publication";
import {
  claimInput,
  evidenceInput,
  id,
  conditions,
  compareClaims,
  lineageRoots,
  selectContext,
  type Claim,
  type Evidence,
} from "./logic";
import type { SemanticLintProvider } from "./semantic";
import { semanticProviderEndpoint } from "./semantic";
import { bindModelTransmission } from "../policy/binding";
import { prepareTransmission } from "../policy/model";
import { assertFeature } from "../policy/features";
import {
  assertSafeModelInput,
  validateFindings,
  SEMANTIC_LINT_CONTRACT_VERSION,
} from "./semantic";
import type { RuntimeExecution } from "../runtime/knowledge";
import {
  createExecutionChallenge,
  type ExecutionBinding,
  type ExecutionProof,
  type ExecutionVerifier,
  type ExecutionVerification,
} from "./execution";

const contextInput = z
  .object({
    asOf: z.iso.datetime().optional(),
    environment: conditions,
    pageIds: z.array(id).max(100).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    includeHistory: z.boolean().default(false),
  })
  .strict();
type ContextOptions = z.infer<typeof contextInput>;
const semanticPublicInput = z
  .object({ semantic: z.literal(true), context: contextInput })
  .strict();
const semanticSealedInput = semanticPublicInput
  .extend({
    context: contextInput.extend({
      asOf: z.iso.datetime(),
      includeHistory: z.literal(true),
    }),
    contractVersion: z.literal(SEMANTIC_LINT_CONTRACT_VERSION),
    claimIds: z
      .array(id)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export interface SemanticJobAdapter {
  prepare(
    db: PoolClient,
    ctx: Context,
    input: unknown,
  ): Promise<{
    payload: Record<string, unknown>;
    pageIds: string[];
    sourceIds: string[];
  }>;
  execute(
    ctx: Context,
    payload: Record<string, unknown>,
    execution: RuntimeExecution,
  ): Promise<unknown>;
}
const outcomeInput = z
  .object({
    id,
    claimIds: z.array(id).min(1).max(100),
    usedVersions: z
      .array(
        z.object({ pageId: id, version: z.number().int().positive() }).strict(),
      )
      .min(1)
      .max(100),
    result: z.enum(["success", "partial", "failure", "unknown"]),
    problem: z.string().min(1).max(5000),
    attempt: z.string().min(1).max(10000),
    observations: z.string().min(1).max(10000),
    conditions,
    evidenceIds: z.array(id).max(100),
    lesson: z.string().min(1).max(5000),
    limits: z.string().min(1).max(5000),
  })
  .strict();
type Outcome = z.infer<typeof outcomeInput> & {
  humanValidation: "unreviewed" | "confirmed" | "rejected";
  recordedAt: string;
  recordedBy: string;
};
type Request = {
  id: string;
  claimIds: string[];
  reason: string;
  status: "pending-review";
  recordedAt: string;
  recordedBy: string;
  agentOutcomeId?: string;
  outcomeId?: string;
  usedVersions?: { page_id: string; version: number }[];
  rootLineage?: { sourceId: string }[];
  [key: string]: unknown;
};
type ClaimReview = {
  id: string;
  kind: "review";
  claimIds: string[];
  evidenceIds: string[];
  status: "reviewed" | "execution-verified" | "rejected";
  verifiedAt: string;
  recordedAt: string;
  recordedBy: string;
  attestationStatus?: "confirmed" | "unverified";
  attestationError?: string;
  executionReceipts?: {
    receiptId: string;
    provider: string;
    executionId: string;
    executorId: string;
    executedAt: string;
    outcome: string;
    sourceId: string;
    sourceVersion: string;
    location: { start: number; end: number };
  }[];
};
export interface RefinementOptions {
  executionVerifier?: ExecutionVerifier;
}
const tables = {
  evidence: "refinement_evidence",
  claims: "refinement_claims",
  outcomes: "refinement_outcomes",
  requests: "refinement_requests",
  reviews: "refinement_reviews",
} as const;
const signalCursorKey = randomBytes(32);
const signalImportInput = z
  .object({
    outcomeId: id.optional(),
    cursor: z
      .string()
      .min(40)
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict()
  .refine(
    (d) => !(d.outcomeId && d.cursor),
    "targeted import cannot use a batch cursor",
  );
function signalCursor(ctx: Context, after: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", signalCursorKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({
        workspaceId: ctx.workspaceId,
        principalId: ctx.principalId,
        credentialId: ctx.credentialId ?? null,
        after,
        expiresAt: Date.now() + 15 * 60 * 1000,
      }),
      "utf8",
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
function readSignalCursor(ctx: Context, cursor: string): string {
  try {
    const packed = Buffer.from(cursor, "base64url"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        signalCursorKey,
        packed.subarray(0, 12),
      );
    decipher.setAuthTag(packed.subarray(12, 28));
    const d = JSON.parse(
      Buffer.concat([
        decipher.update(packed.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
    if (
      d.workspaceId !== ctx.workspaceId ||
      d.principalId !== ctx.principalId ||
      d.credentialId !== (ctx.credentialId ?? null) ||
      !Number.isFinite(d.expiresAt) ||
      d.expiresAt <= Date.now()
    )
      throw Error("invalid");
    return id.parse(d.after);
  } catch {
    throw Error("INVALID_CURSOR");
  }
}
type Table = keyof typeof tables;

/** No live wiki mutation: every refinement is an immutable observation + durable review request. */
export class RefinementService {
  constructor(
    readonly pool: Pool,
    readonly authorize: WorkflowAuthorizer,
    readonly provider?: SemanticLintProvider,
    readonly options: RefinementOptions = {},
  ) {
    if (typeof authorize !== "function") throw Error("AUTHORIZER_REQUIRED");
    const verifier = options.executionVerifier;
    if (
      verifier &&
      (!id.safeParse(verifier.provider).success ||
        typeof verifier.verify !== "function" ||
        typeof verifier.assertProof !== "function")
    )
      throw Error("EXECUTION_VERIFIER_CONFIGURATION");
  }
  private async run<T>(
    ctx: Context,
    action: string,
    resource: WorkflowResource | undefined,
    work: (db: PoolClient) => Promise<T>,
  ) {
    await ctx.authorization?.revalidate();
    const result = await transaction(this.pool, ctx.workspaceId, async (db) => {
      await membership(db, ctx);
      await ctx.authorization?.assertSession(db);
      await this.authorize(db, ctx, action, resource);
      const r = await work(db);
      await ctx.authorization?.assertSession(db);
      return r;
    });
    await ctx.authorization?.revalidate();
    return result;
  }
  private async all<T>(
    db: PoolClient,
    ctx: Context,
    table: Table,
  ): Promise<T[]> {
    return (
      await db.query(
        `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 ORDER BY id`,
        [ctx.workspaceId],
      )
    ).rows.map((r) => r.data);
  }
  private async get<T>(
    db: PoolClient,
    ctx: Context,
    table: Table,
    key: string,
  ): Promise<T> {
    const r = await db.query(
      `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, id.parse(key)],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    return r.rows[0].data;
  }
  private async put<T extends { id: string }>(
    db: PoolClient,
    ctx: Context,
    table: Table,
    value: T,
  ): Promise<T> {
    const old = await db.query(
      `SELECT data FROM ${tables[table]} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, value.id],
    );
    if (old.rowCount) {
      const { recordedAt: _, recordedBy: __, ...prior } = old.rows[0].data;
      const {
        recordedAt: ___,
        recordedBy: ____,
        ...next
      } = value as T & { recordedAt?: string; recordedBy?: string };
      if (table === "reviews") {
        delete prior.verifiedAt;
        delete (next as Record<string, unknown>).verifiedAt;
      }
      if (digest(prior) !== digest(next)) throw Error("IDEMPOTENCY_CONFLICT");
      return old.rows[0].data;
    }
    await db.query(`INSERT INTO ${tables[table]} VALUES($1,$2,$3)`, [
      ctx.workspaceId,
      value.id,
      value,
    ]);
    await audit(db, ctx, `refinement.${table}.create`, value.id);
    return value;
  }
  private stamp(ctx: Context) {
    return {
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.principalId,
    };
  }
  async sourceSnapshot(ctx: Context, input: unknown) {
    const d = z.object({ sourceId: id }).strict().parse(input);
    return this.run(
      ctx,
      "knowledge.read",
      { kind: "source", id: d.sourceId },
      async (db) => {
        const source = await this.source(db, ctx, d.sourceId);
        return {
          id: d.sourceId,
          title: source.title,
          content: source.content,
          sourceVersion: digest(source),
        };
      },
    );
  }
  private async page(
    db: PoolClient,
    ctx: Context,
    pageId: string,
    version: number,
  ) {
    await this.authorize(db, ctx, "knowledge.read", {
      kind: "page",
      id: pageId,
    });
    const state = await loadState(db, ctx.workspaceId);
    if (!(await visiblePageIds(db, ctx, state)).has(pageId))
      throw Error("NOT_FOUND");
    const page = state.pages.find((p) => p.id === pageId),
      v = page?.versions.find((v) => v.number === version);
    if (!v) throw Error("NOT_FOUND");
    for (const sourceId of v.sourceIds) await this.source(db, ctx, sourceId);
    return { page: page!, version: v };
  }
  private async source(db: PoolClient, ctx: Context, sourceId: string) {
    await this.authorize(db, ctx, "knowledge.read", {
      kind: "source",
      id: sourceId,
    });
    await requireRead(db, ctx, "source", sourceId);
    const r = await db.query(
      "SELECT data FROM sources WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, sourceId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    return r.rows[0].data;
  }
  private async evidence(
    db: PoolClient,
    ctx: Context,
    evidenceId: string,
    seen = new Set<string>(),
    checked = new Map<string, Evidence>(),
  ): Promise<Evidence> {
    if (seen.has(evidenceId)) throw Error("CIRCULAR_EVIDENCE");
    if (checked.has(evidenceId)) return checked.get(evidenceId)!;
    if (seen.size >= 256) throw Error("EVIDENCE_DEPTH_LIMIT");
    const e = await this.get<Evidence>(db, ctx, "evidence", evidenceId),
      next = new Set(seen).add(evidenceId);
    if (e.sourceId) await this.source(db, ctx, e.sourceId);
    for (const p of e.parentIds) await this.evidence(db, ctx, p, next, checked);
    checked.set(evidenceId, e);
    return e;
  }
  private async claim(
    db: PoolClient,
    ctx: Context,
    claimId: string,
    checked = new Map<string, Claim>(),
    seen = new Set<string>(),
  ): Promise<Claim> {
    if (seen.has(claimId)) throw Error("CIRCULAR_EVIDENCE");
    if (checked.has(claimId)) return checked.get(claimId)!;
    if (seen.size >= 256) throw Error("EVIDENCE_DEPTH_LIMIT");
    const next = new Set(seen).add(claimId);
    const c = await this.get<Claim>(db, ctx, "claims", claimId);
    await this.page(db, ctx, c.pageId, c.pageVersion);
    for (const eid of c.evidenceIds) await this.evidence(db, ctx, eid);
    for (const parent of c.supersedes) {
      // Claims only point to already-existing immutable ancestors.
      await this.claim(db, ctx, parent, checked, next);
    }
    checked.set(claimId, c);
    return c;
  }
  private async request(
    db: PoolClient,
    ctx: Context,
    claimIds: string[],
    reason: string,
    key: string,
    extra: Record<string, unknown> = {},
  ) {
    return this.put(db, ctx, "requests", {
      ...extra,
      id: key,
      claimIds,
      reason,
      status: "pending-review" as const,
      ...this.stamp(ctx),
    });
  }
  private async prepareEvidence(
    db: PoolClient,
    ctx: Context,
    d: z.infer<typeof evidenceInput>,
  ) {
    if (d.parentIds.includes(d.id)) throw Error("CIRCULAR_EVIDENCE");
    if (d.verifiedAt !== null) throw Error("VERIFICATION_REQUIRES_REVIEW");
    if (d.kind === "review") throw Error("REVIEW_REQUIRES_HUMAN");
    if (
      d.kind === "independent-execution" &&
      (!d.executionId || d.parentIds.length || !d.sourceId)
    )
      throw Error("EVIDENCE_INVALID");
    if (
      (d.kind === "inference" || d.kind === "hypothesis") &&
      !d.parentIds.length
    )
      throw Error("EVIDENCE_MISSING");
    let root: string | null = null;
    if (d.sourceId) {
      const source = await this.source(db, ctx, d.sourceId),
        loc = d.location;
      if (
        d.sourceVersion !== digest(source) ||
        !loc ||
        loc.end <= loc.start ||
        source.content.slice(loc.start, loc.end) !== loc.quote
      )
        throw Error("EVIDENCE_INVALID");
      // Conservative content fingerprint: duplicate source imports are not independent support.
      if (!d.parentIds.length) root = `source:${digest(source.content)}`;
    } else if (d.sourceVersion || d.location) throw Error("EVIDENCE_INVALID");
    if (!root && !d.parentIds.length) throw Error("EVIDENCE_MISSING");
    for (const parent of d.parentIds) await this.evidence(db, ctx, parent);
    const old = await db.query(
      "SELECT data FROM refinement_evidence WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, d.id],
    );
    if (old.rowCount) {
      const {
        root: _,
        recordedAt: __,
        recordedBy: ___,
        executionVerification: ____,
        ...prior
      } = old.rows[0].data as Evidence;
      if (digest(prior) !== digest(d)) throw Error("IDEMPOTENCY_CONFLICT");
      await this.evidence(db, ctx, d.id);
      return { root, existing: old.rows[0].data as Evidence };
    }
    return { root, existing: undefined };
  }
  private executionBinding(
    ctx: Context,
    e: z.infer<typeof evidenceInput>,
  ): ExecutionBinding {
    if (!e.executionId || !e.sourceId || !e.sourceVersion || !e.location)
      throw Error("INDEPENDENT_EXECUTION_REQUIRED");
    return {
      workspaceId: ctx.workspaceId,
      evidenceId: e.id,
      executionId: e.executionId,
      sourceId: e.sourceId,
      sourceVersion: e.sourceVersion,
      location: e.location,
    };
  }
  async addEvidence(ctx: Context, input: unknown) {
    const d = evidenceInput.parse(input);
    const prepared = await this.run(ctx, "changeset.propose", undefined, (db) =>
      this.prepareEvidence(db, ctx, d),
    );
    if (prepared.existing) return prepared.existing;
    let executionVerification: ExecutionVerification | undefined;
    let transmissionCheck: ((db: PoolClient) => Promise<void>) | undefined;
    const verifier = this.options.executionVerifier;
    if (d.kind === "independent-execution") {
      executionVerification = {
        status: "unverified",
        reason: "EXECUTION_VERIFIER_UNCONFIGURED",
      };
      if (verifier) {
        const binding = this.executionBinding(ctx, d),
          challenge = createExecutionChallenge(binding, verifier.provider);
        const policyRequired = Boolean(
          ctx.authorization || ctx.credentialId || verifier.destinationUrl,
        );
        const prepare = async (endpoint: string) => {
          const destinationId =
            process.env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_DESTINATION_ID;
          if (!destinationId) throw Error("MODEL_TRANSMISSION_DENIED");
          transmissionCheck = await prepareTransmission(
            this.pool,
            ctx,
            {
              destinationId,
              purpose: "execution-verification",
              pageIds: [],
              sourceIds: [binding.sourceId],
            },
            endpoint,
          );
        };
        if (policyRequired) {
          const endpoint =
            verifier.destinationUrl ??
            process.env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_URL;
          if (!endpoint) throw Error("EXECUTION_VERIFIER_UNCONFIGURED");
          await prepare(endpoint);
        }
        // No DB transaction/client/lock is held while invoking the external trusted gateway.
        executionVerification = verifier.assertProof(
          await verifier.verify(
            challenge,
            policyRequired ? { beforeTransmission: prepare } : undefined,
          ),
          binding,
        );
      }
    }
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      // All ACLs, parent provenance and canonical source identity are checked again after the await.
      const fresh = await this.prepareEvidence(db, ctx, d);
      await transmissionCheck?.(db);
      if (fresh.existing) return fresh.existing;
      if (executionVerification?.status === "attested") {
        const proof = verifier!.assertProof(
          executionVerification,
          this.executionBinding(ctx, d),
        );
        const replay = await db.query(
          "SELECT 1 FROM refinement_evidence WHERE workspace_id=$1 AND id<>$2 AND data->'executionVerification'->>'status'='attested' AND data->'executionVerification'->>'provider'=$3 AND (data->'executionVerification'->'receipt'->>'receiptId'=$4 OR data->>'executionId'=$5)",
          [
            ctx.workspaceId,
            d.id,
            proof.provider,
            proof.receipt.receiptId,
            d.executionId,
          ],
        );
        if (replay.rowCount) throw Error("EXECUTION_RECEIPT_REPLAY");
      }
      const e: Evidence = {
        ...d,
        root: fresh.root,
        ...(executionVerification ? { executionVerification } : {}),
        ...this.stamp(ctx),
      };
      lineageRoots(
        [
          ...(await this.all<Evidence>(db, ctx, "evidence")).filter(
            (e) => e.id !== d.id,
          ),
          e,
        ],
        e.id,
      );
      return this.put(db, ctx, "evidence", e);
    });
  }
  private async trustedExecutions(
    db: PoolClient,
    ctx: Context,
    evidence: Evidence[],
    claims: Claim[],
  ): Promise<ExecutionProof[]> {
    const candidates = evidence.filter(
      (e) =>
        e.kind === "independent-execution" &&
        !e.parentIds.length &&
        e.executionId,
    );
    if (!candidates.length) throw Error("INDEPENDENT_EXECUTION_REQUIRED");
    const verifier = this.options.executionVerifier;
    if (!verifier) throw Error("EXECUTION_VERIFIER_UNCONFIGURED");
    const proofs: ExecutionProof[] = [];
    for (const e of candidates) {
      if (e.executionVerification?.status !== "attested") continue;
      if (e.executionVerification.provider !== verifier.provider)
        throw Error("EXECUTION_VERIFIER_CONFIGURATION");
      const currentSource = await this.source(db, ctx, e.sourceId!);
      if (digest(currentSource) !== e.sourceVersion)
        throw Error("EXECUTION_SOURCE_CHANGED");
      proofs.push(
        verifier.assertProof(
          e.executionVerification,
          this.executionBinding(ctx, e),
        ),
      );
    }
    if (!proofs.length) throw Error("TRUSTED_EXECUTION_REQUIRED");
    for (const claim of claims) {
      const referenced: Evidence[] = [],
        seen = new Set<string>();
      const visit = async (eid: string): Promise<void> => {
        if (seen.has(eid)) return;
        seen.add(eid);
        const e = await this.evidence(db, ctx, eid);
        referenced.push(e);
        for (const p of e.parentIds) await visit(p);
      };
      for (const eid of claim.evidenceIds) await visit(eid);
      if (
        !proofs.some((p) =>
          referenced.some(
            (e) =>
              e.sourceId === p.receipt.sourceId &&
              e.sourceVersion === p.receipt.sourceVersion &&
              digest(e.location) === digest(p.receipt.location),
          ),
        )
      )
        throw Error("EXECUTION_CLAIM_MISMATCH");
    }
    return proofs;
  }
  async addClaim(ctx: Context, input: unknown) {
    const d = claimInput.parse(input);
    return this.run(
      ctx,
      "changeset.propose",
      { kind: "page", id: d.pageId },
      async (db) => {
        await this.page(db, ctx, d.pageId, d.pageVersion);
        if (d.verifiedAt !== null) throw Error("VERIFICATION_REQUIRES_REVIEW");
        if (d.supersedes.includes(d.id)) throw Error("CIRCULAR_EVIDENCE");
        if (d.protected) {
          if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
          await this.authorize(db, ctx, "knowledge.protect", {
            kind: "page",
            id: d.pageId,
          });
        }
        for (const oldId of d.supersedes) {
          const old = await this.claim(db, ctx, oldId);
          if (old.protected) {
            if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
            await this.authorize(db, ctx, "knowledge.protect", {
              kind: "page",
              id: old.pageId,
            });
          }
        }
        for (const eid of d.evidenceIds) await this.evidence(db, ctx, eid);
        const result = await this.put(db, ctx, "claims", {
          ...d,
          ...this.stamp(ctx),
        });
        await this.request(
          db,
          ctx,
          [d.id, ...d.supersedes],
          d.supersedes.length ? "supersession" : "new-evidence",
          `claim_${d.id}`,
        );
        return result;
      },
    );
  }
  async context(ctx: Context, input: unknown) {
    const d = contextInput.parse(input);
    return this.run(ctx, "knowledge.read", undefined, (db) =>
      this.contextDb(db, ctx, d),
    );
  }
  /** DB-only projection: usable under the queue admission lock; never calls pool/model/verifier I/O. */
  private async contextDb(
    db: PoolClient,
    ctx: Context,
    d: ContextOptions,
    pinned?: readonly string[],
  ) {
    await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await this.authorize(db, ctx, "knowledge.read");
    const all = await this.all<Claim>(db, ctx, "claims"),
      visible: Claim[] = [];
    for (const c of all) {
      if (pinned && !pinned.includes(c.id)) continue;
      if (d.pageIds && !d.pageIds.includes(c.pageId)) continue;
      try {
        await this.claim(db, ctx, c.id);
        visible.push(c);
      } catch (e) {
        if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
      }
    }
    const asOf = d.asOf ?? new Date().toISOString(),
      selected = selectContext(visible, asOf, d.environment);
    const candidates = d.includeHistory ? visible : selected.items;
    const items = [];
    const allEvidence = await this.all<Evidence>(db, ctx, "evidence");
    const reviews = await this.all<ClaimReview>(db, ctx, "reviews");
    for (const c of candidates.slice(0, d.limit)) {
      const lineage = new Map<string, Evidence>();
      const collect = async (eid: string): Promise<void> => {
        if (lineage.has(eid)) return;
        const e = await this.evidence(db, ctx, eid);
        lineage.set(eid, e);
        for (const parent of e.parentIds) await collect(parent);
      };
      for (const eid of c.evidenceIds) await collect(eid);
      const evidence = await Promise.all(
        [...lineage.values()].map(async (e) => {
          if (e.kind !== "independent-execution")
            return { ...e, executionAttestation: undefined };
          try {
            const [proof] = await this.trustedExecutions(db, ctx, [e], []);
            return {
              ...e,
              executionAttestation: {
                status: "attested-unreviewed",
                provider: proof.provider,
                executorId: proof.receipt.executorId,
                executedAt: proof.receipt.executedAt,
                outcome: proof.receipt.outcome,
              },
            };
          } catch (error) {
            if (error instanceof Error && error.message === "NOT_FOUND")
              throw error;
            return {
              ...e,
              executionAttestation: {
                status: "unverified",
                reason:
                  error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
                    ? error.message
                    : "EXECUTION_ATTESTATION_INVALID",
              },
            };
          }
        }),
      );
      const verificationReviews: ClaimReview[] = [];
      for (const r of reviews
        .filter((r) => r.claimIds?.includes(c.id))
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)))
        try {
          const reviewClaims = await Promise.all(
            r.claimIds.map((cid) => this.claim(db, ctx, cid)),
          );
          const reviewEvidence = await Promise.all(
            r.evidenceIds.map((e) => this.evidence(db, ctx, e)),
          );
          if (r.status === "execution-verified") {
            try {
              const proofs = await this.trustedExecutions(
                db,
                ctx,
                reviewEvidence,
                reviewClaims,
              );
              verificationReviews.push({
                ...r,
                attestationStatus: "confirmed",
                executionReceipts: proofs.map((p) => ({
                  receiptId: p.receipt.receiptId,
                  provider: p.provider,
                  executionId: p.receipt.executionId,
                  executorId: p.receipt.executorId,
                  executedAt: p.receipt.executedAt,
                  outcome: p.receipt.outcome,
                  sourceId: p.receipt.sourceId,
                  sourceVersion: p.receipt.sourceVersion,
                  location: {
                    start: p.receipt.location.start,
                    end: p.receipt.location.end,
                  },
                })),
              });
            } catch (error) {
              if (error instanceof Error && error.message === "NOT_FOUND")
                throw error;
              verificationReviews.push({
                ...r,
                attestationStatus: "unverified",
                attestationError:
                  error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
                    ? error.message
                    : "EXECUTION_ATTESTATION_INVALID",
              });
            }
          } else verificationReviews.push(r);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      items.push({
        ...c,
        evidence,
        independentRoots: [
          ...new Set(
            c.evidenceIds.flatMap((e) => lineageRoots(allEvidence, e)),
          ),
        ],
        verificationReviews,
        validation:
          verificationReviews.at(-1)?.status === "execution-verified" &&
          verificationReviews.at(-1)?.attestationStatus !== "confirmed"
            ? "unverified"
            : (verificationReviews.at(-1)?.status ?? "unverified"),
        authority: "review-candidate" as const,
        validAtRequestedTime: selected.items.some((s) => s.id === c.id),
        missingConditions: Object.keys(c.conditions).filter(
          (k) => d.environment[k] === undefined,
        ),
      });
    }
    const conflicts = [];
    for (let i = 0; i < items.length; i++)
      for (const b of items.slice(i + 1)) {
        const a = items[i],
          kind = compareClaims(a, b);
        if (kind !== "unrelated" && kind !== "agreement")
          conflicts.push({
            claimIds: [a.id, b.id],
            kind,
            resolution: "review-required",
          });
      }
    return {
      asOf,
      acl: "current" as const,
      temporalMode: d.includeHistory
        ? "history-not-current-recommendation"
        : "as-of",
      items,
      conflicts,
      unknownTime: selected.unknownTime,
      omitted: Math.max(0, candidates.length - items.length),
      more: "POST /api/v1/refinement/context with pageIds/limit; all evidence and exceptions stay intact",
    };
  }
  async reportOutcome(ctx: Context, input: unknown) {
    const d = outcomeInput.parse(input);
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const claims = await Promise.all(
        d.claimIds.map((c) => this.claim(db, ctx, c)),
      );
      for (const v of d.usedVersions)
        await this.page(db, ctx, v.pageId, v.version);
      if (
        claims.some(
          (c) =>
            !d.usedVersions.some(
              (v) => v.pageId === c.pageId && v.version === c.pageVersion,
            ),
        )
      )
        throw Error("STALE_VERSION");
      for (const e of d.evidenceIds) await this.evidence(db, ctx, e);
      const result = await this.put(db, ctx, "outcomes", {
        ...d,
        humanValidation: "unreviewed" as const,
        ...this.stamp(ctx),
      });
      await this.request(db, ctx, d.claimIds, "outcome", `outcome_${d.id}`, {
        outcomeId: d.id,
        result: d.result,
        uncertainty: "단일 사례; 일반화 및 실제 성공은 별도 검증 필요",
      });
      return result;
    });
  }
  async reviewOutcome(ctx: Context, input: unknown) {
    const d = z
      .object({
        id,
        outcomeId: id,
        status: z.enum(["confirmed", "rejected"]),
        evidenceIds: z.array(id).min(1).max(100),
        reason: z.string().min(1).max(5000),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.protect", undefined, async (db) => {
      if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
      const o = await this.get<Outcome>(db, ctx, "outcomes", d.outcomeId);
      if (o.recordedBy === ctx.principalId)
        throw Error("INDEPENDENT_REVIEW_REQUIRED");
      for (const v of o.usedVersions)
        await this.page(db, ctx, v.pageId, v.version);
      for (const c of o.claimIds) await this.claim(db, ctx, c);
      for (const e of [...o.evidenceIds, ...d.evidenceIds])
        await this.evidence(db, ctx, e);
      return this.put(db, ctx, "reviews", {
        ...d,
        kind: "review",
        verifiedAt: new Date().toISOString(),
        ...this.stamp(ctx),
      });
    });
  }
  async reviewClaim(ctx: Context, input: unknown) {
    const d = z
      .object({
        id,
        claimIds: z.array(id).min(1).max(100),
        status: z.enum(["reviewed", "execution-verified", "rejected"]),
        evidenceIds: z.array(id).min(1).max(100),
        reason: z.string().min(1).max(5000),
      })
      .strict()
      .parse(input);
    return this.run(ctx, "knowledge.protect", undefined, async (db) => {
      if (ctx.credentialId) throw Error("REVIEW_REQUIRES_HUMAN");
      const claims: Claim[] = [];
      for (const cid of d.claimIds) {
        const c = await this.claim(db, ctx, cid);
        claims.push(c);
        await this.authorize(db, ctx, "knowledge.protect", {
          kind: "page",
          id: c.pageId,
        });
        if (c.recordedBy === ctx.principalId)
          throw Error("INDEPENDENT_REVIEW_REQUIRED");
      }
      const evidence = await Promise.all(
        d.evidenceIds.map((e) => this.evidence(db, ctx, e)),
      );
      const proofs =
        d.status === "execution-verified"
          ? await this.trustedExecutions(db, ctx, evidence, claims)
          : [];
      return this.put(db, ctx, "reviews", {
        ...d,
        ...(proofs.length
          ? { executionReceiptIds: proofs.map((p) => p.receipt.receiptId) }
          : {}),
        kind: "review" as const,
        verifiedAt: new Date().toISOString(),
        ...this.stamp(ctx),
      });
    });
  }
  async outcomes(ctx: Context) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await this.all<Outcome>(db, ctx, "outcomes"),
        reviews = await this.all<{
          outcomeId: string;
          status: "confirmed" | "rejected";
          evidenceIds: string[];
          recordedAt: string;
        }>(db, ctx, "reviews"),
        items = [];
      for (const o of rows)
        try {
          for (const c of o.claimIds) await this.claim(db, ctx, c);
          for (const e of o.evidenceIds) await this.evidence(db, ctx, e);
          for (const v of o.usedVersions)
            await this.page(db, ctx, v.pageId, v.version);
          const r = reviews
            .filter((r) => r.outcomeId === o.id)
            .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
          for (const review of r)
            for (const e of review.evidenceIds) await this.evidence(db, ctx, e);
          items.push({
            ...o,
            humanValidation: r.at(-1)?.status ?? "unreviewed",
            reviews: r,
          });
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return { items };
    });
  }
  async requests(ctx: Context) {
    return this.run(ctx, "knowledge.read", undefined, async (db) => {
      const rows = await this.all<Request>(db, ctx, "requests"),
        items = [];
      for (const r of rows)
        try {
          const roots: Array<{
            sourceId: string;
            sourceVersion?: string;
            location?: unknown;
            root?: string | null;
          }> = [...(r.rootLineage ?? [])];
          const seen = new Set<string>();
          const collect = async (eid: string): Promise<void> => {
            if (seen.has(eid)) return;
            seen.add(eid);
            const e = await this.evidence(db, ctx, eid);
            if (e.sourceId)
              roots.push({
                sourceId: e.sourceId,
                sourceVersion: e.sourceVersion,
                location: e.location,
                root: e.root,
              });
            for (const p of e.parentIds) await collect(p);
          };
          for (const cid of r.claimIds) {
            const c = await this.claim(db, ctx, cid);
            for (const eid of c.evidenceIds) await collect(eid);
          }
          for (const v of r.usedVersions ?? [])
            await this.page(db, ctx, v.page_id, v.version);
          for (const root of r.rootLineage ?? [])
            await this.source(db, ctx, root.sourceId);
          if (r.agentOutcomeId)
            await this.agentOutcome(db, ctx, r.agentOutcomeId);
          if (r.outcomeId) {
            const o = await this.get<Outcome>(db, ctx, "outcomes", r.outcomeId);
            for (const c of o.claimIds) await this.claim(db, ctx, c);
            for (const e of o.evidenceIds) await collect(e);
            for (const v of o.usedVersions)
              await this.page(db, ctx, v.pageId, v.version);
          }
          items.push({
            ...r,
            rootLineage: [
              ...new Map(roots.map((root) => [digest(root), root])).values(),
            ],
          } as Request);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return { items };
    });
  }
  private async agentOutcome(db: PoolClient, ctx: Context, outcomeId: string) {
    const row = await db.query(
      "SELECT data,principal_id,result FROM agent_outcomes WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, id.parse(outcomeId)],
    );
    if (!row.rowCount) throw Error("NOT_FOUND");
    // Parse the common store's contract rather than trusting arbitrary historical JSON.
    const d = z
      .object({
        used_versions: z
          .array(
            z
              .object({ page_id: id, version: z.number().int().positive() })
              .strict(),
          )
          .min(1)
          .max(100),
        result: z.enum(["success", "failure", "unknown"]),
        observations: z.string().min(1).max(100000),
        evidence: z
          .array(
            z
              .object({
                id,
                version: z.literal(1),
                location: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(100),
        idempotency_key: z.string().max(200),
        verified: z.literal(false),
        evidenceKind: z.literal("agent-observation"),
        independentExecution: z.literal(false),
      })
      .strict()
      .parse(row.rows[0].data);
    if (row.rows[0].result !== d.result) throw Error("EVIDENCE_INVALID");
    const roots = new Map<
      string,
      {
        sourceId: string;
        version: 1;
        sourceVersion: string;
        location: string;
        root: string;
      }
    >();
    for (const v of d.used_versions) {
      const p = await this.page(db, ctx, v.page_id, v.version);
      for (const sid of p.version.sourceIds) {
        const s = await this.source(db, ctx, sid);
        roots.set(sid, {
          sourceId: sid,
          version: 1,
          sourceVersion: digest(s),
          location: "content",
          root: `source:${digest(s.content)}`,
        });
      }
    }
    for (const ref of d.evidence) {
      const s = await this.source(db, ctx, ref.id);
      if (
        ref.location !== "content" &&
        !(
          ref.location.startsWith("quote:") &&
          ref.location.length > 6 &&
          s.content.includes(ref.location.slice(6))
        )
      )
        throw Error("EVIDENCE_INVALID");
      roots.set(ref.id, {
        sourceId: ref.id,
        version: 1,
        sourceVersion: digest(s),
        location: ref.location,
        root: `source:${digest(s.content)}`,
      });
    }
    return {
      ...d,
      reportedBy: row.rows[0].principal_id,
      rootLineage: [...roots.values()].sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId),
      ),
    };
  }
  /** Task5 common outcome store -> durable, deduplicated, never auto-verified review proposals. */
  async importAgentSignals(ctx: Context, input: unknown = {}) {
    const options = signalImportInput.parse(input);
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      const after = options.cursor
        ? readSignalCursor(ctx, options.cursor)
        : null;
      const candidates = options.outcomeId
        ? [options.outcomeId]
        : (
            await db.query(
              `SELECT DISTINCT s.outcome_id FROM agent_review_signals s
         WHERE s.workspace_id=$1 AND s.state='pending' AND ($2::text IS NULL OR s.outcome_id>$2)
         AND NOT EXISTS (SELECT 1 FROM refinement_requests r WHERE r.workspace_id=s.workspace_id AND r.id='agent_'||s.outcome_id)
         ORDER BY s.outcome_id LIMIT $3`,
              [ctx.workspaceId, after, options.limit + 1],
            )
          ).rows.map((r) => r.outcome_id as string);
      const selected = candidates.slice(0, options.limit);
      const imported: string[] = [],
        acknowledged: string[] = [];
      for (const outcomeId of selected)
        try {
          const d = await this.agentOutcome(db, ctx, outcomeId);
          const linked = (
            await db.query(
              "SELECT id,page_id FROM agent_review_signals WHERE workspace_id=$1 AND outcome_id=$2 AND state='pending' ORDER BY id LIMIT 101",
              [ctx.workspaceId, outcomeId],
            )
          ).rows;
          if (
            linked.length > 100 ||
            linked.some(
              (s) => !d.used_versions.some((v) => v.page_id === s.page_id),
            )
          )
            throw Error("EVIDENCE_INVALID");
          const requestId = `agent_${outcomeId}`;
          const old = await db.query(
            "SELECT data FROM refinement_requests WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, requestId],
          );
          if (old.rowCount) {
            const prior = old.rows[0].data as Request;
            for (const v of prior.usedVersions ?? [])
              await this.page(db, ctx, v.page_id, v.version);
            for (const root of prior.rootLineage ?? [])
              await this.source(db, ctx, root.sourceId);
            for (const cid of prior.claimIds ?? [])
              await this.claim(db, ctx, cid);
            acknowledged.push(requestId);
            continue;
          }
          if (!linked.length) continue;
          const claims = (await this.all<Claim>(db, ctx, "claims")).filter(
            (c) =>
              d.used_versions.some(
                (v) => v.page_id === c.pageId && v.version === c.pageVersion,
              ),
          );
          const claimIds = [];
          for (const c of claims)
            try {
              await this.claim(db, ctx, c.id);
              claimIds.push(c.id);
            } catch (e) {
              if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
            }
          await this.request(db, ctx, claimIds, "agent-outcome", requestId, {
            agentOutcomeId: outcomeId,
            signalIds: linked.map((s) => s.id),
            usedVersions: d.used_versions,
            rootLineage: d.rootLineage,
            result: d.result,
            observations: d.observations,
            reportedBy: d.reportedBy,
            verified: false,
            humanValidation: "unreviewed",
            evidenceKind: "agent-observation",
            independentExecution: false,
            uncertainty:
              "에이전트의 단일 사례 관찰; 성공/실패 주장과 독립 실행 증거·인간 검증은 별개",
            limits:
              "환경 및 유효/검증 시점 미등록; 보편 규칙으로 일반화하지 않음",
          });
          imported.push(requestId);
          acknowledged.push(requestId);
        } catch (e) {
          if (!(e instanceof Error && e.message === "NOT_FOUND")) throw e;
        }
      return {
        imported,
        acknowledged,
        nextCursor:
          !options.outcomeId && candidates.length > selected.length
            ? signalCursor(ctx, selected.at(-1)!)
            : null,
      };
    });
  }
  private async semanticSnapshot(
    db: PoolClient,
    ctx: Context,
    context: ContextOptions,
    pinned?: readonly string[],
  ) {
    await this.authorize(db, ctx, "lint.run");
    if (pinned) for (const cid of pinned) await this.claim(db, ctx, cid);
    const view = await this.contextDb(db, ctx, context, pinned);
    const claimIds = view.items.map((c) => c.id);
    if (pinned && digest(claimIds) !== digest(pinned))
      throw Error("INPUT_CHANGED");
    const modelClaims = view.items.map((c) => ({
      ...c,
      evidence: c.evidence.map(({ executionVerification: _, ...e }) => e),
    }));
    const pageIds = new Set<string>(),
      sourceIds = new Set<string>(),
      seenClaims = new Set<string>(),
      seenEvidence = new Set<string>();
    const visitEvidence = async (eid: string, depth = 0): Promise<void> => {
      if (depth > 32) throw Error("POLICY_RESOURCE_LIMIT");
      if (seenEvidence.has(eid)) return;
      if (seenEvidence.size + seenClaims.size >= 200)
        throw Error("POLICY_RESOURCE_LIMIT");
      seenEvidence.add(eid);
      const e = await this.evidence(db, ctx, eid);
      if (e.sourceId) sourceIds.add(e.sourceId);
      for (const p of e.parentIds) await visitEvidence(p, depth + 1);
    };
    const visitClaim = async (cid: string, depth = 0): Promise<void> => {
      if (depth > 32) throw Error("POLICY_RESOURCE_LIMIT");
      if (seenClaims.has(cid)) return;
      if (seenEvidence.size + seenClaims.size >= 200)
        throw Error("POLICY_RESOURCE_LIMIT");
      seenClaims.add(cid);
      const c = await this.claim(db, ctx, cid);
      pageIds.add(c.pageId);
      for (const eid of c.evidenceIds) await visitEvidence(eid);
      for (const parent of c.supersedes) await visitClaim(parent, depth + 1);
    };
    for (const c of view.items) {
      await visitClaim(c.id);
      for (const r of c.verificationReviews) {
        for (const cid of r.claimIds) await visitClaim(cid);
        for (const eid of r.evidenceIds) await visitEvidence(eid);
      }
    }
    const state = await loadState(db, ctx.workspaceId);
    const flags = (
      await db.query(
        "SELECT page_id,parent_id,state,revision,data FROM workflow_document_state WHERE workspace_id=$1 ORDER BY page_id",
        [ctx.workspaceId],
      )
    ).rows;
    const byId = new Map(state.pages.map((p) => [p.id, p])),
      byFlag = new Map(flags.map((p) => [p.page_id, p]));
    const pending = [...pageIds],
      visited = new Set<string>();
    while (pending.length) {
      const pid = pending.pop()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const p = byId.get(pid);
      if (!p) throw Error("NOT_FOUND");
      const inherited = inheritedProvenance(p);
      for (const sid of inherited.sourceIds) sourceIds.add(sid);
      pending.push(
        ...inherited.pageIds,
        ...(p.links ?? []).filter((id) => byId.has(id)),
      );
      const parent = byFlag.get(pid)?.parent_id;
      if (parent) pending.push(parent);
      if (visited.size > 200 || sourceIds.size > 200)
        throw Error("INPUT_SCOPE_MISMATCH");
    }
    const envelope = await captureEnvelope(
      db,
      ctx,
      state,
      [...visited],
      [...sourceIds],
    );
    if (envelope.pageIds.length > 200 || envelope.sourceIds.length > 200)
      throw Error("INPUT_SCOPE_MISMATCH");
    for (const pid of envelope.pageIds)
      await this.authorize(db, ctx, "knowledge.read", {
        kind: "page",
        id: pid,
      });
    for (const sid of envelope.sourceIds)
      await this.authorize(db, ctx, "knowledge.read", {
        kind: "source",
        id: sid,
      });
    const fingerprint = digest({
      contractVersion: SEMANTIC_LINT_CONTRACT_VERSION,
      context,
      claims: modelClaims,
      envelope,
      flags: flags.filter((f) => visited.has(f.page_id)),
    });
    await ctx.authorization?.assertSession(db);
    const usedVersions = envelope.pageIds.map((pid) => ({
      page_id: pid,
      version: byId.get(pid)!.versions.at(-1)!.number,
    }));
    const rootLineage = envelope.sourceIds.map((sid) => ({
      sourceId: sid,
      sourceVersion: envelope.sources[sid],
      location: "content",
      root: `source:${digest(state.sources.find((s) => s.id === sid)!.content)}`,
    }));
    return {
      envelope,
      modelClaims,
      claimIds,
      contextFingerprint: fingerprint,
      pageIds: envelope.pageIds,
      sourceIds: envelope.sourceIds,
      usedVersions,
      rootLineage,
    };
  }
  semanticJobAdapter(): SemanticJobAdapter {
    return {
      prepare: async (db, ctx, input) => {
        await membership(db, ctx);
        await ctx.authorization?.assertSession(db);
        const hasSeal =
          !!input &&
          typeof input === "object" &&
          ("contractVersion" in input ||
            "contextFingerprint" in input ||
            "claimIds" in input);
        const sealed = hasSeal ? semanticSealedInput.parse(input) : undefined;
        const raw =
          sealed?.context ??
          (!!input && typeof input === "object" && "semantic" in input
            ? semanticPublicInput.parse(input).context
            : contextInput.parse(input));
        const context = contextInput.parse({
          ...raw,
          asOf: raw.asOf ?? new Date().toISOString(),
          includeHistory: true,
        });
        const snapshot = await this.semanticSnapshot(
          db,
          ctx,
          context,
          sealed?.claimIds,
        );
        if (sealed && snapshot.contextFingerprint !== sealed.contextFingerprint)
          throw Error("INPUT_CHANGED");
        return {
          payload: {
            semantic: true,
            contractVersion: SEMANTIC_LINT_CONTRACT_VERSION,
            context,
            claimIds: snapshot.claimIds,
            contextFingerprint: snapshot.contextFingerprint,
          },
          pageIds: snapshot.pageIds,
          sourceIds: snapshot.sourceIds,
        };
      },
      execute: (ctx, payload, execution) =>
        this.executeSemanticJob(ctx, payload, execution),
    };
  }
  private async executeSemanticJob(
    ctx: Context,
    payload: Record<string, unknown>,
    execution: RuntimeExecution,
  ): Promise<unknown> {
    const sealed = semanticSealedInput.parse(payload);
    const recheck = async (db: PoolClient) => {
      // One parent session assertion per projection transaction. Resource ACL checks are NEVER cached;
      // captureInputs/beforeWrite/persist and run's final original-context guard still recheck the lease.
      let asserted: Promise<void> | undefined;
      const local = ctx.authorization
        ? Object.freeze({
            ...ctx,
            authorization: {
              revalidate: ctx.authorization.revalidate,
              assertSession: (client: PoolClient) => {
                if (client !== db) throw Error("INVALID_TRANSACTION_CONTEXT");
                return (asserted ??= Promise.resolve().then(() =>
                  ctx.authorization!.assertSession(client),
                ));
              },
            },
          })
        : ctx;
      const fresh = await this.semanticSnapshot(
        db,
        local,
        sealed.context,
        sealed.claimIds,
      );
      if (fresh.contextFingerprint !== sealed.contextFingerprint)
        throw Error("INPUT_CHANGED");
      await execution.captureInputs(db, fresh.pageIds, fresh.sourceIds);
      await execution.beforeWrite(db);
      return fresh;
    };
    const prepared = await this.run(ctx, "lint.run", undefined, recheck);
    let transmissionCheck: ((db: PoolClient) => Promise<void>) | undefined;
    let findings: ReturnType<typeof validateFindings> = [];
    if (prepared.modelClaims.length) {
      if (!this.provider) throw Error("MODEL_NOT_CONFIGURED");
      assertSafeModelInput({ claims: prepared.modelClaims });
      const binding = await bindModelTransmission(
        this.pool,
        ctx,
        "semantic-lint",
        prepared.envelope,
        execution.modelOptions,
        semanticProviderEndpoint(this.provider),
      );
      transmissionCheck = binding.recheck;
      const raw = await execution.modelResult("semantic-lint", () =>
        this.provider!({ claims: prepared.modelClaims }, binding.options),
      );
      try {
        findings = validateFindings(raw, prepared.modelClaims);
      } catch {
        throw Error("MODEL_INVALID");
      }
      if (findings.length > execution.maxChanges) throw Error("CHANGE_LIMIT");
    }
    return this.run(ctx, "lint.run", undefined, async (db) => {
      await recheck(db);
      await transmissionCheck?.(db);
      if (ctx.authorization || ctx.credentialId)
        await assertFeature(db, ctx, "lint", undefined, "lint.run");
      return execution.persist(db, "semantic-lint", async () => {
        execution.modelOptions.signal?.throwIfAborted();
        if (!prepared.modelClaims.length)
          return {
            status: "no-inputs",
            kind: "not-executed",
            modelAnalysisPerformed: false,
            contextFingerprint: sealed.contextFingerprint,
            findings: [],
            requestIds: [],
          };
        const producer = await execution.producer("model", db),
          requestIds: string[] = [];
        for (const f of findings) {
          const request = await this.request(
            db,
            ctx,
            f.claimIds,
            "semantic-lint",
            `lint_${randomUUID()}`,
            {
              finding: f,
              producer,
              contextFingerprint: sealed.contextFingerprint,
              usedVersions: prepared.usedVersions,
              rootLineage: prepared.rootLineage,
              evidenceKind: "model-proposal",
              independentExecution: false,
            },
          );
          requestIds.push(request.id);
        }
        return {
          status: "completed",
          kind: "model-proposal",
          modelAnalysisPerformed: true,
          contextFingerprint: sealed.contextFingerprint,
          producer,
          findings,
          requestIds,
        };
      });
    });
  }
  async semanticLint(ctx: Context, input: unknown) {
    // Production sessions/delegated identities MUST enter the durable job adapter, never inline HTTP.
    if (
      ctx.authorization ||
      ctx.credentialId ||
      (this.provider && semanticProviderEndpoint(this.provider))
    )
      return this.run(ctx, "lint.run", undefined, async () => {
        throw Error("SEMANTIC_JOB_REQUIRED");
      });
    const d = contextInput.parse(input);
    // Always authorize even when no provider is configured.
    const context = await this.context(ctx, { ...d, includeHistory: true });
    const recheck = async (db: PoolClient) => {
      for (const c of context.items) {
        await this.claim(db, ctx, c.id);
        for (const r of c.verificationReviews) {
          for (const cid of r.claimIds) await this.claim(db, ctx, cid);
          for (const eid of r.evidenceIds) await this.evidence(db, ctx, eid);
        }
      }
    };
    await this.run(ctx, "lint.run", undefined, recheck);
    if (!context.items.length)
      return {
        status: "no-inputs" as const,
        modelAnalysisPerformed: false,
        findings: [],
      };
    if (!this.provider)
      return { status: "unconfigured" as const, findings: [] };
    // Models receive claims/quotes and public summaries, never signed receipt envelopes.
    const modelClaims = context.items.map((c) => ({
      ...c,
      evidence: c.evidence.map(({ executionVerification: _, ...e }) => e),
    }));
    let findings;
    try {
      assertSafeModelInput({ claims: modelClaims });
      findings = validateFindings(
        await this.provider({ claims: modelClaims }),
        modelClaims,
      );
    } catch {
      return { status: "error" as const, code: "MODEL_FAILED", findings: [] };
    }
    return this.run(ctx, "changeset.propose", undefined, async (db) => {
      // Recheck all model input provenance after asynchronous transmission, not only output citations.
      await recheck(db);
      const requestIds = [];
      for (const f of findings) {
        const request = await this.request(
          db,
          ctx,
          f.claimIds,
          "semantic-lint",
          `lint_${randomUUID()}`,
          { finding: f },
        );
        requestIds.push(request.id);
      }
      return {
        status: "completed" as const,
        kind: "model-proposal" as const,
        findings,
        requestIds,
      };
    });
  }
}
