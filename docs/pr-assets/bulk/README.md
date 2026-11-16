# 다중 문서 편집 화면 검증

2026-11-16 macOS Node24/Playwright Chromium. 실제 BulkEditor 컴포넌트와 앱 CSS를 사용하고 API 응답만 합성했다.

1440×1000, 390×1000에서 문서 두 개 선택 → 태그/이유 입력 → 서명 미리보기 모양 → 적용 성공/STALE_VERSION 부분 결과를 조작했다. 문서 폭은 뷰포트와 동일했다. 실제 인증/DB는 별도의 server/workflows/bulk.test.ts에서 검증했다.

preview-1440.png, preview-390.png 및 result-1440.png, result-390.png.
# 2026-11-16 호스트 갱신 경계 보완

일괄 적용 응답 직후 App의 목록 재조회가 패널을 unmount해 결과와 복구 토큰을 지우는 문제를 수정했다. 결과를 확인하고 재확인/실패 대상 재선택을 마친 뒤 사용자가 명시적으로 목록을 새로고침한다. 이 동작은 결과 화면을 닫으므로 명시적 새로고침 이후의 결과 보존을 약속하지 않는다.

- Node 24.22.1, Linux Chromium Headless Shell 141, 실제 BulkEditor와 앱 CSS, 합성 API/사용자 fixture.
- 1440×1000 / 390×1000: 부분 결과·같은 토큰 재확인 보존, 명시적 갱신 이후 호스트 전환, pageerror 0. 실제 회사 계정·DB·배포 인수는 아니다.
- [데스크톱 결과](host-results-1440.png), [모바일 결과](host-results-390.png), [관찰값](host-results.json).
- 저장소 루트에서 `node docs/pr-assets/bulk/verify-results.mjs <playwright/index.mjs> <headless_shell>`로 재현한다. 두 경로는 설치된 도구의 절대경로다.

