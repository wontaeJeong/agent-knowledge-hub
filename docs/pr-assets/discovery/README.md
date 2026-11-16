# 지식 탐색 화면 증거

2026-11-16, macOS Node24 + Playwright Chromium headless, 실제 dist HTTP 서버. 명시적 `?preview=1#discovery` 합성 자료이며 사내 운영 자료가 아니다. 1440×1000/390×1000에서 전체 페이지 캡처, document scrollWidth가 viewport와 같음을 확인했다.

- 1440.png: 데스크톱
- 390.png: 모바일
- results.json: 확인 환경과 측정 값

별도 PostgreSQL17 격리 DB에서 discovery/인증 runtime/접근 제어 3파일37개 회귀 통과. 화면 증거와 DB 검증은 별개다.
