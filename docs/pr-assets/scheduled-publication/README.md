# 예약 발행 화면 증거

실제 Chromium에서 실제 `PublicationSchedule` React 컴포넌트와 공통 스타일을 렌더링했다. 화면에는 합성 변경 집합과 **화면 전용 합성 API**를 사용했다고 명시한다. 전체 운영 앱/실제 인증을 통한 브라우저 E2E 증거로 표시하지 않는다. 실제 OIDC HTTP·CSRF·PostgreSQL 예약 실행/철회는 `server/jobs/scheduled-publication-http.test.ts`에서 별도로 검증한다.

- 환경: Chromium headless, Asia/Seoul, viewport 1440×1100 / 390×1100.
- 확인: 시각 입력 → UTC/현지 미리보기 → 별도 동의 → 예약 상태 → 취소. 가로 넘침/페이지 JavaScript 오류 없음. 결과는 `results.json`.
- 캡처: `preview-1440.png`, `preview-390.png`, `scheduled-1440.png`, `scheduled-390.png`.
- 재현: Node24에서 `AKH_PLAYWRIGHT_MODULE=/설치된/playwright/index.mjs node docs/pr-assets/scheduled-publication/verify.mjs`.
- UI 검사는 서버 ACL·실제 운영 SLA·접근성 전체 인수 검증을 대신하지 않는다.
