import type { Pool } from "pg";
import { authorizeInTransaction } from "../access";
import {
  CollaborationService,
  CollaborationWorker,
  resolveGovernanceResponsibility,
  createDigestGateway,
} from "../collaboration";
import type { RuntimeIdentityOptions } from "../jobs/identity";
import type { DigestGateway } from "../collaboration";
import {
  createRecipientBinding,
  type RecipientBinding,
} from "./collaboration-recipient";
import { z } from "zod";

/** The process dispatcher and directory are explicitly configured; neither grants the recipient rights. */
export function createCollaborationHost(
  pool: Pool,
  origin: string,
  options: RuntimeIdentityOptions & {
    dispatcherId?: string;
    recipientBinding?: RecipientBinding;
    gateway?: DigestGateway;
  },
) {
  const service = new CollaborationService(
    pool,
    {
      authorize: authorizeInTransaction,
      assertDispatcher: async (db) => {
        if (!options.dispatcherId)
          throw Error("COLLABORATION_DISPATCHER_NOT_CONFIGURED");
        const result = await db.query(
          "SELECT 1 FROM access_principals WHERE id=$1 AND kind='service' AND active FOR SHARE",
          [options.dispatcherId],
        );
        if (!result.rowCount)
          throw Error("COLLABORATION_DISPATCHER_NOT_CONFIGURED");
      },
      verifyRecipient: async ({ workspaceId, principalId }, { signal }) => {
        if (!options.directoryStatus || !options.directoryProviderId)
          throw Error("RECIPIENT_STATUS_UNKNOWN");
        const result = await pool.query(
          "SELECT issuer,subject FROM access_principals WHERE id=$1 AND kind='human' AND active",
          [principalId],
        );
        const person = result.rows[0];
        if (!person?.issuer || !person.subject)
          throw Error("RECIPIENT_STATUS_UNKNOWN");
        const proof = await options.directoryStatus(
          { principalId, issuer: person.issuer, subject: person.subject },
          { signal },
        );
        if (
          proof.active !== true ||
          proof.principalId !== principalId ||
          proof.issuer !== person.issuer ||
          proof.subject !== person.subject
        )
          throw Error("RECIPIENT_STATUS_UNKNOWN");
        const checkedAt = Date.parse(proof.verifiedAt),
          expiresAt = Date.parse(proof.validUntil),
          now = Date.now();
        if (
          !Number.isFinite(checkedAt) ||
          !Number.isFinite(expiresAt) ||
          checkedAt > now + 5000 ||
          checkedAt < now - 30000 ||
          expiresAt <= now ||
          expiresAt - checkedAt > 30000
        )
          throw Error("RECIPIENT_STATUS_UNKNOWN");
        const binding = options.recipientBinding
          ? await options.recipientBinding(
              {
                workspaceId,
                principalId,
                identityIssuer: person.issuer,
                subject: person.subject,
              },
              { signal },
            )
          : null;
        const verifiedAt =
          binding &&
          Date.parse(binding.verifiedAt) < Date.parse(proof.verifiedAt)
            ? binding.verifiedAt
            : proof.verifiedAt;
        const validUntil =
          binding &&
          Date.parse(binding.validUntil) < Date.parse(proof.validUntil)
            ? binding.validUntil
            : proof.validUntil;
        return {
          ctx: { workspaceId, principalId },
          address: binding?.address ?? null,
          issuer: person.issuer,
          subject: person.subject,
          verifiedAt,
          validUntil,
          assertCurrent: async (db) => {
            const current = await db.query(
              "SELECT 1 FROM access_principals WHERE id=$1 AND kind='human' AND active AND issuer=$2 AND subject=$3 FOR SHARE",
              [principalId, person.issuer, person.subject],
            );
            if (!current.rowCount) throw Error("RECIPIENT_DISABLED");
          },
        };
      },
      resolveReviewResponsibility: resolveGovernanceResponsibility,
    },
    { applicationOrigin: origin, gateway: options.gateway },
  );
  return {
    service,
    worker: new CollaborationWorker(service, {
      onError: (error) =>
        console.error(
          "COLLABORATION_WORKER_FAILED",
          error instanceof Error ? error.message : "UNKNOWN",
        ),
    }),
  };
}
export { createRecipientBinding } from "./collaboration-recipient";

/** All endpoints, credentials and the signing key are process configuration; partial configuration is rejected. */
export function collaborationDeliveryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { recipientBinding?: RecipientBinding; gateway?: DigestGateway } {
  const names = [
    "AKH_COLLABORATION_RECIPIENT_URL",
    "AKH_COLLABORATION_RECIPIENT_ALLOWED_ORIGINS",
    "AKH_COLLABORATION_RECIPIENT_ISSUER",
    "AKH_COLLABORATION_RECIPIENT_PUBLIC_KEY",
    "AKH_COLLABORATION_RECIPIENT_TOKEN",
    "AKH_COLLABORATION_GATEWAY_URL",
    "AKH_COLLABORATION_GATEWAY_ALLOWED_ORIGINS",
    "AKH_COLLABORATION_GATEWAY_TOKEN",
  ] as const;
  if (!names.some((name) => env[name])) return {};
  try {
    if (names.some((name) => !env[name])) throw Error();
    const origins = (raw: string) =>
      z.array(z.string().url()).min(1).max(20).parse(JSON.parse(raw));
    return {
      recipientBinding: createRecipientBinding({
        url: env[names[0]]!,
        allowedOrigins: origins(env[names[1]]!),
        issuer: env[names[2]]!,
        publicKey: env[names[3]]!,
        token: env[names[4]]!,
      }),
      gateway: createDigestGateway({
        url: env[names[5]]!,
        allowedOrigins: origins(env[names[6]]!),
        token: env[names[7]]!,
      }),
    };
  } catch {
    throw Error("COLLABORATION_DELIVERY_CONFIGURATION");
  }
}
