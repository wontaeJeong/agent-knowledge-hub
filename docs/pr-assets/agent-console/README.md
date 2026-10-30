# 운영 콘솔 · 합성 UI 목업 검증

2026-10-30, Chromium153 / 최종 `dist/` 정적 HTTP 서버. 실제 앱 진입은 **HTTP 계약 fixture**로 검사했고 목업은 서버 미호출을 확인했다. 실제 사내 IdP/DB/모델·부하·운영 인수 결과가 아니다.

## 목업 화면

- [데스크톱 개요](desktop-overview.png) / [다크](desktop-dark-overview.png) / [모바일 개요](mobile-overview.png)
- 사용자: [데스크톱](desktop-users.png) / [모바일](mobile-users.png)
- 에이전트: [데스크톱](desktop-agents.png) / [모바일](mobile-agents.png)
- 공간: [데스크톱](desktop-access.png) / [모바일](mobile-access.png)
- 251개 기능: [데스크톱](desktop-coverage.png) / [모바일](mobile-coverage.png) / [모바일 다크](mobile-dark-coverage.png)

## 실제 검증

`verify-ui.js`: 18화면 × 390/1440px = 36개 레이아웃, 62개 assertion 통과. 가로 문서 넘침0, pageerror0, `/api/` 요청0. 초대 대기·마지막 Owner 거부·토큰 메타데이터·탭 간 메모리 유지/새로고침 초기화, Tab/Escape/초점 복귀, 모바일 탐색 Enter/본문 초점, 뒤로/앞으로, skip 링크 경로 유지, 251개 중 25개씩/전체 검색, 표 키보드 가로 스크롤, 테마, 붙여넣기 원문과 완료 주장 구분, 원본 등록→검토/발행→고정 인용→답변 재편입→Lint를 확인했다. [전체 원시 결과](layout-results.json).

개요의 첫 판단 위치: 데스크톱232px / 모바일369px. 높이1810px / 3109px. 개요 그래프 글자14px이며 SVG viewBox 축소를 사용하지 않는다. 사용자 표 최소760px, 모바일 문서는390px로 유지한다. 기능 점검표는 약741px의 내부 가로 스크롤과25건 페이지를 제공한다.

`verify-auth.js`: 늦은 usage401 뒤 보호 화면 제거, 목록500에서 0건 카드 비표시, 재연결 버튼을 검사했다. 수정 전 false/false/true → 수정 후 true/true/true. 목업 초대 취소→중지→활성화 우회도 단위 시험 RED→GREEN으로 차단했다. 브라우저에서 발견한 dialog 초점 복귀/순환도 실패를 재현한 뒤 수정했다.

`verify-live-routes.js`: 최신 실제 AccessManager·ImportWorkbench 컴포넌트와 `/access`·`/imports/config` 계약 요청, 0건 집계의 실패율 해당 없음, 읽기 전용 호출을 확인했다. 7개 검사 통과. [HTTP fixture 호출/결과](live-route-results.json).

## 같은 7일 fixture로 비교

기준은 최신 `origin/main@31b7d9a`를 작업 전용 scratch에 `git archive`로 읽어 빌드했다. 양쪽 **실제 앱 경로**에 동일 fixture(244호출/234성공/10실패/3발행)를 제공했다. 예시 배너 유무 차이에 의한 비교가 아니다. 성능이나 지식 효과의 개선 측정이 아니라 화면 레이아웃 비교다.

| 너비 | 항목 | 변경 전 | 변경 후 |
| --- | --- | ---: | ---: |
| 390px | 사용량 첫 결론 y | 779px | 522px |
| 390px | 문서 높이 | 2738px | 2616px |
| 390px | 표 너비 / 행 높이 | 600px / 53.75px | 600px / 53.75px |
| 390px | 실제 그래프 글자 | 14px | 14px |
| 1440px | 사용량 첫 결론 y | 581px | 380px |
| 1440px | 문서 높이 | 2280px | 2145px |

새 모바일 탐색은122px의 브랜드/닫힌 메뉴, 데스크톱은252px 너비의 별도 스크롤 사이드바다. 기존 모바일 가로 탭은141px 높이로 본문 흐름을 점유했다. [원시 비교](comparison-results.json), [390px 전](before-usage-390.png) / [후](after-usage-390.png), [1440px 전](before-usage-1440.png) / [후](after-usage-1440.png).

## 재현

`npm run build` 후 정적 HTTP로 실행한다. Playwright의 `browser_run_code_unsafe`로 해당 서버에 이동한 다음 이 폴더의 `verify-ui.js`, `verify-auth.js`, `verify-live-routes.js`를 filename으로 실행할 수 있다. `verify-comparison.js`는 기준 빌드4178/변경 빌드4176 두 서버를 요구한다. 결과는 마지막 페이지의 `window.__consoleVerification`, `window.__liveRouteVerification`, `window.__comparisonVerification`에 담기며 검증용 객체일 뿐 앱의 저장 동작은 아니다.

브라우저 검증은 이번 로컬 실행 근거이며 npm/CI에서 자동 수행된 것으로 표시하지 않는다. `npm run check`는 별도로 클라이언트61개+Node48개+파서/정리15개, 251개 요구사항 연결, 서버 타입 검사, 빌드/HTTP smoke를 통과했다. 실제 PostgreSQL 회귀와 플랫폼 매트릭스 결과는 PR의 필수 CI를 따른다.
