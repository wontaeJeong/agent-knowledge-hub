# Trusted Selected Artifact Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline TDD.

**Goal:** Fetch explicitly selected OpenCode 2.2.2 artifacts from an approved personal host into current-authorized private sources.

**Architecture:** Server configuration binds a unique HTTPS host to a canonical principal and explicit allowed session IDs. A version probe and fixed session/message URL fetch bytes directly; browser-provided artifacts remain rejected. A persisted connection revision allows revocation, rechecked in the same transaction as source storage. Existing parsers and deduplication handle validated bytes.

**Tech Stack:** TypeScript, PostgreSQL, Node HTTPS, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-product-completion-design.md`, P7.

## Global Constraints

- Preserve all 251 requirements, source ceilings and unverified evidence semantics. No real user collection, model call, daemon or deployment.
- Only `opencode` version `2.2.2` with existing anonymized fixtures; unsupported installed versions remain disabled.
- An approved binding is an operator declaration that the endpoint and listed sessions belong to exactly one canonical issuer/subject. Shared/multi-user hosts without this proof are unsupported. Never infer ownership from request JSON.
- No browser URL/token/body/exclusion-policy input. Process-configured host/version path, allowed sessions and excluded text/session rules only. TLS and redirect/body/time bounds apply.
- New migration116 only; never edit released migrations. Existing raw-artifact endpoint stays rejected.

## Review Focus

- Same artifact ID on different sessions/hosts must not deduplicate incorrectly.
- Revoking a connection during fetch or file write must prevent storage.
- New unsupported provider versions and incomplete artifacts must fail without source creation.
- Server exclusions apply to selected text and omit reasoning/native/tool inputs.
- Restart must not reactivate a revoked connection; no broad migration/session auto-adoption.

### Task 1: Trusted collection and native HTTP

**Files:** new `server/storage/trusted-collector.ts`, `server/storage/trusted-collector.test.ts`, `server/migrations/116-trusted-collector.sql`; modify `server/storage/{collectors,service,routes}.ts`, `server/runtime/{http,main}.ts`.

**Interfaces:** `TrustedArtifactCollector.initialize()`, `list(ctx)`, `revoke(ctx,id,expectedRevision)`, `collect(ctx,id,input)`; `StorageService.ingestText(ctx,input,guard?)` accepts a trusted optional same-transaction guard, never from the DTO. Raw `collectArtifact` remains rejecting; internal verified parser validates exact chosen message/session.

- [ ] Write actual DB/HTTP regressions for configured current user/session collection, forged body/session, duplicate and order, wrong owner, source/current identity revocation, connection revoke during fetch/write, unsupported version, exclusions, incomplete artifacts and restart.
- [ ] Observe missing class/routes fail, then implement bounded trusted transport and connection storage. Configuration exposes only safe labels and approved session IDs to the owner.
- [ ] Connect native host and native authenticated storage routes; preserve CSRF and selected space checks. Probe version before and after fetching selected message, with no lock over network I/O.
- [ ] Run focused isolated DB suites and existing collector/storage regressions; commit.

### Task 2: Explicit collection UI and evidence

**Files:** new `src/operational/ToolCollectorPanel.tsx`, meaningful interaction test; modify `src/operational/App.tsx` and relevant docs.

- [ ] Add test for explicit approved connection/session/message selection, collection response and unsupported configuration; verify failure before adding panel.
- [ ] Show configured connection status, explicit artifact/tool-output selection and revoke, without credentials or raw payload input. Read-only default status explains unavailable host.
- [ ] Run `npm run check`, actual DB suites and capture1440/390. Update CURRENT_STATUS, HANDOFF, MISTAKE_LOG and fixtures README honestly, then commit for independent review.

## Environment ruling

The currently resolved `/opt/homebrew/bin/opencode` package is1.15.0; `--version` produced no version in this environment. It is not the recorded2.2.2 fixture installation. No existing personal sessions are inspected. Fixture/loopback verification and installation acceptance remain distinct. The approved2.2.2 host/version-probe configuration must be supplied and verified by its operator; default is unavailable.
