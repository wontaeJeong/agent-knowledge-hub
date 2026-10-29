# agent admission gate UI 이식 가이드

기존 Gate 소스를 이번 환경에서 확보하지 못했다. 실제 컴포넌트를 재사용했다고 주장하지 않는다. 기존 브랜드 팩의 4개 plum 색상과 모서리·선 중심의 단정한 방향을 유지하고 교체 경계를 준비했다.

| 현재 경계 | 사내에서 확인할 대상 | 교체 조건 |
| --- | --- | --- |
| ui/primitives.tsx Button | Gate 버튼 variant·size·loading·disabled | props 어댑터로 도메인 호출 유지 |
| Badge | 상태 배지와 색 의미 | 공식·검증·대기 상태 의미를 보존 |
| Modal | Gate Dialog·FocusTrap·Portal | 열림·닫힘·Escape·초점 복귀 유지 |
| Empty | 빈 상태·오류 상태 | 실제 실패와 정상 빈 상태 구분 |
| ui/tokens.css | Gate 색·타이포·반경 토큰 | 라이트와 다크 각각 검증 |
| sidebar/topbar | AppShell·Navigation·사용자 메뉴 | 실제 권한별 메뉴와 경로 연결 |
| source-table/page-list/diff | Table·Tabs·DiffViewer | 접근성·긴 코드·모바일에서 내용 보존 |
| settings·toast·폼 | Form·Toast·Select·Confirm | 검증 오류 및 저장 실패 처리 유지 |

팔레트는 라이트 #78469e / #623680, 다크 #d4a1eb / #eac7f6다. 현재 값은 CSS에 직접 선언했다. 실제 Gate의 토큰 파서와 대비 검사 규칙을 먼저 확인하고, 임의 var 별칭이나 색상 일괄 교체를 하지 않는다. 콘텐츠에 쓰는 상태 색은 accent와 구분한다.

폰트는 Pretendard Variable과 D2Coding의 이름 및 시스템 fallback만 선언했다. 폰트 파일이나 CDN 의존성을 포함하지 않았다. 회사에서 허용한 정적 호스팅 또는 Gate의 폰트 로더를 연결한다.

초기 이식은 프리미티브 → AppShell·탐색 → Table·폼 → Diff·에디터 순으로 진행한다. 화면을 한꺼번에 새 디자인 시스템으로 바꾸지 말고 각 교체의 라이트·다크·좁은 화면·키보드·한국어 입력을 확인한다. 실제 shared 패키지 경로는 해당 레포에서 관찰한 뒤 지정한다.

도메인 타입과 state reducer는 UI에 의존하지 않으므로 컴포넌트 교체 때 변경할 필요가 없다. 현재 App.tsx는 데모 화면 조립 파일이다. Gate 이식 시 feature별 폴더로 분할할 수 있지만 행동과 테스트를 먼저 보존한다.
