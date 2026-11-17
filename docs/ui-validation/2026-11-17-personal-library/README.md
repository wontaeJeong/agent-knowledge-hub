# C3 개인 문서 목록 화면 검증

2026-11-17, C1/C2 병합 main `d4c52824df823c57681c128c930287c68574c69e` 이후 격리 worktree931e에서 실제 Chromium `158.0.8127.18`로 확인했다. Vite5193과 실제 native runtime4393을 사용했다. 최종 제품 소스로 runtime을 재시작하고 새 전용 PostgreSQL DB를 만든 뒤 최종24PNG를 수집했다. [소스 fingerprint](product-source.json)는 해당 제품16파일을 경로 순으로 SHA256 계산한 `ffc48255b9ad6778dc309ab186f7130b041fea4f84e20783471309a7d20190f1`이다. 이후 변경은 시험 단언과 문서뿐이다.

28개 합성 문서, 본인 즐겨찾기28개·구독3개·실제 GET 방문4개로 시작한다. synthetic reviewer/editor는 evidence-only 인증 어댑터이며 실제 회사 OIDC·토큰·자료를 사용하지 않는다. 실제 API를 intercept된 mock DTO로 대체하지 않는다. Playwright는 요청을 loopback 실제 API로 전달하며 합성 cookie와 Origin만 부착한다. 원본 reader 철회는 같은 전용 DB에서 수행한다. harness는 명시적 opt-in 없이는 DB 생성 전에 종료한다.

| 화면 | 파일 이름 (`1440|390`, `light|dark` 각 조합) | 확인 |
| --- | --- | --- |
| 즐겨찾기 | `favorites-<width>-<theme>.png` | 현재 허용25개, 위/아래 버튼, Enter 이동, 첫 위치 이동 후 활성 방향 버튼으로 초점 복구 |
| 다음 페이지 | `favorites-next-<width>-<theme>.png` | 서명 cursor로 나머지3개, 첫 페이지 복귀 |
| 구독 | `subscriptions-<width>-<theme>.png` | 실제 사이드바 이동, 모바일 메뉴 닫힘, 현재 구독3개 |
| 최근 | `recent-<width>-<theme>.png` | 목록 렌더링 전후 최근 row 개수 불변 |
| 문서 상태 | `document-state-<width>-<theme>.png` | 실제 문서 열기 후 서버 현재 즐겨찾기 해제/추가 readback |
| 권한 철회 | `revoked-<width>-<theme>.png` | 실제 원본 reader 철회 뒤 현재 목록에서 합성 제목 제거, local/sessionStorage 미보관 |

[브라우저 assertion 결과](browser-results.json)는 네 조건 모두 `errors:[]`, overflow false, pagination25→3, 키보드/끝 초점·모바일 이동·토글·non-visit·현재 ACL·미보관 true다. 대표 desktop/light와 mobile/dark PNG를 실제로 열어 가독성·제어·초점을 확인했다. 이 캡처는 현재 viewport이며 25행 전체를 한 이미지에 축소하지 않았다. 로딩/오류와 account/space/API 교체 및 pending mutation 경합은 별도 UI/native 회귀로 검증했다.

재현(지원 Node24, 별도의 disposable `TEST_DATABASE_URL`을 설정):

```sh
AKH_C3_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-17-personal-library/library-runtime.ts
npm run dev -- --host 127.0.0.1 --port 5193 --strictPort
AKH_C3_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node docs/ui-validation/2026-11-17-personal-library/capture.mjs
```

런타임은 이름이 `akh_c3_ui_<timestamp>`인 자신의 DB만 만들고 SIGINT/SIGTERM 때 삭제한다. 다른 컨테이너·공유 DB·실제 IdP에 접속하지 않는다. final capture 뒤 owned runtime/DB와 Vite를 정리했다. raw logs는 local `.superpowers/sdd/2026-11-16-essential-convenience/logs/c3-*`, full report는 같은 디렉터리의 `task-3-report.md`에 있다.

최종 `npm run check` exit0: frontend340/Node48/import16/evaluation41/251요구사항/서버types/build/smoke. native21파일 첫 실행은20파일234시험 성공·기존 exact DTO 기대1실패였으며, exact `{items:[],nextCursor:null,revision:1}` 단언을 유지·보강한 뒤 관련3파일10시험을 다시 통과했다(고유21파일235시험 확인). 첫 exit1을 전체 성공으로 바꾸지 않는다. 프로세스 범위 cursor 키, 후보10,000개 한도, 대규모 부하/다중 인스턴스/실제 사내 인증·운영 인수는 남은 제약이다. 기존 Vite >500kB chunk 경고도 남아 있다. 독립 리뷰·원격 CI·PR·main 병합은 별도 대기다.

증거 정정: 첫 feature commit `28b2fcb`의 `document-state` 4PNG 중 dark2장은 문서 `goto` 뒤 앱이 기본 테마로 돌아가 light와 같은 바이트였다. 나머지 목록/철회 화면은 로드 뒤 명시적으로 테마를 적용했으므로 이 누락의 대상이 아니었다. 문서 제어가 로드되고 실제 toggle이 완료된 뒤 테마를 다시 적용하고 `document.documentElement.dataset.theme`를 확인하도록 capture를 보강했다. 새 전용 DB/runtime의 `c3-browser-final3.log` exit0으로 네 조건24PNG를 다시 수집했으며 browser-results의 `documentThemeVerified`가 요청 테마와 모두 같다. 1440/390 각각 dark/light 문서 PNG의 SHA256이 다름을 확인하고 mobile/dark 실제 이미지를 열어 검증했다. 제품 fingerprint는 변하지 않아 npmcheck/native는 반복하지 않았다.
