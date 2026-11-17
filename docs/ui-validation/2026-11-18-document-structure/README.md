# C7 문서 트리·이동·복제 — 합성 실행 증거

대상: UXC-06, EDT-004, SHR-001, ACL-006/008. 기준 main `de4e150b7a37003ec23a885fb32205b49d107a7f`(C4 PR72 병합)에서 격리 worktree로 구현했다. 전체 251개 기준과 North Star는 유지한다.

## 실제 검증 환경

Node 24.22.2, macOS, PostgreSQL의 별도 `akh_c7_test_ui_<uuid>` DB, Vite 5197와 canonical runtime 4397, Chromium headless(1440×1000 / 390×844), Asia/Seoul. 브라우저의 주체 선택만 명시적 loopback 합성 어댑터이며 API 응답은 정본 HTTP/DB에서 변경 없이 전달한다. 실제 회사 IdP·기기·모델·품질·운영 인수를 검증한 것은 아니다. HTTP 회귀의 로컬 OIDC provider/세션/CSRF 검증은 별도다.

`structure-runtime.ts`, `capture.mjs`, `manifest.mjs`가 실행 소스다. runtime/frontend 시작 당시 전체 제품 source SHA와 현재 source를 대조하고 캡처한다. `source-manifest.json`은 제품·하네스·회귀·산출물·로그 SHA를 묶는다. `node docs/ui-validation/2026-11-18-document-structure/manifest.mjs --verify`로 검증한다.

## 화면

| 조건 | 최종 화면 |
| --- | --- |
| 1440 라이트 | [문서 트리·3단계 경로](1440-light.png) |
| 1440 다크 | [문서 트리·3단계 경로](1440-dark.png) |
| 390 라이트 | [문서 트리 서랍](390-light.png) |
| 390 다크 | [문서 트리 서랍](390-dark.png) |

[before-fix-390-light.png](before-fix-390-light.png)는 보조 설명이 잘못 노출되었던 **수정 전 실패 증거**다. 최종 화면으로 보지 않는다. 펼치기 aria-label을 유지하고 중복 시각 텍스트를 없앴으며, 데스크톱 토글 CSS 우선순위와 새 트리/기존 개인 목록의 React sibling key 충돌도 수정했다.

`browser-results.json`의 네 독립 공간에서 3단계 탐색, 숨긴 제목 부재, 키보드 이동, 모바일 Escape 후 문서 heading 초점 복귀, 이동 후 옛 ID 링크, 실제 trash→restoreTitle 정본 이름 변경 후 옛 링크, 새 page-less 개인 복제 초안, source ACL 철회 후 트리/개인 초안 제거를 확인한다. drag 위치 선택과 키보드 선택의 동일 form 계약은 UI 회귀로 검증한다. 물리 터치·OS IME·스크린리더 전체 인수는 미실행이다.

## 검증과 한계

- 최종 전체 check: frontend 488, Node 48, imports 16, evaluation 41, 251 requirements, server types/build/static HTTP smoke. 기존 큰 Vite chunk 경고는 남는다.
- Round1 최종transport native3파일4와 마지막 보강HTTP2(실제발급 양쪽MCP·queued session/capability 철회) 통과. 이번라운드 source-compatible6파일77 및 이전 unchanged12파일178 carry로 고유21파일259다. 단일현재259 실행이 아니다. focused UI/navigation/exact recovery63 통과. 상세 명령·시점은 task-7-report.md 및 보존 로그를 따른다.
- migration143: 1002행의 500행 batch 백필, rollback 후 미생성, page identity 유일성, 새 pool/migrate 재실행을 검증했다. order row는 page-linked product metadata이고 정확한 3열 schema 변경을 fail closed한다. 승인된 source/page/workspace erasure와 hold를 실제 DB에서 검증했다.
- HTTP/쿠키세션 MCP 및 새 명시적 C7 action grant는 같은 구조 서비스를 쓴다. 사람 세션이 exact operation/input·최대15분 expiry로 발급한 키만 해당 HTTP와 단일MCP 도구를 호출한다. 현재OIDC/session/credential/current capability/source/parent/erasure는 canonical transaction에서 검사한다. 기존 read/write key·일반 delegated ceiling·별도wiki_*는 바꾸지 않았다. 장기 서비스계정 위임/실제 회사IdP 증거는 아니다.
- 응답/후보 scan은 25/100건으로 제한하지만 현재 권한 해석은 기존 전체 지식 상태와 DB digest 계산을 재사용한다. 대규모 성능 미검증이다. cursor/structure token은 15분 및 프로세스 재시작에 만료되며 권한/자료 변경 시 보수적으로 재조회한다.
- cleanup.json은 소유 runtime/Vite/DB/Chromium profile만 정리한 증거다. 부모 PostgreSQL과 다른 작업은 유지한다.

## Round1 새 실제 흐름

기준 FIX_BASE9e77efa의 기존 캡처는 역사적 근거다. 최종 새 fingerprint는 `f7290771005c698cc5d68728057f372aaa2692d2a632f84746994397e4367100`, runtime17:04:00.626Z/frontend17:04:02.355Z, captured17:05:14.388Z이다. fixture에 실제 상대 문서 링크를 포함하고, 정본 HTTP 응답을 그대로 보류했다가 풀어 race를 만든다.

- 네 조건 모두 이동 후 A GET 보류→B 선택/준비→A 응답 반환에도 B와 외부 선택기 focus 유지: [1440 light](1440-light-move-race.png), [1440 dark](1440-dark-move-race.png), [390 light](390-light-move-race.png), [390 dark](390-dark-move-race.png).
- 390 조건은 drawer의 다른 문서를 키보드 Enter로 선택하고 지연 GET을 해제한 뒤 새 heading focus를 확인: [light](390-light-selection-focus.png), [dark](390-dark-selection-focus.png). 별도 반복은 응답 전 외부 선택기 focus를 두고 이를 보존한다. 기존 Escape도 유지한다.
- 새 실제 local OIDC provider와 정본 발급 endpoint로 exact duplicate grant를 만들고 HTTP machine 호출·linked dependency·rename 후 동일 결과/초안1개·source회수후거절을 검증한다. 양쪽 mutation의 실제 SDK MCP 발급/permit과 기타권한거절은 native HTTP 회귀가 증명한다. synthetic actor adapter 자체를 회사 IdP 증거로 승격하지 않는다.

## Round2 N1 최종 증거

Round1 캡처/hash는 해당 커밋의 역사적 근거다. Round2의 제품 변경은 동일 선택에서 generation token을 보존하는 UI guard뿐이며 backend는 무수정이다. native9files81+12files178은 전부 이전 호환 실행 carry이고 이번 새 native 실행은0이다. 실제WorkflowPanel initial pendingA desktop/mobile RED2→GREEN, 기존 race/focus/recovery 포함65 및 전체check488/48/16/41/251/types/build/smoke 통과.

초기 browser의 nested child locator timeout은 `c7-f2-browser.log`에 보존했다. 최종 harness는 초기화된 App에서 다른 root 문서 GET을 보류하고, 그 **같은 pending문서**를 tree에서 키보드로 다시 선택해 detail GET1회·정상 heading 표시·390mobile focus를 확인한다. 초기 mount 자체는 WorkflowPanel 테스트 증거이며 browser의 initialized-App 흐름으로 바꿔 부르지 않는다.

| 조건 | 같은 pending문서 선택 후 |
| --- | --- |
| 1440 light | [단일 조회 후 문서 표시](1440-light-same-selection.png) |
| 1440 dark | [단일 조회 후 문서 표시](1440-dark-same-selection.png) |
| 390 light | [목적지 heading 초점](390-light-same-selection.png) |
| 390 dark | [목적지 heading 초점](390-dark-same-selection.png) |

최종 fingerprint `feeb4aa18c5fa52721059d3efaa5bbfee268233d6d72299d0d51eaef31868ab6`, runtime `2026-11-17T17:23:40.983Z`, frontend `2026-11-17T17:23:42.778Z`, capture `2026-11-17T17:24:57.070Z`. 네 조건의 기존 path/race/outside-focus/oldlink/linked-copy/issued-key/source-revoke도 모두 통과했다. 현재14PNG와 historical failure1PNG, browser/cleanup JSON 및 source/tests/harness/log SHA가 manifest에 있다. cleanup `2026-11-17T17:26:13.467Z`의 자기 DB/profile/Chromium0·4397/5197닫힘·부모PG생존을 확인했다.


## Final combined wave — 현재 최종 증거

- FIX_BASE `595358f469c86d33ad1ac9326414c4b8fc0662d8`; full review의 실제 두 서버 연계 결함을 함께 수정했다. Ruling F1: structure digest만 정확한5항목 C7-only grant를 제외하고 일반/혼합/미지/잘못된/null 행은 계속 포함한다. 이유는 발급이 자체 exact placement token을 무효화했기 때문이며 비용은 서버 발급 형식과의 좁은 결합이다. actor/session/parent/현재 order·ACL/source/erasure 및 실행 key expiry/revoke 잠금 검사는 유지한다. C6/Home 기본 digest는 무수정이다.
- Ruling F2: runtime MCP WorkflowService에 HTTP와 같은 신뢰 `options.origin`을 전달한다. 이유는 absolute same-origin stable link의 dependency/current replay policy 일치이며 비용은 내부 선택 인자1개다. 요청 Host/Origin으로 신뢰를 만들지 않고 external URL은 제외한다. 기존 key/일반 delegated ceiling/UI/schema를 바꾸지 않았다.
- Clean RED3fail/7pass 후 actual-issued HTTP/MCP before-neighbor+replay, queued neighbor/ACL/key revoke·ordinary/mixed/null binding·relative/absolute/external lineage+source/link revoke·C6/Home cursor를 포함한 final native9files95, 별도 기존MCP2files2 통과. 현재11files97이며 과거13files183 carry와 합친 고유24files280은 단일 현재 실행이 아니다. 최종 check488/48/16/41/251/types/build/smoke exit0. session UUID/negative rank fixture 및 잘못된 test path 실패는 보존했다.
- fresh4configs/14PNG: 발급 전 tree token 그대로 machine before-neighbor 이동/동일키 재시도, absolute-link copy pins와 기존 same-item/race/390focus/outsidefocus/oldlink/rename/source revoke 모두 통과,errors[]. HTTP/SDK transport parity와 server race는 native 증거다. source `cf4d6daf5b633d4273adbf688a137024c08e943be7ffcc6577b1695707b0331e`, runtime `2026-11-17T17:48:01.059Z`, frontend `2026-11-17T17:48:12.311Z`, capture `2026-11-17T17:49:25.724Z`. 자기 DB/profile/Chromium0·4397/5197닫힘·부모PG생존 확인.
- 전체 리뷰 원문·정확 명령·실패/현재vs이월·판단비용은 task-7-report finalwave, SHA/cleanup는 UI evidence를 따른다. North Star/251 불변식을 유지하며 실제IdP·운영/품질·대규모성능 및 기존chunk 한계는 남는다. controller의 단1회 scoped final re-review/정확headCI/merge 대기다.
