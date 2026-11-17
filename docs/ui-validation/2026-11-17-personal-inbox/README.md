# 개인 알림함 UI 검증 — 2026-11-17

C2 / UXC-01. 실제 Vite 화면(포트 5192), 실제 `createRuntimeHandler`(포트 4392), PostgreSQL 17.11의 별도 합성 fixture DB를 사용했다. 테스트 identity adapter만 합성이며 알림 API 응답은 모의하지 않았다. 실제 WorkflowService 댓글/멘션과 KnowledgeService 검토 제안, 기존 CollaborationService worker가 알림을 만들었다. 회사 자료 및 실제 IdP는 사용하지 않았다.

- Node 24.22.2, Chromium 158.0.8127.18, Playwright. 데스크톱 1440×1000, 모바일 390×844, light/dark.
- `inbox-{1440,390}-{light,dark}.png`: 전체 화면. `inbox-list-390-{light,dark}.png`: 모바일 목록을 스크롤한 화면.
- `bell-{1440,390}-{light,dark}.png`: 실제 알림 미리보기 5건. 키보드 Enter 열기, Escape 닫기와 트리거 초점 복귀, 재초점 갱신 시 현재 링크 초점/팝오버 스크롤 유지 확인.
- [실행 결과](browser-results.json): 네 조합 모두 가로 넘침 없음, pageerror 없음, 정확한 C1 검토 target URL. 30초 주기·숨긴 탭 정지·늦은 응답 차단은 UI 회귀에서도 검증했다.
- 캡처는 실제 로컬 실행 증거이며 운영 SSO, 메일 전달, 프로덕션 부하 또는 지식 품질 개선의 수용 증거가 아니다. 최종 서버 자체 검토의 due-work 상태/withdrawal 수정은 이 캡처에 없는 데이터 경계이며 화면 코드는 이후 변경하지 않았다.
