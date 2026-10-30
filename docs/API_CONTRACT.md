# 서버 API 제안 계약

후속 실행 경로: `server/runtime/http.ts`는 OIDC 세션·CSRF가 적용된 `/api/v1/me`, `pages`/고정 버전, `sources`, `members`, `changesets`/승인·발행·반려, `ingest`, `query`, `answers/:id/file`, `lint`, `jobs`, `model`, `usage`를 제공한다. 현행 스키마는 `server/runtime/schema.ts`가 기준이며 목록은 `{items}`, 오류는 `{code,requestId}`다. 아래 artifacts/manager/restore/shares 등 목표 계약 전체를 구현한 것은 아니다. [실제 설정/검증/제약](OPERATIONAL_SETUP.md)을 따른다.

현재 실행 중계 API는 docs/MODEL_SETUP.md에 별도 정의한다. 아래는 여전히 프로덕션 서버의 목표 계약이다. MCP 도구 상세는 AGENT_INTERFACE.md를 따른다.

후속 구현으로 `server/http.ts`의 **인증 어댑터 주입형** `GET /api/v1/usage?days=7|30` 핸들러를 추가했다. 실제 호스트 세션 검증과 같은 origin 마운트가 필요하며 기본 정적 데모에 이 엔드포인트가 활성화된 것은 아니다. 일반 구성원은 본인, 검토자는 workspace 전체 집계를 읽는다. 오류/권한/측정 범위는 [SERVER_FOUNDATION.md](SERVER_FOUNDATION.md)를 따른다. 아래 업무 API는 계속 목표 계약이다.

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

## 공간 권한 확장 API (2026-10-30 제안, 미구현)

[권한 모델](ACCESS_CONTROL.md)과 [ADR 005](adr/005-github-style-access-control.md)의 소유권·5역할·공개/자료 제한을 구현할 때 필요한 경계다. 다음은 경로 설계 제안이며 현행 단일 `WORKSPACE_ID` 서버에 존재하지 않는다. 기존 API에 space ID를 받는 것만으로 범위를 늘리지 말고 신원·공간·자원·위임 상한을 공통 서비스에서 검증한다. 기존 클라이언트 호환/버전 정책은 구현 PR에서 명시한다.

| 제안 경로 | 정책/응답의 핵심 |
| --- | --- |
| POST /api/v1/teams | `team.create` 정책의 활성 사내 사용자만 생성, 첫 Owner 고정 |
| GET /api/v1/teams/{teamId}/members | 해당 팀의 관리 권한·멤버 목록 공개 정책 검사 |
| POST /api/v1/teams/{teamId}/invitations | 팀 Owner만 멤버 초대, 수락/만료/취소 전 접근 없음 |
| POST /api/v1/teams/{teamId}/ownership-transfers | 현재 Owner 요청·대상 수락, 마지막 Owner 조건과 원자 이전 |
| GET /api/v1/spaces | 실제 권한 있는 공간만 열거. 문서 한정 공유를 공간 전체 접근으로 표시하지 않음 |
| POST /api/v1/spaces | 개인은 본인, 팀은 Owner 또는 명시적 공간 생성 권한. 기본 Private |
| GET /api/v1/spaces/{spaceId}/capabilities | 현재 자원/작업별 실효 capability·공개 범위·정책 버전. 다른 사람/공간 정보 제외 |
| GET /api/v1/spaces/{spaceId}/access | Admin의 해당 범위 grant·경로·만료, 자료 내용은 별도 권한 |
| POST /api/v1/spaces/{spaceId}/access/preview | Admin의 역할/공개/공유 변경 전후 새 독자·제약·영향. 서버에서 계산 |
| PUT/DELETE /api/v1/spaces/{spaceId}/grants/{grantId} | Admin, 소유 Owner 예외 조건, 수신자/자원/작업 한도·만료·이유와 If-Match 정책 버전 |
| PATCH /api/v1/spaces/{spaceId}/visibility | Admin 및 회사 공개 결정, 원본/파생 제한·예상 독자 검사. Company는 기본 비활성 |
| POST /api/v1/access-requests | 인증 주체의 내용 없는 요청. 무권한 객체 존재·제목·담당자 비노출 |

미발행 개인 스냅샷/변경 집합은 개인 공간 권한을 목적지에 넘기지 않는 별도 제출 계약을 사용한다. 기존 changesets 승인/발행에도 목적지 공간, 지정 검토자·독립 승인, 고정 개인 revision·기준/정책/ACL 해시와 현재 자격을 적용한다. API/MCP 위임 토큰에는 승인·발행·멤버/정책 관리 경로를 노출하지 않는다.

접근 변경은 `If-Match`로 정책 버전을 검사하고 결과의 새 정책 버전과 추적 ID를 반환한다. 버전 충돌은 `STALE_VERSION`, 승인 스냅샷 변경은 `APPROVAL_STALE`, 근거보다 넓은 공개는 `SOURCE_SCOPE_CONFLICT`로 구분한다. 존재 비노출·입력/출력 상한·멱등 생성·페이지네이션·자격증명 원문 비노출을 유지한다. AC-01~24는 후속 실행 수용 사례이며 현재 API 시험의 통과 결과가 아니다.
