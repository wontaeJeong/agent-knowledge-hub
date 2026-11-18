# C11 개인 저장 보기 검증

PostgreSQL 17.11, Node 24, Chromium 158.0.8127.18에서 합성 사용자와 자료를 사용했다. 화면은 `npm run build`로 만든 앱을 루프백 HTTP로 제공했다. 합성 userinfo 공급자를 실제 OIDC 세션 검사기에 연결했다. 각 사용자에게 별도의 세션 쿠키를 발급하고 브라우저의 실제 API 요청을 처리했다.

| 화면 | 밝은 테마 | 어두운 테마 |
| --- | --- | --- |
| 1440×1000 목록 | [목록](1440-light-list.png) | [목록](1440-dark-list.png) |
| 1440×1000 실행 | [실행](1440-light-view.png) | [실행](1440-dark-view.png) |
| 390×844 목록 | [목록](390-light-list.png) | [목록](390-dark-list.png) |
| 390×844 실행 | [실행](390-light-view.png) | [실행](390-dark-view.png) |

네 조건 모두 키보드로 개인 보기 저장·열기·순서 이동, 검색 결과 확인, 다른 세션 변경으로 발생한 409 안내·새로고침·수정, 삭제 확인을 실행했다. 같은 계정의 새 런타임 세션에서 정의를 다시 열고 원본 권한 회수 후 0건을 확인했다. 다른 계정과 다른 공간에서 같은 ID를 열었을 때 정의가 표시되지 않았다. URL, localStorage, sessionStorage에서 보기 이름과 검색어가 검출되지 않았다. 실행마다 임의 포트 및 고유 DB를 할당하며 종료 시 해당 서버, 브라우저, DB를 정리한다.

배포 소스 지문은 `11159a5aadb52d1bf24088a0adbf152e13bfcda532c4c63cc9101ea25c1c45b9`이다. 각 화면의 SHA-256 해시와 브라우저 흐름 결과는 [browser-results.json](browser-results.json)에 있다. 저장소 루트에서 `node docs/ui-validation/2026-11-18-saved-views/verify.mjs`로 검증한다.

재현하려면 먼저 `npm run build`를 실행한다. `TEST_DATABASE_URL`에는 CREATE DATABASE가 가능한 루프백 테스트 인스턴스를 지정한다. `PLAYWRIGHT_MODULE`은 Chromium이 설치된 Playwright 모듈 경로이며, `AKH_C11_SYNTHETIC=1`로 `node_modules/.bin/tsx docs/ui-validation/2026-11-18-saved-views/capture.ts`를 실행한다.

- 전체 `npm run check`에서 프런트엔드 554, Node 48, 수집 16, 평가 41, 요구사항 251개 및 타입 검사, 빌드, 정적 HTTP smoke가 통과했다. [실행 로그](checks.txt)
- PostgreSQL 회귀 12개 파일, 131개 시험이 파일별 독립 DB에서 통과했다. C11 시험 6개를 포함한다. 146 마이그레이션 롤백·재시작·드리프트와 계정별 100개 경계, CAS 충돌, 재시도, 계보·법정 보류·복구를 확인했다. [실행 로그](postgres.txt)
- 실제 사내 IdP·배포·백업 물리 삭제 시점·운영체제별 보조기기와 IME·검색 품질 및 에이전트 업무 효과는 별도 검증 대상이다.
