# 다중 문서 편집 화면 검증

2026-11-16 macOS Node24/Playwright Chromium. 실제 BulkEditor 컴포넌트와 앱 CSS를 사용하고 API 응답만 합성했다.

1440×1000, 390×1000에서 문서 두 개 선택 → 태그/이유 입력 → 서명 미리보기 모양 → 적용 성공/STALE_VERSION 부분 결과를 조작했다. 문서 폭은 뷰포트와 동일했다. 실제 인증/DB는 별도의 server/workflows/bulk.test.ts에서 검증했다.

preview-1440.png, preview-390.png 및 result-1440.png, result-390.png.
