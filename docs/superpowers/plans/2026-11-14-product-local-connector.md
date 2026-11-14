# Native local connector and dependent proposals implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task with TDD.

**Goal:** Verify the portable connector against the actual authenticated runtime and submit selected personal revisions as one dependent proposal.
**Architecture:** Reuse native /api/v1/connector, AgentService, scoped access credentials and common publication. Add an explicit optional `propose-batch` action without changing existing single-page DTOs or broadening PAT scopes. Client CLI/MCP use the same connected-only engine.
**Tech Stack:** TypeScript/PostgreSQL native server, portable Node ESM connector, Vitest/node:test.
**Spec:** docs/superpowers/specs/2026-11-14-product-completion-design.md P8; docs/KNOWLEDGE_INTEGRATION.md; ADR004 remains proposed.

## Global Constraints
- Isolated feat/product-local-connector-20261114 at7630618(P9 erasure). Main stays latest/clean.
- Preserve251requirements/old migrations; CORE-009 and KI-01~07 evidence is bounded, not full semantic/operational acceptance.
- Copy authorization is explicit local.copy plus current source policy, not read permission. Existing akh_sk read/write PATs remain insufficient; use scoped akh_ access credentials bound to actual workspace/principal.
- `personal` is a connector display namespace; server authority remains ctx.workspaceId/principalId. Same-ID cross-space collision fails explicitly; no silently overwritten draft.
- No background daemon after client close, no source/attachment/fullhistory replication. No real company data/token/SSO/model effects.
- New action is additive: `{action:'propose-batch',input:{id,targetSpaceId,selections:[{pageId,baseVersion,personalVersion}]}}`,1..20 distinct pages. Selected revisions must still be current and synchronized; changed revisions fail, never replace chosen content silently. Existing single-page action is unchanged.
- One batch goes through normal source/provenance/dependency/currentACL/independentapproval. No client-supplied authority or automatic publication.

## Review Focus
- Native credentials/current source copy policy and credential revocation must gate cached data and both mutation commit/replay (Task1/2).
- Same page IDs in different workspaces must not mix ownership/upstream or silently replace drafts (Task2).
- Response-loss retries and same key/different revision tuples must not duplicate a proposal or bypass selected-revision identity (Task1).
- Multi-device conflicts retain base/local/remote; close stops outbound sync, reopen resumes without pretending network failure is success (Task2 existing plus actual native integration).
- Multi-page dependencies and publication baseline changes must remain atomic, with no source-ID forgery or old approval reuse (Task1).

### Task 1: Native authenticated batch proposal
**Files:**server/agents/service.ts,http.ts; create server/agents/native-connector.test.ts.
**Interfaces:**Add additive `propose-batch` request; internal proposeChange commit guard may receive the created result so a personal-batch idempotency record and normal proposal record commit atomically. Outer operation stores exact selection fingerprint and current resource bindings. Reuse existing data tables and P9 fences.
- [ ] Build real native HTTP handler + actual scoped akh_ credential + local-copy source policy and DB fixture. Assert existing snapshot/push works, then `propose-batch` two pages fails before implementation. Both content updates must appear in one pending batch; no publication/approval.
- [ ] Run `node scripts/test-server.mjs server/agents/native-connector.test.ts`. Expected new action rejected400.
- [ ] Add strict action/input and single server service preparation of all selected current personal revisions; gather common raw source refs, preserve title/content/links semantics, call common propose once. Before commit recheck each current revision/local copy/ACL; store exact-input idempotency result in same transaction. Cached retry still checks personal.sync/local.copy/current access. Different selection same key409, stale current revision409, source forgery/policy revoked fails.
- [ ] Run native tests plus existing agents/connector tests and P9 product-erasure tests. Expected all PASS, real DB no skips. Include two-page baseline changed after proposal blocks whole publication.
- [ ] Commit server and tests.

### Task 2: Portable client and host documentation
**Files:**scripts/wiki-connector/client.mjs,cli.mjs,mcp.mjs and corresponding tests; native-connector.test.ts; docs/LOCAL_WIKI.md,KNOWLEDGE_INTEGRATION.md,AGENT_HANDOFF.md,MISTAKE_LOG.md.
**Interfaces:**client.proposeBatch(input) captures explicitly selected revisions before authorization refresh and rejects unsynced/conflicted/stale pages; CLI `propose-batch file.json`; MCP `wiki_propose_batch` with exact server schema. Synthetic development backend refuses optional batch feature explicitly, no fake success.
- [ ] Real Node/HTTP client test missing proposeBatch method RED; native two clients test personal edits/sync/conflict, selected two-page proposal retry, revocation/current copy prohibition, spoofed source, separateworkspace binding and close/reopen lifecycle. Verify actual bodies and DB batches, not only mocked requests.
- [ ] Run targeted Node/native tests. Expected missing client method/tool then implement supported method and CLI/MCP entries; keep all existing tools backward compatible.
- [ ] Run `npm run check` plus native/agents/access/P9 regressions. Expected frontend/Node/import/requirements251/servertypes/build/smoke and DB allpass.
- [ ] Document operational-server endpoint, exact required scopes/current local-copy policy, real/principal vsdisplay IDs, additive DTO, dependent batch/rerun semantics, actual evidence and remaining realhost/SSO/install acceptance. Update failure log and NorthStar distinction: synchronization is transport/edits, not knowledge synthesis or independent proof.
- [ ] Commit, fresh whole-branch independent review, verifiedImportantfixes, separate PR based on feat/product-lifecycle-20261114. No merge.
