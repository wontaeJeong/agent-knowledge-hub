# 문서 표시와 첨부 화면 검증

브랜치: `feat/roadmap-presentation-20261116`, 기준 `24550c5`. EDT-001/008/009.

- 실제 Chromium, Node24.22.2, PostgreSQL17 파일별/작업별 disposable DB, 실제 `createRuntimeHandler`와 React 앱. 로컬 OIDC UserInfo 공급자와 합성 세션·문서만 사용했다. 실제 회사 SSO/자료 인수가 아니다.
- `document-1440.png`, `document-390.png`: Markdown 표·코드·수식(MathML)·Mermaid flowchart·인증된 이미지 표시. 원본 Markdown은 그대로 보존한다.
- `attachments-1440.png`, `attachments-390.png`: 실제 파일 업로드→미리보기→PNG에서 WebP 새 불변 버전 교체, 이전 원본 보존.
- `pending-1440.png`, `pending-390.png`: 실제 요청을 네트워크 구간에서 지연한 상태의 닫기 버튼. 닫은 뒤 실제 서버 응답이 도착해도 이미지가 다시 표시되지 않았다.
- 원본 ACL을 DB에서 철회한 다음 실제 이미지 요청이 차단되고 이전 문서 미리보기가 제거됐다. 외부 요청0, 브라우저 오류0. 세부 결과는 `results.json`.
- 자동 회귀: `src/ui/Markdown.test.tsx`, `src/operational/storage.interaction.test.tsx`, `server/storage/lifecycle.test.ts`, `routes.test.ts`, `share-read.test.ts`, `presentation-http.test.ts`. 후자는 실제 OIDC 세션·CSRF·현재 원본 ACL을 사용한다.
- 상세 지원 형식·보안·미지원 경계: [DOCUMENT_PRESENTATION](../../DOCUMENT_PRESENTATION.md). PDF 추출/변환/미리보기·SVG/GIF와 전체 Mermaid 문법 지원은 주장하지 않는다.

최종 로컬 검증:

- Node24 `npm run check` 통과: 프런트48파일189건, Node48건, import16건, evaluation41건, 요구사항251개, 서버 타입검사·빌드·정적 HTTP smoke. 빌드는 Mermaid 선택적 청크의500kB 경고를 표시하며 실패는 아니다. 추가 서버/Pod를 사용하지 않는다.
- `TEST_DATABASE_URL=<disposable base> node scripts/test-server.mjs server/storage server/operations/erasure.test.ts`: 파일별 새 DB13개,89시험 통과. 기존 수집기·snapshot·가져오기·용량/변경 게이트·고정 공유·철회와 새 이미지 HTTP/버전/Markdown 왕복을 포함한다. 파일 I/O와 디코딩 뒤 권한을 재검사한다.
- 물리 참조 그래프·erasure DB·released imports·retention 추가4파일65시험 통과. Node24 `npm ci`로 최종 lockfile 설치 재현.
- `npm audit --omit=dev`는 기존 간접 `hono`·`@hono/node-server`의 moderate2건을 보고했다. 신규 수식·다이어그램 의존성의 권고가 아니며 이번 변경에서 해결했다고 주장하지 않는다.

독립 리뷰의 Important2건(APNG와 응답 경합)은 codec/네이티브 HTTP 및 실제 React deferred 회귀로 RED→GREEN을 확인했다. 유효한2프레임 APNG는415와 메타데이터 생성0, 손상 PNG/정상 PNG·JPEG·WebP/불활성 청크를 구분한다. 최신 권한 거부·역순 A/B·대기 중 닫기·컨텍스트/언마운트를 검사한다. 최종 `npm run check`와 storage/erasure13파일89건, 집중4파일29건 및 실제 Chromium1440/390을 재실행했다. 기존 물리 삭제4파일65건은 첫 구현에서 실행한 증거이며 이번 수정에서 재실행한 결과로 표시하지 않는다. 원격 CI와 최종 리뷰/통합은 별도다.

## Navigation integration capture

- navigation-1440.png and navigation-390.png show actual Chromium with the real DocumentBody + shared Markdown components, explicitly synthetic component text and attachment reader. Native API authorization remains separately verified by presentation-http/navigation-http/bulk tests.
- Confirmed outline4, table find1, local MathML/Mermaid, preview image and blocked external image. External requests0, pageerrors0, documentoverflowfalse at both widths. navigation-results.json records results. This does not replace the earlier actual OIDC/runtime/DB browser flow.
