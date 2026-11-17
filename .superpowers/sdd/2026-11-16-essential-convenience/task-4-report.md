# Task 4 report — personal Home / My Tasks

Status: **DONE_WITH_CONCERNS** (local implementation and required verification complete; independent review, exact-head CI and PR/main integration are controller work).

## Ownership and commits

- Authorized native isolated worktree: `/Users/wt.jeong/.codex/worktrees/9cab/agent-knowledge-hub`.
- Branch: `feat/convenience-home-tasks-20261117`; base `0def475457b54d50b38c2b61655e1987234da8f3` (merged C6 PR71).
- Feature/evidence commit: **cb0d42f2e8ffcd7a115db3b3e3b505a9efa94fdb** — `feat: add wiki home and personal work queue`.
- This report/packaging metadata is committed separately after that concrete feature SHA is assigned; the final handoff provides both SHAs. Terminal logs have only trailing whitespace/EOF blank lines normalized; failures, results and content are retained and the final manifest hashes these normalized transcripts.
- Root checkout remained clean `main...origin/main`. No helper agents/reviewers, push, PR or merge were used. Parent PostgreSQL container was retained.

## Result and requirement mapping

UXC-05 maps to unchanged UX-001/003/004, REV-001/002 and SRH-009. The existing251 requirements/acceptance criteria/classifications, North Star, schema and migration142 were not altered.

| Contract | Implementation and proof |
| --- | --- |
| Personal default landing, explicit operations destination | Empty legacy hash now selects Home; known and unknown legacy hash behavior retains explicit `#overview`. App loads identity/space navigation for personal landing, independently of legacy pages/sources/member/jobs/model aggregates. Unloaded operations chrome/counts are absent on Home/My Tasks. Navigation/Overview regression and fullcheck pass. |
| Document lists without recording visits | Recent/favorites reuse PersonalLibraryService and current source/ancestor ACL. Home never opens a document body to authorize a card. Native personalSnapshot and actual `workflow_activity.kind=recent` stay empty until actual editor document open. |
| Own drafts, own review/disclosure/access requests | Optional canonical drafts paging filters owner before candidate read and retains current/history/source/parent checks. Governance own requests scan only authenticated author's batch/disclosure candidates; canonical exact detail/current disclosure checks precede metadata DTO. Own access feed exposes decision metadata only, with no hidden target titles/IDs. |
| Revisions, permitted and assigned reviews | Own rejected review-feedback and disclosure requests populate revisions. Canonical governance reviewer qualification, changeset.approve, current source/full input lineage and publication requirements are reused. Assigned/stale flags remain separate from current permission. No generic foreign draft read was added. |
| Own failed work, precise resume | Existing JobService own scope plus failure/retry-state filter and readable input-envelope checks. Exact review/job/access targets use existing tasks targetKind/targetId routes. Every draft uses compose&draft; exact own page-bound drafts delegate to the existing WorkflowPanel initialDraftId editor, preserving original base/CAS/autosave/recovery. No first-item/first-page fallback. |
| Empty, error, retry and cursor | Widgets expose ready/error, items and nextCursor, plus truthful partial for hidden scan segments. Independent canonical transactions prevent one aborted widget transaction from poisoning siblings. Real unavailable access/disclosure tables remain local; shared authority/source/erasure failure stays failclosed. Individual UI retry calls only its widget. |
| Current identity, keyboard and workflow state | API/actor/space/capability keyed sessions discard late responses. Existing unsaved navigation guards remain. Current-DOM heading fallback preserves keyboard intent and never steals deliberate outside focus.25 items remain in each native scrolling list; Tab reaches offscreen last item, true Next and then another widget. Reading never approves, publishes or completes work; access, disclosure and knowledge approval have distinct stage labels. |

## Files

Feature code/tests:

- `server/convenience/home.ts`, `home.test.ts`, `home-http.test.ts`, `http.ts`.
- `server/runtime/http.ts`, `server/jobs/service.ts`.
- `server/workflows/service.ts`, `governance/service.ts`, `manual-disclosure.ts`.
- `src/operational/convenience/Home.tsx`, `Home.css`, `MyTasks.tsx`, `home.test.tsx`, `DocumentComposer.tsx`, `Navigation.test.tsx`.
- `src/operational/App.tsx`, `console.ts`, `console.test.ts`, `workflows.tsx`.
- `docs/AGENT_HANDOFF.md`, `docs/MISTAKE_LOG.md`, `docs/superpowers/plans/2026-11-16-essential-convenience.md`.
- `docs/ui-validation/2026-11-17-personal-home/` contains three harnesses,44 PNG, browser-results, cleanup, README and source-manifest. This report and scoped c4 logs are explicitly committed from ignored `.superpowers` paths; existing c4-baseline/brief/constraints are not changed/staged.

**Planned Overview.tsx no-hunk exception:** controller explicitly accepted preserving its existing component and URL. The actual default/operations split lives in App/console, so a cosmetic Overview hunk would not implement additional behavior. The plan and handoff record this exception. No required widget was dropped.

## Rulings: what, why and cost

1. **Canonical own feeds and optional paging:** queue.triage/admin aggregates cannot supply personal Home. Small owner-scoped feeds and25/26-candidate paging extend existing canonical services; old exhaustive draft/review DTOs keep their exact shape unless paging was explicitly requested. Cost: additional server-only method/options, without migration or parallel task/permission engine.
2. **Disclosure is an existing request stage:** own C6 disclosure metadata appears inside own requests/revisions with exact compose&draft resume. Pending/approved/submitted disclosure is distinguished from knowledge review and publication. Cost: one bounded union feed and canonical snapshot/current checks internally; bodies never enter Home DTOs.
3. **All own drafts resume through one route/editor:** the approved compose&draft route resolves the exact own ID. Page-less drafts retain C6 Composer; page-bound drafts delegate to WorkflowPanel with initialPageId/initialDraftId and a fresh canonical own list/detail. Cost: narrow resolver/editor prop extension, with revoked-cache and capability-generation preservation.
4. **Reuse cursor infrastructure, isolate feed outages:** C6 authenticated encryption and SQL revision helper are reused. Default private-data selection is still all for C6. Home chooses only fixed server-owned feed dependencies while retaining every common authority/source/erasure table. No request accepts table names. Real access/disclosure table outage leaves unrelated widgets ready, and relevant data/authority changes invalidate cursors. Cost: conservative per-feed digest scans still scale with DB tables; this is bounded item authorization/output, not bounded end-to-end DB scan complexity.
5. **Independent personal bootstrap and existing operations destination:** Home/My Tasks do not depend on unrelated administrative aggregates, and do not show false unloaded operational counts. Explicit #overview and existing exact panel routes remain. Cost: separate personal bootstrap branch inside App; broader App session refactor is outside this feature.
6. **Home-only native nested scrolling:** visual QA found25 rows stretching sibling cards to several thousand pixels. Home-specific CSS aligns cards to start and limits list height, preserving25 DOM items, links and true cursor. Cost: nested scrolling; actual Chromium Tab/scroll/continuation/no-trap proof exists in all4 configurations. Shared grid behavior was not changed.

## RED and GREEN evidence

All paths below are under `.superpowers/sdd/2026-11-16-essential-convenience/logs/`. Expected missing-feature RED is separated from fixture/setup and product regression failures in MISTAKE_LOG. Initial missing-service/component RED used production base0def475; intermediate production snapshots were not individually hashed. Final production/harness/artifact/log SHA binding is complete below; this is not a claim that RED snapshots have the final hash.

| Evidence | Actual result / exit |
| --- | --- |
| c4-red-server.log |4 native failures because HomeService is absent; exit1. |
| c4-red-ui.log |2 client failures because Home is absent; exit1. |
| c4-red-disclosure.log |4 pass/1 fail: own disclosure missing from requests; exit1. |
| c4-red-page-resume.log |2 pass/1 fail: exact older page-bound body absent; exit1. |
| c4-red-keyboard.log |4 pass/1 fail: removed focused row falls to body; exit1. |
| c4-red-stage-label.log |5 pass/1 fail: access approval stage missing; exit1. |
| c4-red-aggregate-chrome.log |32 pass/1 fail: unloaded operations aggregate chrome appears on Home; exit1. |
| c4-red-table-isolation.log |9 pass/1 fail: actual missing own-access table42P01 escapes whole Home; exit1. |
| c4-red-http.log |Controlled temporary adapter removal yields404 instead of200; child test runner exit1, restoration wrapper exit0. |
| c4-green-resume-2.log |C6 composer18 + Home3 =21 client tests pass; exit0, including revoked requested-draft cache regression. |
| c4-final-native-corrected.log |Home8/governance14/workflows36 =58 pass; exit0 after default DTO and overlap-fixture corrections. Home8 later superseded by Home10. |
| c4-final-isolation-native.log |**Current final backend:** Home10/HTTP1/C6 manual9/new-document30 =4 files50 pass; exit0. Covers real per-feed table outage, common authority outage, relevant-change invalidation and C6 cursor/default compatibility. Later frontend-only CSS did not modify backend bytes. |
| c4-final-check.log |**Final complete check:** frontend436/Node48/import16/evaluation41/requirements251/server types/build/static HTTP smoke; exit0 on final Home scrolling bytes. Existing large-chunk warning remains. |
| c4-final-browser.log |**Final capture:**1440 light/dark and390 light/dark all pass; exit0,44 PNG and unchanged canonical API responses. |

Native carry accounting is explicit: governance14 + workflows36 from corrected evidence, and collaboration inbox21 + personal7 + personal HTTP4 + jobs48 from preceding green files = **6 carried files130**. With current4 files50 this is **10 unique files180**, **not one final180-test execution**. `c4-final-native.log` contains the earlier148-test selection with2 failures (strict legacy DTO and invalid overlapping fixture), both identified and corrected; its failures are not hidden as a green batch. Pre-isolation/pre-scroll browser runs are superseded by the final44-state capture.

## Final source and UI binding

- Complete production fingerprint: `2339ac55d3eb86a5d3c9d5a4915d0031fe9143276a59a235acbc729599d43f98`.
- Source manifest SHA256: `877d910cbf39b7a6182307202ecf72eb69de860322b4c1026d70324a95d667d9`.
- Manifest binds **322 production paths**, **3 harness paths**, **46 artifacts** (44 PNG + browser-results + cleanup) and **33 scoped logs**. Individual hashes are in `docs/ui-validation/2026-11-17-personal-home/source-manifest.json`.
- Fresh final backend4394 start: `2026-11-17T12:07:54.716Z`. Fresh final frontend5194 start: `2026-11-17T12:07:56.347Z`. Capture asserts backend/frontend/current complete production fingerprint equality.
- Native harness: macOS Node24.22.2, PostgreSQL17, scripts/test-server.mjs one UUID-owned DB per selected file. Parent container `akh-convenience-test-20261117` port32769 remains.
- Browser: Chromium158 headless, Asia/Seoul;1440×1000 and390×844, each light/dark. Explicit synthetic loopback actor adapter, current canonical HTTP/service/ACL; no production IdP, fabricated successful DTO or model invocation.
- Loading holds delivery of an actual completed backend response. Empty uses a genuinely empty personal space. Partial-error temporarily renames only the owned DB's access-request table. Other25 drafts and2 requests remain visible, and retry requests only accessRequests after restoration.
- Home reads initially create no recent entry; an actual document editor open does. Older d27 is reached after25-row continuation and Enter, exact page-less ID also resumes. Other-owner ID is denied; current source ACL removes cards; keyboard fallback/outside intent and fresh actor-owned rows are verified. Same-component stale API/account/space responses are additionally covered by client regression, not falsely described as an OS session test.
- Visual inspection opened final compact1440-dark Home and390-light keyboard-bottom screenshots; controller independently inspected final Home/partial-error evidence.

## Cleanup

`cleanup.json` records0 owned databases,0 owned profiles, ports4394/5194 free,0 orphan browser processes and parent PostgreSQL alive. Runtime shutdown drops only `akh_c4_test_ui_` databases; profiles use only `akh_c4_profile_`. No global Docker/Chrome kill or parent container shutdown occurred. Root main remained clean. Temporary fixture/browser diagnostics are synthetic; failure DOM is preserved in c4-browser-attempt-4/5 logs.

## Mistakes and self-review

- Product regressions actually found: unconditional continuation changed old DTO; invalid route rendered Home; exact resolver skipped revoked-cache cleanup; disabled focus fallback lost keyboard position; broad cursor digest coupled widget-table outage; shared stretch made sparse cards extremely tall. Each has a retained regression or actual visual/browser proof and a scoped repair.
- Packaging mistake: retained raw terminal logs triggered cached diff whitespace warnings, but the shell continued to the feature commit. Only trailing whitespace/blank EOF was normalized afterward; substantive failure/result bytes were retained, manifest/report SHA refreshed, and final diff/manifest gates run with checked exit status. No product/source/test/capture rerun was needed.
- Fixture/tool mistakes: omitted DB/reviewer environment, fake scoped credential admitted to a canonical authorizer, overlapping approved proposal, globally keyed request ID reused across spaces, navigation evaluate/route-disposal race, exact wrapping-label lookup and wrong recent kind. They are recorded separately, with failed logs retained where available; no permission/domain rule was weakened to make fixtures pass. Local string-patch formatting assumptions failed twice and were checked/corrected before continued work.
- Own vs other, current ACL/source/parent/history, capability downgrade, assigned vs permitted review, exact IDs beyond25, precise target links, real transaction/table failure, relevant cursor invalidation, approval-not-publication and no visit/mutation from read are covered. Native cursor crypto/default C6 behavior and backward-compatible ordinary draft DTO are retained.
- No SQL migration, new model/provider call, role-name permission inference, admin aggregate download, foreign private-draft grant, fake task completion or North Star/251 requirement reduction was introduced.

## Remaining concerns and evaluation limits

- C6 process-local cursor keys expire on restart/instance switch; no multi-instance cursor continuity is claimed. Conservative shared/per-feed SQL digest scans and existing personal-library10,000 cap remain; large DB/production load is unmeasured.
- Existing WorkflowPanel wrapping label includes initial textarea content. Harness uses a unique label prefix plus exact body/id/CAS assertions. This inherited accessible-name issue is disclosed; Chromium keyboard proof is not OS/assistive-tech certification.
- Existing Vite629/1499kB chunk warnings remain. Real IdP, production operational/security acceptance, screen readers/OS IME and live corporate data are not validated here.
- North Star contribution is navigability back to current drafts, evidence-aware review and failures in the human review→publication loop. Home read does not alter knowledge/evidence/approvals/publication. Better knowledge quality/downstream agent performance remains a goal until EVALUATION controlled comparisons; no such effect is claimed.
- C6 prerequisite completion was controller-verified: PR71/main0def475/final1bd418a/CI44068230799 all8. Plan/handoff now reflect that completion; C4 remains local verification pending independent review, exact-head CI and merge. No further discretionary product polishing is included.
