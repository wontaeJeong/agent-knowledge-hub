# Published Recommendation State Implementation Plan

> **For agentic workers:** Execute inline with `executing-plans`; no additional agents or worktrees.

**Goal:** Preserve every accessible published page while making server-provided recommendation and review status clear.

**Architecture:** The operational knowledge list consumes the existing `/pages` response. Only explicit boolean recommendation values are classified; review overdue is an independent indicator. Filters are client-side and default to all pages; server ACL and direct links remain unchanged.

**Tech Stack:** React, TypeScript, Vitest, PostgreSQL runtime, Chromium.

**Spec:** The task request and `docs/LLM_WIKI_CORE.md`.

## Global Constraints

- Do not infer current recommendations from missing fields, dates, or lifecycle.
- Do not hide existing pages by default or infer that overdue means false or discarded.
- Preserve current authorization and clear stale protected data on failure or scope changes.
- Treat SRH-003, SRH-005, and LIF-002 as partial work only.

## Review Focus

- Legacy or malformed response fields: unknown, not current.
- Overdue current page: current and overdue, never false by inference.
- Filtering/search and pagination: reset page and preserve links.
- Revocation, failed refresh, or space/session changes: old protected data is not visible.
- Narrow viewport and keyboard interaction: usable controls and legible result states.

### Task 1: Published list and interaction

**Files:** `src/operational/App.tsx`, focused UI test(s), and dependency metadata only if needed.

- [ ] Original RED covered the initial status labels/default list and filtering only; it did not separately demonstrate failures for every search, pagination or empty-result case. Later regression coverage is recorded in the handoff.
- [x] Run the initial status test and observe the expected failure before implementation.
- [x] Add server-value-only Korean status labels, independent overdue explanation and opt-in filter. Reset pagination on selection and data change; hide protected list while reloading or on error.
- [x] Run focused tests and confirm passing.

### Task 2: Runtime and evidence

**Files:** focused runtime/HTTP regression if needed, `docs/AGENT_HANDOFF.md`, `docs/MISTAKE_LOG.md` if failures occur, screenshot assets.

- [x] Verify actual runtime HTTP response and authorization revocation using test DB; cover current, overdue, future and replacement states.
- [x] Run Node 24 `npm run check`; inspect results rather than treating missing tests as passing.
- [x] Verify Chromium at 390px and 1440px including keyboard, pagination, empty results and overflow; identify actual versus synthetic API fixtures and capture both viewports. Linux Chromium keyboard operation passed; macOS native menu operation remains unverified as described in the handoff.
- [ ] Record exact verification and remaining gaps; commit, push via SSH and open a small PR without merging.
