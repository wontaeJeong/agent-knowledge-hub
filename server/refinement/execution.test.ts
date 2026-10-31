import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { approveLocalTransmissionFixture } from "../policy/test-fixture";
import { registerTrustedDestinations } from "../policy/model";
import { createServer, request } from "node:https";
import { testTlsCertificate } from "../test-tls-fixture";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import {
  createExecutionVerifier,
  createExecutionChallenge,
  executionConfigFromEnvironment,
  canonicalExecutionJson,
} from "./execution";
import { source, fixture, adoptFixture } from "../test-support";
import { digest } from "../publication";
import { RefinementService } from "./service";
import { authorizeInTransaction } from "../access/index";
import { claim } from "./fixtures";
import { fixtureSigningKey, signedFixtureReceipt } from "./execution-fixture";

let origin: string, cert: string, server: ReturnType<typeof createServer>;
let behavior = "valid",
  calls = 0,
  lastRequestAuthenticated = false;
let savedReceipt: ReturnType<typeof signedFixtureReceipt>;
let allowedWorkspace = "fixture",
  beforeReceipt: (() => Promise<void>) | undefined,
  receiptHookError: unknown;
let transport: typeof fetch;
const challenge = () =>
  createExecutionChallenge(
    {
      workspaceId: "fixture",
      evidenceId: "e1",
      executionId: "run-1",
      sourceId: source.id,
      sourceVersion: digest(source),
      location: { start: 0, end: source.content.length, quote: source.content },
    },
    "fixture-gateway",
  );
beforeAll(async () => {
  const tls = testTlsCertificate();
  cert = tls.cert;
  const key = tls.key;
  server = createServer({ cert, key }, async (req, res) => {
    calls++;
    let raw = "";
    for await (const c of req) raw += c;
    const input = JSON.parse(raw);
    const signature = createHmac(
      "sha256",
      Buffer.from(fixtureSigningKey, "base64"),
    )
      .update("akh-execution-request/v1\n" + canonicalExecutionJson(input))
      .digest("hex");
    lastRequestAuthenticated =
      req.headers["x-akh-execution-signature"] === signature;
    if (!lastRequestAuthenticated) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (behavior === "redirect") {
      res.writeHead(302, { location: "https://unapproved.invalid/" });
      res.end();
      return;
    }
    if (behavior === "timeout") {
      req.on("close", () => res.destroy());
      return;
    }
    if (behavior === "oversized") {
      res.end("x".repeat(70000));
      return;
    }
    if (input.executionId !== "run-1") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (input.workspaceId !== allowedWorkspace) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (
      input.sourceId !== source.id ||
      input.sourceVersion !== digest(source) ||
      input.location.start !== 0 ||
      input.location.end !== source.content.length ||
      input.location.quote !== source.content
    ) {
      res.writeHead(422);
      res.end();
      return;
    }
    if (behavior === "replay") {
      res.end(JSON.stringify(savedReceipt));
      return;
    }
    try {
      await beforeReceipt?.();
    } catch (error) {
      receiptHookError = error;
      res.writeHead(503);
      res.end();
      return;
    }
    const changes =
      behavior === "wrong-source"
        ? { sourceVersion: "0".repeat(64) }
        : behavior === "failed"
          ? { outcome: "failure" }
          : behavior === "stale"
            ? {
                issuedAt: new Date(Date.now() - 600000).toISOString(),
                expiresAt: new Date(Date.now() - 300000).toISOString(),
              }
            : behavior === "wrong-nonce"
              ? { nonce: "wrong-nonce" }
              : behavior === "historical"
                ? { executedAt: "2026-01-01T00:00:00Z" }
                : behavior === "wrong-location"
                  ? { location: { start: 0, end: 4, quote: "fake" } }
                  : behavior === "wrong-fingerprint"
                    ? { requestFingerprint: "0".repeat(64) }
                    : behavior === "wrong-workspace"
                      ? { workspaceId: "other-workspace" }
                      : behavior === "wrong-execution"
                        ? { executionId: "other-run" }
                        : {};
    const result = signedFixtureReceipt(input, changes);
    savedReceipt = result;
    if (behavior === "forged") result.signature = "0".repeat(64);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture");
  origin = `https://127.0.0.1:${address.port}`;
  transport = ((url: URL | RequestInfo, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(
        String(url),
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          ca: cert,
        },
        (res) => {
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status: res.statusCode,
              headers: { "content-type": "application/json" },
            }),
          );
          res.on("close", () =>
            init?.signal?.removeEventListener("abort", abort),
          );
        },
      );
      const abort = () => req.destroy(Error("aborted"));
      init?.signal?.addEventListener("abort", abort, { once: true });
      req.on("error", reject);
      req.end(init?.body);
    })) as typeof fetch;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const verifier = (timeoutMs = 1000) =>
  createExecutionVerifier(
    {
      url: origin + "/v1/executions/verify",
      approvedOrigin: origin,
      provider: "fixture-gateway",
      hmacKeyBase64: fixtureSigningKey,
      allowTransmission: true,
      timeoutMs,
    },
    transport,
  )!;
it("actual approved HTTPS gateway binds authenticated execution receipt to exact source/quote and nonce", async () => {
  behavior = "valid";
  const input = challenge(),
    v = verifier(),
    proof = await v.verify(input);
  v.assertProof(proof, input);
  expect(proof.receipt.executorId).toBe("trusted-fixture-runner");
  expect(proof.receipt.executedAt).toBeTruthy();
  expect(proof.receipt.outcome).toBe("success");
  expect(proof.request.nonce).toBe(input.nonce);
  expect(lastRequestAuthenticated).toBe(true);
});
it.each([
  "wrong-source",
  "wrong-location",
  "wrong-fingerprint",
  "wrong-workspace",
  "wrong-execution",
  "wrong-nonce",
  "forged",
  "stale",
  "failed",
  "redirect",
  "oversized",
  "timeout",
])("fails closed for gateway %s", async (mode) => {
  behavior = mode;
  await expect(
    verifier(mode === "timeout" ? 50 : 1000).verify(challenge()),
  ).rejects.toThrow();
});
it("unknown execution IDs cannot be signed from uploaded/collected text", async () => {
  behavior = "valid";
  await expect(
    verifier().verify(
      createExecutionChallenge(
        { ...challenge(), executionId: "fake-id" },
        "fixture-gateway",
      ),
    ),
  ).rejects.toThrow();
});
it("rejects a captured signed receipt for a fresh nonce and arbitrary uploaded source hashes", async () => {
  behavior = "valid";
  const v = verifier();
  await v.verify(challenge());
  behavior = "replay";
  await expect(v.verify(challenge())).rejects.toThrow(
    "EXECUTION_ATTESTATION_INVALID",
  );
  behavior = "valid";
  await expect(
    v.verify(
      createExecutionChallenge(
        { ...challenge(), sourceVersion: "1".repeat(64) },
        "fixture-gateway",
      ),
    ),
  ).rejects.toThrow("EXECUTION_VERIFIER_UNAVAILABLE");
});
it("dispatches a challenge nonce only once and never performs HTTP on a nonce replay", async () => {
  behavior = "valid";
  const v = verifier(),
    q = challenge();
  await v.verify(q);
  const before = calls;
  await expect(v.verify(q)).rejects.toThrow("EXECUTION_NONCE_REPLAY");
  expect(calls).toBe(before);
});
it("preserves historical actual execution time independently from fresh receipt/verification time", async () => {
  behavior = "historical";
  const proof = await verifier().verify(challenge());
  expect(proof.receipt.executedAt).toBe("2026-01-01T00:00:00Z");
  expect(proof.receipt.issuedAt).not.toBe(proof.receipt.executedAt);
});
it("configuration requires HTTPS exact approved origin, explicit transmission and a server-only strong key", () => {
  expect(createExecutionVerifier({ allowTransmission: false })).toBeUndefined();
  const base = {
    url: origin + "/v1/executions/verify",
    approvedOrigin: origin,
    provider: "fixture-gateway",
    hmacKeyBase64: fixtureSigningKey,
    allowTransmission: true,
  };
  for (const input of [
    { ...base, url: "http://127.0.0.1/v1" },
    { ...base, approvedOrigin: "https://other.invalid" },
    { ...base, url: base.url + "?key=body" },
    { ...base, hmacKeyBase64: "weak" },
    { ...base, provider: undefined },
  ])
    expect(() => createExecutionVerifier(input)).toThrow(
      "EXECUTION_VERIFIER_CONFIGURATION",
    );
  expect(executionConfigFromEnvironment({}).allowTransmission).toBe(false);
});
it("actual PostgreSQL + authenticated HTTPS receipt + distinct human reviewer complete the positive proof path", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    allowedWorkspace = f.workspaceId;
    behavior = "valid";
    vi.stubEnv(
      "AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_DESTINATION_ID",
      "explicit-local-fixture",
    );
    const authorization = await approveLocalTransmissionFixture(
      f.pool,
      f.workspaceId,
      origin + "/v1/executions/verify",
      ["execution-verification"],
    );
    const service = new RefinementService(
      f.pool,
      authorizeInTransaction,
      undefined,
      { executionVerifier: verifier(5000) },
    );
    const e = await service.addEvidence(
      { ...f.editor, authorization },
      {
        id: "https-evidence",
        kind: "independent-execution",
        executionId: "run-1",
        sourceId: source.id,
        sourceVersion: digest(source),
        location: {
          start: 0,
          end: source.content.length,
          quote: source.content,
        },
        parentIds: [],
        assertedAt: new Date().toISOString(),
        verifiedAt: null,
        conditions: { os: "linux" },
      },
    );
    expect(e.verifiedAt).toBeNull();
    expect(e.executionVerification?.status).toBe("attested");
    const { recordedAt: _, recordedBy: __, ...candidate } = claim;
    await service.addClaim(f.editor, { ...candidate, evidenceIds: [e.id] });
    await service.reviewClaim(f.ctx, {
      id: "https-human-review",
      claimIds: [claim.id],
      status: "execution-verified",
      evidenceIds: [e.id],
      reason: "실제 HTTPS fixture 영수증과 원본/시점 독립 검토",
    });
    const result = await service.context(f.reader, {
      asOf: "2026-03-01T00:00:00Z",
      environment: {},
    });
    expect(result.items[0].validation).toBe("execution-verified");
    expect(
      result.items[0].verificationReviews[0].executionReceipts?.[0].executorId,
    ).toBe("trusted-fixture-runner");
  } finally {
    allowedWorkspace = "fixture";
    vi.unstubAllEnvs();
    await f.pool.end();
  }
});
it("actual HTTPS execution verifier receives zero protected requests without per-source transmission approval", async () => {
  const f = await fixture();
  const before = calls;
  try {
    await adoptFixture(f.pool, f.workspaceId);
    await registerTrustedDestinations(f.pool, [
      {
        id: "denied-execution-fixture",
        url: origin + "/v1/executions/verify",
        purposes: ["execution-verification"],
        classifications: ["synthetic"],
        active: true,
      },
    ]);
    vi.stubEnv(
      "AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_DESTINATION_ID",
      "denied-execution-fixture",
    );
    const service = new RefinementService(
      f.pool,
      authorizeInTransaction,
      undefined,
      { executionVerifier: verifier(5000) },
    );
    await expect(
      service.addEvidence(
        {
          ...f.editor,
          authorization: {
            revalidate: async () => {},
            assertSession: async () => {},
          },
        },
        {
          id: "denied-execution",
          kind: "independent-execution",
          executionId: "run-1",
          sourceId: source.id,
          sourceVersion: digest(source),
          location: {
            start: 0,
            end: source.content.length,
            quote: source.content,
          },
          parentIds: [],
          assertedAt: new Date().toISOString(),
          verifiedAt: null,
          conditions: {},
        },
      ),
    ).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
    expect(calls).toBe(before);
  } finally {
    vi.unstubAllEnvs();
    await f.pool.end();
  }
});
it("actual HTTPS in-flight ACL revocation acquires the workspace lock and prevents evidence persistence", async () => {
  const f = await fixture();
  try {
    await adoptFixture(f.pool, f.workspaceId);
    allowedWorkspace = f.workspaceId;
    behavior = "valid";
    vi.stubEnv(
      "AGENT_KNOWLEDGE_HUB_EXECUTION_VERIFIER_DESTINATION_ID",
      "explicit-local-fixture",
    );
    const authorization = await approveLocalTransmissionFixture(
      f.pool,
      f.workspaceId,
      origin + "/v1/executions/verify",
      ["execution-verification"],
    );
    receiptHookError = undefined;
    beforeReceipt = async () => {
      const db = await f.pool.connect();
      try {
        await db.query("BEGIN");
        await db.query(
          "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE NOWAIT",
          [f.workspaceId],
        );
        await db.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='editor'",
          [f.workspaceId, source.id],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    };
    const service = new RefinementService(
      f.pool,
      authorizeInTransaction,
      undefined,
      { executionVerifier: verifier(5000) },
    );
    const input = {
      id: "revoked-https-proof",
      kind: "independent-execution",
      executionId: "run-1",
      sourceId: source.id,
      sourceVersion: digest(source),
      location: { start: 0, end: source.content.length, quote: source.content },
      parentIds: [],
      assertedAt: new Date().toISOString(),
      verifiedAt: null,
      conditions: {},
    };
    await expect(
      service.addEvidence({ ...f.editor, authorization }, input),
    ).rejects.toThrow("NOT_FOUND");
    expect(receiptHookError).toBeUndefined();
    expect(
      (
        await f.pool.query(
          "SELECT id FROM refinement_evidence WHERE workspace_id=$1",
          [f.workspaceId],
        )
      ).rowCount,
    ).toBe(0);
    const before = calls;
    await expect(service.addEvidence(f.editor, input)).rejects.toThrow(
      "NOT_FOUND",
    );
    expect(calls).toBe(before);
  } finally {
    beforeReceipt = undefined;
    vi.unstubAllEnvs();
    allowedWorkspace = "fixture";
    await f.pool.end();
  }
});
