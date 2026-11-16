# Personal Follow-up Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox syntax.

**Goal:** Connect private, durable question threads to actual runtime, queue and authenticated UI while preserving current input and erasure fences.

**Architecture:** One QuestionsService instance serves HTTP and the runtime job adapter. Runtime resolves its server-only trusted context on admission, transmission and fenced persistence; history is typed model input and the accepted envelope and completion share the existing durable transaction. Existing queue, ACL and erasure controls remain authoritative.

**Tech Stack:** TypeScript, PostgreSQL, React, Vitest, durable jobs, loopback model.

**Spec:** docs/superpowers/specs/2026-11-14-product-completion-design.md, P1; server/questions/INTEGRATION.md.

## Global Constraints

- User-approved P1 design; no dependency upgrades, no live external messages, no push or merge.
- Only this worktree; migration 117 if needed; preserve P9 erasure fences and existing historical migration checksums.
- No browser-supplied history/seal or localStorage question content; authenticated principal and current resource permissions govern every access.
- North Star: supports query-to-knowledge feedback while preserving source ceilings and honest evidence; no model effectiveness claim without evaluation.

## Review Focus

- Revocation between admission and transmission produces zero revoked history bytes and stale work cannot persist: exercise actual loopback and DB.
- Concurrent same nonce, lost response, cancellation, restart and worker replay preserve one durable receipt and one answer/turn: DB/HTTP/queue tests.
- Other principals/spaces cannot view history, and revoked history is omitted before the next admission: HTTP and model tests.
- Erasure-protected artifacts remain inaccessible and do not permit resurrection: P9 regression.
- Missing queue, missing evidence and failure states remain explicit: HTTP/UI tests.

### Task 1: Trusted query context and durable host

**Files:** Modify `server/runtime/knowledge.ts`, `server/runtime/http.ts`, `server/runtime/main.ts`; test `server/questions/` and `server/jobs/`.

**Interfaces:** Existing `TrustedQuestionContext.resolve(db,state)` and `onCreated(db,answer)`; `QuestionsService.questionJobAdapter()` and `setSubmit`; `RuntimeService.query(ctx,question,mode,execution,context)` retains existing trusted query consumer behavior.

- [x] Write real DB/queue regression for two turns and expected history transport, fences and same-nonce receipt; run and observe the expected failure.
- [x] Implement repeated current-state context resolution, full input union/capture and atomic onCreated inside fenced write; connect a shared question service to host HTTP and job adapter.
- [x] Verify real DB, HTTP, queue, loopback, revocation, restart, cancellation, response-loss retry, private scope, evidence absence and erasure fences; observe passes.

### Task 2: Authenticated workbench and completion

**Files:** Modify `src/operational/App.tsx` and relevant UI tests; update `docs/CURRENT_STATUS.md`, `docs/AGENT_HANDOFF.md`, `docs/MISTAKE_LOG.md` and report.

**Interfaces:** Mount `QuestionsWorkbench({api,identityKey})` with current principal and workspace; preserve existing query interface.

- [x] Write failing host UI regression for mounted workbench and scope reset, then connect it and verify failure/cancellation/feedback states.
- [x] Run focused real DB tests and Node 24 `npm run check`; record exact RED/GREEN evidence and remaining company-model/browser limits, then commit.
