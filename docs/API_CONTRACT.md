# 서버 API 제안 계약

현재 마운트·차단 경로는 [현재 현황](CURRENT_STATUS.md) 및 `server/runtime/http.ts`를 따른다. 아래 제안 URL은 구현 경로의 전체 목록이 아니며, 과거 기반 단계 기록은 당시 범위다.

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

## 공간 권한의 확장 계약과 현행 API (2026-10-30)

[권한 모델](ACCESS_CONTROL.md)과 [ADR 005](adr/005-github-style-access-control.md)의 소유권·5역할·공개/자료 제한을 구현할 때 필요한 경계다. 아래 표의 경로명은 최종 확장 설계다. 현재 실제 경로는 이 문서 끝의 `/api/v1/access`와 IMPLEMENTATION_GUIDE를 따른다. 서버는 세션에 선택한 관리 공간을 사용하며 클라이언트의 임의 workspace 헤더로 경계를 넓히지 않는다. 기존 API에 space ID를 받는 것만으로 범위를 늘리지 말고 신원·공간·자원·위임 상한을 공통 서비스에서 검증한다. 기존 클라이언트 호환/버전 정책은 구현 PR에서 명시한다.

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


## 웹 편입 · 조직 접근 관리 구현 (2026-10-30)

[실제 실행 계약·설정·검증과 남은 범위](IMPLEMENTATION_GUIDE.md), [웹 자료 편입 설계](DATA_INGESTION.md), [대화 기록](CONVERSATION_IMPORT.md)를 참조한다. 웹/REST/MCP의 개인 원본 접수·서버 영속 정리·선택 원본 공개 승인·독립 지식 검토/발행을 연결했다. Organization/Team/공간별 역할·초대·Owner·현재 권한 철회를 구현하며 기존 공간은 명시적 이관 전까지 기존 OIDC 역할을 유지한다. 원본 제한은 관리자에게도 적용한다. 새 기능의 구현은 전체 251개 요구사항이나 실제 LLM 의미 품질/운영 인수 통과를 뜻하지 않는다.

현재 접근 관리 REST: `/api/v1/access`는 현재 공간의 서버 capability·실효 경로를, `/spaces`, `/organizations`, `/invitations`는 본인에게 보이는 목록을 반환한다. POST `/bootstrap`은 명시적 운영자 바인딩 이관, `/spaces`·`/organizations`는 생성, `/switch`는 허용된 공간 선택과 CSRF 교체다. 초대 생성/수락/취소, 조직 멤버 강등/제명, Team 생성·멤버 추가/회수, `/grants` 역할/만료·회수, `/reviewers` 지정, `/visibility`는 서버의 관리 capability를 요구한다. 요청 DTO/엄격한 검증은 `server/access-http.ts`가 기준이다. 실제 제품 grant를 `OIDC_GROUP_ROLES` 값으로 클라이언트에서 덮어쓰지 않는다.

`POST /api/v1/changesets/:id/triage`는 Triage 이상의 공간 역할과 변경안 전체 근거의 현재 읽기를 함께 확인하고 `untriaged/needs-review/duplicate/blocked` 분류만 바꾼다. 승인·본문·발행 상태를 바꾸지 않는다.


## 개인 알림함 (C2 / UXC-01, 2026-11-17)

기존 인증·공간·CSRF 경로 아래 다음 API를 추가했다. 기존 `/collaboration/notifications`·preferences·구독·검토 기한·전달 API는 유지한다. UI 조회는 이벤트 생성이나 메일 발송을 수행하지 않는다.

| `/api/v1` 뒤 경로 | 계약 |
| --- | --- |
| GET `/collaboration/inbox` | `state=all|unread|archived`, 선택적 `type`, `limit` 1~25(기본25, bell5), `cursor`. `{items,nextCursor,unreadCount,readBoundary}`. all은 보관 제외 |
| POST `/collaboration/inbox/:id/state` | `{read?,archived?,expectedRevision,mutationId}`. 읽음과 보관을 독립 수정, 현재 인가된 InboxItem 반환 |
| POST `/collaboration/inbox/read-all` | `{boundary,mutationId}` → `{updated}`. 해당 주체/공간의 서명된 관찰 경계까지, 현재 보이는 미보관·미읽음 항목만 변경 |
| GET `/changesets/:id` | 기존 지식 서비스의 정확한 검토 대상 조회. 현재 작성자 또는 기존 qualified reviewer, 전체 페이지/입력/원본 계보 ACL 검사. rejected 결과는 readOnly이며 승인 권한을 부여하지 않음 |
| GET `/governance/access-requests/:id` | 현재 요청자 본인의 `{id,status,revision,createdAt,decidedAt,readOnly:true}`만 반환. 문서 열람 권한과 별개이며 문서 제목·본문·원본·정책·요청/결정 사유·다른 요청자는 반환하지 않음 |

InboxItem은 `{id,sequence,revision,type,createdAt,readAt,archivedAt,target,title,actionState}`다. 정수 `revision`을 호환 추가했다. 실제 상태가 바뀔 때 증가하며 같은 mutationId/본문 재시도는 중복 변경하지 않는다. 다른 본문 재사용은 MUTATION_CONFLICT, 오래된 revision은 STALE_VERSION이다. 기존 읽음 API로 변경된 상태도 같은 revision에 반영된다. read-all은 이후 전달된 outbox와 이후 명시적 미읽음 변경을 덮지 않는다. 재시도 영수증도 현재 주체·공간·본문·가시성을 다시 확인한다.

타입은 mention/document-updated/review-requested/review-decided/review-due/job-succeeded/job-failed/access-decided다. 실제 언급 수신자만 mention이고 다른 댓글 수신자는 document-updated 및 정확한 comment target이다. 기한 검토는 문서 target과 실제 due-work 상태(needs-review/needs-assignment/acknowledged)를 사용한다. 지식 변경 검토는 정확한 batch ID를 사용한다. 기존 철회는 `rejected` 상태와 canonical `batch.withdraw` 감사 기록으로 구분하며 정확한 조회에서 unavailable 처리한다. 접근 요청 본인 결과는 일반 제목을 사용하고 기존 관리자 타인 요청 조회/결정 권한은 변경하지 않는다.

목록 제목·개수·커서는 현재 대상/상위 위치/원본/입력 계보와 세션 인가를 사용한다. 커서는 주체·공간·필터·현재 정책 및 인가된 데이터 해시에 바인딩된다. 보호 대상 변경 시 오래된 커서를 재사용하지 않는다. 현재 조회 후보가 10,000건을 넘으면 부분 개수나 0건으로 위장하지 않고 INBOX_QUERY_LIMIT(413)을 반환한다. INVALID_BOUNDARY는400, STALE_CURSOR·STALE_VERSION·MUTATION_CONFLICT는409다. 권한·삭제에 의한 unavailable은 보호 내용을 포함하지 않는다.

서명 키 설정/재시작 동작과 메타데이터 보존은 [운영 설정](OPERATIONAL_SETUP.md#개인-알림함-설정-c2)을 따른다. 읽음은 검토 완료가 아니며 보관은 업무 취소가 아니다.


C2 리뷰 보완(2026-11-17): immutable approved 결정 이벤트는 동일 batch/hash의 canonical published 전이 뒤에도 검토 결정 알림으로 남는다. 이것은 현재 승인 권한을 부여하지 않으며 현재 철회·작성자/reviewer·전체 계보 ACL 검사를 계속 적용한다. 결정 이벤트 커서의 내부 인가 fingerprint에 현재 전체 페이지/원본 내용과 reader 집합을 포함하고, 공개 exact-detail/InboxItem DTO에는 해당 fingerprint 또는 계보 envelope를 넣지 않는다.

## 개인 문서 목록 (C3 / UXC-02, 2026-11-17)

기존 인증·선택 공간·CSRF와 WorkflowService의 문서/원본/계보/상위 위치 검사를 사용한다. 즐겨찾기 저장은 열람 권한이나 원본 복제가 아니다. 기존 favorite/subscribe 변경 URL과 `{pageId,enabled}` 응답은 유지한다.

| `/api/v1` 뒤 경로 | 계약 |
| --- | --- |
| GET `/workflows/favorites`, `/workflows/recent`, `/workflows/subscriptions` | `limit` 1~25(기본25), 선택적 `cursor`. `{items,nextCursor,revision}`. 각 항목은 `{id,title,version,at}`이고 구독의 at은 null이다. 기존 items에 페이지 정보와 개인 정렬 revision을 추가한다 |
| GET `/workflows/pages/:id/personal-state` | 현재 열람 가능한 문서의 `{favorite,subscribed}`. 방문을 기록하지 않는다 |
| POST `/workflows/favorites/reorder` | `{pageIds,expectedRevision,mutationId}` → `{revision}`. 중복 없는 현재 즐겨찾기 1~50개를 지정 순서로 해당 항목들의 기존 슬롯에 배치한다. 다른 현재 열람 가능한 항목의 상대 순서를 보존하며 숨긴 항목을 반환하지 않는다 |
| POST `/workflows/favorites/move` | `{pageId,direction:'up'|'down',expectedRevision,mutationId}` → `{revision,cursor}`. 서버가 현재 인가된 전체 즐겨찾기에서 바로 이웃과 교환하고 이동한 문서를 포함하는 현재25행 페이지의 새 서명 cursor를 반환한다(first page는 null). 클라이언트에 전체 목록/숨긴 이웃 ID를 보내지 않는다 |

즐겨찾기 변경과 재정렬은 같은 사용자·공간의 잠금/revision을 사용한다. 오래된 기준은 STALE_VERSION(409), 같은 mutationId의 다른 본문은 MUTATION_CONFLICT(409)다. 재시도에도 현재 문서/원본/상위/계보 인가와 입력을 재검사하며 저장된 문서 ID·제목을 재생하지 않는다. 재정렬 영수증은 해시·revision만 가진다.

커서는 사용자·공간·목록 종류·limit·현재 인가된 결과와 전체 의존 내용/reader 해시에 바인딩한다. 바뀐 기준 또는 변조된 커서는 STALE_CURSOR(409)다. 문서 ID·제목을 토큰에 넣지 않는다. 현재 구현의 서명 키는 프로세스 범위이며 재시작이나 다른 인스턴스에서는 처음부터 현재 인가된 목록을 다시 조회해야 한다. 개인 목록 후보가 10,000개를 넘으면 PERSONAL_LIBRARY_CAPACITY(409)를 반환하며 0건이나 잘린 성공으로 표시하지 않는다. 대규모 부하/다중 인스턴스 운용 인수는 미검증이다.

최근 방문은 기존 `/workflows/pages/:id`의 성공한 현재 인가 조회에서만 upsert하며 같은 문서는 한 항목이다. 개인 목록·상태 조회·키워드 링크 검색은 이 방문 기록 경로를 호출하지 않는다. 화면은 활성 상태에서 30초/재초점 때 재검사하고 숨긴 탭의 주기 갱신을 멈춘다. 이동 뒤 오래된 커서를 버리고 서버가 반환한 현재25행 context cursor로 다시 읽어 대상 문서와 키보드 초점을 유지한다. 이전 계정·공간·API 인스턴스의 늦은 응답은 현재 화면에 반영하지 않으며 제목/목록을 URL이나 브라우저 저장소에 복사하지 않는다.

migration141은 기존 workflow_activity에 nullable position을 추가한다. 기존 5개 값 INSERT와 기존 구독 저장소를 유지한다. 새 state/mutation 테이블은 내용이나 자원 ID를 갖지 않는 제어 메타데이터로 분류하고 보존/삭제 inventory의 정확한 스키마 검사에 등록했다. 상세 실행 증거와 한계는 [화면 검증](ui-validation/2026-11-17-personal-library/README.md)을 따른다.

C3 최종 리뷰 보완: favorite 항목의 호환 추가 `canMoveUp`/`canMoveDown`은 현재 열람 가능한 전체 즐겨찾기의 경계만 표시한다. 페이지25행 제한은 순서 범위를 나누지 않는다. move는 기존 reorder와 같은 canonical private primitive/사용자·공간 잠금/CAS/해시 영수증을 사용하며 별도 트랜잭션 안에 public 변경 메서드를 중첩 호출하지 않는다. 같은 mutationId를 다른 move/reorder 본문에 재사용하면 MUTATION_CONFLICT다. 현재 인가·목록 존재·전체 의존 envelope를 먼저 확인한 후 replay를 처리하고 실제 전역 끝의 새 이동은 FAVORITE_BOUNDARY(409)다. replay에서도 현재 인가된 snapshot으로 새 context cursor를 발급하며 과거 cursor/보호 DTO를 영수증에 보관하지 않는다. 현재 권한/목록이 바뀌거나 문서가 사라지면 generic stale/not-found 오류다. 기존 reorder의 입력1~50ID와 응답 `{revision}`은 그대로다. migration141은 바꾸지 않았다.

일반 목록 새로고침으로 초점 행이 사라지면 공용 현재 DOM helper가 현재 허용된 이웃의 같은 제어 또는 안정된 refresh/error 제어로 복구한다. 외부 keyboard/pointer 선택은 존중하며 과거 행·제목을 캐시하지 않는다. C2 useInboxFocus 공개 동작/선택자/안내는 compat wrapper로 유지한다.


## 전역 키워드 검색과 고정 버전 열기 (2026-11-17, C5)

기존 `POST /api/v1/questions/search`와 `ScopedSearch`를 사용한다. `src/domain/search-filters.ts`의 단일 검증 스키마를 서버·새 UI·기존 QuestionsWorkbench가 공유한다. 기존 필드·`historical=false`·25건·API 최대100건을 유지하고 선택적 `sort:recent|title`을 추가한다(기본 recent). title은 허용된 전체 후보를 정확 제목 → 제목 접두어 → 제목 포함 → 본문/요약 일치로 정렬한 뒤 같은 키로 페이지를 자른다. 빠른 열기10건·상세 검색25건이며 별도 검색 엔진이나 모델 작업을 만들지 않는다. cursor는 주체·credential·공간·필터(sort/limit 포함)·현재 권한/내용 revision에 결합된다. stale cursor는 결과를 비우고 처음부터 다시 검색한다.

기존 `historical`은 과거 포함 **조회 모드**이고 `currentRecommendation=false`는 그 모드의 보수적 값이다. additive `isCurrentVersion`은 해당 결과의 실제 최신 버전 여부다. UI는 세 값을 혼동하지 않으며 구형 DTO의 최신 여부는 unknown으로 표시한다. 과거 속성/제목은 당시 snapshot 또는 unknown이며 현재 메타데이터로 채우지 않는다. UI의 날짜·시각 선택은 기기의 현지 시각이며 전송 시 기존 UTC ISO 계약으로 변환한다. 빈 값은 조건을 제외하고 잘못된 날짜·역전 기간은 오류를 표시한다.

`GET /api/v1/versions/pages/{id}/{number}`는 기존 비방문 조회/DTO를 유지하고 `isCurrentVersion`을 추가한다. 실제 고정 문서 route 전체 열기만 `?visit=1`을 사용한다. visit 값은 정확히 하나의 `1`만 허용하며 잘못된 값/중복은 validation 오류다. VersionService의 동일 트랜잭션에서 현재 page/version/metadata 권한 확인 후 기존 문서 열기와 공유하는 `recordDocumentVisit`으로 인증 주체의 최근 방문을 upsert한다. 목록·미리보기·비교·인용·포커스 refresh는 비방문이다. URL에는 공간/문서/버전만 넣고 검색어·제목·본문은 URL/localStorage에 저장하지 않는다. `anchor` 경로는 C9 후속 범위다.

## C6 수동 신규 문서의 현재 구현 계약

`server/workflows/{service,manual-disclosure,new-document,http}.ts`가 아래 경로를 런타임 OIDC/CSRF 라우터 안에서 처리한다. 정적 데모의 저장이나 운영 인수 결과를 뜻하지 않는다.

| 경로 (`/api/v1` 이후) | 현재 계약 |
| --- | --- |
| POST `/workflows/drafts` | 기존 개인 CAS 저장. `pageId` 없는 문서, `parentId`, `templateId`/`templateRevision`을 수용하며 서버가 전체 템플릿·과거 계보를 합친다. |
| POST `/workflows/drafts/:id/disclosure` | `{expectedRevision,title,parentId,readers,reviewerId?,reason,mutationId}`. 소유자의 정확한 저장본·독자·위치·정책을 고정한다. 팀은 지정 독립 검토자, 실제 owner-only 개인 공간은 본인 확인 대기다. |
| GET `/workflows/draft-disclosures` | optional `queue=all` 또는 `queue=assigned-pending`, `draftId`, `cursor`. 현재 권한의 본인/지정 검토를 기본 25건씩 반환한다. `{items,nextCursor,partial}`이며 정확한 draft 조회도 같은 권한/계속 조회 계약을 따른다. 타인의 일반 초안 읽기 권한은 부여하지 않는다. |
| POST `/workflows/draft-disclosures/:id/decision` | `{hash,decision:'approve'|'reject',reason,mutationId}`. 서버가 검토 모드·현재 자격·계보를 재검사한다. |
| POST `/workflows/drafts/:id/submit-new` | `{expectedRevision,title,parentId,reason,disclosureId,disclosureHash,mutationId}`. 승인한 같은 본문을 immutable 수동 원본과 초기 변경 집합으로 한 트랜잭션에 등록한다. `{status:'knowledge-review-pending',sourceId,batchId,hash}`이며 별도의 기존 approve/publish가 필요하다. |
| POST `/workflows/recovery/permission`, `/validate` | 기존 page 바인딩과 `{kind:'draft',id,draftId,expectedRevision,sourceIds,dependencyVersions}`를 수용한다. 서버의 실제 owner·revision·전체 계보·local.copy 허용에 묶인다. |

기존 `submitDraft`의 `SOURCE_REGISTRATION_REQUIRED`는 유지한다. 모델 호출·가짜 import_run·즉시 발행은 없다. 동일 mutation은 같은 결과만 반환하며 내용·기준·정책 변경 시 재검토한다. C4는 `/?app=1&space=<space>&section=compose&draft=<id>`로 정확한 새 초안을 재개할 수 있다. C7 복제는 기존 `saveDraft`의 `sourceIds`/`dependencyVersions`를 보존하는 개인 저장 계약을 사용하고 공개 절차를 생략할 수 없다.

### 영속 스키마와 삭제 경계

migration `142-new-document-disclosure.sql`은 `workflow_draft_disclosures`에 workspace/owner/draft/revision, snapshot/content hash, dependency envelope, parent/policy hash, audience/reviewer/server policy mode, status/revision, request/decision mutation 기록, source/batch/submission 관계를 저장한다. 요청·제출 유일 키가 중복 생성을 막는다. import 테이블과 FK는 변경하지 않는다.

새 `sources.data.manualProvenance`는 기존 captureEnvelope에서 얻은 page/source ID만 보존하며 원본 직접 읽기·목록도 모든 현재/과거 계보의 canonical readers 교집합을 따른다. 외부 source DTO에 이 메타데이터 주입 권한은 없다. 초기 parent 위치는 hash-bound batch의 trusted `initialDocument`로 저장하고 실제 발행 시에만 정본 문서 위치가 된다.

삭제 권위는 Source JSON의 임의 owner/draft 주장이 아니라 `workflow_draft_disclosures.source_id → owner_id,draft_id` 관계다. private draft 삭제 시 미제출 요청과 본문 이력/복구 grant를 삭제하고, 제출된 관계는 본문·사유·decisions를 지우고 snapshot의 서버 소유 templateIds만 남겨 템플릿 사본을 이후 원본 삭제 그래프에서 찾는다. 원계보 source 삭제와 등록된 manual source 자체 삭제 모두 기존 법정 삭제 walk를 사용한다. 보존 inventory는 비공개 본문을 해시로 투영하고 계보 ID만 유지한다. 기존 hold·retirement·workspace erasure write fence를 우회하지 않는다.

C6 리뷰 수정 1차: 공개 요청의 `reason`은 보호 snapshot의 `requestReason`, 결정 사유는 기존 `decisions`의 `{decision,reason,principalId}`로 저장한다. authorized list는 이를 `requestReason`/`decision`으로 반환한다. 동일 mutation의 다른 사유는 idempotency conflict이며, 별도 댓글 권한이나 공개 감사 평문을 만들지 않는다. 이전 버전이 폐기한 사유는 없음으로 표시한다. 목록은 예상 권한/기준/retirement 거부만 제외하고 정책 의존성·SQL·프로그램 실패는 오류로 반환한다.

명시적 templateId 복사 계보는 owner-scoped template→draft/history token으로 기존 삭제 그래프에 연결한다. 원본 등록 전 복사도 포함하며, 현재 초안에서 templateId를 지워도 서버 이력은 유지한다. 다른 소유자의 동명 템플릿/초안이나 연결 없는 동일 본문에는 삭제 권위를 부여하지 않는다. UI는 고정 공개 독자/검토자와 새 선택을 구분하고 선택이 바뀌면 fresh disclosure 없이 이전 승인으로 제출하지 않는다.

C6 등록된 파생 사본의 삭제는 disclosure의 정본 `source_id`까지 전파하여 source/batch/발행 version을 같은 그래프에 포함한다. 공개 요청 snapshot의 내부 `templateIds`는 서버가 확인한 해당 owner의 현재+과거 초안에서 수집한다. 템플릿 내부 `producerDraftIds`는 검증한 생산 초안 ID를 누적하여 CAS 갱신에서 sourceDraftId를 생략해도 삭제 관계를 유지한다. 두 필드는 외부 입력 schema에서 허용하지 않고 save/list DTO에 노출하지 않는다. 이전 sourceIds/dependencyVersions 상한도 갱신에 보존하며 제거하려는 요청은 기존 scope 검사를 통과해야 한다. 새 테이블·삭제 API·동일 텍스트 추론은 추가하지 않는다.

최종 리뷰 F1: 목록은 `(created_at DESC,id DESC)` keyset으로 한 요청에서 raw100까지 검사한다. `partial:true`는 탐색 미완료이며 숨은 수/ID나 전체0을 뜻하지 않는다. `nextCursor`로 이어 조회하고 `null`일 때만 완료다. cursor는 서버 프로세스 AES-GCM 키로 암호화하며 principal/credential/session/workspace/filter/고정25 한도, 현재 effective capability·검토자 설정, SQL 데이터/권한 hash 및 시간 만료를 바인딩한다. 변경·위조·15분 경과·프로세스 재시작은 `STALE_CURSOR`409로 처음부터 재조회한다. cursor·owner lookup 상태는 브라우저 메모리에만 두며 본문/제목/검색어를 URL/storage에 넣지 않는다. SQL hash는 비공개 corpus를 애플리케이션으로 반환하지 않지만 공간 데이터 크기에 비례한 DB 비용과 보수적인 무관 변경 invalidation이 있다. 운영 규모 성능 인수는 별도다.

최종 리뷰 F2: template insert/CAS도 동일 트랜잭션·mutation gate의 기존 product-write fence를 먼저 적용한다. 완료 workspace receipt와 물리 purge 대기 blocked receipt는 새 제목/본문을 저장하지 않는다. provenance/current ACL 검사는 별도로 유지한다.
