import type { Pool } from "pg";
import type { OidcIdentityOptions } from "../runtime/auth";
import { assertResourceUpperBound } from "../access/index";
import {
  canonicalGroupAdmin,
  assertFreshDirectoryHuman,
  syncDirectoryMemberships,
  type DirectoryAuthority,
  type GroupProof,
} from "./directory";
import { EmergencyAccess } from "./emergency";
import {
  IdentityOperations,
  identityTransaction,
  sessionPolicyFromEnvironment,
  type GlobalLogoutAdapter,
  type SessionPolicy,
} from "./sessions";
import type { DirectoryBindingOption, IdentityHttpServices } from "./http";

/** Unattended paths use an independently verified authority, not a copied
 * browser access token or a caller's group claim. Call before a service/sponsor
 * rights revalidation, outside that effect's transaction. */
export async function refreshVerifiedDirectoryMemberships(
  pool: Pool,
  subject: string,
  authority: DirectoryAuthority,
): Promise<GroupProof> {
  const proof = await authority.verify(subject);
  await identityTransaction(pool, (db) => syncDirectoryMemberships(db, proof));
  return proof;
}
export interface IdentityRuntimeOptions {
  sessionPolicy?: SessionPolicy;
  platformEmergencyApproverIds?: readonly string[];
  globalLogout?: GlobalLogoutAdapter;
  directoryAuthority?: DirectoryAuthority;
  directoryBindings?: readonly DirectoryBindingOption[];
  directoryGroupClaim?: string;
  directoryFreshnessSeconds?: number;
  allowLoopbackHttp?: boolean;
}
/** Pure server construction: pass authOptions into OidcAuth.create(pool,...),
 * and mount httpServices in the coordinator's normal authenticated dispatcher.
 * Emergency authority is attached to native browser guards, never global state,
 * platform Owner inference, effectiveAccess capabilities or agent credentials. */
export function createIdentityRuntime(
  pool: Pool,
  options: IdentityRuntimeOptions = {},
) {
  const sessionPolicy =
    options.sessionPolicy ?? sessionPolicyFromEnvironment(process.env);
  const sessions = new IdentityOperations(
    pool,
    sessionPolicy,
    options.globalLogout,
  );
  const emergency = options.platformEmergencyApproverIds?.length
    ? new EmergencyAccess(pool, {
        platformEmergencyApproverIds: options.platformEmergencyApproverIds,
        sessionPolicy,
        assertFreshHuman: assertFreshDirectoryHuman,
        assertSourceUpperBound: async (db, ctx, pageIds) => {
          for (const id of pageIds)
            await assertResourceUpperBound(db, ctx, "knowledge.read", {
              kind: "page",
              id,
            });
        },
      })
    : undefined;
  const httpServices: IdentityHttpServices = {
    sessions,
    ...(emergency ? { emergency } : {}),
    ...(options.directoryBindings
      ? {
          directory: {
            options: options.directoryBindings,
            assertGroupAdmin: canonicalGroupAdmin,
            allowLoopbackHttp: options.allowLoopbackHttp,
          },
        }
      : {}),
  };
  const authOptions: OidcIdentityOptions = {
    sessionPolicy,
    emergency,
    directoryGroupClaim: options.directoryGroupClaim,
    directoryFreshnessSeconds: options.directoryFreshnessSeconds,
    ...(options.directoryAuthority
      ? {
          directoryProof: async (subject: string) =>
            options.directoryAuthority!.verify(subject),
        }
      : {}),
  };
  return {
    httpServices,
    authOptions,
    emergency,
    /** Host credential authorizer passes canonical actor or sponsor ID; subject
     * and issuer are resolved from the DB, never accepted from an agent body. */
    refreshPrincipal: async (principalId: string) => {
      if (!options.directoryAuthority)
        throw Error("DIRECTORY_REFRESH_NOT_CONFIGURED");
      const p = (
        await pool.query(
          "SELECT issuer,subject FROM access_principals WHERE id=$1 AND active AND kind='human'",
          [principalId],
        )
      ).rows[0];
      if (!p?.issuer || !p?.subject) throw Error("DIRECTORY_IDENTITY_MISMATCH");
      const proof = await options.directoryAuthority.verify(p.subject);
      if (proof.issuer !== p.issuer) throw Error("DIRECTORY_IDENTITY_MISMATCH");
      await identityTransaction(pool, (db) =>
        syncDirectoryMemberships(db, proof),
      );
    },
  };
}
