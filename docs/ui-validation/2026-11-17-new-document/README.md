# Final combined F1/F2 evidence (2026-11-17)

The current evidence is the final combined correction wave. Runtime PID62204 and Vite62218 started at 19:31:00 KST after every final backend change. Full check429/48/16/41/251/types/build/smoke exited0. Native evidence is current6files153 plus unchanged9files99 from the earlier249 run (unique252; not a single252 run). Frontend focused26 passed. Existing bundle warnings remain.

`c6-finalwave-bound-browser.log` exited0: all four1440/390 light/dark conditions, previous first-publication/recovery/ACL/rationale tests plus old approval behind newer requests, raw101 hidden prefix/partial continuation, Next/First keyboard focus, cursor409/reset, empty queue and newer outside focus preservation.52 screenshots and browser-results.json record real assertions, using canonical HTTP with synthetic loopback auth and owned PG17.

Distinct-draft regression is separate from the paging fixture: [initialization results](draft-initialization.json) cover27 and81 distinct drafts, four configurations, concurrent author exact resume/reviewer initialization (16 passed, no5xx). [distribution results](draft-distribution.json) cover81 distinct drafts with54 older approved/27pending, author exact approved resume and reviewer initialization at390/light (2 passed, no5xx). Reproduce with the two same-named .mjs files and the Node24/Playwright/AKH_C6_SYNTHETIC_CAPTURE environment below. No retries or successful DTO injection.

An earlier intermediate capture failed with an unexpected503 at390 initialization. Its underlying cause remains unconfirmed; later passing same-scale regressions do not establish the cause or prove a production load fix. Final capture's12 intentionally induced503 responses correspond to12 PostgreSQL42P01 errors while governance_type_policies was deliberately renamed; final runtime had no other PG errors. Runtime diagnostics log error code/message only, and request observations retain path/status/timing without bodies or credentials.

Current manifest binds17 production paths,5 harness files and55 artifacts. The links below refer to the current captured artifacts. Production IdP, OS IME, large-scale DB digest cost, full accessibility/load and semantic-quality acceptance remain unverified.

| Final queue states | 1440 light | 1440 dark | 390 light | 390 dark |
| --- | --- | --- | --- | --- |
| Partial | [image](review-partial-1440-light.png) | [image](review-partial-1440-dark.png) | [image](review-partial-390-light.png) | [image](review-partial-390-dark.png) |
| Next page | [image](review-queue-1440-light.png) | [image](review-queue-1440-dark.png) | [image](review-queue-390-light.png) | [image](review-queue-390-dark.png) |
| Empty | [image](review-empty-1440-light.png) | [image](review-empty-1440-dark.png) | [image](review-empty-390-light.png) | [image](review-empty-390-dark.png) |


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

리뷰 수정1차(I1–I4)는 동일 네 조건에서 추가 검증했다. 고정 승인 독자/검토자의 정확한 resume와 form 초기화, reader/reviewer 편집 후 이전 승인 버튼 없음 및 fresh request, 직접 입력한 반려 사유의 author readback을 확인했다. 실제 소유 DB의 governance_type_policies를 일시 rename하여 canonical API503과 UI 오류를 단언하고 즉시 복원했다. 오류 DTO를 위조하지 않았다. 최종 결과 파일은 모든 assertion 뒤에 기록했다.

| 리뷰 경계 | 1440 light | 1440 dark | 390 light | 390 dark |
| --- | --- | --- | --- | --- |
| 승인 후 exact resume | [화면](approved-resume-1440-light.png) | [화면](approved-resume-1440-dark.png) | [화면](approved-resume-390-light.png) | [화면](approved-resume-390-dark.png) |
| 독자 변경·이전 승인 차단 | [화면](audience-edited-1440-light.png) | [화면](audience-edited-1440-dark.png) | [화면](audience-edited-390-light.png) | [화면](audience-edited-390-dark.png) |
| 반려 사유 readback | [화면](rejection-1440-light.png) | [화면](rejection-1440-dark.png) | [화면](rejection-390-light.png) | [화면](rejection-390-dark.png) |
| 실제 의존성 오류 | [화면](disclosure-error-1440-light.png) | [화면](disclosure-error-1440-dark.png) | [화면](disclosure-error-390-light.png) | [화면](disclosure-error-390-dark.png) |

검증 명령(별도 터미널; 제품 소스 변경 후 runtime 재시작 필요):

```sh
export PATH=/Users/wt.jeong/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH
export TEST_DATABASE_URL=postgres://knowledge_test:test-only-convenience@127.0.0.1:32769/knowledge_test
AKH_C6_SYNTHETIC_CAPTURE=1 node node_modules/.bin/tsx docs/ui-validation/2026-11-17-new-document/composer-runtime.ts
npm run dev -- --host 127.0.0.1 --port 5196 --strictPort
AKH_C6_SYNTHETIC_CAPTURE=1 PLAYWRIGHT_MODULE=/Users/wt.jeong/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs node docs/ui-validation/2026-11-17-new-document/capture.mjs
node docs/ui-validation/2026-11-17-new-document/manifest.mjs --verify
```


Final cleanup is recorded separately in c6-finalwave-cleanup.log: owned DB/profile zero and ports4396/5196 closed. Controller owns scoped re-review, final-head CI and PR71 merge.
