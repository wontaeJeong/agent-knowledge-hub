# Developer Experience and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Track completion with checkboxes.

**Goal:** Fresh source checkouts get a documented, reproducible installation and the same checks locally and on PRs, without changing app features.

**Architecture:** Retain npm, Vite, Vitest and the local demo server. Add dependency-free diagnostics and HTTP smoke checks, explicit supported Node LTS versions, and least-privilege CI with container verification. No production deployment is configured because the product has no production backend or deployment credentials.

**Tech Stack:** Node 22.12+/24 LTS, npm, GitHub Actions, Docker Compose.

**Spec:** User request: independently audit/improve development setup, testing and PR CI/CD; stop at PR, do not merge (latest instruction). Implementation choices below are agent decisions under the user's permission to proceed without questions.

## Global Constraints

- Do not modify app features, North Star meaning, runtime wiki rules or requirement acceptance/status.
- Support Node `^22.12.0 || ^24.0.0`; recommend Node 24 using `.nvmrc`.
- Preserve `Verify / check` as a final stable CI gate; PR code gets no secrets or write token.
- Relate work to OPS-002/003/014, SEC-012 and EVA-007 without claiming production acceptance.
- Existing knowledge is unchanged; repeatable domain/HTTP regressions protect the knowledge loop and its safety invariants. This is not semantic-quality or downstream-agent evaluation.

## Review Focus

- Unsupported Node fails early with actionable instructions; test version boundaries.
- Missing dependencies produce setup instructions, not an opaque import error; test in an empty directory.
- A failed HTTP smoke check returns nonzero and always stops its child server; test a broken artifact/startup and remote endpoint.
- Windows/macOS use portable npm/Node commands; exercise the CI matrix.
- Container tests use isolated Compose project/port and cleanup on failure; execute Docker smoke with bounded health polling.

## Task 1: Reproducible developer commands

Files: `package.json`, `package-lock.json`, `.nvmrc`, `.npmrc`, `.editorconfig`, `.gitignore`, `scripts/doctor.mjs`, `scripts/doctor.test.mjs`.

- [ ] Add failing tests for Node 22.11/22.12/24/25/26, missing dependencies, and diagnostic CLI exit/output.
- [ ] Run `node --test scripts/doctor.test.mjs`; confirm missing module failure.
- [ ] Implement dependency-free environment diagnostics; add engines, engine-strict and doctor/typecheck/test:watch/check commands. Ignore agent-generated local state, not user source.
- [ ] Run doctor tests and baseline tests using supported Node; commit reviewed tooling changes.

## Task 2: Build and HTTP smoke verification

Files: `scripts/smoke.mjs`, `scripts/smoke.test.mjs`, `package.json`, `compose.yaml`.

- [ ] Write failing tests for HTML, referenced JS/CSS and brand assets, missing URL 404, remote failures, and child cleanup/startup failure.
- [ ] Confirm smoke module missing failure, then implement `checkStaticSite(base: string): Promise<void>` plus CLI: no argument starts/stops the existing demo, optional base checks an existing static server.
- [ ] Add `test:smoke`, include smoke after build in `check`; allow Compose host-port override while retaining loopback binding and default 8080.
- [ ] Run regression tests, `npm run check`, and an isolated Docker build/health/HTTP check with cleanup.

## Task 3: PR CI and developer guidance

Files: `.github/workflows/ci.yml`, `.github/pull_request_template.md`, `docs/DEVELOPMENT.md`, `README.md`, `docs/TESTING.md`, `docs/AGENT_HANDOFF.md`.

- [ ] Configure Ubuntu Node22/24, macOS/Windows Node24, npm cache/ci, bounded timeouts, cancellation, read-only permissions, merge queue/manual triggers, build artifact and Docker smoke job. Final `check` fails if any required job fails or skips.
- [ ] Document fresh clone, supported runtime, offline vs model setup, focused tests, build/smoke, CI reproduction, Docker limitations and troubleshooting. Do not enforce pre-existing formatting debt by mass-changing app files.
- [ ] Run full local checks, diff/secret review, independent branch review, commit and push.
- [ ] Open PR, observe actual GitHub Actions results and fix failures. Record actual evidence/remaining limitations in handoff and testing docs. Leave PR unmerged.

## Baseline evidence

- Fresh `npm ci`: 58 packages, audit 0 vulnerabilities; host Node25 warns Vitest does not support that runtime.
- `npm test`: 32 Vitest + 5 Node HTTP tests pass; requirements 251 pass; build passes with existing 510.25 kB chunk warning.
- Latest main and previous PR `Verify` runs succeeded via GitHub API; prior workflow has one Ubuntu Node22 job only.
- Existing Prettier debt in four app/data/style files: do not reformat unrelated product code in this PR.
