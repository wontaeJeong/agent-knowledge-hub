# Product Trash and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline TDD. Root performs independent review.

**Goal:** Provide current-authorized trash recovery and explicitly configured, durable, guarded retention for eligible content classes.

**Architecture:** Extend existing workflow lifecycle and retention service; retain P9 Task1 erasure fences. Use revision-bound policy, current ACL and legal holds, transactional retirement records and the existing worker's durable execution boundary. Default configuration stays disabled.

**Tech Stack:** TypeScript, React, PostgreSQL, Vitest, Node 24.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md` P9 and `docs/superpowers/plans/2026-11-14-product-lifecycle.md` Task 2.

## Global Constraints

- No default company retention periods; no external backup/physical delete claim.
- Never remove evidence required by a retained publication; unknown references fail closed.
- Current identity/ACL, holds, preview and final fenced effect must be rechecked.
- Preserve IDs, history, current permissions, version lineage and Task1 erasure replay.
- Migration 112 reserved. No dependency updates or deployment.

## Review Focus

- Trashed page collision with a current sibling requires an explicit target and rechecking access.
- Legacy trash with missing timestamps must not invent a grace date.
- A newly added hold/reference or changed policy invalidates a preview.
- Concurrent writer or stale worker cannot recreate retired content.
- Unknown provenance or externally retained content is blocked, not counted as pruned.

### Task 1: Trash policy and recovery

**Files:** `server/workflows/service.ts`, `server/retention/service.ts`, `server/workflows/http.ts`, `src/operational/workflows.tsx`, actual DB/HTTP tests.

**Interfaces:** `setDocumentState` retains existing CAS and ACL checks. Trash metadata includes `trashedAt` and optional policy-derived grace deadline; recovery preserves ID and version history and reports conflicts. Policy default has no grace period.

- [ ] Write DB tests for missing/configured grace, conflicting path, explicit recovery choice, unchanged history/ACL and revoked-source denial.
- [ ] Observe RED, implement minimal safe behavior and UI, and run GREEN.

### Task 2: Retention classes and guarded durable execution

**Files:** `server/retention/service.ts`, migration 112, worker/runtime integration and focused DB tests.

**Interfaces:** Preserve `retentionTick(workspaceId)` guarded service context and current policy revision. Retirement records must prevent late writes and recovery resurrection. Existing durable worker owns execution and shutdown.

- [ ] Write tests for eligible expired draft, publication and source version, and retained/held/unknown references; verify stale previews and retry/late-writer behavior.
- [ ] Observe RED, implement bounded dependency-safe pruning and immutable retirement/replay.
- [ ] Write tests for explicitly configured service identity and scheduled durable execution/retries, denied or revoked identity, and stop behavior; implement.
- [ ] Run focused DB/HTTP/worker regressions and `npm run check`. Document unverified browser/operations; root reviews and captures UI.
