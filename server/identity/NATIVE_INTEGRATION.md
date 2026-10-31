# Task B native integration follow-up

## Implemented in native production paths

- `OidcAuth` constructor's optional sixth argument is `OidcIdentityOptions`; existing five-argument fixtures remain supported. `OidcAuth.create(pool, options?)` consumes deployment session policy defaults (absolute 3600s, idle 1800s, bounded touch 30s). Native callback initializes activity in the session INSERT transaction. Cookies/session expiry use the configured absolute ceiling intersected with token expiry; no activity update extends either ceiling.
- `authenticate` fetches actual UserInfo, checks current active human and exact bound issuer/subject, synchronizes verified directory groups, asserts policy, resolves canonical rights, and bounds interactive activity updates in one transaction. `authenticate(req,false)` performs no idle extension. Native `requestGuard.revalidate` uses this non-touching form. Known job/notification/event polling does not touch activity. No client last-seen timestamp is accepted.
- `requestGuard.assertSession` now asserts idle/absolute policy, original session hash/principal/CSRF and current canonical role snapshot (including the five-role snapshot when supplied), before a fenced effect. Current-role computation projects stale directory paths first. Roleless accounts can still resolve an exact pinned share; they gain no workspace capability.
- `executionSession`, `revalidateInteractiveGrant`, `assertInteractiveGrant`, and `backgroundContext` enforce policy and current canonical action role. Network revalidation happens before DB final fencing, never silently refreshes idle activity, and compares the saved identity/CSRF/subject snapshot. All final native job assertions use the original hashed parent session.
- `switchSpace` locks the original session, revalidates, asserts current target access, touches activity monotonically, and rotates CSRF without extending absolute expiry. Native logout and provider-failure cleanup revoke the parent execution grants/ephemeral canonical credentials before removing the originating session. Native callback still returns `/?app=1` and UserInfo failures remove the session.
- A missing activity row is **not** initialized by a final guard. Only an actual successful live UserInfo validation may recover it, with active current identity and a conservative issuance/last-seen bound `expires_at - max(3600, configuredAbsoluteSeconds)`, never a pretend new login at now. Unknown old idle history can therefore expire even when its token remains valid. Canonical hashed legacy IDs may bind verified issuer/subject; arbitrary legacy/test IDs are not rebound to a new provider.
- Default directory proof comes from the already verified OIDC UserInfo (expected subject, configured issuer) through `createVerifiedOidcDirectoryAdapter`. Exact group claim values remain exact IDs/paths; Keycloak display paths are not relabeled GUIDs. `directoryGroupClaim` explicitly selects the deployed provider mapper; `directoryProof` can instead supply an independently verified approved authority proof. An unknown/undefined proof never manufactures membership: existing directory paths expire under their original SLA.
- Canonical `effectiveAccess` projects fresh directory contributions before any group grant path. A Pool call is wrapped in a transaction; real effect clients retain their transaction. `readShare` projects before its group lookup, and group-share recipient selection projects current memberships. Directory expiration preserves independent manual memberships and never changes principal activation. Membership path changes and binding revisions bump affected spaces' policy epochs.
- Canonical `setGroupMembers` uses explicit manual-provenance helpers. Known directory edges are included even if their canonical row already expired, so removing an absent projected member still leaves a denial tombstone. Only an explicitly selected, qualified human product regrant clears it; automatic fresh directory proof cannot. Existing server-domain fixtures keep their explicit canonical team-Owner checks; no fake interactive session is introduced.
- Native request guards register optional emergency authority in a server-only WeakMap; background/credential guards do not. Canonical `authorizeActionDb` consumes it only for an active team member, exact page/version, a fixed allowed incident action, current independent approval and current human proof. It never unions emergency actions into `effectiveAccess.capabilities`, creates raw readers, grants Admin/Owner, authorizes `knowledge.protect`, changes role/token management, publishes, deletes, or bypasses egress/holds. `assertResourceUpperBound` is the extracted **same** original page/source/linked-page/full-provenance ceiling, applied before and after the emergency path. Source ACL denial wins even if the injected approval callback were permissive.

## Coordinator factory / mounts (remaining owned elsewhere)

```ts
import { createIdentityRuntime } from "../identity/runtime";
import { handleIdentityRequest } from "../identity/http";

const identity = createIdentityRuntime(pool, {
  // Explicit server deployment IDs, never inferred from Owner/reviewer/email.
  platformEmergencyApproverIds: configuredEmergencyApproverIds,
  // Optional server-approved exact binding options / signed authority / logout.
  directoryBindings: configuredBindingOptions,
  directoryAuthority: approvedDirectoryAuthority,
  globalLogout: approvedGlobalLogoutAdapter,
});
const auth = await OidcAuth.create(pool, identity.authOptions);
```

Construct with a `signedDirectoryAuthority` for an approved HTTPS proof endpoint/pinned RSA key or use native verified UserInfo by omitting the independent authority. Factory source-ceiling checks call canonical `assertResourceUpperBound`, not emergency authorization recursively. Empty/missing approver configuration disables emergency behavior; it does not choose an Owner. Mount `handleIdentityRequest(identity.httpServices, ctx, method, pathWithQuery, body)` behind the existing CSRF/Origin/body-limit/authentication checks. It returns `{status,body}` or null. Clear the cookie for current-session/global logout. `GET /api/v1/identity/emergency-pages/:pageId/versions/:version` performs an actual canonical resource-scoped read and returns `{pageId,version,content}`; it does not list the entire space or expose raw metadata.

For the account UI:

```tsx
import { IdentityManager, identityApiAdapter } from "./identity";
<IdentityManager
  api={identityApiAdapter(api)}
  onExpired={clearProtected}
  emergencyEnabled={emergencyConfigured}
  directoryEnabled={directoryConfigured}
  pageOptions={currentlyPermittedPageOptions}
/>;
```

`identityApiAdapter` is stable per `OperationalApi` object and calls `api.request<T>(pathWithoutApiV1, method, body)`, preserving that object's CSRF/space/idempotency/error handling. Do not pass the API object as a function or double-prefix `/api/v1`.

**Unattended refresh remains an A/host hook:** before credential/service-sponsor revalidation, call `identity.refreshPrincipal(canonicalHumanOrSponsorId)` when an independent approved authority is configured, outside the final DB transaction. It derives issuer/subject from an active human DB row, fetches verified proof and synchronizes transactionally. Lower-level `refreshVerifiedDirectoryMemberships(pool, subject, authority)` is also exported; its subject must be server-derived. A provider error must deny that execution, not reuse an expired proof. This worker did not edit jobs/model/host modules. Canonical rights already expire directory contributions even without a refresh; missing unattended configuration cannot create an immortal group path.

## Explicit legacy compatibility conflict — NOT declared fixed

Source inspection of released `origin/main:server/runtime/auth.ts`, migrations 009/014, and `server/access/legacy-adapter.ts` establishes:

1. Released unmanaged spaces admitted an authenticated user with the existing three-role membership/IdP mapping. Migration 009 preserves old verified principal/subject metadata, but not an owned namespace. Migration 014 deliberately does **not** synthesize ownership from these memberships or reviewer roles and explicitly quarantines unowned/unadopted spaces. The legacy adapter says it never reads archived tables/memberships as authorization authority.
2. This is not merely protection against unknown/new identities. `legacy-compatibility.test.ts` builds released001–007, seeds an actual previously verified hashed principal/session and reviewer membership, migrates all current versions, performs fresh live OIDC UserInfo verification, and shows the principal authenticates while its former workload still fails canonical authorization. The original source reader rows remain unchanged and no Owner/Admin/policy-strengthen permission is synthesized.
3. Therefore the current AGENTS requirement **“미이관 공간은 기존 3역할/인증을 유지” is not met for a production upgrade containing a previously verified but ownerless unmanaged workspace**. Local explicit bootstrap and previously owned Organization/personal spaces adopted by014 are different cases; their passing tests do not establish compatibility for this case.
4. No generic unmanaged-context fallback, new legacy authority, or migration111 was added. Current safe behavior is intentional quarantine until an authorized operator supplies explicit real ownership/adoption and reviewed roles via the existing bootstrap/adoption mechanism. Old reviewer → Maintain must not be an implicit shortcut to new `policy.strengthen`/Admin powers. Unknown issuer/subject, disabled identities, missing provenance and malformed/unverified bindings remain quarantined even after unrelated spaces are adopted.
5. A product/operator decision is required: either implement a separately reviewed bounded three-role compatibility projection with a frozen pre-upgrade verified binding and exact legacy-only capabilities throughout publication/review/source authorization, **or** explicitly approve an operator-adoption prerequisite and change that AGENTS/upgrade contract through the normal process. This worker has not edited AGENTS, North Star or the requirement to pretend this incompatibility is resolved. It is a real remaining upgrade acceptance gap, not company approval or a site-only limitation.

## Verification caveat

The strengthened exact issuer binding exposes existing cross-file fixture contamination: `server/access/access.test.ts` assigns shared principal `reviewer` to `https://fixture.invalid`; `server/access/http.test.ts` later reuses that principal with a different loopback issuer. Its formerly permissive authentication ignored the mismatch. The isolated original HTTP suite passes on a fresh UUID DB. Do not weaken production issuer binding to make that contaminated combination pass; the aggregate harness/fixture isolation needs an explicit fix by its owner. Latest executed counts and full gate results are in the worker report.
