# 에이전트 인계

## 2026-11-17 Task1c — Unicode lexical compatibility correction

- SRH-001/002/004/006 and CORE-009/010: before PR #55 merge, an actual PostgreSQL17 locale probe showed SQL lower() differs from JavaScript toLocaleLowerCase() for contextual final sigma and dotted I. Native canonical tests with unrelated title/summary reproduced two missed body hits and two overmatches before implementation. A fifth Kelvin-sign/ASCII-query case retains coverage of Unicode bodies.
- `server/search/query.ts` still executes the fixed physical GIN query, then conservatively adds keys only from the already-loaded authorized snapshot for non-ASCII query/body or measured database/process ASCII-fold mismatch. `server/questions/search.ts` verifies every body result with the same JavaScript substring predicate as metadata. Existing current ACL/source/credential ceilings, history, cursor and structural filters remain; no query language restriction, normalization, silent truncation, model change or migration121 edit.
- Exact limit: fallback work visits the existing authorized version array, adds no new content read and has no new independent hard count/byte bound. Unicode queries, including Korean, may scan that whole snapshot; end-to-end Unicode acceleration and large-workspace performance are unverified. Actual10,000-version GIN execution plans are tested for both selective Korean and code patterns. Empty-query semantic preparation still bypasses candidate/probe work and retains its full authorized structural-filtered corpus.
- RED4 then targeted GREEN64 (index16, historical search18, retention30). Final complete Node24 check passed (frontend216, Node48, imports16, evaluation41, requirements251, server types/build/static smoke); combined UUID-isolated native20 files/217 tests passed including index16/semantic13/ordinary jobs52/historical search18/policy14, retention/release and native MCP. Independent fresh review and final remote CI remain required. No UI/layout change.

## 2026-11-17 PR #62 native navigation HTTP 시험 예산 보완

- PR #62 `7387484`의 staged 알림 수정은 독립 리뷰 16시험에서 승인됐지만, 최종 CI run `43898200490`/job `133407397086`의 기존 navigation HTTP 시험은 5000ms 예산을 5005ms에 초과했다. staged 16시험을 포함한 다른 125서버 파일 통과가 이 CI 실패를 상쇄하지 않는다.
- 승인된 현재 통합 `a98a542`를 fix worktree에 병합해 PR #56의 최신 source closure와 함께 검사한다. matching lockfile 의존성에서 원래 사례의 5002ms timeout을 재현했다. 해당 단일 사례는 34개 순차 native HTTP 요청으로 인증·문서 탐색·completion·draft·submit·URL 형태·현재 원본 회수를 검사한다. 임시 진단에서는 전체 4193.95/3952.36ms, teardown 0.43/1.26ms로 종료됐고 개별 요청 최대 230/252ms였다. 누적 작업 예산의 부족을 확인했으며 전역/제품 timeout을 늘리지 않는다.
- 변경은 `server/workflows/navigation-http.test.ts`의 해당 사례 20초 예산과 이 기록뿐이다. 모든 요청/상태/권한·계보 assertion을 유지하고 진단 계측은 제거했다. 관련 CLB-005/ACL-007/008/CORE-008의 staged 알림 수정과 EDT-007/REV-003 원본 회귀를 함께 재검증하며 의미 품질/운영 인수 주장은 하지 않는다. 최종 native 재실행은 staged 16·lineage 30·navigation 1시험이 통과했고 navigation 파일 전체는 3.96초였다. Node 24.22.2 전체 `npm run check`도 통과했다(프런트 213, Node 48, import 16, 평가 41, 요구사항 251, 서버 타입·빌드·smoke). 추가 독립 검토와 최종 원격 CI는 PR 후속 기록을 따른다.

## 2026-11-17 Task1c — approved-flow base integration

- Follow-up: extracted only approved commitf08058f (single navigation HTTP test budget and its historical records) after mergee093a4c. PR #62 production/migration130 changes were not imported; its earlier validation above remains a record of that separate PR. The resulting navigation test file is byte-identical to reviewed f08058f. A fresh UUID-isolated run passed1 test (file8.28s, including setup/teardown), and the final full Node24 check again passed57 frontend files/216 tests plus all existing required checks. Only this case has20 seconds; production/global timeouts are unchanged.
- Continued the parent-owned pending merge of integration `a98a542d843aa4f2dd03b9c33f77f67f55979e85` into the isolated index branch after the inventory repair `2026edf` received independent approval (native6 files/85 tests). No new feature or migration was added. Both sides of the handoff/status/mistake records remain preserved.
- `ScopedSearch.searchDb(db, ctx, raw, legacyOffset)` keeps the integration base's trusted host-transaction composition, current ACL/history/metadata/structural filters and signed cursor logic. Only literal body candidate retrieval uses `indexedContentMatches`; semantic preparation still passes an empty query and sees the full authorized structural-filtered corpus. Future question-scope work is separate.
- `server/jobs/runtime.ts` retains both semantic and fixed index payloads, model policy/reservation/usage fences, kind-first/semantic-seal replay checks from018abf5, and the operator+current Admin verified-session-only rebuild grant. Index work cannot become scheduled/service/generic delegated maintenance or model/publication work. The rebuild and semantic HTTP endpoints each retain their own202 receipt/trace; both server/client error maps remain.
- Exact lockfile match was checked before changing only the untracked dependency symlink to `/private/tmp/akh-779-deps/node_modules`. Full Node24 `npm run check` passed (src216, Node48, imports16, evaluation41, requirements251, server types/build/static HTTP smoke). Combined UUID-isolated PostgreSQL17 regressions passed20 files/212 tests: index11, semantic13, ordinary jobs52, runtime12, policy14, historical search18, question HTTP9 and the selected retention, release and agent/cookie MCP cases. No layout change was introduced by conflict resolution; prior UI evidence remains valid for its stated synthetic/real boundaries. Independent merge-scope review and final remote CI remain required.

## 2026-11-17 Task1c — retention integration correction

- SRH-006/008 and existing retention/erasure invariants: PR #55 head `1f1f555`, CI run `43891959528` / job `133385264883`, exposed unclassified `search_index_state` and `search_index_workspace_state`. Native reproduction identified the durable job's actual `RETENTION_GRAPH_UNSUPPORTED` error. The full CI log failed five files / 28 assertions, including retention jobs, inventory, ordinary retention and notification erasure; the original 152-test selection omitted positive retention jobs and inventory.
- `server/retention/inventory.ts` now explicitly classifies these two tables as metadata only. Exact column/type/nullability signatures and exact foreign-key descriptors are frozen: global maintenance observations have no FK; workspace observations have only the validated, immediate, non-cascading workspace FK. New content columns, product FKs, type/nullability drift and changed FK actions remain fail closed. No new product-content root, unknown-table exemption, source ACL/hold relaxation or migration change is introduced; migration121 stays unchanged and122 unused.
- Actual retention regression confirms an authorized expired non-head version disappears from the real indexed candidate query, the current version remains, committed workspace observation advances, global maintenance success/failure history survives, and resurrection remains fenced. Existing legal-hold, source-ceiling, rollback/recovery and workspace/source erasure regressions are included in the final native validation.
- RED: original jobs reproduce dead; baseline controls reject; classification alone leaves two new product-FK tests incorrectly succeeding. GREEN: exact FK guard passes the targeted six retention jobs plus nine control tests. Node24 complete `npm run check` passed (src193, Node48, imports16, evaluation41, requirements251, server typecheck, build and static smoke). Expanded scripts/test-server.mjs validation passed: 23 files / 179 tests (retention HTTP/runtime7, all operations91, retention inventory/HTTP/recovery/service45, release25, index11). No UI/layout change; existing screen evidence applies. Independent scoped review and final remote CI remain required.
## 2026-11-17 최종 요청 인가 전후의 검토 알림 소실 수정

- CLB-004/005, ACL-007/008, REV-003/004, JOB-002 및 CORE-008 관련. PR #48의 [리뷰 5921247928](https://github.com/wontaeJeong/agent-knowledge-hub/pull/48#pullrequestreview-5921247928)과 [후속 리뷰 5921544871](https://github.com/wontaeJeong/agent-knowledge-hub/pull/48#pullrequestreview-5921544871)에 이미 지적됐으나 미해결로 남았던 staged-authorization 알림 누락을 별도 수정한다. PR #56의 링크 계보 보완과 별개다.
- 원인: migration 120이 `requestAuthorizationPending=true` 변경안에도 리뷰 이벤트를 만들었다. 스캐너는 canonical 검토 게이트의 `NOT_FOUND`를 받으면 이벤트를 소비했고, 최종 인가 해제 때 같은 이벤트 키 충돌로 실제 검토 가능 알림을 잃었다. PostgreSQL에서 해제 전 이벤트 생성·legacy 이벤트 소비·해제 시 재발행 실패를 RED로 확인했다.
- 변경: 적용된 120의 체크섬은 보존한다. 신규 `server/migrations/130-staged-review-events.sql`은 비공개 staging 중 이벤트를 만들지 않고, 실제 true→해제 전환에서만 기존 이벤트의 `projected_at`과 구독 기준 시각을 실제 해제 시각으로 갱신한다. 이벤트 ID와 수신자별 알림 ID는 유지한다. `server/collaboration/events.ts`는 이전 릴리스가 남긴 staging 이벤트를 recipient 검사 전에 제외하여 소비하지 않는다. canonical `reviewNotificationDb`, 승인·발행·원본 상한은 변경하지 않았다.
- 제한적 복구: 마이그레이션 실행 시 **현재 pending/model 변경안의 현재 해시와 일치하는 기존 소비 이벤트** 중 **아직 어떤 수신자에게도 리뷰 알림이 없는 이벤트**만 한 번 재투영한다. 원래 `created_at`을 유지하고 현재 검토 자격·원본 권한·원래 구독 cutoff를 재검사한다. 이미 알림이 있는 이벤트, 다른 해시/상태/offline, 아직 staging 중인 변경안, 사라진 이벤트는 복원하지 않는다. 재실행은 migration ledger와 알림 고정 ID로 중복을 막는다.
- 복구 한계: 과거 해제 시각과 staging 이력은 저장되지 않아, 실제 누락과 당시 적격 수신자가 없던 model 이벤트를 완전히 구분할 수 없다. 위 범위의 후자도 현재 적격인 원래 구독자에게 처음 투영될 수 있다. staging 시작 이후 실제 해제 이전에 구독한 과거 사용자는 과거 cutoff 때문에 복구되지 않을 수 있다. 시각·이력·알림을 추정해 만들지 않는다. 새 릴리스의 해제 전환에는 실제 해제 cutoff가 적용된다. 데이터가 큰 운영 DB의 migration 소요 시간/잠금 부하는 미측정이다.
- 검증: Node 24.22.2 `npm run check` 통과(프런트 212, Node 48, import 16, 평가 41, 요구사항 251, 서버 타입, 빌드, 정적 HTTP smoke). Vite의 기존 500kB chunk 경고는 남는다. 파일별 새 PostgreSQL DB로 협업·구독 HTTP·인증·runtime final-response guard·발행·계보 14파일 123시험 통과. 신규 16시험은 직접 제안/실제 `RuntimeService.ingest`의 final revalidation barrier, 성공/실패 cleanup, old consumed/unconsumed 이벤트, 실제 checksum-aware upgrade/retry, 동시 scan/고정 ID, 현재 원본/검토자 회수, release rollback을 검사했다. migration runner로 보강한 최종 16시험도 재실행 통과했다.
- North Star: Ingest → 검토 가능한 변경 → 승인·발행의 사람 검토 연결과 현재 권한/중복 방지 불변식을 보완한다. 기존 지식 본문·근거·검토 결정은 바꾸지 않는다. 이 회귀는 알림 전달의 정확성을 검증하며 지식 품질·후속 에이전트 성과의 개선 측정은 아니다. UI·모델·SSO grant·인프라 변경은 없고 앱1/DB1을 유지한다. 새 PR의 독립 재검토·최종 원격 CI와 운영 인수는 별도다.

## 2026-11-16 문서 표시·이미지 첨부 — 로드맵 Task 3

- 독립 리뷰의 Important 2건을 회귀로 재현해 수정했다. Sharp가 APNG의 pages를 생략하므로 실제 PNG 청크 경계를 검사해 acTL/fcTL/fdAT·손상/종료 뒤 데이터를 거부한다. 유효한 2프레임 합성 APNG는 실제 런타임에서415로 거부되고 blob 메타데이터가 생기지 않는다. 수식/다이어그램 세대와 별개인 이미지 요청 토큰은 새 선택·닫기·컨텍스트/언마운트에서 갱신하며 늦은 성공이 최신 권한 거부를 덮지 못한다. 대기 중 닫기도 지원한다. 이미지 object URL은 생성하지 않는다. 새 codec/React deferred/native HTTP 회귀 및 최종 전체 검사 결과는 화면 증거 README를 따른다.
- EDT-001/008/009. `src/ui/Markdown.tsx`와 운영 문서·질문·고정 인용 및 기존 데모의 공통 읽기 경로를 연결했다. 원본 Markdown 표/코드/내부 링크를 다시 직렬화하지 않고, 로컬 KaTeX MathML과 엄격한 Mermaid flowchart/sequenceDiagram을 표시한다. 외부 이미지·HTML 실행·다이어그램 설정/콜백은 차단한다.
- `server/storage/content.ts`, `service.ts`, `attachments.ts`, `file-read.ts`, `routes.ts`와 `src/operational/storage.tsx`에서 PNG/JPEG/WebP 업로드·이미지 미리보기·불변 버전 교체와 검토 연결을 지원한다. 5 MiB/400만 화소/4096px/정지 이미지 제한, 전체 픽셀 디코딩, 현재 ACL·원본 상한·고정 공유·디코딩 뒤 재검사·철회를 적용한다. 기존 CAS·스냅샷·보존/물리 삭제 게이트를 재사용하며 공개 파일 저장소는 없다.
- 지원 형식·API·원본/발행/평가 경계는 [문서 표시 계약](DOCUMENT_PRESENTATION.md). 이미지 구조 검사는 바이러스/근거 검증이 아니며 PDF 변환·추출·미리보기, SVG/GIF와 임의 Mermaid 확장은 미지원이다. 지식/에이전트 성과는 측정하지 않았다.
- 검증: Node24 전체 `npm run check`, 파일별 격리 PostgreSQL17의 storage/erasure 회귀 및 OIDC 세션·CSRF를 지나는 이미지 HTTP 검사를 실행했다. 실제 Chromium/React/서버/합성 OIDC·DB의 1440/390 문서·첨부 캡처와 업로드→미리보기→교체→원본 ACL 철회 후 차단, 외부 요청0/브라우저 오류0 근거는 [화면 증거](pr-assets/roadmap-presentation/README.md). 최종 실행 수와 PR 검토 상태는 해당 증거에 기록한다. 회사 SSO/실제 자료 운영 인수는 수행하지 않았다.
## 2026-11-16 일괄 결과의 호스트 재조회 경계 수정

- PR #45 독립 검토에서 apply 직후 `onChanged` → App.load의 `dataReady=false` → WorkflowPanel unmount로 결과/복구 토큰이 사라지는 경계를 확인했다. 적용 응답 뒤 자동 부모 갱신을 제거하고, 결과·실패 대상 선택·같은 토큰 재확인을 보존한 뒤 사용자가 명시적으로 목록을 새로고침하게 했다. 명시적 갱신은 결과 화면을 닫는다.
- TDD: 실제 호스트와 같은 unmount 경계 회귀가 수정 전 `NOT_PROCESSED` 대신 호스트 로딩 문구를 받아 실패했다. 수정 후 BulkEditor 3시험과 전체 `npm run check` 통과. scope/API 전환과 401/403의 보호 상태 비우기를 유지했다. 독립 재검토에서 중요 차단 결함을 발견하지 않았다.
- [1440/390 화면 및 재현](pr-assets/bulk/README.md): 실제 컴포넌트/CSS와 합성 API, 부분 결과·재확인·명시적 갱신 및 pageerror 0 확인. 서버 기능은 바꾸지 않았고 전체 DB/최종 CI는 PR의 마지막 커밋 검사를 따른다.
## 2026-11-17 C1 최종 전체 검토 호환 수정 (#49 / PR #63)

- 수정 기준 `3f3e63f`. 실제 `AccessPanel`이 생성하는 `/?app=1&space=...#share-...`를 독립 share 위치로 보존했다. 인증 전 로그인 복귀와 인증 후 기존 `/shares/:id`의 현재 수신자·문서·원본 계보 재인가 조회 및 고정 본문 표시를 연결했다. document 없는 comment와 모순 조합은 거절한다.
- `knowledge.read` 멤버의 개인 API 키·장치 연결 메뉴를 별도 ‘내 도구’ 그룹에 복구했다. 검토 평가는 `changeset.approve`와 현재 검토 자격으로 판단한다. 기존 화면의 관리자 전용 부분과 서버 인가는 바꾸지 않았다. preview의 메뉴·history 취소·상태 정리 주소는 `preview=1`을 유지해 재열기에도 합성 모드다.
- RED7실패/79통과 → GREEN86통과, 보강 포함5파일95통과. 최종 Node24 check: frontend255/Node48/import16/evaluation41, 요구사항251·서버 타입/build/smoke 통과. 메뉴 캡처를 갱신하고 Reader/Writer/Maintain 실제 렌더3장을 추가해 총15장·pageerror0. [최종 로그/화면](pr-assets/convenience-navigation/README.md). 실제 운영 SSO/DB 인수 및 별도 main 통합 한계는 유지한다.


## 2026-11-17 C1 1차 검토 수정 (#49)

- `b7d7cd3`의 history 복귀가 URL 공간만 바꾸고 API 공간은 유지하는 문제를 재현했다. 공통 미저장 경고를 통과한 뒤 outer workspace key를 먼저 전환·재마운트하고, 새 API에서만 복원된 정확한 대상을 해석한다. 실제 Back/Forward와 충돌 작업 ID, 취소한 Back, 이전 공간의 지연 응답 회귀를 추가했다.
- 기존 boards/refinement 진입을 `knowledge.read` 메뉴에 복구했다. 각 화면의 변경·승인·Lint 컨트롤은 기존 capability 검사를 유지한다. `section=tasks` 없이 쓰인 targetKind/targetId는 한쪽·양쪽·빈 값 모두 오류이며 로그인 복귀에서 조용히 버리지 않는다.
- RED10실패/64통과 → GREEN74통과. 최종 Node24 `npm run check` 1회 통과: frontend240/Node48/import16/evaluation41, 요구사항251, 서버 타입/build/smoke. 기존 8장 재확인 및 복구 메뉴 4장 추가, 총12장·pageerror0. [현재 증거](pr-assets/convenience-navigation/README.md). 별도 main 통합과 실제 운영 인수 한계는 그대로 남는다.


## 2026-11-17 C1 사용자 메뉴와 호환 경로 (#49)

- 범위: capability 기반 기본/개인/도구/관리 메뉴와 모바일 상단 검색·새 문서·기존 알림 진입, 검증된 `section/draft/view/version/anchor/targetKind/targetId` 계약과 동일 앱 로그인 복귀를 연결했다. 문서·댓글·공유·기존 탭 URL과 계정/세션 화면을 유지한다. UX-001/003/004/006, SHR-001~003, REV-001/002, ACL-008, IAM-004/005/009의 관련 이동 경계를 보강하며 기존 251개 수용 기준/상태를 바꾸지 않는다.
- 정확한 검토/작업/접근 요청은 ID를 초기 선택 props로 전달하고 현재 인가된 응답으로 다시 확인한다. `/changesets`와 governance access-inbox는 canonical 서비스에서 LIMIT 없는 전체 인가 목록임을 확인했으며 30번째 대상을 회귀 검증했다. 작업은 기존 `/jobs-v2/:id`와 telemetry를 사용한다. 삭제/거부/철회는 일반 오류이며 다른 작업으로 대체하지 않는다. 현재 서버에서 철회 검토는 rejected로 저장되므로 rejected review deep link도 일반 오류로 처리한다.
- 변경 파일: `src/operational/convenience/{types,route,Navigation,ReviewSelection}`와 시험, `App`, `ConsoleShell`, `console`, `api`, `jobs`, `governance`, `workflows`. 계정/공간/세션 변경 시 대상과 보호 상태를 비우고, 문서 편집의 기존 미저장 조건을 메뉴·브라우저 종료 경고에도 연결했다. 안전한 기존 공간 전환 탭은 유지한다.
- 검증: Node24.22.2 `npm run check` 통과 — frontend 47파일/230시험, Node48, import16, evaluation41, 요구사항251, 서버 타입검사, build, static HTTP smoke. RED→GREEN 기록과 실제 1440/390 light/dark 8장·키보드·capability 조합 확인은 [증거](pr-assets/convenience-navigation/README.md) 및 작업 보고서에 있다.
- 한계/인계: UXC-01~10의 공통 이동 기반만 이번 범위다. 새 개인 목록·검색·작성·일반 작업함·저장 보기와 버전/문단 위치의 실제 화면은 후속 작업 전까지 명시적 미연결 상태다. 모델 호출·지식 효과·실제 SSO/DB/운영 인수를 검증한 변경이 아니다. BASE `51129cb`에서 구현했으며 별도 세션의 #44/#59 main 통합 후 충돌 해결·재검증과 독립 검토가 필요하다. push/PR/merge는 이 작업 에이전트가 수행하지 않았다.


## 2026-11-16 필수 편의기능 설계와 구현 플랜

- 사용자 요청: 열린 PR 병합과, 검토한 필수 편의기능 10개 전체의 설계·플랜 작성. 이 문서 PR은 후속 제품 코드 구현을 포함하지 않는다. [설계](superpowers/specs/2026-11-16-essential-convenience-design.md)와 [플랜](superpowers/plans/2026-11-16-essential-convenience.md)에 기존 요구사항·현재 경로·API/저장/권한·인수 기준·12개 PR 의존성을 연결했다. 기준 251개 요구사항과 보호 문서의 의미를 바꾸지 않았다.
- 독립 설계 검토에서 수동 신규 문서의 import-run과 독립된 원본 공개 절차, 정확한 검토/작업/접근 요청 deep link, owner-only 개인 공간의 명시적 소유자 확인 경계를 보완했다. 개인 공간 정책을 팀 공유 승인 우회로 사용하지 않는다.
- 작업 중 main의 전체 로드맵 문서 #44와 PR #45 일괄 편집, #46 공통 검색, #47 문서 탐색, #48 구독·알림 이벤트가 추가됐다. 해당 구현의 API·컴포넌트를 재사용하고 일괄 50건/10분 계약을 유지하도록 설계를 조정했다. 병합됐다는 가정으로 미구현 항목을 완료 처리하지 않는다.
- 검증: 문서 링크·요구사항 ID·10개 작업/12개 PR 대응·기존 기준 불변·diff 및 요구사항 검사. 문서 전용 변경이며 제품 화면 캡처·DB 재검증은 이 PR의 변경 범위가 아니다. 최종 원격 검사와 병합 SHA는 PR 기록을 따른다.

## 2026-11-14 병합 CI의 동시 인증 회귀 수정

- 사용자 후속 요청으로 기능 PR #32~43의 병합이 승인됐다. #37 최종 CI `43601746148`에서 같은 세션의 동시 인증 갱신이 shared row lock을 UPDATE로 승격하면서 교착됐고 유효 세션이 폐기됐다. IAM-004/005/009, QNA-005와 관련된다.
- `server/runtime/auth.ts`에서 세션별 트랜잭션 advisory lock으로 인증 증명 갱신을 직렬화한다. 권한·만료·원본 상한 검사는 유지하며 지식 내용과 평가 주장을 바꾸지 않는다. `server/identity/native-integration.test.ts`의 interactive/poll 동시 요청 두 회귀는 수정 전 실패, 수정 후 통과했다.
- `server/collaboration/review-race.test.ts`는 증명 시작과 만료를 한 시각에서 계산해 30초 상한을 1ms 초과하는 테스트 데이터 경합을 제거했다. Node 24 전체 `npm run check`와 PostgreSQL 17의 인증·기존 역할·질문·협업 9파일 회귀가 통과했다. 최종 원격 CI는 새 커밋에서 다시 확인한다.
- 한계: 이 수정은 동일 세션의 증명 갱신 간 교착을 다룬다. 리뷰에서 지적한 기존 final guard와 directory gate 사이의 다른 잠금 순서 가능성은 별도 재현 대상이며 전체 교착 부재나 실서비스 인수를 주장하지 않는다.
- 최종 제품 조합 확인: 인증 수정 포함 전체 `npm run check`와 PostgreSQL 17 서버 111파일·823시험 통과. 앞서 검증한 통합 트리와의 제품 코드 차이는 인증 수정·동시 요청 회귀·증명 시각 fixture뿐이다. 임시 무볼륨 테스트 컨테이너는 종료했다. 각 PR 최종 커밋의 원격 CI와 실제 병합 결과는 별도로 확인한다.

## 2026-11-14 미이관 공간 3역할 호환 — P5

- 관련 IAM-001/002/004/005/006/009, ACL-001~005/007 및 CORE-008의 권한·원본 상한 불변식. `server/database.ts` 전환 직전 증거와 `server/migrations/113-legacy-roles.sql`, `server/access/legacy-compat.ts`, OIDC·공통 권한·발행·작업 큐 경로 및 운영 앱의 기존 reader 원본 조회를 연결했다. reviewer는 Maintain/Admin/Owner가 아니며 current source ACL, 독립 승인·발행 직전 권한 검사는 유지한다. 실제 지식 품질·에이전트 성능은 측정하지 않았다.
- 독립 권한 리뷰 수정: 이관 전 공간의 query 전용 내부 자격은 변경 제안·원본 등록·편입을 허용하지 않는다. 과거 작성자의 현재 원본·문서·의존·전체 입력 권한을 재인증 강제 없이 승인·발행에 재검사한다.
- 기존 인증 세션과 membership의 전환 직전 증거가 없는 이미 업그레이드된 DB는 자동 복원하지 않는다. [운영자 백업 manifest 계약](LEGACY_ACCESS_RECOVERY.md)은 신뢰키·설치·만료·기존 기록과 회수 상태를 검증한다. 서명은 백업 진위를 대신하지 않는다. 현재 호출자는 fresh UserInfo로 그룹 역할을 좁히며 과거 작성자/검토자는 현재 DB membership·활성·철회와 원본 권한으로 비동기 검증한다. 회사의 실제 디렉터리 및 백업 확인은 수행하지 않았다.
- 검증: 격리 PostgreSQL에서 이전 스키마→최신 migration, 실제 합성 서명 OIDC code flow/UserInfo·세션, 역할별 read/write/queue, 독립 검토·발행·원본 철회, 재로그인·회수·이관과 서명 manifest 합성 검사를 실행했다. Node 24 `npm run check` 통과(프런트 143, Node 48, import 16, 요구사항 251, 서버 타입·빌드·smoke). 파일별 신규 DB 9개에서 권한·OIDC·큐·발행·정책 등 113건 통과. UI 변경은 합성 브라우저 화면 증거와 독립 권한 리뷰가 필요하다.

## 2026-11-14 사용자 알림·검토함 연결 — P3

- CLB-003~007, LIF-002, UX-003 관련. `server/runtime/collaboration-host.ts`, `collaboration-recipient.ts`, `http.ts`, `main.ts`, `server/collaboration/service.ts`, `src/operational/notifications.tsx`와 콘솔 탐색을 연결했다. 알림 읽음과 이메일 수신 상태를 구분하고 배정 전/조회 시 현재 검토 자격과 원본 상한을 검사한다. 읽음이나 기한 확인은 검증·승인이 아니다.
- 유지 순환의 사람 검토 접근성을 개선하며 기존 지식 내용과 발행 상태를 바꾸지 않는다. 지식·에이전트 성과는 평가 계약의 대조 실험 전 목표다. worker는 `AKH_COLLABORATION_DISPATCHER_ID`의 활성 서비스 주체가 설정되어야 시작하며 현재 디렉터리 확인이 실패하면 배정하지 않는다. 이메일은 계획 문서의 승인된 서명 수신자 endpoint, 공개키/issuer, HTTPS origin allowlist, 인증 토큰과 별도 게이트웨이 설정이 모두 있을 때만 사용한다. 실제 회사 설정과 메시지 전송은 수행하지 않았다.
- 검증: Node 24 `npm run check` 통과. 격리 PostgreSQL에서 협업 서비스·인증 HTTP·검토 경합·합성 서명 TLS endpoint와 발송 gate를 실행했다. 화면 캡처, 독립 코드 리뷰, 최종 CI 및 실제 디렉터리/메일 운영 인수는 별도다.
- 독립 리뷰 수정: 배정 철회는 revision을 올리고 오래된 확인을 차단한다. 비동기 조회의 늦은 성공·실패는 최신 결과를 바꾸지 못하며, 설정 저장은 dispatcher 상태와 무관하게 완료되고 worker는 저장 시각부터 계획을 재개한다. 실제 브라우저 1440/390 합성 화면과 오류 캡처는 `docs/pr-assets/product-collaboration/`에 있다.
- 한계: 기한 기반 작업함이며 변경 집합 검토 자체는 기존 변경 검토 화면의 별도 흐름이다. 실제 업무의 검토 비용과 효과는 미측정이다. 발행 자격은 별도 발행 경로에서 재검증한다.


## 2026-11-14 운영 고도화 제외 추가 기능 — 설계 검토 대기

- 사용자 요청: 추가 기능을 구현해 기능별 PR을 열어두기. 이번 요청에서 머지는 수행하지 않는다.
- `main@92bd63c`에서 격리 worktree를 생성하고 [설계 초안](superpowers/specs/2026-11-14-product-completion-design.md)에 현재 현황의 잔여 기능 10개 PR 후보와 검증/의존 관계를 정리했다. 관련 기준은 CORE/QNA, VER/REV, CLB, IAM/ACL, COL/INT, KNO, LIF, EVA/UX다. 기존 요구사항·우선순위·수용 기준은 변경하지 않았다.
- 독립 설계 검토의 두 질문을 반영해 휴지통 복구·제품 보존 실행을 P9에 포함하고, 새 호스트 경로 활성화 전에 삭제/복구 fence를 연결하도록 순서를 보완했다. 열린 PR #30의 탐색/트렌딩과 migration 110은 중복 구현하지 않는다.
- 검증: 설계 상대 링크 확인 및 `git diff --check`. 제품 코드를 변경하지 않았고 의존성 설치·제품 시험·새 기능 PR 생성은 아직 수행하지 않았다. 설계에 적힌 시험은 향후 실행할 기준이다.
- 미확정: 현재 현황 잔여 기능만인지 원래 확장·선택 항목까지인지 사용자 범위 확인과 설계 검토 대기. 첫 실제 업무·회사 설정·운영 인수는 구현/합성 회귀와 구분한다.

## 2026-11-14 요구사항·구현 현황 정비

- 사용자 요청: 브레인스토밍의 필요한 정비를 반영하고 PR 생성·머지까지 진행. `main@9883fbe`에서 별도 worktree로 문서 정비를 수행한다.
- 관련 기준: GOV-007~010, CORE-003/006/009~012, KNO-002~006/012~014, QNA-005/008, UX-003, NFR-001~009, EVA-001~010 및 IAM/ACL·LIF·VER의 알려진 연결/이관/삭제 격차. 기존 251개 ID·우선순위·수용 기준·미검증 상태와 North Star·런타임 규칙·ADR 제안 상태는 그대로다.
- 변경: `docs/CURRENT_STATUS.md`에 확인 커밋·코드/연결 근거·미지원 경계를 모으고, `docs/requirements/MAINTENANCE.md`에 위험도/적용 조건/개발 순서/증거 상태, W0~W3와 기존 기준에 더할 미실행 평가 사례를 기록한다. README·아키텍처·로드맵·보안·에이전트/API·접근·편입·통합·평가·운영·검증 문서의 과거 설명을 시점별로 구분하고 새 현황으로 연결한다.
- 제품 영향: 기존 지식의 반증·조건·연결 갱신 및 검토 비용 평가를 다음 작업으로 구체화한다. 문서 개수·인용 문자열·합성 평가를 누적 품질로 오인하지 않게 한다. 제품 코드·UI·권한·발행 데이터는 변경하지 않는다. 기능/운영 인수나 지식·에이전트 효과의 달성 주장이 아니다.
- 기준 검사: Node 24.22.2에서 `npm ci`, `npm run check` 통과(프런트/도메인 142, Node 48, import 16, 요구사항 251 매핑, 서버 타입, 빌드, HTTP smoke). 상대 링크 218개·새 문서의 요구사항 ID와 보호 파일 8개의 byte-identical 비교를 확인했다. 정비 후 같은 `npm run check`를 다시 실행해 모두 통과했다. 독립 리뷰·원격 CI는 PR의 최종 커밋 기준으로 확인한다.
- 제한: 개인 대화·일부 관리 모듈 연결, 안전한 자동 수집, 기존 3역할 호환, 전체 삭제/복구와 실제 사내 품질/운영 인수는 여전히 미완료다. 필수 출시 조건 재분류·첫 업무 선택·부하 목표 확정은 이 정비에서 승인하지 않았다. 로컬 PostgreSQL/실제 모델/브라우저를 새로 실행하지 않았으며 UI 변화가 없어 화면 캡처는 대상이 아니다. 설치에서 발견한 기존 간접 의존성 moderate 2건은 MISTAKE_LOG에 남긴다.


## 2026-11-11 지식 탐색·통계 — 부분 구현

- DSC-001~005 및 ACL-008, SRH-003/008/010, QNA-001 관련: `docs/requirements/knowledge-discovery.md`에 트렌딩·인용·권한·집계 정의와 미완료 항목을 기록했다. 현재 권고 대상 중 접근 가능한 발행 문서 연결, 최근 갱신 문서의 연결 순위, 기간별 질문 인용과 일별 그래프를 제공한다. 인용 횟수는 독립 근거나 품질을 뜻하지 않는다.
- 서버는 `runtime_answers`의 기존 인용과 전체 입력 envelope를 재검사한다. 일반 사용자는 본인 질문 인용, `usage.read_aggregate` 권한자는 접근 가능한 입력의 공간 집계만 본다. 타인의 질문 본문·질문자·접근 불가 연결은 반환하지 않는다. 공통 인용 순위의 공개 집계 정책은 미구현이다. migration 110은 기존 답변 시각 인덱스만 추가한다.
- 검증: Node 24.22.1 `npm run check` 통과(프런트 147, Node 48, import 16, 요구사항 251, 서버 타입·빌드·HTTP smoke). PostgreSQL 17.6의 격리 DB 기반 지식 탐색·인증 runtime HTTP·접근 제어 3파일 37건 통과. 권한 변경, 비공개 입력, 역할, 대량 데이터 상한 및 동시 요청을 포함한다. 실제 사내 IdP·데이터·운영 및 3만 사용자 부하 평가는 미실행이다.
- 가용성 경계: 답변 원본 4 MiB·공간 상태 16 MiB, 페이지/버전 개수와 입력 계보 상한, 공간별 단일 집계와 시간 예산은 의도적 임시 제한이다. 접근 불가 자료도 용량에 포함되며 오류·대기시간을 통한 간접 추론 및 공간 간 공정성은 미검증이다. migration 110은 운영 중 쓰기를 차단할 수 있어 유지보수 창이 필요하다.
- 미해결: 실행 환경에서 Chromium의 소켓 생성이 거부되고 별도 브라우저는 로컬 서버에 연결하지 못해 1440/390px 실제 화면·키보드·캡처를 확보하지 못했다. PR을 초안으로 남기고 화면 증거를 확인해야 한다. 목업 합성 데이터는 운영 계측이 아니다.

## 2026-11-02 API 키 폐기 시각 표시 — 부분 UI 개선

- IAM-009의 일부: 서버가 이미 반환하는 `revokedAt`을 본인 키 목록과 공간 관리자 목록에 표시한다. 서버 인증·폐기 정책·데이터는 바꾸지 않는다. 전체 요구사항의 운영 수용을 뜻하지 않는다.
- 변경: `src/operational/AgentCredentials.tsx`, `src/operational/AgentCredentials.test.tsx`. 합성 API 응답으로 양쪽 목록에 폐기 시각이 나오는지 확인했다.
- 검증: Node 24.22.1 `npm run check` 통과(프런트 141, Node 48, import 16, 요구사항 연결·서버 타입·빌드·HTTP smoke). 실제 서버·SSO 및 브라우저 1440/390px 확인은 미실행이다.
- 한계: Chromium 시작 시 소켓 생성이 거부돼 화면 캡처를 얻지 못했다. UI 증거 확보 또는 저장소 규칙에 따른 검토자의 명시적 예외 전에는 초안으로 유지한다. 전체 UI/UX 전수조사나 전체 기능 구현 완료가 아니다.

## 2026-10-31 발행 목록 권고 상태 — 부분 구현

- PR #27 독립 리뷰 후 수정: 각 목록 재조회에 별도 순번을 부여하고 이전 요청의 성공·오류가 최신 조회를 덮지 못하게 했다. 조회 중·실패 시 페이지·원본·변경 집합과 선택을 비우고 편집/정련/평가 및 질문의 기존 보호 내용을 가린다. 세션 경계는 기존 epoch를 유지하며 늦은 `/me`가 최신 CSRF를 덮지 못하게 했다. 권고 대상은 서버의 검색 자격이지 공식성·독립 검증이 아니다. 비대상에 서버가 준 생애주기·시행일·대체 지정 정보를 함께 보여 주며 값이 없으면 사유 미확인으로 표시한다. 시계에 따라 클라이언트에서 자격을 재판정하지 않는다.
- 추가 검증: 실제 React 탭 전환에서 실패 이후 보호 페이지가 편집 화면에 남는 RED를 확인했고, 지연된 이전 성공과 새 빈 결과의 경합을 재현했다. 새 회귀는 최신 빈 결과·403·네트워크 실패를 먼저 완료하고 이전 성공을 늦게 반환하여 다른 탭까지 확인한다. 별도 실제 로컬 HTTP 시험은 늦은 이전 `/me`가 최신 CSRF를 덮지 않는지 확인한다. 다른 필수 API 오류도 성공으로 표시하지 않는다. PostgreSQL 17의 인증 runtime HTTP 기존 25건을 재실행해 통과했다.
- 키보드: Linux Alpine Chromium 155.0.8059.84에서 합성 API의 30건을 사용해 390×844 및 1440×900 양쪽 모두 Tab으로 필터에 접근, 화살표로 현재 대상 28건·비대상 1건·미확인 1건 선택, Home으로 전체 복귀, Tab/Enter로 문서 펼침과 다음 페이지 5건 이동을 확인했다. macOS Chrome 155의 Playwright 키 입력은 앱뿐 아니라 단순 HTML select에서도 선택값을 바꾸지 못했고 OS 네이티브 메뉴의 실사용 조작은 별도 미검증이다. 캡처는 합성 API, 인증 HTTP 회귀는 별도 실제 서버/DB다.
- 관련 요구사항 SRH-003/SRH-005/LIF-002의 일부다. `src/operational/App.tsx`는 기존 서버 `currentRecommendation`의 명시적 true/false만 현재 권고 대상/비대상으로 표시하고 누락·미확인은 별도로 둔다. 검토 기한 경과는 독립 표시이며 거짓 또는 자동 폐기를 뜻하지 않는다. 기본은 모든 접근 가능 발행본, 필터는 선택 사항이다. 기존 지식·발행 상태·직접 링크·서버 ACL은 변경하지 않는다. 목록 탐색의 시간·적용 범위 구분을 돕지만 검색 기본 정책과 요구사항 전체 수용을 주장하지 않는다.
- `src/operational/published-list.test.tsx`의 실제 React 상호작용은 합성 HTTP 응답에서 상태 분류·필터·검색·페이지 이동·오류와 세션 만료·공간 전환을 확인한다. `server/runtime/release-safety.test.ts`는 별도 PostgreSQL과 인증된 실제 HTTP에서 상태 기본값, 기한 경과인 현재 권고, 미래 시행, 대체 및 원본 권한 철회를 확인한다. 서버 구현은 변경하지 않았다.
- 검증: Node 24.22.2 `npm ci` 및 수정 후 `npm run check` 통과(프런트 140건 및 Node 48건, import 16건, 요구사항 연결·타입·빌드·HTTP smoke). PostgreSQL 17 전용 DB의 runtime HTTP 파일 25건 통과. Chromium 390×844와 1440×900에서 합성 API로 세 상태와 결과를 확인했고 문서 폭은 각각 390/1440px, 전체 높이는 수정 후 1395/1096px이었다. 캡처는 `docs/pr-assets/published-recommendation/`이며 실제 사내 API나 자료가 아니다.
- 추가 브라우저 검증: 합성 응답 30건으로 25건 첫 페이지에서 다음을 눌러 두 번째 페이지 5건과 마지막 항목을 확인했다.
- 제한: 캡처의 응답은 합성 API이며 실제 서버 응답은 별도 HTTP 회귀에서 검증했다. 공식 여부·적용 조건 전체, 기한별 알림, 운영 인수 및 실제 지식/에이전트 성과는 미검증이다. macOS 네이티브 메뉴 실사용 키보드, 독립 재리뷰와 최종 CI는 별도다.

## 버전 워크플로 법정 삭제 차단 — 부분 안전 경계

- PR #26 리뷰 후: 버전 기록 미지원 사전검사 실패는 redaction/tombstone 전 트랜잭션을 롤백하고 `failed` 영수증 및 운영 감사만 남긴다. 이는 승인도 삭제도 아니며 기존 질문·에이전트의 다른 `blocked`/`completed` receipt 및 tombstone fence를 변경하지 않는다. 이미 존재하는 `blocked` receipt도 소급 면제하지 않는다. 실제 인증 HTTP는 해당 오류를 409로 반환한다. 여섯 EXISTS를 나머지 다섯을 제거한 실제 PostgreSQL 쿼리로 각각 확인했으며 복원 적용 행은 부모 계획이 필요한 제약도 고려했다.
- 검증: Node 24.22.2 `npm run check` 통과. 전용 PostgreSQL에서 기존·신규 삭제, 질문, 인증 HTTP 5파일 43건 통과. 실패 후 질문·발급·사용량 기록, 기존 blocked fence, signed recovery 범위 제외와 gate 대기 중 추가된 이벤트 재검사를 확인했다. 직접 SQL/비공개 helper의 gate 우회 한계는 여전히 존재한다.
- LIF-008/010, SEC-009/010/011, OPS-004 및 CORE-002/005 관련. `server/operations/erasure.ts`는 현재 공간의 버전 메타데이터·이벤트·부분 결정·복원 미리보기/계획/적용 기록 여섯 테이블에 행이 있으면 삭제 실행과 signed recovery replay를 차단하고 미리보기에 존재 여부만 표시한다. `src/operational/operations.tsx`는 미지원 또는 미확인 시 실행 버튼을 차단한다. 법적 보류와 기존 질문·에이전트 차단은 유지한다. 요구사항 전체 수용이나 실제 삭제·복구 구현이 아니다.
- 제한: 버전 workflow HTTP는 현재 런타임에 마운트되지 않는다. 임의 DB client를 받는 trusted helper 및 직접 SQL 삽입은 이 gate를 강제하지 않으므로 삭제 검사와 경합할 수 있다. 이를 공개하거나 발행에 연결하기 전에 공통 gate→공간 잠금→삭제 fence 및 원자적 발행 계약을 구현·검증해야 한다. 단독 wrapper를 발행과 원자적이라고 가정하지 않는다. 이 차단은 미승인 blocked receipt를 승인으로 취급하지 않는다.
- 검증: Node 24.22.2 `npm run check` 통과. 격리 PostgreSQL에서 삭제 및 인증 runtime HTTP 2파일 26건 통과. UI 화면은 실제 서버가 아닌 합성 응답 fixture이며 실제 운영 삭제 검증이 아니다. 메타데이터 실제 삭제, 안전한 복원 및 독립 리뷰는 미완료다. 지식 품질 효과는 측정하지 않았다.

## 자격증명 삭제 선행 실험 — 테스트 전용, 운영 미연결

- 관련 기준: LIF-008/010, IAM-009, SEC-009/010/011, OPS-004, CORE-002/005. 원본·파생 지식의 권한과 법적 삭제 불변식을 지키기 위한 DB 안전성 실험이며 기존 지식·요구사항 수용 상태는 바꾸지 않는다.
- `server/operations/credential-erasure.test-support.ts`와 `credential-erasure-db.test.ts`는 테스트 전용 precursor다. 전용 트랜잭션이 exclusive mutation gate를 workspace 행보다 먼저 얻고 기존 workspace receipt fence를 확인해 공간 내 키·장치·미완료 grant 상태를 바꾸는 실험이다. 교차 공간/소유자 불일치는 fail-closed다. 운영 서버·HTTP·실제 삭제/복원에는 연결하지 않았다.
- `blocked` receipt는 실패나 법적 보류로도 생기므로 승인 증거가 아니다. 별도 운영용 단독 함수가 이를 승인으로 취급하면 권한 없이 취소할 수 있다. 정당한 명시 승인과 receipt 생성, 원자적 취소·최종 삭제, signed recovery ledger 전달을 결합하는 별도 내부 계약이 필요하다. 기존 실행/복원 차단과 write fence는 유지한다.
- 토큰/해시 비식별화, 사용량 보존·귀속, 복원 재적용 및 실제 erasure gate 연결은 미완료다. 이 실험이나 receipt를 삭제 완료로 해석하지 않는다. 지식 품질·에이전트 성능 효과는 측정하지 않았다.
- 검증: Node 24.22.2 `npm ci`와 `npm run check` 통과. 격리된 신규 PostgreSQL DB에서 precursor 5건 및 기존 삭제 회귀를 포함해 19건 통과했다. 실제 운영 승인·복원 경합·독립 리뷰·최종 CI는 별도다.
- PR #25 리뷰 후: 테스트 전용 경합에서 두 backend의 동일 gate 보유·실제 대기·차단 관계를 관찰하고, rollback 실패 주입은 고유 trigger와 단일 grant로 제한했다. 교차 공간 grant/audit도 양방향 차단을 검증했다. gate 양쪽을 각각 제거한 변이에서 해당 assertion이 실패한 뒤 원복했고, 신규 DB 2회 각 21건과 Node 24 `npm run check`가 통과했다. 실제 운영 경로 보장이나 독립 재검토 완료를 뜻하지 않는다.
- PR #24 반영: `origin/main@db9ac2b`를 실제 merge하고 두 작업의 인계·실수 기록을 모두 보존했다. 통합 트리에서 Node 24.22.2 `npm run check`와 전용 신규 PostgreSQL DB의 삭제·수집기 회귀 7파일 35건이 통과했다. 최종 CI·독립 리뷰는 별도다.

## 2026-10-31 수집기 세션 결합 안전 차단

- COL-002/012, ACL-005/007, SEC-002/004 관련: `server/storage/collectors.ts`는 신뢰 가능한 artifact-세션 결합과 서버 제외 정책이 없는 OpenCode 2.2.2 assistant 및 synthetic 자동 수집을 `ARTIFACT_SESSION_UNVERIFIED`로 차단한다. 기존 성공 테스트를 차단 테스트로 교체한 것은 의도적인 기능 축소이며 요구사항 완료가 아니다. 수동 HTTP 요청은 `tool:"manual"`만 허용하고 다른 도구명이나 collection/external 필드는 거부한다. 이는 자료 내용의 출처가 사실임을 보장하거나 직접 내부 서비스 호출을 제한하는 검증은 아니다.
- `server/storage/collector-isolation.test.ts`는 실제 익명화 fixture에서 위조 요청이 수정 전 성공하는 RED와 수정 후 차단을 검증한다. 저장 호출 이전 실패이므로 해당 route에서 저장·후속 전송이 시작되지 않는다. `collectors.test.ts`, `routes.test.ts`, storage/fixtures 설명도 갱신했다. 기존 지식의 내용이나 발행 상태를 바꾸지 않는다.
- 검증: Node 24.22.2 `npm run check` 통과. 별도 PostgreSQL 17 컨테이너의 수집기 단위·실제 storage HTTP·인증된 runtime HTTP 4파일 12건 통과. 실제 fixture 재포장과 수동 수집 메타데이터 위조는 수정 전 각각 201로 처리되는 RED를 확인했고 수정 후 거부됐다. 첫 전체 검사의 테스트 타입 오류는 수정 후 재실행해 통과했다. 최종 CI는 별도 확인한다.
- 추가 검증: 위조 도구명을 수동 HTTP에 제출하면 수정 전 201이었던 RED가 수정 후 400이며 저장 행이 늘지 않는다. `manual`은 개인·미검증으로 저장된다. runtime 마운트와 인증·CSRF 경로를 확인하고 PostgreSQL 17 대상 4파일 14건 및 Node 24 `npm run check`를 재실행해 통과했다. 직접 `StorageService.ingestText`를 외부 입력에 노출하는 별도 호스트는 이 HTTP 가드를 우회하므로 신뢰 계약을 지켜야 한다.
- 한계: trusted authority, 실제 호스트/원격 세션 결합, 현재 권한 및 원본 범위의 완전 검증은 구현하지 않았다. 재활성화에는 정확한 artifact와 세션의 검증된 결합 및 위조·제외·교체·권한 회귀와 실제 호스트 검증이 필요하다. 품질·운영 인수 효과는 미평가다.

## 법적 삭제 에이전트 경계 진단 — 부분 구현

- PR #22 독립 리뷰 수정: 교차 공간 grant/audit FK가 허용되는 상황에서 이웃 행 존재가 분류에 노출되는 결함을 재현했다. `agentDataBoundary`는 직접 소속만 공개하고 `agentDataUnsupported`와 실행·복원의 기존 보수적 참조 검사 `hasAgentData`는 유지한다. 직접 분류와 전체 차단값은 다를 수 있다. 비소유 Admin의 원본 ACL/전체 공간 Owner 검사와 미리보기 뒤 사용량 추가 시 실행 차단도 실제 DB로 검증했다. Node 24.22.2 `npm run check`와 별도 PostgreSQL의 신규·기존 삭제 회귀 14건(기존 게이트 경합 회귀 포함)이 통과했다. CI·독립 재검토는 별도다.
- 관련 요구사항: LIF-008/010, IAM-009, SEC-009/010/011, OPS-004 및 CORE-002/005의 삭제·권한·복구 경계. 수용 상태는 변경하지 않았다.
- `server/operations/erasure.ts`, `server/operations/erasure-agent-boundary-db.test.ts`, `docs/OPERATIONS.md`와 이 기록: 권한 검사된 미리보기에 공간 전체의 다섯 분류별 존재 여부만 추가한다. 자료와의 관계는 unknown이며 기존 fail-closed 실행/복원 게이트와 write fence를 완화하지 않는다. 기존 지식과 본문을 수정하지 않는다.
- 검증: Node 24.22.2 `npm ci`, `npm run check` 통과(기본 테스트·요구사항 251·서버 타입·빌드·smoke). 전용 임시 PostgreSQL DB에서 신규 및 기존 삭제 회귀 11건 통과. CI·독립 리뷰와 실제 운영 검증은 별도다.
- 한계: 공간 내 관련 없는 기록도 삭제를 차단한다. 진단은 시점별 스냅샷이지 승인이나 자격증명 취소·사용량 삭제/보존·복원 지원의 완료가 아니다. 해당 기능과 동시성/복구 계약을 후속 구현해야 한다. 지식 품질/에이전트 성능 개선은 측정하지 않았다.

## 운영 기능 체크포인트 — 부분 구현

- 후속 통합: PR #18의 배포된 migration 009를 보존하고 기존 브랜치의 접근 이관 migration을 010–015로 순서대로 조정한다. API 키와 기존 서비스 자격증명의 범위·현재 권한을 각각 검사하며, 원본 반출 승인과 모델 사용량 계측을 함께 유지한다. 이 통합의 최종 테스트·CI 결과는 PR을 기준으로 확인한다.
- SystemOne은 `AGENT_KNOWLEDGE_HUB_SYSTEMONE_DESTINATION_ID`에 등록된 정확한 endpoint와 `assessment` 목적의 모든 원본별 명시 승인이 없으면 전송을 거부한다. 결과 반환 전 현재 계보·권한·정책도 다시 확인한다. 이는 사내 승인이나 실제 모델 품질 검증이 아니다.
- 법적 삭제의 임시 안전 경계: 공간에 API 키·장치·모델 계측 기록이 있으면 자료별/전체 삭제와 복원 재적용을 차단한다. 삭제 이력이 있는 공간의 새 키·장치 발급과 계측도 보수적으로 차단한다. 이는 자격증명 취소·비식별화, 계측 보존과 동시 요청·복원 경합 처리의 완성본이 아니며 후속 PR에서 실제 지원을 구현해야 한다. 삭제가 차단되면 성공이나 전체 삭제로 보고하지 않는다.
- 관련 범위: ACL/IAM, COL, EDT, VER, JOB, SEC, OPS와 CORE 지식 순환. 기존 요구사항의 전체 수용 완료가 아니다. 변경은 `server/`의 접근·작업·정책·편입·보존·운영 모듈과 `src/operational/`, K8s 배포 도구 및 관련 테스트에 걸친다.
- Node 24 환경에서 `npm run check`와 파일별 독립 PostgreSQL DB를 사용하는 `npm run test:server` 83개 파일이 현재 통합 트리에서 통과했다. 이는 이후 main 통합 및 최종 CI 결과를 대체하지 않는다. 초안 복구 경로는 실제 서버 핸들러에서 인증·CSRF 뒤 연결하고 회수 검사를 유지했다.
- 질문·버전 메타데이터·협업의 일부 호스트 연결, 보존의 주기 실행 및 전체 삭제 범위, 수집기 권한, 실제 브라우저·최종 이미지/IdP·운영 인수는 미완료 또는 미검증이다. Owner가 확인되지 않은 기존 공간은 격리되므로 기존 3역할 호환성에 제한이 있다. reviewer를 Owner로 추정하지 않는다.
- 실제 DeepSeek 평가 `evaluation-05a7d023183e5e89`: 33개 배정 중 32개 완료, 1개 시간 초과, 인용 안전성 실패 3개, 합성 라벨 일치 10개, 종료 코드 1이다. 품질 및 업무 효과는 미확인이다.

## 2026-10-30: 최신 main K8s 운영 사이트 도구 내용 통합

- 내용 출처: `fb8298acca1987fb5f62a62a260534f29bc20594`(PR #15). 활성 merge 기준 `a9cfcdbdd5ce842e07e77def277ddb3132187c15` 이후 16개 파일의 추가분을 현재 작업에 적용했다. 이 기록은 내용 반영이며 최신 커밋의 ancestry 병합 완료 선언이 아니다. coordinator가 기존 merge 완료 후 실제 최신 커밋을 병합해야 한다.
- OPS-001~014, NFR-001~010, SEC-007~013, JOB-007 관련: `prepare-site.mjs`의 STG/PROD 비밀 없는 site·Ingress/제한 egress·Quota·digest 생성, `deploy-site.mjs`의 Secret 사전 검사·동일 이미지 승격·DB→migration→App 순서, `release.mjs`의 namespace/DB/TLS/NetworkPolicy 가드를 유지한다. 기존 전체 운영 후속 구현·테마·브랜드 기록은 보존했다.
- 호환: site migration은 공통 `release.mjs` factory로 `migrate:server`와 DATABASE_URL/선택적 ACCESS_BOOTSTRAP_JSON만 전달한다. 앱의 모델·감사 Secret이나 PVC를 상속하지 않는다. Secret 환경변수 allowlist를 명시된 운영 키로만 확장하고 감사/서명/metrics 강도·독립성 및 사용 시 backup keyring 일치를 검사한다. 권한·issuer·기능·목적지 registry 정책을 Secret으로 덮어쓸 수 없다.
- site는 base의 blob/audit/backup PVC를 환경별 namespace에서 상속한다. DB·backup staging·blob·audit·backup 총 5 PVC/45Gi에 맞춰 synthetic fixture와 예제 quota를 60Gi로 수정했다. StorageClass는 DB와 일반 PVC에 적용한다. 이는 실제 용량 보증이 아니다. 선택적 명시 registry는 실제 코드 계약의 주소/용도/분류만 허용하며 기본 `[]`다. egress/업로드 자체는 원본 반출 승인이 아니다.
- CI K8s job은 `scripts/k8s/test.mjs`로 오직 native Kind·전용 DB가 필요한 `operations-backup-db.test.mjs`만 제외하며 미실행을 출력한다. 나머지 operations/TLS/format/release 시험을 포함한다. 해당 Kind 게이트는 별도 실제 실행 근거로만 보고한다. CI aggregate `check`에 k8s를 포함한다.
- 이 단위의 실제 검증: Node24 `node scripts/k8s/test.mjs` **38/38 통과**(대상 upstream deploy/prepare/순차 배포 시험과 기존 release/manifests/local-secrets 및 나머지 operations 포함). native Kind·전용 DB 시험 하나는 runner가 명시적으로 미실행 표시한다. 4개 실행 모듈 `node --check`, `git diff --check` 통과. synthetic STG/PROD 생성물의 production guard 모두 통과, 미설정 STG/PROD 템플릿 모두 거부. 렌더된 환경별 4 일반 PVC + DB claim의 namespace/StorageClass·5 PVC/60Gi quota·기본 빈 registry를 별도 assertion으로 확인했다. 최신 `productionFailures` 가드 본문과 보조 함수는 upstream과 byte-identical임을 확인했다. 실제 클러스터 배포·IdP/TLS/CNI 집행·운영 인수·최신 GitHub CI 통과를 이 내용 반영으로 주장하지 않는다.

## 2026-10-30: 1차 K8s 운영 사이트 생성/검증/순차 배포 도구 (PR 작업)

- 기준: 최신 main `31b7d9a`의 서버/OIDC/DB/Kustomize 구조 유지. OPS-001~014, NFR-001~010, SEC-007~013, JOB-007 등 운영/영속성 계약에 대한 기능 보강이며 기존 인수 상태는 변경하지 않는다.
- 구현: `scripts/k8s/prepare-site.mjs`로 STG/PROD 비밀 없는 오버레이·Ingress controller ingress·OIDC/model 제한 egress·Quota·digest 생성, `deploy-site.mjs`로 정적 리소스/실제 Secret/동일 이미지 승격 점검과 DB→migration→App 순서 보장. `release.mjs`의 네임스페이스/DB/Ingress/NetPol 미비 거부. 예제·CI synthetic fixture 및 테스트 추가.
- 보안/격리: Secret 값을 git/파일 출력하지 않으며 앱 DB URL과 DB password 일치 검사, PROD 명시적 승인 필요. 실사용 DNS/인증서, 실제 네트워크 집행, 백업 복원, 서버 측 인수·부하는 추가 검증 필요.
- 검증: CI에 K8s unit + Kustomize 렌더링/production guard 테스트 추가(실행 결과는 GitHub Actions에서 확인). 로컬 도구 환경의 kubectl/사내 클러스터·실제 운영 배포 시험을 수행했다고 주장하지 않는다.

## 2026-10-30 전체 운영 기능 후속 구현 — 진행 중

**부분 구현을 전체 완료로 보고하지 않는다.** [계속 실행 계획](superpowers/plans/2026-10-30-complete-operational-workflows.md)의 파일·작업 DB를 분리해 진행하고 있다. 기본 체크아웃은 `main`, 후속 작업은 기존 전용 워크트리의 `feat/complete-operational-workflows`다.

- 공간 권한: `389c7c1`의 `server/access/`, migrations006–009, core/runtime 연결은 개인/팀 소유권·5역할·팀/접근 그룹·수락형 초대/소유권 이관·정책 CAS·지정된 독립 인간 검토·현재 권한과 교차하는 제한 토큰·원본별 반출 정책을 구현한다. reviewer를 Owner/Admin으로 자동 승격하지 않는다. 미지정 레거시 공간은 격리하며 `ACCESS_BOOTSTRAP_JSON`으로 검증한 주체를 명시적으로 채택한다. ADR 004/005의 조직 승인이나 사내 권한 인수 완료를 뜻하지 않는다.
- 작성·협업: `server/workflows/`, migration020, `src/operational/workflows.tsx`는 개인 초안 revision CAS, 승인 전 발행본과 분리한 편집/버전 복원 제안, 트리 순환 방지·속성·보호·보관/휴지통/현재 권한 복구, 버전·정확한 문단 발췌에 고정한 댓글/수정/삭제/해결, 구독·멘션·현재 권한 알림/환경설정, 즐겨찾기/최근 조회, 개인 템플릿, 접근 요청, 불변 원본 정정·철회를 제공한다. 템플릿의 원본 페이지·버전·독자 제한도 제안까지 유지한다. 원본 정정의 독자 재검사·정정 계보 기록을 등록 트랜잭션 안에서 수행하고 새 본문은 미검증으로 시작한다.
- 웹: `src/operational/access.tsx`와 앱/API 연결에 공간 선택·권한 경로·개인/팀 공간 생성·초대/이관·접근 그룹·grant/회수·공개 범위·독립 검토 정책·수신자 지정 고정 버전 공유·제한 토큰을 추가했다. 선택 공간은 `X-Space-Id`이며 전환하면 보호 화면/입력을 새 컴포넌트로 분리한다. 초기 공간이 없는 사용자는 내용 API를 호출하지 않고 공간 생성부터 시작한다. 문서·댓글·공유 링크는 불변 공간/문서 ID와 현재 권한으로 열며 로그인 복귀 힌트에는 ID만 저장한다. 브라우저 저장 차단 시 안전한 고정 앱 복귀를 유지한다.
- 에이전트/개인 커넥터: `server/agents/`, migration023, 기존 `scripts/wiki-connector/client.mjs`를 연결했다. `/api/v1/agent/{search,read,context,artifacts,changesets,outcomes}`, `/api/v1/agent/mcp`, `/api/v1/connector`는 같은 서버 신원·현재 ACL·원본/입력 계보·core 제안 서비스를 사용한다. SDK 도구는 `wiki_search/read/get_context/submit_artifact/propose_change/report_outcome`이며 승인·발행 도구가 없다. 원본/제안/성과 요청 영수증은 도메인 트랜잭션과 함께 저장하고 재시도도 현재 접근을 재검사한다. 컨텍스트 예산은 보수적인 UTF-8 바이트 상한이며 모델 tokenizer의 실제 token 수로 표시하지 않는다.
- 개인 동기화는 PostgreSQL의 사용자별 작업 revision과 기존 연결 중 동기화·충돌 보존 경로를 사용한다. 정확히 선택한 revision을 제안 commit에서도 검사하고 발행본은 바꾸지 않는다. `local.copy`는 명시 위임과 모든 원본의 현재 반출 정책을 함께 요구한다. 서비스 실패 시 기존 로컬 캐시를 열지 않는다. 상시 로컬 daemon은 추가하지 않는다. 에이전트 성공/실패 보고는 `verified:false` 관측이며 `agent_review_signals`로 재검토를 요청할 뿐 독립 실행 증거나 공식 지식으로 자동 승격하지 않는다.
- 관련 기준: GOV-003/004, IAM-002/005/009/010, ACL-001~014, EDT-001~007/011, VER-001~010, REV-001~009, SHR-001~009, LIF-001~004/007, INT-001/002/006, CORE-002~011과 KI-01/02/04/05/06/07의 구현 경로다. 원래 수용 기준·상태를 이 설명만으로 accepted로 바꾸지 않는다.
- 실제 실행 근거: 17:38의 공유 트리에서 `npm run check`(전체 npm 시험·251개 연결·서버 타입·빌드·정적 HTTP smoke)와 real-DB `vitest run server --maxWorkers=1` 220/220건을 실행했다. 이후 추가한 원본 정정 경쟁/검증 계승 회귀를 포함한 최종 결과는 이어지는 실행 기록과 PR의 최종 head CI를 기준으로 한다. MCP SDK1.32.2 클라이언트와 기존 로컬 커넥터가 실제 loopback HTTP/DB/임시 작업 디렉토리에서 동작하는 시험을 추가했다. 실제 OpenCode/Codex/Desktop 제품 호스트·Windows 검증으로 확대하지 않는다.
- 후속 연결 검증: 22:08의 작성/편입 API·권한/DB·SDK/커넥터·세션/프로브·대기열 접수/조회/취소 대상 19파일 **104건 통과**, `npm test`의 프런트엔드76건+Node48건·요구사항251개 연결·빌드 통과. 실제 서비스 요청은 202 접수와 실행 결과를 구분하고 원래 주체·살아 있는 부모 세션/현재 디렉터리·전체 입력 계보·fence를 효과 commit 직전에 검사한다. 이전 MCP 경로도 운영 설정에서는 직접 모델을 실행하지 않는다. 저장 답변 재열람도 질문자와 현재 전체 입력 권한을 재검사하고 내부 ACL은 응답하지 않는다. 전체 서버 타입 검사는 별도 작업 중인 `operations/released-imports.ts:160` 진단이 남은 시점을 포함하므로 위 대상 검증을 전역 최종 통과로 표시하지 않는다.
- 실제 모델 평가는 `deepseek-flash` 합성33개 배정 중32개 완료/1개 시간 초과/3개 인용 안전성 실패였다. 고정 합성 라벨 일치는10개이며 실제 업무 성공률이나 지식 활용 효과로 해석하지 않는다. 비용/토큰의 불완전 합계는 null로 보존했고 평가 종료 코드1을 통과로 바꾸거나 정답을 수정하지 않았다.
- 계속할 작업: 파일/blob·수집/가져오기/내보내기, 지속 작업/일정/예산/실제 모델 계측, 주장·시간·경험 정련/고정 대조 평가, DB+blob 일관 백업/삭제 재적용/감사 외부 보호/관측과 운영 UI는 별도 모듈 작업 및 최종 runtime 통합·실제 kind 검증이 진행 중이다. 현재 화면·서비스가 있다는 이유로 모든 251개 수용 조건·사내 운영 인수나 지식/후속 에이전트 성능 개선을 완료로 표시하지 않는다. 실제 새 브라우저 390/1440px·최종 이미지/IdP/모델/10사용자 혼합 부하·독립 보안 리뷰·PR/CI/머지는 계속 실행해야 한다.
## 2026-10-30 PR #14 테마 대응 브랜드, 최신 운영 콘솔과 통합

- PR #16의 운영 콘솔·관리 목업·대시보드를 보존하고, 기존 PR #14를 최신 main에 통합했다. 랜딩·데모·`ConsoleShell` 브랜드 마크는 모두 원형을 유지한 `BrandMark` SVG 및 의미 기반 색상 토큰을 사용한다. 마크의 원본 경로/8·6 stroke는 `src/ui/brand-mark.json`을 공유한다.
- `src/main.tsx`는 운영/목업 `preview` 진입 로직을 유지하면서 저장된 테마와 동적 파비콘 반영을 추가했다. 원래 PR의 `src/operational/App.tsx` 헤더 변경은 새 구조의 `ConsoleShell`을 사용하도록 대체했다. 기존 서버·권한·편입·위키 정책 및 251개 요구사항 상태는 변경하지 않는다.
- 런타임 SVG와 favicon만 자동 색 변경한다. PNG·OG·ICO·배너는 고정 Plum 원본이고, 다른 팔레트 선택 UI는 별도 작업이다. 검증은 새 병합 커밋의 CI 결과를 기준으로 판단한다.

## 2026-10-30 에이전트 운영 콘솔 · 누락 관리 UI 목업

- 사용자 요청: 에이전트에게 지식을 제공하는 환경을 중심으로 웹 UI·필수 관리 누락을 재점검하고 미구현 기능은 목업으로 제공, 의미 있는 대시보드·목업 제시, 최신 코드 기준 PR/머지까지 진행. 추가 질문 없이 판단하도록 위임했다.
- 기준: 처음 `e89921c`에서 시작했고 작업 중 병합된 최신 `origin/main@31b7d9a`를 통합했다. 실제 ImportWorkbench/AccessManager, Organization·Team/공간5역할/초대, 독립 검토 자격·분류와 서버 편입 worker를 보존한다. 최신 구현을 과거 설계 문구 때문에 목업으로 덮지 않는다.
- 구현: 공통 그룹별 사이드바/모바일 접기·hash 직접 링크/뒤로·앞으로/테마·본문 이동, 운영 개요의 접근 지식·검토/발행 대기·본인 작업/실패·조치 링크·7일 호출, 정확한 계측/분모·미점검/미수집/미평가 경계. 기존7개 업무 화면과 실제 자료입력/접근관리를 보존했다.
- 독립 `/?preview=1`: 네트워크/로그인 없는 메모리 API/관리 상태. 사용자/초대/역할·세션 영향, 공간/소유/공개, 서비스 주체·허용 범위 토큰 메타데이터/폐기, 연동/예약·예산/중지, 검토·공유/반출, 초안/복원/보관/휴지통·첨부/협업, 알림/감사·복구, 평가/성과 환류를 시연한다. 일부 동작은 설명·확인 시나리오이며 실제 기능 성공으로 표시하지 않는다. 251개 원 요구사항 검색/25건 페이지·수용 기준·탐색 경로를 제공하며 기준/운영 상태를 올리지 않는다. [계약/한계](AGENT_CONSOLE.md).
- 변경 파일: `src/entry.ts`, `src/main.tsx`, `src/operational/App.tsx`, ConsoleShell/Overview·console.css, preview adapter, management state/ManagementPreview/PreviewDialog/ConsoleTable/FeatureCoverage/ImportPreview와 테스트, `UsageDashboard.tsx` 계측 설명, 이 인계/README·설계/계획·화면 계약과 캡처.
- 관련 ID: GOV-001/003/005/009, IAM-001~011, ACL-002/010/011, SHR-001~012, EDT/VER/LIF의 편집·복원/보존·반출, REV-001~009, MGR/JOB/INT/SEC/OPS 관리·관측, EVA-001~010, UX-001~008, CORE-002~012. 화면 연결/목업은 해당 ID의 전체 수용 기준 충족 증거가 아니다. 기존251개/35개 인수 시험과 North Star·런타임 규칙 의미는 보존한다.
- 독립 리뷰: 중요3건(늦은401, 목록실패의0건표시, 초대취소→중지→활성화 우회)을 실제 RED→GREEN으로 수정했다. 이전 세션의 늦은 목록 응답도 무시한다. 최신 편입 worker와 별도 예약 유지관리의 범위 오인을 수정했다. 브라우저에서 발견한 dialog Tab 순환/Escape/초점복귀도 수정 후 재실행했다.
- 실제 로컬 검증: Node24.22.2 `npm ci`/`npm run check` 통과. 클라이언트61개+Node48개+파서/정리15개, 요구사항251개, 서버 타입 검사, 빌드·HTTP smoke. 390/1440px 18화면(36레이아웃),62 UI assertion, API요청0/pageerror0. 실제 앱 라우트는 합성 HTTP 계약으로 AccessManager·ImportWorkbench/0건집계 보존7검사, 세션/오류3검사를 통과했다. [원시 결과·화면·동일fixture 전후](pr-assets/agent-console/README.md).
- 전후: 최신main과 같은244호출fixture의 실제 앱 사용량 화면, 모바일 첫결론779→522px/문서2738→2616px, 데스크톱581→380px/문서2280→2145px. 그래프14px·표행53.75px 유지. 새 개요 첫판단232px/369px(데스크톱/모바일). 화면 레이아웃 비교이며 지식/에이전트 효과나 성능 개선 주장이 아니다.
- 남은 한계: 전역 계정/세션 관리·서비스 주체/Bearer·수신자grant·예약 유지관리·범용편집/공유/수명주기·알림/운영 제어는 추가 서버 연결/검증 필요. 이 작업의 브라우저 검증은 실제 사내SSO/DB/LLM·운영 인수나 전체 접근성 인증이 아니다. PostgreSQL/다중OS·Docker 회귀는 PR의 실제 CI 결과를 따른다. PR/머지 결과는 후속 원격 기록으로 확인한다.

## 2026-10-30 PR #12와 공개 랜딩 PR #13 통합

- 최신 `main@e89921c`를 PR #12에 병합했다. `server/runtime/auth.ts`의 충돌은 Organization/개인 공간 권한 처리에 필요한 import와 공개 랜딩의 `workspaceHref` import를 모두 보존해 해결했다. OIDC 로그인 성공 후 `/?app=1`로 복귀하며, 자료 편입·조직/Team/공간 권한 동작은 유지한다. 이 인계 문서의 두 작업 기록도 모두 보존했다.
- 관련 기준: GOV-001/003, ACL·INT·SEC 및 CORE 순환. 요구사항·North Star·런타임 위키 규칙의 의미는 변경하지 않았다.
- 통합 상태에서 `npm ci`와 `npm run check`를 통과했다. 클라이언트 43개, Node 회귀 48개, 편입 순수 15개, 251개 요구사항 연결, 서버 타입 검사, 프로덕션 빌드와 정적 HTTP smoke를 확인했다. `git diff --check`도 통과했다.
- PostgreSQL/OIDC 통합과 OS·Node 매트릭스·Docker 회귀는 이 병합 커밋의 GitHub CI를 기준으로 확인한다. 이번 충돌 해결이 실제 사내 IdP·모델 의미 품질·운영 인수를 새로 검증했다는 뜻은 아니다.

## 2026-10-30 웹 자료 편입과 실제 조직 권한 구현 (구현 PR #12)

- 사용자의 추가 지시: 이전 열린 PR 모두 머지, 설계뿐 아니라 실제 기능 구현·PR. #11을 main@1e521db1에 squash merge했다. 이번 변경은 그 뒤의 구현이다.
- 실행 계약: [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md). 개인 붙여넣기/파일 업로드, 안전한 파싱, 영속 worker/재개/취소, 기존 위키와 모델 정리, 원본 공개 검토, 독립 지식 검토/원자 발행, 같은 REST/SDK MCP 경로를 구현했다. 개인 Owner는 본인 전용 위키 저장 경로를 사용한다.
- 실제 권한: Organization Owner/Member, Team, 개인/조직 공간, 직접/Team 5역할·만료·실효 경로, 수락/만료/취소 초대, 마지막 Owner, 지정 검토자, 감사·철회·명시적 기존 공간 이관. OIDC 그룹은 이관 후 제품 grant를 덮어쓰지 않는다. 원본 ACL은 Owner에게도 상한이다.
- 주요 파일: server/imports/*, server/access{,-http,.test}.ts, migrations/006·007, runtime auth/http/mcp/model, repository/publication, domain imports/access, 운영 UI ImportWorkbench/AccessManager. 초기 App1/DB1에서 원본 조각은 제한된 PostgreSQL bytea로 보관하며 별도 broker/object store를 필수화하지 않는다.
- 관련 요구사항: COL-002/005/012/013, JOB 지속 작업, GOV/ACL/SHR/REV/VER/INT/SEC/OPS와 CORE 순환. 기존 251개 요구사항·35개 인수 시나리오는 변경하지 않았다. North Star·wiki/SCHEMA.md 의미도 변경하지 않는다.
- 현재 로컬 근거: npm run check 통과(기존 테스트 + 편입 순수 15개, 서버 타입/빌드/요구사항/정적 smoke), PGlite 보조 DB에서 새 편입/HTTP/SDK MCP·접근 관리 회귀 24개 통과. 실제 PostgreSQL 첫 CI는 116개 중 115개 통과 후 기존 /me DTO 호환성 기대 한 건으로 실패했고, 미이관 공간의 응답 형태를 보존해 수정했다. 개인 저장·OIDC 회수·Triage/사용량 회귀를 추가했다. 최종 PG CI는 PR 커밋 상태를 따른다.
- 의미 품질은 실제 외부 LLM/실사용 자료 대조로 아직 측정하지 않았다. 브라우저 Chromium 153에서 실제 웹 붙여넣기→서버 분석→개인 정리→별도 원본 공개 검토→독립 지식 승인/원자 발행→독자 열람을 통과했다. 1440px/390px에서 가로 넘침/JS 오류가 없었고 캡처·JSON 증거는 docs/pr-assets/ingestion에 둔다. QA 모델은 결정적 계약 fixture다. Company/Guest/Public·범위 Bearer/서비스 주체·실제 로컬 커넥터 통합·전체 251개 구현/운영 인수 완료라고 표시하지 않는다. Organization 관리 전환·Team 생성/멤버 추가/공간 Write 부여도 같은 실제 UI에서 확인했다. 500개 발언의 원문 근거를 청크 통합 후에도 보존하는 회귀를 추가했다. 아래 이전 인계는 당시 변경 범위의 기록이다.

## 2026-10-30 공개 랜딩과 Memory·RAG·Wiki 역할 안내

- 사용자 요청: 웹 첫 진입에 랜딩페이지를 두고 왜 위키를 쓰는지, Memory·RAG와 무엇이 다른지 명확히 설명한다. 기준 `main@1e521db`에서 별도 브랜치로 구현하며 병렬 진행 중인 웹 편입/권한 PR의 완료를 전제하지 않는다.
- 화면: 기존 브랜드 심볼/plum 토큰의 라이트·다크 소개, 목적·원본→연결 지식 예시, 역할 비교표, 일주일치 대화의 Memory/RAG/Wiki 선택형 결과, Ingest→Review→Query→Lint & Feedback, 근거/권한/사람·에이전트 원칙, FAQ와 시작 버튼. 실제 처리 결과/장기 목표와 현재 기능을 구분한다. 새 안내 계약은 [LANDING_PAGE.md](LANDING_PAGE.md).
- 진입: `/`는 로그인·API 없이 소개를 표시한다. `/?app=1` 서버 UI와 `/?demo=1` 합성 시연은 각각 지연 로드한다. 기존 데모 hash 경로를 유지하고 OIDC 성공 후에는 고정 `/?app=1`로 복귀한다. 원본/지식/ACL/승인/발행 엔진을 변경하지 않으며 루트 주소 자체가 권한을 부여하지 않는다.
- 변경 파일: `src/landing/`, `src/entry.ts`와 테스트, `src/main.tsx`, `index.html`, `server/runtime/auth.ts`의 성공 redirect와 기존 DB 회귀 assertion, 기존 명시 데모 테스트명, README·ARCHITECTURE·OPERATIONAL_SETUP·이 인계 및 화면 계약/증거.
- 관련 기준: GOV-001, CORE-002~007·009의 목적과 순환을 사람이 이해하도록 설명한다. 기존 251개 요구사항/운영 인수 상태를 완료로 바꾸지 않는다. 새 지식·후속 에이전트 성능 효과를 주장하지 않고 EVALUATION의 대조 실험 대상으로 유지한다. North Star·런타임 규칙의 의미는 변경하지 않았다.
- 실제 검증: Node 24.22.1/npm 11.9.0에서 `npm ci`, `npm run check` 통과(클라이언트 43개 + Node 48개, 251개 연결 검사, 서버 타입 검사, 빌드·정적 HTTP smoke). 새 테스트는 공개 렌더링의 API 미호출/앵커/CTA와 명시 진입 경계를 검증한다. `git diff --check` 통과.
- 브라우저: production dist + Chromium153에서 320/390/768/1440px의 페이지 가로 넘침 없음, 소개 API/앱 청크 미요청, 선택 예시·Enter·FAQ·테마/저장 차단·모바일 표 내부 스크롤, 서버 로그인 안내(합성401)·데모/hash 이동을 확인했고 pageerror는0개다. [캡처와 고정 결과](pr-assets/landing/README.md).
- 제한: 브라우저의 보호 앱 진입은 합성401로 확인했다. 실제 IdP/DB 로그인·운영 배포·모델 의미 품질·SEO·전체 접근성 인수를 로컬에서 새로 검증한 것은 아니다. OIDC 성공 redirect assertion은 PR CI의 PostgreSQL 회귀에서 실제 실행한다. 클라이언트 렌더링과 query 기반 앱 진입을 유지한다. GitHub CI 결과는 PR의 실제 상태를 따른다.

## 2026-10-30 로컬·개인·팀 GitHub식 권한 설계 (문서만)

- 사용자 요청: 기존 로컬/개인/팀(공유) 컨셉에 GitHub식 권한을 설계하고 PR로 제출한다. 이 작업은 설계 제안이며 런타임 권한 구현·운영 인수·자동 머지 요청이 아니다.
- 기준: `main@ec148ef9`의 실제 OIDC·DB 세션, 3역할·자료 allowlist·전체 모델 입력 계보·승인 ACL 검사를 확인했다. 합성 로컬 커넥터와 운영 서비스 통합은 아직 미완료다. 과거의 서버 미구현 설명으로 최신 코드를 판단하지 않는다.
- 새 문서: [ACCESS_CONTROL.md](ACCESS_CONTROL.md)와 [ADR 005](adr/005-github-style-access-control.md). 로컬 위치/개인·팀 소유권/Private·Team·Company/공간별 Read·Triage·Write·Maintain·Admin을 분리한다. 팀 Owner/Member·접근 그룹·기본 none·자료 제한·정제본 공개·수신자 한정 공유·개인 revision 제안·독립 사람 검토·토큰 상한·철회/소유권 이전·사용량/관리 UX를 정의한다. ADR 005는 **Proposed**이며 ADR 004의 상태나 North Star 의미를 변경하지 않는다.
- 이관: 현행 `workspaces` 공간 ID와 원본/본문 allowlist를 보존한다. reviewer를 Admin/팀 Owner로 자동 승격하지 않으며 구승인/구세션·토큰의 재검토/재인증, OIDC 재로그인의 grant 복원 방지, 소유권 불명 자료 격리·쓰기 차단·호환성/복구 검증을 요구한다.
- 연결 파일: README·AGENTS·ARCHITECTURE·SECURITY·LOCAL_WIKI·KNOWLEDGE_INTEGRATION·AGENT_INTERFACE·API_CONTRACT·ROADMAP과 이 인계 문서. 제안 API 경계와 구현 순서를 추가했다. 앱/서버/마이그레이션/패키지/워크플로·런타임 `wiki/SCHEMA.md`는 변경하지 않았다.
- 관련 기준: GOV-003/004/005/009, ACL-001~014, SHR-001~012, REV-002~006/009, VER-005/009, INT-001/002/006, LIF-008/010, SEC-009/010/011, OPS-004, CORE-002~006/009. 기존 251개 요구사항·35개 인수 시나리오의 내용/수/미검증 상태와 운영 작업표는 그대로다. AC-01~24는 기존 기준을 구체화하는 **미실행 설계 사례**이며 제품 요구사항/통과 결과 수에 합산하지 않는다.
- North Star 판단: Ingest→Query→Lint·질문 재편입·개인 파생본이 같은 원본/현재 권한으로 기존 지식을 갱신하도록 경계를 정의한다. 독립 검토·근거 교집합·응답/발행 직전 재검사를 유지한다. 문서/동기화 수와 지식/에이전트 성능 개선을 혼동하지 않는다. 의미 품질/후속 업무 효과는 EVALUATION의 대조 실험 대상이다.
- 실제 로컬 검증: Node 24.22.1/npm 11.9.0에서 `npm ci`와 `npm run check` 통과. 클라이언트 40개+Node 48개, 251개 요구사항 연결, 서버 타입 검사·빌드·정적 HTTP smoke 통과. 문서 상대 링크·Markdown 표 구조·24개 AC ID 연속성·참조 요구사항 ID·`git diff --check`를 확인했다. 새 문구를 검사하는 영구 테스트는 추가하지 않았다.
- 제한: 새 5역할·팀/그룹/수신자 grant·독립 검토·Bearer/서비스 주체·개인 커넥터 공통 서버 연결·관리 UI·새 API는 이 PR에서 구현/실행하지 않았다. DB 서버 회귀·실제 IdP/Windows/호스트·K8s/운영/반출·AC-01~24·지식 품질 시험을 새로 수행한 결과로 표시하지 않는다. GitHub CI 결과는 해당 PR의 실제 상태를 기준으로 한다.

## 2026-10-29 운영형 서버·OIDC·kind 수직 연결

**전체 251개 구현 완료나 사내 운영 인수 완료가 아니다.** 다음은 구현한 수직 경로와 실제 실행 근거이며, 남은 소프트웨어·환경 조건은 아래에 따로 남긴다.

- 사용자 결정: 동시접속 10명 이하, 운영 K8s/로컬 kind, 개발 Keycloak/운영 사내 SSO, 현재 DeepSeek/향후 온프레미스 교체. 추가 질문 없이 PR·머지까지 요청했다. 대규모 확장 최적화만 후순위이며 기존 251개 기준을 보존한다.
- 서버: OIDC+PKCE/state/nonce/JWKS, issuer+subject 신원, DB 세션/CSRF, 매 요청 UserInfo/현재 DB 권한, 원본/변경 집합/원자 발행/Query/답변/Lint/시도 기록, 쿠키 인증 REST/MCP를 연결했다. 실제 모델의 전체 입력 계보와 원본·페이지 ACL을 결과/재편입/발행/과거 버전에도 보존한다.
- UI: 기본 진입은 서버 정본 UI, 기존 합성 데모는 `/?demo=1`로 분리한다. 한국어 원본/편입/검토/발행/질문/재편입/Lint/작업/사용량, 25건 목록과 고정 인용 버전을 제공한다. 역할 선택/localStorage를 운영 인증/정본으로 사용하지 않는다.
- 배포: `Dockerfile.server`, Kustomize base/local/stg/prod, 로컬 Keycloak 고정 subject, 별도 DB/PVC, migration 성공 후 앱 배포, Secret 주입과 미설정/가변 이미지 운영 차단을 추가했다. 실제 회사 도메인·SSO·TLS·CNI·저장소는 추정하지 않는다. [설정/기동/제한](OPERATIONAL_SETUP.md).
- 실행 검증: Node 24.22.2 `npm run check`의 클라이언트 40개+Node 48개, 251개 연결 검사, 서버 타입/빌드/HTTP smoke 통과. 전용 kind DB의 서버 83개 회귀와 배포/추적 10개 통과. UTF-8 한글/이모지가 네트워크 청크 경계에서 손상되는 기존 읽기를 재현하고, 바이트 상한 확인 후 한 번만 디코딩하도록 수정했다. 실제 Keycloak의 3역할·원본→다중 페이지 편입→승인·원자 발행/멱등 재시도→인용 질문→재편입 제안→Lint·ACL/CSRF 거부를 실행했다.
- 실제 모델: 최초 자연어 질문의 조사 토큰 검색 실패와 DeepSeek thinking의 출력6000/추론5642토큰 JSON 잘림을 재현하고 성공으로 치환하지 않았다. 검색·선택적 thinking 설정·잘림 거부 RED→GREEN 후 최종 이미지에서 `deepseek-flash` 편입·승인/발행12,233ms, 자연어 질문3,128ms/인용4개를 확인했다. thinking=disabled를 명시했고 온프레미스 기본 옵션으로 보내지 않는다. 의미 품질/업무 효과 평가는 아니다.
- 제한된 읽기 측정: 최종 3개 합성 주체의 10개 인증 세션, 50/50 요청 성공, p95 158ms/전체516ms. 고유 사용자 10명의 혼합 부하·대용량·장기 안정성이나 사내 SLO 검증으로 확대하지 않는다. 이전 실행과 코드/입력/설정이 달라 성능 개선 비교로도 사용하지 않는다.
- 백업: AES256-GCM+scrypt/체크섬의 DB 백업 161610bytes를 로컬 폐기용 DB로 복원했다. 페이지 237·버전 265·원본 221개, 복원 단계 307ms였다. 테스트 workspace를 포함한 합성 DB이며 blob 일관성·독립 보관·사내 RPO/RTO는 별도다.
- 브라우저: 실제 OIDC 로그인/세션 만료 보호 화면 제거/재로그인, 자연어 발췌와 고정 버전, 사용량 401의 전체 보호 상태 제거를 확인했다. 390px 지식 화면 너비390/높이1178/첫 제목145px, 1440px 너비1440/높이1000/첫 제목107px. 사용량 모바일 높이2797/첫 집계730px, 그래프14px·키보드 내부 스크롤을 확인했다. [캡처/고정 결과](pr-assets/operational/README.md).
- 리뷰: UI/배포7건·서버 입력 계보3건·최종 schema 기동 차단/실행 중 세션·IdP 철회2건을 수정하고 독립 재검토에서 모두 addressed를 확인했다. 후속 provider 잘림 수정도 중요 결함 없음 판정이다. 최종 이미지의 실제 모델 실행 중 로그아웃200 → 응답401/UNAUTHENTICATED와 content 미반환을 확인했다. 전체 제품/사내 운영 인수 승인이 아니라 구현한 수직 경로의 리뷰다. PR/CI/머지 결과는 후속 기록을 따른다.
- 환경: 기본 Colima 2GiB에서 우리 노드의 OOM을 관찰했다. 기존 프로젝트는 중지하지 않고 실패한 우리 합성 cluster만 정리한 뒤 별도 4GiB profile `knowledge-hub-dev`를 생성했다. Docker 기본 context는 유지하고 `DOCKER_CONTEXT=colima-knowledge-hub-dev`로 분리한다. 앱/IdP는 28080/28081이다.
- 남은 소프트웨어: 지속 작업 lease/재시도/무인 일정·취소/예산, 개인 커넥터 공통 서버 통합, 서비스 계정 MCP/업무 context/outcome, 초안·수동 편집·전체 복원·공유·첨부·댓글·알림·삭제/권한 변경 운영 UI, blob 저장/일관 백업/감사 외부 보호, 실제 토큰·비용 영속 계측, 모델 의미 품질/후속 에이전트 대조 평가. 현재 jobs는 영속 시도 기록이지 자동 재개 worker가 아니다.
- 남은 운영 인수: 실제 사내 SSO/TLS/CNI/스토리지/독립 백업·삭제 정책/알림 수신자·책임자·혼합 부하와 품질/보안 기준. 정책·담당자 승인을 기술 구현으로 대체하지 않는다.
- 추적: [251개 항목별 미완료 작업표](requirements/operational-backlog.json)는 원래 ID/제목/우선순위/수용 기준을 그대로 보존하고, 항목별 구현 작업·실패/검증 사례·근거 심볼·소프트웨어 미구현/현장 검증/정책 차단을 구분한다. 모두 open이며 accepted는 0개다. `node scripts/release-status.mjs /external/path/report.json`의 간단 집계는 4개 ID 부분 근거만 연결한 별도 요약이며 작업표나 구현 완료 증거를 대체하지 않는다.
- PR: https://github.com/wontaeJeong/agent-knowledge-hub/pull/10 . 사용자 사전 머지 요청에 따라 중요 지적 해결·새 이미지 재검증·필수 CI 이후 병합한다. 실제 원격 상태/최종 head 검사와 병합 여부는 이 PR 기록이 기준이다. 이 기록의 전체 미구현/사내 운영 인수 제한은 PR 병합으로 사라지지 않는다.

## 서버 기반 첫 단계의 기록 (위 후속 기록 우선)

2026-10-29 후속 구현: PostgreSQL 내부 발행 서비스, DB membership/자료 allowlist, 승인 권한 스냅샷, 원자 발행·멱등 영수증, 감사/사용 기록과 사용량 대시보드를 추가했다. 상세는 [SERVER_FOUNDATION.md](SERVER_FOUNDATION.md). 아래 기존 데모 상태 설명은 계속 유효하며 새 서비스가 SSO/업무 UI/API 전체를 운영용으로 대체한 것은 아니다.

React 로컬 데모와 도메인 엔진, UI 교체 경계, 기준 239개와 핵심 순환 12개 요구사항, 앱 내 로드맵, 아이콘 팩을 제공한다. 선택적 로컬 모델 중계와 별도의 합성 개발용 로컬 위키 커넥터/STDIO MCP를 제공한다. 제품 서버·SSO·운영 커넥터·무인 스케줄러·인증된 운영 MCP는 아직 없다. 로드맵의 데모 매핑은 부분 시연 범위이지 프로덕션 완료 수가 아니다.

## 2026-10-29 로컬 커넥터 상시 실행 제외 확정

- 사용자 지시로 로컬 커넥터 상시 실행을 먼 미래 과제가 아닌 **제품 범위 밖**으로 확정했다. 연결 중 자동 동기화, 종료 시 미전송 변경 보존, 다음 연결 시 재개는 유지한다. 별도 daemon·OS 서비스·시작 프로그램·예약 작업은 동기화 수단으로 제공하지 않는다.
- 변경 파일: README, ARCHITECTURE, LOCAL_WIKI, ROADMAP, 로컬 위키 설계/계획, 이 인계 문서. 제품 코드와 현재 연결 수명주기는 변경하지 않았다.
- 관련 기준: EDT-002의 저장/복구, VER-005의 충돌 보존, INT-002·CORE-009의 MCP 연결 경계와 연관된다. JOB-001~012·MGR 일정·CORE-011 등 **서버 측** 지속 작업/예약 유지관리 요구사항과 기존 251개 수용 기준은 변경하지 않는다. North Star의 지식 유지 순환·근거·권한 불변식도 유지한다.
- 판단: 설치/운영 부담을 줄이고 호스트 연결 수명주기만 사용한다. 그 대가로 연결 종료 중 새 원격 변경이나 미전송 변경은 동기화되지 않고 다음 연결을 기다린다. 지식 효과/성능 개선을 새로 주장하지 않는다.
- 검증 결과: Node 24.22.2의 `npm ci`·`npm run check` 통과. Vitest 35개 + Node 48개(연결 종료·재연결/자동 polling 회귀 포함), 요구사항 251개, 서버 타입 검사, 빌드·정적 HTTP smoke 통과. 기존 511.20 kB 주 청크 경고는 유지한다. 독립 문서 리뷰에서 차단 지적 없음, `git diff --check` 통과. 서버 DB 시험·운영·실제 앱 호환 검증을 새로 수행한 것으로 표시하지 않는다.

## 2026-10-29 로컬 위키–LLM Wiki 통합 설계 제안 (문서만)

- 최신 `main`의 커넥터 합성 동기화/단일 페이지 공유 제안과, 브라우저 `src/domain/wiki.ts`의 다중 페이지 컴파일·Query·Lint가 분리된 점을 확인했다.
- `docs/KNOWLEDGE_INTEGRATION.md`에 공통 정본·원본/개인본/발행본 구분, P0/P1/P2 전환 순서와 KI-01~08의 **미실행** 통합 수용 시나리오를 정의했다.
- `docs/adr/004-unified-knowledge-service.md`는 공통 서버 지식 서비스를 정본으로 삼는 **제안(Proposed)**이다. 사용자/제품 책임자의 리뷰 없이 채택·구현 완료로 취급하지 않는다.
- README·AGENTS·LOCAL_WIKI·ARCHITECTURE·ROADMAP·AGENT_INTERFACE·EVALUATION의 문서 탐색 경로를 연결한다. North Star 원문·런타임 `wiki/SCHEMA.md`·기존 251개 요구사항·앱 코드는 변경하지 않는다.
- 검증 범위는 문서 링크/변경 내용 확인으로 한정된다. 모델 의미 품질, 운영 인증/MCP, DB 트랜잭션, KI-01~08 실행, K8s 배포를 이 문서 PR의 통과 결과로 표시하지 않는다.

## 2026-10-29 로컬 개인 위키 커넥터 첫 수직 구현

- 사용자 결정: 로컬/개인/공유 분리, 개인 자동 동기화, 여러 PC·에이전트 충돌 보존, 병합안 사람 확인, 공유는 명시적 변경 제안. 공유 레벨은 미정이며 로컬 커넥터 상시 실행은 위 후속 결정에 따라 제품 범위에서 제외한다. 개발자 하네스와 기존 에이전트 Desktop/Cowork 사용자가 대상이지 자체 Windows 제품 앱 개발이 아니다.
- 관련 요구사항: GOV-003·004, ACL-001·004~007·009·013·014, EDT-002·003, VER-005·007·009, REV-004~006, LIF-008~010, INT-001·002, CORE-002~007·009~012. 기존 요구사항·수용 기준·미검증 상태를 변경하지 않았다.
- 변경 파일: `scripts/wiki-connector/`의 protocol/store/service/dev-server/client/mcp/cli 및 실제 파일·HTTP·SDK/CLI 시험, 합성 example-config.json; package.json/lock, .gitignore, README, ARCHITECTURE, AGENT_INTERFACE, LOCAL_WIKI와 연결 설계/계획 문서.
- 실제 행동: JSON 작업본 원자 교체·잠금, 연결 중 직렬 자동 동기화와 재시작, 개인 공간 격리, 버전 CAS·중복 요청 방지, 충돌 세 버전과 해시 고정 병합안, 개인→공유 스냅샷 제안·검토자 승인·발행. MCP에는 공유 승인/발행·병합 확정 도구가 없다. 호스트 EOF에서 종료한다.
- 판단/기존 지식 영향: 기존 웹 데모와 지식 엔진은 그대로 보존했다. 파일 서버는 합성 loopback 검증용이며 운영 PostgreSQL/SSO를 대체하지 않는다. 개인 저장·공유 승격과 원본/파생 계보를 구분하며 기존 North Star·런타임 규칙 의미는 변경하지 않았다.
- 안전 선택: 권한·버전 metadata 확인 뒤 로컬 본문을 제공하므로 본문 반복 전송은 피하지만 권한 네트워크 호출은 남는다. 권한 불명확 시 열람/검색/충돌 조회를 차단한다. 로컬 보관은 반출이며 이미 복사된 평문 회수는 보장하지 않는다. 토큰은 환경변수로만 전달하고 redirect 금지·크기/시간 상한을 적용한다.
- 구현 한계: 단일 페이지 제안, 전체 최신 스냅샷 다운로드, 1 MiB HTTP 상한, 같은 문서 충돌의 보수적 수동 처리다. 일반 Markdown 폴더 편집·delta/paging·개인 fork rebase·기존 UI/다중 페이지 Ingest/Query/Lint 통합은 남아 있다. 운영 인증·ACL·DB·첨부/원본 조회·Windows 설치형 배포·실제 호스트 실기·의미/성능 효과는 미완료다. 완전한 오프라인 열람을 약속하지 않는다.
- 독립 리뷰: 다른 공간의 같은 ID가 draft/출처를 덮어쓰는 문제와 제출 직전 다른 기기의 개인 revision이 선택될 수 있는 문제를 실제 HTTP 회귀로 RED→GREEN 확인했다. 공간 충돌은 `PAGE_ID_COLLISION`으로 기존 draft를 보존하고, 제출은 `personalVersion`을 권한 갱신 전에 고정해 서버에서 CAS 검사한다. 미해결 Critical/Important 지적은 없다. 리뷰의 운영/포장/의미 품질 제외 항목은 아래 제약 그대로 남긴다.
- 최종 검증: 리뷰 수정 후 지원 Node 22.23.4에서 `npm test` 32 Vitest + 33 Node(커넥터 28개와 기존 모델 5개), `check:requirements` 251개, `build`, `git diff --check` 통과. 수정 전 Node 24 추가 회귀도 통과했다. 직접 추가한 SDK/Zod 라이선스 원문과 고지 보존, `npm audit --omit=dev` 취약점 0개를 확인했다. 최신 main 브랜드 통합 후 주 청크는 510.31 kB이며 기존 500 kB 경고 유형을 유지한다. 운영/Windows 검증으로 확대하지 않는다.

## 2026-10-29 이름 통일과 North Star 문서화

- 관련 요구사항: GOV-001·010, CORE-001~012, KNO-002·005·006·009·013·014, EVA-001~010. 기존 251개 요구사항/수용 기준과 35개 인수 시험 계획은 변경하지 않았다. 새 의미 품질 평가의 완료 상태도 올리지 않았다.
- 제품 기준: `docs/LLM_WIKI_CORE.md`에 원전/프로젝트 확장/현재 데모를 분리하고 Agent-Native Knowledge & Experience Platform 목표, 불변식·Non-Goals·판단 기준·명시 승인에 의한 변경 관리를 추가했다. `AGENTS.md`에 작업별 참조를 통합하고 `CLAUDE.md`는 공통 지침 참조만 남겼다.
- 평가/단계: `docs/EVALUATION.md`는 누적 대조 실험, KE-01~08, 계보·상충·시간·후속 에이전트 성공률의 **미실행 설계**다. `docs/ROADMAP.md`에 현재 격차와 P0~P3 평가 연결을 추가하고 기존 이행표를 보존했다. README에서 연결한다.
- 런타임 경계: `wiki/SCHEMA.md`의 기존 규칙은 유지했다. 장기 규칙은 비활성 설계 참조이며 현행 출력 계약·도구 권한·정책 버전을 확장하지 않는다. 활성화는 별도 구현/버전 변경/평가가 필요하다.
- 이름 변경 파일: package.json/lock, index.html, src/App.tsx·styles.css, src/adapters/repository.ts와 회귀 시험, src/domain/wiki.ts, scripts의 브랜드·모델·데모·배포 생성기, compose.yaml, .env.example, brand-kit 및 public/brand, 개발·모델·운영 문서에 `agent-knowledge-hub`를 적용했다. 외부 LLM Wiki 원전과 다른 프로젝트명은 유지한다.
- 업그레이드: 환경변수는 `AGENT_KNOWLEDGE_HUB_LLM_BASE_URL`, `AGENT_KNOWLEDGE_HUB_LLM_MODEL`, `AGENT_KNOWLEDGE_HUB_LLM_API_KEY`, `AGENT_KNOWLEDGE_HUB_DEMO_PORT`로 변경한다. 기존 환경 설정은 새 이름으로 갱신해야 한다. 브라우저 상태/테마는 새 저장 키로 이전하며 쓰기 실패 시 기존 값을 보존한다. 새 키가 우선이고 초기화는 이전 상태 키도 제거한다.
- 규칙 식별자: 앞선 이름 통일로 `agent-knowledge-hub/2`를 사용한다. 예전 식별자로 생성된 미결/승인 변경 집합은 발행 시 충돌하며, 최신 규칙으로 다시 생성·검토·승인해야 한다. 이를 우회해 발행하지 않는다.
- 검증: `npm test` 32 Vitest + 5 Node 통과, `npm run check:requirements` 251개 통과, `npm run build` 통과(브랜드 PR 통합 후 510.25 kB 주 청크 크기 경고), `git diff --check` 통과. K8s 문서 통합 시 Markdown 상대 경로 73개/32문서 존재 확인. 새 문구 존재를 검사하는 형식적 테스트는 추가하지 않았다. 독립 리뷰에서 일곱 질문에 답변 가능하며 수정 지적 없음을 확인했다.
- 브라우저: 로컬 실행기의 새 포트 변수로 실행하고 1440px/390px에서 제목/브랜드와 가로 넘침 없음을 확인했다. PR #2의 새 브랜드 통합 후에도 두 너비에서 이미지 로드·이름 잘림 없음(하단 이름 16px)을 다시 확인했다. 워드마크·README 배너 PNG도 전체 이름을 확인했다. 이것은 전체 모바일·접근성·제품 순환 검증이 아니다.
- PR 통합: 사용자 승인으로 K8s 설계 PR #1과 새 브랜드 PR #2를 main에 먼저 반영하고 최신 main을 통합했다. 새 Linked K 에셋·24개 아이콘·CSS·메타데이터·브랜드 ZIP 구조는 #2를 보존하고, 기존 상태/테마 이전·새 환경변수·규칙 식별자·North Star는 이 작업을 보존했다. #2의 당시 호환성 설명보다 이 절의 최종 업그레이드 안내를 우선한다.
- 남은 제약: 실제 모델 의미 종합, 지식 누적/에이전트 성능 평가, 서버 ACL/DB, API/MCP, 무인 정련, 시간/계보 모델, Docker/배포 실행은 이 작업에서 구현·측정하지 않았다. North Star 보호는 문서상 절차이며 CI 강제는 아니다. 도구 산출물은 커밋하지 않는다.

## 2026-10-29 개발환경·PR CI 보강

- 머지 준비 후속: 사용자 머지 승인 후 최신 main의 브랜드/로컬 위키 PR을 통합했다. `.gitignore`의 양쪽 제외 항목과 `wiki`/`wiki:mcp` 명령을 모두 보존하고, 전체 `test`에 기존 개발 도구 및 새 커넥터 회귀를 모두 명시 등록했다. 합성 로컬 위키 데이터도 Docker 컨텍스트에서 제외했다. Node24 `check`: Vitest32 + Node47(하위 테스트 포함), 요구사항251·빌드·HTTP smoke 통과. 최신 브랜드 기준 번들 경고는 510.31 kB다.
- 두 번째 main 통합: CI 대기 중 반영된 서버 기반 PR #6의 migration 회귀·서버 명령·사용량 UI를 보존했다. `check`에 DB 없는 서버 타입검사를 포함하고, 미적용 PostgreSQL CI 패치를 독립 서비스 job으로 반영해 최종 게이트가 서버 실패도 차단한다. 최신 Node24 `check`: Vitest35+Node48, 별도 폐기용 PostgreSQL17.6에서 서버26 통과 후 컨테이너 정리. 요구사항251·빌드/HTTP·actionlint 통과, 청크 경고511.20 kB. 과거 적용용 패치는 재적용하지 않도록 SERVER_FOUNDATION에 기록했다.

- 요구사항 연결: OPS-002·003·014, SEC-012, EVA-007의 개발 지원/회귀 기반. 기존 수용 기준·프로덕션 상태는 변경하지 않았다. 지식 편입/질문/점검·원본/권한/승인 불변식의 기존 회귀를 재사용하며 의미 품질/후속 에이전트 성능 개선을 주장하지 않는다.
- 변경 파일: `package.json`/lock, `.nvmrc`, `.npmrc`, `.editorconfig`, `.gitignore`, `.dockerignore`, `scripts/doctor.mjs`/시험, `scripts/smoke.mjs`/시험, `Dockerfile`, `nginx/default.conf`, `compose.yaml`, `.github/workflows/ci.yml`, PR 템플릿, README·DEVELOPMENT·TESTING·작업 계획.
- 개발 계약: Node 22.12+인 22.x 또는 24.x LTS/npm10+, 새 환경은24. 비지원 엔진 설치 차단, `npm run doctor`, `check`, `typecheck`, `test:watch`, `test:smoke`. 모델 키/DB/Docker 없이 기본 검사 가능. 기존 대량 포맷 부채를 앱 변경으로 섞지 않는다.
- CI: PR/main/merge queue/수동 이벤트, Ubuntu22/24·macOS24·Windows24, 고정 SHA Actions/읽기 전용 토큰·중복 취소·시간 제한, 정적 artifact 7일, Docker build/health/HTTP/항상 정리, 최종 `check` 게이트. 실제 운영 배포는 없으며 main 보호 규칙은 별도 관리자 설정이 필요하다.
- 실제 검증: Node22/24 `npm ci`/`check`(32 Vitest+19 Node, 251개 매핑·build·HTTP), 최소 Node22.12.0 `check`, Node25 설치 거부, Docker Linux aarch64 실제 빌드/health/HTTP/정리, actionlint·diff 검사 통과. Docker에서 발견한 webmanifest MIME 오류는 custom Nginx 설정으로 수정 후 동일 검사 통과. [PR #5](https://github.com/wontaeJeong/agent-knowledge-hub/pull/5)의 [Actions 40860406846](https://github.com/wontaeJeong/agent-knowledge-hub/actions/runs/40860406846)에서 네 OS/Node 조합+Docker+최종 게이트 6개 job 성공 및 artifact 업로드 확인. 독립 코드 리뷰 결함 없음·별도 진단/smoke14개 통과. 자세한 근거는 TESTING 참조.
- 운영 영향/제한: 앱 기능·지식 상태·권한/발행 로직은 변경하지 않았다. Compose 포트는 기본8080 loopback을 유지하며 환경변수로 변경 가능하다. 원래의 510.25 kB 빌드 경고·포맷 부채, 운영 서버/CD·실제 모델 품질·브라우저 E2E·부하/복구 검증은 남아 있다. Docker 기반 이미지는 기존의 가변 태그를 유지한다. 사용자의 마지막 지시에 따라 PR까지만 진행하며 머지하지 않는다.

## 다음 작업

### 2026-10-29 서버 기반·사용량 작업 인계

- 요구사항: CORE-002~004, ACL-001~005·009, REV-004~006, VER-005, SEC-009, OPS-004, GOV-009·OPS-006의 일부 구현. 기존 251개 상태/수용 기준과 35개 인수 시험 계획은 완료로 변경하지 않았다.
- 변경 파일: `server/` 서비스·저장소·마이그레이션 3개/DB 시험, `scripts/migrate.mts`, 시험 compose/CI, `src/domain/usage.ts`·집계 어댑터·대시보드·CSS·App 탐색, 패키지/라이선스, README·ARCHITECTURE·SERVER_FOUNDATION 및 캡처.
- 보안/발행: 권한 교집합과 연결 대상 실효 접근 검사, 승인 시 ACL 고정, 승인 후 source/base/body/policy/ACL 변경 차단, 현재 권한으로 replay·과거 제목 검사, SQL/성공 계측 실패 rollback. 독립 리뷰의 중요 결함 3건을 시험으로 재현하고 수정했다.
- 사용량: 실제 DB에 주체/작업/성공·실패/시각/ms 기록, 본인/검토자 workspace 범위와 UTC 7/30일 집계. 모델 토큰/비용은 미수집(null). 현재 데모 업무 UI/페이지뷰를 수집하거나 운영 사용량이라고 주장하지 않는다.
- UI: 데스크톱/모바일 19개 캡처를 PR에 첨부. 실측 시험 응답/미연결/UI fixture를 구분한다. 측정 화면 높이 1576/1782px, 첫 결론 264/334px, 그래프 글자 14px, 표 내부 스크롤을 확인했다.
- 최종 로컬 검증(Node 24.22.2/PostgreSQL 17.6): `npm test` 35 Vitest + 6 Node, `npm run test:server` 26개 통과. `check:server`, `check:requirements`(251개), `build`, `db:migrate`(재실행), `git diff --check` 통과. 주 청크 511.15 kB 크기 경고는 남는다. 서버 CI 확장은 현재 OAuth 토큰의 workflow 권한 부족으로 푸시가 거부되어 `docs/ci-server-tests.patch`로 분리했다. 기존 CI만 실행되며 서버 DB 회귀 자동화는 권한 있는 담당자가 패치를 적용해야 한다. SSO·실제 모델·업무 UI 서버 전환·K8s 배포/백업복원·운영 부하 검증은 미실행이다.
- 다음 작업: 실제 인증/그룹·UI/API 계약 연결, 반려/수정·재검토 운영 흐름, Query/Lint/작업 영속화와 나머지 1차 릴리즈 필수 게이트를 순차 구현한다. workspace 단위 잠금은 초기 선택이며 대규모 처리량을 보장하지 않는다.
- PR: https://github.com/wontaeJeong/agent-knowledge-hub/pull/6 . UI 캡처 19개 모두 PR 본문에 첨부하고 원격 이미지 응답을 확인했다. 병합은 사용자 승인 대기다.
- PR 생성 후 최신 `origin/main`의 확정 원본 Folio 심볼 변경(670f5a9)을 보존해 통합했다. 충돌은 TESTING의 양쪽 검증 기록을 모두 보존해 해결했다. 전체 35+6+26개 시험/251개 요구사항/타입/빌드를 다시 통과했고 최종 주 청크 경고는 511.20 kB다. 최신 심볼로 캡처 19개도 다시 생성했다.
- 사용자 머지 승인 후 PR #7의 로컬 개인 위키 커넥터(c03079d)도 보존해 통합했다. 패키지 시험 명령은 양쪽 시험을 모두 실행하며 lockfile의 의존성/버전을 합쳤다. Node 24.22.2에서 `npm ci`, 클라이언트 35개+Node 34개+서버 26개(총 95개), 요구사항 251개/서버 타입/빌드가 통과했다. 업무 UI 산출물 해시는 변경 전과 같아 캡처 19개는 계속 유효하다. 커넥터의 합성 파일 서비스와 PostgreSQL 기반 서비스를 이미 통합했다고 주장하지 않는다.

### 기존 후속 순서

1. docs/LLM_WIKI_CORE.md와 wiki/SCHEMA.md의 지식 누적 순환을 기준으로 사내 권한·자료 등급·UI 계약을 확정한다. Gate UI의 실제 경로와 지침을 확인해 어댑터로 재사용한다.
2. 원본·변경 집합·발행·인용·관계 메타데이터를 서버 저장소와 트랜잭션으로 옮긴다. 현재 localStorage를 인증된 서버 권한으로 대체한다.
3. 실제 사내 모델로 연속 편입·질문·점검의 익명화 평가셋을 실행한다. 오프라인 결과와 모델 평가 결과를 분리한다.
4. OpenCode/Claude Code의 배포 버전 fixture와 인증된 MCP 검색·읽기·등록·변경 제안을 공통 서비스에 연결한다.
5. 지속 작업·무인 일정·사용 결과 환류·권한 철회 전파와 전체 운영·보안·복구 게이트를 구현한다.

## 0.2 변경 기록

CORE-001~008의 일부 로컬 동작을 추가했다. 원본 기준 239개를 보존하고 CORE-001~012 추가 기준을 앱 로드맵에 함께 추적한다. 지식 컴파일 화면, 여러 페이지 변경 집합, 승인 내용 고정과 일괄 발행, 발행본 질문·고정 버전 인용, 답변 재편입, 실제 규칙 Lint, 선택적 실제 모델 중계 코드를 제공한다. 모델 오류·근거 오류는 반영하지 않는다. MCP·SSO·지속 DB·무인 일정·실제 사내 모델 평가의 완료를 의미하지 않는다. 검증 근거는 TESTING.md에 기록한다.

작업별로 요구사항 ID, 코드 변경, 도메인 및 통합 검증, 운영상 영향, 남은 제약을 이 문서 또는 연결 작업 기록에 갱신한다. 모든 요구사항의 원래 수용 기준을 보존한다. 모델·UI·백엔드를 동시에 대규모 변경해 검증 책임이 섞이지 않도록 변경 단위를 구분한다.

## 2026-10-29: 최초 K8s 릴리즈 설계 문서화

- 관련 요구사항: OPS-001~014, NFR-001~010, JOB-001~012 및 SEC/권한·발행 일관성 요구사항(기존 ID의 수용 기준은 변경하지 않음).
- 추가: `docs/adr/003-single-cluster-initial-release.md`, `docs/K8S_RELEASE.md`, `docs/SCALING_PLAN.md`. README·AGENTS·ARCHITECTURE·OPERATIONS에 참조 경로 추가.
- 내용: 동일 클러스터 STG/PROD 분리, 환경별 App 1/DB 1 목표, 운영 필수 게이트, 30,000 사용자에 대한 부하 측정·확장 조건 명시.
- 검증: 문서 변경과 기존 저장소의 현재 구현 대조. **K8s 배포·백업 복원·실부하/성능 검증은 수행하지 않음.** 제품 서버·SSO·DB·K8s 매니페스트는 계속 미구현.

## 상태 기록 양식

```text
요구사항 ID:
변경한 행동:
재사용한 사내 모듈과 실제 경로:
검증 명령 및 실제 결과:
권한·발행·복구 영향:
남은 미충족 조건:
다음 담당 역할:
```

## 2026-10-29 브랜드 갱신

제품 브랜드를 agent-knowledge-hub으로 확정했다. 기존 브랜드 에셋 54개 전체를 교체하고 총 74개 파일의 브랜드 팩을 제공한다. Linked K 심볼, 라이트·다크·단색·타일, 폰트 윤곽이 포함된 워드마크, 배너·공유 카드·프로필·빈 상태 일러스트, 24개 커스텀 UI 아이콘을 새로 작성했다. src/ui/brand-icons.json을 앱 BrandIcon과 에셋 생성기가 공유한다. public/brand, HTML 메타데이터, 앱 표시명, 패키지명과 README를 갱신했다.

요구사항 연결: 일반 위키 UI·사내 컴포넌트 이식·접근성에 관한 기존 수용 기준을 유지하며, 새 프로덕션 기능의 완료로 승격하지 않는다. brand-kit/asset-manifest.json에 개별 파일의 SHA-256을 기록하고 npm run brand로 다시 생성한다. 기존 localStorage 키·모델 환경변수 FOLIO_*·정책 ID folio-wiki/2는 저장 데이터와 실행 설정의 호환성을 위해 유지한다. 앱 표시 브랜드와 내부 호환 식별자를 구분한다. 포장 스크립트는 새 이름을 사용하고 전체 패키지 안에 중복 아이콘 ZIP을 넣지 않는다.

검증: 기존 도메인 28개와 모델 중계 5개, 251개 요구사항 연결 검사, TypeScript·프로덕션 빌드, SVG 파싱·PNG 크기·ICO 다중 크기·manifest 경로와 SHA-256 검사를 수행한다. 최종 실행 결과와 브라우저 확인은 docs/TESTING.md에 기록한다.

## 2026-10-29 확정 심볼 복원

사용자가 최초 Folio Wiki의 기존 아이콘을 그대로 쓰기로 결정했다. 육각형·펼친 책의 원본 path와 비율·선 두께·plum 색상을 복원하며, 이름은 agent-knowledge-hub으로 유지한다. 이전 Linked K 및 후속 캐릭터 후보는 현재 확정 브랜드가 아니다. 생성기·앱의 hub 아이콘·favicon·워드마크·배너·공유 카드·미리보기를 원본 심볼 기준으로 갱신했다.

이 변경은 UI 식별과 사내 브랜드 일관성을 개선한다. 지식 편입·질문·점검 순환·권한·근거·평가 계약은 변경하지 않는다. 기존 지식 데이터·모델·운영 문서의 최신 변경을 보존했다. 에셋 원본 대조와 재생성·빌드로 확인하며 지식 품질이나 운영 완료에 관한 새 주장을 추가하지 않는다.

## 2026-10-31 저장소 운영 기준

- 범위: 작은 기능 단위 PR, UI 변경 PR의 화면 캡처, 실수·실패와 재발 방지 기록. 제품 요구사항 ID의 수용 상태나 지식 순환·권한·North Star 의미는 바꾸지 않는다.
- 변경: `AGENTS.md`, `README.md`, `docs/DEVELOPMENT.md`, `docs/PR_WORKFLOW.md`, `docs/MISTAKE_LOG.md`. 기록은 실제 관찰과 미확인을 구분하며 비밀·개인 정보·원문을 제외한다.
- 검증: 문서 링크와 `git diff --check`를 확인한다. 저장소 규칙의 실제 준수와 향후 실수 감소 효과는 운영 중 별도로 확인해야 한다.
# Private question thread HTTP 경계 (2026-10-31)

- 재검토 round 3: 공개 범위는 인증된 스레드 생성·목록으로 한정한다. 모든 상세·제목/이력 GET은 ID 형식·소유·이력 크기와 무관하게 현재 세션 확인 후 `503 QUESTION_HISTORY_NOT_CONFIGURED`를 반환하며 이력 SQL·뷰·모델을 호출하지 않는다. 제출/재개도 미연결 상태다. 목록은 기존 `(workspace_id, principal_id, created_at, id)` 인덱스 순서와 ID 기준 커서를 사용하고 revision은 확인 불가다. 도메인의 기존 상세 구현과 round 2 예산은 운영 안전성 보장이 아니며 공개 경로에 재연결하지 않는다. ACL 인덱스와 bounded authorized pagination·실제 UI는 후속 과제다. QNA005/QNA008·CORE-005 전체 완성 아님.
- 재검토 round 2 기록: 도메인 상세 메서드의 크기·root 제한을 추가했으나 위 round 3에서 불충분하다고 확인돼 HTTP 상세는 비활성화했다. 상세 pagination, 큰 공간의 범위 지정 ACL 뷰와 운영 부하 검증은 미구현이다.
- 재검토 후: 일부 턴이 숨겨지면 상세의 revision과 모든 표시 턴의 `ordinal`이 null이다. 표시 순서를 저장 ordinal 또는 재개 입력으로 해석하지 않는다. 이전의 목록 내 턴 일괄 조회·뷰 공유는 위 round 2의 ID 전용 조회로 대체됐다. 삭제 UI는 `questionDataUnsupported`가 true이거나 미확인이면 차단한다. 성능 시험은 합성 자료와 해당 환경의 회귀 증거이며 운영 부하 보장은 아니다.
- 리뷰 후 안전 조치: 질문 테이블의 계보 삭제·복원이 아직 구현되지 않아 해당 공간의 resource/workspace 삭제와 복원 재생을 명시 차단한다. preview는 `questionDataUnsupported`를 표시한다. 기존 mutation gate와 삭제 tombstone/workspace receipt를 이용해 이후 질문 쓰기도 차단한다. 다른 공간에는 적용하지 않는다. 실제 질문 사본 삭제·복원 안전성은 미지원이며 차단을 해제할 조건은 별도 계보 구현과 검증이다.
- 권한 철회로 일부 턴을 볼 수 없으면 스레드 내용·제목뿐 아니라 목록/상세 revision도 `null`로 숨긴다. 이는 미연결 UI와 후속 턴 재개 계약에서 처리해야 한다. 영향 파일: `server/operations/erasure.ts`, `server/operations/erasure-db.test.ts`, `server/questions/{erasure-fence,service,feedback,runtime-http.test}.ts`, `server/runtime/errors.ts`.
- 관련 요구사항: QNA005/QNA008 및 CORE-005 관련 일부 경계만; 전체 수용 완료 아님.
- `server/runtime/http.ts`: 기존 세션 인증·Origin/CSRF 이후 개인 스레드 생성·목록만 `QuestionsService`와 현재 ACL에 연결한다. 상세·제목은 위와 같이 비활성화했다. 다른 인증 종류는 보수적으로 거부한다. 새 질문/재개는 DB 저장 전 503, 검색·피드백은 404다.
- `server/questions/runtime-http.test.ts`: 실제 HTTP·OIDC 세션·PostgreSQL에서 사용자/공간 격리, 권한 철회 후 내용 생략, CSRF 및 bearer 거부, 큐 미연결 시 미저장을 검사한다. 기존 도메인 테스트와 함께 격리 DB에서 11개 통과. Node 24에서 `npm run check` 통과.
- Query 순환의 개인 대화 접근 경계를 개선하나 기존 지식을 변경하거나 새 모델 전송을 하지 않는다. 턴 수락→실제 큐→RuntimeService trusted context→모델/답변 영속화와 UI 연결, 검색/피드백 호스트 연결, erasure/export/backup 통합은 후속이다. 큐 미연결을 답변 완료로 표시하지 않는다. 지식 품질이나 에이전트 성능 효과는 대조 평가 전 목표다.

### 2026-11-02 — 사이드바 사용자 메뉴

- UI 일관성 요구: 로컬 데모와 서버 콘솔에서 사용자 클릭 메뉴로 테마와 사용자 설정에 접근한다. 서버 모드에서는 현재 사용자·공간·역할과 기존 로그아웃을 제공한다. 테마는 기존 브라우저 저장 키에 보존한다.
- 변경: `src/ui/AccountMenu.tsx`, `src/ui/account-menu.css`, `src/App.tsx`, `src/operational/ConsoleShell.tsx`, `src/operational/App.tsx`, `src/operational/console.ts`, `src/operational/console.css`. 지식 순환이나 기존 권한·지식 데이터는 변경하지 않는다. 기존 UI 일관성 요구를 구체화한 변경이며 기존 요구사항 ID를 변경하지 않았다.
- 한계: 공개 Gate main은 별도 테마 컨트롤을 사용하므로 사내 드롭다운 구현과 동일한 코드를 확인한 것은 아니다. 서버 계정·세션 관리 라우트는 실제 런타임에 연결되지 않아 사용자 설정에서는 현재 정보만 표시한다. 사내 SSO 및 실제 데이터로는 검증하지 않았다.
- 검증: Node 24에서 `npm ci`, `npm run check` 통과. 사용자 메뉴 상호작용 테스트 포함. 실제 브라우저 1440px/390px 화면 확인은 로컬 서버에 브라우저가 연결되지 않아 미실시. 최종 커밋 CI는 PR에서 별도 확인한다.


### 2026-11-14 — P7 승인된 개인 도구 자료 수집
- 관련 COL-003/005/008~011·INT-005/007. `storage/trusted-collector`, migration116, native routes/host 및 앱 선택 화면을 연결했다. 기존 raw artifact 제출은 계속 차단한다.
- 서버가 승인한 개인 host/canonical 주체/세션만 직접 조회한다. 전후 version probe, 본문/시간/TLS 경계, 서버 제외 정책, 현재 source.create와 연결 revision 재검사, 재시작 후 철회 유지 및 안정적인 이벤트 중복 처리를 구현했다.
- 실제 DB·인증 HTTP·합성 TLS10건과 기존 storage 회귀, UI2건 및 `npm run check`가 통과했다.1440/390 및 키보드 제출/권한 철회 화면은 `docs/pr-assets/product-collector/`에 기록했다. 최종 독립 리뷰와 CI는 대기 중이다.
- 운영자가 승인한 전용 host/session 소유권 선언과 호환 version endpoint가 필요하다. 현재 로컬1.15.0은 미지원이며2.2.2 실제 설치 인수를 완료했다고 주장하지 않는다. 사용자 세션 열람/실제 외부 수집/daemon/배포는 수행하지 않았다.

P7 독립 검토 후 선택한 미완료/실패/빈 도구 출력이 다른 본문에 가려져 성공하지 않도록 저장 전 거부하며, 새로고침·수집 후에도 유효한 연결/세션 선택을 유지한다. 연결 문맥이 달라지면 메시지·도구·제목은 비운다. 실제 설치 인수·원격 소유권 독립 발견은 검증하지 않았다. fixture README의 마지막 기존 문단은 호출자 payload 경로에 대한 설명이며 별도 승인 host 경로의 구현 상태는 문서 첫 문단을 따른다.
최종 P7 검증: Node24에서 `npm run check` 통과(프런트145, Node48, import16, 요구사항251, 서버 타입/빌드/HTTP smoke); trusted collector 실제 DB/TLS/UserInfo13개 및 React3개 통과. 첫 전체 실행은 sandbox loopback listen EPERM으로 기존9개 시험이 실패했고 권한을 허용한 동일 시험 재실행은 통과했다. 실제 사내 host/model 전송 및 운영 인수는 하지 않았다.

### 2026-11-14 — P7/P9 workspace erasure integration
- `server/storage/trusted-collector.ts` now fences a workspace with a completed erasure or a blocked receipt whose error is absent, `PHYSICAL_BLOB_PURGE_REQUIRED`, or `SHARED_LIVE_BLOB_RETAINED`. A legal-hold or failed preflight receipt alone does not indicate applied deletion. The check remains both before outbound requests and before committing the source/snapshot; other identity, session, version, and permission guards remain in place.
- PostgreSQL 17.6 isolated collector, storage, erasure and signed-recovery regressions: 6 files / 65 tests passed; native HTTP + verified TLS tests verify zero remote requests for fenced states, while legal-hold and failed controls collect normally. An in-flight receipt blocks commit. Node 24 `npm run check` passed. Actual company host operation and external physical purge remain separate.

- P5 독립 리뷰 수정 검증: 실제 격리 DB RED→GREEN 및 PostgreSQL 17의 UUID별 DB에서 전체 서버 테스트 95개 파일 통과. Node 24 `npm run check` 통과. 외부 IdP·실제 백업 및 외부 롤백 앵커는 별도 검증이 필요하다.

P5 root 확인:독립 권한 리뷰의 조회 전용 grant 제안 우회와 과거 작성자 원본 권한 철회 누락을 실제 RED→GREEN으로 수정했다. 최종 PostgreSQL17 전체95파일 통과 로그를 확인했고, 초기 PG16/pg_restore17 불일치4건과 간헐 사용량 시각 시험 실패/재실행 기록을 유지한다. Chromium1440/390에서 기존 공간 독자 원본 목록과 쓰기 비활성을 합성 API로 확인해 docs/pr-assets/product-legacy에 남겼다. 운영자 서명은 출처 진실의 독립 증거가 아니며 실제 회사 IdP/백업 인수는 미실행이다.

### 2026-11-14 P6 근거 연결 답변 재편입

- 관련 요구사항: CORE-003/006/007/010/011, KNO-002~006/009/012~014, QNA-007. 전체 운영 수용 또는 의미 품질 개선을 선언하지 않는다.
- 변경: `server/runtime/knowledge.ts`와 `server/runtime/model.ts`는 모델 답변을 기존 페이지 갱신·새 분석·변경 없음의 이유를 포함한 후보로 정련한다. 입력 페이지/원본 envelope와 답변 관계를 고정하고 현재 권한·적용성·기준 버전을 재검사한다. `server/publication.ts`, `server/refinement/{logic,service}.ts`는 원문 위치와 버전이 검증된 미검증 주장 후보를 해시에 포함하고, 실제 발행 트랜잭션에서 새 페이지 버전의 근거·주장과 기존 주장 간 상충/환경 차이 재검토 요청으로 연결한다. 승인이나 에이전트 보고를 실행 검증으로 바꾸지 않는다. 화면은 이유·구분·후보·재검토 신호를 표시한다.
- 판정과 한계: 모델에 전달하는 기존 자료는 기존 봉인 페이지·원본과 파생 답변으로 제한한다. 변경되는 정련 컨텍스트는 봉인/검증 계약이 없어 모델에 전달하지 않으며 명시적 모델 후보만 발행 후 미검증 정련 레코드로 생성한다. 동일 원문은 기존 정련 서비스의 콘텐츠 해시를 동일 근거 뿌리로 사용한다. 모델의 중복 여부 판단과 의미 품질은 독립 평가 전 보장하지 않는다. 보호 문서는 모델 답변 제안의 생성·대기 결과 공개·승인·발행 시 행위자의 보호 권한과 무관하게 거부하고 기준 버전은 기존 발행 경계로 강제한다. 문단 단위 보호 편집기는 구현하지 않는다.
- 검증: 합성 격리 DB의 실제 HTTP/loopback 모델, 중복, 반증·환경, 인간 보호, 오래된 기준/ACL, 철회, 발행 재시도와 모델 오류 회귀를 실행했다. 정확한 최종 결과 및 화면·독립 리뷰 상태는 작업 보고서를 확인한다. 실제 사내 자료·모델/운영 검증과 후속 성과 대조 실험은 수행하지 않았다.
- P6 UI 확인: 실제 React/Chromium에서 합성 제안을1440×1000·390×844로 검토했다. 변경 이유·기존 페이지 분류·미검증 후보의 조건/시점/원본 버전·위치를 확인했고 `docs/pr-assets/product-evolution/`에 증거를 남겼다. 실제 모델 의미 품질 인수는 별도다.

### 2026-11-14 P10 실제 유지 경로 평가

- 관련 요구사항: CORE-012, EVA-001~006, UX-003, NFR-009. 기존 평가 임계값과 운영 미검증 상태는 보존한다.
- 변경: `server/evaluation/{run,policy-agent}.ts`는 인증된 런타임/정책에 묶인 내부 실험을 제공한다. `scripts/evaluation/{maintenance,evolution,http-driver,usage}.mjs`는 실제 3회 이상 유지 순환·raw/static/maintained 비교·독립 정답 격리·실패/중단 분모·검토 이벤트·유지/질문/평가 비용을 기록한다. `provider.mjs`는 전송 직전 정책 hook과 측정된 비용을 사용하고 토큰 사용량이 없을 때 다음 도구 호출을 중단한다. `npm run test:evaluation`을 전체 검사에 포함한다.
- 검증 범위: 합성 fixture와 실제 HTTP/PostgreSQL/loopback 모델에서 3회 발행, 동일 원본 대조군, 정적 고정, 평가 답변 미저장, 과거 정답·반증/환경 사례, 전송 전·전송 중 ACL 철회와 사용량 분리를 확인한다. 구체적 최종 명령 및 독립 리뷰는 작업 보고서에 기록한다.
- 한계: 합성 fixture의 정답/검토는 실제 인간 도메인 판정이 아니다. 평가 답변의 원문 substring 검사는 의미적 지지나 실행 검증이 아니다. 독립 증거 여부와 실제 모델·업무 성능 개선은 미확인이다. 구간 사용량은 별도의 전용 workspace 사용을 전제로 하며, 명시된 인간 검토 이벤트가 없으면 작업 시간은 미측정이다. 시간초과/중단 뒤 서버 측 결과는 별도 재조정해야 한다.

#### P10 독립 리뷰 수정

- 전체 실제 ingest 입력의 원본·페이지 메타데이터에서 디코딩된 홀드아웃 질문/마커/정답 필드를 검사하고 서버 전용 ingest guard가 실제 캡처·전송 직전 동일 입력 봉인을 재검사한다. 최초 위키의 전체 계보는 S0 원본 범위에 있어야 하고 각 평가 발행 버전의 원본 계보도 해당 단계 원본에 포함돼야 한다. 공개 검증 함수 주입 API는 추가하지 않았다.
- 모델 오류·중간 시간초과에도 이미 측정된 토큰/비용 소계와 호출 수를 기록하며 최종 총액은 미확인으로 보존한다. `expectedAbstained`를 명시한 정답과 실제 보류 여부를 함께 채점하고 별도 보류 통계를 남긴다.
- 실제 운영 모델의 의미 품질, 독립 근거의 진실성, 사업 성과와 기존 pg 동시 query deprecation은 이 수정으로 검증하지 않았다. 최종 테스트는 P10 작업 보고서를 따른다.

### 2026-11-14 — P4 계정·세션 호스트 연결 (IAM/ACL)

- 변경: `server/runtime/main.ts`, `server/runtime/http.ts`가 identity runtime을 실제 OIDC 및 인증·CSRF 뒤의 HTTP 경로에 연결한다. `src/operational/App.tsx` 계정 화면은 본인 세션 조회·철회와 전체 로그아웃을 표시하고 현재 세션 종료 시 보호 상태를 비운다. 선택 긴급 접근·디렉터리 기능은 명시적 서버 구성일 때만 제공한다. 원본 권한 상한과 canonical authorizer는 그대로 적용된다.
- 증거: 실제 HTTP·PostgreSQL 테스트에서 타인 세션 철회 거부, CSRF, 현재 세션 쿠키 제거, 전체 로그아웃, 비활성 신원과 기본 선택 기능 비활성을 확인했다. `npm run check` 및 identity DB 테스트 통과. 브라우저 1440/390 화면과 실제 운영 IdP는 미검증이다.
- 한계: 소유권 없는 기존 공간의 3역할 호환(P5)은 이 작업에 포함하지 않는다. 외부 IdP 로그아웃 브리지는 미구성으로 보고한다. 지식 품질·업무 성과의 개선은 평가하지 않았다.
- 독립 리뷰 후속: 재접속 중 현재 세션 철회 뒤 늦은 `/me`가 보호 화면을 복원하지 않도록 인증 세대·화면 epoch를 검사한다. 전체 로그아웃의 외부 IdP 결과도 로그인 화면에 남긴다. 실제 앱 지연 응답·결과 표시 테스트 RED→GREEN 및 전체 검사 재실행 통과.
- P4 화면 증거: `docs/pr-assets/product-identity/`에 실제 React/Chromium의 1440×1000·390×844 합성 응답 캡처와 키보드 전체 종료 결과를 기록했다. 독립 코드 리뷰의 늦은 `/me`와 로그아웃 안내 소실을 수정했다. 실제 IdP/배포 인수는 미실행이다.

### 2026-11-14 — P9 Task 1: 검토 기반 삭제와 복구 재생 (LIF-005~007, VER-012, OPS-008~009)

- `server/operations/erasure.ts`, `product-erasure.ts`와 migration 111은 질문 턴·피드백, 버전 메타데이터·복구 계획, 협업·거버넌스 기록, 에이전트 자격증명 및 모델 사용 표식을 인벤토리와 승인된 삭제에 포함한다. 전체 공간에서는 자격증명을 철회하고 계보 없는 기록도 삭제한다. 원본별 삭제는 접근·법적 보류·기준 해시를 재검사하고, 계보 없는 질문·에이전트 내용은 미해결로 보고한다. 다른 공간에 연결된 잘못된 자격증명 관계는 트랜잭션 전체를 거부한다.
- 동일 mutation gate와 페이지 tombstone으로 늦은 버전 메타데이터 쓰기를 막는다. 호출자는 데이터 변경 전에 shared gate를 잡아야 한다. 일반 transaction은 이를 수행한다. 법적 보류로 거부된 요청은 실행된 삭제가 아니다. 불변 ID·행위자·제약된 enum·사용량 수치는 보존하며 외부 백업까지 삭제했다고 주장하지 않는다.
- 집중 합성 PostgreSQL 시험에서 실 HTTP, 소스/질문 계보, 별도 공간 격리, nonce 중복, signed 복구 재생, stale preview·보류·현재 ACL과 gate 경합을 검증했다. 정확한 명령과 결과는 작업 보고서와 PR에 기재한다. PostgreSQL 17 복구 도구를 PostgreSQL 16 합성 서버에 사용한 release 시험은 `transaction_timeout` 미지원으로 실패했으며 PG17 CI에서 별도 확인해야 한다.
- Task 2 사용자 휴지통·복원과 주기 보존 실행은 후속 독립 PR 범위다. 사내 보존/법적 정책, 외부 백업 삭제와 운영 수용·실제 업무 품질 개선은 검증하지 않았다.
- 독립 리뷰 후속: 복구 미리보기의 복합 기본키 `hash`를 보존하고 payload만 삭제한다. 전체 삭제와 복구 재생에서 각각 두 미리보기의 충돌을 RED→GREEN으로 확인했고 특권 SQL 함수도 해당 키 변경을 거부한다.

### P1 개인 후속 대화 — 2026-11-14
- 요구사항 QNA-005/008/009, SRH-002/004, CORE-005: `server/questions`, `server/runtime`, `server/jobs`, `src/operational/questions.tsx`와 앱 질문 화면을 연결했다. 서버 소유 이력·원본 범위를 승인 시점과 전송·저장 직전에 검사하고, 큐의 fenced 쓰기에서 답변과 턴 완료를 함께 기록한다. 기존 P9 삭제 fence를 유지한다.
- 검증: Node 24 `npm run check`; 실제 격리 PostgreSQL/HTTP/durable queue와 합성 loopback 모델의 두 턴·동일 nonce·영수증 소실·권한 철회 전후·취소·worker 재시작·근거 부족, 삭제·원복 회귀. 상세 실행 결과와 미실행 항목은 `.superpowers/p1-report.md` 참조. 브라우저 캡처·독립 리뷰·최종 CI는 별도다. 실제 사내 모델 품질이나 지식 성과를 주장하지 않는다.
- 에이전트 기존 검색은 점수순/정수 offset 계약이고 질문 scoped search는 시간순/서명 cursor다. 각 경로의 현재 ACL/원본 범위는 별도 검사하며 기존 agent DTO 호환 어댑터는 PR30 discovery와 함께 후속 검토한다.

- P1 독립 리뷰 수정: 숨겨진 이력의 revision은 소유자·공간·스레드·현재 revision·보이는 입력에 묶인 비복호화 MAC으로 대체한다. 오래된 토큰은 재조회하며 이미 수락된 nonce는 복구한다. 대화는 읽기 페이지별 고유 근거와 바이트 예산을 적용하고 모델 이력은 최근 서버 봉인 윈도로 별도 선택한다. terminal 취소·실패 뒤 재조회와 새 nonce, 현재 공간을 사용하는 인용·피드백·검색 버전 뷰어를 연결했다.
- 합성 화면 검증: [1440px](pr-assets/product-conversations/review-desktop-1440.png), [390px](pr-assets/product-conversations/review-mobile-390.png). 실제 앱에서 다른 공간으로 전환한 뒤 인용 요청의 `X-Space-Id`와 해당 공간 본문, 가로 폭 및 이전 대화 병합을 확인했다. 기존 키보드 취소·403 기록도 [캡처 설명](pr-assets/product-conversations/README.md)에 보존한다. 실제 사내 자료·모델 검증은 아니다.

- P1 리뷰 수정 최종 검증: Node 24 `npm run check`와 PostgreSQL 17 격리 DB 전체 서버 테스트 95개 파일 통과. 회사 IdP·운영 모델·최종 CI는 별도다.

### 2026-11-14 — P8 native local connector (CORE-009, KI-01~07 partial)

- `server/agents/{service,http}.ts` and `scripts/wiki-connector/{client,cli,mcp,service}.mjs` submit 1–20 selected synchronized personal revisions as one pending common proposal. The exact-input receipt commits atomically with that proposal; replay rechecks current access, copy policy and selected revisions. Existing PAT scopes are unchanged.
- Synthetic PostgreSQL and native HTTP with scoped credentials, two clients and two workspaces exercise synchronization, conflict preservation, forged source rejection, policy revocation, retry, and changed-baseline rejection. Real SSO, installation, production policy acceptance, and knowledge quality remain unverified. ADR 004 remains proposed.

- P8 independent review fix: cached inner proposals (including the existing single-page route) now recheck selected personal revisions and copy authorization; links on personal revisions are checked as current page dependencies including inherited raw-source ACL/copy policy, and are bound to receipts. Protected unsynchronized drafts require the native `check-local` dependency check before read/search/conflict display or body transmission. Denied pending edits remain stored for later authorized access. Hosts predating this action fail closed; upgrade server and client together. Six PostgreSQL authorization-race and native HTTP regressions cover these paths. Full test outcomes are in the P8 report.
- Final P8 review-fix verification: Node 24 `npm run check` exit 0; PostgreSQL 17.6 complete isolated server suite 97 files / 697 tests, zero skips, exit 0; six focused review regressions and native integration separately passed. The initial shared-cluster 5-second targeted test timeout was corrected by increasing the test-only timeout; no product network timeout changed.

## 2026-11-14 P2 버전 비교·선택 검토·복원 연결

관련 VER-004~010, REV-004~007, KNO-014. 기존 VersionService/handleVersionRoute를 실제 cookie 인증·선택 공간·CSRF·현재 권한 검사 뒤 native HTTP에 연결하고 #versions 콘솔에 VersionsPanel을 제공한다. 인증된 사람의 비교/복원/선택 검토이며 credential 경로는 열지 않는다. 복원·부분 판단은 새 pending 묶음이고 독립 검토·발행이 필요하다. 현재 ACL·보호 내용·의존성과 원본 철회를 다시 확인하며 과거 메타데이터를 현재 값으로 채우지 않는다.

변경 파일:server/runtime/http.ts/errors.ts/versions-host.test.ts,src/operational/versions.tsx/versions-interaction.test.tsx/App.tsx/console.ts/ConsoleShell.tsx,index.html. 서비스/기존 migration은 유지한다. P9 삭제·복구 보호 PR 위에 쌓인다.

검증:원래 미연결 경로404→실제 HTTP 성공과 권한/CSRF 거부, stale preview409 및 의존성 분리 차단을 RED→GREEN으로 확인했다. 기존 versions5와 erasure15 회귀 통과. UI deferred 응답·서버25줄 및 발행 묶음 pagination 회귀3건이 RED→GREEN(기존2 포함5개)이다. Node24 npm run check145frontend/48Node/16import/251requirements/types/build/smoke 통과. 추가 원본 철회/보호 문서와 저장된 댓글 위치 회귀의 최종 결과는 후속 기록한다.

현재 한계:배포·실제 조직 SSO·실제 모델/효과 인수는 미실행. 본문은 정확한 줄 비교이며 의미 판단이 아니다. 메타데이터/anchor 없는 과거 버전은 미확인/위치 미확정으로 남는다. UI 캡처는 docs/pr-assets/product-versions의 합성1440/390환경이다. 장기 목표의 검토 가능한 발전·현재 권한 불변식을 연결하는 기능이며 지식 품질 효과는 별도 평가 대상이다.

최신 웹 문구 선호에 따라 공통 콘솔 장식 설명과 슬로건을 제거하고 문서 title/meta description을 기능 설명으로 바꿨다. 원본 브랜드 심볼은 보존한다.
P2 최종 추가 회귀: native HTTP5개 통과(원본 접근 철회 후 복원 거부, 보호 페이지 제안403, 보존된 v2→v3 댓글 위치 이동과 원래 댓글 버전 유지 포함). 마지막 문구 변경까지 포함한 전체 npm run check도 다시 통과했다. 새 migration/권한 확대/자동 발행은 없다.

### P2 독립 리뷰 수정 — 실제 발행과 속성 이력
- VER-001/002/003/004/006/007/008/009/010/011, CORE-006/007: 기존 VersionService 단독 시험으로는 공통 발행 훅 누락을 발견하지 못했다. 이제 `server/publication.ts`가 trusted 복원 계획의 문서·본문·기준 버전·속성·근거를 검증하고 최종 묶음 해시에 결합한다. 실제 승인/발행에서 현재 권한·속성·정책을 재검사하며 모든 버전 생성 뒤 선택 속성을 적용하고 불변 스냅샷을 기록한다. 일반 새 발행도 당시 메타데이터를 캡처한다. 과거 미기록 속성을 채워 넣지 않는다.
- `server/workflows/service.ts` 설정 변경은 동일 트랜잭션의 before/after 이벤트를 기록한다. 기존 호스트 authorizer를 그대로 사용하며 휴지통은 lifecycle 권한으로 검사한다. 부분 유지/반려로 파생한 묶음은 선택된 복원 계획만 새 최종 해시에 묶으며 기존 승인을 재사용하지 않는다.
- `server/workflows/governance/requirements.ts`는 검증된 복원 projection에 필수 속성을 적용한다. 현재 정책/설정도 승인 해시에 계속 결합한다. 위조·누락 계획이나 이후 속성 변경은 발행을 거부한다.
- `src/operational/versions.tsx`는 25개 목록을 이동해도 선택한 두 비교 버전을 보존한다. 실제 Chromium 1440/390에서 v1→v30 요청과 Enter 비교를 확인했다. 본문/코드는 가로 스크롤 표 안에 보존한다.
- 새 실제 발행 통합 회귀 8건, UI 추가 회귀 포함4건 통과. 전체 필수 검사와 최종 PG17 전체 회귀 결과는 아래에 기록한다. 기존 미기록 스냅샷은 unknown, 의미적 비교·실제 회사 인수는 미검증이다. 작은 후속은 문단 위치 25개 이후의 탐색과 일부 복원 오류 메시지 매핑이다.
- P2 최종 검증: Node24 `npm run check` 종료0(프런트엔드146/기존 Node48/import16, 251 요구사항·서버 타입·빌드·HTTP smoke), PostgreSQL17 전체97파일703개 종료0. 첫 전체 실행의 두 테스트 전제 실패는 위와 MISTAKE_LOG에 보존했다. 독립 리뷰 중요3건은 모두 수정했다. 실제 회사 모델/SSO/의미 품질은 미검증이다.

### 2026-11-14 — P9 휴지통 복구 단계 (LIF-004/005, ACL-008)

- 휴지통에 이동한 시각과 명시된 `trashGraceDays` 정책에서 계산한 유예 만료를 보관한다. 미설정·비활성 정책은 만료 시각을 만들지 않고 유예 만료만으로 삭제하지 않는다. 미리보기에 기존 레거시 시각이 없으면 미확인으로 표시한다.
- 복구 시 현재 문서·원본·상위 경계와 revision을 재검사한다. 원래 위치의 같은 제목과 충돌하면 409로 표시하며 사용자가 새 parent 또는 새 제목을 명시할 수 있다. 대상 parent 및 변경 문서의 현재 보호 권한과 순환을 검사하고, 동일 ID·버전 본문과 현재 ACL을 유지한다. 이름 변경은 활동 기록에 남기며 관련 대기/승인 변경을 충돌 처리한다.
- 합성 PostgreSQL workflow 및 기존 retention 시험 통과. 1440/390 실제 브라우저 화면·운영 정책 인수는 별도다. P9 Task 2의 발행/원본 버전 pruning과 durable worker 연결은 후속 작업이며 유예 기능의 구현을 해당 작업의 완료로 표시하지 않는다.

P9 휴지통 분리 PR의 root 재검증:잘못 삽입된 template JSX를 제거한2f4933e에서 npm run check 전체가 실제 exit0으로 통과했다. Chromium1440/390 실제 화면과 키보드 복구 흐름을 합성 API로 확인했으며 docs/pr-assets/product-trash에 보존했다. 최초 성공 오보고는 MISTAKE_LOG의 정정 기록을 유지한다. 실제 회사 보존 정책이나 실자료 삭제/복구는 실행하지 않았다.
P9 휴지통 root DB 재검증도33개 통과(workflows25+retention6+HTTP2). 화면 확인은 합성 성공 응답이며 이 실제 DB 결과와 구분한다.

- 독립 리뷰 수정: 휴지통의 이름/부모 변경 복구에서 현재 문서·원본 경계는 기존 lifecycle 검사로 확인하고 `knowledge.protect` 능력을 별도 확인한다. 대상 부모의 보호 권한은 계속 개별 확인한다. 실제 adopted maintainer와 HTTP/OIDC 세션의 RED→GREEN 및 현재 원본·부모 ACL, 보호 권한, 기존 독자 ACL/버전 보존을 합성 PostgreSQL에서 확인했다. 전체 검사와 집중 DB 회귀 exit 0. UI의 충돌 안내가 위치만 제안하고 제목 변경을 언급하지 않는 문구는 후속 개선이다.
### 2026-11-14 — P9 보존 실행·지속 작업 (LIF-005/007, VER-009/012, ACL-008)

- 정책에 지정된 기간이 지난 미참조 개인 초안과 비최신 발행 버전, 원본의 오래된 스냅샷을 각각 분리해 검사한다. 버전·스냅샷은 보존된 참조와 법적 보류·미확인 스키마·현재 항목이면 차단한다. 명시 초안 소유자 범위 밖과 다른 공간은 변경하지 않는다. migration 112는 서명 원장에 포함되는 retirement와 재삽입 차단을 추가하며, 복구 격리에서 현재 원장을 재생하고 충돌 참조가 있으면 해제를 중단한다.
- `AKH_RETENTION_SERVICES_JSON`의 정확한 서비스/credential만 실제 durable 일정과 worker의 단일 DB effect에서 실행할 수 있다. 현재 policy revision, human 승인자·스폰서 권한, service 상태와 directory, 원본/페이지의 서비스 자격 범위를 다시 검사한다. 정책 변경 권한과 원본 접근을 이 서비스에 자동 부여하지 않는다. DB gate→queue 순서와 현재 lease가 효과를 보호한다. 개인 초안 본문·제목은 결과/감사에 반환하지 않는다.
- source snapshot의 DB 기록과 blob metadata 정리는 실제 수행하지만, CAS 파일은 별도 물리 purge 전까지 남는다. 해당 영수증은 `blocked`와 `physicalPurgePending`으로 표시하며 외부 백업·전체 복사본 삭제를 주장하지 않는다. 실행 결과의 상세 검증과 기존 PG17 복구 릴리스 환경 제한은 작업 보고서를 따른다.
- 실회사 보존 기간·서비스 배치·TLS/IdP, 외부 백업, CAS 물리 purge와 운영 수용은 미검증이다. UI 실제 브라우저 1440/390 증거 및 독립 보안 리뷰는 코디네이터가 수행한다.
- 잠금 순서 제한: version/snapshot DB trigger는 잘못된 늦은 삽입을 차단하지만 raw SQL이 다른 테이블 lock을 먼저 잡으면 trigger의 gate 대기와 교착할 수 있다. 지원되는 제품 호출은 transaction 시작 시 gate를 먼저 잡는 계약을 지켜야 한다. 기존 metadata helper의 무잠금 거부와 별도 trigger 대기 시험을 유지한다.
- 최종 합성 검증: Node24 `npm run check` 종료 코드 0, 별도 PostgreSQL DB 12개 파일 216개 시험과 인증 HTTP→지속 worker 경로 종료 코드 0. 비공개 본문/제목은 주요 저장 형식을 SQL에서 해시·구조화된 계보로 투영하고 나머지 미분류 형식은 차단하는 보수적 정책이다. 이는 모든 환경의 보안 감사나 실제 보존 의무 인수가 아니다.

- P9 독립 리뷰 수정 (LIF-007, VER-012, ACL-008): 복구 replay는 보류된 원본의 발행 이력과 현재 초안이 없는 과거 복사본, 비공개 질문/에이전트 참조, 마지막 스냅샷을 보수적으로 보호한다. 초안 정리 실행자는 현재·이력 페이지와 원본 전체의 읽기 상한을 충족해야 하며 본문은 인벤토리·권한 조회에서 SQL 투영으로 제외한다. 누락된 신원이나 참조는 실패로 처리한다. 실제 CAS 파일 purge·외부 백업·회사 정책·운영 수용은 미검증이다.
- 실제 React 화면의 합성 fixture에서 1440/390 크기와 키보드 Enter 일정 생성, retention 작업 설정과 물리 purge 대기 영수증을 확인했다. 캡처와 환경은 [보존 화면 증거](pr-assets/product-retention/README.md)에 기록한다. 실제 업무 자료나 실제 작업 실행의 증거는 아니다.
- 최종 합성 검증: Node 24 `npm run check` exit 0 및 PostgreSQL 17 전체 98개 파일·727개 시험 exit 0. 리뷰 회귀의 실패와 환경 제약은 MISTAKE_LOG와 작업 보고서를 따른다.

- P5/P7 통합 후속: legacy 권한·manifest와 수집기 설정의 네 제어 테이블을 보존 그래프에서 명시적으로 식별한다. 열 이름·타입·nullability가 변경되거나 제품 자원 FK가 추가되면 계속 차단한다. 합성 독립/통합 DB에서 미분류 RED와 스키마 변경 차단을 확인했다.



- 교차 기능 삭제 후속: P5 기존 역할 증거와 P7 수집기 연결이 존재하면 workspace 삭제 및 서명 복구 재생의 같은 트랜잭션에서 각각 철회한다. 기능 미설치 DB도 지원하며 미확인 제어 스키마는 차단한다. 법적 보류·오류는 전체 롤백하고 다른 공간은 유지한다. 합성 복구 상태에서 기존 editor가 다시 원본을 작성하던 RED와 수정 후 현재 권한 거부를 확인했다.

### 2026-11-14 — P1~P10 사용자 승인 병합
- 후속 “머지” 요청에 따라 기능 PR #32~43을 squash 순서로 통합한다. 요구사항 범위는 변경하지 않으며 기존 PR #30은 별도다.
- 각 기능의 격리 worktree에서 현재 main 및 선행 기능을 보존하고 최종 head의 필수 CI를 확인한다. 절차·검증과 제약은 [병합 기록](superpowers/plans/2026-11-14-product-merge.md)을 참조한다.

## 2026-11-16 - SHR-007 fixed descendant sharing preview
- Added authenticated shares/preview and shares/selection plus an actual AccessPanel flow. The ten-minute actor/workspace/credential-bound signed preview lists currently accessible fixed versions for one recipient. Selection creates all shares atomically after current actor/source/recipient checks and policy CAS. Future children never auto-join; moved/changed selected pages require a new preview. Existing individual/group fixed-link path remains available.
- No document/source audience expansion is performed: recipient must currently read the complete input ancestry. Maximum50 selected pages; snapshots are fixed to current versions and restart requires a new preview.
- Node24 npm run check, UI scope-clearing regression and PostgreSQL nativeOIDC/CSRF/forgery/descendant/source-revocation regressions4 pass. Actual1440/390 component screenshots under docs/pr-assets/share-selection use synthetic API; corporate acceptance is separate.
## 2026-11-16 Task 1a — Unified scoped search

- Requirements: SRH-002/003/004/005/007, CORE-009/010 search integration. AgentService, ScopedSearch, cookie MCP and runtime HTTP share strict filters, actual historical bodies, current ACL and credential ceilings. Agent legacy offset DTO remains, with signed cursors and explicit historical metadata status. Unknown history is never filled from current title/conditions.
- Default search/context uses canonical currentRecommendation, excluding active+replacementId, archived and future-effective pages. Explicit history/read stays available and is not described as current recommendation.
- [API decisions, North Star invariants and remaining limits](implementation/2026-11-16-unified-search.md). Semantic selection and index operations are separate following units; no whole-requirement or company model quality/agent-performance acceptance claim.
- Verified Task1a: final Node24 `npm run check` passed (src172 + Node48 + imports16 + evaluation41, requirements251, server typecheck, build/static HTTP smoke). Native PostgreSQL17 per-file runner passed 10 files/68 tests; final changed-search rerun passed 3 files/24 tests after cookie DTO compatibility mapping. No model/provider calls or semantic quality claim in this unit.

## 2026-11-16 Task1b - configured semantic retrieval

- Requirements: SRH-001/002/003/004/005/007 and CORE-009/010 implementation scope. Actual model selection over the complete authorized filtered corpus (up to100 versions, without lexical prefilter), exact quote checks, canonical historical metadata and current source/dependency checks. Durable budgets, actual telemetry and current result-read authorization remain enforced.
- Connected authenticated REST, agent/cookie MCP and web mode admit/poll real jobs; unconfigured/policy/budget/limit/invalid-output cases remain failures. No answer/wiki/publication effect. [API, North Star decisions and limits](implementation/2026-11-16-semantic-search.md), [1440/390 browser evidence](pr-assets/semantic-search/README.md).
- Company semantic quality, external CLI interoperability, large-wiki performance and downstream utility remain unverified acceptance; native provider replies are synthetic. Index freshness/rebuild is separate Task1c.
- Validation Task1b: final Node24 npm run check passed (src173, Node48, imports16, evaluation41, requirements251, server typecheck, build/static HTTP smoke). PostgreSQL17 per-file isolated broad regression passed15 files/154 tests; final semantic11-test isolated rerun passed after malformed-schema repair. Browser1440/390 success/failure screenshots are explicitly synthetic UI evidence.

### Task1b review corrections - semantic retry and key collisions

- Stored job kind and sealed semantic payload are checked before accessing snapshotHash. Reusing an ordinary query/lint key returns IDEMPOTENCY_CONFLICT and creates no additional job/model call.
- Web semantic search releases its key when job progress definitively reports dead/cancelled, allowing identical-filter retry to create a fresh job. Unknown admission, network interruption and poll timeout retain the original key to prevent duplicate uncertain jobs. No layout changed; existing screenshot evidence remains applicable to presentation.
- Added native query/lint collision RED regressions and UI dead/cancelled/new-key plus admission-network/poll-network/poll-timeout/same-key checks. Final command/results recorded below after execution.
- Review-fix validation: final Node24 npm run check passed (src178, Node48, imports16, evaluation41, requirements251, server typecheck, build/static smoke). Isolated PostgreSQL17 runtime52 plus semantic13 tests passed; UI semantic6 passed. Both terminal retry and uncertain same-key cases are executed regressions. git diff --check clean.
## 2026-11-16 — Task 8: subscriptions and event notifications (CLB-004–006)

- Isolated native worktree branch `feat/roadmap-notifications-20261116`, based on `5218828`; feature contract: [notification API and boundaries](superpowers/specs/2026-11-16-notifications-contract.md).
- Migration 120, `server/collaboration/events.ts`, collaboration service/HTTP/worker and canonical publication review gate connect current category/space subscriptions to transactional publication/review/final-job-failure events and explicit lifecycle expiry. Document comments join these subscriptions. The notification panel exposes subscription changes, event meaning and per-recipient processing; the lifecycle panel exposes reason/CAS-bound UTC expiry.
- Current active identity, canonical review qualification, current subscriptions and all input/source ancestry are checked before content and again by existing digest finalization. Event IDs deduplicate retries/overlapping subscriptions; internal envelopes never enter DTOs. Failure notices stay with the explicit human actor/current service sponsor. Owner status cannot bypass source ACLs.
- New tables are classified in retention inventory; category names stay in PostgreSQL, subscription configuration is removed during workspace erasure/recovery, and typed outbox/notification references join the existing erasure graph.
- Validation: `npm run check`; isolated PostgreSQL 17 tests for retention compatibility/product erasure, collaboration, event flow, review races, workflows, runtime collaboration host and new subscription HTTP host; notification/expiry React interaction tests. [Actual 1440/390 Chromium screenshots and fixture conditions](pr-assets/roadmap-notifications/README.md). Final command evidence and commit are recorded in the feature PR.
- Limits: topic means current `Page.category`; historical events are not backfilled; event projection requires the configured existing dispatcher. Expiry is a notification deadline, not an automatic deletion or a new recommendation policy. External directory/email gateway and company operations acceptance were not exercised; no external message was sent. Semantic quality/downstream business effects remain evaluation targets.

### Task 8 independent review N1 follow-up

- The publication outbox stores its originating batch in `resource_id`. Corrected erasure lineage to treat both publication and pending-review resource IDs as batch references, preserving the separate publication target page edge.
- Added failing-first exported graph selection regression and native PostgreSQL source-scoped execute/recovery replay regressions. They ensure source → batch → event → notification cleanup reaches an event whose target page is independently retained; the retained page title remains intact. No migration or UI change.
- Validation: `npm run check` plus targeted erasure graph/product/DB, collaboration events and native subscription HTTP regressions, recorded in the PR follow-up and task report. Independent review and integration branch CI remain separate from these local checks.
## 2026-11-16 — EDT-012 다중 문서 편집
- 서버 서명된 10분 유효 미리보기를 사용자·공간·자격증명에 고정하고 최대50문서의 태그 교체·상위 이동·보관을 현재 ACL과 metadata CAS로 적용한다. 문서별 성공/실패/제외를 반환하고 실패 대상만 새 미리보기로 재시도한다. 기존 검토/발행 본문과 권한은 변경하지 않는다.
- 실제 운영 WorkflowPanel에 연결했으며 합성 API 브라우저1440/390 캡처는 docs/pr-assets/bulk. Node24 npm run check, 실제 PostgreSQL17의 도메인/네이티브 OIDC·CSRF·HTTP회귀4개, UI2개 통과. 서버 재시작 뒤 미리보기는 다시 생성해야 한다. 실제 사내 인수·지식 성과는 별도다.

- EDT-012 review fixes: canonical Page.tags/search metadata now agree. Atomic per-target workflow_events receipts support same-preview reconciliation after response loss. Unknown/unprocessed outcomes remain visible; current authorization is required to read a receipt. Preview validity is ten minutes and restart requires new preview; company acceptance remains separate.

## 2026-11-16 — 탐색 대시보드 최신 통합 검증
- PR30을 main5218828과 통합했다. 원래 인계·실수 기록을 보존하고 discovery GET과 최신 인증 me 경로를 함께 유지했다.
- Node24 npm run check 통과. PostgreSQL17 격리 DB discovery/runtime/access 3파일37개 통과. 실제 Chromium1440/390 합성 명시 미리보기와 document overflow 없음 확인, docs/pr-assets/discovery에 캡처. 실제 회사 품질/대규모/운영 인수는 미검증이다.

## 2026-11-16 - Authentication transaction lock order
- Synthetic actualbrowser concurrent reads exposed SQLSTATE40P01 between directory gate7203101 and a refreshed runtime_session row. The mutation gate now orders shared directory serialization before workspace/session/identity rows. Callback/switch-space join the common gate and OperationsService shared mode uses the same helper. Exclusive mutation operations retain their existing exclusion.
- SQL deadlock/serialization/lock/backend availability failures become AUTH_BACKEND_UNAVAILABLE503 and do not discard a valid session. Current-identity/session/ACL checks remain required, and actual authentication failures still revoke the session.
- Native deterministic blocked-backend regression fails before the fix and passes after it, including preserved session after transient40P01. Node24 npm run check and11nativefiles pass. Actual OIDC browser concurrent reads passed with pool6, 1440/390 Chromium, synthetic Task5 lineage flow, in a separate stacked verification worktree (9de1; local fc46344). Four screenshots and native/browser log are retained in /private/tmp/akh-auth-pool6-browser and /private/tmp/akh-auth-pool6-browser.log. This is not a scalability/SLO claim.
### 2026-11-16 — Task 5 일반 편입 주장 계보·검토 피드백
- 요구사항: KNO-002~006/013/014. 일반 편입 후보를 정확한 원본 위치/fingerprint와 조건·기간·예외에 결합하여 배치에 보관하고, 검토 발행 트랜잭션에서 주장/근거/상충 요청을 저장한다. 반려·사람의 발행 수정·보호 이유는 다음 모델 입력에 고정하며 같은 원본·같은 제안 반복은 차단한다. 원본 정정은 불변 원본/주장을 보존하면서 영향을 받은 발행 버전의 재검토와 미발행 승인 무효화에 연결한다.
- 변경 파일: `server/runtime/{knowledge,ingest-lineage,model,http,errors}.ts`, `server/publication.ts`, `server/refinement/service.ts`, `server/workflows/service.ts`, `src/operational/{App,review-rejection,refinement}.tsx`, 관련 CSS/회귀. 기존 저장소를 사용하며 migration 추가 없음.
- 검증: Node24 `npm run check` 통과(웹173, import16 및 기존 Node/evaluation·251개 요구사항·서버 타입·빌드·HTTP smoke). PostgreSQL·실제 OIDC/모델 HTTP·MCP SDK 계보 회귀와 기존 답변 환류/권한/워크플로/정련/내구 작업 회귀를 실행한다. 최종 native 수치는 PR 검증 기록을 따른다. 실제 Chromium 1440/390 크기와 가로 넘침 검사, 합성 서버 데이터 캡처를 [증거](pr-assets/roadmap-knowledge-lineage/README.md)에 보관한다.
- 남은 조건: 합성 loopback은 실제 사내 모델의 의미 품질·독립 실행 검증·지식 효과·운영 수용이 아니다. 의미상 반복 제안/상충 해석의 정답성은 모델 평가와 사람 검토가 필요하다. 모델 피드백·사람 편집 이력 각100개 및 기존 컨텍스트/작업 예산 초과는 명시적으로 중단한다. Task 6의 질문 주제/현재·과거 범위·조건 컨텍스트는 별도 PR 대상이다.
- 추가 검증 발견(미해결): screenshot pool6의 병렬 인증 GET에서401/세션 폐기를 관찰했고 임시 PG 계측이 identity projection advisory7203101의SQLSTATE40P01을 확인했다(연결 timeout0건). Task5에서 auth/identity/network 경로를 바꾸지는 않았다. [요약](pr-assets/roadmap-knowledge-lineage/auth-deadlock.json)·실수 기록과 별도 검토 인계를 따르며 pool20 캡처 통과를 해결로 표시하지 않는다.

### 2026-11-16 — Task 5 PR52 P1 권한/계보 재검토 보완
- 독립 검토가 재현한 과거 반려안 외부 링크 누락을 수정했다. `rejectedFeedback`은 제안의 모든 기존 대상·외부 링크·과거/파생 원본·상위 문서에 현재 권한을 적용하고 전체 envelope를 반환한다. 하나라도 거부되면 본문/이유/ID 전체를 제외한다. 일반 편입은 이 전체 envelope를 고정하고, 답변 편입은 원래 답변 envelope 안에 완전히 포함되는 피드백만 허용한다. 전송 직전/커밋 직전 범위를 재검사한다.
- 새 파일 `server/runtime/lineage-feedback.test.ts`에서 실제 DB/모델 입력과 실제 HTTP provider를 사용해 페이지/하위 페이지/원본/정책 철회·전송 직전 철회·응답 후 철회·답변 범위·제안 로컬 새 링크를 검증한다. 최초11개 동작 RED를 확인한 뒤 수정했다. 최종 검사 결과는 PR52와 인계 파일을 따른다.
- 같은 변경 집합의 새 페이지 링크와 과거 결정 이력을 보존하되 현재 종합 페이지 선택·원본 공개 상한·모델 정책을 넓히지 않는다. 기존 auth deadlock 수정은 별도 PR이다.
- P1 최종 검증: 리뷰어 원래 실제 PG 재현은 빈 feedback으로 수정 확인. 집중15개(링크/원본/정책 철회와 실제 provider HTTP 포함), 관련 native6파일110개, `npm run check` 웹178/import16/251 요구사항·서버 타입·빌드·HTTP smoke 통과. 로그 `/private/tmp/akh-lineage-feedback-{red,green,final-focused,regression,check,proof-green}.log`. 제품 UI 변경이 없어 기존 캡처를 보존했다.
## 2026-11-16 문서 탐색과 개인 목록

- EDT-007/010, SRH-009/010: `server/workflows/service.ts`, `http.ts`, `src/operational/document-navigation.tsx`, `workflows.tsx`, `styles.css`에 현재 ACL의 링크 후보·백링크·태그 관계(각 20건), 목차·코드/표 검색 위치 이동, 기존 즐겨찾기·최근 API 기반 목록과 개인 초안 링크 완성을 연결했다. 기존 구독 버튼·서버 활동 저장을 재사용한다.
- [API·판단·현재 한계](design/2026-11-16-document-navigation.md), [실제 1440/390 화면](pr-assets/roadmap-navigation/README.md). North Star의 인간 검토·연결된 재사용을 개선하며 본문·원본·ACL·발행 상태를 자동 변경하지 않는다. 의미 유사도·지식 품질·업무 성과 효과는 미측정이다.
- 검증: TDD로 없는 탐색 API·자동완성·삽입 전 권한 철회·코드 예시 백링크 오인 회귀의 실패를 확인하고 수정 후 통과했다. native HTTP에서 OIDC UserInfo·DB 세션·CSRF·현재 원본 ACL 철회 후 탐색/자동완성/개인 목록 제목 제거를 검증했다. Node 24 전체 `npm run check`와 PostgreSQL17 전체 workflow 서버 8파일 회귀를 통과했다. 프런트 178시험, import 16시험, Node/평가·요구사항251·서버 타입·빌드·smoke 포함이며 운영 인수는 아니다.
- 제약: 현재 권한은 요청·포커스 복귀·60초 주기로 재검사하며 권한 변경 실시간 푸시는 포함하지 않는다. 서버는 기존 전체 상태 조회로 ACL을 계산하므로 큰 공간의 부하 시험이 필요하다. 같은 태그를 관련 문서로 표시하며 SRH-009 주제/공간 구독 확대와 실제 사내 인수는 별도다.

### PR #47 독립 리뷰 후 링크 삽입 입력 보존 수정

- `LinkCompletion`의 지연 권한 응답이 최신 삽입 콜백을 사용하고, `WorkflowPanel`이 현재 초안/계정 바인딩과 활성 자동 저장 편집기의 최신 본문을 사용해 대기 중 입력을 보존하도록 수정했다. EDT-007과 초안 저장 경계에 해당한다. 기존 요청 세대/대상 철회 검사는 유지한다.
- `src/operational/navigation-draft.test.tsx`에서 과거 콜백 호출·실제 편집창의 입력 유실 RED를 확인한 뒤 수정했다. React 입력과 실제 DraftAutosave→OperationalApi의 합성 저장소에 동일한 최신 본문·링크가 남는 통합 회귀를 포함한다. 전체 `npm run check`(프런트180)와 native 인증 HTTP 탐색·CSRF·원본 철회 회귀를 재통과했다. 시각 변경은 없어 기존 캡처를 유지한다.

## 2026-11-16 Task1c - native search index operations

- SRH-006/008 and SRH-001/002/004/007 compatibility: migration121 adds actual PostgreSQL body GIN acceleration, committed mutation observations, catalog readiness/actual rebuild outcomes and durable index maintenance in existing workers. Literal Korean/code/wildcard compatibility and canonical current ACL/history filters remain.
- Authenticated status/rebuild REST and a jobs-console panel require configured platform operator plus current space Admin through a verified human session. No generic Admin credential delegation, caller SQL/index selection, service job or schedule path is added. Failed atomic rebuild keeps prior index/last success; recorded failure and later recovery remain distinct.
- [Design, North Star invariants, official SQL references and limits](implementation/2026-11-16-search-index.md), [actual1440/390 browser evidence with synthetic UI provenance](pr-assets/search-index/README.md). Large-index/company workload performance, physical corruption detection and production operating acceptance remain unverified.
- Task1c validation after schema fix: Node24 npm run check passed (src188, Node48, imports16, evaluation41, requirements251, server typecheck, build/static smoke). Isolated PostgreSQL17 recovery/index/erasure/storage68 tests plus runtime/policy/historical-search84 tests passed:7 files/152 tests. New index-native11 and UI3 included; actual1440/390 success/failure browser captures are labeled synthetic UI data. git diff --check clean.
### 2026-11-17 — Task 6 질문 범위와 실제 컨텍스트
- 요구사항: QNA-004, CORE-010. 인증 공간 안의 주제(문서 분류)·현재/과거 발행 기록·UTC 기간·환경 조건을 선택하며, 실제 query provider/REST/cookie MCP와 agent REST/MCP 컨텍스트에 연결한다. 기본 현재 권고와 기존 메서드 인자/필터·작업 예산·멱등 키를 유지한다.
- 변경: `server/questions/scope.ts`, runtime schema/knowledge/model/http/mcp, agents/service, jobs/runtime, refinement/service, workflows/answers, evaluation/run과 웹 질문 범위 컴포넌트. 고정 버전·원본 상한의 주장/전체 예외·유효 기간을 전달하고 전송/저장 직전 재검사한다. 과거 속성 미기록과 적용 조건/유효 시점 미확인은 unknown이며 현재 속성으로 보충하지 않는다. 같은 원자적 발행의 주장은 originBatchId로 구별한다.
- [API·시간·예산·North Star 판단·제약](implementation/2026-11-16-question-scope.md), [1440/390 실제 인증 화면](pr-assets/roadmap-question-scope/README.md). 모델 계약은 `2026-11-17-question-scope-v1`; 기존 모델 작업은 원래 계약 신선도 검사를 따른다. 마이그레이션/추가 Pod 없음.
- 검증: scope/실제 HTTP·OIDC/CSRF·provider·두 MCP·durable replay·철회·예산 회귀와 Node24 전체 필수 검사를 실행한다. 최종 수치는 해당 PR과 작업 보고서에 기록한다. 실제 사내 의미 품질·대규모 비용/지연·지식 효과·운영 인수는 미검증이다.
- Task 6 최종 검증: Node24 `npm run check` 통과(웹195, import16, Node/evaluation·251 요구사항·서버 타입·빌드·HTTP smoke). 최종 집중 native 3파일11개 통과(scope8, 실제 인증/provider/MCP/durable/브라우저2, policy-bound 모델 평가1). 더 넓은 native23파일에서203개 통과/평가1개 실패를 확인했고, 해당 평가 가드 수정 뒤 위 최종 회귀로 재통과했다. 이전 scope7에서 최종8로 확장했다. 평가의 pg 동시 client.query deprecation 경고와 별도 pool6 인증 이슈는 미해결 기록을 보존한다. 실제 1440/390 역사 질문 제출·저장 답변 재조회·가로 넘침 검사는 통과했다. 독립 리뷰·원격 CI는 PR에서 별도로 확인한다.

### 2026-11-17 — PR58 독립 검토 보완
- QNA-004/CORE-010: 유효한 UTC 기간의 소수점 정밀도 차이를 downstream searchFilters도 실제 시각으로 비교한다. 서로 독립인 페이지의 source_refs에는 각 페이지의 전체 계보만 넣으며 전체 선택 envelope는 권한/전송 검사에 유지한다. 페이지별 주장도 그 페이지의 계보 envelope에 제한해 다른 검색 결과가 근거 상한을 넓히지 않는다.
- 기존 agent conditions의 reviewDue/lifecycle와 미등록 project/environment/effectiveFrom의 null을 복원한다. canonical metadata와 기존 키는 함께 제공하며, 미기록 과거 속성에는 현재값을 대입하지 않는다. UI 레이아웃 변경이 없어 기존 1440/390 증거를 재사용한다.
- 검증: 혼합/동일 UTC 정밀도, 두 독립 페이지 source_refs/정확한 바이트 예산, 전이 계보, 현재 조건 DTO/미기록 과거 null 회귀를 추가했다. 기존 실제 provider·OIDC/CSRF·두 MCP와 agent REST DTO 회귀도 확장했다. 최종 실행 결과와 커밋은 PR58 재검토 보고서를 따른다. root의 최신 base 통합은 이 보완에서 수행하지 않는다.
- PR58 보완 최종 로컬 검증: Node24 npm run check 통과(웹195/import16/Node·evaluation/251 요구사항/서버 타입/build/smoke), native6파일31개 통과(scope13/실제 인증provider·MCP·REST·durable2/agents9/search-regression5/search-MCP1/policy-evaluation1). RED 로그 `/private/tmp/akh-question-scope-review-red.log`, 최종 `/private/tmp/akh-question-scope-review-final.log`; pg deprecation은 계속 관찰되며 미해결이다. 독립 재검토·base 충돌·원격 CI는 root 인계 대상이다.
## 2026-11-17 - Task15 additional actual collector fixture
- COL004 implementation adds explicitly pinned OpenCode2.3.0 synthetic pending input via the trusted private host/session path, with actual installed-server fixtures (IDs anonymized, no model/tools/work data). Live GET verified the pending inbox differs from the legacy message endpoint; only the exact selected item is persisted after strict session/version/revision/exclusion checks.
- Native36 tests and fullnpmcheck passed. No UI/migration/newPod. Assistant/tool output for2.3.0 and corporate approved-host installation remain unsupported/unverified. [Contract and capture limits](implementation/2026-11-17-additional-collector.md). Independent review/finalCI remain required.
## 2026-11-17 — LIF-008/009 검토 기반 구조·속성·이력 아카이브 복원

- 요구사항: LIF-008/009. `server/storage/service.ts`, `imports.ts`, 새 `roundtrip.ts`와 canonical `publication.ts`/`workflows/versions/metadata.ts`, 오류 계약을 연결했다. 기존 인증 HTTP의 export/import/propose에서 v2 아카이브를 생성·검역·검토 제안한다. 실제 승인/발행 트랜잭션이 본문·사실·링크·분류·태그·사용자 속성·환경·부모 트리를 복원한다. 단순 부모 링크나 검역 보관만을 복원으로 표시하지 않는다.
- 원래 version metadata/metadata-only events와 과거 페이지·원본·첨부 메타데이터, remap을 보존·재내보내며 imported history는 `unverified-import` 근거다. 기존 로컬 과거 버전·승인·검증 시각으로 소급 삽입하지 않는다. selective review의 파생 배치에도 이력 근거를 유지한다.
- 변경되지 않은 속성도 현재 hash에 고정하며 base/settings/policy/부모 순환과 발행 직전 ACL·원본 상한을 검사한다. 기존 ACL·보호·소유권·검토 기한·수명주기는 유지한다. 새 ID는 현재 인간 소유자의 개인 공간에서 private/미검증으로 새 로컬 버전을 만들며 수입 권한·역할·공식성·egress 허가를 적용하지 않는다. 개인 공간의 기존 self-review 예외 외에는 독립 검토가 필요하다.
- 새 페이지 첨부는 제안 중 원본 상한에 묶고 실제 발행 때 모든 revision의 hash/scan/head와 현재 독자 상한을 확인한 후 실제 페이지 부모로 함께 옮긴다. 논리 slot이 없는 원본 스냅샷은 그대로 둔다. 중복 stage/propose/publish는 기존 durable 기록을 재사용하며 실패 시 페이지 버전·속성·첨부 부모 변경이 롤백된다.
- [판단·API·한계](design/2026-11-16-export-import-roundtrip.md). North Star의 연결된 근거·검토·발행·재편입 순환을 보존하기 위한 변경이며 품질/업무 성과 향상은 미평가다. 새 migration·서비스·Pod·UI는 없고 1노드/앱1/DB1 초기 구성을 유지한다.
- 검증: TDD의 v2 미지원·속성/실제 트리 미복원 RED와 기본 부모·selective 이력·미변경 속성 drift·새 첨부 부모/복수 revision·slot 없는 스냅샷·remap 이력 누락을 재현했다. canonical 첨부 hook을 제거하면 승인 후 scan/head 변경 회귀 2건이 잘못 발행됨을 확인한 후 hook 복구로 차단했다. 실제 native HTTP/격리 PostgreSQL은 DB 세션·loopback OIDC UserInfo·CSRF·원본/부모자식/속성/이력·첨부2버전·독립 승인·원자 발행·재시도·현재 원본 ACL 철회를 실행한다. 최종 Node24 `npm run check`와 영향 범위 native PostgreSQL 15파일108시험의 결과는 PR/작업 보고서에 기록한다.
- 제약: 같은 workspace의 허용 아카이브만 지원한다. v1은 종전 content-proposal 호환이며 v2의 속성 복원 보장이 소급 적용되지 않는다. 5MiB/100문서·원본·blob/20제안문서 및 bounded history 제한을 초과하면 거부한다. 과거 이력은 inspect/re-export 가능한 미검증 근거이며 현재 버전 목록의 확정 발행본으로 나타내지 않는다. 실제 회사 IdP/기밀 자료·모델 품질·대규모 부하·운영 인수는 미검증이다. UI 변경이 없어 새 화면 캡처는 없다.
## 2026-11-17 Task 7 — Weekly maintenance / Monthly proposals

- MGR-003/004, 관련 MGR-005/006·CORE-007/008/011. `server/refinement/maintenance.ts`, `server/jobs/{runtime,service,schedule,types}.ts`, feature/model/error contracts, `src/operational/jobs.tsx`와 회귀를 변경했다. 기존 Daily 편입은 유지하고 Weekly를 기존 지식·주장·연결·공백·오래된 내용의 구조 후보/실제 모델 다중 문서 제안으로 분리했다. 정확한 입력과 적용 조건·근거 버전/인용·기준 버전·정책·보호·예산과 독립 검토/발행 경계를 유지한다.
- Monthly는 담당자 증거가 없으면 unknown, 보존 분류/현 정책/보류와 영향 문서, 실행 주체의 공간별 실측 비용 두 달 비교를 제안만 한다. 소유권·정책·권한·보존/삭제 API를 호출하지 않는다. 누락 가격은 비용 0으로 승격하지 않는다. 달력 기준 월간 현지 일정과 명시 clamp/skip, 실제 회차·승인 revision 시간대, 제한 보충과 원자적 체크포인트/재시도를 연결했다. 추가 인프라는 없다.
- [상세 설계/계약](implementation/2026-11-16-maintenance-cycles.md). Node24 전체 `npm run check` 통과(192 source + 48 Node + 16 import + 41 evaluation, 251 요구사항, server types, build/smoke). 파일별 UUID DB의 PG jobs 전체 115시험 통과 후 주장/unknown meter 2회귀를 추가해 maintenance runtime 9/9 통과. 실제 loopback OIDC/HTTP/CSRF/일정 실행·원본 철회와 실제 HTTP 모델의 2문서 제안·독립 검토/발행, stale/protection, 커밋 중단 후 동일 제안 재사용을 확인했다. 최종 head 검증과 1440/390 화면은 PR/자산 기록을 따른다.
- 한계: 의미 품질·업무 효과와 사내 운영 인수 미검증. 혼합 source scope 종합은 별도 승인한 일정으로 나눈다. 현재 monthly 비용은 서비스 주체의 공간별 usage ceiling이며 전사/타인 비용 전체를 보여 주지 않는다. 기존 인증 잠금 문제 수정은 별도 PR이며 Task7 브랜치에 포함하지 않는다.

- Task7 실제 화면: [1440/390 캡처와 검증 commit/환경](pr-assets/roadmap-maintenance/README.md). 별도 승인 auth 수정이 적용된 native 검증 worktree의 실제 pool6/OIDC/HTTP에서 월간 일정 저장→정본 재조회와 가로 overflow 없음·pageerror 0을 확인했다. 최종 기능 프런트 소스는 동일하며 인증 수정은 별도다.

Final feature validation (2026-11-17): `npm run check` passed after ancestry hardening and the final editor caption (192 source + 48 Node + 16 import + 41 evaluation; 251 requirement mappings, server types, build and HTTP smoke). Native isolated PG jobs suite passed 6 files/118 tests; the final maintenance runtime file then passed 11/11 after adding the canonical missing-link admission regression. The separate approved-auth verification build passed the real OIDC HTTP test after actual browser save/capture and cleaned its owned DB. Screenshot UI blob: `a024b69d757560caa02a43a2a2d19a2d0b53855d`, identical in feature and verification commit `9d0da1a883db71fd9594d124680b48bb24a4cb81`. Final remote CI and independent review remain separate gates.
### Task3/Task2 integration safety
- Resolved overlapping published-body UI by using the shared safe Markdown renderer inside DocumentBody navigation. Outline/find decorate existing DOM without replacing authenticated attachment handlers. Math/SVG/control/status nodes are excluded from text marking. An integration regression failed on an external img before the change; safe image/math/find/preview and existing navigation/draft tests16 now pass. Fullcheck passed; actual integrated screenshots and scoped independent review follow.

- Task3/Task2 final base integration: Node24 npmruncheck passed, native presentation-http/navigation-http/bulk3files passed, actual Chromium1440/390 safe-renderer navigation fixture passed outline4/find1/math/diagram/preview with external0/errors0/overflowfalse. Synthetic component input/reader is explicit in capture README; original actualOIDC/runtime/DB flow remains separately evidenced.

## 2026-11-17 Task 14 — 예약 발행 (REV-011)

- 요구사항: REV-011, GOV-007, 현재 승인/원본 상한/기준 버전 불변식. [실행 계약](implementation/2026-11-17-scheduled-publication.md).
- 변경: migration128 `scheduled_publications`, 인간 세션에 묶인 단일 발행 동의, 엄격 HTTP 미리보기/예약/상태/취소, App1 15초 스캐너, 정본 `preparePublicationDb`/`publishInTransaction` 공통 검사, UTC/기기 시각 UI. 일반 에이전트 job은 승인·발행하지 않는다.
- 수명주기: retention 명시 분류와 원본→batch→예약 계보, 법정 삭제/복구의 typed 취소·비밀 참조/결과 정리. unknown fail-safe 보존.
- 검증: 전체 `npm run check`에서 UI/domain214, script48, imports16, evaluation41, 요구사항251·서버 타입·build·static HTTP smoke 통과. 초기 실제 PG 예약12/정본25/버전8과 실제 OIDC HTTP1 통과. 최종 실제 PG9개 파일114개 테스트(예약14, OIDC HTTP1, legacy2, 삭제18, 정책14, retention30, auth2, 정본25, 버전8) 통과. [화면1440/390](pr-assets/scheduled-publication/README.md)은 실제 컴포넌트+합성 API이며 인증 브라우저 E2E로 주장하지 않는다.
- 제한: 현재 세션/절대/유휴 만료 이전 예약만 허용한다. 장기 위임·정각 SLA·운영 배포·사내 IdP·실제 모델 품질과 지식 효과는 미검증이다. 기능이 꺼져도 기존 조회/취소는 유지하며 도래 실행은 실패 상태를 남긴다.
## 2026-11-17 - First ready wave to main
- User requests incremental completed-PR merges. This wave contains canonical/semantic search, document navigation, bulk edits, subscriptions/events, fixed-descendant sharing, ingest lineage/feedback and safe document/image rendering. Each immutable feature head passed final8 CI and independent scoped review. Product code from PR52ee1599d is integrated; its corrected-base verification note remains its separately tracked PR completion.
- Broad combined review found no new Critical/Important issues and independently verified native21/UI19. Integrated requiredchecks and targeted native cross-feature regressions passed; final main-PR CI remains required before merge. Existing PR49 design documents and all251 requirements are preserved.
- Extra auth/index, question-scope, export/import, weekly/monthly and remaining tasks continue separately; no whole-roadmap or company operations/model-quality completion claim.

### 2026-11-16 — PR #47 내부 링크의 초안·발행 계보 보존

- EDT-007/010, SRH-009/010 및 ACL/CORE-006의 원본 상한·검토 발행 불변식: 자동완성은 삽입 직전 재확인한 대상 ID/버전을 기존 `dependencyVersions`에 보존한다. 진행 중인 이전 자동 저장 응답이 새 입력과 링크 바인딩을 지우지 않도록 합친다. 기존 최신 콜백·현재 편집기·신원·요청 세대 검사를 유지했다.
- 서버 `WorkflowService`의 기존 Markdown 탐색 파서를 재사용해 저장과 직접 제안에서도 같은 공간의 링크 대상을 현재 권한으로 확인한다. 저장된 의존 집합과 새 참조를 합치므로 클라이언트 메타데이터나 URL 제거가 기존 계보를 제거하지 않는다. 제출은 현재 대상 버전과 일반 `captureEnvelope`·발행 권한 검사로 대상 페이지/원본의 독자 상한을 유지한다. 모델 호출·마이그레이션·원격 변경은 없다.
- 변경 파일: `server/workflows/service.ts`, workflow 서비스/인증 HTTP 회귀, `src/operational/document-navigation.tsx`, `workflows.tsx`, 탐색/자동 저장 회귀. 코드 예시·외부/다른 공간 제외와 이전 지연 응답 입력 보존 회귀를 유지했다. `constructor`처럼 객체 프로토타입 이름과 겹치는 유효 문서 ID도 의존 집합에 포함한다.
- 검증: 초안 계보 누락/철회 저장·제출/가짜 대상의 서버 RED 6건과 클라이언트 누락 RED, 진행 중 저장 응답의 바인딩 유실 RED, 프로토타입 이름 누락 RED를 관찰했다. 수정 후 Node24 `npm run check` 전체와 전용 native PostgreSQL17의 workflow·인증 HTTP·보존/복구 5파일 73시험, 클라이언트 3파일 13시험을 통과했다. 화면 모양은 변하지 않아 기존 PR #47의 1440/390 캡처를 유지한다.
- 한계: 과거에 계보 없이 저장한 뒤 URL도 제거한 자유 텍스트의 출처를 소급 추정하지 않는다. Docker dump/restore·실제 회사 자료/디렉터리·운영 인수는 미실행이다. 독립 재리뷰·원격 최종 CI·발행은 별도 확인한다.


### 2026-11-16 — 내부 링크 계보의 독립 리뷰 후속 폐쇄

- 이전 `ad2fbca`의 검증 뒤 독립 리뷰에서 저장 핀 덮어쓰기, Zod의 `__proto__` 키 제거, 렌더된 query-relative/HTML 링크 누락, 템플릿 우회, 업그레이드 전 초안 URL 유실을 추가로 확인했다. 하나의 수정 묶음으로 대응하며 새 편의 기능이나 접근 권한은 추가하지 않았다.
- 저장/이력의 의존 버전은 immutable union으로 합쳐 충돌을 `STALE_VERSION`으로 거부한다. 클라이언트의 반복 자동완성도 기존 핀과 다른 버전이면 본문을 변경하지 않는다. 공통 키 보존 스키마는 save/propose/recovery에 적용하며 ordinary envelope의 page/source 해시 맵도 `__proto__`를 own key로 보관한다.
- `marked`가 렌더한 HTML을 parse5로 읽어 query-relative 링크·HTML anchor·엔티티 인코딩을 같은 공간 관계에 포함한다. 코드 예시·다른 공간·절대 외부 URL 제외를 유지했다. parse5 8.0.1은 기존 lockfile의 전이 패키지를 고정 버전 그대로 runtime 직접 의존성으로 승격했으며 MIT 원문과 고지를 추가했다. entities 8.1.0도 버전을 바꾸지 않았다.
- 초안 목록/저장/제출과 복구는 기존 현재·이력 본문의 URL 증거를 확인해 다음 입력이 URL이나 메타데이터를 제거해도 대상을 보존한다. 알려진 다중 출처 초안의 템플릿 편입은 지원하지 않고 안전하게 거부한다. 현재 저장한 초안 ID/리비전에 템플릿 작성을 바인딩하고, owner 범위의 일치 본문/동일 원본 페이지 초안·이력도 검사해 바인딩 생략 우회를 막는다. 기존 안전한 plain/단일 origin 템플릿은 유지하지만 같은 원본에 추가 계보가 있는 초안 이력이 있으면 보수적으로 제한할 수 있다.
- 검증 명령/원시 출력은 `.superpowers/sdd/navigation-lineage-repair-plan/task-1-report.md`에 추가했다. 새 서버 18건 RED·반복 삽입 2건 RED 및 외부 sentinel/ordinary envelope 키 누락 RED를 관찰한 뒤 집중 GREEN, 최종 전체 `npm run check`를 실행했다. 모델 품질·회사 인수·Docker dump/restore는 검증하지 않았다. 부모 작업에서 새 커밋 범위만 독립 재리뷰·원격 발행을 담당한다.


### 2026-11-16 — 링크 계보 수정의 round 2 회귀 복구

- `132ec8d` 독립 재리뷰는 앞선 5개 계보 문제의 수정을 확인했지만, 변경분의 신뢰 origin·템플릿 바인딩·과거 초안 목록 처리에서 3개 Important 회귀를 추가로 발견했다. 이를 같은 로컬 작업 트리에서 수정했으며 원격 변경은 하지 않았다.
- APP_ORIGIN에서 유래한 runtime `options.origin`만 WorkflowService와 DraftRecoveryService에 전달한다. 같은 배포의 절대/네트워크 Markdown·HTML href를 포함하고 외부 origin·다른 공간은 제외한다. Request Host/본문을 신뢰 기준으로 사용하지 않는다. 설정하지 않은 순수 fixture는 상대 URL만 추론한다.
- 검증된 템플릿은 지정한 source draft ID/리비전의 불변 본문·origin과 그 리비전까지의 출처만 검사한다. 같은 A의 독립 초안이나 원본 초안의 이후 B 추가가 기존 안전한 템플릿을 오염시키지 않는다. 추가 출처 템플릿 거부는 유지하며, unbound legacy 템플릿은 owner 범위의 실제 일치 본문 증거로만 보수적으로 검사한다.
- 과거 초안의 명시 핀을 모두 먼저 합친 뒤 URL의 빠진 바인딩을 추론한다. 기존 핀들이 서로 충돌하는 pre-upgrade 초안은 목록의 해당 항목만 제외하며 건강한 다른 초안은 읽을 수 있다. 충돌 초안의 저장·제출은 계속 거부한다.
- RED: 신규 closure 9건과 native HTTP same-origin 1건 실패, 기존 closure 21건 통과. GREEN: 최종 native PostgreSQL 7파일 115시험과 Node24 전체 `npm run check`(프런트 181시험 포함) 통과. 세부 명령과 원시 출력은 같은 task report에 추가했다. 기존 late-typing·원본 상한·erasure/current-session·검토 발행 불변식은 유지한다. capped 정확 ID 검색과 반복 visibility 비용은 여전히 Minor 제약이며 Docker/실제 운영 인수는 미실행이다.

### 2026-11-16 — 내부 링크 계보 수정의 통합 브랜치 검증

독립 spec/quality 리뷰와 두 차례 범위 재검토에서 Important 잔여 없음. 검토한 ca6c958..7bb6d86의 세 수정 커밋을 bulk #45·구독 #48이 포함된 통합4f50478 위에 옮겼다. git range-diff로 코드 patch 동등성을 확인했고, MISTAKE_LOG의 양쪽 추가 기록만 함께 보존했다. 최종 통합 소스09fa3b1에서 Node24 `npm run check` 통과(프런트49파일191시험·원래251요구사항·서버 타입·빌드·HTTP smoke), 전용 native PostgreSQL17에서 workflow/lineage/native HTTP/recovery/retention/provenance/bulk 8파일122시험 통과. Docker dump/restore·배포·사내 수용·원격 CI는 이 로컬 결과로 주장하지 않는다. 템플릿의 추가 계보는 아직 fail-closed이고, 충돌하는 legacy 초안은 목록에서 개별 제외되어 별도 복구가 필요하다.

통합된 #48의 승인 대기 검토 이벤트 유실은 별도 미해결이다. PR48 리뷰5921247928·5921544871에 재현 경로가 있으며, 이 내부 링크 수정은 해당 이벤트 문제를 해결하지 않는다.

## 2026-11-17 PR60 독립 리뷰 A — Weekly 공통 주장 후보 계약 연결

- 검토에서 통합 기준 `7791a75`의 모든 ingest 모델 요청이 허용하는 `candidates`를 Weekly의 strict schema가 거부하고 canonical 배치에 후보/변경 이유를 넘기지 않음을 확인했다. 기존 테스트가 후보 없는 응답만 사용한 것이 검증 격차였다. 같은 Task7 브랜치에 지정 통합 기준을 병합하고 semanticSearch/query 및 기존 문서/모델 계약을 보존했다.
- `server/refinement/maintenance.ts`는 공통 `proposalCandidateInput`와 `runtime/ingest-lineage.ts`의 `bindCandidates`를 사용한다. 고정된 전체 현재 권한 문맥의 정확한 원본 텍스트에서 source fingerprint·인용 위치·미검증 상태를 서버가 바인딩하고, `candidates`와 `evolutionReason`을 검토 해시에 포함된 canonical `propose`로 전달한다. 독립 승인·발행 때만 새 버전의 주장·근거가 저장된다. 기존 무변경 응답/후보 필터와 권한·보호·예산·실제 producer 검사를 유지한다.
- 실제 loopback HTTP 모델의 유효/빈 후보 응답이 실패하는 RED 및 invalid quote/source/target가 공유 binder에 이르지 못하는 RED를 확인했다. 수정 뒤 신규 후보→검토/발행→버전2 주장/정확한 원본 근거, empty no-change, 전송 중 철회, 후보/이유 승인 해시 변조, 발행 전 원본 철회 원자성까지 maintenance runtime 20/20 통과했다. 통합 기준의 잠금 파일과 일치하는 의존성은 기존 symlink만 해제한 뒤 이 worktree에서 `npm ci`로 설치했고 다른 의존성 폴더를 변경하지 않았다.
- 최종 전체 검사와 jobs/refinement/lineage 전체 회귀 결과, 새로운 head 및 독립 재검토 상태는 아래 후속 기록·PR60을 따른다. UI blob은 기존 캡처와 같으며 이번 교정은 서버 계약이다. 실제 의미 품질·독립 업무 증거·사내 운영 인수는 미검증이다.
- PR60 검토 A 최종 로컬 검증: 통합 `7791a75`와 교정 코드의 Node24 `npm run check` 통과(source215, Node48, imports16, evaluation41, 요구사항251, server types, build/smoke). 기존 presentation의 큰 청크 경고는 남으며 빌드는 성공했다. `scripts/test-server.mjs server/jobs server/refinement server/runtime/lineage.test.ts server/runtime/lineage-feedback.test.ts server/runtime/lineage-http.test.ts`는15파일224시험·exit0. 실제 접근 불가 원본을 추가해 모델 입력에서 원문 sentinel이 제외되는 강화 회귀까지 최종 maintenance20/20 재통과. UI 소스 blob은 `a024b69d757560caa02a43a2a2d19a2d0b53855d`로 캡처와 동일하다. 독립 재검토·최종 원격 CI는 별도다.

## 2026-11-17 첫 완료 로드맵 묶음 main 통합

- 완료된 #45/46/47/48/50/51/52/53/56/60/62와 인증 수정 #54를 PR #59에 통합한다. 별도 편의기능 C1 main `a1dba1f`도 보존했다. C1 충돌은 App의 ReviewRejection 및 convenience imports, workflows의 BulkEditor 및 NavigationProtection imports를 모두 유지했으며 양쪽 인계/실수 기록을 보존했다.
- C1 통합 후 및 인증 통합 후 Node24.22.2 전체 npm run check가 각각 통과했다. 주간 모델/알림/계보 관련 통합 native도 통과했다. 인증·수집·navigation의 원본 시험은 호스트/DB 시계 차이를 관찰한 뒤 동일 시계 컨테이너에서18건 전부 통과했다. 실패와 환경 제약은 MISTAKE_LOG에 기록했다. 최종 원격8개 필수 검사를 확인한 뒤 main에 머지한다.
- 남은 Task1c/6/10/11/12/13/14/15/16/17/18/19는 각각 별도 PR로 계속 진행한다. 1노드/App1/DB1 최소 리소스 기준, 전체251요구사항, 현재 ACL·원본 상한·독립 검토/발행 불변식을 유지하며 의미 품질·사내 SSO·운영 인수를 주장하지 않는다.

### 2026-11-16 — PR #56 native HTTP 통합 시험 시간 예산

- 부모 작업이 전달한 원격 CI `43890549626`의 PostgreSQL 119파일 실행에서 `navigation-http.test.ts` 단일 사례만 기본 5000ms를 초과했다. assertion/product 오류는 보고되지 않았으며 다른 CI 작업은 통과했다. 해당 사례는 fixture migration/bootstrap과 OIDC/current-ACL 검증을 포함한 native HTTP 요청 34건을 순차 실행한다. 이전 로컬 파일 시간도 5.20초로 기본 제한에 근접했다.
- 제품·전역 테스트·CI 설정을 변경하지 않고 해당 통합 사례에만 20초 상한을 명시했다. `server/questions/runtime-http.test.ts`의 20초/30초 native HTTP 예산을 따르며 auth/CSRF·상대/절대/network 링크·Host·원본 철회 검사를 그대로 유지했다. sleep/retry는 추가하지 않았다.
- 전용 native PostgreSQL의 해당 파일 1시험 통과(파일 5.46초), `npm run check:server` 통과. 테스트만 수정한 작은 변경이므로 전체 광역 suite는 반복하지 않았다. 정확한 명령/출력은 기존 task report에 추가했다. 최종 원격 CI 확인은 부모 작업에서 수행한다.
### 2026-11-16 — 렌더링 변경과 링크 계보 수정의 최종 통합

문서 표시 PR #53이 반영된 통합175ed7a를 보존해 링크 계보 수정과 합쳤다. source 충돌은 없었고 HANDOFF·라이선스 고지의 양쪽 항목을 함께 보존했다. 새 KaTeX/Mermaid 의존성은 이 작업 트리의 독립 node_modules에 `npm ci --ignore-scripts`로 설치했다. Node24 `npm run check` 통과(프런트56파일213시험·251요구사항·서버 타입·빌드·HTTP smoke), 전용 native PostgreSQL17의 기존154회귀와 storage presentation HTTP를 포함한13파일155시험 통과. 이전38fa809의 원격124파일 CI도 모두 통과했으나 이 통합 커밋의 최종 CI는 별도 확인해야 한다. 번들 크기 경고와 npm http-proxy 경고는 빌드 실패가 아니다. 알림 승인 대기 이벤트 유실은 앞선 미해결 기록대로 별도다.

### Task3/Task2 integration safety
- Resolved overlapping published-body UI by using the shared safe Markdown renderer inside DocumentBody navigation. Outline/find decorate existing DOM without replacing authenticated attachment handlers. Math/SVG/control/status nodes are excluded from text marking. An integration regression failed on an external img before the change; safe image/math/find/preview and existing navigation/draft tests16 now pass. Fullcheck passed; actual integrated screenshots and scoped independent review follow.

- Task3/Task2 final base integration: Node24 npmruncheck passed, native presentation-http/navigation-http/bulk3files passed, actual Chromium1440/390 safe-renderer navigation fixture passed outline4/find1/math/diagram/preview with external0/errors0/overflowfalse. Synthetic component input/reader is explicit in capture README; original actualOIDC/runtime/DB flow remains separately evidenced.

## 2026-11-17 main PR #59 최종 native 시험 예산 보완

- PR #56의 이후 최종9e209d2를 병합했다. 실제 source 차이는 없고 양쪽 HANDOFF/MISTAKE_LOG29줄을 보존했다. 원격9e209d2의 취소된 macOS job을 정상 재실행해 최신8개 검사가 전부 통과했다.
- 유지관리 기본5초 native 예산 실패를 실제 단계 비용으로 진단하고 해당 파일의 async PG/정책/모델/worker 기본 사례14선언/그룹에만20초 예산을 명시했다. 원본 본문·assertion·제품 timeout·기존15초·순수 달력은 유지했다. Node24 전체 check(프런트293/Node48/import16/evaluation41/251요구사항/types/build/smoke) 및 native21시험 통과. 독립 검토와 최종main CI 후 머지한다. 나머지 기능/첫 배포1노드App1DB1 최소리소스 기준은 계속 유지한다.


## 2026-11-17 C2 개인 알림함 (UXC-01)

- 기준: 격리 worktree e5a9, `feat/convenience-inbox-20261117`, BASE `6d74a369f004dd4fa40eaceaa9bab0d4c3b41a79`(C1 + canonical #48 이벤트/승인 대기 보완 + #54/#60). baseline npm ci offline 및293 frontend/48 Node. #59 이후 main 통합·PR·독립 리뷰는 컨트롤러가 수행한다.
- 연결 요구사항: UXC-01, CLB-002/004/005/006/007, JOB-007, ACL-008. 기존251 요구사항·North Star·운영 수용 상태는 변경하지 않았다. 사람이 현재 인가된 검토/작업으로 돌아가는 순환을 개선하는 것이 목표이며 지식 품질 또는 에이전트 성능 개선은 대조 평가하지 않았다.
- 변경: migration140은 기존 workflow_notifications/outbox를 확장한다. 수신자 잠금/커밋 순번/이벤트 중복 키, 항목 revision CAS, 서명 경계, 현재 계보 ACL 기반 목록·개수·커서, 지연 전달 및 명시적 미읽음 보존, 재시도 영수증, 기본90일 메타데이터 정리와 기존 삭제/보존 fence. 새 독립 이벤트·메일 엔진은 없다.
- 정확한 대상: 실제 멘션/댓글, 문서 발행, batch 검토 요청/결정, 문서 기한 검토의 현재 work 상태, 페이지 없는 작업 성공/실패, 본인 접근 요청 결정. C1 링크 및 보호된 탐색을 재사용한다. 기존 검토/접근 요청 서비스에 exact detail을 추가해 본인 read-only 결과를 열며 전체 입력 계보 ACL과 기존 관리자 타인 요청 권한은 유지한다. 실제 철회 audit는 unavailable, rejected는 권한이 있을 때 read-only다.
- 파일: `server/collaboration/{inbox,service,events,http,worker}` 및 native inbox/http/upgrade/기존 collaboration 회귀, `server/migrations/140-user-inbox.sql`, canonical publication/runtime/governance/workflow 연결, operations/erasure와 retention/inventory; UI convenience의 Bell/Inbox/client/css/tests, 기존 App/ConsoleShell/ReviewSelection/governance/notifications. DTO 정수 revision 추가와 API·서명 키·조회 상한은 API_CONTRACT/OPERATIONAL_SETUP 및 승인 설계에 기록했다.
- UI: bell5/전체25, 상태·유형 필터, 읽음/미읽음·보관/복원·관찰 경계 일괄 읽음, 활성30초/재초점 갱신과 숨김 정지, 계정/공간 전환·늦은 응답 보호. 기존 구독·전달·기한 검토·설정 화면은 유지하고 중복 알림 목록만 숨겼다. [실제1440/390 light/dark10장·키보드 검증](ui-validation/2026-11-17-personal-inbox/README.md).
- 최종 검사: FINAL2 코드 기준 Node24.22.2, PostgreSQL17.11에서 `npm run check` exit0(frontend301, Node48, imports16, evaluation41, 요구사항251, 서버 typecheck/build/static HTTP smoke). 파일별 disposable PG를 사용하는 native13파일138시험도 exit0. 최종 로컬 로그는 `.superpowers/sdd/2026-11-16-essential-convenience/c2-logs/akh-c2-{check,regression}-final2.log`. 이는 독립 리뷰·CI·main 통합 완료를 뜻하지 않는다.
- 한계/남은 조건: 조회 후보10,000건 초과는 명시적413; 기본 임시 키는 재시작/교체 시 토큰 무효(선택적32~4096자 서버 키로 유지 가능). 실제 IdP/메일/운영 키 배포/대량 부하 및 의미 품질은 검증하지 않았다. App 기존 파일의 formatter 공백 차이를 보존했으며 자동 승인 거절과 환경 실패는 MISTAKE_LOG에 남겼다. 로컬 구현·검증과 독립 리뷰·최종 CI·main 병합은 구분한다.


## 2026-11-17 C2 리뷰 Round1 수정

FIX_BASE be613da의 I1/I2/I3/M1을 실제 실패로 확인한 뒤 수정했다. 승인→발행 뒤에도 immutable 승인 결과 알림을 유지하되 현재 철회·전체 계보 권한과 read-only 경계를 보존한다. 결정 커서는 현재 원본 내용/reader 해시를 내부에 포함하고 DTO에는 노출하지 않는다. 늦은 POST의 완료/오류/busy는 발생 당시 query epoch와 operation에 묶어 새 필터 화면을 덮지 않는다. 미리보기에서 제거된 항목의 초점은 현재 허용된 같은 위치 항목/안전한 버튼으로 옮기며 보호된 과거 행을 남기지 않는다.

최종 한 번 `npm run check` exit0(frontend309/Node48/import16/evaluation41/요구사항251/types/build/smoke), 전용 PG17의 native13파일142시험 exit0. [18장과 실제 도착/철회·Tab 키보드 결과](ui-validation/2026-11-17-personal-inbox/README.md). 원시 RED/GREEN/final 로그는 local task report의 `c2-logs/akh-c2-r1-*`. 기존 Vite chunk 경고는 deferred; 최종 exact-head CI/독립 재리뷰/병합은 미완료이며 운영 인수·의미 품질 개선은 주장하지 않는다.


## 2026-11-17 C2 후속 CI 작업 예산

리뷰 수정8d1cb9a와 별도 커밋으로 `.github/workflows/ci.yml` server job만15→20분으로 조정했다. 이전 be613da의 run44000325932/job133762488115는 약15분 뒤 operation canceled로 종료되었고131/132파일 통과, FAIL 없이 마지막 workflows.test에서 중단됐다. 전체 성공으로 기록하지 않는다. 컨트롤러의 마지막 파일 별도 실행은8d1cb9a/전용 PG32769에서36/36,3.15초,exit0이다. YAML 파싱 및 변경 범위를 검사했으며 제품/시험 assertion/개별 timeout/다른 job은 변경하지 않았다. config/docs만 바뀌어 전체 제품 suite는 반복하지 않았고 exact new HEAD CI의132개 이상 전체 파일 완료와 모든 필수 gate가 병합 조건이다.
## 2026-11-17 두 번째 완료 묶음 통합

- main #59의6366597을 보존한 뒤 #55 인덱스, #58 질문 범위, #61 실제 추가 수집기, #57 구조/이력 왕복을 각각 최종8검사·독립 승인과 통합 회귀 후 머지했다. #64 예약 발행은 같은 원자 발행 코어 안에 가져오기 첨부 훅을 보존해 통합한다. 요구사항SRH-001~010/QNA-004/CORE-010/COL-004/LIF-008/009/REV 발행 관련이며 전체251개 기준·현재 권한/원본 상한은 유지한다.
- 통합 전체check299/48/16/41/251 및 native49시험이 통과했다. 처음 전체검사의 무효한 관리 API fixture 실패와 수정은 MISTAKE_LOG에 보존했다. 원격 최종 CI와 통합 broad review를 통과한 뒤 다음 main PR로 반영한다. 실제 회사 SSO/모델 품질·운영 인수와 성능 효과는 주장하지 않는다. 1노드/App1/DB1 최소리소스 기준을 유지한다.
