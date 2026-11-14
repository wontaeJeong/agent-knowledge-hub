# Product Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect personal notifications, review work, and durable digests to the authenticated application and worker.

**Architecture:** Reuse CollaborationService and its current access checks and governance responsibility adapter. The runtime host owns one instance shared by HTTP and the worker; the authenticated operational app uses the existing panel and displays individual in-app notifications separately from email delivery receipts.

**Tech Stack:** TypeScript, PostgreSQL, Node HTTP, React, Vitest.

**Spec:** docs/superpowers/specs/2026-11-14-product-completion-design.md, P3.

## Global Constraints

Preserve ACL, source ceilings, CSRF, current reviewer eligibility and existing 3-role compatibility. No outbound messages during development. Email requires an explicitly configured approved recipient binding and destination. No dependency upgrades or migration 110. No merge.

## Review Focus

- Revoked access must remove titles and links from notifications and inbox.
- Reviewer revocation must withdraw assignment on the next scan.
- A stale or changed preference must not dispatch an old digest.
- Session expiry and CSRF must protect all personal mutations.
- Gateway acceptance, confirmed receipt, and in-app read state must remain distinct.

### Task 1: Runtime host and worker

**Files:** Modify `server/runtime/http.ts`, `server/runtime/main.ts`; create `server/runtime/collaboration-host.ts`, `server/runtime/collaboration-host.test.ts`.

**Interfaces:** host supplies a `CollaborationService` and `CollaborationWorker`; HTTP passes authenticated context and full path/query to `handleCollaborationRoute`; main starts and drains worker.

- [ ] Write DB/HTTP regression for settings, read acknowledgement, CSRF and revoked-page visibility, plus worker review eligibility and retry behavior.
- [ ] Run the focused test via `scripts/test-server.mjs` and confirm the missing runtime route fails.
- [ ] Implement host, HTTP routing, current directory proof and worker lifecycle; fail closed without approved email configuration.
- [ ] Run focused regression and existing collaboration tests; expect all pass.
- [ ] Commit the tested runtime change.

### Task 2: Operational inbox

**Files:** Modify `src/operational/App.tsx`, navigation, `src/operational/notifications.tsx`; test `src/operational/notifications.test.tsx`.

**Interfaces:** `NotificationPanel` consumes the existing `OperationalApi`, `capabilities`, and `onExpired`; loads `/collaboration/notifications` and POSTs `/:id/read` using that API.

- [ ] Add a failing UI test for visible in-app notifications, read action and navigation availability.
- [ ] Run `npx vitest run src/operational/notifications.test.tsx`; expect missing UI to fail.
- [ ] Connect the panel to the authenticated app and render in-app notifications separately from delivery receipts.
- [ ] Run the focused test and full `npm run check`; expect pass.
- [ ] Update CURRENT_STATUS, AGENT_HANDOFF and PR mistake log with actual verification and limitations; capture 1440px/390px browser evidence if available; commit.

## Recipient proof contract

The configured recipient endpoint is HTTPS and origin-allowlisted, authenticated by a server token. It returns a compact Ed25519 JWT pinned to a server-configured public key and issuer, with `aud=collaboration-recipient`, `workspaceId`, `principalId`, `identityIssuer`, `subject`, verified `email`, `iat`, and `exp`. The proof expires within 30 seconds and must exactly match the current canonical principal; directory activity and DB state are independently rechecked. A separate approved HTTPS gateway handles idempotent delivery. All endpoint settings must be present or all absent. The configured service dispatcher is checked as an active service principal. Missing configuration does not enable sending; no real messages are sent in development.

Runtime email configuration requires all of `AKH_COLLABORATION_RECIPIENT_URL`, `AKH_COLLABORATION_RECIPIENT_ALLOWED_ORIGINS` (JSON array), `AKH_COLLABORATION_RECIPIENT_ISSUER`, `AKH_COLLABORATION_RECIPIENT_PUBLIC_KEY` (Ed25519 SPKI PEM), `AKH_COLLABORATION_RECIPIENT_TOKEN`, `AKH_COLLABORATION_GATEWAY_URL`, `AKH_COLLABORATION_GATEWAY_ALLOWED_ORIGINS` (JSON array), and `AKH_COLLABORATION_GATEWAY_TOKEN`; partial settings fail startup. `AKH_COLLABORATION_DISPATCHER_ID` selects an existing active service principal, and the existing `AKH_DIRECTORY_*` adapter supplies current subject status. The proof endpoint receives the canonical workspace/principal/identity issuer/subject JSON and returns `{ "token": "<compact JWT>" }`; it must independently verify the email. A gateway acceptance is not delivery confirmation.
