# C1 사용자 메뉴·호환 경로 화면 증거

2026-11-17, Node 24.22.2 / macOS arm64 / Playwright Chromium 158 headless / Vite 5191. 별도 브라우저 프로세스·컨텍스트에서 1440×900, 390×900과 light/dark를 실제 렌더링했다. 모든 계정·공간·작업·API 응답은 합성 fixture이며 실제 SSO·DB·사내 인수 결과가 아니다. 목업을 운영 완료로 표시하지 않는다.

| 너비 | 메뉴 light / dark | 정확한 작업 light / dark |
| --- | --- | --- |
| 1440 | [light](1440-light-navigation.png) / [dark](1440-dark-navigation.png) | [light](1440-light-job.png) / [dark](1440-dark-job.png) |
| 390 | [light](390-light-navigation.png) / [dark](390-dark-navigation.png) | [light](390-light-job.png) / [dark](390-dark-job.png) |

1차 검토 후 기존 공지/VOC·정련 메뉴 복원을 확인한 추가 캡처: [1440 light](1440-light-tools.png) / [1440 dark](1440-dark-tools.png) / [390 light](390-light-tools.png) / [390 dark](390-dark-tools.png). 최종 검토 후 개인 도구·검토 평가 진입의 capability별 캡처도 추가했다: [Reader](1440-light-reader-personal-tools.png) / [Writer](1440-light-writer-personal-tools.png) / [Maintain](1440-light-maintainer-personal-tools.png). 현재 증거는 총 15장이다.

메뉴 캡처는 viewport, 작업 캡처는 같은 viewport의 전체 페이지다. 모바일 메뉴를 키보드 Enter로 열고 최근 방문 링크를 Enter로 선택했다. 이동 후 메뉴 닫힘과 본문 초점 복귀, 닫힌 메뉴에서도 검색·새 문서·알림 접근, viewport 가로 넘침 없음, 실제 작업 ID 선택을 확인했다. Reader/Writer/Maintainer capability 조합에서 항목 표시와 reviewer 문자열에 의한 Admin 승격 방지를 확인했다. 브라우저 pageerror는 0건이다.

즐겨찾기 등 새 섹션은 C1에서 아직 연결되지 않았다는 상태만 보여 준다. 개인 목록·빠른 검색·새 문서 저장·내 작업 집계는 해당 후속 작업 범위다. 버전/문단 URL도 검증·보존하며 실제 해당 위치 열기는 후속 읽기 도구 범위다.

재현: 별도 포트에서 `npm run dev -- --port 5191 --strictPort` 후 `C1_PLAYWRIGHT_MODULE=<설치된 playwright/index.mjs 절대 경로> node docs/pr-assets/convenience-navigation/capture.mjs`를 실행한다. `C1_BASE_URL`로 주소를 바꿀 수 있다. 검증 기록은 [check](check.txt), [browser](browser.json), 합성 fixture와 동작 검사는 [capture.mjs](capture.mjs)에 있다. 캡처는 전체 접근성·서버 ACL·실제 OIDC 인수를 대신하지 않는다.
