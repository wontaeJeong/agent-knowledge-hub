# C6 신규 문서 실제 브라우저 검증

2026-11-17, Node24.22.2, cached Playwright Chromium, 1440×1000 / 390×844, light/dark. 스크린샷은 전체 페이지 높이다. 실제 React/Vite → 실제 runtime HTTP → disposable PostgreSQL17을 실행했다. `composer-runtime.ts`의 명시적 `AKH_C6_SYNTHETIC_CAPTURE=1` loopback 인증 어댑터와 합성 업무 자료를 사용했으며 DTO/모델 성공을 위조하지 않았다. 운영 OIDC/회사 자료/품질 인수는 아니다.

최종 backend runtime는 **17:28:24 KST** 시작한 PID20576이며 마지막 backend 변경 뒤 재시작했다. Vite PID8995는 최종 frontend 파일을 실제 모듈 요청으로 제공했다. 최종 제품 소스는 [source-manifest.json](source-manifest.json)의 17개 변경 production 파일이다. 해당 manifest를 포함하는 커밋이 검증 소스 커밋이다. [browser-results.json](browser-results.json)의 결과는 harness의 실제 assertion을 통과한 후에만 기록했다. 초기 성공/실패 실행과 최종 결과를 구분한다.

네 조건 모두 확인:

- 전역 새 문서 버튼의 키보드 Enter 진입, Tab으로 제목→위치 이동, 키보드 미리보기.
- 실제 CAS 개인 저장·정확한 draft URL·비공개 검색/백링크 제외.
- CDP Korean composition 중 1초 autosave 없음, 확정 후 저장. OS IME 인증은 아니다.
- API 연결 중단·허용된 미전송 캐시·브라우저 프로세스를 실제 닫고 새로 열어 온라인 재검사 후 복구.
- 두 실제 탭의 충돌에서 양쪽 본문 보존. canonical GET 응답 보류 중 선택 disabled, 실제 본문 도착 후 enabled를 단언했다.
- 팀 지정 reviewer의 고정 snapshot 승인(다른 사람의 일반 draft 목록에는 없음), 같은 본문 초기 제안, 별도 canonical knowledge approve/publish 및 DB version 본문·producer 확인.
- 실제 owner-only 개인 공간의 명시적 원본 확인, 별도 knowledge approve/publish. 두 경우 model_usage_events 0.
- source 권한을 브라우저 종료 중 철회한 후 새 프로세스에서 정확한 draft 재개 거부·미전송 캐시 삭제·복구 버튼 없음.
- 수평 overflow 없음. 주 author 화면 pageerror/external request 수집 0. 전체 OS/스크린리더/실제 IdP 검증을 대체하지 않는다.

| 상태 | 1440 light | 1440 dark | 390 light | 390 dark |
| --- | --- | --- | --- | --- |
| 미리보기 | [화면](preview-1440-light.png) | [화면](preview-1440-dark.png) | [화면](preview-390-light.png) | [화면](preview-390-dark.png) |
| 오프라인 | [화면](offline-1440-light.png) | [화면](offline-1440-dark.png) | [화면](offline-390-light.png) | [화면](offline-390-dark.png) |
| 두 탭 충돌 | [화면](conflict-1440-light.png) | [화면](conflict-1440-dark.png) | [화면](conflict-390-light.png) | [화면](conflict-390-dark.png) |
| 팀 공개 대기 | [화면](disclosure-1440-light.png) | [화면](disclosure-1440-dark.png) | [화면](disclosure-390-light.png) | [화면](disclosure-390-dark.png) |
| 개인 원본 승인 | [화면](personal-1440-light.png) | [화면](personal-1440-dark.png) | [화면](personal-390-light.png) | [화면](personal-390-dark.png) |
| 철회 후 재시작 | [화면](revoked-1440-light.png) | [화면](revoked-1440-dark.png) | [화면](revoked-390-light.png) | [화면](revoked-390-dark.png) |

검증 명령(별도 터미널; 제품 소스 변경 후 runtime 재시작 필요):

```sh
export PATH=/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
export TEST_DATABASE_URL=postgres://knowledge_test:test-only-convenience@127.0.0.1:32769/knowledge_test
AKH_C6_SYNTHETIC_CAPTURE=1 node node_modules/.bin/tsx docs/ui-validation/2026-11-17-new-document/composer-runtime.ts
npm run dev -- --host 127.0.0.1 --port 5196 --strictPort
AKH_C6_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-17-new-document/capture.mjs
node docs/ui-validation/2026-11-17-new-document/manifest.mjs --verify
```

최종 `npm run check` exit0: frontend415/65파일, Node48, imports16, evaluation41, requirements251, server types/build/static HTTP smoke. Native14파일224 exit0. Vite 기존500kB chunk 경고를 유지했다. 최종 로그 원문은 작업 디렉터리 `.superpowers/sdd/2026-11-16-essential-convenience/logs/c6-final-check-revocation.log`, `c6-final-native-corrected.log`, `c6-browser-final-capture.log`에 보존한다. 최초 네이티브 RED7/기존4통과, 클라이언트 RED3/기존5통과와 후속 실패/수정은 작업 report 및 MISTAKE_LOG에 기록했다.

완료 후 commandline으로 소유권을 확인한 PID20576/8995만 SIGTERM했다. owned `akh_c6_ui_*` DB 0, `akh_c6_profile_*` 0, 4396/5196 closed를 별도 검증했다. 부모 PG17 컨테이너는 계속 유지했다. 독립 리뷰·원격8CI·PR/병합은 controller가 수행한다.
