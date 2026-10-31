import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { transaction } from "../database";
import type { Context } from "../service";
import type { ModelUsage } from "../runtime/model";
import type { OrganizeCall } from "./organizer";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function safeModelLabel(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 200 ||
    /[\x00-\x1f\x7f?#@]/.test(value)
  )
    return null;
  for (const key of ["AGENT_KNOWLEDGE_HUB_LLM_API_KEY", "OIDC_CLIENT_SECRET"]) {
    const secret = process.env[key];
    if (secret && secret.length >= 8 && value.includes(secret)) return null;
  }
  return value;
}
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export interface ImportCallBinding {
  workspaceId: string;
  principalId: string;
  runId: string;
  importId: string;
  attempt: number;
  leaseToken: string;
  inputRevision: number;
  privateInputHash: string;
  meta: OrganizeCall;
  requestId?: string;
  jobId?: string;
}
export function importCallId(b: ImportCallBinding) {
  return hash([
    b.workspaceId,
    b.runId,
    b.attempt,
    b.leaseToken,
    b.meta.index,
    b.meta.inputHash,
  ]);
}
/** SAME shared workspace/principal/day rows and lock order as jobs.reserve; no nested transaction. */
export async function reserveImportCall(
  db: PoolClient,
  b: ImportCallBinding,
  reservation: { tokens: number; costMicros: number },
) {
  if (
    !Number.isSafeInteger(reservation.tokens) ||
    reservation.tokens < 1 ||
    !Number.isSafeInteger(reservation.costMicros) ||
    reservation.costMicros < 0
  )
    throw Error("INVALID_MODEL_RESERVATION");
  const id = importCallId(b);
  if (
    (
      await db.query(
        "SELECT 1 FROM import_model_calls WHERE workspace_id=$1 AND call_id=$2",
        [b.workspaceId, id],
      )
    ).rowCount
  )
    throw Error("MODEL_CALL_ALREADY_STARTED");
  const advanced = await db.query(
    "UPDATE import_runs SET calls=calls+1 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND attempt=$4 AND status='running' AND cancel_requested=false AND lease_until>clock_timestamp() AND calls<20 RETURNING calls",
    [b.workspaceId, b.runId, b.leaseToken, b.attempt],
  );
  if (!advanced.rowCount) throw Error("BUDGET_OR_LEASE_EXCEEDED");
  const day = new Date().toISOString().slice(0, 10);
  for (const principal of ["*", b.principalId]) {
    await db.query(
      "INSERT INTO durable_budget_days(workspace_id,principal_id,day) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [b.workspaceId, principal, day],
    );
    const used = (
        await db.query(
          "SELECT * FROM durable_budget_days WHERE workspace_id=$1 AND principal_id=$2 AND day=$3 FOR UPDATE",
          [b.workspaceId, principal, day],
        )
      ).rows[0],
      limit = (
        await db.query(
          "SELECT * FROM durable_budget_limits WHERE workspace_id=$1 AND principal_id=$2",
          [b.workspaceId, principal],
        )
      ).rows[0] ?? { tokens: 100000, cost_micros: 1000000 };
    if (
      Number(used.tokens_reserved) +
        Number(used.tokens_charged) +
        reservation.tokens >
        Number(limit.tokens) ||
      Number(used.cost_reserved) +
        Number(used.cost_charged) +
        reservation.costMicros >
        Number(limit.cost_micros)
    )
      throw Error("BUDGET_EXCEEDED");
    await db.query(
      "UPDATE durable_budget_days SET tokens_reserved=tokens_reserved+$4,cost_reserved=cost_reserved+$5 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
      [
        b.workspaceId,
        principal,
        day,
        reservation.tokens,
        reservation.costMicros,
      ],
    );
  }
  await db.query(
    "INSERT INTO import_model_calls(workspace_id,call_id,run_id,import_id,principal_id,attempt,lease_token,call_index,phase,input_revision,input_hash,private_input_hash,context_bytes,budget_day,reserved_tokens,reserved_cost_micros,request_id,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
    [
      b.workspaceId,
      id,
      b.runId,
      b.importId,
      b.principalId,
      b.attempt,
      b.leaseToken,
      advanced.rows[0].calls,
      b.meta.phase,
      b.inputRevision,
      b.meta.inputHash,
      b.privateInputHash,
      b.meta.contextBytes,
      day,
      reservation.tokens,
      reservation.costMicros,
      b.requestId ?? null,
      b.jobId ?? null,
    ],
  );
  return id;
}
export async function startImportCall(
  db: PoolClient,
  b: ImportCallBinding,
  provider: string,
  requestedModel: string,
) {
  const id = importCallId(b);
  const row = (
    await db.query(
      "SELECT * FROM import_model_calls WHERE workspace_id=$1 AND call_id=$2 FOR UPDATE",
      [b.workspaceId, id],
    )
  ).rows[0];
  if (!row || row.started_at) throw Error("MODEL_CALL_ALREADY_STARTED");
  for (const principal of ["*", b.principalId]) {
    const used = (
        await db.query(
          "SELECT * FROM durable_budget_days WHERE workspace_id=$1 AND principal_id=$2 AND day=$3 FOR UPDATE",
          [b.workspaceId, principal, row.budget_day],
        )
      ).rows[0],
      limit = (
        await db.query(
          "SELECT * FROM durable_budget_limits WHERE workspace_id=$1 AND principal_id=$2",
          [b.workspaceId, principal],
        )
      ).rows[0] ?? { tokens: 100000, cost_micros: 1000000 };
    if (
      Number(used.tokens_reserved) + Number(used.tokens_charged) >
        Number(limit.tokens) ||
      Number(used.cost_reserved) + Number(used.cost_charged) >
        Number(limit.cost_micros)
    )
      throw Error("BUDGET_EXCEEDED");
  }
  await db.query(
    "UPDATE import_model_calls SET started_at=clock_timestamp(),requested_provider=$3,requested_model=$4 WHERE workspace_id=$1 AND call_id=$2",
    [
      b.workspaceId,
      id,
      safeModelLabel(provider),
      safeModelLabel(requestedModel),
    ],
  );
}
/** Accounting-only late reports are accepted after cancellation/removal; they grant no processing rights. */
export async function recordImportUsage(
  pool: Pool,
  b: ImportCallBinding,
  usage: ModelUsage & { actualProvider?: string | null },
) {
  const u = {
      actualProvider: safeModelLabel(usage.actualProvider),
      actualModel: safeModelLabel(usage.model),
      inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens),
      costMicros: count(usage.costMicros),
      error:
        typeof usage.error === "string" && /^[A-Z_]{1,80}$/.test(usage.error)
          ? usage.error
          : null,
    },
    fingerprint = hash(u);
  return transaction(pool, b.workspaceId, async (db) => {
    const row = (
      await db.query(
        "SELECT * FROM import_model_calls WHERE workspace_id=$1 AND call_id=$2 FOR UPDATE",
        [b.workspaceId, importCallId(b)],
      )
    ).rows[0];
    if (!row) throw Error("MODEL_RESERVATION_MISSING");
    if (row.usage_hash) {
      if (row.usage_hash === fingerprint) return false;
      throw Error("TELEMETRY_CONFLICT");
    }
    const tokens =
        u.inputTokens !== null && u.outputTokens !== null
          ? u.inputTokens + u.outputTokens
          : null,
      cost = u.costMicros;
    for (const principal of ["*", b.principalId]) {
      await db.query(
        "SELECT 1 FROM durable_budget_days WHERE workspace_id=$1 AND principal_id=$2 AND day=$3 FOR UPDATE",
        [b.workspaceId, principal, row.budget_day],
      );
      await db.query(
        "UPDATE durable_budget_days SET tokens_reserved=tokens_reserved-$4,cost_reserved=cost_reserved-$5,tokens_charged=tokens_charged+$6,cost_charged=cost_charged+$7 WHERE workspace_id=$1 AND principal_id=$2 AND day=$3",
        [
          b.workspaceId,
          principal,
          row.budget_day,
          tokens === null ? 0 : row.reserved_tokens,
          cost === null ? 0 : row.reserved_cost_micros,
          tokens ?? 0,
          cost ?? 0,
        ],
      );
    }
    await db.query(
      "UPDATE import_model_calls SET actual_provider=$3,actual_model=$4,input_tokens=$5,output_tokens=$6,cost_micros=$7,provider_error_code=$8,state='reported',tokens_settled=$9,cost_settled=$10,usage_hash=$11,finished_at=clock_timestamp() WHERE workspace_id=$1 AND call_id=$2",
      [
        b.workspaceId,
        importCallId(b),
        u.actualProvider,
        u.actualModel,
        u.inputTokens,
        u.outputTokens,
        cost,
        u.error,
        tokens !== null,
        cost !== null,
        fingerprint,
      ],
    );
    return (
      (tokens !== null && tokens > Number(row.reserved_tokens)) ||
      (cost !== null && cost > Number(row.reserved_cost_micros))
    );
  });
}
export async function finishImportCall(
  pool: Pool,
  b: ImportCallBinding,
  error?: unknown,
) {
  const code =
    error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
      ? error.message
      : error
        ? "MODEL_FAILED"
        : null;
  await transaction(pool, b.workspaceId, (db) =>
    db.query(
      "UPDATE import_model_calls SET state=CASE WHEN usage_hash IS NULL THEN 'usage_unknown' ELSE state END,effect_error_code=coalesce($3,effect_error_code),provider_error_code=CASE WHEN usage_hash IS NULL THEN coalesce($3,provider_error_code,'MODEL_USAGE_NOT_REPORTED') ELSE provider_error_code END,finished_at=clock_timestamp() WHERE workspace_id=$1 AND call_id=$2",
      [b.workspaceId, importCallId(b), code],
    ),
  );
}
