import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { id } from "./logic";
import { assertSafeModelInput } from "./semantic";

/** Host may merge these literal public codes into its sanitized error mapper. No provider text. */
export const executionErrorStatuses: Readonly<Record<string, number>> =
  Object.freeze({
    EXECUTION_VERIFIER_UNCONFIGURED: 503,
    EXECUTION_VERIFIER_CONFIGURATION: 503,
    EXECUTION_VERIFIER_UNAVAILABLE: 502,
    EXECUTION_VERIFIER_OUTPUT_LIMIT: 502,
    EXECUTION_ATTESTATION_INVALID: 409,
    EXECUTION_SIGNATURE_INVALID: 409,
    EXECUTION_ATTESTATION_STALE: 409,
    EXECUTION_FAILED: 409,
    EXECUTION_RECEIPT_REPLAY: 409,
    EXECUTION_NONCE_REPLAY: 409,
    EXECUTION_VERIFIER_BUSY: 429,
    TRUSTED_EXECUTION_REQUIRED: 409,
    EXECUTION_SOURCE_CHANGED: 409,
    EXECUTION_CLAIM_MISMATCH: 409,
  });

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.iso.datetime();
const location = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(20000),
  })
  .strict();
const bindingSchema = z
  .object({
    workspaceId: id,
    evidenceId: id,
    executionId: id,
    sourceId: id,
    sourceVersion: hash,
    location,
  })
  .strict();
export type ExecutionBinding = z.infer<typeof bindingSchema>;
const challengeSchema = bindingSchema
  .extend({
    schemaVersion: z.literal(1),
    provider: id,
    nonce: z.uuid(),
    requestedAt: time,
    expiresAt: time,
    fingerprint: hash,
  })
  .strict();
export type ExecutionChallenge = z.infer<typeof challengeSchema>;
const receiptSchema = bindingSchema
  .extend({
    schemaVersion: z.literal(1),
    provider: id,
    receiptId: id,
    nonce: z.uuid(),
    requestFingerprint: hash,
    outcome: z.enum(["success", "failure"]),
    executorId: id,
    executedAt: time,
    issuedAt: time,
    expiresAt: time,
  })
  .strict();
const proofSchema = z
  .object({
    status: z.literal("attested"),
    provider: id,
    request: challengeSchema,
    receipt: receiptSchema,
    signature: hash,
  })
  .strict();
export type ExecutionProof = z.infer<typeof proofSchema>;
export type ExecutionVerification =
  ExecutionProof | { status: "unverified"; reason: string };
export interface ExecutionVerifier {
  readonly provider: string;
  readonly destinationUrl?: string;
  verify(
    input: ExecutionChallenge,
    options?: { beforeTransmission?: (endpoint: string) => Promise<void> },
  ): Promise<ExecutionProof>;
  /** Local cryptographic/time/binding validation only; MUST NOT perform network I/O. */
  assertProof(proof: unknown, binding: ExecutionBinding): ExecutionProof;
}
export function canonicalExecutionJson(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : v;
  return JSON.stringify(canonical(value));
}
export const executionFingerprint = (value: unknown) =>
  createHash("sha256").update(canonicalExecutionJson(value)).digest("hex");
export function createExecutionChallenge(
  binding: ExecutionBinding,
  provider: string,
): ExecutionChallenge {
  const b = bindingSchema.parse({
    workspaceId: binding.workspaceId,
    evidenceId: binding.evidenceId,
    executionId: binding.executionId,
    sourceId: binding.sourceId,
    sourceVersion: binding.sourceVersion,
    location: binding.location,
  });
  const now = Date.now();
  const content = {
    ...b,
    schemaVersion: 1 as const,
    provider: id.parse(provider),
    nonce: randomUUID(),
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  return { ...content, fingerprint: executionFingerprint(content) };
}
export interface ExecutionVerifierConfig {
  url?: string;
  approvedOrigin?: string;
  provider?: string;
  hmacKeyBase64?: string;
  allowTransmission: boolean;
  timeoutMs?: number;
}
export function executionConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionVerifierConfig {
  return {
    url: env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_URL,
    approvedOrigin: env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_APPROVED_ORIGIN,
    provider: env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_PROVIDER,
    hmacKeyBase64: env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_HMAC_KEY_BASE64,
    allowTransmission:
      env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_ALLOW_TRANSMISSION === "true",
    ...(env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_TIMEOUT_MS
      ? {
          timeoutMs: Number(
            env.AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_TIMEOUT_MS,
          ),
        }
      : {}),
  };
}
/** Approved gateway must attest its OWN immutable executor records, never sign uploader text. */
export function createExecutionVerifier(
  config: ExecutionVerifierConfig,
  transport: typeof fetch = fetch,
): ExecutionVerifier | undefined {
  if (!config.allowTransmission) return undefined;
  let endpoint: URL, key: Buffer, provider: string;
  const timeout = config.timeoutMs ?? 5000;
  try {
    endpoint = new URL(config.url!);
    const approved = new URL(config.approvedOrigin!);
    provider = id.parse(config.provider);
    if (
      endpoint.protocol !== "https:" ||
      approved.protocol !== "https:" ||
      approved.href !== approved.origin + "/" ||
      endpoint.origin !== approved.origin ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^\/[a-zA-Z0-9/_-]+$/.test(endpoint.pathname) ||
      !Number.isInteger(timeout) ||
      timeout < 25 ||
      timeout > 15000
    )
      throw Error("config");
    const encoded = config.hmacKeyBase64 ?? "";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error("key");
    key = Buffer.from(encoded, "base64");
    if (
      key.length < 32 ||
      key.length > 128 ||
      key.toString("base64") !== encoded
    )
      throw Error("key");
  } catch {
    throw Error("EXECUTION_VERIFIER_CONFIGURATION");
  }
  const mac = (domain: string, value: unknown) =>
    createHmac("sha256", key)
      .update(domain + "\n" + canonicalExecutionJson(value))
      .digest("hex");
  const dispatched = new Map<string, number>();
  const assertProof = (
    value: unknown,
    binding: ExecutionBinding,
  ): ExecutionProof => {
    let proof: ExecutionProof;
    try {
      proof = proofSchema.parse(value);
    } catch {
      throw Error("EXECUTION_ATTESTATION_INVALID");
    }
    const r = proof.receipt,
      q = proof.request;
    const { fingerprint, ...unsigned } = q;
    const expectedBinding = bindingSchema.parse({
      workspaceId: binding.workspaceId,
      evidenceId: binding.evidenceId,
      executionId: binding.executionId,
      sourceId: binding.sourceId,
      sourceVersion: binding.sourceVersion,
      location: binding.location,
    });
    const receivedBinding = {
      workspaceId: r.workspaceId,
      evidenceId: r.evidenceId,
      executionId: r.executionId,
      sourceId: r.sourceId,
      sourceVersion: r.sourceVersion,
      location: r.location,
    };
    const requestBinding = {
      workspaceId: q.workspaceId,
      evidenceId: q.evidenceId,
      executionId: q.executionId,
      sourceId: q.sourceId,
      sourceVersion: q.sourceVersion,
      location: q.location,
    };
    if (
      proof.provider !== provider ||
      r.provider !== provider ||
      q.provider !== provider ||
      r.nonce !== q.nonce ||
      r.requestFingerprint !== fingerprint ||
      fingerprint !== executionFingerprint(unsigned) ||
      executionFingerprint(receivedBinding) !==
        executionFingerprint(expectedBinding) ||
      executionFingerprint(requestBinding) !==
        executionFingerprint(expectedBinding)
    )
      throw Error("EXECUTION_ATTESTATION_INVALID");
    if (
      !timingSafeEqual(
        Buffer.from(proof.signature, "hex"),
        Buffer.from(mac("akh-execution-receipt/v1", r), "hex"),
      )
    )
      throw Error("EXECUTION_SIGNATURE_INVALID");
    const now = Date.now(),
      issued = Date.parse(r.issuedAt),
      expires = Date.parse(r.expiresAt),
      executed = Date.parse(r.executedAt),
      requested = Date.parse(q.requestedAt),
      deadline = Date.parse(q.expiresAt);
    if (
      ![now, issued, expires, executed, requested, deadline].every(
        Number.isFinite,
      ) ||
      issued > now + 30000 ||
      issued < now - 300000 ||
      expires <= now ||
      expires <= issued ||
      expires > issued + 300000 ||
      executed > issued ||
      executed > now + 30000 ||
      executed < 0 ||
      requested > issued + 30000 ||
      issued > deadline ||
      deadline <= requested ||
      deadline > requested + 60001
    )
      throw Error("EXECUTION_ATTESTATION_STALE");
    if (r.outcome !== "success") throw Error("EXECUTION_FAILED");
    if (
      r.location.end <= r.location.start ||
      r.location.end - r.location.start !== r.location.quote.length
    )
      throw Error("EXECUTION_ATTESTATION_INVALID");
    return proof;
  };
  return {
    provider,
    destinationUrl: endpoint.href,
    assertProof,
    verify: async (input, options) => {
      const q = challengeSchema.parse(input);
      const { fingerprint, ...unsigned } = q;
      const now = Date.now(),
        requested = Date.parse(q.requestedAt),
        deadline = Date.parse(q.expiresAt);
      if (
        q.provider !== provider ||
        fingerprint !== executionFingerprint(unsigned) ||
        ![requested, deadline].every(Number.isFinite) ||
        requested > now + 30000 ||
        requested < now - 60000 ||
        deadline <= now ||
        deadline <= requested ||
        deadline > requested + 60000
      )
        throw Error("EXECUTION_ATTESTATION_INVALID");
      for (const [nonce, expires] of dispatched)
        if (expires <= Date.now()) dispatched.delete(nonce);
      if (dispatched.has(q.nonce)) throw Error("EXECUTION_NONCE_REPLAY");
      if (dispatched.size >= 10000) throw Error("EXECUTION_VERIFIER_BUSY");
      dispatched.set(q.nonce, Date.parse(q.expiresAt));
      assertSafeModelInput(q);
      await options?.beforeTransmission?.(endpoint.href);
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeout),
          headers: {
            "content-type": "application/json",
            "X-AKH-Execution-Signature": mac("akh-execution-request/v1", q),
          },
          body: canonicalExecutionJson(q),
        });
      } catch {
        throw Error("EXECUTION_VERIFIER_UNAVAILABLE");
      }
      if (!response.ok) throw Error("EXECUTION_VERIFIER_UNAVAILABLE");
      const reader = response.body?.getReader();
      if (!reader) throw Error("EXECUTION_ATTESTATION_INVALID");
      let raw = "",
        bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const c = await reader.read();
          if (c.done) break;
          bytes += c.value.byteLength;
          if (bytes > 64000) {
            await reader.cancel();
            throw Error("EXECUTION_VERIFIER_OUTPUT_LIMIT");
          }
          raw += decoder.decode(c.value, { stream: true });
        }
        raw += decoder.decode();
      } catch (e) {
        if (
          e instanceof Error &&
          e.message === "EXECUTION_VERIFIER_OUTPUT_LIMIT"
        )
          throw e;
        throw Error("EXECUTION_VERIFIER_UNAVAILABLE");
      }
      let result: { receipt: unknown; signature: string };
      try {
        result = z
          .object({ receipt: receiptSchema, signature: hash })
          .strict()
          .parse(JSON.parse(raw));
      } catch {
        throw Error("EXECUTION_ATTESTATION_INVALID");
      }
      return assertProof(
        { status: "attested", provider, request: q, ...result },
        bindingSchema.parse({
          workspaceId: q.workspaceId,
          evidenceId: q.evidenceId,
          executionId: q.executionId,
          sourceId: q.sourceId,
          sourceVersion: q.sourceVersion,
          location: q.location,
        }),
      );
    },
  };
}
