# Acceptance Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans or subagent-driven-development. This is a required continuation of `2026-10-30-complete-operational-workflows.md`, not a reason to stop after another partial PR.

**Goal:** Close actual required software acceptance gaps identified by independent source comparison, preserving the original251 acceptance texts and separately reporting site approval/effect evaluation.
**Architecture:** Retain canonical access/provenance/publication and the released imports/dashboard. Add focused policy, identity, document-governance, collaboration, search and question services over the same PostgreSQL transactions, mandatory authorizer and durable queue. Keep all model transmissions on guarded execution paths.
**Tech Stack:** Existing Node24/TypeScript/React/PostgreSQL/MCP/Kustomize/Keycloak.
**Spec:** `docs/requirements/requirements.json`, `docs/requirements/core-requirements.json`, `docs/LLM_WIKI_CORE.md`, `docs/ACCESS_CONTROL.md`, `docs/EVALUATION.md`; the original continuation plan remains binding.

## Global Constraints
- User explicitly requires all remaining implementation, validation, PR and authorized merge without new scope questions. Missing software stays active, never renamed a site-only blocker.
- Preserve main PR12 actual imports/Organization/Team access and PR16 console/preview. Finish that merge and migration009–014 compatibility before changing shared integration points.
- Caller identity is server-derived. Business owner, namespace Owner, reviewer, proposer and service sponsor remain distinct.
- Complete current input ancestry, current rights, original-source immutability, independent human approval, fencing and idempotency remain mandatory. A configured model URL/read permission is not a resource transmission approval.
- No plaintext credentials in clients, logs, project evidence or command arguments. Unknown/unexecuted/error/partial states never become zero or success.
- Company/guest/anonymous expansion stays explicitly disabled unless its separate optional policy is implemented and authorized. Do not misclassify this optional default-off behavior as absence of personal/team spaces.

## Review Focus
- A still-admitted user removed from just one bound IdP group loses that group's path, without reviving manually revoked grants.
- Every model/embedding/conversion/semantic path rechecks destination and full source policy immediately before transmission; direct URLs/MCP/schedules cannot bypass feature disable.
- Autosave recovery and conversational reuse never restore protected old content after source/identity/space revocation; local-copy prohibition remains binding.
- Partial decisions/restores preserve dependency closure and explain conflicts instead of silently overwriting later human edits.
- Digest/alert/review jobs resolve current recipients/resource access immediately before delivery and use durable dedupe, timezone and quiet-hour rules.

## Audit checkpoint

Read-only audit used workingHEAD `da576e5` and `origin/main=cba1e8f`, including upstream source through git show. It did NOT execute tests or accept requirements. Existing `operational-backlog.json` software_missing247 is an obsolete baseline count, not this implementation's current result.

| Gap | Required IDs | Missing acceptance behavior |
|---|---|---|
| Source model policy | SEC-011 | Resource/classification/destination checks, not only global transmission flag |
| Business ownership | GOV-005 | Inactive-owner handoff queue and outstanding work |
| Directory groups | IAM-006 | Verified external group bindings, bounded freshness/removal |
| Required metadata | EDT-005 | Per-type required-property warn/block at publication |
| Shared feature gates | GOV-007, OPS-005 | Disable enforced across UI/REST/MCP/workers/schedules |
| Session management | IAM-004 | Session listing/revoke/global logout/idle expiry |
| Emergency access | IAM-008 | Reason/independent temporary authorization/expiry/audit |
| Access decisions | ACL-011 | Owner inbox, approve/reject, source upper-bound checks/history |
| Review work assignment | CLB-003 | Per-changeset assignee/deadline/absence/reassignment |
| User digest delivery | CLB-006/007 | Actual preference-consuming durable worker, no-change suppression/quiet hours |
| Content retention | VER-012 | Draft/publication/source lifetime rules and evidence dependency preservation |
| Metadata versions | VER-001 | Immutable properties/environment/lifecycle snapshots and comparison |
| Dependent restoration | VER-008 | Bundle analysis, later-human-change conflicts, selective reviewed restore |
| Partial decisions | REV-007 | Per-document reasons and dependency-safe selected changesets |
| Draft recovery | EDT-002 | Autosave and permitted pre-transmission recovery/offline conflict handling |
| Actual diff | VER-004 | Arbitrary version selection, additions/deletions/property/location changes |
| Anchor evolution | SHR-002, VER-010 | Stable paragraph identity and moved/deleted/changed status (existing pinned links remain) |
| Scoped/historical search | SRH-002/004 | Combined type/owner/tag/status/review/time filters and actual historical versions |
| Conversations | QNA-005 | Durable threads/turns and each-turn current input reselection |
| Answer feedback | QNA-008 | Exact answer/version/used-document/assigned-reviewer report routing |
| Tool/project authority | COL-005/008 | Verified session-to-project binding and server-side project exclusions |
| Monitoring dispatch | OPS-007 | Host schedule/config/delivery wiring, not just adapter existence |
| Operational controls | OPS-012, LIF-005 | Actual configured audit/archive/deletion targets and admin bootstrap wiring |
| Trace correlation | OPS-006 | Request→job→model/domain/audit persisted correlation |
| Review deadlines | LIF-002 | Type cadence, due work, owner notification, overdue-not-false status |

## Task A: Shared transmission and feature policy
**Files:** `server/policy/{model,features,http,policy.test}.ts`; additive migration100+; common runtime/MCP/queue/import/semantic transmission boundaries; Korean policy UI.
**Interfaces:** Mandatory `assertModelTransmission(db,ctx,{destinationId,purpose,pageIds,sourceIds}):Promise<void>` over complete ancestry; `assertFeature(db,ctx,feature,resource?):Promise<void>`. Both fail closed. Policy changes bump pinned epochs and invalidate relevant approvals/jobs.
- [ ] Add failure-first actual DB/HTTP tests for source-denied but globally enabled model, changed destination, classification/ancestry denial, and disabled direct REST/MCP/schedule execution.
- [ ] Observe RED at actual transmission/effect boundary, not source-string checks.
- [ ] Implement versioned, explicit policies and exact destination registry/actor controls; UI never creates approval from untrusted material. No unsupported path may silently fall back.
- [ ] Run domain/integration, all server tests, npmcheck; inspect provider fixture received0 protected requests on denial.
- [ ] Commit owned implementation and record exact IDs/evidence/current limitations.

## Task B: Directory/session/emergency identity operations
**Files:** `server/identity/`, current auth/access adapters, additive migrations, actual account UI.
**Interfaces:** Verified `syncDirectoryMemberships(db,authorityProof)` never re-enables manual denies; `sessions(ctx)/revokeSession(ctx,id)/logoutAll(ctx)`; idle/absolute expiry both asserted; temporary emergency authorization has immutable reason/approver/scope/expiry and a non-renewing ceiling.
- [ ] RED: user remains in admission group but loses mapped access group; revoked manual grant stays revoked; session/idle/global revocation stops active effects; emergency expired/self-approved access denied.
- [ ] Implement same canonical checks for all consumers and distinguish external directory source from product groups and platform roles.
- [ ] Supply actual local provider fixtures and configurable approved production authority; no fake current status from old login.
- [ ] Run actual IdP/DB/session and original security regressions plus npmcheck.
- [ ] Commit and update handoff without claiming company approval.

## Task C: Document governance, work routing and access requests
**Files:** `server/workflows/governance/`, publication validation, document/access/review workbench, additive migrations.
**Interfaces:** `assignBusinessOwner(ctx,pageId,expectedRevision,owner)` validates responsibility without granting access; `publicationRequirements(db,ctx,updates)` yields warnings/blockers; access/review decisions are revision-checked events, never role promotion shortcuts.
- [ ] RED tests: missing required property blocks/warns by type; disabled business owner creates handoff work; no self/admin inferred ownership; access request rejected/approved with exact current source upper bounds/history; individual review reassignment retains qualification and stale approval invalidation.
- [ ] Implement actual inbox, delegation/absence/deadline and decisions; successful request submission alone is not authorization.
- [ ] Persist assignments/reasons/deadlines independently from reviewer eligibility.
- [ ] Run DB/HTTP/UI regression and npmcheck.
- [ ] Commit and record acceptance links.

## Task D: Full metadata history, diff and dependency-safe decisions/restoration
**Files:** version metadata storage/publication, `server/workflows/versions/`, diff/restore/review UI.
**Interfaces:** Immutable version snapshot includes body/evidence/properties/environment/parent/lifecycle; `compareVersions(ctx,pageId,from,to)`; `previewRestore(ctx,batchId,selection)` and `proposeRestoreSelection(ctx,previewHash,reason)` use exact current bases; partial decision creates a dependency-closed reviewed batch.
- [ ] RED: later human edit survives selected restore; selected subset with broken dependency denied; arbitrary code/table/move/property diff shows additions/deletions and fixed positions.
- [ ] Implement immutable snapshots and stable paragraph anchors with moved/changed/deleted state; never attach old comments to unrelated new paragraphs.
- [ ] Restore only through new versions/current ACLs; versions never restore historical readers.
- [ ] Verify eight-document dependency fixture, actual HTTP/UI and full regression.
- [ ] Commit with traceable evidence.

## Task E: Autosave/recovery and lifetime retention
**Files:** draft client/repository recovery, retention policy services/workers, UI and additive migrations.
**Interfaces:** Revision-CAS autosave, explicit pending/conflict/error states, recovery storage bound to current identity+space+source lineage and allowed local-copy policy; retention preview preserves all evidence needed by retained publications and legal holds.
- [ ] RED: disconnect/restart recovers permitted unsent input, conflict preserves both, denied local-copy/revocation cannot resurrect cached protected text.
- [ ] Implement bounded recovery without putting secrets/roles into localStorage or pretending complete offline authorization.
- [ ] RED retention tests preserve referenced originals/history, distinguish drafts/versions/sources, and expose actual blocked/completed receipts.
- [ ] Run restart/permission/browser/DB retention regression and npmcheck.
- [ ] Commit and document offline/retention boundaries honestly.

## Task F: User collaboration delivery and due review work
**Files:** collaboration notification scheduler/outbox/delivery adapters, workflow preferences/inbox/UI.
**Interfaces:** Durable `prepareDigest/runDigest` consumes actual preference timezone/quiet hours; immutable event key+current recipient ACL; type review cadence creates due work without marking knowledge false.
- [ ] RED: no-change cycle sends0 messages; DST/quiet-hours follow actual configuration; recipient/source revoked while delivery waits sends0 protected bytes; inactive owner routes to explicit backup.
- [ ] Implement actual dispatch, ack/retry/dedupe, per-user opt-out and review deadline state/work.
- [ ] Distinguish operations alerts from user digests, queue acceptance from delivery, and unconfigured relay from success.
- [ ] Run actual local TLS relay/DB/restart plus UI/full regressions.
- [ ] Commit with current delivery evidence, not imaginary company receiver approval.

## Task G: Conversations, answer feedback and scoped historical search
**Files:** `server/questions/`, search service/agent contract, question/search UI and additive migrations.
**Interfaces:** Thread/turn immutable IDs; each new turn resolves current permitted inputs and transmission policy afresh; `reportAnswer(ctx,{answerId,version,reason,...})` binds exact source versions and reviewer work. `search(ctx,filters,cursor)` fixes query scope/time and applies current ACL even to historical versions.
- [ ] RED: follow-up cannot resend revoked earlier context; answer feedback routes correct fixed version/owner; combined filters and pagination retain scope; historical result explicitly not current recommendation.
- [ ] Implement complete body/metadata filters and actual old-version lookup, not current version under an include_history label.
- [ ] Preserve existing safe answer readback and outcome→refinement loop; never treat feedback as independent execution evidence.
- [ ] Run actual HTTP/MCP/thread/history/ACL/UI regression and npmcheck.
- [ ] Commit and record acceptance links.

## Task H: Collector project authority, observability wiring and final closure
**Files:** collector session/project authority and exclusions; actual runtime monitoring/backup/retention/audit/deletion scheduling/targets; request/job/model correlation; CI and251-row evidence report.
**Interfaces:** Tool session/project proof is server-verified, not a request label; every request ID links persistent job/stage/model/audit; all administrative actions use configured guarded services, not arbitrary SQL/browser secrets.
- [ ] RED: forged project/session mapping and excluded projects produce0 collected source bytes; trace lookup follows exact request→job→model/domain chain.
- [ ] Wire actual monitor/delivery/backup/retention/audit targets and safe admin UI; preserve all released import raw/derived caches in erasure/recovery graph.
- [ ] Finish original continuation Tasks7/8: real kind/Keycloak/model/Pod restart/10-user mixed load/390+1440 keyboard verification, independent security review, final-head CI.
- [ ] Update every original acceptance row with executed evidence or genuine external decision/site-only limitation. Any missing required software keeps this plan active.
- [ ] PR/push/authorized merge only after final gates; do not terminate on an intermediate commit or merged partial PR.

## Self-review
- Original251 criteria and all audit gaps are assigned above; Company/guest/anonymous default-off remain optional, not secretly deleted requirements.
- Shared boundaries: A applies before B/G/F/H network/effects; B identity guards every package; C owners/type policies feed D/F; D snapshots feed E/G; F/H share durable outbox but not receiver policy; all retain canonical authorization and current ancestry.
- Execution continues under the already authorized method; no new scope/PR/merge confirmation is requested from the user.
