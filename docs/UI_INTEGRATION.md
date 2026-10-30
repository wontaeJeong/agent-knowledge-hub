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

## 테마에 대응하는 브랜드 에셋 (2026-10-30)

- 확정된 Folio Wiki 육각형·펼친 책의 원본 path와 8/6 stroke는 `src/ui/brand-mark.json` 하나에 둔다. `src/ui/BrandMark.tsx`는 이 형상을 웹 페이지(소개·데모·운영)에서 inline SVG로 표시하고 `scripts/generate-brand.mjs`는 같은 경로를 써서 정적 브랜드 팩을 만든다.
- 두 색상은 `--brand-mark-primary: var(--color-accent)`, `--brand-mark-secondary: var(--color-accent-strong)`에 연결되어 라이트/다크와 같은 요소의 palette override를 따라간다. `BrandIcon` 및 Lucide 아이콘은 기존 `currentColor`를 유지한다.
- 외부 `<img src="...svg">`는 페이지 CSS 변수를 상속하지 못한다. 앱 로고만 inline으로 변경했고, 파비콘은 활성 루트 토큰을 사용해 data SVG를 갱신한다. `/brand/favicon.svg`과 ICO는 JS 미사용 환경의 폴백이며, 서버 CSP는 `img-src data:`를 허용한다.
- 새로운 팔레트는 `[data-palette="ocean"]` 또는 `[data-theme="dark"][data-palette="ocean"]` 같은 선택자에서 `--color-accent`, `--color-accent-strong` 및 필요한 대비 토큰을 재정의하면 된다. 최상위 `document.documentElement.dataset.palette`를 변경하면 로고와 파비콘이 함께 반영된다. 새 팔레트 선택 UI는 아직 제공하지 않는다.
- `brand-kit` 배너, OG/소셜 이미지, PNG/ICO와 설치 아이콘은 고정 브랜드 산출물이다. 브라우저 런타임 팔레트 변경으로 이 파일들까지 재생성하지 않으며, 인쇄·공유용 변형이 필요할 때에만 `npm run brand`를 실행한다. 색상 변경이 상태(성공·경고·위험) 색상을 덮어쓰거나 명암 대비를 떨어뜨리지 않는지 검증한다.
