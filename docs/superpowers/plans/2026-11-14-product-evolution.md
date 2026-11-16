# Evidence-linked Knowledge Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Reintegrate a cited answer through a reviewable, evidence-linked model synthesis that can revise knowledge, create analysis, or explain no change.

**Architecture:** Extend the existing answer filing runtime and publication transaction, retaining its cited versions, source ACL envelope, human protections and independent publication flow. Preserve structural filing as explicitly structural; model filing uses the configured model, never an offline fallback. Pin validated candidate interpretations to the batch; at atomic publication create unverified evidence and version-bound claims plus conflict review requests using the existing refinement service.

**Tech Stack:** TypeScript, PostgreSQL, Vitest, HTTP/MCP runtime.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md` P6.

## Global Constraints

- Preserve CORE-003 multi-page ingestion, protected human content, source lineage and current authorization revalidation.
- Distinguish model synthesis from structural processing; no fabricated success or independent execution proof.
- Candidate claims, contexts, temporal conditions and conflicts remain proposals, not approved facts.
- Existing publication review, atomicity, idempotency and stale-source/ACL checks remain mandatory.

## Review Focus

- Repeated derived answers: model must not count common sources as independent evidence; test repeated/no-change.
- Counterevidence for the same conditions: proposal retains both evidence sides; test model output and source lineage.
- Different environment: record applicability rather than overwrite a general rule; test model input and proposal.
- Protected text: reject modifications and preserve current version; test actual proposal boundary.
- Revocation or concurrent change during model call: reject without partial proposal; test database state.

### Task 1: Evidence-linked answer reintegration

**Files:** Modify `server/runtime/knowledge.ts`, `server/runtime/model.ts`, existing runtime tests and documentation. Modify existing HTTP/MCP/UI surfaces only as necessary to expose outcomes.

**Interfaces:** Consumes `RuntimeService.file(ctx,id)` and `propose(...)`; returns existing proposal reference or explicit no-change outcome with reason. Model receives answer, cited versions, source snapshots and existing page context, with full provenance pinned by `InputEnvelope`.

- [x] **Step 1: Write failing tests** for model answer filing: existing-page revision, separate analysis, duplicate/no-change reason, model failure, stale ACL/source and protected content; assert sources and dependency versions remain pinned.
- [x] **Step 2: Verify RED** using focused Vitest runtime tests. Expected: new behavior fails because filing currently copies the answer into a new page.
- [x] **Step 3: Implement** `RuntimeService.file(ctx,id)` model path with validated model output, current policy, input envelope, no-change revalidation and atomic proposal; retain structural path.
- [x] **Step 4: Verify GREEN** focused tests and existing CORE-003 tests; document command and result.
- [ ] **Step 5: Complete documentation and run `npm run check` plus server DB suite**; record verification and limits in handoff and report, then commit.
