# Legacy Three-Role Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve explicitly evidenced pre-upgrade three-role access for unadopted spaces, without creating product-space ownership or expanding current source readers.

**Architecture:** Capture old membership and matching session subject before migration 010 in the migration transaction; migration 113 materializes a revocable compatibility authority only for workspaces without adopted metadata. Fresh verified OIDC issuer/subject must match canonical principal ID and captured evidence. Use explicit legacy capabilities and current membership/active-principal checks; adoption extinguishes this path and modern grants remain authoritative. Already-upgraded databases without pre-transition evidence remain quarantined unless supported by an independently verifiable historical manifest.

**Tech Stack:** TypeScript, Node, PostgreSQL, OIDC, Vitest.

**Spec:** docs/superpowers/specs/2026-11-14-product-completion-design.md, P5; docs/ACCESS_CONTROL.md and ADR 005.

## Global Constraints

Do not modify released migrations or infer pre-upgrade authority from mutable current membership. Migration 113 is reserved. Never infer Owner, Admin or Maintain from reviewer. No dependency upgrades, pushes, PR creation or merge. Fresh OIDC verification, resource/source upper bounds and independent review/final publication revalidation are mandatory.

## Review Focus

- Existing upgraded DB has no pre-transition snapshot: quarantine it, never reconstruct evidence from current rows.
- Unknown or disabled user, mismatched issuer/subject or expired session: no legacy actions.
- Modified/revoked membership and later login: no automatic restoration of withdrawn authority.
- Adoption between authorization and write: legacy authority no longer authorizes the effect.
- Same principal and resource IDs in separate spaces: no cross-space capability or ACL widening.

### Task 1: Immutable pre-transition evidence and migration

**Files:** Modify `server/database.ts`; create `server/migrations/113-legacy-roles.sql`, `server/access/legacy-compatibility.test.ts`.

**Interfaces:** Migration hook captures `(workspace_id,principal_id,role,subject)` from existing membership and corresponding pre-transition session in one migration transaction. Migration 113 produces revocable compatibility records only where no adopted `access_spaces` row exists, and never synthesizes historical evidence on an already-transitioned database.

- [ ] Write an upgrade regression starting with the released 001–009 schema, three roles, sessions, source readers, disabled and unknown identities; assert captured proof and no false proof for already-transitioned DB.
- [ ] Run `node scripts/test-server.mjs server/access/legacy-compatibility.test.ts`; expect missing evidence to fail.
- [ ] Add pre-010 hook and migration 113, including a durable revocation fence for changes/removal of captured membership and adoption.
- [ ] Run the migration regression and existing migration tests; expect pass.

### Task 2: Fresh OIDC authority and bounded runtime operations

**Files:** Modify `server/access/index.ts`, `server/runtime/auth.ts`, `server/repository.ts`, `server/publication.ts`, `server/runtime/http.ts`, relevant job adapters; test `server/access/legacy-compatibility.test.ts` and runtime HTTP.

**Interfaces:** A server-verified interactive session determines whether a captured legacy binding can produce explicit allowed capabilities; a legacy reviewer never gains a modern Maintain/Admin/Owner role. Data reads and changes continue to use existing source ceilings and publication author/approval/version checks.

- [ ] Write real OIDC/DB HTTP tests for reader/editor/reviewer read, write, queue, independent approval/publish; confirm cross-space, credential, export/admin, unknown/disabled and revoked access fail.
- [ ] Run focused tests; expect authenticated legacy routes to fail at current quarantine boundary.
- [ ] Connect verified session identity, bounded capability checks, protected operations and independent publication to the compatibility binding; make adoption take precedence atomically.
- [ ] Verify failed/disabled/revoked subject, post-adoption and relogin cases plus source revocation and stale approval.

### Task 3: Evidence-based recovery and documentation

**Files:** Add a server-operator historical-manifest import only if independently verifiable provenance and explicit operator authorization can be established; update `docs/CURRENT_STATUS.md`, `docs/AGENT_HANDOFF.md`, `docs/MISTAKE_LOG.md`.

- [ ] Test that already-upgraded DBs never infer compatibility from current rows; if manifest support is implemented, verify signature, archived identity and operator-supplied workspace/role binding, tamper/replay and post-adoption rejection.
- [ ] Implement only a verifiable historical-evidence path; otherwise document precisely why pre-existing upgraded DBs remain quarantined and do not claim complete recovery.
- [ ] Run `npm run check` and isolated PostgreSQL migration, HTTP and publication regressions; record commands and remaining limitations, commit, request independent permissions review.
