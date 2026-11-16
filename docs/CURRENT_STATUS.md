# 현재 구현과 남은 연결

기준일: 2026-11-14. 확인한 소스: `9883fbeb609c99fc4b0247168d496ac65fa0b8e4`. **소스 정적 대조이며 새 운영 인수 결과가 아니다.** 이 문서는 현재 구현을 읽는 진입점이다. 기능 변경 시 해당 행의 소스·연결·남은 조건과 확인 커밋을 함께 갱신한다. 날짜가 있는 과거 인계·시험 기록은 당시 증거로 보존한다.

제품 목표는 [North Star](LLM_WIKI_CORE.md), 수용 기준은 [기준 요구사항](requirements/requirements.json)과 [CORE 추가 기준](requirements/core-requirements.json), 개발 순서는 [요구사항 정비 기준](requirements/MAINTENANCE.md)을 따른다. 251개 중 필수 236개·확장 12개·선택 3개이며, 전체 운영 수용 완료로 판정한 항목은 없다. 이것은 구현이 전혀 없다는 뜻이 아니다.

## 상태를 읽는 방법

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
