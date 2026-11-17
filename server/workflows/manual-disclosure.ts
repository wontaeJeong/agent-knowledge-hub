import { assertProductWritesNotErased } from "../operations/product-erasure";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type { WorkflowService } from "./service";
import { transaction } from "../database";
import { audit, loadState, membership } from "../repository";
import { authorizeInTransaction, effectiveAccess } from "../access";
import {
  captureEnvelope,
  fingerprint,
  type InputEnvelope,
} from "../provenance";
import { assertDraftNotRetired } from "../retention/drafts";
import {
  personalOwner,
  qualifiedReviewers,
  readDisclosureInputs,
  assertDisclosureAudience,
} from "../imports/disclosure-policy";
// Process-local authenticated encryption hides scan positions and hidden row IDs.
const cursorKey = randomBytes(32);
const listQuery = z
  .object({
    cursor: z.string().max(4096).nullable().optional(),
    draftId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    queue: z.enum(["all", "assigned-pending"]).default("all"),
  })
  .strict();
function encodeCursor(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", cursorKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
function decodeCursor(raw: string) {
  try {
    const data = Buffer.from(raw, "base64url"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        cursorKey,
        data.subarray(0, 12),
      );
    decipher.setAuthTag(data.subarray(12, 28));
    return z
      .object({
        binding: z.string(),
        at: z.string(),
        id: z.string(),
        expires: z.number(),
      })
      .strict()
      .parse(
        JSON.parse(
          Buffer.concat([
            decipher.update(data.subarray(28)),
            decipher.final(),
          ]).toString(),
        ),
      );
  } catch {
    throw Error("STALE_CURSOR");
  }
}
// Conservative data/authority invalidation; only fixed-size SQL digests leave
// PostgreSQL. No private corpus or hidden count is materialized for pagination.
const scopedCursorTables = [
  "workflow_draft_disclosures",
  "workflow_drafts",
  "workflow_draft_revision_history",
  "workflow_document_state",
  "workflow_source_state",
  "sources",
  "pages",
  "versions",
  "resources",
  "resource_readers",
  "memberships",
  "access_spaces",
  "access_grants",
  "access_reviewers",
  "access_credentials",
  "access_shares",
  "access_source_policy",
  "governance_type_policies",
  "operations_tombstones",
  "operations_erasure_receipts",
  "operations_erased_artifacts",
];
const globalCursorTables = [
  "access_principals",
  "access_namespaces",
  "access_team_members",
  "access_groups",
  "access_group_members",
  "access_service_accounts",
  "identity_directory_bindings",
  "identity_directory_edges",
  "identity_directory_proofs",
  "identity_manual_group_members",
  "identity_group_denies",
];
async function listRevision(db: PoolClient, ctx: Context) {
  const parts = [
    ...scopedCursorTables.map((table) => ({ table, scoped: true })),
    ...globalCursorTables.map((table) => ({ table, scoped: false })),
  ];
  const sql = parts
    .map(
      ({ table, scoped }) =>
        `SELECT '${table}' AS name,md5(COALESCE(string_agg(h,'' ORDER BY h),'')) AS hash FROM (SELECT md5((to_jsonb(t)-'last_used_at')::text || CASE WHEN to_jsonb(t)->>'expires_at' IS NULL THEN '' ELSE ((to_jsonb(t)->>'expires_at')::timestamptz>clock_timestamp())::text END || CASE WHEN to_jsonb(t)->>'valid_until' IS NULL THEN '' ELSE ((to_jsonb(t)->>'valid_until')::timestamptz>clock_timestamp())::text END) AS h FROM ${table} t ${scoped ? "WHERE workspace_id=$1" : ""}) hashes`,
    )
    .join(" UNION ALL ");
  return (await db.query(sql, [ctx.workspaceId])).rows;
}
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const manualTargetSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  parentId: id.nullable(),
  reason: z.string().trim().min(1).max(2000),
  mutationId: z.string().uuid(),
});
const requestSchema = manualTargetSchema
  .extend({ readers: z.array(id).min(1).max(100), reviewerId: id.optional() })
  .strict();
export interface DisclosureRow {
  id: string;
  owner_id: string;
  draft_id: string;
  draft_revision: number;
  content_hash: string;
  snapshot: {
    title: string;
    requestReason?: string;
    /** Server-validated current/history template consumption, retained only for erasure. */
    templateIds?: string[];
    content: string;
    sourceIds: string[];
    dependencyVersions: Record<string, number>;
  };
  dependency_envelope: InputEnvelope;
  parent_id: string | null;
  policy_hash: string;
  audience: string[];
  reviewer_id: string;
  policy_mode: "personal-owner" | "independent-review";
  status: "pending" | "pending-confirmation" | "approved" | "rejected";
  revision: number;
  hash: string;
  request_mutation_id: string;
  request_hash: string;
  decisions: Record<
    string,
    {
      hash: string;
      result: unknown;
      decision?: {
        decision: "approve" | "reject";
        reason: string;
        principalId: string;
      };
    }
  >;
  source_id: string | null;
  batch_id: string | null;
  submission: {
    inputHash: string;
    result: {
      status: "knowledge-review-pending";
      sourceId: string;
      batchId: string;
      hash: string;
    };
  } | null;
}
/** Snapshot-specific review permission. Never grants generic access to another owner's drafts. */
export class ManualDraftDisclosureService {
  constructor(readonly workflows: WorkflowService) {}
  private async run<T>(ctx: Context, work: (db: PoolClient) => Promise<T>) {
    await ctx.authorization?.revalidate();
    const result = await transaction(
      this.workflows.pool,
      ctx.workspaceId,
      async (db) => {
        await membership(db, ctx);
        await ctx.authorization?.assertSession(db);
        await authorizeInTransaction(db, ctx, "knowledge.read");
        return work(db);
      },
    );
    await ctx.authorization?.revalidate();
    return result;
  }
  async snapshot(
    db: PoolClient,
    ctx: Context,
    draftId: string,
    expectedRevision: number,
    title: string,
    parentId: string | null,
  ) {
    await authorizeInTransaction(db, ctx, "draft.write");
    await authorizeInTransaction(db, ctx, "changeset.propose");
    await assertProductWritesNotErased(db, ctx.workspaceId, "");
    await assertDraftNotRetired(db, ctx, id.parse(draftId));
    const r = (
      await db.query(
        "SELECT revision,data FROM workflow_drafts WHERE workspace_id=$1 AND owner_id=$2 AND id=$3",
        [ctx.workspaceId, ctx.principalId, draftId],
      )
    ).rows[0];
    if (!r) throw Error("NOT_FOUND");
    if (r.revision !== expectedRevision) throw Error("APPROVAL_STALE");
    if (r.data.pageId) throw Error("VALIDATION_FAILED");
    if (r.data.title !== title) throw Error("APPROVAL_STALE");
    // The service retains every historical/template/link dependency, including labels removed by later saves.
    const lineage = await this.workflows.draftHistoryAccess(db, ctx, draftId);
    const state = await loadState(db, ctx.workspaceId);
    for (const [pageId, version] of Object.entries(lineage.dependencyVersions))
      if (
        state.pages.find((p) => p.id === pageId)?.versions.at(-1)?.number !==
        version
      )
        throw Error("STALE_VERSION");
    if (parentId)
      await authorizeInTransaction(db, ctx, "draft.write", {
        kind: "page",
        id: parentId,
      });
    const envelope = await captureEnvelope(
      db,
      ctx,
      state,
      [
        ...Object.keys(lineage.dependencyVersions),
        ...(parentId ? [parentId] : []),
      ],
      lineage.sourceIds,
    );
    const snapshot = {
      title,
      content: r.data.content as string,
      sourceIds: lineage.sourceIds,
      dependencyVersions: lineage.dependencyVersions,
    };
    return {
      snapshot: {
        ...snapshot,
        ...(lineage.templateIds.length
          ? { templateIds: lineage.templateIds }
          : {}),
      },
      envelope,
      contentHash: fingerprint(snapshot),
    };
  }
  private async policy(
    db: PoolClient,
    ctx: Context,
    audience: string[],
    reviewer: string | undefined,
    envelope: InputEnvelope,
  ) {
    const personal = await personalOwner(db, ctx);
    const mode = personal ? "personal-owner" : "independent-review";
    if (personal) {
      if (audience.length !== 1 || audience[0] !== ctx.principalId || reviewer)
        throw Error("FORBIDDEN");
    } else if (
      !reviewer ||
      reviewer === ctx.principalId ||
      !(await qualifiedReviewers(db, ctx)).includes(reviewer) ||
      !audience.includes(ctx.principalId) ||
      !audience.includes(reviewer)
    )
      throw Error("FORBIDDEN");
    for (const principalId of audience)
      if (
        !(
          await db.query(
            "SELECT 1 FROM access_principals WHERE id=$1 AND active AND kind='human'",
            [principalId],
          )
        ).rowCount
      )
        throw Error("FORBIDDEN");
    await assertDisclosureAudience(db, ctx, audience, envelope);
    const rules = (
      await db.query(
        "SELECT * FROM governance_type_policies WHERE workspace_id=$1 ORDER BY document_type",
        [ctx.workspaceId],
      )
    ).rows;
    const space = (
      await db.query("SELECT * FROM access_spaces WHERE workspace_id=$1", [
        ctx.workspaceId,
      ])
    ).rows[0];
    const ancestry = (
      await db.query(
        `WITH RECURSIVE path AS (
      SELECT page_id,parent_id,state,revision,data,ARRAY[page_id] AS visited FROM workflow_document_state WHERE workspace_id=$1 AND page_id=ANY($2::text[])
      UNION ALL SELECT p.page_id,p.parent_id,p.state,p.revision,p.data,c.visited||p.page_id FROM workflow_document_state p JOIN path c ON p.page_id=c.parent_id WHERE p.workspace_id=$1 AND NOT p.page_id=ANY(c.visited)
    ) SELECT DISTINCT page_id,parent_id,state,revision,data FROM path ORDER BY page_id`,
        [ctx.workspaceId, envelope.pageIds],
      )
    ).rows;
    return {
      mode,
      policyHash: fingerprint({
        mode,
        space,
        rules,
        ancestry,
        audience,
        reviewer: reviewer ?? ctx.principalId,
      }),
    };
  }
  async current(db: PoolClient, ctx: Context, row: DisclosureRow) {
    const owner = { workspaceId: ctx.workspaceId, principalId: row.owner_id };
    const fresh = await this.snapshot(
      db,
      owner,
      row.draft_id,
      row.draft_revision,
      row.snapshot.title,
      row.parent_id,
    );
    const policy = await this.policy(
      db,
      owner,
      row.audience,
      row.policy_mode === "personal-owner" ? undefined : row.reviewer_id,
      fresh.envelope,
    );
    if (
      fingerprint(fresh.envelope) !== fingerprint(row.dependency_envelope) ||
      fresh.contentHash !== row.content_hash ||
      policy.policyHash !== row.policy_hash ||
      policy.mode !== row.policy_mode
    )
      throw Error("APPROVAL_STALE");
    await readDisclosureInputs(db, ctx, fresh.envelope);
    return fresh;
  }
  async request(ctx: Context, draftId: string, input: unknown) {
    const body = requestSchema.parse(input),
      audience = [...new Set(body.readers)].sort();
    return this.run(ctx, async (db) => {
      const fresh = await this.snapshot(
        db,
        ctx,
        draftId,
        body.expectedRevision,
        body.title,
        body.parentId,
      );
      const policy = await this.policy(
          db,
          ctx,
          audience,
          body.reviewerId,
          fresh.envelope,
        ),
        inputHash = fingerprint({ draftId, body });
      const previous = (
        await db.query(
          "SELECT * FROM workflow_draft_disclosures WHERE workspace_id=$1 AND owner_id=$2 AND request_mutation_id=$3",
          [ctx.workspaceId, ctx.principalId, body.mutationId],
        )
      ).rows[0] as DisclosureRow | undefined;
      if (previous) {
        if (previous.request_hash !== inputHash)
          throw Error("IDEMPOTENCY_CONFLICT");
        await this.current(db, ctx, previous);
        return {
          id: previous.id,
          hash: previous.hash,
          status: previous.status,
        };
      }
      if (
        (
          await db.query(
            "SELECT 1 FROM workflow_draft_disclosures WHERE workspace_id=$1 AND owner_id=$2 AND draft_id=$3 AND batch_id IS NOT NULL",
            [ctx.workspaceId, ctx.principalId, draftId],
          )
        ).rowCount
      )
        throw Error("ALREADY_PROPOSED");
      const disclosureId = randomUUID(),
        status =
          policy.mode === "personal-owner" ? "pending-confirmation" : "pending",
        reviewer = body.reviewerId ?? ctx.principalId;
      const hash = fingerprint({
        draftId,
        owner: ctx.principalId,
        revision: body.expectedRevision,
        ...fresh,
        parentId: body.parentId,
        ...policy,
        audience,
        reviewer,
        requestReason: body.reason,
      });
      await db.query(
        "INSERT INTO workflow_draft_disclosures(workspace_id,id,owner_id,draft_id,draft_revision,content_hash,snapshot,dependency_envelope,parent_id,policy_hash,audience,reviewer_id,policy_mode,status,hash,request_mutation_id,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
        [
          ctx.workspaceId,
          disclosureId,
          ctx.principalId,
          draftId,
          body.expectedRevision,
          fresh.contentHash,
          { ...fresh.snapshot, requestReason: body.reason },
          fresh.envelope,
          body.parentId,
          policy.policyHash,
          JSON.stringify(audience),
          reviewer,
          policy.mode,
          status,
          hash,
          body.mutationId,
          inputHash,
        ],
      );
      await audit(db, ctx, "draft.disclosure.request", disclosureId);
      return { id: disclosureId, hash, status };
    });
  }
  async list(ctx: Context, input: unknown = {}) {
    const q = listQuery.parse(input);
    return this.run(ctx, async (db) => {
      const binding = fingerprint({
        workspace: ctx.workspaceId,
        principal: ctx.principalId,
        credential: ctx.credentialId ?? null,
        agent: ctx.agent ?? null,
        session: ctx.authorization?.sessionId ?? null,
        draftId: q.draftId ?? null,
        queue: q.queue,
        limit: 25,
        access: await effectiveAccess(db, ctx),
        reviewers: (await qualifiedReviewers(db, ctx)).sort(),
        revision: await listRevision(db, ctx),
      });
      const old = q.cursor ? decodeCursor(q.cursor) : null;
      if (old && (old.binding !== binding || old.expires < Date.now()))
        throw Error("STALE_CURSOR");
      const rows = (
        await db.query(
          `SELECT *,created_at::text AS sort_at FROM workflow_draft_disclosures WHERE workspace_id=$1 AND (owner_id=$2 OR reviewer_id=$2)
        AND ($3::text IS NULL OR draft_id=$3) AND ($4::boolean=false OR (reviewer_id=$2 AND status IN ('pending','pending-confirmation')))
        AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text)) ORDER BY created_at DESC,id DESC LIMIT 101`,
          [
            ctx.workspaceId,
            ctx.principalId,
            q.draftId ?? null,
            q.queue === "assigned-pending",
            old?.at ?? null,
            old?.id ?? null,
          ],
        )
      ).rows as (DisclosureRow & { sort_at: string })[];
      const items = [];
      let scanned = 0;
      for (const row of rows.slice(0, 100)) {
        scanned++;
        try {
          await this.current(db, ctx, row);
          if (
            row.owner_id !== ctx.principalId &&
            !(await qualifiedReviewers(db, ctx)).includes(ctx.principalId)
          )
            continue;
          items.push({
            id: row.id,
            draftId: row.draft_id,
            draftRevision: row.draft_revision,
            ownerId: row.owner_id,
            reviewerId: row.reviewer_id,
            policyMode: row.policy_mode,
            status: row.status,
            hash: row.hash,
            audience: row.audience,
            parentId: row.parent_id,
            title: row.snapshot.title,
            content: row.snapshot.content,
            sourceIds: row.snapshot.sourceIds,
            dependencyVersions: row.snapshot.dependencyVersions,
            requestReason: row.snapshot.requestReason,
            submission: row.submission?.result,
            decision: Object.values(row.decisions).find((d) => d.decision)
              ?.decision,
          });
        } catch (error) {
          // Only a known inaccessible/stale/retired snapshot is an omitted item.
          // Policy dependencies, SQL and programming failures remain errors.
          if (
            !(error instanceof Error) ||
            ![
              "NOT_FOUND",
              "FORBIDDEN",
              "APPROVAL_STALE",
              "STALE_VERSION",
              "SOURCE_SCOPE_CONFLICT",
              "ERASURE_PRODUCT_WRITES_FENCED",
            ].includes(error.message)
          )
            throw error;
        }
        if (items.length === 25) break;
      }
      const more = scanned < rows.length,
        last = rows[scanned - 1];
      return {
        items,
        nextCursor:
          more && last
            ? encodeCursor({
                binding,
                at: last.sort_at,
                id: last.id,
                expires: Date.now() + 15 * 60 * 1000,
              })
            : null,
        partial: more && items.length < 25,
      };
    });
  }
  async decide(ctx: Context, disclosureId: string, input: unknown) {
    const body = z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().trim().min(1).max(2000),
        mutationId: z.string().uuid(),
      })
      .strict()
      .parse(input);
    return this.run(ctx, async (db) => {
      const row = (
        await db.query(
          "SELECT * FROM workflow_draft_disclosures WHERE workspace_id=$1 AND id=$2 AND reviewer_id=$3 FOR UPDATE",
          [ctx.workspaceId, id.parse(disclosureId), ctx.principalId],
        )
      ).rows[0] as DisclosureRow | undefined;
      if (!row) throw Error("NOT_FOUND");
      await this.current(db, ctx, row);
      if (row.hash !== body.hash) throw Error("APPROVAL_STALE");
      if (row.policy_mode === "independent-review") {
        await authorizeInTransaction(db, ctx, "changeset.approve");
        if (
          row.owner_id === ctx.principalId ||
          !(await qualifiedReviewers(db, ctx)).includes(ctx.principalId)
        )
          throw Error("FORBIDDEN");
      } else if (
        row.owner_id !== ctx.principalId ||
        !(await personalOwner(db, ctx))
      )
        throw Error("FORBIDDEN");
      const old = row.decisions[body.mutationId];
      if (old) {
        if (old.hash !== fingerprint(body)) throw Error("IDEMPOTENCY_CONFLICT");
        return old.result;
      }
      if (!["pending", "pending-confirmation"].includes(row.status))
        throw Error("STALE_VERSION");
      const result = {
        id: row.id,
        hash: row.hash,
        status: body.decision === "approve" ? "approved" : "rejected",
      };
      await db.query(
        "UPDATE workflow_draft_disclosures SET status=$3,revision=revision+1,decisions=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [
          ctx.workspaceId,
          row.id,
          result.status,
          {
            ...row.decisions,
            [body.mutationId]: {
              hash: fingerprint(body),
              result,
              decision: {
                decision: body.decision,
                reason: body.reason,
                principalId: ctx.principalId,
              },
            },
          },
        ],
      );
      await audit(db, ctx, "draft.disclosure." + body.decision, row.id);
      return result;
    });
  }
}
