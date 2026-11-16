# 필수 편의기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 편의기능 10개를 기존 권한·원본·검토·발행 경로에 연결해 찾기·읽기·작성·재방문·검토의 사용자 동선을 완성한다.

**Architecture:** 기존 WorkflowService·CollaborationService·ScopedSearch·publication·draft recovery를 재사용한다. 새 UI는 `src/operational/convenience/`, 새 조회/구조/일괄/개인 보기 서비스는 `server/convenience/`에 분리하고 현재 runtime에 연결한다. 각 PR은 서버·UI·실제 경계 시험이 함께 있어 단독 검토 가능한 결과를 낸다.

**Tech Stack:** TypeScript, React 19.3.1, Vite 8.3.5, Node `^22.12.0 || ^24.0.0`, npm `>=10`, PostgreSQL, existing marked/DOMPurify/Vitest. 기존 package-lock을 유지하고 의존성을 추가하기 전에 필요성을 확인한다.

**Spec:** [필수 편의기능 설계안](../specs/2026-11-16-essential-convenience-design.md). 이 플랜은 **미실행**이며 체크박스가 제품 구현 완료를 나타내지 않는다. 기존 PR 병합과 후속 기능 구현은 별도 작업이다.

## Global Constraints

- 기존 251개 요구사항·수용 기준·필수/확장/선택 분류와 North Star를 변경하지 않는다. UXC는 작업 ID다.
- 역할 이름 대신 기존 capability를 사용한다: `knowledge.read`, `draft.write`, `changeset.propose`, `changeset.approve`, `knowledge.protect`, `lifecycle.manage` 등. API가 최종 인가한다.
- 원본/계보/상위 위치의 현재 ACL 상한을 모든 제목·개수·스니펫·검색·알림·백링크·파일·버전에 적용한다.
- 읽음과 처리 완료, 개인 저장과 검토/승인/발행, 작업 접수와 완료를 구분한다. 모델 호출 없이 핵심 읽기·키워드 검색·수동 작성이 동작한다.
- 기본 목록 25건, quick-open 10건, 알림 미리보기 5건, 일괄 최대 50건, preview 유효 10분, 개인 보기 이름 100자/개수 100개.
- 기존 문서/댓글/공유 링크·로그인 복귀와 자동 저장·충돌/로컬 복구·보존/삭제 fence를 보존한다.
- migration 117~122은 작성 시점 제안 파일명이다. 구현 시작 시 최신 번호 뒤로 재배정하고 적용된 SQL을 수정하지 않는다.
- 파일의 `Create`/신규 API/아래 함수는 **계획된 계약**이다. 실제 main에 이미 존재한다고 가정하지 않는다. 구현 시작 시 최신 main과 PR #30 반영 상태를 다시 확인한다.

## Review Focus

1. 다른 계정/공간으로 전환하는 순간 늦은 응답·로컬 초안·개인 목록·알림이 이전 자료를 노출하지 않아야 한다 — Tasks 1/2/3/5/11.
2. 일괄 읽음과 이벤트 생성이 겹치고 outbox가 늦게 도착해도 새 알림을 읽음 처리하거나 중복 전달하지 않아야 한다 — Task 2.
3. pageId 없는 새 초안·복제·템플릿이 sourceIds/의존 버전/독자를 잃거나 개인 내용을 직접 발행하지 않아야 한다 — Tasks 6/7.
4. 이동·백링크·일괄 작업 중 ACL/상위 정책·삭제·보존 fence가 바뀌면 재검사하고 안전한 항목별 결과를 남겨야 한다 — Tasks 7/8/10.
5. 반복 제목·문단 삭제·한글 IME·키보드/좁은 화면·Clipboard 거부가 잘못된 이동·입력 손실·거짓 성공을 만들지 않아야 한다 — Tasks 5/6/7/9.

## PR 순서와 의존성

| PR 단위 / Task | 선행 | 독립 검토 가능한 결과 | 연결 작업 |
| --- | --- | --- | --- |
| C1 / 1 | PR #30 통합 확인 | 호환 경로·권한별 사용자 메뉴 기반 | 전체 |
| C2 / 2 | C1 | 전역 알림함과 안전한 읽음/보관/이벤트 | UXC-01 |
| C3 / 3 | C1 | 즐겨찾기·최근·구독 목록 | UXC-02 |
| C4 / 4 | C2,C3 | 위키 중심 개인 홈·내 작업함 | UXC-05 |
| C5 / 5 | C1 | 전역 검색·빠른 열기 | UXC-03 |
| C6 / 6 | C1,C5 | 새 개인 문서 작성부터 최초 검토/발행 | UXC-04 |
| C7 / 7 | C3,C6 | 트리·경로·이동·복제 | UXC-06 |
| C8 / 8 | C5,C6,C7 | 내부 링크 자동완성·백링크 | UXC-07 |
| C9 / 9 | C1,C6 | 목차·본문 검색·부분 링크·코드 복사 | UXC-08 |
| C10 / 10 | C6,C7 | 속성 폼·일괄 미리보기/실행 | UXC-09 |
| C11 / 11 | C3,C5 | 개인 저장 보기 | UXC-10 |
| C12 / 12 | C1~C11 | 모든 동선의 통합·권한·회귀 인수 기록 | 전체 |

독립 단위의 진행 순서는 조정할 수 있지만 같은 파일을 동시 수정하지 않는다. 각 PR 종료 시 해당 요구사항·변경 파일·검증·남은 조건을 인계 문서에 기록한다. 이 문서는 병렬 실행을 자동 승인하거나 이미 실행했다고 선언하지 않는다.

## 기존·진행 중 코드 재사용

[설계안의 PR 재사용 표](../specs/2026-11-16-essential-convenience-design.md#동시에-진행된-pr의-재사용-경계)를 먼저 확인한다. #45의 `bulkPreview/bulkApply`·`BulkEditor`, #46의 공통 ScopedSearch, #47의 `DocumentBody/PersonalDocuments/RelatedDocuments/LinkCompletion`을 기준으로 **남은 계약만 구현**한다. 각 Task의 새 파일은 필요한 확장 책임만 맡거나 기존 컴포넌트에 위임한다. 같은 역할의 화면·서버를 나란히 유지하지 않는다. 병합이 아직 안 됐으면 해당 PR을 선행으로 삼고 cherry-pick으로 다른 PR의 소유 변경을 중복 게시하지 않는다.

## Task 1: 사용자 메뉴와 호환 경로

**Files:** Create `src/operational/convenience/route.ts`, `route.test.ts`, `types.ts`, `Navigation.tsx`, `Navigation.test.tsx`; Modify `src/operational/ConsoleShell.tsx`, `console.ts`, `App.tsx`, `api.ts`, `api.test.ts`, `jobs.tsx`, `governance.tsx`.

**Interfaces:** Consumes existing `Identity`, `documentHref`, `resumeWorkspaceLink`. Produces `parseConvenienceLocation(search:string,hash:string): ConvenienceLocation`, `convenienceHref(location:ConvenienceLocation):string`, `navigationItems(identity:Identity): NavigationItem[]`. `ConvenienceLocation` validates the spec's section/draft/view/version/anchor union; legacy document/comment/share/tab locations remain valid. Exact task targets are `{section:'tasks',targetKind:'review'|'job'|'access-request',targetId:string}` and are passed into authorized panel initial-selection props.

- [ ] Add failing route tests for old document/comment/share/discovery URLs, new section values, exact review/job/access target after login, deleted/denied target, invalid version, contradictory draft/document, external return URL, missing space and account transition.
- [ ] Run `npx vitest run src/operational/convenience/route.test.ts src/operational/api.test.ts`; confirm failures are the missing contracts, not setup errors.
- [ ] Implement typed route parsing/building, capability-based navigation and preserved legacy destinations. Wire identity/session generation changes to clear protected route state.
- [ ] Run those tests plus `Navigation.test.tsx`, `src/operational/console.test.ts`; check keyboard menu selection and role-specific items in a real browser.
- [ ] Record UXC coverage and commit `feat: add user navigation and compatible document locations`.

## Task 2: 알림함과 이벤트 연결

**Files:** Create `server/migrations/117-user-inbox.sql`, `server/collaboration/inbox.ts`, `inbox.test.ts`, `src/operational/convenience/NotificationBell.tsx`, `NotificationInbox.tsx`, `inbox-client.ts`, `inbox.test.tsx`; Modify `server/collaboration/http.ts`, `service.ts`, `types.ts`, `server/workflows/service.ts`, `server/publication.ts`, `server/jobs/service.ts`, `server/workflows/governance/service.ts`, `src/operational/notifications.tsx`, `ConsoleShell.tsx`.

**Interfaces:** Consumes current event/worker/preference and authorized target services. Produces `InboxService.list(ctx:Context,input:InboxQuery):Promise<InboxPage>`, `setState(ctx,id,input):Promise<InboxItem>`, `readAll(ctx,{boundary,mutationId}):Promise<{updated:number}>`, `recordInboxEvent(db:PoolClient,event:InboxEvent):Promise<void>`. DTOs, targets, limits and endpoint paths are fixed in UXC-01.

- [ ] Add database failures for duplicate source events, pending creator transaction vs read-all boundary, delayed outbox delivery, mark-unread after read-all, archive/restore, target ACL/session revocation, job-without-page, legacy row backfill and actor/workspace separation. Add UI failures for 5-item preview, filtering, focus-preserving refresh and multiple-tab stale responses.
- [ ] Run `node scripts/test-server.mjs server/collaboration/inbox.test.ts` with a disposable `TEST_DATABASE_URL`, and `npx vitest run src/operational/convenience/inbox.test.tsx`; verify the intended red state.
- [ ] Implement recipient-row-locked committed sequence, event-key uniqueness, signed boundary, target authorization and schema/backfill. Integrate the existing outbox/worker rather than sending during UI reads. Connect review/request/decision/publication/job/access events and 90-day configurable inbox pruning through existing erasure/retention controls.
- [ ] Add routes and bell/inbox UI; keep old notification routes and preferences working. Run focused tests, existing collaboration/notification interaction tests and migration upgrade/restart checks. Verify 1440/390 and light/dark screenshots, keyboard preview/close/focus return.
- [ ] Record actual evidence and commit `feat: complete personal notification inbox`.

## Task 3: 즐겨찾기·최근·구독

**Files:** Create `server/convenience/personal.ts`, `personal.test.ts`, `http.ts`, `types.ts`, `src/operational/convenience/PersonalLibrary.tsx`, `personal-client.ts`, `personal.test.tsx`; Modify `server/workflows/service.ts`, `http.ts`, `server/runtime/http.ts`, `src/operational/workflows.tsx`, `App.tsx`.

**Interfaces:** Consumes `WorkflowService.activity`, `favorite`, `subscribe`, authorized document reads and Task 1 route helpers. Produces `PersonalLibraryService.list(ctx,{kind,cursor,limit}):Promise<LibraryPage>`, `documentState(ctx,pageId):Promise<{favorite:boolean,subscribed:boolean}>`, `reorderFavorites(ctx,{pageIds,expectedRevision,mutationId})`. Extend existing `/workflows/favorites|recent` compatibly and add `/workflows/subscriptions`.

- [ ] Add failures for pagination, duplicate visits, no visit on search rendering, access removal including hidden ancestors, current state toggles, reordered list conflict and account-switch response isolation.
- [ ] Run `node scripts/test-server.mjs server/convenience/personal.test.ts` and `npx vitest run src/operational/convenience/personal.test.tsx` and verify intended failures.
- [ ] Implement current-ACL list queries, 25-item cursors and favorite order CAS using existing activity/preferences storage. Wire sidebar/home-friendly lists and actual document-open visit recording.
- [ ] Run focused tests plus workflow/API regressions. Verify keyboard reorder and mobile navigation, screenshots and no hidden title/count persistence.
- [ ] Commit `feat: connect personal document lists` with evidence.

## Task 4: 개인 홈·내 작업함

**Files:** Create `server/convenience/home.ts`, `home.test.ts`, `src/operational/convenience/Home.tsx`, `MyTasks.tsx`, `home.test.tsx`; Modify `server/convenience/http.ts`, `src/operational/App.tsx`, `console.ts`, `Overview.tsx`.

**Interfaces:** Consumes Tasks 1~3, existing workflow drafts/governance review inbox/changesets/jobs and PR #30 discovery links. Produces `HomeService.read(ctx:Context):Promise<HomeSummary>` where each widget has `status:'ready'|'error'`, `items`, `nextCursor`; successful empty differs from failed. GET `/convenience/home` uses only the authenticated person's permitted records.

- [ ] Add failures for own vs other drafts/requests/jobs, assigned vs permitted review, capability changes, one widget error, exact resume links and read-not-equal-complete.
- [ ] Run server `home.test.ts` and client `home.test.tsx` red checks.
- [ ] Implement bounded per-widget authorized composition and precise links. Make personal home the default user landing; preserve operations overview as an explicit destination.
- [ ] Run focused tests, existing overview/navigation tests and actual resume flows. Capture empty/loading/partial-error and both viewport/theme combinations.
- [ ] Commit `feat: add wiki home and personal work queue`.

## Task 5: 전역 검색과 Quick Open

**Files:** Create `src/operational/convenience/QuickOpen.tsx`, `SearchPage.tsx`, `search-client.ts`, `search.test.tsx`; Modify `server/questions/search.ts`, `server/questions/service.test.ts`, `src/operational/questions.tsx`, `ConsoleShell.tsx`, `App.tsx`.

**Interfaces:** Consumes Task 1 and existing POST `/api/v1/questions/search`. Produces `normalizeSearchFilters(input:unknown):SearchFilters`, `searchDocuments(api,filters,{limit,cursor,signal}):Promise<SearchPage>` and `QuickOpen({api,onOpen,onClose})`; reuse one validated filter schema. Fast title results 10, detail results 25.

- [ ] Add failures for IME composition, 200ms debounce, late old responses, cursor bound to principal/space/filter, denied snippets/counts, model disconnected, keyboard open/navigate/select/escape/focus return and default exclusion of past/non-current versions.
- [ ] Run `npx vitest run src/operational/convenience/search.test.tsx` and focused search DB tests to establish red.
- [ ] Implement common keyword search binding, safe snippets, combobox/listbox and filter UI. Keep explicit historical mode and do not auto-submit a model question.
- [ ] Run search/service/API regressions plus a browser Korean IME and keyboard walkthrough at 1440/390. Record limitations of semantic quality separately.
- [ ] Commit `feat: add global search and quick document opening`.

## Task 6: 신규 문서와 작성기

**Files:** Create `server/migrations/118-new-document-disclosure.sql`, `server/workflows/new-document.ts`, `new-document.test.ts`, `server/workflows/manual-disclosure.ts`, `manual-disclosure.test.ts`, `server/imports/disclosure-policy.ts`, `src/operational/convenience/DocumentComposer.tsx`, `composer.test.tsx`; Modify `server/workflows/service.ts`, `http.ts`, `server/imports/service.ts`, `src/operational/ImportWorkbench.tsx`, `server/retention/recovery.ts`, `server/retention/recovery.test.ts`, `src/operational/draft-recovery.ts`, `draft-recovery.test.ts`, `workflows.tsx`, `App.tsx`.

**Interfaces:** Consumes Task 1/5, existing `saveDraft`, `propose`/`approve`/`publish`, template and recovery services. Produces `submitNewDraft(ctx,draftId,{expectedRevision,title,parentId,reason,disclosureId,disclosureHash,mutationId}):Promise<{status:'knowledge-review-pending',sourceId:string,batchId:string,hash:string}>` and recovery binding union `{kind:'page',pageId,...}|{kind:'draft',draftId,...}` authorized server-side. Also produces `ManualDraftDisclosureService.request(ctx,draftId,{expectedRevision,title,parentId,readers,reviewerId,reason,mutationId})` and `decide(ctx,id,{hash,decision,reason,mutationId})`, the three disclosure endpoints and persisted state fixed in UXC-04. Extract reviewer/policy helpers from ImportService without faking import_runs. It must remove the *functional gap* of `SOURCE_REGISTRATION_REQUIRED` for this deliberate endpoint without loosening the existing endpoint.

- [ ] Add failures for pageId-less save/restart/recovery, first proposal and reviewed first publish without a model, duplicate submit, stale draft, pending/rejected/approved team disclosure and owner-only personal confirmation before proposal, no other-reader personal audience, server-determined policy mode, reviewer snapshot-only access, stale disclosure hash/audience/parent/policy, legacy import disclosure compatibility, template/source/ancestor revocation, inability to recover another owner's draft and private draft absence from search/backlinks.
- [ ] Run `node scripts/test-server.mjs server/workflows/new-document.test.ts server/workflows/manual-disclosure.test.ts server/retention/recovery.test.ts` and client composer/recovery tests; establish the absent endpoint/behavior failures.
- [ ] Implement persisted manual-draft disclosure and common reviewer/policy helpers first. No proposal exists until the exact snapshot/audience is explicitly approved: an independent qualified reviewer for team sharing, or the verified owner under the existing owner-only personal-space policy. Never accept a client-chosen personal-mode bypass. Then register the immutable source and content-preserving initial proposal through existing publication checks. Keep raw-source/publication decisions separate and preserve import-run APIs. Extend recoverable ownership binding for new drafts; preserve old draft autosave/fences/CAS.
- [ ] Connect global new-document entry, title/parent/template/form/preview, new draft resume and explicit publication states. Run workflow/publication/retention regressions and browser disconnect/IME/dual-tab conflict flows.
- [ ] Commit `feat: add reviewed creation of new wiki documents`.

## Task 7: 문서 트리·이동·복제

**Files:** Create `server/migrations/119-document-order.sql`, `server/convenience/structure.ts`, `structure.test.ts`, `src/operational/convenience/PageTree.tsx`, `Breadcrumbs.tsx`, `structure.test.tsx`; Modify `server/workflows/service.ts`, `server/convenience/http.ts`, `src/operational/App.tsx`, `workflows.tsx`.

**Interfaces:** Consumes Tasks 1/3/6 and existing parent/state/history ACLs. Produces `DocumentStructureService.children(ctx,{parentId,cursor,limit})`, `path(ctx,pageId)`, `move(ctx,{pageId,parentId,beforeId,expectedRevision,mutationId,reason})`, `duplicateToDraft(ctx,{pageId,version,parentId,mutationId})` using spec UXC-06; duplicate returns a new private draft reference retaining source/version dependencies.

- [ ] Add failures for 3-level navigation, hidden ancestor/child counts, cycles, stale neighbor, ACL-broadening move, concurrent trash/retention, duplicate lineage, old stable links and keyboard equivalent of drag.
- [ ] Run structure DB/UI tests red. Validate new order migration uniqueness/backfill before implementation.
- [ ] Implement paged authorized tree/path, deterministic ordering and audit/CAS mutation; duplicate only through Task 6 private draft creation, never independent-proof cloning.
- [ ] Run workflow/trash/access/version regressions. Verify mobile tree drawer focus and old-link navigation after move/rename with screenshots.
- [ ] Commit `feat: add document tree navigation and safe organization`.

## Task 8: 내부 연결·백링크

**Files:** Create `server/migrations/120-published-page-links.sql`, `server/convenience/links.ts`, `links.test.ts`, `src/operational/convenience/LinkAutocomplete.tsx`, `Backlinks.tsx`, `links.test.tsx`; Modify `server/publication.ts`, `server/operations/product-erasure.ts`, `server/convenience/http.ts`, `src/operational/convenience/DocumentComposer.tsx`.

**Interfaces:** Consumes Task 5 authorized suggestions, Task 6 publication, Task 7 stable IDs and existing page links/PR #30 discovery semantics and PR #47 navigation/linkSearch; extend its behavior instead of a duplicate relation service. Produces `resolveLinkSuggestions(ctx,query,limit=10)`, `backlinks(ctx,pageId,{cursor,limit})`, `replacePublishedLinks(db,{workspaceId,pageId,version,refs})`. Refs are `{targetPageId,label,sourceBlockId}`; only published versions contribute.

- [ ] Add failures for duplicate titles/explicit choice, rename, unresolved links, hidden source/target/raw source, unreviewed draft edges, replayed publication, erasure during query and stale derived indexes.
- [ ] Run links DB/UI tests red; implement publication-transaction/outbox link index and rebuild path with final current-ACL checks.
- [ ] Wire `[[...]]` suggestions, keyboard confirmation, backlink/related-document panel and stable-ID rendering without replacing the portable Markdown source.
- [ ] Run publication/discovery/erasure regressions and actual rename/revoke navigation. Do not change common citation privacy policy.
- [ ] Commit `feat: connect internal document links and backlinks`.

## Task 9: 읽기·목차·부분 공유

**Files:** Create `src/operational/convenience/DocumentReader.tsx`, `document-reader.ts`, `reader.test.tsx`, `server/convenience/anchors.ts`, `anchors.test.ts`; Modify `server/workflows/versions/metadata.ts`, `server/publication.ts`, `src/operational/convenience/route.ts`, `src/operational/App.tsx`, `workflows.tsx`, `questions.tsx`, `versions.tsx`, `api.ts`.

**Interfaces:** Consumes Task 1 location codec and existing authorized current/fixed-version reads and PR #47 DocumentBody; extend/delegate to the reader instead of rebuilding its TOC/search. Produces `buildDocumentOutline(markdown:string,blocks:BlockReference[]):OutlineItem[]`, `findDocumentMatches(markdown:string,query:string):DocumentMatch[]`, `DocumentReader({document,version,blocks,targetAnchor})` and `captureBlockReferences(db,pageId,version,content):Promise<BlockReference[]>`. IDs persist in version metadata; repeated titles do not collapse.

- [ ] Add failures for repeated Korean headings, fenced code/tables, search next/previous, XSS-bearing text, removed/changed block, latest vs fixed-version link, current permission removal and denied Clipboard API.
- [ ] Run reader/anchor tests red, then implement safe outline/search/token rendering, stable block matching/snapshots and copy fallback. Preserve DOMPurify.
- [ ] Add explicit version/anchor URL and login-return regression tests. Do not reuse tab/comment hashes for document headings.
- [ ] Run focused tests and old document/comment/share/version tests; verify keyboard position movement/code copy and 390px layout in both themes.
- [ ] Commit `feat: improve wiki reading and precise document sharing`.

## Task 10: 속성 폼·일괄 정리

**Files:** Create `server/migrations/121-bulk-document-actions.sql`, `server/convenience/bulk.ts`, `bulk.test.ts`, `src/operational/convenience/PropertiesForm.tsx`, `BulkActions.tsx`, `bulk.test.tsx`; Modify `server/workflows/bulk.ts`, `src/operational/BulkEditor.tsx`, `server/workflows/versions/metadata.ts`, `server/workflows/governance/service.ts`, `server/jobs/types.ts`, `runtime.ts`, `server/convenience/http.ts`, `src/operational/workflows.tsx`.

**Interfaces:** Consumes Tasks 6/7 and current property/governance/publication/job/erasure services. Produces `BulkDocumentService.preview(ctx,input):Promise<BulkPreview>`, `execute(ctx,{previewToken,mutationId}):Promise<{id:string,status:'queued'}>`, `read(ctx,id):Promise<BulkReceipt>` with the spec's 50-target/10-minute contract. Extend existing `/workflows/bulk/preview` and `/workflows/bulk/apply` with compatible input aliases; add GET `/workflows/bulk/:id`, not parallel convenience bulk endpoints. `PropertiesForm` uses the canonical metadata schema and policy warnings, not a second metadata store.

- [ ] Add failures for required fields, tag normalization, owner not granting access, stale property edit, 50/51 target boundary, expired preview, ACL or parent change after preview, mixed denied/stale/applied/needs-review results, worker crash/replay and delete/retention racing execution.
- [ ] Run bulk/governance/version DB tests and UI tests red. Implement hash-bound preview and durable per-item idempotent receipts; tag/content metadata emits reviewed proposals.
- [ ] Wire form-based metadata editing and multi-select preview/result/retry. Keep privileged JSON as optional advanced mode and destructive permanent deletion outside this menu.
- [ ] Run jobs/publication/retention/access regressions, schema upgrade/restart and browser partial-result walkthroughs with screenshots.
- [ ] Commit `feat: add document property forms and reviewed bulk actions`.

## Task 11: 저장 검색·개인 보기

**Files:** Create `server/migrations/122-personal-saved-views.sql`, `server/convenience/views.ts`, `views.test.ts`, `src/operational/convenience/SavedViews.tsx`, `views.test.tsx`; Modify `server/convenience/http.ts`, `src/operational/convenience/SearchPage.tsx`, `PersonalLibrary.tsx`, `route.ts`.

**Interfaces:** Consumes Task 5 `SearchFilters`, Task 3 personal lists and Task 1 private view links. Produces `SavedViewService.list(ctx)`, `save(ctx,{id?,name,filters,sort,expectedRevision,mutationId})`, `remove(ctx,id,expectedRevision)`; endpoints and DTO as UXC-10. View definitions are owner/space scoped, results always freshly authorized.

- [ ] Add failures for re-login persistence, 100-character/100-view boundaries, unknown filters, unauthorized view ID, current permission revocation, concurrent edit/reorder/delete and search text absent from URL/localStorage.
- [ ] Run saved-view DB/UI tests red and implement typed storage/CAS plus save/edit/delete/reorder/run UI. URL holds only view ID.
- [ ] Run search/personal/route regressions and fresh-account/space-switch browser flows. A saved view never grants document access or becomes team-shared by default.
- [ ] Capture keyboard/mobile evidence and commit `feat: add personal saved search views`.

## Task 12: 연결 인수·현재 현황 정리

**Files:** Modify `docs/CURRENT_STATUS.md`, `docs/AGENT_HANDOFF.md`, `docs/MISTAKE_LOG.md`, `docs/requirements/README.md`, this plan and the spec's evidence links. Extend tests in each feature rather than introducing a separate test-only authority layer.

**Interfaces:** Consumes C1~C11 committed behavior. Produces a per-UXC evidence record: `{commit,implementation,connection,automatedChecks,browserEvidence,remaining,operationalAcceptance}`. Planned criteria and actual evidence stay separate.

- [ ] Trace every UXC row and each Review Focus item to its implementation and test; keep unimplemented/failed items open and never mark them complete because their spec merged.
- [ ] Run `npm run check`, `npm run test:server` with the dedicated disposable database, and applicable K8s/container checks from CI. Inspect every final-head required check and unresolved review thread before each merge.
- [ ] In a real browser perform new document → save/recover → shared-source review if required → knowledge review → publish → search → favorite/revisit → backlink → comment/notification → home/task resume. Include revoked source/identity, model outage, expired session, IME and 390px keyboard use.
- [ ] Record migration ordering/backfill, worker replay and rollback evidence. Preserve old URLs and old notification/authoring APIs. No production deployment is included in this plan.
- [ ] Update feature status to the exact tested scope, commit `docs: record convenience feature acceptance evidence`, and report remaining operational/quality conditions.

## 완성 판정과 후속 실행

설계·플랜 문서를 작성하고 검토하는 현재 작업은 후속 C1~C12 실행과 별개다. 구현 시 체크박스는 해당 결과·최종 커밋 증거를 확보한 후에만 바꾼다. 실제 UI 변경 PR은 1440/390 화면 캡처, 라이트/다크·키보드 검증과 필요한 DB 회귀를 포함하고, 원본 정책·독자·발행 불변식을 통과해야 한다. 모든 C 단위를 한 대형 PR로 합치지 않는다.
