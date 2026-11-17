# Task 5 실제 검토 화면

합성 PostgreSQL 자료와 loopback 모델/OIDC HTTP 서버, 실제 웹 빌드·Chromium으로 확인했다. MCP SDK 반려 재시도는 동일 내용을 차단하고 이후 보완 제안을 보여 준다. 원본 인용은 미검증 주장으로 표시되며 모델 호출 성공/반려/검토 승인과 독립 실행 검증을 구별한다. 실제 계정·사내 원문·운영 토큰은 포함하지 않는다.

- [1440px](lineage-1440.png): 미검증 후보 원본 위치·조건과 반려/수정 사유 입력·이전 사유.
- [390px](lineage-390.png): 같은 서버 상태, 실제 viewport 크기 및 문서 가로 넘침 없음 확인.
- 재현: `AKH_LINEAGE_SCREENSHOT_DIR`과 설치된 Playwright의 `AKH_PLAYWRIGHT_MODULE`을 지정해 `node scripts/test-server.mjs server/runtime/lineage-http.test.ts`를 실행한다. `dist`를 먼저 빌드하고 캡처 중에 재빌드하지 않는다. DB는 `TEST_DATABASE_URL`의 disposable 복제 DB에서만 실행한다.

별도 관리 모듈의 기존 로딩 표시는 Task 5의 계보/반려 기능 실행 증거가 아니며, 이 캡처를 그 모듈의 운영 수용으로 해석하지 않는다.
- [정정 영향 1440px](correction-1440.png) / [390px](correction-390.png): 실제 원본 정정 API 이후 발행 v1의 재검토 요청에 원본·정정본·이유를 표시하고 두 원본을 선택 재편입에 사용한다.

인증 검증 발견: [pool6 deadlock 요약](auth-deadlock.json)은 아직 미해결이다. 캡처 fixture는 기본 pool20이며 `AKH_LINEAGE_SCREENSHOT_POOL_MAX=6`으로 재현 환경을 선택할 수 있다. pool20 통과는 제품 인증 deadlock의 해결 증거가 아니다.
