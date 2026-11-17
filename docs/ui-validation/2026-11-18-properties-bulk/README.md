# C10 브라우저 검증

Chromium 158.0.8127.18에서 현행 빌드와 합성 OIDC·PostgreSQL 17·실제 API·큐 작업자를 사용했다. 뷰포트는 1440×1000, 390×844이며 각 PNG는 해당 요소를 촬영했다. 문서 속성의 Tab 이동, 필수 값 경고, 검토 요청 뒤 기존 발행본 유지, 일괄 접수, 실제 부분 처리와 만료 후 새 동의·완료를 확인했다.

| 화면 | 속성 폼 | 변경 미리보기 | 부분 처리 | 만료된 작업 |
| --- | --- | --- | --- | --- |
| 1440 밝게 | [속성](1440-light-properties.png) | [미리보기](1440-light-preview.png) | [결과](1440-light-partial.png) | [만료](1440-light-expired.png) |
| 1440 어둡게 | [속성](1440-dark-properties.png) | [미리보기](1440-dark-preview.png) | [결과](1440-dark-partial.png) | [만료](1440-dark-expired.png) |
| 390 밝게 | [속성](390-light-properties.png) | [미리보기](390-light-preview.png) | [결과](390-light-partial.png) | [만료](390-light-expired.png) |
| 390 어둡게 | [속성](390-dark-properties.png) | [미리보기](390-dark-preview.png) | [결과](390-dark-partial.png) | [만료](390-dark-expired.png) |

각 구성에서 한 문서는 처리, 한 문서는 기준 변경, 한 문서는 접근 철회 상태가 됐다. 새 동의가 필요한 문서만 다시 선택했다. 실제 실행 권한 만료로 작업이 dead가 되고 pending이 남은 뒤 재선택·새 미리보기·새 영수증을 거쳐 보관이 적용됐다. 네 구성에서 가로 넘침과 pageerror는 0건이었다. 요청 수와 서버 소스 지문은 [실행 결과](browser-results.json)에 있다.

이전 main 29a892b의 실제 SPA를 별도 포트로 실행하고 현행 서버·스키마 145에 연결했다. 구버전 화면은 기존 token 요청으로 보관을 완료했다. 활성 문서의 태그 작업은 별도 검토 제안을 만들었고, 당시 클라이언트는 needs-review를 ‘실패’로 표시했다. 화면 전환 전에 접수한 작업도 현행 작업자가 완료했다. 구버전 개발용 React 콘솔에는 중복 key 경고가 관찰됐다. 해당 브라우저 실행에서 pageerror는 발생하지 않았다. [구버전 결과 화면](390-dark-legacy-client.png)

현행 SPA로 돌아가 별도 태그 작업을 접수한 뒤 실제 작업자를 실행했다. 최신 영수증에서 ‘검토 필요’와 제안 ID를 확인했고, 발행된 태그는 아직 비어 있었다. 구버전 코드는 applied·unconfirmed·skipped 이외의 상태를 ‘실패’로 표시한다. 새 자산을 미리 준비한 뒤 현행 서버와 UI를 함께 활성화하거나 원자적으로 전환한다. 구 서버에는 새 속성 읽기 경로가 없고 태그의 독립 검토 계약도 도입되기 전이다. 구 UI로만 롤백할 때는 접수된 영수증과 실제 검토 제안을 현행 화면에서 확인해야 한다. [현행 검토 결과 화면](390-dark-current-reviewed.png)

## 재현 및 한계

Node 24와 루프백 합성 TEST_DATABASE_URL을 준비하고 현행 빌드를 `vite preview --host 127.0.0.1 --port 5200 --strictPort`로 제공한다. `git archive 29a892b`로 만든 기준 스냅샷의 Vite를 5201에서 실행한다. `AKH_C10_SYNTHETIC_CAPTURE=1 node_modules/.bin/tsx docs/ui-validation/2026-11-18-properties-bulk/runtime.ts`를 시작하고, PLAYWRIGHT_MODULE과 C10_ROLLBACK_ORIGIN=http://127.0.0.1:5201, C10_ROLLBACK_COMMIT=29a892b06b1edc089ffab678835a46a936241306을 설정한 뒤 `node docs/ui-validation/2026-11-18-properties-bulk/capture.mjs`를 실행한다. 캡처는 루프백 HTTP 응답을 전달한다. 작업자 실행 시점 및 합성 자료의 권한·기준 변경을 제어한다.

해당 프로세스와 데이터베이스를 정리한 뒤 `node docs/ui-validation/2026-11-18-properties-bulk/manifest.mjs`와 `node docs/ui-validation/2026-11-18-properties-bulk/manifest.mjs --verify`를 실행한다. 최종 검증 로그는 c10-r1-current-check, c10-r1-current-native, c10-r1-browser다. 사내 IdP, 운영 배포, 한글 OS IME, 보조기기 인수 및 대규모 부하는 검증 범위 밖이다. 각 검증용 DB와 포트의 종료 결과는 [정리 기록](cleanup.json)에 있다.
