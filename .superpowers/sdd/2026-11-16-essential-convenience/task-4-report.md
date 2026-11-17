# Task 4 report — personal Home / My Tasks

Status: **DONE_WITH_CONCERNS** — F1/F2 are locally repaired and verified in the SAME combined final wave; controller scoped re-review, exact-head CI and PR72 integration remain pending. Current final-wave evidence is471 frontend tests/76 fresh PNG; prior sections are historical.

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

## Initial package source and UI binding (superseded by I1 round below)

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


## I1 fix round1/5 — complete open finding closure

FIX_BASE: `d8dfa94feee7baa904223b724c59f3d2726897ce`. The supplied task review found0 Critical/1 Important/0 new Minor; its complete text is preserved in `c4-i1-task-review.log`. This round addresses that one finding only. The fix commit is the commit containing this section; the concrete SHA is supplied to the controller in the final handoff.

### I1 supplied finding (verbatim)

- **I1 — Represent the default Home with a route that survives serialization, and keep preview's supported landing.** `src/operational/console.ts:89` changes the empty legacy hash to `home`, but `home` is not in the legacy `consoleItems` recognized by the same function. `parseConvenienceLocation` therefore produces `{kind:'console', tab:'home'}` (`src/operational/convenience/route.ts:140`), while `convenienceHref` serializes that value to `#home` (`src/operational/convenience/route.ts:153`); reparsing it returns `overview`. A focused execution on this head produced exactly:

  ```text
  parse('?app=1&space=team', '')
    => {kind:'console', spaceId:'team', tab:'home'}
  convenienceHref(...)
    => /?app=1&space=team#home
  parse(the generated href)
    => {kind:'console', spaceId:'team', tab:'overview'}
  ```

  This affects a real existing flow: OperationalApp's space-change handler preserves `current.tab` for console locations and passes it through `convenienceHref` (`src/operational/App.tsx:178`). Changing space from the new implicit Home consequently writes `#home` and mounts the operations destination in the new space. It violates the new personal default's preservation through navigation and the route codec's meaning-preservation contract.

  The same root change is unconditional across modes. The probe also confirmed `parse('?preview=1','') => {kind:'console',tab:'home'}`. App sets `personalLanding` only for `!preview` (`src/operational/App.tsx:531`) and renders Overview only for `tab === 'overview'` (`src/operational/App.tsx:1109`). Thus the previously supported bare preview URL now selects neither its Overview nor a Home body. This rendering consequence follows directly from the branch conditions; I did not run a new browser session.

  Make the implicit workspace Home a valid, mode-aware route (for example, canonical `section=home`), and preserve a supported preview default. Ensure any resulting console Home value round-trips if it remains part of the codec. Add focused regressions for the generated-href round-trip, default-Home space change, and bare preview rendering; the new navigation test currently checks the initial workspace title and explicit overview link only (`src/operational/convenience/Navigation.test.tsx:712`).

### Verified cause and scoped repair

The reported behavior was reproduced in pure-code and actual App regressions. Initial focused RED was8 failures/86 pass across94 tests; the explicit unsupported-mode guard added a ninth failure across95 tests. These are behavior failures on the fix base, not fixture/import/setup failures.

`readConsoleTab` now receives the rendering mode. The existing `entryMode` helper supplies the route parser's mode, preserving app-over-preview precedence. The canonical implicit workspace Home route has no hash; `convenienceHref` no longer invents legacy #home. A workspace-only implicit Home passed to the preview builder is explicitly rejected rather than serialized into a different meaning. Bare preview parses to its supported Overview. Explicit #overview and old unknown/malformed/#home fallback remain Overview in both modes. No URL key, parallel codec, App navigation engine or backend behavior was added.

The real existing onSpace handler continues preserving current.tab. Because the same codec now serializes/reparses Home correctly, actual selector change remains Home in the new space, without downloading operations aggregates. No additional App production hunk was necessary. Only `src/operational/console.ts` and `src/operational/convenience/route.ts` changed among the322 production manifest paths; the other320 production hashes, including every backend/SQL file, match the pre-fix manifest. Tests changed in console.test.ts, route.test.ts and Navigation.test.tsx. Existing Home/Composer/Overview integration tests were exercised unchanged.

### Exact commands, outputs and evidence

All commands ran in the assigned native isolated worktree with Node24.22.2 on PATH; logs are `.superpowers/sdd/2026-11-16-essential-convenience/logs/`.

| Command / file | Observed output / exit |
| --- | --- |
| `npx vitest run src/operational/convenience/route.test.ts src/operational/console.test.ts src/operational/convenience/Navigation.test.tsx` → c4-i1-red.log |3 files,8 fail/86 pass(94), exit1: generated href drift, preview default, actual Home space selection and bare preview body. |
| Same command after adding unsupported-preview-Home serialization case → c4-i1-red-mode-guard.log |3 files,9 fail/86 pass(95), exit1. |
| `npx vitest run src/operational/convenience/route.test.ts src/operational/console.test.ts src/operational/convenience/Navigation.test.tsx src/operational/convenience/home.test.tsx src/operational/convenience/composer.test.tsx src/operational/Overview.test.tsx` → c4-i1-green-focused.log |6 files121 pass, exit0. |
| `npm run check` → c4-i1-final-check.log |Final447 frontend/48 Node/16 imports/41 evaluation/251 requirements/server types/build/static HTTP smoke, exit0. Run once after settling I1 bytes; inherited large-chunk warning remains. |
| `node docs/ui-validation/2026-11-17-personal-home/manifest.mjs --frontend-start` then `npm run dev -- --host 127.0.0.1 --port 5194 --strictPort` |Fresh frontend source fingerprint recorded; c4-i1-frontend.log records ready5194. |
| `AKH_C4_SYNTHETIC_CAPTURE=1 TEST_DATABASE_URL=<authorized loopback test DB> npx tsx docs/ui-validation/2026-11-17-personal-home/home-runtime.ts` |Fresh owned synthetic runtime4394 ready; c4-i1-runtime.log. No model environment is used. |
| `AKH_C4_SYNTHETIC_CAPTURE=1 TEST_DATABASE_URL=<same loopback test DB> PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-17-personal-home/capture.mjs` → c4-i1-final-browser.log |1440 light/dark and390 light/dark all pass, exit0;13 states per configuration,52 PNG. |
| `node docs/ui-validation/2026-11-17-personal-home/manifest.mjs` and `--verify` |Verified322 production/3 harness/54 artifacts/42 logs. Logs have only line-ending whitespace/EOF normalization; all substantive failures/results remain. |

**Native carry, not a new native run:** no scripts/test-server.mjs/native suite was run in I1 because backend bytes are unchanged. Previous4 files50(Home10/HTTP1/C6 manual9/new-document30) and6 files130(governance14/workflows36/collaboration21/personal7/personal HTTP4/jobs48) are all carried for this round. Unique10 files180 is not a current single-run count. The task review's warning about complete unchanged exact-detail/login and production ACL/retention machinery remains controller cross-task/final-review context; this focused route fix does not claim a new broad audit.

### Fresh source-bound actual UI proof

- Current production fingerprint: `ec5dfbbab8d29cc2e4bdb90e12960f1da6442451c264440cd116279ff071eb76`.
- Current source-manifest SHA256: `ba2756b38dcf59f1dd2353c411b0eae6569516da010c46dfebf7ed53b331e7fd`.
- Fresh backend start `2026-11-17T12:33:37.539Z`, frontend start `2026-11-17T12:33:37.737Z`. Browser asserts both start fingerprints match current production bytes; the old2339 fingerprint is not reused on this code.
-13 states: preview, empty, space-change, loading, home, keyboard-bottom, partial-error, tasks, page-draft-resume, new-draft-resume, other-owner-denied, acl-revoked, account-switched. Current52 PNG, browser-results and cleanup are54 manifest artifacts.
- In every viewport/theme: actual bare `?preview=1` renders Overview and no Home widgets, with0 native API calls; actual default Home space selector change retains the Home body and emits no operations pages/sources/members/jobs aggregate request. Existing real table-outage isolation,25-item keyboard/native scrolling/continuation, older exact page-bound and page-less resume, source ACL and actor switch proof still pass.
- Visually inspected final preview1440-light and space-change390-dark images. This is actual preview UI and synthetic authenticated native UI, not production IdP/accessibility certification.
- Prior package source manifest is preserved as c4-i1-prior-manifest.log, and all previous failure proofs/logs remain. Prior44 PNG/436-check package is recoverable at FIX_BASE; it is historical evidence, not the current snapshot.

### Cleanup, mistakes and remaining scope

Final cleanup.json records0 owned DBs/profiles/orphan Chromium processes, ports4394/5194 free and parent PostgreSQL alive. Only the owned runtime/frontend were stopped. The initial cleanup checker unexpectedly flagged incomplete; subsequent concrete inventory showed all resources0. Its exact cause was not established. Chromium executable filtering replaced generic command-text matching to avoid possible wrapper matches, then cleanup was reverified; no cleanup success was fabricated from the failed check and no unrelated processes were killed.

The implementation mistake was changing the empty legacy default without jointly testing serialization, actual space switching and preview's supported body. Added RED→GREEN and actual browser flows now cover each boundary. MISTAKE_LOG, handoff and plan record the correction. There were no I1 product test failures after the repair and no additional product changes after finalcheck/capture. Existing process-local cursor/digest scan/large bundle/wrapping-label/production IdP/OS accessibility/model quality limits remain unchanged.

I1 is locally repaired with current evidence. Controller scoped re-review, whole-branch final review, new exact-head CI and PR72 push/merge remain pending; the implementer did not push, create reviewers or merge.

Packaging note: checked git add stopped on ignored `.superpowers` ancestry despite staging the tracked report. The owned report/new I1 logs were explicitly force-added, leaving baseline/brief files untouched; checked diff/manifest gates then precede commit. This was packaging/tool handling, not a product or test failure.


## C4 ONE combined final wave — F1/F2 (continuation, not a second wave)

FIX_BASE `f74f408c0b056725fc55b26548b0853a48a921d5`. The assigned native worktree/branch were reused. Existing three modified production files and two untracked regression files were preserved when the first worker was interrupted by a usage limit. No reset/stash/discard, helper agent, push, PR or merge was performed. The whole supplied final review is retained as `c4-finalwave-review.log`; its two Important findings are reproduced below.

### Supplied findings (verbatim)

1. **C4-F1 — Automatic Home refresh discards the user's continuation page even when nothing changed.**

   **Files:** `src/operational/convenience/Home.tsx:90`, `:110`, `:141`, `:178`.

   `refresh()` clears `summary` at line92 and always requests the first-page summary. The focus/visibility handlers and 30-second timer call it. While summary is null, all `HomeWidget` instances unmount; their current page state is lost, and the new instances initialize from the first-page results. This applies to both Home and My Tasks.

   A user who has opened page2 to continue an older task loses that location merely by switching tabs/windows and returning, or by spending 30 seconds reviewing the queue. The dataset need not change. Repeated resets make large backlogs difficult to inspect and also replace the focused list controls. This is a functional continuation/keyboard workflow problem, not cosmetic refresh flicker. A reasonable user expects a background authorization refresh to preserve the page being viewed if it remains valid.

   **Focused reproduction:** `/private/tmp/akh-c4-final-probe/home-refresh.test.tsx`, test `unchanged queue retains selected second page after returning focus`. The test clicked the real Next button, verified `second-page-draft`, dispatched window focus, and then observed `first-page-draft`. API calls were:

   ```text
   /convenience/home
   /convenience/home?widget=drafts&cursor=page2
   /convenience/home
   ```

   The unchanged-page retention assertion failed. Full output: `/private/tmp/akh-c4-final-probe/output-native.log`.

   **Fix:** retain each widget's requested cursor and identity-bound state through automatic refresh, revalidate the current page, and update it without wholesale widget remounting. Keep current fail-closed behavior: stale/revoked/error results must clear invalid data and provide an explicit restart/retry. Do not fix this by disabling current-permission revalidation or indefinitely retaining stale rows. Add regressions for page2 across focus, visibility and the timer, including a refresh racing with Next and a stale/revoked cursor.

2. **C4-F2 — Exact page-bound draft resume bypasses the existing permitted local-recovery flow.**

   **Files:** `src/operational/workflows.tsx:702`–705 (changed initialization), `:440` (recovery guard), `:532` and `:641` (cache cleanup); integration entry at `src/operational/convenience/DocumentComposer.tsx:152`.

   The new initial-draft branch sets `draft` and server `content` immediately. The existing local-recovery effect explicitly returns whenever `draft` exists. Therefore an exact `section=compose&draft=<page-bound ID>` resume never checks/offers an otherwise valid newer local recovery for that same draft. It proceeds with the older server text and shows the ordinary saved status. Later successful autosave/flush or editor cleanup can remove the unoffered local cache.

   This affects a concrete restart scenario covered by the preservation contract: the browser has a still-valid, policy-permitted cache containing unsent text; the user returns through the Home draft card or reloads that exact URL. The ordinary document-entry path offers recovery, while the new direct resume path silently bypasses it. The persisted server draft remains intact, but the user's recoverable unsent edits can be lost; this is an Important integration defect.

   **Focused comparison:** the same temporary probe seeded a real `RecoveryCache` with a page-bound draft at r1, server body `server body`, and local `UNSENT LOCAL BODY`, using a current five-minute grant. Its transport supplied successful current identity and canonical validation responses. The ordinary-page case passed the recovery-dialog assertion. The exact-draft case failed and reported:

   ```json
   {"mode":"exact-draft","recoveryOffered":false,"calls":["/workflows/recovery/permission"],"editor":["server body"],"cachePresent":true}
   ```

   Thus the exact path never calls `/me` or `/workflows/recovery/validate` for recovery; it only asks permission for future caching. Output: `/private/tmp/akh-c4-final-probe/recovery-output.log`. Existing new exact-resume coverage deliberately denies recovery and has no seeded restart cache, so it cannot detect this (`src/operational/convenience/home.test.tsx:117`, `:157`).

   **Fix:** integrate exact page-bound resume with the existing online identity/full-lineage/local-copy/CAS recovery handshake before initializing/clearing the ordinary saved editor state. Match the cached draft ID to the requested exact ID (page-bound caches are keyed by page, so never silently select another draft for that page). Offer explicit restore/discard and preserve the conflict path; do not assign cached content before authorization. Cover matching valid cache, different draft on the same page, changed server revision/conflict, revoked/expired grant and failed validation, along with ordinary and page-less resume regressions.


### Root causes and final repair

- **F1:** summary-level refresh unmounted all widgets and restarted at page1. Each identity/API/capability-bound widget now retains its requested cursor and current DOM through focus, visibility and the actual30s interval. A current-page response replaces only that widget. 403/409/503/error DTO clears invalid rows; Retry revalidates the same page, while explicit “처음부터” restarts. Sequence checks protect both Next/refresh orderings and old-identity completions. Repeated background events coalesce while the current background request is pending, so they cannot starve its API timeout/error indefinitely. Next still supersedes an older background request. This uses existing canonical per-widget endpoints, not a client permission cache.
- **F2:** exact page-bound resume used to assign the saved server draft before the ordinary recovery effect could run. Exact initialization now awaits the existing RecoveryCache online `/me` and full-lineage/local-copy/CAS validation before offering a matching cached draft. Cached ID must equal the requested ID, not merely the page key. Explicit restore revalidates; explicit discard initializes the exact saved server draft. Conflict retains the old CAS and requires explicit resolution. Matching expired/invalid/revoked/failed validation fails closed; pending or wrong-identity responses never expose cached content.
- A different unexpired draft on the same page is not restored, overwritten by a cache write, or removed by the exact editor’s saved/flush/dispose cleanup. Optional expectedDraftId scopes RecoveryCache clear/recover; ordinary and page-less call contracts remain compatible. Authority/identity failure still clears protected recovery data.
- **Actual-browser F2 lifecycle finding within this same wave:** the generic `action()` reloaded parent App after local restoration; App’s dataReady=false unmounted the coordinator before its1s autosave, leaving server r1 and losing the cache. The retained browser failure and focused parent-reload RED prove this. Local-only restore now skips that server-mutation reload; all actual server mutation actions retain it. Online revalidation, coordinator CAS, original base and explicit conflict behavior remain unchanged. The final successful actual capture verifies canonical server r2 persistence and the subsequent concurrent-writer conflict, not merely displayed text.

The changed production paths are only `Home.tsx`, `draft-recovery.ts`, `workflows.tsx`. No server/SQL/route/capability implementation changes occur in this wave. UXC-05 / UX-001/003/004, REV-001/002, SRH-009 and preserved EDT recovery contracts are affected; existing251 criteria and North Star are unchanged. The improvement concerns the human continuation/review loop and recoverable author input. It does not publish knowledge or establish model/agent quality effects.

### Commands and observed evidence

All commands run in the assigned9cab worktree with Node24.22.2 on PATH. Log names below are under the existing scoped logs directory.

| Command / log | Actual result |
| --- | --- |
| Previous worker `vitest` new interaction cases → `c4-finalwave-red.log` |14 failing /2 passing across16; failure assertions include page2 lost and absent recovery offer. Missing-button TypeErrors in dependent restore/discard tests are distinguished from the primary behavioral assertions. |
| Resumed focused Home/exact-recovery/Home legacy/Composer/draft-recovery/WorkflowPanel → `c4-finalwave-resume-focused.log` |6 files52 passed, exit0, before extended cases. Previous first GREEN51 remains historical. |
| Extended focused → `c4-finalwave-green-focused.log` |6 files58 passed, exit0; includes both race orderings, actual pending identity result, outside focus, error DTO/503 and recovery revalidation revocation. |
| Actual initial capture → `c4-finalwave-browser-first.log` |exit1: recovery text displayed, canonical server remained r1 because parent reload unmounted autosave. Retained as product failure, not a harness timeout excuse. |
| Parent-reload regression → `c4-finalwave-red-parent-reload.log` |1 failed /12 passed, exit1; no saved CAS reached the server transport. |
| Focused after local-only restore repair → `c4-finalwave-green-parent-reload.log` |6 files59 passed, exit0. |
| Repeated pending automatic refresh regression → `c4-finalwave-red-overlap.log` |1 failed /10 passed, exit1:3 background requests superseded one another instead of permitting the outstanding failure to settle. |
| `npx vitest run src/operational/convenience/{home-refresh,exact-recovery,home,composer}.test.tsx src/operational/draft-recovery.test.ts src/operational/workflows.test.tsx` → `c4-finalwave-final-focused.log` |6 files60 passed, exit0 on final product bytes. |
| `npm run check` → `c4-finalwave-final-check.log` |frontend471/Node48/import16/evaluation41/requirements251/server types/build/static smoke, exit0. Pre-browser469 and parent-reload470 full checks are retained historical logs, not the final count. Existing629.09/1499.04kB warnings remain. |
| Parent-reload capture → `c4-finalwave-parent-reload-browser.log` |exit1 after actual restore persisted r2: conflict fixture posted read DTO `updatedAt` to strict write schema, correctly received400 VALIDATION_FAILED. Harness now selects canonical write fields; no server validation was weakened. |

Final actual browser, manifest and cleanup evidence is recorded below. Synthetic use only; real IdP/retention operating acceptance, representative scale/load, multi-instance cursor continuity, inherited editor accessible-name debt, OS IME/screen-reader certification and EVALUATION quality effects remain unverified. C1/C2 unchanged exact review/job/access/login browser journeys remain carried, with C12 broad journey validation outstanding.

**Backend native carry, explicitly not a fresh native run:** `git diff f74f408 -- server` is empty. Prior4 files50 (Home10/HTTP1/manual9/new-document30) plus6 files130 (governance14/workflows36/collaboration21/personal7/personal HTTP4/jobs48) are carried separately,10 unique files180, never a claimed current180-test execution.

### Final actual evidence and packaging

- Fresh backend `2026-11-17T15:26:08.455Z` / frontend `2026-11-17T15:26:06.919Z`; both start fingerprints equal final production `be63334376c81a8cd2c5e1c88db1ba1a89e8711468ec75a51d3dd6bdada49291`. Current browser `c4-finalwave-final-browser.log` exits0 for1440 light/dark and390 light/dark.19 states each,76 new PNG,22 semantic checks per configuration, pageerror/overflow0.
- Actual real30s timer, focus/visibility preserve page2 node/focus. Canonical revision change clears the stale page and explicit restart works. Real offline autosave cache, wrong same-page draft preservation, exact online offer, canonical r2 restore persistence and old-CAS concurrent-writer conflict pass alongside I1/legacy flows. Network abort is intentional for draft-save failure; no successful DTO is fabricated.
- Visual QA inspected current-page-refresh1440-light and recovery-offered1440-light; final mobile dark recovery/conflict captures are also inspected before handoff. Existing long WorkflowPanel/accessibility debt is not concealed or redesigned in this repair.
- Fresh `cleanup.json` records0 owned DBs/profiles/Chrome, ports4394/5194 free, parentPG alive. Only owned runtime/frontend are stopped.
- Source manifest binds322 production,3 harness,6 focused regression source paths,78 artifacts and scoped logs. Manifest SHA: 62a5afad06255aba6a105d323207d137f980d356f66292d36dc8a6966ee6ec2c. Source/hash/cleanup verification and `git diff --check` pass before the scoped commit.
- Same-backend native50+130 remains carried, unchanged. No helper/reviewer/push/PR/merge. Current main was observed clean on0def475/origin0def475; no other worktree or root content was changed.
