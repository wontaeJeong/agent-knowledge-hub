# 업무 에이전트 인터페이스

후속 구현: `server/runtime/mcp.ts`의 `/mcp`는 실제 SDK Streamable HTTP이며 OIDC 브라우저 세션·Origin·CSRF를 검사한다. 현행 도구는 `knowledge_search`, `knowledge_query`, `knowledge_ingest`, `knowledge_lint`, `knowledge_jobs`로 별도 버전 경로이며 공통 서버 ACL/계보/발행 서비스를 사용한다. 독립 서비스 계정/Bearer 위임·업무 context/outcome·아래 `wiki_*` 목표 계약 전체와 개인 커넥터의 운영 통합은 **미구현**이다. 쿠키 세션 도구를 일반 에이전트 호스트 운영 인증까지 완성한 것으로 표시하지 않는다. [설정과 현재 한계](OPERATIONAL_SETUP.md).

이 문서는 **운영 목표 계약**이다. 현재 앱에 범용 사내 REST API나 인증된 운영 MCP가 구현된 것은 아니다. 모델 중계는 로컬 실행기의 /api/model/config와 /api/model/complete다. 별도로 [로컬 위키 커넥터](LOCAL_WIKI.md)는 합성 개발 서비스용 STDIO MCP를 제공한다. 이 개발 프로토콜의 도구·단일 페이지 제안은 아래 운영 계약 전체와 호환/통합됐다는 뜻이 아니다.

## 구성과 책임

웹·MCP·매니저는 같은 지식 서비스 계층을 사용한다. 원본·위키·발행 집합·작업 기록은 서버가 소유하며 검색 인덱스는 재생성 가능한 파생 데이터다. 도구 호출자의 실제 사용자·위임·서비스 주체로 권한을 검사한다. 요청 본문의 사용자 이름이나 공통 관리자 키로 신원을 대신하지 않는다. MCP Tools를 기본으로 제공하고 버전별 본문 Resources는 클라이언트 호환성을 검증해 추가한다.

| 제안 도구 | 주요 입력 | 결과와 제약 |
| --- | --- | --- |
| wiki_search | query, project, environment, limit | 현재 권한의 발행본 요약·적용 조건·버전·검증 상태 |
| wiki_read | page_id, version, section_id | 해당 버전·본문 위치·정확한 근거·예외 |
| wiki_get_context | task, project, environment, token_budget | 필요한 지식·조건·근거, 생략 정보와 추가 조회 방법 |
| wiki_submit_artifact | artifact, evidence, scope, idempotency_key | 원본 스냅샷 등록과 처리 상태; 자동 공개하지 않음 |
| wiki_propose_change | base_versions, updates, source_refs, idempotency_key | 변경 집합; 승인·발행 권한을 포함하지 않음 |
| wiki_report_outcome | used_versions, result, observations, evidence | 사용 결과와 재검증 필요 신호; 성공 주장만으로 공식화하지 않음 |

긴 편입 작업은 job_id를 반환하고 명시적인 상태 조회·취소를 제공한다. 입력·출력 JSON Schema, 페이지네이션·상한·추적 ID·오류 계약과 호환 정책을 버전으로 관리한다. STALE_VERSION, SOURCE_SCOPE_CONFLICT, EVIDENCE_MISSING, RATE_LIMITED, MODEL_UNAVAILABLE 등의 오류가 에이전트의 다음 행동을 결정할 수 있어야 한다.

## 로컬 위키 MCP와 운영 목표 계약의 관계

현재 `scripts/wiki-connector/mcp.mjs`의 `wiki_search`/`wiki_read`는 서버의 최신 허용 페이지 메타데이터를 확인하고 로컬 복사 텍스트를 읽는 개발용 도구다. `wiki_write`/`wiki_sync`는 개인 작업본과 동기화 상태만 다루며, 현행 `wiki_propose_change`는 **고정 개인 revision의 단일 페이지** 공유 변경 제안이다. 이 이름들이 운영 목표 표의 이름과 같더라도 원본 검증·지식 컴파일·근거 기반 컨텍스트 제공·성과 환류가 구현됐다는 뜻은 아니다.

미래 통합은 [통합 계획](KNOWLEDGE_INTEGRATION.md)의 KI-01~08 및 제안 상태의 [ADR 004](adr/004-unified-knowledge-service.md)를 기준으로 도구 책임을 구분한다. 개인 draft는 임의의 원본 `sourceRefs`만으로 공식 지식에 승격되지 않으며, 다중 의존 페이지는 현재 단일 페이지 공유 발행으로 우회하지 않는다. 구체적인 운영 JSON Schema/버전/호환성은 별도 설계·검증 후 확정한다.

## 호출 시점

업무 시작 시 관련 정책과 기존 사례를 검색한다. 적용 전 환경·버전·전제 조건과 공식성을 읽는다. 결과가 기존 지식과 다르면 새 근거와 함께 변경 제안한다. 업무 종료 때 공유가 허용된 산출물과 실제 검증 결과만 선택 등록한다. 호출 정책은 각 호스트가 지원하는 프로젝트 지침·훅에 연결하고 정확한 클라이언트 버전으로 검증한다. 모든 대화와 파일을 무조건 수집하지 않는다.

위키 본문·원본·도구 결과는 자료다. 그 안의 지시문이 접근·실행·외부 전송 권한을 부여하지 않는다. 상시 의무 통제는 서버가 강제한다. 검색 후보 선택과 최종 응답에서 현재 권한을 확인하고 캐시·과거 답변도 같은 정책을 적용한다.

## 런타임 지침

[wiki/SCHEMA.md](../wiki/SCHEMA.md)는 업무 지식 유지관리 규칙이다. 루트 AGENTS.md와 CLAUDE.md는 이 앱을 개발하는 에이전트용이다. 둘을 혼동하거나 문서가 있다는 이유로 실제 MCP 연동을 완료했다고 표시하지 않는다.
