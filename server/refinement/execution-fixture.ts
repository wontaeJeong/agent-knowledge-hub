// Explicit TRUSTED test gateway fixture, never imported by production modules.
import { createHmac } from "node:crypto";
import { source } from "../test-support";
import { digest } from "../publication";
import {
  canonicalExecutionJson,
  createExecutionVerifier,
  type ExecutionChallenge,
} from "./execution";
export const fixtureSigningKey = Buffer.from(
  "fixture-only-gateway-signing-key-32-bytes",
).toString("base64");
export const fixtureExecutedAt = new Date(Date.now() - 1000).toISOString();
export function signedFixtureReceipt(
  input: ExecutionChallenge,
  changes: Record<string, unknown> = {},
) {
  const receipt = {
    schemaVersion: 1,
    provider: input.provider,
    receiptId: `receipt-${input.nonce}`,
    nonce: input.nonce,
    evidenceId: input.evidenceId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    location: input.location,
    requestFingerprint: input.fingerprint,
    outcome: "success",
    executorId: "trusted-fixture-runner",
    executedAt: fixtureExecutedAt,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    ...changes,
  };
  return {
    receipt,
    signature: createHmac("sha256", Buffer.from(fixtureSigningKey, "base64"))
      .update("akh-execution-receipt/v1\n" + canonicalExecutionJson(receipt))
      .digest("hex"),
  };
}
export function trustedFixtureVerifier(
  beforeResponse?: (input: ExecutionChallenge) => Promise<void>,
  changes: Record<string, unknown> = {},
) {
  return createExecutionVerifier(
    {
      url: "https://trusted-fixture.invalid/v1/executions/verify",
      approvedOrigin: "https://trusted-fixture.invalid",
      provider: "fixture-gateway",
      hmacKeyBase64: fixtureSigningKey,
      allowTransmission: true,
    },
    async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as ExecutionChallenge;
      // Known independently prepared fixture record, not an uploader-controlled echo-sign service.
      if (
        input.executionId !== "run-1" ||
        input.sourceId !== source.id ||
        input.sourceVersion !== digest(source) ||
        input.location.start !== 0 ||
        input.location.end !== source.content.length ||
        input.location.quote !== source.content
      )
        return new Response("not an approved execution fixture", {
          status: 404,
        });
      await beforeResponse?.(input);
      return new Response(
        JSON.stringify(signedFixtureReceipt(input, changes)),
        { headers: { "content-type": "application/json" } },
      );
    },
  )!;
}
