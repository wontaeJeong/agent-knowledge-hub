# Complete Operational Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use subagent-driven-development or executing-plans. Do not treat an incremental PR merge as completing this plan.

**Goal:** Implement the remaining software in all 251 requirements and the current access-control contract, not another foundation-only slice.
**Architecture:** Keep the reviewed PostgreSQL/provenance/publication/OIDC engine; add space-scoped policy, operational workflow services, durable jobs, scoped agent interfaces and the UI over the same services. kind is the local integration environment; company-specific approvals/infrastructure are separately tracked, not substitutes for missing code.
**Tech Stack:** Node24/TypeScript/React/PostgreSQL/Kustomize/Keycloak.
**Spec:** existing `2026-10-29-operational-platform-design.md`, `docs/requirements/operational-backlog.json`, `docs/ACCESS_CONTROL.md`/ADR005 (proposal implementation, not automatic product-policy approval).

## Global constraints
- User explicitly requires the entire implementation and PR+merge; no more scope or execution questions, no partial-stop after a tranche.
- Existing landing page `/` and app `/?app=1` from latest main must remain. Existing personal connector is connection-bound, never an always-on local daemon.
- Current full-input provenance, schema/checksum startup gate, session/IdP revalidation, raw-source immutability, independent review and atomic/idempotent publication remain binding.
- No reviewer→Admin/Owner promotion. New ownership bootstrap must explicitly name verified subjects. Unknown legacy ownership stays quarantined.
- Original 251 acceptance texts remain unchanged. Implemented software, fixture regression and actual company acceptance remain distinct.

## Review focus
- Revoked grants must not reappear on OIDC login; scope tokens and personal spaces never grant another space's access.
- Self/service approval, stale reviewer qualification and permission changes during publication fail closed.
- Private drafts/blobs/comments/notifications/history/search/export obey current input ancestry and resource policy.
- Restarted/leased/retried jobs preserve exactly-once publication and cancellation/budget limits.
- Files/URLs/model output cannot acquire execution/network/visibility rights or forge independent evidence.

### Task 1: Space ownership, roles, review policies and credentials
**Files:** `server/access/`, additive migrations006+, auth/core/publication/http integration and real DB regression.
**Interfaces:** trusted `Context` stays workspace(space)+principal; optional credential/authorization guard is server-only. `/api/v1/spaces` list/create/select via `X-Space-Id`, `/teams`, `/groups`, `/access`, `/review-policy`, `/credentials` use authenticated identity, never caller roles. Produce `authorizeAction(pool,ctx,action,resource?)` and capability DTO consumed by other tasks.
- [ ] RED tests for personal isolation, default-none team membership, direct/group roles, no reviewer auto-admin, last-owner transfer, invitations, token scope/expiry/revocation, independent designated human review and revoked OIDC binding.
- [ ] Implement common policy and explicit legacy migration/bootstrap; retain complete provenance and publication transactions.
- [ ] GREEN targeted/full DB tests and types/build; independent review/fix; commit.

### Task 2: Knowledge authoring, collaboration and lifecycle
**Files:** `server/workflows/`, additive migrations, runtime extension router; matching operational UI.
**Interfaces:** Task1 authorization on every operation. Draft/revision CAS, page edit/restore proposals, template/tree/property/protection, changeset revise/withdraw/reviewer assignment, shares, comments/mentions/subscriptions/notifications, favorites/history, lifecycle/access requests and source correction/withdrawal.
- [ ] Write failure-first real HTTP/DB tests per acceptance, including unchanged live publication until approval and current ACL after restore/deletion/revocation.
- [ ] Implement services and Korean UI with explicit confirmation/diff and25-row pagination.
- [ ] Run domain/server/UI integration and independent review; commit.

### Task 3: Blobs, ingestion, import/export and collection
**Files:** `server/storage/`, collector adapters, runtime routes, deployment PVC/object adapter and UI.
- [ ] RED tests: MIME/size/path/HTML checks, scoped downloads, restricted export/import, source correction/withdrawal and attachment sharing expiry.
- [ ] Implement persistent content-addressed blobs and streaming bounds, immutable snapshots, sandboxed/disabled unsupported conversions and SSRF-safe approved URL collection; actual versioned collector fixtures.
- [ ] Verify real file/HTTP/restart and license/security paths; review/commit.

### Task 4: Durable jobs, schedules, budgets and model telemetry
**Files:** `server/jobs/`, migrations, runtime worker integration, scheduler/manager UI.
- [ ] RED restart/lease/heartbeat/retry/cancel/idempotency/outbox/fairness/budget/timezone tests.
- [ ] Implement DB queue and daily/weekly schedules with scoped execution credentials, preview/protection/emergency stop; exact source/page/policy input versions. Persist actual provider/model/tokens/cost-if-known, never null→0.
- [ ] Verify forced process/Pod restart, model/DB failures and duplicate events; review/commit.

### Task 5: Agent contract and personal connector integration
**Files:** operational MCP, REST context/outcome, personal sync service and connector protocol adapter.
- [ ] RED scoped bearer/service identity, read/context/artifact/propose/outcome and job polling/cancel; private revision/space collision/revocation tests.
- [ ] Implement same authorization/domain services for web/MCP/connector, local-copy policy and bounded context preserving omitted-evidence explanation. No agent approve/publish/admin authority.
- [ ] Real SDK/HTTP/host-version fixture tests and review; commit.

### Task 6: Temporal/claim/experience refinement and continuous evaluation
**Files:** claim/provenance/condition metadata, semantic Lint provider contract, outcome review, evaluation runner/datasets/reports.
- [ ] RED contradictory/superseded/environmental/duplicate/circular evidence and withheld-answer tests.
- [ ] Implement current/point-in-time context, evidence types/locations, failure lessons, human-protected edits, outcome-triggered re-review and three-condition evaluation runner with fixed datasets/independent expected answers.
- [ ] Run structural and actual DeepSeek fixtures separately; do not invent domain approvals/statistical evidence or claim downstream benefit without the contracted experiment.

### Task 7: Operational release gates
**Files:** backup/restore/retention/tombstone orchestration, audit export protection, metrics/alerts, admin runbooks, K8s manifests/scripts.
- [ ] RED DB+blob consistency/restore/delete replay, key rotation, shutdown, resource/capacity/monitoring/alert failure cases.
- [ ] Implement coordinated encrypted off-pod backup/retention/restore, migration/image/rollback gates, privacy retention/admin tools and configured alert adapters.
- [ ] Actual kind deployment,10 distinct user mixed workload, fault/recovery,390/1440 keyboard/browser; review.

### Task 8: Full traceability, PR and merge
- [ ] Map every251 row and AC/KI/KE case to actual implemented endpoints/UI and executed evidence or a concrete external decision/site-only blocker. Missing software must stay in active tasks, not be relabeled external.
- [ ] Full npm check/server/deployment/evaluation/actual browser gates, final independent security review and fixes.
- [ ] PR(s), actual final-head required CI and authorized merge; continue remaining tasks after incremental merges.

## Execution ledger
Track persistent task progress under this plan's `.superpowers/sdd/` workspace. Do not declare plan completion while any implementable software task remains.
