# 랜딩페이지 브라우저 확인

2026-10-30, production `dist`를 기존 정적 실행기로 제공하고 Chromium 153.0.8010.0 / Playwright로 확인했다. 합성 설명만 사용했으며 화면 결과는 [results.json](results.json)에 고정했다.

| 화면 | 캡처 |
| --- | --- |
| 1440 × 1000 다크 첫 화면 | [desktop-dark.webp](desktop-dark.webp) |
| 1440 × 1000 라이트 첫 화면 | [desktop-light.webp](desktop-light.webp) |
| 비교표와 선택형 예시 | [comparison-dark.webp](comparison-dark.webp) |
| 390 × 844 다크 전체 페이지 | [mobile-dark.webp](mobile-dark.webp) |

확인한 행동:

- 기본 `/`에서 로그인/API와 두 앱 청크를 요청하지 않고 소개를 표시한다.
- 320/390/768/1440px에서 document 너비가 viewport와 같다. 320/390px의 비교표는 내부 660px 영역을 스크롤한다.
- Memory/RAG/Wiki 선택이 해당 예시와 `aria-pressed`를 바꾸고 Enter 키로도 동작한다.
- FAQ 펼치기, 테마 전환과 새로고침 후 유지, 저장소 차단 상태의 렌더링·테마 조작이 동작한다.
- “지식 공간 시작하기”는 `/?app=1`로 이동하며 **합성 401 응답**에서 기존 로그인 안내와 `/auth/login` 링크를 표시한다.
- 데모 버튼과 `/?demo=1#/roadmap`에서 기존 앱과 로드맵 화면이 표시된다.
- 위 흐름에서 `pageerror`가 없다.

이 브라우저 확인에는 실제 IdP·PostgreSQL·모델을 연결하지 않았다. 실제 OIDC 콜백의 redirect는 기존 `server/runtime/auth.test.ts` DB 회귀에 추가했으며 CI의 PostgreSQL job이 실행한다. 전체 키보드/스크린리더 감사, 실제 기기·사내 브라우저 인수, SEO 검증은 아니다.

QA 환경에는 제품의 설치 폰트 경로를 재현하기 위해 격리된 fontconfig에 Pretendard를 설치했다. 제품 코드에는 폰트 파일/CDN/외부 네트워크 의존성을 추가하지 않았다. 캡처는 현재 코드의 합성 설명이며 실제 지식 처리·효과 측정 결과가 아니다.
