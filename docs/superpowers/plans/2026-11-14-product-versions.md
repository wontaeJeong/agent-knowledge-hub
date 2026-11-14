# Product version comparison and selective restore implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose existing version comparison, independent selective review and current-authority restore through the authenticated host and console.
**Architecture:** Reuse VersionService with authorizeInTransaction after the host identity/space/CSRF checks; expose VersionsPanel as a console destination. Fence asynchronous UI results and consume actual server pagination.
**Tech Stack:** TypeScript, React, native HTTP, PostgreSQL, Vitest.
**Spec:** docs/superpowers/specs/2026-11-14-product-completion-design.md P2; docs/LLM_WIKI_CORE.md.

## Global Constraints
- Worktree feat/product-versions-20261114 starts at P9 erasure commit 7630618; original checkout stays main.
- Preserve all 251 requirements, existing migrations and North Star meaning. VER-004~010, REV-004~007, KNO-014 are targets, not a production acceptance claim.
- Current ACL and provenance apply to historical reads. Restore creates a new independently reviewed proposal, never restores old ACL or auto-publishes.
- Existing historical metadata remains unknown where no snapshot exists. Human changes, protected content and dependency conflicts remain explicit.
- Credentials cannot acquire interactive human review through these routes. No real user data or real model calls.
- UI copy states function/status concisely. Actual 1440/390 screenshots and environment accompany the PR.

## Review Focus
- Native HTTP must preserve human-only mutations and current source revocation, including post-preview revocation (Task1).
- Historical metadata and comment positions remain version-bound and unknown/ambiguous states explicit (Task1 existing regressions).
- Stale previews, dependency edges and protected human content cannot bypass review via native routes (Task1).
- Scope/identity changes and newer authorization failures cannot revive late private UI data (Task2).
- More than 25 diff lines/publications/history entries must stay navigable without stale selection confusion (Task2).

### Task 1: Authenticated native version routes
**Files:** modify server/runtime/http.ts, server/runtime/errors.ts; create server/runtime/versions-host.test.ts; existing server/workflows/versions/versions.test.ts, server/operations/product-erasure.test.ts regression coverage.
**Interfaces:** consumes VersionService(pool, authorizeInTransaction) and handleVersionRoute({method,path,body,ctx,send,query}, service); produces /api/v1/versions routes after native auth, bounded body and CSRF. Reuse one service instance per handler; reject credential mutation paths rather than synthesize human.
- [ ] Write native HTTP + actual DB + loopback UserInfo tests: history returns200, metadata unknown, compare supports offset, bad CSRF403, unauth401, invalid body400, revoked source hides history, reader restore403; real editor restore creates pending batch and stale preview409; partial decision dependency conflict409 and no implicit approval/publication.
- [ ] Run `node scripts/test-server.mjs server/runtime/versions-host.test.ts`. Expected missing native routes return404, assertions fail.
- [ ] Connect exact handler after authentication, add explicit safe public error codes for version conflicts/limits, preserve authorization.
- [ ] Run native tests plus versions and product-erasure regression files. Expected all pass without skipped DB tests.
- [ ] Commit native host and tests.

### Task 2: Navigable, scope-fenced console
**Files:** modify src/operational/versions.tsx, App.tsx, console.ts, ConsoleShell.tsx; create src/operational/versions-interaction.test.tsx; update docs/AGENT_HANDOFF.md, docs/ROADMAP.md, docs/MISTAKE_LOG.md and docs/pr-assets/product-versions.
**Interfaces:** consumes native routes; VersionsPanel keeps existing props plus optional onChanged/onExpired callbacks. Console uses authoritative changeset.propose/approve; reader may compare. API pagination includes text.offset/totalLines/next and bundle/history next.
- [ ] Write real React/JSDOM tests: deferred history from old identity never renders after scope change; authorization failure clears retained state; server diff next page requests offset25 and renders late lines; bundle next page reachable; document switch clears prior history/preview context. App static routing test proves #versions destination exists.
- [ ] Run `npx vitest run src/operational/versions-interaction.test.tsx src/operational/versions.test.tsx`. Expected missing fencing/pagination behavior fails.
- [ ] Fence all UI reads/writes with request generation, clear protected state on identity/space/API change and 401/403/404; paginate through server API; invalidate previews on user inputs and after successful action. Mount #versions in console without calling server in preview mode; use existing primitives.
- [ ] Run UI tests and `npm run check`. Expected frontend, import, requirements251, server types, build and smoke pass.
- [ ] Capture actual browser1440/390 synthetic API rendering, keyboard interaction and permissions failure; record exact environment, assertions and limits in handoff. Update failure log for observed failures, no fake acceptance.
- [ ] Commit UI/docs. Whole-branch independent review before PR; Critical/Important fixes require RED→GREEN and suite rerun. Push separate PR based on feat/product-lifecycle-20261114; no merge.
