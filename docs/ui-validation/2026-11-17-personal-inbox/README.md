# 개인 알림함 UI 검증 — 2026-11-17

C2 / UXC-01. 실제 Vite 화면(포트 5192), 실제 `createRuntimeHandler`(포트 4392), PostgreSQL 17.11의 별도 합성 fixture DB를 사용했다. 테스트 identity adapter만 합성이며 알림 API 응답은 모의하지 않았다. 실제 WorkflowService 댓글/멘션과 KnowledgeService 검토 제안, 기존 CollaborationService worker가 알림을 만들었다. 회사 자료 및 실제 IdP는 사용하지 않았다.

- Node 24.22.2, Chromium 158.0.8127.18, Playwright. 데스크톱 1440×1000, 모바일 390×844, light/dark.
- `inbox-{1440,390}-{light,dark}.png`: 전체 화면. `inbox-list-390-{light,dark}.png`: 모바일 목록을 스크롤한 화면.
- `bell-{1440,390}-{light,dark}.png`: 실제 알림 미리보기 5건. 키보드 Enter 열기, Escape 닫기와 트리거 초점 복귀, 재초점 갱신 시 현재 링크 초점/팝오버 스크롤 유지 확인.
- [실행 결과](browser-results.json): 네 조합 모두 가로 넘침 없음, pageerror 없음, 정확한 C1 검토 target URL. 30초 주기·숨긴 탭 정지·늦은 응답 차단은 UI 회귀에서도 검증했다.
- 캡처는 실제 로컬 실행 증거이며 운영 SSO, 메일 전달, 프로덕션 부하 또는 지식 품질 개선의 수용 증거가 아니다. 최종 서버 자체 검토의 due-work 상태/withdrawal 수정은 이 캡처에 없는 데이터 경계이며 화면 코드는 이후 변경하지 않았다.


## 로컬 재현

저장소 루트에서 Node24와 `npm ci`를 사용한다. [inbox-runtime.ts](inbox-runtime.ts)는 **증거용 합성 identity**를 연결하며 제품 런타임에서 import하지 않는다. 운영 DB/자격 증명을 사용하지 않는다. CREATE DATABASE 권한이 있는 전용 폐기 가능 PostgreSQL 테스트 서버의 `TEST_DATABASE_URL`을 제공한다. 스크립트는 `akh_c2_ui_<timestamp>` DB만 생성하고 종료 시 그 DB만 삭제하며 기존 데이터베이스에는 fixture를 넣지 않는다.

터미널1:

```sh
export TEST_DATABASE_URL='postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DATABASE'
AKH_C2_SYNTHETIC_CAPTURE=1 npx tsx docs/ui-validation/2026-11-17-personal-inbox/inbox-runtime.ts
```

터미널2:

```sh
npm run dev -- --host 127.0.0.1 --port 5192 --strictPort
```

포트4392와5192를 다른 작업에서 사용 중이면 먼저 그 작업과 조율한다. fixture 정보는 `/tmp/akh-c2-browser.json`에 기록하며 양쪽 실행에 같은 `AKH_C2_CAPTURE_FIXTURE` 경로를 지정할 수도 있다. 스크립트는127.0.0.1에만 서버를 연다.

터미널3에는 Playwright 모듈과 Chromium이 필요하다. 캡처에 사용한 버전은 `1.66.0-alpha-2026-11-09`이며 repository dependency를 추가하지 않았다. 별도 임시 디렉터리에 준비하는 예:

```sh
npm install --prefix /tmp/akh-c2-capture-tools playwright@1.66.0-alpha-2026-11-09
/tmp/akh-c2-capture-tools/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/akh-c2-capture-tools/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-17-personal-inbox/capture.mjs
```

`capture.mjs`는 이 폴더의10PNG와 browser-results.json을 갱신한다. 원래 결과 보존이 필요하면 별도 복사본에서 실행한다. 완료 후 fixture 프로세스에 한 번 SIGTERM 또는 Ctrl-C를 보내 DB 정리를 마친 뒤 Vite도 종료한다. 포트 충돌/강제 종료로 정리되지 않은 경우 출력 fixture JSON의 정확한 자기 DB 이름을 확인한 후 그것만 정리한다. 실제 IdP·운영 인증 경로가 아니며 이 스크립트를 배포에 연결하지 않는다.
