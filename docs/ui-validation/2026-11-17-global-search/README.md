# C5 전역 검색·Quick Open 화면 검증

2026-11-17, 기준 main `d4048bda1c93f1951b26a8e33c6d1e7737a4def7`, 격리 worktree `8ef7`에서 Chromium `158.0.8127.18`의 실제 DOM과 native API로 확인했다. Node24.22.2·PostgreSQL17.11·Vite5195/runtime4395, viewport1440×1000/390×844, light/dark 네 조건이다. 모든 full goto 뒤 실제 `document.documentElement.dataset.theme`를 다시 적용·확인했다. 최종 제품16파일 fingerprint는 `77ac4dd368f2e95a54aa91a25e6e60912cbde83410ed147315db9f778f5ea700`이며 [전체 변경 제품 소스 manifest](product-source.json)에 경로·개별 해시·harness 해시를 기록했다.

[최종 browser 결과](browser-results.json)는 네 조건 모두 errors[]/overflowfalse다. 28PNG는 실제 viewport 캡처이며 긴 결과/필터 전체를 한 이미지로 축소하지 않았다.

| 화면 | 파일 이름 (`1440|390`, `light|dark` 각 조합) | 실제 확인 |
| --- | --- | --- |
| 빠른 열기 | `quick-open-<width>-<theme>.png` | 제목 우선10건, 안전한 text snippet, Korean composition, listbox/combobox |
| 상세 검색 | `detail-<width>-<theme>.png` |25건, 실제 이전 응답 지연 gate 뒤 새 조건 유지 |
| 고급 기간 | `filters-<width>-<theme>.png` | datetime-local, 명시적 Asia/Seoul 입력→정본 POST의 UTC 값 |
| 빈 결과 | `empty-<width>-<theme>.png` | 정상0건과 오류 구분 |
| 과거 포함 | `historical-<width>-<theme>.png` | 같은 조회의 현재 제목/v2/현재 버전과 이전 제목/v1/과거 버전을 각 row로 확인 |
| 고정 본문 | `snapshot-<width>-<theme>.png` | 실제 v1·당시 제목, 재사용 DocumentBody·목차·본문, 현재 제목 fallback 없음 |
| 오래된 cursor | `stale-cursor-<width>-<theme>.png` | 실제 source reader 철회 뒤 signed cursor 오류와 결과 제거 |

명시적 opt-in의 합성 runtime은 자신이 만든 `akh_c5_ui_<uuid>` DB만 사용한다. 28개 코드 키워드 문서와 현재/이전 제목이 다른 history page를 실제 DB/동일 트랜잭션 publication hook으로 만들었다. synthetic-session/CSRF는 evidence-only 인증 어댑터이며 실제 IdP·회사 자료·토큰이 아니다. Playwright `route.fetch`는 loopback native API로 전달하며 실제 응답을 사용한다. DTO/성공 상태를 꾸미지 않는다. 지연 gate도 native 응답을 받은 뒤 전달만 지연한다. provider 환경을 명시적으로 제거한 runtime에서 모든 POST가 questions/search이고 model/question/job 생성 POST와 외부 image 요청이 없음을 확인했다.

Ctrl/Cmd+K, 입력/다른 입력 소유자에서 미가로채기, 위/아래·Enter의 정확한 문서 열기, 마지막 활성 row의 viewport 표시, Tab/Shift+Tab trap, Escape의 trigger 복귀를 실제 키보드로 확인했다. bare/plaintext-only editable·alertdialog/native dialog의 합성 DOM 소유자도 원래 제어의 초점을 유지한다. 계정·공간·API·버전별 늦은 응답과 외부 초점 no-steal은 별도 DOM 회귀21개에도 포함된다. 스크린리더 전체 인수는 아니다.

IME는 **Chromium CDP 에뮬레이션**이다. `Input.imeSetComposition`의 compositionstart/update/input은 isTrusted=true, 조합 중 260ms 대기마다 검색 요청0이었다. `Input.insertText` 완료의 compositionend는 isTrusted=false였다. 이벤트를 JS CompositionEvent로 만들어 통과시키지 않았으며 [raw 이벤트](browser-results.json)에 그대로 보존했다. OS 한국어 입력기·다른 브라우저/플랫폼 인수로 확대하지 않는다. [CDP Input 문서](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-imeSetComposition), [Playwright keyboard 문서](https://playwright.dev/docs/api/class-keyboard#keyboard-insert-text)와 설치된 protocol 타입을 참고했다.

날짜 browser context는 Asia/Seoul로 고정했다. DOM의 `2026-01-01T00:00` → 실제 검색 POST `2025-12-31T15:00:00.000Z`, `2026-12-31T23:59` → `2026-12-31T14:59:00.000Z`를 독립 literal로 단언했다. 구현 변환 함수를 기대값 계산에 쓰지 않았다. 빈 값/잘못된 날짜/기간 역전/기존 ISO 보존은 UI·순수 함수 회귀로 확인했다. 검색 렌더는 recent row를 만들지 않고 실제 현재/고정 본문 열기만 인증 actor의 한 row를 만든다. 고정 본문의 focus 재조회는 nonvisit이며 at가 변하지 않는다. source ACL 철회 뒤0건, stale cursor 오류 후0행, 검색어/제목을 URL/localStorage/sessionStorage에 보관하지 않는 것도 확인했다.

최초 구현의 `c5-onecheck-owner-final.log` exit0: frontend385/Node48/import16/evaluation41/251요구사항/서버types/build/smoke. `c5-native-final.log` exit0: 영향10파일106시험(검색/필터/주체·공간·sort·limit·ACL cursor/현재·과거/소스·상위 ACL/버전 실제 방문/HTTP/기존 workflow·personal·index·semantic·MCP). 마지막 shortcut selector만 UI 변경이어서 이 native backend 증거는 그대로 유효하다. 기존 Vite >500kB chunk 경고는 남는다.

최초 전체 check는 새 fixture의 metadataStatus 타입 추론 오류로 build에서 exit1이었다. fixture에 SearchItem 반환형을 명시한 재실행은381개 frontend를 포함해 exit0, 이후 shortcut 소유권 RED4 보완 뒤 최종385개 check가 exit0이다. 초기 browser는 combobox locator 충돌/heading의 버전 누락/IME all-trusted 가정에서 실패했다. 또한 formatter 뒤 harness 문맥 치환이 적용되지 않아 날짜 assertion 없이 result 상수만 들어갔던 실행은 날짜 증거로 인수하지 않았다. 실제 날짜 assertion·4filters PNG를 넣은 final2를 실행했고, UI 소유권 보완과 row별 버전 검증을 포함한 **최초 구현 최종 `c5-browser-final3.log` exit0**에서 당시28PNG/JSON을 만들었다. 현재 artifacts는 아래 F1 최종 실행에서 재수집했다. 실패를 삭제하거나 과거 실행을 최종 성공으로 바꾸지 않는다. 자세한 원인/조치는 MISTAKE_LOG와 task-5-report에 있다.

재현(지원 Node24, 별도의 disposable loopback TEST_DATABASE_URL):

```sh
AKH_C5_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-17-global-search/search-runtime.ts
npm run dev -- --host 127.0.0.1 --port 5195 --strictPort
AKH_C5_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node docs/ui-validation/2026-11-17-global-search/capture.mjs
```

최종 capture 뒤 이 작업의 runtime/Vite만 SIGTERM으로 정리했다. 명시적 소유 DB와 C5 prefix DB가0개이고4395/5195가 닫힌 것을 확인했다. 부모가 소유한 PostgreSQL 컨테이너와 다른 서비스는 건드리지 않았다. raw logs/report는 local `.superpowers/sdd/2026-11-16-essential-convenience/`에 있다. 프로세스 범위 cursor·실제 IdP/사내 자료·3만 사용자 부하·OS IME·전체 스크린리더·의미 품질/지식·에이전트 성과·운영 배포는 미검증이다. 독립 리뷰·원격 CI·PR·병합은 controller의 별도 단계다.


## F1 리뷰 보완 — 이전 head 증거

FIX_BASE100fd4c/PR70 draft의 정규화 동등 편집 정지와 실제 실행 중 발견한 ready/selection 경계를 수정했다. raw invalidate revision으로200ms debounce를 다시 시작하고, focus refresh는 기존 즉시 요청을 유지한다. Quick Open 선택 초기화는 useLayoutEffect로 결과가 입력 가능해지는 시점과 동기화한다. backend/API/schema/legacy QuestionsWorkbench는 동일하다.

프로젝트 RED6(Quick keyword/detail keyword/detail tags×표시/진행 요청) → 관련4파일59 GREEN, 이후 ready commit의 첫 Arrow를 지우는 RED1 → search28 포함 관련4파일60 GREEN이다. 현재 제품의 최종 단1회 `c5-f1-selection-onecheck.log` exit0: **frontend392/Node48/import16/evaluation41/251/servertypes/build/smoke**. 앞선 client-only391 check는 selection 수정 전의 중간 근거다. backend가 바뀌지 않아 기존10파일106 native 증거를 유지하며 재실행하지 않았다. M1 큰 chunk 경고도 유지한다.

현재28PNG/JSON의 실제 최종 로그는 `.superpowers/sdd/2026-11-16-essential-convenience/logs/c5-f1-selection-browser-final.log` **exit0**이다. 네 조건 각각 `equivalentEdits`6개: Quick keyword와 detail keyword의 `코드_retry`→`코드_retry `, detail tags의 `synthetic`→`synthetic, `를 결과 표시 후와 실제 native 응답 대기 중에 각각 실행했다. 새 canonical 응답/현재 행/새 요청의 cursor 미사용을 직접 단언하고 pending gate의 이전 실제 응답을 나중에 풀었다. 수동 검색/refresh는 사용하지 않았다. 프런트엔드 테스트는 보류했던 구 응답이 새 결과를 덮지 못함도 확인한다.

기존 실제 IME/date/timezone/shortcut owner/late response/ACL/empty/error/snapshot/visit/no-storage/no-model 흐름을 모두 유지했다. Quick Open은 결과 준비 직후 추가 sleep/2paint 없이 각 Arrow10개의 aria-active가 현재 DOM의 예상 제목과 연결되는지, wrap 뒤 `코드_retry 안내`가 정확히 열리는지를 단언한다(`readyArrowTitles`). 최초 F1 browser는11-arrow 뒤 search-09로 잘못 이동해 exit1이었다. 이를 단순 harness 문제로 종결하지 않고 deterministic ready-commit RED와 제품 수정으로 해소했다. 중간2paint capture는 중단되어 증거에서 제외한다.

현재 전체 변경 제품16파일 SHA는 **d451c3bd47c7e8c4fdebef7c35ae4bc6a6975002a7b3db33b6f7152cb9497a5c**다. 직전 client-only 단계63919f5d…와 초기100fd의12c71ef…는 과거 bytes이며 현재 manifest와 혼동하지 않는다. 최종 mobile/dark Quick Open을 다시 열어 확인했다. 자기 runtime/Vite를 종료하고 소유 DB0개·4395/5195닫힘을 확인했다. scoped 재리뷰·새 exact CI·병합과 기존 운영/OS IME/의미 품질 한계는 별도다.


## ONE FINAL wave — F2/M2 현재 증거

FIX_BASE e462749의 고급 text IME gate와 Quick Open→상세 검색어 전달을 같은 wave에서 수정했다. 폼 전체 text compositionstart가 pending을 무효화하고 compositionend가 해당 필드의 확정 값을200ms 뒤 적용한다. 메모리 handoff는 API/계정·공간/revision에 묶이며 navigate가 허용된 뒤에만 생성한다. 이미 열린 상세도 조건/과거모드/커서를 초기화하고 다른 identity/API 또는 취소된 이동에는 전달하지 않는다. 검색어는 URL/storage에 넣지 않는다.

프로젝트 새 search13사례 RED11fail/2pass와 App 전달2fail/cancel1pass를 보존했다. 관련4파일76 GREEN 후 최종코드 단1회 `c5-final-onecheck.log` exit0: **408/48/16/41/251/servertypes/build/smoke**. 이전392는 F2 증거가 아니다. Backend/API/domain/legacy diff가 없어106 native는 carry하고 반복하지 않았다. 기존 M1 경고는 유지한다.

현재28PNG/JSON은 **`c5-final-browser.log` exit0**에서 재수집했다. 네 조건 각각 advancedIme2(owner/tag)에서 실제 CDP의 `한`/`한국` 조합 중260ms마다 POST0을 단언하고 commit 뒤 실제 body의 한국/태그[한국]을 확인했다. handoffChecks2는 fresh/already-mounted의 실제25건 요청·검색어·조건/커서 reset·URL/storage 미보관을 확인하며 already-mounted에서는 취소 시 옛 query 유지도 확인한다. 기존 equivalent6/readyArrow10·IME/date/shortcut/snapshot/ACL/no-model 경계와 errors[]/overflowfalse를 유지했다. 모든 true 기록은 해당 실제 assertion 뒤에만 쓴다. CDP commit의 isTrusted=false와 OS IME 미인수 한계는 그대로다.

현재16제품 SHA는 **77ac4dd368f2e95a54aa91a25e6e60912cbde83410ed147315db9f778f5ea700**다. 최종 로그의 정확한 local 경로는 `.superpowers/sdd/2026-11-16-essential-convenience/logs/c5-final-browser.log`다. 자기 runtime/Vite/DB 정리 후 소유 DB0개·4395/5195닫힘을 확인했다. 새 head scoped review/exact8CI/merge와 운영/의미 품질 인수는 controller의 별도 단계다.
