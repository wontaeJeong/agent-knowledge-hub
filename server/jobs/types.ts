import type { PoolClient } from "pg";
import type { Context } from "../service";
import type { InputEnvelope } from "../provenance";

export type Resource = { kind: "page" | "source"; id: string };
export type Authorizer = (
  db: PoolClient,
  ctx: Context,
  action: string,
  resource?: Resource,
) => Promise<void>;
/** Persist identifiers only. Accept either an actual scoped service credential
 * or an explicit server-minted, one-operation, expiring same-human consent grant.
 * Reject ambient OIDC sessions/refresh tokens and bare human PATs as durable
 * identities; a PAT may consent to its own bounded grant without widening scope.
 * Recheck expiry, revocation, current actor and scope on every resolution. */
export type ExecutionIdentity = Readonly<{
  workspaceId: string;
  principalId: string;
  credentialId: string;
}>;
export interface JobHooks {
  /** Server-only integration declaration: inputs are read context, while the
   * attached runtime enforces protection/current scope on ACTUAL output targets
   * inside its write transaction. Generic queues remain strict by default. */
  inputsAreReadOnly?: boolean;
  /** Network/directory/session refresh OUTSIDE all queue/domain transactions. */
  revalidateIdentity?: (identity: ExecutionIdentity) => Promise<void>;
  authorize: Authorizer;
  resolveIdentity: (
    db: PoolClient,
    identity: ExecutionIdentity,
  ) => Promise<Context>;
  /** Include current feature flags, review/protection rules and model allowlist. */
  policyFingerprint: (db: PoolClient, ctx: Context) => Promise<string>;
  /** Check input ancestry, approved scope, protected pages and payload operation.
   * Never grant approve/publish, tools, network or code execution rights. */
  validateScope: (
    db: PoolClient,
    ctx: Context,
    input: JobInput,
    purpose?: "execute" | "schedule" | "read",
  ) => Promise<void>;
  /** Production bridges must reject human/one-operation grants for schedules. */
  validateScheduleIdentity?: (
    db: PoolClient,
    identity: ExecutionIdentity,
  ) => Promise<Context>;
}
export interface JobInput {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  pageIds: string[];
  sourceIds: string[];
  reservation: { tokens: number; costMicros: number };
  timeoutMs: number;
  maxAttempts: number;
  limits?: { documents: number; changes: number };
  ruleId?: string;
  model?: string;
}
export interface Lease {
  id: string;
  workspaceId: string;
  principalId: string;
  credentialId: string;
  workerId: string;
  fence: number;
  attempt: number;
  input: JobInput;
  envelope: InputEnvelope;
  policyHash: string;
  checkpoint: unknown;
}
export interface Completion {
  value: unknown;
  /** Trusted executor evidence that no model/gateway was invoked on any stage.
   * Not accepted in JobInput or HTTP DTOs. */
  noModelCalls?: boolean;
  /** Short DB-only effect in the SAME fenced transaction. No model/network calls.
   * Publication must use the host's reviewed idempotent publication contract;
   * agent executors only create human-review proposals, never approve/publish. */
  commit?: (db: PoolClient, ctx: Context, key: string) => Promise<void>;
}
export interface ModelTelemetry {
  callId: string;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  error: string | null;
}
export interface ModelReservation {
  callId: string;
  provider: string;
  model: string;
  maxTokens: number;
  maxCostMicros: number;
}
export interface JobRun {
  lease: Lease;
  ctx: Context;
  signal: AbortSignal;
  /** Revalidate immediately before an external model call; never hold DB locks during it. */
  ready: () => Promise<void>;
  checkpoint: (value: unknown) => Promise<void>;
  recordModel: (usage: ModelTelemetry) => Promise<void>;
  /** Mandatory before transmitting model input; prevents another call while a
   * prior attempt's actual usage is unknown. */
  beginModel: (reservation: ModelReservation) => Promise<void>;
}
export type JobHandler = (run: JobRun) => Promise<Completion>;
export interface ScheduleSpec {
  cadence: "daily" | "weekly";
  time: string;
  timezone: string;
  weekday?: number;
  holidays: string[];
}
export interface ScheduleInput extends ScheduleSpec {
  key: string;
  expectedRevision?: number;
  catchup: "skip" | "latest" | "bounded";
  catchupLimit?: number;
  job: Omit<JobInput, "key">;
  identity: ExecutionIdentity;
  approvedPageIds: string[];
  approvedSourceIds: string[];
  enabled?: boolean;
}
