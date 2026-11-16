# 개별 삭제·이력 정리 화면 증거

2026-11-17, 실제 Chromium과 빌드된 운영 App의 `편집 · 협업 → 자료 유형별 보존 정책 → 개별 자료 삭제와 이력 정리` 화면이다. localhost 실제 서버·OIDC UserInfo fixture·DB 세션·CSRF·UUID별 disposable PostgreSQL DB를 사용했다. 합성 `fixture-owner`/`reviewer`/`editor`와 합성 종료 이력만 사용했으며 실제 사용자 자료·토큰은 없다.

- [1440×1100 선택·미리보기](desktop-1440.png)
- [390×1000 선택·미리보기](mobile-390.png)

현재 서버의 개별 ID·작성자, 체크박스 선택, 삭제 가능 미리보기, 독립 검토 요청을 실제 화면에서 확인했다. 모바일 `scrollWidth=390`, viewport 390으로 가로 넘침이 없었다. 앞선 브라우저 실행에서는 별도 reviewer 승인과 Owner 실행 완료까지 확인했으나, 최종 반복의 reviewer App bootstrap은 기준 브랜치의 알려진 인증 동시성 문제로 세션이 폐기됐다. 완료 화면 캡처를 최종 증거로 사용하지 않는다. 이 문제의 수정 PR 54와 조합한 전체 App 재인수는 별도다. 화면 캡처 자체를 전체 기능/운영 수용으로 표시하지 않는다.

브라우저 합성 fixture의 pool만 24로 구성했으며 운영 설정은 변경하지 않았다. pool 6의 순차 실제 OIDC/CSRF HTTP 삭제 흐름과 DB 효과는 `server/retention/granular-http.test.ts`, 서비스/보존/복구/CAS 회귀는 `server/retention/granular.test.ts`로 별도 통과했다. 실행 후 상위 영수증 수를 갱신하는 UI 회귀는 실제 React 상태 변화로 검증했다.
