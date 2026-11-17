# C9 문서 읽기·부분 공유 검증

실제 Node24·PostgreSQL17·Chromium 158.0.8127.18에서 정본 HTTP API를 호출한 합성 fixture다. 회사 SSO/실제 사용자/운영 인수·모델 품질 증거가 아니다. Chromium 1440×1000과 390×844, light/dark 네 조건이다.

- `*-reader.png`: 반복 한글 제목을 서로 다른 목차 위치로 이동, 문서 내 한글 4건과 Enter/Shift+Enter 이동, 코드/표/XSS 제외, 가로 넘침 없음.
- `*-copy-fallback.png`: Clipboard 거부 후 코드 원문을 선택해 복사하는 대안. 성공 안내를 표시하지 않는다.
- `*-missing-anchor.png`: 다음 발행에서 삭제된 블록의 최신 링크는 다른 문단으로 이동하지 않는다.
- `*-revoked.png`: 과거 고정 버전도 현재 원본 ACL 철회 시 본문·앵커를 지운다. 같은 시나리오에서 현재 편집·협업 읽기 화면의 focus 재검증도 확인했다.
- 최신/버전 고정 부분 URL, 중복 제목 목차, 고정 과거 위치 유지, 승인 후 실제 발행, current-title/frozen-title 구분은 browser-results와 자동 회귀를 함께 따른다.

발행 시점은 실제 합성 발행 기록이다. 검토 시점·공식 문서 여부는 이 DTO에 독립 확인 기록이 없어 `미확인`으로 표시하며 발행 여부로 대신 추론하지 않는다. 동일한 블록은 공유 불가를 명시하고 목차 이동만 허용한다. 과거 coarse 앵커는 첫 원문 위치만 매핑하며 하위 위치 ID를 만들지 않는다.

`capture.mjs`는 실제 HTTP 응답만 전달하고 UI 응답을 꾸며내지 않는다. 인증 adapter만 명시 합성 주체다. `reader-runtime.ts`는 자체 생성한 `akh_c9_test_ui_*` DB만 종료 시 삭제한다. 부모 PG를 보존했다. `cleanup.json`에 DB/profile 0·4399/5199 닫힘·부모 생존을 기록했다. OS IME·실기기·스크린리더 전체 검증은 아니다.

`source-manifest.json`은 실제 runtime/frontend 시작과 최종 source fingerprint, 회귀 파일, harness, PNG24개·JSON, 실행 로그의 SHA-256을 고정한다. `node docs/ui-validation/2026-11-18-document-reader/manifest.mjs --verify`로 재확인한다. 실행에는 `AKH_C9_SYNTHETIC_CAPTURE=1`, loopback `TEST_DATABASE_URL`, `PLAYWRIGHT_MODULE`이 필요하다.


## Round 1 — CR 줄바꿈과 복사 요청 순서

FIX_BASE `2199d7082ae79bf1e831091b17a9f629840655a6`의 독립 리뷰 I1/I2를 수정한 제품 소스로 전체 네 조건을 새로 실행했다. 현재 top-level 캡처24개(기존4상태+추가2상태 ×4조건)는 모두 이 소스다. 이전16개 증거는 FIX_BASE 커밋에 보존되어 있다.

- `*-copy-race.png`: 최신 링크 복사를 pending으로 둔 뒤 고정 링크가 실패하고, 앞선 성공 응답을 뒤늦게 완료해도 고정 링크 실패와 정확한 선택 URL이 유지된다.
- `*-newline-unavailable.png`: 실제 검토·승인·발행한 CR-only 문단을 mixed CR/LF로 이동하면 정확한 문단으로 이동하고, 변경·삭제하면 최신 링크의 위치 부재를 표시한다. 고정 v4의 원문 위치는 유지된다.
- 자동 회귀는 CR/LF/CRLF/mixed 네 종류의 발행 capture와 실제 Reader DOM을 함께 검사한다. LF/CRLF 기존 해시와 legacy coarse 기본 모드는 변경하지 않는다. 저장한 문서/버전 metadata를 다시 쓰지 않는다.
- UI Clipboard는 명시적인 거부·지연 promise fixture다. 실제 OS 클립보드/회사SSO 인수라는 주장이 아니다. 정본 HTTP/PG·승인/발행·현재 ACL·브라우저 keyboard는 실제 실행했다.
