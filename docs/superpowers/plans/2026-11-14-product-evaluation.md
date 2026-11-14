# Actual Knowledge Evolution Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Evaluate real three-cycle knowledge maintenance against raw-only and fixed static controls without leaking held-out answers or treating synthetic results as business impact.

**Architecture:** A trusted server-side experiment runner executes RuntimeService ingest, independent human review/publish, a non-holdout operational query and lint for each stage, recording actual resulting versions and maintenance usage. A separate read-only evaluator calls the same evaluation provider with equal source access/budget and per-arm raw-only, first published snapshot or latest published snapshot; heldout tasks and labels never enter maintenance. A pure metrics layer preserves all assigned outcomes and explicit review event provenance, including unknown costs and times.

**Tech Stack:** TypeScript runtime/PostgreSQL, existing JS evaluation runner/provider, Node/Vitest, synthetic loopback HTTP model.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md` P10; `docs/EVALUATION.md`.

## Global Constraints

- At least three actual ingest → review → publish → operational query → lint cycles, with raw-only/static/maintained identical source access, model, budget and permission scope.
- No evaluation questions or labels in maintenance inputs; never file heldout output. Fixed static arm never changes after first publication.
- No independent evidence double-counting for duplicate source lineage; preserve conflicts, environment and previous answers.
- Record all assigned runs and failed/timed-out/unexecuted denominators; unknown cost/time is null, never zero.
- Human review work time only from explicit paired start/end events; missing/duplicate/unmatched events remain unmeasured. Preserve reject/reproposal/review and queue wait separately.
- Synthetic/loopback regression is not company-approved evidence, actual model quality or performance improvement; retain all thresholds in existing contracts.

## Review Focus

- An evaluator label embedded in maintenance inputs must reject the run before model or writes; test leaked marker and task text.
- Duplicate/unmatched/inverted human review timestamps must remain unmeasured; test event validation.
- Failed or timed-out model calls remain assigned failures and do not silently use fixture output; test complete denominator.
- Every arm sees same sources and parameters while static snapshot stays fixed; test input envelopes across all stages.
- A protected change or failed publication must not create fake successful cycles; test failure and state.

### Task 1: Runtime evolution experiment and evaluation accounting

**Files:** Create `server/evaluation/evolution.ts`, `server/evaluation/evolution.test.ts`, `scripts/evaluation/evolution.mjs`, `scripts/evaluation/evolution.test.mjs`; modify package scripts and status/handoff/mistake records as needed.

**Interfaces:** `runEvolutionExperiment({runtime, editor, reviewer, stages, operationalQuestion, evaluator, heldout, expected, config, reviewEvents})` produces sealed stage snapshots, per-arm results and maintenance accounting. Runtime owns writes and permission checks. Evaluator receives only permitted source snapshots, wiki snapshot and one heldout task, never labels or other runs. Scoring runs separately with expected labels.

- [x] **Step 1: RED** tests for three actual staged maintenance cycles and static immutability via HTTP/DB/loopback model; tests for holdout leakage, metrics failures/timeouts, missing or duplicate review events and unknown cost.
- [x] **Step 2: Run RED** `node --test scripts/evaluation/evolution.test.mjs` and isolated `node scripts/test-server.mjs server/evaluation/evolution.test.ts`; expect absent implementation failure.
- [x] **Step 3: Implement** pure isolation/accounting and actual runtime stage orchestration with pinned snapshots, equal arm access and no evaluation writes; failures remain visible.
- [x] **Step 4: GREEN** execute focused tests, existing CORE-003 and evaluation tests, and `npm run check`.
- [ ] **Step 5: Document evidence, limits, changed requirements and review findings; commit without push or merge.**
