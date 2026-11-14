# Product lifecycle completion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task with TDD. Root coordinates the final independent review.

**Goal:** Extend safe product erasure, trash/restore and retention to the stored question, agent and version workflows before their public hosts are enabled.

**Architecture:** Extend the existing preview-bound, current-authorized mutation-gated service, with explicit per-table handling of constrained fields. Retain immutable identity/attribution and erase content through the existing privileged redaction boundary. Use existing lifecycle and retention services for user actions and guarded scheduled execution.

**Tech Stack:** TypeScript, PostgreSQL, React, Vitest; Node24.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md`, P9.

## Global Constraints

- Keep all251 requirements and the North Star unchanged. Do not alter released migrations.
- Only synthetic test data. No production deployment, real deletion or PR merge.
- Unknown lineage and cross-workspace credential relations fail closed; no best-effort success.
- Current ACL, legal holds, full input lineage, preview hash and exclusive mutation gate precede any redaction.
- No restoration of past permissions, automatic Owner elevation or automatic approval.
- Existing external-backup limitations and `allCopiesErased:false` remain honest.
- Reserve migration111; PR30 uses110. Other workers use112/114/115.

## Review Focus

- Question turn/feedback IDs propagate content lineage without selecting unrelated private threads.
- Constraint fields such as model mode, feedback category and decision retain valid enum values after redaction.
- Credential/usage text may be unlineaged; resource erasure must explicitly report unresolved workspace text rather than silently erase unrelated records.
- Late writes through trusted metadata/restore helpers cannot revive erased content.
- Restoring trash or retrying retention must retain current ACL and IDs and expose path conflicts.

### Task 1: Extend reviewed erasure and late-write fences

**Files:** `server/operations/erasure.ts`, new `server/operations/product-erasure.ts`, `server/migrations/111-product-lifecycle.sql`, `server/workflows/versions/{service,metadata}.ts`, `server/questions/erasure-fence.ts`, relevant tests in `server/operations/`.

**Interfaces:** Keep preview/execute/replay public signatures. Add internal extension inventory/redaction helpers receiving the same PoolClient and workspace/selected rows; never acquire a nested transaction. Version helpers use a shared DB-only product write fence before persistence under the existing mutation gate.

- [ ] Add actual DB regressions: workspace erasure with private question turns/feedback and immutable version snapshots succeeds, removes synthetic plaintext, preserves unrelated workspace and immutable identity fields, rejects later writes; resource erasure follows exact source/page lineage and exposes unmapped text.
- [ ] Run `node scripts/test-server.mjs server/operations/product-erasure.test.ts` with the synthetic TEST_DATABASE_URL; record failing behavior before implementation.
- [ ] Add new migration extending the explicit privileged redaction allowlist and protecting valid non-content enums. Integrate questions/versions/collaboration/governance content into inventory and lineage with explicit identifiers.
- [ ] Implement credential revocation/redaction for an approved whole-workspace deletion, cross-space-reference rejection, and explicit unlineaged handling for resource deletion. Preserve usage accounting numeric fields and attribution while removing free-form labels.
- [ ] Apply the same behavior to signed recovery replay and keep denied/failed receipts from becoming approval. Preserve hold/ACL rechecks and transactional rollback.
- [ ] Cover stale preview, current ACL revocation, held content, enum constraints, malformed unknown content, concurrent write fencing and retry. Update old tests that asserted temporary unsupported behavior to exercise the replacement safety contract.
- [ ] Run focused erasure/questions/versions tests, `npm run check`, inspect outputs and commit this independently reviewable feature.

### Task 2: Complete product trash/restore and guarded retention

**Files:** `server/workflows/service.ts`, `server/retention/{service,http}.ts`, `server/runtime/main.ts`, `src/operational/workflows.tsx`, related tests and a new focused lifecycle worker module if needed.

**Interfaces:** Preserve `ContentRetentionService.retentionTick(workspaceId)` guard requirement and existing preview-hash/revision API. User restore retains page ID/version history and current ACL. Retention uses explicit configured service identity, never a synthesized human administrator.

- [ ] Add failing tests for grace period metadata, trash restoration with a path conflict, current ACL denial, and a configured service's scheduled retention of an unreferenced expired record versus referenced/held content.
- [ ] Extend lifecycle metadata/UI with explicit deletion/grace/restore results; never infer a company retention period.
- [ ] Implement reviewed dependency-safe retention for supported immutable record classes with explicit retirement records; preserve kept publication evidence and reject unknown references. Connect guarded ticks to the existing server lifecycle and stop them at shutdown.
- [ ] Run actual DB/HTTP regression and `npm run check`; capture changed UI at1440/390 with synthetic data and record real limitations.
- [ ] Update CURRENT_STATUS, AGENT_HANDOFF and MISTAKE_LOG with IDs, actual evidence and remaining external policy/backup limitations; commit.

## Completion

Root obtains a fresh whole-branch review, fixes material findings with regressions, and opens PR(s) without merging. Task1 and Task2 may be split into two dependent PRs if the diff is too broad; that preserves approved P9 behavior while making erasure independently reviewable. CI and UI evidence are reported against final commits.
