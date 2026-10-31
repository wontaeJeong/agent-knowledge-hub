import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Context } from "../service";
import type { RuntimeService } from "../runtime/knowledge";
import { transaction } from "../database";
import {
  membership,
  audit,
  addResource,
  loadState,
  readers,
} from "../repository";
import {
  captureEnvelope,
  assertEnvelope,
  visiblePageIds,
  type InputEnvelope,
} from "../provenance";
import { current } from "../../src/domain/wiki";
import { digest, propose } from "../publication";
import type { Draft } from "../../src/domain/wiki";
import type { Source } from "../../src/domain/types";
import {
  defaultSelection,
  type ImportSelection,
  type ImportView,
  type ImportRunView,
  type ParsedImport,
  type ImportResult,
} from "../../src/domain/imports";
import { hash, MAX_FILE, parseImport } from "./parser";
import { organizeRecords, type ContextPage } from "./organizer";
import { isolatedParse } from "./isolated-parser";
import { modelConfig } from "../runtime/model";
import type { ModelOptions } from "../runtime/model";
import { readFile } from "node:fs/promises";
import type { OrganizeCall, OrganizeHooks } from "./organizer";
import { bindPrivateImportTransmission } from "../policy/imports";
import { configuredModelEndpoint } from "../policy/binding";
import {
  reserveImportCall,
  startImportCall,
  recordImportUsage,
  finishImportCall,
  type ImportCallBinding,
} from "./model-accounting";
import { authorizeInTransaction, effectiveAccess } from "../access";
import {
  assertReleasedImportContext,
  replayReleasedInputRemoval,
} from "../operations/released-imports";
export const IMPORT_POLICY_VERSION = "agent-knowledge-hub/imports/1";
export interface ImportTransmissionMetadata extends OrganizeCall {
  runId: string;
  importId: string;
  inputRevision: number;
  attempt: number;
  pageIds: string[];
  sourceIds: string[];
  fullInputHash: string;
  configuredEndpoint: string;
}
export interface ImportServiceOptions {
  modelOptions?: ModelOptions;
  maxCostMicrosPerCall?: number;
  /** Explicit trusted DI for LOCAL deterministic/no-network fixtures only. Never a DTO or env permission fallback. */
  trustedLocalModel?: boolean;
  beforeModelTransmission?: (
    ctx: Context,
    metadata: ImportTransmissionMetadata,
    envelope: InputEnvelope,
    options: ModelOptions,
  ) => Promise<{
    options: ModelOptions;
    recheck: (db: PoolClient) => Promise<void>;
  }>;
  correlation?: (ctx: Context) => { requestId?: string; jobId?: string };
}
const executionConfig = () => ({
  policy: IMPORT_POLICY_VERSION,
  ...modelConfig(),
  endpointHash: hash(process.env.AGENT_KNOWLEDGE_HUB_LLM_BASE_URL || ""),
  thinking: process.env.AGENT_KNOWLEDGE_HUB_LLM_THINKING || null,
});

export const PART_SIZE = 262144;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const requestKey = z.string().min(1).max(100);
export const selectionSchema = z
  .object({
    format: z.enum(["auto", "text", "json", "csv"]),
    encoding: z.enum(["utf-8", "euc-kr", "utf-16le"]),
    namespace: z.string().trim().max(200),
    timezone: z.enum(["unknown", "Asia/Seoul", "UTC"]),
    project: z.string().trim().max(200),
    from: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/),
    to: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/),
    excludedIds: z.array(identifier).max(20_000),
    acknowledgeWarnings: z.boolean(),
    csv: z
      .object({
        text: z.string().min(1).max(100),
        author: z.string().max(100),
        time: z.string().max(100),
        id: z.string().max(100),
        conversation: z.string().max(100),
      })
      .strict(),
  })
  .strict()
  .refine((s) => !s.from || !s.to || s.from <= s.to, "INVALID_DATE_RANGE");
export const importCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    files: z
      .array(
        z
          .object({
            id: identifier,
            name: z.string().min(1).max(255),
            size: z.number().int().positive().max(MAX_FILE),
            sha256: checksum,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (b) =>
      b.files.reduce((n, f) => n + f.size, 0) <= 100 * 1024 * 1024 &&
      new Set(b.files.map((f) => f.id)).size === b.files.length,
    "UPLOAD_LIMIT",
  );
export const partSchema = z
  .object({
    data: z.string().max(Math.ceil(PART_SIZE / 3) * 4),
    sha256: checksum,
  })
  .strict();
export const runSchema = z
  .object({
    revision: z.number().int().positive(),
    mode: z.enum(["model", "offline"]),
  })
  .strict();
export const disclosureSchema = z
  .object({
    reviewerId: z.string().min(1).max(200),
    readers: z.array(z.string().min(1).max(200)).min(2).max(100),
    sourceAuthorization: z.literal("request_authorized_source_review"),
  })
  .strict();
type Row = Record<string, any>;
type BackgroundAuthorizer = (row: Row) => Promise<Context>;
const safeCode = (e: unknown) =>
  e instanceof Error && /^[A-Z_]{1,80}$/.test(e.message)
    ? e.message
    : "IMPORT_FAILED";
const terminal = [
  "review_ready",
  "no_changes",
  "parsed",
  "failed",
  "cancelled",
  "authorization_required",
  "proposed",
];

export class ImportService {
  authorizer?: BackgroundAuthorizer;
  private stopping = false;
  private running = false;
  constructor(
    readonly pool: Pool,
    readonly runtime: RuntimeService,
    readonly options: ImportServiceOptions = {},
  ) {}
  private async modelHooks(
    ctx: Context,
    row: Row,
    imported: Row,
    envelope: InputEnvelope,
    rechecks: ((db: PoolClient) => Promise<void>)[],
    bindings: Map<number, ImportCallBinding>,
  ): Promise<OrganizeHooks> {
    const fullInputHash = await transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        const input = await this.own(db, ctx, imported.id, true);
        const files = (
          await db.query(
            "SELECT id,size,sha256,received FROM import_files WHERE workspace_id=$1 AND import_id=$2 ORDER BY id",
            [ctx.workspaceId, imported.id],
          )
        ).rows;
        return digest({
          revision: input.revision,
          selection: input.selection,
          parsed: input.parsed,
          files,
        });
      },
    );
    return {
      modelOptions: async (meta) => {
        await this.guard(row, row.lease_token);
        const endpoint = this.options.trustedLocalModel
            ? "http://127.0.0.1/trusted-local-model-fixture"
            : configuredModelEndpoint(),
          base = {
            maxContextBytes: 320000,
            maxOutputTokens: 6000,
            ...this.options.modelOptions,
          };
        const metadata: ImportTransmissionMetadata = {
          ...meta,
          runId: row.id,
          importId: imported.id,
          inputRevision: row.input_revision,
          attempt: row.attempt,
          pageIds: [...envelope.pageIds],
          sourceIds: [...envelope.sourceIds],
          fullInputHash,
          configuredEndpoint: endpoint,
        };
        const policy = this.options.beforeModelTransmission
          ? await this.options.beforeModelTransmission(
              ctx,
              metadata,
              envelope,
              base,
            )
          : await bindPrivateImportTransmission(
              this.pool,
              ctx,
              { importId: imported.id, inputRevision: row.input_revision },
              envelope,
              base,
              endpoint,
            );
        if (
          !policy?.options ||
          typeof policy.recheck !== "function" ||
          (!this.options.trustedLocalModel &&
            typeof policy.options.beforeTransmission !== "function")
        )
          throw Error("MODEL_TRANSMISSION_DENIED");
        const rules =
            policy.options.rules ??
            (await readFile(
              new URL("../../wiki/SCHEMA.md", import.meta.url),
              "utf8",
            )),
          maxOutput = policy.options.maxOutputTokens ?? 6000,
          maxContext = policy.options.maxContextBytes ?? 320000;
        const reservation = {
          tokens:
            Math.min(
              maxContext,
              meta.contextBytes + Buffer.byteLength(rules) + 16384,
            ) + maxOutput,
          costMicros: this.options.maxCostMicrosPerCall ?? 100000,
        };
        const correlation = this.options.correlation?.(ctx) ?? {
            requestId: (ctx as Context & { requestId?: string }).requestId,
          },
          clean = (v: string | undefined) =>
            v && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v) ? v : undefined;
        const b: ImportCallBinding = {
          workspaceId: ctx.workspaceId,
          principalId: ctx.principalId,
          runId: row.id,
          importId: imported.id,
          attempt: row.attempt,
          leaseToken: row.lease_token,
          inputRevision: row.input_revision,
          privateInputHash: fullInputHash,
          meta,
          requestId: clean(correlation.requestId),
          jobId: clean(correlation.jobId),
        };
        await transaction(this.pool, ctx.workspaceId, async (db) => {
          const current = await this.own(db, ctx, imported.id, true);
          await this.authorize(db, ctx, "changeset.propose");
          await this.assertPolicy(db, ctx, row);
          if (current.revision !== row.input_revision)
            throw Error("INPUT_CHANGED");
          await reserveImportCall(db, b, reservation);
        });
        bindings.set(meta.index, b);
        rechecks.push(policy.recheck);
        const original = policy.options;
        return {
          ...original,
          beforeCall: async (provider, model) => {
            await this.guard(row, row.lease_token);
            await original.beforeCall?.(provider, model);
            await transaction(this.pool, ctx.workspaceId, async (db) => {
              await this.own(db, ctx, imported.id, true);
              await this.authorize(db, ctx, "changeset.propose");
              await this.assertPolicy(db, ctx, row);
              await startImportCall(db, b, provider, model);
            });
          },
          onUsage: async (usage) => {
            const over = await recordImportUsage(this.pool, b, usage);
            await original.onUsage?.(usage);
            if (over) throw Error("BUDGET_EXCEEDED");
          },
        };
      },
      onCallError: async (meta, error) => {
        const b = bindings.get(meta.index);
        if (b) await finishImportCall(this.pool, b, error);
      },
      onCallFinished: async (meta) => {
        const b = bindings.get(meta.index);
        if (b) await finishImportCall(this.pool, b);
      },
    };
  }
  private async authorize(
    db: PoolClient,
    ctx: Context,
    action:
      | "knowledge.read"
      | "source.create"
      | "changeset.propose" = "knowledge.read",
  ) {
    const role = await membership(db, ctx);
    await ctx.authorization?.assertSession(db);
    await authorizeInTransaction(db, ctx, action);
    return role;
  }
  private async own(db: PoolClient, ctx: Context, id: string, write = false) {
    await this.authorize(db, ctx, write ? "source.create" : "knowledge.read");
    const r = await db.query(
      "SELECT * FROM imports WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 FOR UPDATE",
      [ctx.workspaceId, id, ctx.principalId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    await assertReleasedImportContext(db, ctx, id);
    return r.rows[0] as Row;
  }
  private async personalOwner(db: PoolClient, ctx: Context) {
    const a = await effectiveAccess(db, ctx);
    return a.space.namespaceKind === "personal" && a.space.owner;
  }
  private async qualifiedReviewers(db: PoolClient, ctx: Context) {
    const rows = (
      await db.query(
        "SELECT r.principal_id FROM access_reviewers r JOIN access_principals p ON p.id=r.principal_id AND p.active AND p.kind='human' WHERE r.workspace_id=$1",
        [ctx.workspaceId],
      )
    ).rows;
    const allowed: string[] = [];
    for (const row of rows) {
      const access = await effectiveAccess(db, {
        workspaceId: ctx.workspaceId,
        principalId: row.principal_id,
      });
      if (
        access.capabilities.includes("changeset.approve") &&
        this.reviewers().has(row.principal_id)
      )
        allowed.push(row.principal_id);
    }
    return allowed;
  }
  private async readInputs(
    db: PoolClient,
    ctx: Context,
    envelope: InputEnvelope,
  ) {
    for (const id of envelope.sourceIds)
      await authorizeInTransaction(db, ctx, "knowledge.read", {
        kind: "source",
        id,
      });
    for (const id of envelope.pageIds)
      await authorizeInTransaction(db, ctx, "knowledge.read", {
        kind: "page",
        id,
      });
  }
  private reviewers() {
    return new Set(
      (process.env.IMPORT_DISCLOSURE_REVIEWERS || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
  }
  async config(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx);
      const eligible = await this.qualifiedReviewers(db, ctx);
      return {
        personal: await this.personalOwner(db, ctx),
        partSize: PART_SIZE,
        maxFileSize: MAX_FILE,
        reviewers: eligible,
        canReviewDisclosure: eligible.includes(ctx.principalId),
      };
    });
  }
  async create(ctx: Context, input: unknown, key: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      const body = importCreateSchema.parse(input);
      requestKey.parse(key);
      const fingerprint = digest(body);
      const old = await db.query(
        "SELECT id,request_hash FROM imports WHERE workspace_id=$1 AND principal_id=$2 AND request_key=$3",
        [ctx.workspaceId, ctx.principalId, key],
      );
      if (old.rowCount) {
        await assertReleasedImportContext(db, ctx, old.rows[0].id);
        if (old.rows[0].request_hash !== fingerprint)
          throw Error("IDEMPOTENCY_CONFLICT");
        return { id: old.rows[0].id };
      }
      const limit = await db.query(
        "SELECT count(*)::int n FROM imports WHERE workspace_id=$1 AND principal_id=$2 AND status<>'erased'",
        [ctx.workspaceId, ctx.principalId],
      );
      if (limit.rows[0].n >= 100) throw Error("IMPORT_QUOTA");
      const storage = await db.query(
        "SELECT COALESCE(sum(f.size),0)::bigint total,COALESCE(sum(f.size) FILTER(WHERE i.principal_id=$2),0)::bigint personal FROM import_files f JOIN imports i ON i.workspace_id=f.workspace_id AND i.id=f.import_id WHERE f.workspace_id=$1 AND i.status<>'erased'",
        [ctx.workspaceId, ctx.principalId],
      );
      const reserved = body.files.reduce((n, f) => n + f.size, 0);
      if (
        Number(storage.rows[0].personal) + reserved > 250 * 1024 * 1024 ||
        Number(storage.rows[0].total) + reserved > 1024 * 1024 * 1024
      )
        throw Error("IMPORT_QUOTA");
      const id = randomUUID();
      await db.query(
        "INSERT INTO imports(workspace_id,id,principal_id,title,selection,request_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          ctx.workspaceId,
          id,
          ctx.principalId,
          body.title,
          defaultSelection,
          key,
          fingerprint,
        ],
      );
      for (const file of body.files)
        await db.query(
          "INSERT INTO import_files(workspace_id,import_id,id,name,size,sha256) VALUES($1,$2,$3,$4,$5,$6)",
          [ctx.workspaceId, id, file.id, file.name, file.size, file.sha256],
        );
      await audit(db, ctx, "import.create", id);
      return { id };
    });
  }
  async uploadPart(
    ctx: Context,
    id: string,
    fileId: string,
    part: number,
    input: unknown,
  ) {
    await transaction(this.pool, ctx.workspaceId, (db) =>
      this.own(db, ctx, id, true),
    );
    const body = partSchema.parse(input);
    identifier.parse(fileId);
    if (!Number.isSafeInteger(part) || part < 0)
      throw Error("VALIDATION_FAILED");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        body.data,
      )
    )
      throw Error("INVALID_UPLOAD");
    const bytes = Buffer.from(body.data, "base64");
    if (hash(bytes) !== body.sha256) throw Error("CHECKSUM_MISMATCH");
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id, true);
      if (row.status !== "uploading") throw Error("INPUT_FROZEN");
      const f = await db.query(
        "SELECT * FROM import_files WHERE workspace_id=$1 AND import_id=$2 AND id=$3",
        [ctx.workspaceId, id, fileId],
      );
      if (!f.rowCount) throw Error("NOT_FOUND");
      const expected = Math.min(PART_SIZE, f.rows[0].size - part * PART_SIZE);
      if (expected <= 0 || bytes.length !== expected)
        throw Error("INVALID_UPLOAD");
      const old = await db.query(
        "SELECT sha256 FROM import_parts WHERE workspace_id=$1 AND import_id=$2 AND file_id=$3 AND part=$4",
        [ctx.workspaceId, id, fileId, part],
      );
      if (old.rowCount) {
        if (old.rows[0].sha256 !== body.sha256)
          throw Error("IDEMPOTENCY_CONFLICT");
        return { received: f.rows[0].received };
      }
      await db.query("INSERT INTO import_parts VALUES($1,$2,$3,$4,$5,$6)", [
        ctx.workspaceId,
        id,
        fileId,
        part,
        body.sha256,
        bytes,
      ]);
      const next = await db.query(
        "UPDATE import_files SET received=received+$4 WHERE workspace_id=$1 AND import_id=$2 AND id=$3 RETURNING received",
        [ctx.workspaceId, id, fileId, bytes.length],
      );
      return { received: next.rows[0].received };
    });
  }
  private async files(db: PoolClient, ctx: Context, id: string) {
    await this.own(db, ctx, id, true);
    const workspace = ctx.workspaceId;
    const files = await db.query(
      "SELECT * FROM import_files WHERE workspace_id=$1 AND import_id=$2 ORDER BY id",
      [workspace, id],
    );
    const result = [];
    for (const f of files.rows) {
      const parts = await db.query(
        "SELECT part,data FROM import_parts WHERE workspace_id=$1 AND import_id=$2 AND file_id=$3 ORDER BY part",
        [workspace, id, f.id],
      );
      if (f.received !== f.size || parts.rows.some((r, i) => r.part !== i))
        throw Error("UPLOAD_INCOMPLETE");
      const bytes = Buffer.concat(parts.rows.map((r) => r.data as Buffer));
      if (bytes.length !== f.size || hash(bytes) !== f.sha256)
        throw Error("CHECKSUM_MISMATCH");
      result.push({ id: f.id, name: f.name, sha256: f.sha256, bytes });
    }
    return result;
  }
  private async enqueue(
    db: PoolClient,
    ctx: Context,
    row: Row,
    mode: string,
    key: string,
  ) {
    await this.own(db, ctx, row.id, true);
    if (mode !== "preflight")
      await this.authorize(db, ctx, "changeset.propose");
    requestKey.parse(key);
    const fingerprint = digest([row.id, row.revision, mode, row.selection]);
    const old = await db.query(
      "SELECT id,request_hash FROM import_runs WHERE workspace_id=$1 AND principal_id=$2 AND request_key=$3",
      [ctx.workspaceId, ctx.principalId, key],
    );
    if (old.rowCount) {
      if (old.rows[0].request_hash !== fingerprint)
        throw Error("IDEMPOTENCY_CONFLICT");
      return { id: old.rows[0].id };
    }
    const active = await db.query(
      "SELECT id FROM import_runs WHERE workspace_id=$1 AND import_id=$2 AND status IN ('queued','running')",
      [ctx.workspaceId, row.id],
    );
    if (active.rowCount) throw Error("IMPORT_BUSY");
    const quota = await db.query(
      "SELECT count(*)::int n FROM import_runs WHERE workspace_id=$1 AND status IN ('queued','running')",
      [ctx.workspaceId],
    );
    if (quota.rows[0].n >= 20) throw Error("JOB_CAPACITY");
    const role = await membership(db, ctx),
      id = randomUUID();
    await db.query(
      `INSERT INTO import_runs(workspace_id,id,import_id,principal_id,input_revision,mode,session_id,grant_role,grant_expires_at,request_key,request_hash,execution_config)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '1 hour',$9,$10,$11)`,
      [
        ctx.workspaceId,
        id,
        row.id,
        ctx.principalId,
        row.revision,
        mode,
        ctx.authorization?.sessionId || null,
        role,
        key,
        fingerprint,
        {
          ...executionConfig(),
          accessRevision:
            (
              await db.query(
                "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
                [ctx.workspaceId],
              )
            ).rows[0]?.policy_version ?? null,
        },
      ],
    );
    await audit(db, ctx, "import.enqueue", id);
    return { id };
  }
  async finalize(ctx: Context, id: string, key: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id, true);
      if (row.status === "uploading") {
        await this.files(db, ctx, id);
        await db.query(
          "UPDATE imports SET status='finalized',updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id],
        );
      }
      return this.enqueue(db, ctx, row, "preflight", key);
    });
  }
  async select(ctx: Context, id: string, revision: number, input: unknown) {
    await transaction(this.pool, ctx.workspaceId, (db) =>
      this.own(db, ctx, id, true),
    );
    const selection = selectionSchema.parse(input);
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id, true);
      if (row.revision !== revision) throw Error("INPUT_CHANGED");
      const active = await db.query(
        "SELECT id FROM import_runs WHERE workspace_id=$1 AND import_id=$2 AND (status IN ('queued','running','proposed') OR changeset IS NOT NULL OR EXISTS(SELECT 1 FROM import_disclosures d WHERE d.workspace_id=import_runs.workspace_id AND d.run_id=import_runs.id AND d.status='approved'))",
        [ctx.workspaceId, id],
      );
      if (active.rowCount) throw Error("INPUT_FROZEN");
      if (
        digest({ ...row.selection, acknowledgeWarnings: false }) ===
        digest({ ...selection, acknowledgeWarnings: false })
      ) {
        await db.query(
          "UPDATE imports SET selection=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, id, selection],
        );
        return { revision: row.revision };
      }
      selection.acknowledgeWarnings = false;
      await db.query(
        "DELETE FROM import_disclosures WHERE workspace_id=$1 AND run_id IN (SELECT id FROM import_runs WHERE workspace_id=$1 AND import_id=$2)",
        [ctx.workspaceId, id],
      );
      await db.query(
        "UPDATE imports SET selection=$3,revision=revision+1,parsed=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id, selection],
      );
      return { revision: row.revision + 1 };
    });
  }
  async start(ctx: Context, id: string, input: unknown, key: string) {
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.own(db, ctx, id, true);
      await this.authorize(db, ctx, "changeset.propose");
    });
    const body = runSchema.parse(input);
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id, true);
      if (row.revision !== body.revision) throw Error("INPUT_CHANGED");
      if (!row.parsed) throw Error("PREFLIGHT_REQUIRED");
      if (row.parsed.warnings.length && !row.selection.acknowledgeWarnings)
        throw Error("WARNINGS_REQUIRE_ACKNOWLEDGEMENT");
      return this.enqueue(db, ctx, row, body.mode, key);
    });
  }
  async list(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx);
      return (
        await db.query(
          "SELECT id,title,status,revision,created_at AS \"createdAt\" FROM imports WHERE workspace_id=$1 AND principal_id=$2 AND status<>'erased' ORDER BY created_at DESC LIMIT 100",
          [ctx.workspaceId, ctx.principalId],
        )
      ).rows;
    });
  }
  private runView(row: Row): ImportRunView {
    return {
      id: row.id,
      importId: row.import_id,
      status: row.status,
      stage: row.stage,
      attempt: row.attempt,
      cancelRequested: row.cancel_requested,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      errorCode: row.error_code,
      result: row.result,
      changeSet: row.changeset,
    };
  }
  async view(ctx: Context, id: string, offset = 0): Promise<ImportView> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20000)
      throw Error("VALIDATION_FAILED");
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      const row = await this.own(db, ctx, id);
      const files = await db.query(
        "SELECT id,name,size,received,sha256 FROM import_files WHERE workspace_id=$1 AND import_id=$2 ORDER BY id",
        [ctx.workspaceId, id],
      );
      const runs = await db.query(
        "SELECT * FROM import_runs WHERE workspace_id=$1 AND import_id=$2 ORDER BY created_at DESC LIMIT 50",
        [ctx.workspaceId, id],
      );
      const state = await loadState(db, ctx.workspaceId);
      const visible = await visiblePageIds(db, ctx, state);
      for (const run of runs.rows)
        if (run.input_envelope) {
          let allowed = run.input_envelope.pageIds.every((id: string) =>
            visible.has(id),
          );
          for (const id of run.input_envelope.sourceIds)
            if (
              !(await readers(db, ctx.workspaceId, "source", id)).includes(
                ctx.principalId,
              )
            )
              allowed = false;
          try {
            await this.readInputs(db, ctx, run.input_envelope);
          } catch (e) {
            if (
              e instanceof Error &&
              ["NOT_FOUND", "FORBIDDEN", "SOURCE_SCOPE_CONFLICT"].includes(
                e.message,
              )
            )
              allowed = false;
            else throw e;
          }
          if (!allowed) {
            run.result = null;
            run.changeset = null;
            run.status = "authorization_required";
            run.error_code = "SOURCE_SCOPE_CONFLICT";
          }
        }
      // Imported records are private to their creator, even for workspace reviewers.
      const parsed: ParsedImport | null = row.parsed
        ? {
            ...row.parsed,
            records: row.parsed.records.slice(offset, offset + 50),
          }
        : null;
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        revision: row.revision,
        selection: row.selection,
        files: files.rows,
        parsed,
        runs: runs.rows.map((r) => this.runView(r)),
      };
    });
  }
  async runViewFor(ctx: Context, id: string) {
    const r = await this.pool.query(
      "SELECT import_id FROM import_runs WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
      [ctx.workspaceId, id, ctx.principalId],
    );
    if (!r.rowCount) throw Error("NOT_FOUND");
    const view = await this.view(ctx, r.rows[0].import_id);
    const run = view.runs.find((r) => r.id === id);
    if (!run) throw Error("NOT_FOUND");
    return run;
  }
  async cancel(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx);
      const r = await db.query(
        "SELECT * FROM import_runs WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 FOR UPDATE",
        [ctx.workspaceId, id, ctx.principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      await assertReleasedImportContext(db, ctx, r.rows[0].import_id);
      if (
        r.rows[0].changeset ||
        (
          await db.query(
            "SELECT 1 FROM import_disclosures WHERE workspace_id=$1 AND run_id=$2 AND status='approved'",
            [ctx.workspaceId, id],
          )
        ).rowCount
      )
        throw Error("ALREADY_PROPOSED");
      await db.query(
        "UPDATE import_runs SET cancel_requested=true,status=CASE WHEN status='running' THEN status ELSE 'cancelled' END,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [ctx.workspaceId, id],
      );
      await db.query(
        "DELETE FROM import_disclosures WHERE workspace_id=$1 AND run_id=$2 AND status='pending'",
        [ctx.workspaceId, id],
      );
      await audit(db, ctx, "import.cancel", id);
      return { requested: true };
    });
  }
  private async withdrawSources(
    db: PoolClient,
    ctx: Context,
    sourceIds: string[],
  ) {
    if (!sourceIds.length) return;
    await db.query(
      "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=ANY($2::text[])",
      [ctx.workspaceId, sourceIds],
    );
    await db.query(
      "UPDATE sources SET data=jsonb_set(jsonb_set(data,'{content}',to_jsonb('[원본 소유자가 철회한 자료]'::text)),'{importWithdrawn}','true') WHERE workspace_id=$1 AND id=ANY($2::text[])",
      [ctx.workspaceId, sourceIds],
    );
    const batches = await db.query(
      "SELECT id,data FROM batches WHERE workspace_id=$1",
      [ctx.workspaceId],
    );
    for (const row of batches.rows) {
      let changed = false;
      for (const snapshot of row.data.snapshots || [])
        if (sourceIds.includes(snapshot.id)) {
          snapshot.content = "[원본 소유자가 철회한 자료]";
          changed = true;
        }
      if (changed) {
        await db.query(
          "UPDATE batches SET data=$3 WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, row.id, row.data],
        );
        await db.query(
          "DELETE FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
          [ctx.workspaceId, row.id],
        );
      }
    }
    await audit(db, ctx, "import.source.withdraw", sourceIds[0]);
  }
  async remove(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.own(db, ctx, id);
      const sources = await db.query(
        "SELECT id FROM sources WHERE workspace_id=$1 AND data->>'importOwnerId'=$2 AND data->>'importId'=$3",
        [ctx.workspaceId, ctx.principalId, id],
      );
      await replayReleasedInputRemoval(db, {
        workspace_id: ctx.workspaceId,
        import_id: id,
        principal_id: ctx.principalId,
      });
      await this.withdrawSources(
        db,
        ctx,
        sources.rows.map((r) => r.id),
      );
      await db.query(
        "DELETE FROM imports WHERE workspace_id=$1 AND id=$2 AND principal_id=$3",
        [ctx.workspaceId, id, ctx.principalId],
      );
      await audit(db, ctx, "import.remove", id);
      return { removed: true, withdrawnSources: sources.rowCount };
    });
  }
  async resume(ctx: Context, id: string) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      const r = await db.query(
        "SELECT r.*,i.revision FROM import_runs r JOIN imports i ON i.workspace_id=r.workspace_id AND i.id=r.import_id WHERE r.workspace_id=$1 AND r.id=$2 AND r.principal_id=$3 FOR UPDATE OF r",
        [ctx.workspaceId, id, ctx.principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      const row = r.rows[0];
      await assertReleasedImportContext(db, ctx, row.import_id);
      if (row.mode !== "preflight")
        await this.authorize(db, ctx, "changeset.propose");
      if (
        !["failed", "authorization_required", "cancelled"].includes(
          row.status,
        ) ||
        row.changeset
      )
        throw Error("STALE_VERSION");
      if (row.input_revision !== row.revision) throw Error("INPUT_CHANGED");
      if (row.attempt >= 5) throw Error("RETRY_LIMIT");
      if (row.calls >= 20) throw Error("BUDGET_EXCEEDED");
      await db.query(
        "UPDATE import_runs SET status='queued',cancel_requested=false,error_code=NULL,session_id=$3,grant_role=$4,grant_expires_at=now()+interval '1 hour',updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [
          ctx.workspaceId,
          id,
          ctx.authorization?.sessionId || null,
          await membership(db, ctx),
        ],
      );
      await audit(db, ctx, "import.resume", id);
      return { id };
    });
  }
  private async guard(row: Row, token: string) {
    const fresh = await this.pool.query(
      "SELECT * FROM import_runs WHERE workspace_id=$1 AND id=$2",
      [row.workspace_id, row.id],
    );
    const r = fresh.rows[0];
    if (r?.policy_version !== IMPORT_POLICY_VERSION)
      throw Error("POLICY_CHANGED");
    if (
      r?.mode === "model" &&
      digest(
        Object.fromEntries(
          Object.entries(r.execution_config).filter(
            ([key]) => key !== "accessRevision",
          ),
        ),
      ) !== digest(executionConfig())
    )
      throw Error("MODEL_CONFIGURATION_CHANGED");
    if (
      !r ||
      r.lease_token !== token ||
      r.status !== "running" ||
      new Date(r.lease_until).getTime() <= Date.now()
    )
      throw Error("LEASE_LOST");
    if (r.cancel_requested) throw Error("IMPORT_CANCELLED");
    if (new Date(r.grant_expires_at).getTime() <= Date.now())
      throw Error("AUTHORIZATION_REQUIRED");
    const ctx = this.authorizer
      ? await this.authorizer(r)
      : { workspaceId: r.workspace_id, principalId: r.principal_id };
    if (r.session_id && !this.authorizer) throw Error("AUTHORIZATION_REQUIRED");
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      let imported: Row;
      try {
        if ((await this.authorize(db, ctx, "source.create")) !== r.grant_role)
          throw Error("AUTHORIZATION_REQUIRED");
        imported = await this.own(db, ctx, r.import_id, true);
        if (r.mode !== "preflight")
          await this.authorize(db, ctx, "changeset.propose");
      } catch (e) {
        if (
          e instanceof Error &&
          ["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(e.message)
        )
          throw Error("AUTHORIZATION_REQUIRED");
        throw e;
      }
      await this.assertPolicy(db, ctx, r);
      if (imported.revision !== r.input_revision) throw Error("INPUT_CHANGED");
      if (r.input_envelope) {
        await this.readInputs(db, ctx, r.input_envelope);
        await assertEnvelope(
          db,
          ctx,
          await loadState(db, ctx.workspaceId),
          r.input_envelope,
        );
      }
    });
    return ctx;
  }
  private async assertPolicy(db: PoolClient, ctx: Context, row: Row) {
    const revision =
      (
        await db.query(
          "SELECT policy_version FROM access_spaces WHERE workspace_id=$1",
          [ctx.workspaceId],
        )
      ).rows[0]?.policy_version ?? null;
    if (
      revision !== (row.execution_config?.accessRevision ?? null) ||
      row.policy_version !== IMPORT_POLICY_VERSION
    )
      throw Error("POLICY_CHANGED");
  }
  async tick(): Promise<boolean> {
    if (this.running || this.stopping) return false;
    this.running = true;
    let row: Row | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined;
    const transmissionRechecks: ((db: PoolClient) => Promise<void>)[] = [],
      modelBindings = new Map<number, ImportCallBinding>();
    try {
      await this.pool.query(
        "UPDATE import_runs SET status='failed',stage='failed',error_code='RETRY_LIMIT',lease_until=NULL,updated_at=now() WHERE attempt>=5 AND (status='queued' OR (status='running' AND lease_until<clock_timestamp()))",
      );
      const claim = await this.pool
        .query(`UPDATE import_runs SET status='running',stage=CASE WHEN mode='preflight' THEN 'parsing' ELSE 'compiling' END,
        lease_token=lease_token+1,lease_until=clock_timestamp()+interval '120 seconds',attempt=attempt+1,updated_at=clock_timestamp()
        WHERE (workspace_id,id)=(SELECT workspace_id,id FROM import_runs WHERE (status='queued' OR (status='running' AND lease_until<clock_timestamp()))
        AND attempt<5 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
      if (!claim.rowCount) return false;
      row = claim.rows[0];
      const token = row!.lease_token as string;
      heartbeat = setInterval(() => {
        void this.pool
          .query(
            "UPDATE import_runs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='running'",
            [row!.workspace_id, row!.id, token],
          )
          .catch(() => {});
      }, 20_000);
      heartbeat.unref();
      const ctx = await this.guard(row!, token);
      const imported = await transaction(this.pool, ctx.workspaceId, (db) =>
        this.own(db, ctx, row!.import_id, true),
      );
      let parsed: ParsedImport = imported.parsed;
      if (!parsed) {
        const files = await transaction(this.pool, ctx.workspaceId, (db) =>
          this.files(db, ctx, imported.id),
        );
        await this.guard(row!, token);
        parsed = await isolatedParse(files, imported.selection);
        await this.guard(row!, token);
        await transaction(this.pool, ctx.workspaceId, async (db) => {
          await this.own(db, ctx, imported.id, true);
          const lease = await db.query(
            "SELECT id FROM import_runs WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp() FOR UPDATE",
            [ctx.workspaceId, row!.id, token],
          );
          if (!lease.rowCount) throw Error("LEASE_LOST");
          const deleted = parsed.records
            .filter((r) => r.event === "deleted")
            .map((r) => r.sourceKey);
          if (deleted.length) {
            const affected = await db.query(
              "SELECT id FROM sources WHERE workspace_id=$1 AND data->>'importOwnerId'=$2 AND data->'importRecordKeys' ?| $3::text[]",
              [ctx.workspaceId, ctx.principalId, deleted],
            );
            await this.withdrawSources(
              db,
              ctx,
              affected.rows.map((r) => r.id),
            );
          }
          await db.query(
            "INSERT INTO import_observations(workspace_id,principal_id,source_key,content_hash,import_id,record_id,event) SELECT $1,$2,source_key,content_hash,$3,record_id,event FROM unnest($4::text[],$5::text[],$6::text[],$7::text[]) AS x(source_key,content_hash,record_id,event) ON CONFLICT DO NOTHING",
            [
              ctx.workspaceId,
              ctx.principalId,
              imported.id,
              parsed.records.map((r) => r.sourceKey),
              parsed.records.map((r) => r.contentHash),
              parsed.records.map((r) => r.id),
              parsed.records.map((r) => r.event),
            ],
          );
          await db.query(
            "UPDATE imports SET parsed=$3,status='ready',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$4",
            [ctx.workspaceId, imported.id, parsed, imported.revision],
          );
        });
      }
      let result: ImportResult | null = null;
      if (row!.mode !== "preflight") {
        const { state } = await this.runtime.snapshot(ctx);
        const words = String(imported.selection.project || imported.title)
          .toLowerCase()
          .split(/\s+/)
          .filter((x) => x.length >= 2);
        const pages = state.pages
          .filter(
            (p) =>
              state.pages.length <= 20 ||
              words.some((w) =>
                (p.title + " " + p.summary).toLowerCase().includes(w),
              ),
          )
          .slice(0, 20);
        const envelope = await transaction(
          this.pool,
          ctx.workspaceId,
          async (db) => {
            await this.own(db, ctx, imported.id, true);
            await this.authorize(db, ctx, "changeset.propose");
            for (const page of pages)
              await authorizeInTransaction(db, ctx, "knowledge.read", {
                kind: "page",
                id: page.id,
              });
            return captureEnvelope(
              db,
              ctx,
              state,
              pages.map((p) => p.id),
            );
          },
        );
        await transaction(this.pool, ctx.workspaceId, async (db) => {
          await this.own(db, ctx, imported.id, true);
          await this.authorize(db, ctx, "changeset.propose");
          await this.assertPolicy(db, ctx, row!);
          return db.query(
            "UPDATE import_runs SET input_envelope=$4,state_hash=$5 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
            [ctx.workspaceId, row!.id, token, envelope, digest(state)],
          );
        });
        const contextPages: ContextPage[] = pages.map((p) => ({
          id: p.id,
          title: p.title,
          content: current(p).content,
          version: current(p).number,
        }));
        result = await organizeRecords(
          parsed.records,
          contextPages,
          (operation,modelContext,modelOptions) => this.runtime.model(operation,modelContext,{...modelOptions,pool:this.pool,workspaceId:ctx.workspaceId,principalId:ctx.principalId}),
          row!.mode,
          async () => {
            await this.guard(row!, token);
          },
          async () => {}, // reserveImportCall atomically increments the SAME max20 run budget.
          Math.max(0, 20 - row!.calls),
          await this.modelHooks(
            ctx,
            row!,
            imported,
            envelope,
            transmissionRechecks,
            modelBindings,
          ),
        );
      }
      await this.guard(row!, token);
      await transaction(this.pool, ctx.workspaceId, async (db) => {
        await this.own(db, ctx, imported.id, true);
        if (row!.mode !== "preflight")
          await this.authorize(db, ctx, "changeset.propose");
        const checked = await db.query(
          "SELECT * FROM import_runs WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 FOR UPDATE",
          [ctx.workspaceId, row!.id, token],
        );
        if (!checked.rowCount || checked.rows[0].cancel_requested)
          throw Error("IMPORT_CANCELLED");
        await this.assertPolicy(db, ctx, checked.rows[0]);
        if (
          checked.rows[0].status !== "running" ||
          new Date(checked.rows[0].lease_until).getTime() <= Date.now()
        )
          throw Error("LEASE_LOST");
        if (checked.rows[0].input_envelope)
          await assertEnvelope(
            db,
            ctx,
            await loadState(db, ctx.workspaceId),
            checked.rows[0].input_envelope,
          );
        for (const recheck of transmissionRechecks) await recheck(db);
        if (result) result.calls = checked.rows[0].calls;
        const status =
          row!.mode === "preflight"
            ? "parsed"
            : result!.topics.length
              ? "review_ready"
              : "no_changes";
        await db.query(
          "UPDATE import_runs SET status=$4,stage=$4,result=$5,lease_until=NULL,error_code=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
          [ctx.workspaceId, row!.id, token, status, result],
        );
        await audit(db, ctx, "import." + status, row!.id);
      });
      return true;
    } catch (e) {
      if (row) {
        const code = safeCode(e);
        for (const binding of modelBindings.values())
          await finishImportCall(this.pool, binding, Error(code)).catch(
            () => {},
          );
        await this.pool
          .query(
            "UPDATE import_runs SET status=$4,stage=$4,error_code=$5,lease_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='running'",
            [
              row.workspace_id,
              row.id,
              row.lease_token,
              code === "IMPORT_CANCELLED"
                ? "cancelled"
                : code === "AUTHORIZATION_REQUIRED" ||
                    code === "UNAUTHENTICATED"
                  ? "authorization_required"
                  : "failed",
              code,
            ],
          )
          .catch(() => {});
      }
      return Boolean(row);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.running = false;
    }
  }
  startWorker(interval = 1000) {
    this.stopping = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (this.stopping) return;
      await this.tick();
      if (!this.stopping) {
        timer = setTimeout(() => {
          void poll();
        }, interval);
        timer.unref();
      }
    };
    void poll();
    return () => {
      this.stopping = true;
      clearTimeout(timer);
    };
  }
  async requestDisclosure(ctx: Context, id: string, input: unknown) {
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      await this.authorize(db, ctx, "changeset.propose");
    });
    const body = disclosureSchema.parse(input),
      audience = [...new Set(body.readers)].sort();
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      await this.authorize(db, ctx, "changeset.propose");
      const r = await db.query(
        "SELECT r.*,i.parsed,i.revision FROM import_runs r JOIN imports i ON i.workspace_id=r.workspace_id AND i.id=r.import_id WHERE r.workspace_id=$1 AND r.id=$2 AND r.principal_id=$3 FOR UPDATE OF r",
        [ctx.workspaceId, id, ctx.principalId],
      );
      if (!r.rowCount) throw Error("NOT_FOUND");
      const row = r.rows[0];
      await this.own(db, ctx, row.import_id, true);
      await this.assertPolicy(db, ctx, row);
      if (
        row.status !== "review_ready" ||
        row.input_revision !== row.revision ||
        row.cancel_requested
      )
        throw Error("STALE_VERSION");
      if (
        !(await this.qualifiedReviewers(db, ctx)).includes(body.reviewerId) ||
        body.reviewerId === ctx.principalId ||
        !audience.includes(ctx.principalId) ||
        !audience.includes(body.reviewerId)
      )
        throw Error("FORBIDDEN");
      for (const principalId of audience)
        if (
          !(
            await effectiveAccess(db, {
              workspaceId: ctx.workspaceId,
              principalId,
            })
          ).role
        )
          throw Error("FORBIDDEN");
      if (row.input_envelope) {
        await this.readInputs(db, ctx, row.input_envelope);
        await assertEnvelope(
          db,
          ctx,
          await loadState(db, ctx.workspaceId),
          row.input_envelope,
        );
      }
      // Every supplied page/source can taint the synthesized prose. Do not expand its audience.
      for (const [kind, ids] of [
        ["source", row.input_envelope?.sourceIds || []],
        ["page", row.input_envelope?.pageIds || []],
      ] as [string, string[]][])
        for (const ref of ids) {
          const allowed = await readers(db, ctx.workspaceId, kind, ref);
          if (audience.some((who) => !allowed.includes(who)))
            throw Error("SOURCE_SCOPE_CONFLICT");
        }
      const fingerprint = digest([
        row.result,
        row.input_revision,
        row.input_envelope,
        audience,
        body.reviewerId,
      ]);
      const previous = await db.query(
        "SELECT status FROM import_disclosures WHERE workspace_id=$1 AND run_id=$2",
        [ctx.workspaceId, id],
      );
      if (previous.rows[0]?.status === "approved")
        throw Error("ALREADY_PROPOSED");
      await db.query(
        "INSERT INTO import_disclosures(workspace_id,run_id,principal_id,reviewer_id,audience,hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,run_id) DO UPDATE SET reviewer_id=excluded.reviewer_id,audience=excluded.audience,hash=excluded.hash,status='pending',approved_at=NULL",
        [
          ctx.workspaceId,
          id,
          ctx.principalId,
          body.reviewerId,
          JSON.stringify(audience),
          fingerprint,
        ],
      );
      await audit(db, ctx, "import.disclosure.request", id);
      return { id, hash: fingerprint };
    });
  }
  async disclosureList(ctx: Context) {
    return transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx);
      if (!(await this.qualifiedReviewers(db, ctx)).includes(ctx.principalId))
        return [];
      await authorizeInTransaction(db, ctx, "changeset.approve");
      const rows = await db.query(
        "SELECT d.*,r.import_id,r.policy_version,r.execution_config,r.result,r.input_revision,r.input_envelope,r.cancel_requested,i.parsed,i.title,i.revision FROM import_disclosures d JOIN import_runs r ON r.workspace_id=d.workspace_id AND r.id=d.run_id JOIN imports i ON i.workspace_id=r.workspace_id AND i.id=r.import_id WHERE d.workspace_id=$1 AND d.reviewer_id=$2 AND d.status='pending' AND r.status='review_ready' ORDER BY d.created_at DESC LIMIT 50",
        [ctx.workspaceId, ctx.principalId],
      );
      const result = [];
      for (const row of rows.rows) {
        if (row.cancel_requested || row.revision !== row.input_revision)
          continue;
        try {
          await assertReleasedImportContext(db, ctx, row.import_id);
          await this.assertPolicy(db, ctx, row);
          if (row.input_envelope) {
            await this.readInputs(db, ctx, row.input_envelope);
            await assertEnvelope(
              db,
              ctx,
              await loadState(db, ctx.workspaceId),
              row.input_envelope,
            );
          }
        } catch {
          continue;
        }
        result.push({
          id: row.run_id,
          title: row.title,
          authorId: row.principal_id,
          audience: row.audience,
          hash: row.hash,
          result: row.result,
          records: row.parsed.records,
        });
      }
      return result;
    });
  }
  async savePersonal(ctx: Context, id: string) {
    const expected = await transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        await this.authorize(db, ctx, "source.create");
        await this.authorize(db, ctx, "changeset.propose");
        if (!(await this.personalOwner(db, ctx))) throw Error("FORBIDDEN");
        const r = await db.query(
          "SELECT * FROM import_runs WHERE workspace_id=$1 AND id=$2 AND principal_id=$3 AND status IN ('review_ready','proposed') AND NOT cancel_requested FOR UPDATE",
          [ctx.workspaceId, id, ctx.principalId],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        const row = r.rows[0],
          hash = digest({
            id,
            revision: row.input_revision,
            result: row.result,
            envelope: row.input_envelope,
            audience: [ctx.principalId],
          });
        await assertReleasedImportContext(db, ctx, row.import_id);
        await this.assertPolicy(db, ctx, row);
        await db.query(
          "INSERT INTO import_disclosures(workspace_id,run_id,principal_id,reviewer_id,audience,hash) VALUES($1,$2,$3,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            ctx.workspaceId,
            id,
            ctx.principalId,
            JSON.stringify([ctx.principalId]),
            hash,
          ],
        );
        return hash;
      },
    );
    const batch = await this.approveDisclosure(ctx, id, expected, true);
    const approved = await this.pool.query(
      "SELECT 1 FROM approvals WHERE workspace_id=$1 AND batch_id=$2",
      [ctx.workspaceId, batch.id],
    );
    const published = await this.pool.query(
      "SELECT 1 FROM publications WHERE workspace_id=$1 AND batch_id=$2",
      [ctx.workspaceId, batch.id],
    );
    if (!approved.rowCount && !published.rowCount)
      await this.runtime.core.approve(ctx, batch.id, batch.hash);
    return this.runtime.core.publish(
      ctx,
      batch.id,
      batch.hash,
      "personal-" + id,
    );
  }
  async approveDisclosure(
    ctx: Context,
    id: string,
    expectedHash: string,
    personal = false,
  ) {
    // This approval authorizes the selected source snapshot/audience; knowledge publication still requires its own review.
    const prepared = await transaction(
      this.pool,
      ctx.workspaceId,
      async (db) => {
        await this.authorize(db, ctx, "source.create");
        await this.authorize(db, ctx, "changeset.propose");
        if (!personal) {
          await authorizeInTransaction(db, ctx, "changeset.approve");
          if (
            !(await this.qualifiedReviewers(db, ctx)).includes(ctx.principalId)
          )
            throw Error("FORBIDDEN");
        }
        if (personal && !(await this.personalOwner(db, ctx)))
          throw Error("FORBIDDEN");
        const r = await db.query(
          "SELECT d.*,r.import_id,r.policy_version,r.execution_config,r.result,r.input_revision,r.input_envelope,r.status AS run_status,r.changeset,r.cancel_requested,i.parsed,i.revision,i.title,i.selection FROM import_disclosures d JOIN import_runs r ON r.workspace_id=d.workspace_id AND r.id=d.run_id JOIN imports i ON i.workspace_id=r.workspace_id AND i.id=r.import_id WHERE d.workspace_id=$1 AND d.run_id=$2 AND d.reviewer_id=$3 FOR UPDATE OF d,r",
          [ctx.workspaceId, id, ctx.principalId],
        );
        if (!r.rowCount) throw Error("NOT_FOUND");
        const row = r.rows[0];
        await assertReleasedImportContext(db, ctx, row.import_id);
        await this.assertPolicy(db, ctx, row);
        if (row.hash !== expectedHash) throw Error("APPROVAL_STALE");
        if (row.changeset) return row.changeset;
        if (
          !["pending", "approved"].includes(row.status) ||
          row.run_status !== "review_ready" ||
          row.cancel_requested ||
          row.revision !== row.input_revision ||
          (!personal && row.principal_id === ctx.principalId)
        )
          throw Error("STALE_VERSION");
        if (
          personal &&
          (row.principal_id !== ctx.principalId ||
            JSON.stringify(row.audience) !== JSON.stringify([ctx.principalId]))
        )
          throw Error("FORBIDDEN");
        const creator = {
          workspaceId: ctx.workspaceId,
          principalId: row.principal_id,
        };
        await authorizeInTransaction(db, creator, "source.create");
        await authorizeInTransaction(db, creator, "changeset.propose");
        for (const principalId of row.audience)
          if (
            !(
              await effectiveAccess(db, {
                workspaceId: ctx.workspaceId,
                principalId,
              })
            ).role
          )
            throw Error("APPROVAL_STALE");
        const state = await loadState(db, ctx.workspaceId);
        if (row.input_envelope) {
          await this.readInputs(db, ctx, row.input_envelope);
          await this.readInputs(db, creator, row.input_envelope);
          await assertEnvelope(db, ctx, state, row.input_envelope);
          await assertEnvelope(db, creator, state, row.input_envelope);
        }
        for (const [kind, ids] of [
          ["source", row.input_envelope?.sourceIds || []],
          ["page", row.input_envelope?.pageIds || []],
        ] as [string, string[]][])
          for (const ref of ids) {
            const allowed = await readers(db, ctx.workspaceId, kind, ref);
            if (row.audience.some((who: string) => !allowed.includes(who)))
              throw Error("SOURCE_SCOPE_CONFLICT");
          }
        const parsed = row.parsed as ParsedImport,
          result = row.result as ImportResult;
        const chunks: string[] = [];
        let buffer = "";
        for (const record of parsed.records) {
          const block = `[${record.id}] ${record.author} · ${record.occurredRaw || "시간 미상"}\n원문: ${record.anchor.fileName} / ${record.anchor.entry} / ${record.anchor.location} · SHA256 ${record.anchor.sha256}\n${record.text}\n\n`;
          if (buffer.length + block.length > 90_000 && buffer) {
            chunks.push(buffer);
            buffer = "";
          }
          if (block.length > 90_000) throw Error("BUDGET_EXCEEDED");
          buffer += block;
        }
        if (buffer) chunks.push(buffer);
        const serialized = chunks.join("");
        if (serialized.length > 9_000_000) throw Error("BUDGET_EXCEEDED");
        const sourceIds: string[] = [];
        let index = 0;
        for (const content of chunks) {
          const sid = "import-" + hash(id + ":" + index++).slice(0, 48);
          sourceIds.push(sid);
          const source: Source = Object.assign(
            {
              id: sid,
              title: row.title + " · 선택 원본 " + index,
              tool: "web-import",
              project: row.selection.project,
              scope: personal ? ("private" as const) : ("team" as const),
              verification: "미검증" as const,
              content,
              createdAt: new Date().toISOString(),
              processed: false,
              targetPageId: "import-topic-" + hash(id).slice(0, 32),
            },
            {
              importId: row.import_id,
              importOwnerId: row.principal_id,
              importRunId: id,
              importRecordKeys: parsed.records.map((r) => r.sourceKey),
            },
          );
          const old = await db.query(
            "SELECT id FROM sources WHERE workspace_id=$1 AND id=$2",
            [ctx.workspaceId, sid],
          );
          if (!old.rowCount) {
            await addResource(db, ctx.workspaceId, "source", sid, row.audience);
            await db.query(
              "INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)",
              [ctx.workspaceId, sid, source],
            );
          }
        }
        const inherited = (row.input_envelope?.sourceIds || []) as string[];
        const allSources = [...new Set([...sourceIds, ...inherited])];
        if (allSources.length > 100) throw Error("BUDGET_EXCEEDED");
        const updates: Draft[] = result.topics.map((t) => {
          const existing = t.targetPageId
            ? state.pages.find((p) => p.id === t.targetPageId)
            : undefined;
          if (t.targetPageId && !existing) throw Error("STALE_VERSION");
          if (existing && !personal && existing.scope !== "team")
            throw Error("SOURCE_SCOPE_CONFLICT");
          return {
            id:
              existing?.id ||
              "import-topic-" +
                hash(
                  [row.selection.namespace || row.principal_id, t.key].join(
                    ":",
                  ),
                ).slice(0, 40),
            title: t.title,
            summary: t.summary,
            content: t.content,
            scope: personal ? "private" : "team",
            sourceIds: allSources,
            links: t.relatedPageIds.filter((p) => p !== existing?.id),
            facts: [],
            baseVersion: existing ? current(existing).number : 0,
          };
        });
        await db.query(
          "UPDATE import_disclosures SET status='approved',approved_at=now() WHERE workspace_id=$1 AND run_id=$2",
          [ctx.workspaceId, id],
        );
        await audit(db, ctx, "import.disclosure.approve", id);
        return {
          updates,
          sourceIds: allSources,
          envelope: row.input_envelope as InputEnvelope | undefined,
          authorId: row.principal_id,
          importId: row.import_id as string,
        };
      },
    );
    if ("id" in prepared) return prepared;
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      await this.authorize(db, ctx, "changeset.propose");
      await assertReleasedImportContext(db, ctx, prepared.importId);
      if (prepared.envelope) await this.readInputs(db, ctx, prepared.envelope);
    });
    const batch = await propose(
      this.pool,
      ctx,
      prepared.updates,
      prepared.sourceIds,
      {
        mode: "model",
        dependencyIds: prepared.envelope?.pageIds,
        inputEnvelope: prepared.envelope,
        importRunId: id,
        importAuthorId: prepared.authorId,
      },
    );
    await transaction(this.pool, ctx.workspaceId, async (db) => {
      await this.authorize(db, ctx, "source.create");
      await this.authorize(db, ctx, "changeset.propose");
      await assertReleasedImportContext(db, ctx, prepared.importId);
      const saved = await db.query(
        "UPDATE import_runs SET status='proposed',stage='proposed',changeset=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND cancel_requested=false AND status='review_ready'",
        [ctx.workspaceId, id, batch],
      );
      if (!saved.rowCount) throw Error("IMPORT_CANCELLED");
      return saved;
    });
    return batch;
  }
}
