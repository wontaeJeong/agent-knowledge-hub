# 서버 API 제안 계약

현재 실행 중계 API는 docs/MODEL_SETUP.md에 별도 정의한다. 아래는 여전히 프로덕션 서버의 목표 계약이다. MCP 도구 상세는 AGENT_INTERFACE.md를 따른다.

이 파일은 다음 구현의 계약 제안이며 현재 정적 데모에 아래 엔드포인트가 존재하는 것은 아니다. Repository와 도메인 개체를 서버 DTO에 매핑하고, 서버가 모든 권한·버전·발행을 강제한다.

| 경로 | 동작과 주요 조건 |
| --- | --- |
| GET /api/v1/me | 실제 인증 주체·그룹·권한·기능 범위 |
| GET /api/v1/pages | 권한 있는 현재 발행본 검색·필터·커서 페이지네이션 |
| GET /api/v1/pages/{id}/versions/{version} | 현재 권한으로 버전과 근거 열람 |
| POST /api/v1/artifacts | 정규화된 산출물·공개 범위·검증 근거 등록, Idempotency-Key |
| POST /api/v1/manager/runs | 규칙 버전·범위·예산·실행 주체로 지속 작업 수락 |
| GET /api/v1/changesets/{id} | 기준 버전·내용 해시·근거·항목 의존성 |
| POST /api/v1/changesets/{id}/approve | 승인 대상 해시·기준 버전 고정 |
| POST /api/v1/changesets/{id}/publish | If-Match 및 현재 권한 재검사, 의존 그룹 원자 발행 |
| POST /api/v1/pages/{id}/restore | 기존 버전을 새 버전으로 복원, 현재 ACL 유지 |
| POST /api/v1/shares | 대상·버전·독자·만료·허용 공유 범위 검증 |
| DELETE /api/v1/shares/{id} | 공유 철회 및 첨부·캐시 차단 |
| GET /api/v1/jobs/{id} | 수락·진행·실패·취소·재처리 상태 |

에러는 요청 추적 ID와 NOT_FOUND, FORBIDDEN, STALE_VERSION, SOURCE_SCOPE_CONFLICT, APPROVAL_STALE, VALIDATION_FAILED, RATE_LIMITED, DEPENDENCY_UNAVAILABLE 등을 구분한다. 원문 비밀을 에러 메시지에 넣지 않는다. 권한 없는 자료의 존재를 드러내지 않는 응답 정책을 통일한다.

MCP의 검색·읽기·등록·변경 제안도 같은 서비스 계층을 호출해야 한다. MCP 호출자의 대화 속 사용자 이름으로 신원을 결정하지 않는다. 실제 도구 버전·스키마를 fixture로 검증하고 현재 미구현 도구를 지원한다고 표기하지 않는다.
