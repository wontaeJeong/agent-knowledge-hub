# 현재 구현과 남은 연결

기준일: 2026-11-14. 확인한 소스: `9883fbeb609c99fc4b0247168d496ac65fa0b8e4`. **소스 정적 대조이며 새 운영 인수 결과가 아니다.** 이 문서는 현재 구현을 읽는 진입점이다. 기능 변경 시 해당 행의 소스·연결·남은 조건과 확인 커밋을 함께 갱신한다. 날짜가 있는 과거 인계·시험 기록은 당시 증거로 보존한다.

제품 목표는 [North Star](LLM_WIKI_CORE.md), 수용 기준은 [기준 요구사항](requirements/requirements.json)과 [CORE 추가 기준](requirements/core-requirements.json), 개발 순서는 [요구사항 정비 기준](requirements/MAINTENANCE.md)을 따른다. 251개 중 필수 236개·확장 12개·선택 3개이며, 전체 운영 수용 완료로 판정한 항목은 없다. 이것은 구현이 전혀 없다는 뜻이 아니다.

## 2026-11-16 문서 표시·이미지 첨부 추가 근거

EDT-001/008/009의 공통 Markdown 읽기, KaTeX MathML, 제한된 Mermaid flowchart/sequenceDiagram과 PNG/JPEG/WebP 업로드·현재 ACL 미리보기·불변 버전/검토 연결을 구현했다. 외부 자동 자원/HTML·스크립트 실행은 차단하며 PDF 추출·SVG/GIF는 미지원이다. 독립 리뷰 후 APNG 청크 거부와 요청별 이미지 응답·닫기 무효화 회귀를 추가했다. [실제 연결·지원 형식](DOCUMENT_PRESENTATION.md), [1440/390 실제 서버 화면과 합성 회귀](pr-assets/roadmap-presentation/README.md)를 따른다. 이는 전체 수용 기준이나 실제 사내 운영 인수 완료가 아니다.

## 상태를 읽는 방법

2026-11-16 편의기능 후속 설계는 [설계안](superpowers/specs/2026-11-16-essential-convenience-design.md)과 [구현 플랜](superpowers/plans/2026-11-16-essential-convenience.md)을 따른다. 10개 작업의 현재 격차·기존 PR 재사용·화면/API·권한·인수 기준과 12개 PR 단위 의존성을 정리했다. 이 문서 추가는 기존 구현·검증·운영 인수 상태를 승격하지 않는다. PR #30 및 #45~48의 병합/최종 검사는 각 PR 기록을 별도로 확인한다.

- **구현:** 실제 서비스 로직이 있는가. 파일·화면 이름만으로 구현을 판정하지 않는다.
- **연결:** 실행 진입점에서 인증·정책·저장소·작업·화면까지 호출되는가. `503`, 비활성 기능과 독립 어댑터를 구분한다.
- **검증:** 실행한 커밋·환경·명령·범위가 있는가. 테스트 파일 존재와 과거 통과 기록은 현재 커밋 재실행이 아니다.
- **운영 인수:** 실제 사내 환경과 수용 기준에서 승인됐는가. 구현·합성 회귀 통과로 대신하지 않는다.

아래 표는 기능군의 대표 경계를 추적한다. 해당 요구사항 전체의 전수 코드 감사나 완료율이 아니다. 새 증거가 없는 항목의 상태는 올리지 않는다.

## 실행 경로별 현황

| 기능군 / 관련 기준 | 구현·연결 근거 | 남은 조건 |
| --- | --- | --- |
| 편입·검토·발행 / CORE-002~004·008, COL, REV | [runtime 서비스](../server/runtime/knowledge.ts), [편입 서비스](../server/imports/service.ts), [발행](../server/publication.ts), [입력 화면](../src/operational/ImportWorkbench.tsx). 개인 입력→분석/정리→공개 검토→지식 검토/발행 경로가 있다. | 실제 업무 자료의 의미 품질과 전체 수용 기준. 원본 공개 승인과 지식 발행은 별도다. |
| 질문·답변 재편입 / CORE-005~006, QNA | runtime의 `query`/`file`과 [HTTP](../server/runtime/http.ts), [앱](../src/operational/App.tsx)에 연결돼 있다. | [fileAnswer](../src/domain/wiki.ts)는 새 답변 페이지를 제안한다. 기존 결론/조건을 갱신하는 재편입과 누적 효과는 별도 구현·평가 대상이다. |
| 개인 후속 대화 / QNA-005·008 | 인증 호스트에서 본인 스레드, durable 턴·재개, 권한 재확인 이력과 질문 화면을 연결했다. 답변과 완료 턴은 동일한 fenced 트랜잭션에서 저장한다. 큐가 없으면 턴 실행은 비활성이다. | 합성 DB·loopback 회귀는 실제 사내 모델의 품질이나 운영 인수가 아니다. 브라우저 화면 증거와 독립 보안 리뷰, CI가 남는다. |
| 에이전트 소비·결과 보고 / CORE-009~010, QNA-006, KNO-012 | [agent MCP](../server/agents/mcp.ts)의 검색·읽기·context·산출물·변경 제안·outcome 경로가 runtime에 연결된다. [자격증명](../server/agent-credentials.ts), `AgentService.reportOutcome`→`RefinementService.importAgentSignals` 연결도 있다. | 결과는 미검증 관측·재검토 신호다. 실제 호스트의 인증·권한 철회·업무 완료·독립 실행 증거와 CORE-009 전체 인수는 별도 검증한다. |
| 주장·조건·시간·상충 / KNO-002~006·013, CORE-007 | [정련 서비스](../server/refinement/service.ts), [주장/계보 로직](../server/refinement/logic.ts), semantic job adapter와 runtime/App 정련 경로가 있다. | 자연어 상충 탐지/해소의 정확도, 편입 결과와 주장 계보의 전체 연결, 정정 후 회귀와 업무 효과. 모델 제안을 검증 사실로 승격하지 않는다. |
| 지속 작업·일정 / JOB, MGR, CORE-011 | [runtime jobs](../server/jobs/runtime.ts), [worker](../server/jobs/worker.ts)의 `scheduleTick`, [main](../server/runtime/main.ts)의 `jobs.start()` 및 편입 worker가 있다. | 서비스 주체·실제 정책·일정별 장애 복구와 예산 인수. 개인 로컬 커넥터의 상시 daemon은 범위에서 제외한다. |
| 사람의 편집·협업 / EDT, CLB, VER | [workflow HTTP](../server/workflows/http.ts), [협업 HTTP](../server/collaboration/http.ts)·검토 기한 worker 및 [사용자 알림 화면](../src/operational/notifications.tsx)이 runtime에 연결된다. | 별도 [versions HTTP](../server/workflows/versions/http.ts)의 호스트 연결은 미완료다. 검토 worker는 명시된 활성 서비스 주체와 디렉터리가 필요하며 이메일은 승인된 서명 수신자 증명·게이트웨이 설정 없이는 전달하지 않는다. 실제 사내 설정·전송·운영 인수는 미검증이다. |
| 신원·접근 관리 / IAM, ACL | OIDC 세션·현재 권한, 공간·팀·Owner, 범위 자격증명 경로가 있다. | 계정 화면과 인증된 identity HTTP에서 본인 세션 조회·철회·전체 로그아웃을 연결했다. 긴급 접근·디렉터리 설정은 명시적 서버 구성에만 노출된다. 실제 IdP 연동·브라우저/운영 인수는 별도다. 기존 3역할 호환은 이관 전 증거와 fresh OIDC가 있는 미이관 공간에 한정하며 [복구 경계](LEGACY_ACCESS_RECOVERY.md)를 따른다. |
| 실제 도구 수집 / COL-003·005·008 | 서버가 승인한 개인 host·canonical 주체·세션 목록에서 선택 메시지를 직접 가져오는 [연결](../server/storage/trusted-collector.ts), 철회 및 앱 선택 화면을 구현했다. OpenCode2.2.2 fixture·실제 합성 TLS·인증 HTTP/DB로 검증한다. 호출자 artifact 입력은 차단한다. | 기본 연결 없음. 실제 승인된2.2.2 설치/소유권·버전 probe 인수는 별도이며 현재 로컬1.15.0은 미지원이다. 무인 수집·추론/도구 입력·다른 버전을 지원한다고 표시하지 않는다. |
| 보존·삭제·복구 / LIF-005~007, VER-012, OPS-008~009 | [보존 서비스](../server/retention/service.ts)와 [삭제 경계](../server/operations/erasure.ts), 운영 도구가 있다. | 전체 공간 삭제·복구 재생은 질문·에이전트 자격증명·버전 기록을 포함하며 원본 단위는 계보 없는 자료를 미해결로 보고한다. 일반 보존은 미참조 개인 초안과 제한된 비최신 이력에 적용된다. 휴지통의 명시 정책 유예와 현재 ACL 기반 복구·위치 충돌 해결이 연결된다. 명시 서비스·정책 버전에 고정된 지속 작업과 참조 없는 비최신 발행 버전·원본 스냅샷의 제한된 가지치기가 연결된다. 원본 스냅샷 CAS 물리 정리와 외부 백업·운영 인수 검증은 남는다. 차단 성공은 삭제 완료가 아니다. |
| 개인 작업본 통합 / CORE-009, KI-01~08 | [로컬 커넥터](../scripts/wiki-connector/service.mjs)는 합성 개발 서비스 경로이고 [서버 agent 서비스](../server/agents/service.ts)에는 개인 작업본 관련 로직이 있다. | 현재 로컬 커넥터와 운영 서버의 실제 종단 통합·KI 인수는 별도다. [ADR 004](adr/004-unified-knowledge-service.md)는 제안 상태다. |
| 평가 / CORE-012, EVA | 기존 사전 작성 위키 실행기와 별도로 [실제 유지 순환 평가](../server/evaluation/run.ts)는 편입·독립 검토·발행·운영 질문·점검을 3회 이상 실행하고 동일 원본의 raw/static/maintained 대조군을 평가한다. 합성 HTTP/DB/loopback 회귀와 현재 ACL·전송 정책 재검사가 있다. | 합성 응답과 문자열 인용 검사는 의미적 지지·실제 업무 개선을 증명하지 않는다. 실제 승인 정답·도메인 판정자·사내 환경과 기존 100답변/95% 등 수용 기준은 미검증이며 검토 작업 시간은 명시된 인간 시작/완료 기록이 없으면 미측정이다. |
| 배포·운영 / OPS, NFR | [기동](../server/runtime/main.ts), [site 배포 도구](../scripts/k8s/deploy-site.mjs), [운영 설정](OPERATIONAL_SETUP.md) 및 과거 kind/OIDC/모델 실행 기록이 있다. | 사내 SSO/TLS/CNI·저장소·독립 백업·보존 정책·혼합 부하·복구·운영 인수. 로컬/CI 검사를 운영 승인으로 사용하지 않는다. |

## 먼저 해소할 제품·운영 결정

1. **기존 공간 업그레이드:** 미이관 공간은 검증된 전환 직전 membership·세션 증거와 fresh OIDC에 근거해 제한된 3역할을 유지한다. 이미 010이 적용되어 증거가 없는 DB는 현재 membership을 소급 신뢰하지 않으며 [서명된 운영자 백업 진술](LEGACY_ACCESS_RECOVERY.md) 없이는 격리한다. 실제 백업 진위·운영 인수는 별도다.
2. **첫 실제 업무 사례:** 장애 해결 등은 평가 시나리오 제안이다. 제품 사용팀의 확정된 첫 업무로 간주하지 않는다. 사례가 정해지면 성공·실패·적용 조건·독립 실행 증거와 담당 검토자를 고정한다.
3. **부하 등급:** 동시접속 10명 이하의 초기 배포 가정, NFR-001의 동시 활성 100명 등 제안 부하, 전사 확대 가정을 각각 표시한다. 작은 부하 통과로 원래 NFR을 충족했다고 판정하지 않는다. 운영 부하/목표 변경은 근거와 승인 기록을 요구한다.

## 기록과 갱신

기존 `implementation-status.json`, `src/data/roadmap.json`의 `demoCoverage`는 초기 로컬 시연 정보다. `operational-backlog.json`은 2026-10-30의 작업 분석 스냅샷이다. 현재 코드 연결이나 완료율로 사용하지 않는다. `check:requirements`는 251개 매핑·원래 수용 기준·미검증 상태를 확인하며 기능의 동작을 증명하지 않는다.

기능 변경 PR은 해당 행과 [인계](AGENT_HANDOFF.md)에 요구사항 ID, 코드/route/UI, 실제 실행한 검사와 커밋, 남은 조건을 남긴다. 소스가 변경되면 이 문서의 기준 커밋 이후 차이를 재검토한다. 현재까지의 테스트 이력은 [TESTING](TESTING.md), 효과 측정의 계약은 [EVALUATION](EVALUATION.md)을 따른다.

- P8 native local connector supports scoped-credential access, explicit current copy policy and dependent proposals for selected revisions. Evidence uses synthetic PostgreSQL/native HTTP and two clients; actual SSO, installation and production policy acceptance remain separate. ADR 004 remains proposed.
- P9 휴지통 복구 독립 리뷰 수정: 실제 유지관리자의 이름/부모 변경 복구가 휴지통 페이지 재조회로 404가 되던 문제를 수정했다. 현재 원본·대상 ACL과 보호 권한을 유지하며 실제 인증/DB 회귀와 전체 검사를 통과했다. 충돌 안내에 제목 선택 설명 추가는 후속이다.

- P9 보존 리뷰 후속: 복구 재생에서 원본 법적 보류·비공개 참조·최신 스냅샷을 보수적으로 보호하고 초안의 현재 및 이력 계보에 대한 실행 자격증명의 접근을 재검사한다. CAS 물리 purge와 실제 운영 정책 검증은 남아 있다.
- P7/P9 integration: applied workspace erasure receipts, including physical-purge-pending states, fence trusted collection before outbound requests and at final commit. Legal-hold and failed preflight alone are not treated as completed erasure. Verified with synthetic PostgreSQL 17, native HTTP and local TLS; external physical deletion and production operation remain separate.

- SHR-007: fixed current descendants can be previewed and explicitly selected for an authenticated recipient. Atomic creation rechecks input rights and policy/selected versions; no later descendants or expanded source audience. Max50 pages, preview10minutes.
### 2026-11-16 — Task 5 일반 편입 계보·검토 환류
- KNO-002~006/013/014: [일반 편입](../server/runtime/knowledge.ts)도 [공통 후보 바인딩](../server/runtime/ingest-lineage.ts)을 사용해 정확한 원본 fingerprint/위치·조건·유효 기간·예외를 미검증 주장 후보로 저장한다. 승인된 원자적 발행에서만 기존 refinement 주장/근거/상충 요청으로 연결한다. 승인/모델 성공을 독립 실행 검증으로 바꾸지 않는다.
- 반려 사유·검토자·시각을 저장하고, 전체 현재 ACL의 반려 내용·발행된 사람 수정/보호 이유가 다음 일반 편입/답변 재편입에 전달된다. 동일 원본·동일 내용 재제안은 서버가 차단한다. 원본 정정은 영향 발행 버전/주장별 재검토 요청과 미발행 승인 무효화에 연결되며 원본/이전 주장을 덮어쓰지 않는다.
- 연결: 기존 REST·MCP·durable Ingest가 같은 RuntimeService를 호출한다. 검토 화면의 반려 사유 입력/이력, 정련 화면의 원본 정정 이유·원본/대체 ID를 표시한다. [설계와 한계](superpowers/specs/2026-11-16-knowledge-lineage-feedback.md), [실제 화면 증거](pr-assets/roadmap-knowledge-lineage/README.md).
- 검증/경계: 실제 PostgreSQL·loopback 모델/OIDC·MCP SDK·브라우저 회귀이며 실제 사내 모델 의미 품질/독립 업무 증거/운영 수용을 뜻하지 않는다. 정확히 같은 제안의 반복 차단과 의미상 같은 제안의 판단을 구분한다. 피드백 이력/모델 컨텍스트 한도 초과는 명시 오류로 남긴다.
- PR52 검토 P1 보완: 반려안의 외부 링크·전이/과거 원본·상위 문서 전체를 현재 권한으로 검사하고, 그 완전한 envelope를 모델 전송/저장 시 다시 검증한다. 답변 편입에는 원래 답변 envelope 밖의 피드백을 보내지 않는다. 권한을 잃은 링크 ID만 제거하며 반려 본문을 유지하던 부분 검사는 사용하지 않는다.
- 2026-11-16 Task 8 (CLB-004–006): current-category/space subscriptions, document comment integration, transactional publication/pending-review/terminal-job-failure outbox, explicit lifecycle expiry and personal processed state are connected to the existing collaboration notification/digest worker and UI. Read/final-send gates reauthorize current identity, whole source context and subscriptions; retries deduplicate. [Exact API/limits](superpowers/specs/2026-11-16-notifications-contract.md) · [synthetic browser evidence](pr-assets/roadmap-notifications/README.md). Local PostgreSQL/native HTTP/React/project checks are distinct from actual directory/gateway and operational acceptance; no semantic quality claim is added.
- EDT-012: 운영 편집 화면의 다중 문서 태그/위치/보관 미리보기·대상별CAS 결과·실패 재시도 연결. 미리보기는 최대50문서/10분이고 현재권한을 적용 시 재검사한다.

## 2026-11-16 추가: 문서 탐색과 개인 목록

EDT-007/010, SRH-009/010의 사람 탐색 경로를 연결했다. 현재 발행본 목차·코드/표 본문 검색 위치 이동, 현재 ACL의 내부 링크 자동완성·삽입 전 재검사·한 단계 백링크와 태그 관계, 기존 서버 즐겨찾기/최근 목록을 제공한다. 관계는 펼칠 때 최대 20건씩 조회하며 숨긴 문서 제목·개수는 반환하지 않는다. [설계·API·한계](design/2026-11-16-document-navigation.md)와 [실제 브라우저 1440/390 캡처](pr-assets/roadmap-navigation/README.md)를 따른다. 포커스 복귀/60초 권한 새로 고침은 실시간 푸시 철회를 뜻하지 않는다. 전체 상태 ACL 계산의 대규모 부하 시험·사내 운영 인수·실제 업무 효과는 남는다. 기존 요구사항의 운영 검증 상태는 변경하지 않는다.

## 2026-11-16 Task 1a — Unified scoped search

- Requirements: SRH-002/003/004/005/007, CORE-009/010 search integration. AgentService, ScopedSearch, cookie MCP and runtime HTTP share strict filters, actual historical bodies, current ACL and credential ceilings. Agent legacy offset DTO remains, with signed cursors and explicit historical metadata status. Unknown history is never filled from current title/conditions.
- Default search/context uses canonical currentRecommendation, excluding active+replacementId, archived and future-effective pages. Explicit history/read stays available and is not described as current recommendation.
- [API decisions, North Star invariants and remaining limits](implementation/2026-11-16-unified-search.md). Semantic selection and index operations are separate following units; no whole-requirement or company model quality/agent-performance acceptance claim.
- Verified Task1a: final Node24 `npm run check` passed (src172 + Node48 + imports16 + evaluation41, requirements251, server typecheck, build/static HTTP smoke). Native PostgreSQL17 per-file runner passed 10 files/68 tests; final changed-search rerun passed 3 files/24 tests after cookie DTO compatibility mapping. No model/provider calls or semantic quality claim in this unit.

## 2026-11-16 Task1b - configured semantic retrieval

- Requirements: SRH-001/002/003/004/005/007 and CORE-009/010 implementation scope. Actual model selection over the complete authorized filtered corpus (up to100 versions, without lexical prefilter), exact quote checks, canonical historical metadata and current source/dependency checks. Durable budgets, actual telemetry and current result-read authorization remain enforced.
- Connected authenticated REST, agent/cookie MCP and web mode admit/poll real jobs; unconfigured/policy/budget/limit/invalid-output cases remain failures. No answer/wiki/publication effect. [API, North Star decisions and limits](implementation/2026-11-16-semantic-search.md), [1440/390 browser evidence](pr-assets/semantic-search/README.md).
- Company semantic quality, external CLI interoperability, large-wiki performance and downstream utility remain unverified acceptance; native provider replies are synthetic. Index freshness/rebuild is separate Task1c.
- Validation Task1b: final Node24 npm run check passed (src173, Node48, imports16, evaluation41, requirements251, server typecheck, build/static HTTP smoke). PostgreSQL17 per-file isolated broad regression passed15 files/154 tests; final semantic11-test isolated rerun passed after malformed-schema repair. Browser1440/390 success/failure screenshots are explicitly synthetic UI evidence.

### Task1b review corrections - semantic retry and key collisions

- Stored job kind and sealed semantic payload are checked before accessing snapshotHash. Reusing an ordinary query/lint key returns IDEMPOTENCY_CONFLICT and creates no additional job/model call.
- Web semantic search releases its key when job progress definitively reports dead/cancelled, allowing identical-filter retry to create a fresh job. Unknown admission, network interruption and poll timeout retain the original key to prevent duplicate uncertain jobs. No layout changed; existing screenshot evidence remains applicable to presentation.
- Added native query/lint collision RED regressions and UI dead/cancelled/new-key plus admission-network/poll-network/poll-timeout/same-key checks. Final command/results recorded below after execution.
- Review-fix validation: final Node24 npm run check passed (src178, Node48, imports16, evaluation41, requirements251, server typecheck, build/static smoke). Isolated PostgreSQL17 runtime52 plus semantic13 tests passed; UI semantic6 passed. Both terminal retry and uncertain same-key cases are executed regressions. git diff --check clean.

## 2026-11-17 — 검토된 변경 집합의 예약 발행

REV-011의 서버/UI 경로를 추가했다. 사람이 승인된 고정 집합과 미리보기 시각을 확인하고 현재 세션에 묶어 예약하며, App1 스캐너가 도래 시 정본 즉시 발행과 같은 현재 권한·검토자·해시·원본 상한·정책·기준 버전을 재검사한다. 취소/성공과 발행 영수증은 DB 잠금으로 직렬화하고 중복 worker/재시작에서 중복 버전을 만들지 않는다. 승인/발행 권한을 에이전트 job이나 서비스에 부여하지 않는다.

`scheduledPublication` 사이트/공간 정책은 생성과 실제 worker 양쪽에서 적용하며 조회/취소는 비활성화 중에도 가능하다. 예약 기간은 현재 세션·절대·유휴 만료 안으로 제한하고 장기 예약을 보장하지 않는다. 실제 운영 검증과 정각 SLA는 미완료다. [계약·설정·검증 범위](implementation/2026-11-17-scheduled-publication.md), [화면 증거의 합성 API 경계](pr-assets/scheduled-publication/README.md)를 참조한다.
