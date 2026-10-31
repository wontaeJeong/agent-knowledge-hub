# agent-knowledge-hub 브랜드 에셋

브랜드 표기는 **agent-knowledge-hub**다. 심볼은 최초 Folio Wiki에서 사용한 **육각형 안의 펼친 책**을 그대로 사용한다. 사용자가 이 기존 심볼을 선택했으며, 원본의 두 path·선 두께·비율·plum 색상과 단색·타일 변형을 보존한다. 워드마크와 배너의 제품 이름은 agent-knowledge-hub으로 유지한다. Gate와의 경험 일관성을 위해 Graphite & Plum 색상을 사용한다.

| 파일 | 용도 |
| --- | --- |
| mark-light / mark-dark | 투명 배경 심볼. 밝은 / 어두운 배경에 사용 |
| mark-mono-black / mark-mono-white | 단색 인쇄·각인 |
| mark-tile-light / mark-tile-dark | 배경이 있는 앱 타일 |
| wordmark-light / wordmark-dark | 전체 이름을 SVG path로 고정한 가로형 워드마크 |
| favicon.svg / favicon-*.png / favicon.ico | 테마 대응 SVG, 16–512px PNG, 16/32/48px ICO |
| readme-banner-light / readme-banner-dark | 1600×480 저장소·문서 배너 |
| open-graph-light / open-graph-dark | 1200×630 소셜 카드 |
| social-avatar-light / social-avatar-dark | 512×512 프로필 이미지 |
| empty-state-light / empty-state-dark | 480×320 빈 지식 공간 일러스트 |
| icons/ | 새로 그린 24개 UI 아이콘과 SVG sprite |
| brand-preview | 전체 세트 미리보기 |
| asset-manifest.json | 파일별 크기·SHA-256·브랜드 정보 |

심볼 최소 크기는 16px, 기본 앱 크기는 32px다. 주변에 폭의 15% 이상 여백을 둔다. 이름의 하이픈·소문자를 유지한다. 좁은 사이드바에서는 agent- / knowledge-hub 두 줄로 배치한다. 그림자·그라데이션·새 색을 임의로 추가하지 않는다.

아이콘은 24×24 기준, 1.8 stroke, currentColor다. 공통 원본은 src/ui/brand-icons.json이며 앱의 BrandIcon과 에셋 생성기가 함께 사용한다. 일반 유틸리티용 Lucide는 별도 라이선스를 따른다.

워드마크는 DejaVu Sans의 필요한 글자 윤곽만 사용해 폰트 설치나 CDN이 필요 없다. 출처·라이선스는 third-party-licenses/dejavu-font-license.txt에 보존한다. 보조 문구는 SVG text이며 PNG 사본을 제공한다. webmanifest는 메타데이터이며 오프라인 PWA나 서비스워커를 구현한 것은 아니다.

웹 앱의 로고는 같은 두 path를 `src/ui/brand-mark.json`에서 읽는 `BrandMark` 컴포넌트로 표시한다. 색은 `--brand-mark-primary`/`--brand-mark-secondary`가 활성 CSS `--color-accent`/`--color-accent-strong`을 따라가므로 테마 또는 팔레트 변경 시 PNG/SVG를 다시 만들 필요가 없다. 브라우저 favicon은 활성 CSS 토큰으로 갱신되며, 이 폴더의 SVG/PNG/ICO는 배포·인쇄·소셜 공유를 위한 고정 Plum 원본이다. 정적 에셋의 색상까지 바꿀 경우에만 생성기를 실행한다.

프로젝트 루트에서 npm ci 후 npm run brand로 다시 생성한다. Node.js와 프로젝트의 sharp만 사용한다. 심볼·배치·색상은 scripts/generate-brand.mjs, 워드마크 윤곽은 scripts/brand-wordmark-glyphs.json, UI 아이콘은 src/ui/brand-icons.json을 편집한다. 외부 서비스·웹폰트는 호출하지 않는다.

별도 중첩 ZIP 없이 이 폴더 전체를 에셋 팩으로 사용한다. 프로젝트 전용 심볼·아이콘·일러스트와 폰트 윤곽의 라이선스 범위를 구분해 유지한다.
