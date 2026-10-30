# 브라우저 검증 증거

2026-10-30, Chromium 153 + Playwright 1.62.1, 실제 빌드된 운영 UI/REST/서버 worker와 loopback OIDC UserInfo를 사용했다. 합성 5개 대화와 결정적 `ModelCall` 계약 fixture이며 실제 외부 LLM 품질·사내 SSO·운영 인수 증거가 아니다. DB는 로컬 보조 검증용 PGlite이고 네이티브 PostgreSQL 검증은 PR의 GitHub Actions를 따른다.

`results.json`에 실행한 단계와 화면 치수/가로 스크롤 폭, JS 오류 여부를 기록한다. 데스크톱 1440px/모바일 390px에서 문서 가로 폭이 viewport를 넘지 않았다.

- [desktop-result.png](desktop-result.png): 개인 정리 후보, 제안/결정 진술 구별, 원문 근거.
- [mobile-result.png](mobile-result.png): 같은 후보의 모바일 레이아웃.
- [review-published.png](review-published.png): 별도 원본 공개 승인 후 지식 승인/원자 발행.
- [access-members.png](access-members.png): 명시적 기존 공간 이관 후 Organization Owner·직접/Team 경로의 실효 역할. 기존 reader의 직접 Read와 Team Write를 합쳐 Write를 계산한다.

검증 순서: 편집자 로그인 → 웹 붙여넣기 → 서버 분석 → 안내 확인/정리 → 대상 독자/검토자 공개 요청 → 별도 검토자 세션의 원본 공개 승인 → 지식 승인/발행 → 독자 열람 → 명시적 초기 Owner 이관 → Team 생성/멤버 추가/공간 역할 부여. 서버 보안 회귀는 `server/access.test.ts`, `server/imports/{service,http}.test.ts`로 반복 실행할 수 있다.
