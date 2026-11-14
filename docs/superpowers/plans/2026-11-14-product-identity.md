# Product Identity Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect authenticated account and session operations to the real host and application.

**Architecture:** Construct the existing identity runtime at startup and dispatch its HTTP services after authentication and CSRF validation. The account screen uses the existing authenticated API adapter and server-declared optional feature availability.

**Tech Stack:** TypeScript, PostgreSQL, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md` P4; `server/identity/INTEGRATION.md`; `server/identity/NATIVE_INTEGRATION.md`.

## Global Constraints

- Keep canonical authorization and source ceilings; never infer emergency approvers.
- Directory and emergency features require explicit server configuration; no dependency upgrades.
- P5 legacy compatibility is separate.

## Review Focus

- Other actors' sessions cannot be revoked; HTTP returns 404.
- Missing or incorrect Origin/CSRF prevents mutation.
- Current-session revocation and logout-all clear the cookie and protected UI.
- Disabled identities or expired sessions cannot use the route.
- Optional features remain unavailable without configuration and source ceilings remain intact.

### Task 1: Host authentication and HTTP integration

**Files:** `server/runtime/main.ts`, `server/runtime/http.ts`, `server/identity/native-integration.test.ts`.

**Interfaces:** `createIdentityRuntime(pool, options)` supplies `authOptions` and `httpServices`; `createRuntimeHandler` accepts those services. `/api/v1/me` advertises only configured options.

- [ ] Write actual HTTP tests for own session list, other-user revocation, CSRF failure, current-session revocation/cookie clearing, logout-all, and disabled/expired actor.
- [ ] Run tests and observe missing route failure.
- [ ] Mount identity routes after authentication, CSRF, and bounded parsing, reject credentials, set cookie on current revocation/logout-all, and map identity errors.
- [ ] Configure identity runtime explicitly at startup and pass its auth options and services.
- [ ] Run focused HTTP/DB tests and confirm passing.

### Task 2: Account screen and final verification

**Files:** `src/operational/App.tsx`, `src/operational/api.ts`, frontend tests, status and handoff documents.

**Interfaces:** `IdentityManager` receives `identityApiAdapter(api)`, `clearProtected`, configured feature flags and currently permitted pages.

- [ ] Write a failing app test showing actual account screen mounts session management and protected data is removed on expiry.
- [ ] Wire component and server feature flags; preserve preview behavior.
- [ ] Run focused frontend tests and complete `npm run check`, server security tests, and browser checks where feasible.
- [ ] Record results and limits in status/handoff and execution report; commit for independent review.
