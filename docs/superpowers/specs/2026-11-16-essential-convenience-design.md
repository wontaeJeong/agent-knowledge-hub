# 필수 편의기능 설계안

작성일: 2026-11-16 (Asia/Seoul). 상태: **후속 구현을 위한 설계 제안**. 이 문서의 추가 API·테이블·화면은 별도 표기가 없으면 아직 구현되지 않았다. 문서 병합은 제품 구현·운영 인수 완료를 뜻하지 않는다.

## 목적과 기준

사용자가 지식을 찾고, 읽고, 작성하고, 다시 방문하고, 필요한 검토를 처리하는 동선을 완성한다. Agent-native Ingest → Query → Lint → 재편입과 사람의 위키 사용 경험을 함께 유지한다. 편의기능은 기존 원본 접근 상한·발행 검토·계보·삭제 정책을 통과하는 동일한 서비스 경로를 사용한다.

확인 기준은 main `52188289e16201c8a5c424cd6152d430dc223771`과 PR #30의 통합 변경이다. `src/App.tsx`의 로컬 데모와 `src/operational/`의 인증된 운영 앱을 구분했다. 251개 기존 요구사항의 수·우선순위·수용 기준을 변경하지 않는다. 아래 `UXC-01`~`UXC-10`은 이 설계의 작업 식별자이며 기존 요구사항 수에 더하지 않는다.

참조: [North Star](../../LLM_WIKI_CORE.md), [현재 현황](../../CURRENT_STATUS.md), [요구사항 정비 기준](../../requirements/MAINTENANCE.md), [기준 요구사항](../../requirements/requirements.md), [PR 운영](../../PR_WORKFLOW.md).

## 범위와 현재 격차

| 작업 | 우선순위 | 현재 구현·연결 | 이번 설계의 결과 | 기존 기준 |
| --- | --- | --- | --- | --- |
| UXC-01 알림함 사용성 | 1차 | `NotificationPanel`, 구독·멘션, 개별 읽음, 검토 기한과 수신 설정 있음. 전역 벨·일괄 읽음·보관·필터 없음 | 전역 알림 진입, 미읽음 배지, 최근 5건, 전체/미읽음/보관, 유형 필터, 사건별 바로가기 | CLB-002/004~007, JOB-007, ACL-008 |
| UXC-02 개인 문서 목록 | 1차 | 즐겨찾기 변경 버튼과 `/workflows/favorites`, `/recent` API 있음. 운영 UI에 목록이 연결되지 않음 | 즐겨찾기·최근 방문·구독 목록과 현재 상태·고정 순서 | SRH-009, CLB-004, ACL-008 |
| UXC-03 전역 검색·빠른 열기 | 2차 | 발행 지식 검색과 `/questions/search` 고급 검색이 서로 다른 화면에 있음 | 항상 접근 가능한 검색, Ctrl/Cmd+K, 조건 통합, 키보드로 문서 열기 | SRH-001~005/007, UX-006 |
| UXC-04 새 문서 빠른 작성 | 2차 | 기존 문서의 개인 초안·자동 저장·복구·템플릿 있음. `submitDraft`는 pageId 없는 초안을 `SOURCE_REGISTRATION_REQUIRED`로 거절 | 새 문서·템플릿 → 개인 저장 → 원본/지식 검토 → 최초 발행의 실제 서버 경로 | EDT-001~003/006, REV-001~009, UX-002 |
| UXC-05 개인 홈·내 작업함 | 1차 | 운영 개요, 초안, 검토, 알림, 작업 이력이 별도 화면 | 최근·즐겨찾기, 내 초안, 내가 요청한 검토, 수정 요청, 담당 검토, 실패 작업을 이어 처리 | UX-001/003/004, REV-001/002, SRH-009 |
| UXC-06 문서 트리·경로 | 3차 | 상위 문서 선택·구조 저장·휴지통 복구 있음. 목록/선택 상자 중심 | 문서 트리·경로·하위 문서 생성·이동·복제·순서 지정 | EDT-004, SHR-001, ACL-006/008 |
| UXC-07 내부 링크·백링크 | 3차 | 도메인의 links와 PR #30 연결 집계 있음. 운영 편집 자동완성·백링크 탐색 부족 | `[[문서명]]` 자동완성, 안정 ID 링크, 백링크·관련 문서 | EDT-007, KNO-007/010, ACL-008 |
| UXC-08 읽기·부분 공유 도구 | 3차 | 정제 Markdown, 문서·댓글 링크와 버전 조회 있음 | 목차·본문 검색·검색 위치 이동·제목/문단 링크·코드 복사 | EDT-001/010, SHR-001~003, UX-005/006 |
| UXC-09 속성·일괄 정리 | 3차 | 문자열 JSON 속성 입력, 단일 문서 구조·수명주기 변경 있음 | 유형·태그·담당자·환경·검토일 폼, 여러 문서의 태그·이동·보관 미리보기/실행 | EDT-005/012, LIF-001~004, VER-004 |
| UXC-10 저장 검색·개인 보기 | 4차 | 조건 검색은 있으나 조건을 저장해 재사용하는 운영 경로 없음 | 개인 보기 저장·수정·삭제·정렬, 고유 URL 재열기 | SRH-002/009, UX-001/004, ACL-008 |

휴지통·버전 비교/복원·자동 저장/복구·접근 요청·계정 메뉴는 재구현하지 않는다. PR #30의 트렌딩·연결·인용 및 7/14/30/90일 통계도 재사용한다. 타인의 질문 인용 활동을 일반 사용자에게 넓혀 공개하지 않는다.

로컬 Markdown/Obsidian 호환 경로는 [LOCAL_WIKI](../../LOCAL_WIKI.md)를 유지한다. 기존 로컬 커넥터의 상시 daemon 제외 결정을 바꾸지 않는다. 본 편의기능 묶음은 오프라인 전체 편집·Obsidian의 모든 기능·플러그인 호환을 완료했다는 선언이 아니다. 저장·검색·탐색은 모델 없이 동작해야 한다.

## 접근 방식

| 대안 | 이점 | 비용·판단 |
| --- | --- | --- |
| 기존 화면에 버튼만 추가 | 변경량이 작음 | 기능 분산과 신규 문서 서버 경로의 공백이 남음 |
| **기존 서비스를 재사용하고 사용자 동선을 기능별로 연결** | ACL·발행·복구를 보존하면서 단계별 출시/검토 가능 | 공통 경로·개인 목록·문서 참조 계약을 먼저 맞춰야 함. 이 설계의 권고안 |
| 에디터·라우터·디자인 시스템 전체 교체 | 큰 자유도 | 이미 검증된 경로의 회귀 범위가 크며 이번 요구에 불필요 |

권고안은 작성자가 제안한 구현 선택이다. 사용자는 편의기능 전체의 설계·플랜 작성과 기존 PR 병합을 요청했으며, 후속 제품 코드 구현까지 완료됐다고 해석하지 않는다.

## 화면과 이동 계약

| 영역 | 기본 진입과 표시 |
| --- | --- |
| 상단 | 전역 검색, 새 문서, 알림 벨·미읽음 배지. 생성은 `draft.write`, 검토 요청은 `changeset.propose`로 각각 판단 |
| 기본 사이드바 | 홈, 지식 탐색(발행 지식/트렌딩), 내 문서(즐겨찾기/최근/구독/저장 보기), 내 작업, 자료 넣기 |
| 문서 | 트리·상위 경로, 제목·현재 상태, 읽기/편집, 속성, 관련 문서·백링크, 댓글·버전 |
| 내 작업 | 내 초안 / 내가 요청한 검토 / 수정 요청 / 담당 검토 / 실패 작업. 읽음 여부와 실제 업무 처리 상태는 별도 |
| 관리·운영 | 기존 capability에 맞는 항목만 별도 그룹. 운영 개요·사용량·정책·접근 관리의 기존 URL과 서버 권한은 보존 |
| 모바일 | 검색·새 문서·알림은 메뉴를 모두 펼치지 않아도 접근. 트리는 서랍으로 열고 닫은 뒤 문서에 초점 복귀 |

새 경로를 전면 도입하지 않고 기존 `/?app=1&space=...&document=...`, `#comment-...`, `#share-...`를 보존한다. `src/operational/convenience/route.ts`에서 개인 목록·검색·신규 초안·보기·버전/문단 대상을 해석한다. 새 query key는 `section`, `draft`, `view`, `version`, `anchor`, `targetKind`, `targetId`로 한정하며 ID·버전·조합을 검증한다. `section` 값은 `home|favorites|recent|subscriptions|search|compose|tasks|saved-views`다. 문서와 초안의 동시 지정 등 모순된 URL은 명시적 오류를 보인다. `#discovery` 등 기존 탭도 계속 연다. 정확한 업무 이동은 `section=tasks&targetKind=review|job|access-request&targetId=<id>`로 표현한다. kind/id는 함께 있어야 하며 선택한 공간의 현재 주체 권한으로 대상 상세를 다시 조회한다. 로그인 복귀 후에도 선택 ID를 jobs/governance/review 패널의 초기 선택 props로 전달한다. 대상 삭제/철회는 일반 오류로 표시하고 전체 탭만 열어 성공처럼 표시하지 않는다.

검색어·초안 본문·문서 제목을 URL이나 localStorage에 자동 저장하지 않는다. 저장 보기 URL은 개인 소유 `view` ID만 포함한다. 로그인 복귀는 `resumeWorkspaceLink`의 동일 출처 allowlist를 명시적으로 확장하며 전체 URL을 무조건 신뢰하지 않는다. 문서·공간·계정 전환은 기존 미저장 입력 경고·복구·요청 세대 격리를 유지한다.

## 공통 데이터·서비스 경계

- 기존 OIDC 세션/CSRF/현재 공간/`Context`와 `OperationalApi`를 사용한다. capability를 클라이언트의 역할 이름으로 추정하지 않는다. 메뉴 숨김이 서버 인가를 대체하지 않는다.
- 목록과 개수는 현재 열람 가능한 문서·원본·계보의 교집합만 포함한다. 제한 자료의 제목·스니펫·조상·개수·연결을 placeholder나 미리보기로 유출하지 않는다.
- 기본 페이지 크기 25, 빠른 열기 10, 최근 미리보기 5, 일괄 대상 최대 50. cursor는 주체·공간·필터·권한/데이터 revision에 바인딩한다. 제한 초과·조회 실패는 부분 결과/오류로 표시하고 실제 0건과 구분한다.
- 새로운 편의 API는 `server/convenience/`의 HTTP 어댑터와 기능별 서비스로 분리하고 `server/runtime/http.ts`에 연결한다. 기존 `/workflows/*`, `/collaboration/*`, `/questions/search`는 호환을 유지한다.
- 새 SQL migration 제안은 117~122이다. 구현 시 최신 번호를 다시 조회해 미사용 번호로 정하고, 기존 110 및 111~116을 수정/재사용하지 않는다. 백필은 bounded batch, 배포 전후 schema 검증·롤백/재시작 시험을 포함한다.
- 상태 변경은 mutationId·revision CAS·업무 감사 기록을 사용한다. HTTP 수락, 저장, 검토, 승인, 발행, 전달 확인을 각각 표시한다. 에이전트 API/MCP도 같은 변경 서비스를 호출한다.

## UXC-01: 알림함

기존 `workflow_notifications`와 `CollaborationService`를 확장한다. 새 알림 저장소나 메일 발송기를 병행 생성하지 않는다. 수신 설정·일/주 요약·조용한 시간과 기존 전달 이력은 유지한다.

알림 DTO는 `{id, sequence, type, createdAt, readAt, archivedAt, target, title, actionState}`다. `target`은 문서/댓글/검토/작업/접근 요청의 discriminated union이다. 타입은 `mention`, `document-updated`, `review-requested`, `review-decided`, `review-due`, `job-succeeded`, `job-failed`, `access-decided`다. 본문·대화·원본 오류·키는 알림에 복제하지 않는다. 표시 직전에 대상별 현재 인가를 검사하며 작업 알림은 작업 소유자/허용된 작업 권한을 확인한다.

| API (기존 prefix `/api/v1`) | 계약 |
| --- | --- |
| GET `/collaboration/inbox?state=all|unread|archived&type=...&limit=25&cursor=...` | items, nextCursor, unreadCount, readBoundary. `all`은 보관 제외. 전체 알림 수와 배지는 같은 가시성 규칙 적용 |
| POST `/collaboration/inbox/:id/state` | `{read?:boolean, archived?:boolean, expectedRevision, mutationId}`. 읽음/미읽음과 보관/복원을 독립 수정 |
| POST `/collaboration/inbox/read-all` | `{boundary, mutationId}`. 목록을 확인한 시점까지의 커밋된 알림만 읽음 처리 |

기존 page_id는 작업 알림을 위해 nullable로 확장하고 target type/id 및 이벤트 중복 키를 추가한다. 레거시 알림은 기존 ID를 중복 키로 백필한다. `collaboration_inbox_state(workspace_id, principal_id, next_sequence, revision)` 행을 잠근 트랜잭션에서 수신자별 순번을 배정한다. 전역 sequence의 MAX를 일괄 읽음 경계로 사용하지 않는다. 경계 토큰은 서버가 주체·공간·순번에 서명하며 그 뒤 커밋된 이벤트는 읽지 않음으로 남는다. 여러 수신자 잠금은 정렬된 ID 순서로 얻는다.

업무 트랜잭션과 이벤트 outbox를 함께 커밋하고 전달 worker가 `(workspace,recipient,eventKey)`로 중복을 막는다. 늦게 도착한 outbox 이벤트는 새 수신 순번을 받는다. 최초 완료·실패와 재시도 회차는 원인 이벤트 키로 구별한다. 읽음 처리는 검토 완료가 아니고 보관은 대상 업무를 취소하지 않는다.

보존은 서버 설정 기본 90일의 수신함 메타데이터 정책으로 제안하며 기존 원본/버전 보존이나 법정 삭제를 대신하지 않는다. 설정·정리 배치·삭제 fence와 통합하고 운영 정책이 다른 경우 배포 설정으로 명시한다. 활성 탭은 30초 간격과 재초점 시 갱신하며 숨긴 탭에서는 멈춘다. 라이브 갱신으로 현재 초점·스크롤을 이동시키지 않는다.

## UXC-02: 개인 문서 목록

즐겨찾기와 최근 목록은 기존 `WorkflowService.activity(ctx, kind)`를 페이지화해 사용한다. `GET /workflows/subscriptions`와 문서별 `{favorite,subscribed}` 상태 조회를 추가한다. 최근 방문은 실제로 문서를 연 경우만 기록하고 목록·검색 결과를 렌더링한 것만으로 방문 처리하지 않는다.

각 목록은 25건과 nextCursor를 반환한다. 즐겨찾기 순서는 사용자·공간별 revision CAS로 저장하고 모바일에서도 버튼으로 이동할 수 있게 한다. drag-and-drop만 제공하지 않는다. 권한이 철회되면 다음 응답부터 제목·미리보기를 제외하고 이미 열린 보호 상태도 기존 만료 처리에 따라 비운다. 즐겨찾기 저장은 권한 부여나 원본 복제를 뜻하지 않는다.

## UXC-03: 전역 검색과 빠른 열기

빠른 열기는 제목 우선 10건, 상세 검색은 기존 `/questions/search`를 사용하는 25건 결과다. 기본은 현재 권고 가능한 발행본이며 과거 버전은 사용자가 별도로 활성화한다. 의미 검색/모델 없이도 일반 키워드 검색은 동작한다. 고급 조건(유형·태그·담당자·환경·검토 상태·기간)을 하나의 DTO로 정규화한다.

검색은 200ms debounce, 이전 요청 취소/세대 무효화, 한글 IME 조합 완료 후 요청을 적용한다. Ctrl/Cmd+K, Escape, 위/아래, Enter, 초점 가두기·복귀와 스크린리더 combobox/listbox를 지원한다. Ctrl/Cmd+K는 브라우저/다른 대화상자의 입력을 무작정 가로채지 않는다.

결과에는 안전한 일치 구간·문서 유형·적용 환경·현재/과거·검토 시점을 표시한다. 제목 클릭은 동일한 문서 위치 계약을 사용하고 검색어를 저장 답변이나 LLM 프롬프트로 자동 전송하지 않는다. 오래된 cursor/권한 변경은 결과를 비우고 재검색을 안내한다.

## UXC-04: 새 문서 작성

`DocumentComposer`는 `mode: new|edit`, 제목, 대상 위치, Markdown, 미리보기, 저장 상태와 공유 범위를 표시한다. 템플릿 저장/선택은 기존 기능을 확장하며 회의·조사·설계·장애 분석·가이드 템플릿을 제공한다. 템플릿과 복제본은 원본 계보·접근 제한을 지우지 않는다.

`saveDraft`는 pageId 없는 본인 초안을 이미 수용하지만 `submitDraft`는 최초 문서 발행을 지원하지 않는다. 따라서 UI 버튼만 추가하지 않고 `WorkflowService.submitNewDraft(ctx,draftId,input)`와 POST `/workflows/drafts/:id/submit-new`를 추가한다. 입력은 `{expectedRevision,title,parentId,reason,disclosureId,disclosureHash,mutationId}`이고 본문·sourceIds·dependencyVersions는 서버가 저장된 초안에서 읽는다.

서버는 현재 초안 소유권과 `draft.write`/`changeset.propose`, 상위 위치, 유형 정책·필수 속성·원본 제한을 확인한다. 사람이 작성한 내용을 immutable 수동 원본 스냅샷으로 등록하고 같은 본문의 최초 변경 집합을 기존 `propose` → 검토 → `approve` → `publish` 경로로 제출한다. 모델 종합을 거치거나 즉시 발행하는 경로를 만들지 않는다. 기본은 개인 초안이다. 팀 공유로 범위를 넓히는 경우 기존 원본 공개 승인과 지식 발행 검토를 적용하며 화면에서 두 상태와 현재 대상 독자를 구분한다.

현재 `ImportService.requestDisclosure/approveDisclosure`는 import_run에 결합돼 있으므로 이 메서드를 새 초안에서 바로 호출할 수 있다고 가정하지 않는다. 새 `ManualDraftDisclosureService`가 기존 qualified-reviewer·정책/독자 검증 코어를 공통 helper로 추출해 사용하되, import API·run FK·기존 자료의 의미는 유지한다. `workflow_draft_disclosures`에는 draftId/ownerId/draftRevision/contentHash/dependencyEnvelope/parentId/policyHash/audience/reviewerId/policyMode/status/revision을 저장한다. 실제 import_run을 위조 생성하지 않는다.

원본 공개 요청은 POST `/workflows/drafts/:id/disclosure`의 `{expectedRevision,title,parentId,readers,reviewerId,reason,mutationId}`다. 서버가 현재 공간의 인간 독자를 확인하고 공간 정책으로 검토 모드를 결정한다. 팀 공유는 독립 qualified reviewer를 요구하고 `{id,hash,status:'pending'}`를 반환한다. 현재 서버가 확인한 owner-only 개인 공간은 readers가 정확히 본인뿐이어야 하고 reviewerId를 받지 않으며 `{id,hash,status:'pending-confirmation'}`를 반환한다. 본인의 명시적 확인은 기존 ImportService.personalOwner 정책을 재사용하고 독자를 늘리지 않는다. 클라이언트의 개인 모드 주장이나 역할 문자열로 이 예외를 선택할 수 없다. 본인이 입력한 수동 원본의 고정 스냅샷을 지정 검토자가 검토하도록 요청하는 행위와 최종 독자를 UI에서 명시적으로 확인한다. 템플릿/복제/기존 자료의 원본·의존 버전은 검토자와 모든 대상 독자가 이미 읽을 수 있어야 하며 이 절차로 확대하지 않는다. 검토자의 임시 검토 접근은 해당 고정 스냅샷에 한정하고 다른 개인 초안 열람권으로 확장하지 않는다.

GET `/workflows/draft-disclosures`는 본인 요청 또는 본인에게 배정된 요청만 반환한다. POST `/workflows/draft-disclosures/:id/decision`의 `{hash,decision:'approve'|'reject',reason,mutationId}`로 팀 공간에서는 지정 독립 검토자가, owner-only 개인 공간에서는 현재 소유자가 명시적으로 결정한다. 개인 문서는 기존 개인 발행 검토 정책을 유지하고 팀으로 옮겨 공유하려면 독립 공개 검토를 새로 받는다. 반려·대기 중에는 지식 변경 집합을 만들지 않는다. 승인 시에만 원본을 승인된 독자/정책으로 등록하고 `submit-new`가 같은 disclosureId/hash와 초안·독자·상위·정책 스냅샷을 재검사해 `{status:'knowledge-review-pending',sourceId,batchId,hash}`를 반환한다. 개인 저장에는 이 절차가 필요 없고 최초 발행 요청에는 그 공간 정책에 맞게 명시적으로 확인/승인된 disclosure가 필요하다. 화면 상태는 개인 저장 → 원본 공개 검토 대기/반려 → 원본 승인 → 지식 검토/수정 요청 → 발행이다. 팀 공유의 독립 승인과 기존 개인 공간의 소유자 확인을 구별하며 새 자동 승인 예외를 도입하지 않는다.

같은 mutationId는 같은 원본/변경 집합만 반환한다. 본문·기준·독자·상위 위치가 달라지면 재검토한다. 페이지 없는 초안의 복구는 본인 초안 ID·revision·현재 계보 권한에 바인딩한 새 recovery union으로 확장한다. 존재하지 않는 페이지 권한 검사를 생략하는 임시 우회를 만들지 않는다. 기존 1초 자동 저장·미전송 입력 보존·충돌 양쪽 보존·계정 전환 비우기를 유지한다.

## UXC-05: 개인 홈과 내 작업

`GET /convenience/home`은 위젯별 items/nextCursor/status를 반환한다. 문서 목록, 본인 초안, 본인 요청, 현재 검토 가능·담당 검토, 수정 요청, 본인 실패 작업을 기존 서비스의 현재 인가 경로로 조회한다. 관리자 공간 집계를 일반 사용자에게 내려 필터링하지 않는다. 조회 실패한 위젯은 재시도할 수 있고 다른 위젯까지 거짓 0건으로 바뀌지 않는다.

검토 수락/승인과 실제 발행을 구분하며 알림 읽음으로 업무를 완료하지 않는다. 카드의 동작은 정확한 초안·변경 집합·작업으로 이동한다. 담당 검토는 `changeset.approve`, 초안 작성은 `draft.write`를 각각 확인한다. 기존 운영 개요는 별도 탭으로 보존하며 신규 기본 홈을 사람의 위키 동선으로 바꾼다.

## UXC-06: 문서 구조

`GET /convenience/tree?parentId=...&cursor=...`와 `GET /convenience/pages/:id/path`는 현재 열람 가능한 노드/경로만 반환한다. 비공개 조상 이름·숨겨진 자식 개수는 반환하지 않는다. 조상이 보이지 않으면 노출 가능한 시작점에서 경로를 시작한다. 트리의 제목은 정본 문서에서 읽는다.

이동/정렬은 `DocumentStructureService.move(ctx,{pageId,parentId,beforeId,expectedRevision,mutationId,reason})`를 사용한다. 같은 공간 내 안정 ID를 유지하며 순환·자기 부모·휴지통 부모·없는 이웃·기준 변경·원본/상위 ACL 확대를 거절한다. 삭제/복구/보존 fence를 통과한다. API/MCP도 이 서비스를 사용한다. 다른 공간 이동은 기존 자료 반출/공유 계약을 따르는 별도 경로이며 이 기능이 암묵적으로 제공하지 않는다.

복제는 새 개인 초안으로 생성하고 원본 버전·sourceIds·dependencyVersions를 유지한다. 하위 문서 생성은 UXC-04를 parentId와 함께 연다. drag 동작에 상응하는 키보드 이동 메뉴를 제공하고 문서 이름 변경·이동 이후 기존 링크는 동일 ID로 열린다.

## UXC-07: 문서 연결

문서 연결은 제목 대신 pageId를 정본 키로 사용한다. Markdown의 `[[제목]]`/표시 이름 입력은 현재 접근 가능한 후보를 제시하고 동명 문서는 사용자가 선택한다. 원문 본문은 Markdown으로 유지하면서 구조화된 참조 `{targetPageId,label,sourceBlockId}`를 버전 메타데이터에 보존한다. 텍스트만 입력한 미해결 링크는 미해결로 표시하고 숨겨진 문서의 존재 여부를 응답하지 않는다.

`GET /convenience/pages/:id/backlinks`는 현재 읽을 수 있는 발행 출발점과 대상 양쪽을 검사한다. 초안의 링크는 검색·백링크·PR #30 순위에 포함하지 않는다. 링크 파생 테이블은 발행 트랜잭션/outbox로 갱신하고 재구축 가능하게 한다. 권한/원본 철회·삭제 시 색인 갱신을 기다리지 않고 최종 읽기를 차단한다. 문서 병합은 기존 이동 대상/원본 버전 안내 계약을 유지한다.

## UXC-08: 문서 읽기와 부분 링크

공통 `DocumentReader`는 기존 marked + DOMPurify를 유지하고 안전한 노드 렌더링으로 목차·코드 복사·검색 강조를 추가한다. HTML 삽입으로 검색 결과를 합성하지 않는다. Markdown 내 코드/표/한글과 반복 제목을 포함해 검색 위치로 이동하고 다음/이전·검색 결과 수를 제공한다. 현재 권고/과거 고정 버전·검토 시점·공식성은 독립 표시한다.

제목/문단은 발행 버전 메타데이터의 안정 blockId를 사용한다. 같은 이름의 제목을 위치 하나로 합치지 않는다. 최신 링크와 `version` 고정 링크를 구분하고 `anchor`를 검증한다. 대상 삭제/문단 변경 시 ‘위치가 변경되었거나 사라짐’을 표시하고 다른 문단으로 조용히 이동하지 않는다. 고정 버전도 현재 원본/문서 권한·삭제 정책을 적용한다. 복사 실패는 성공 토스트를 띄우지 않고 선택 가능한 링크/코드 대안을 제공한다.

## UXC-09: 속성 폼과 일괄 작업

속성 정본은 기존 문서·governance/version 메타데이터다. 유형·태그·업무 담당자·대체 담당자·적용 환경·검토일·요약을 스키마화한 폼을 제공한다. 고급 JSON은 선택 기능으로 남기고 필수 속성 정책을 입력 단계와 발행 단계 모두 검사한다. 담당자 지정이 ACL이나 reviewer 자격을 부여하지 않는다. 본문·제목·태그 등 발행 메타데이터 변경은 검토되는 새 버전으로 반영하며 즉시 구조/수명주기 변경과 구별한다.

기존 `POST /workflows/bulk/preview`의 `{pageIds,operation,reason}` 계약을 유지한다. operation은 `{kind:'tags',tags}|{kind:'move',parentId}|{kind:'archive'}`이며 서버가 대상 revision과 정규화 patch를 계산한다. 최대 50건, 서버 정규화 대상·변경 전후·인가 결과·10분 만료 previewToken을 반환한다. 접근 불가 대상에는 제목/본문을 포함하지 않는다.

`POST /workflows/bulk/apply`의 기존 입력 별명을 보존하며 `{previewToken,mutationId}`를 호환 추가해 durable 작업을 접수한다. 새 `GET /workflows/bulk/:id`로 항목별 `pending|applied|needs-review|denied|stale|failed`와 안전한 사유를 조회한다. 항목별 현재 정책·revision을 재검사하고 전체 성공으로 덮지 않는다. 태그 변경은 검토 제안을 생성하며 이동/보관은 해당 기존 capability와 감사 경로를 사용한다. 네트워크 재시도·worker 재시작 후 적용된 항목을 중복 수행하지 않는다. 영구 삭제·ACL 확대는 일괄 메뉴에 포함하지 않는다.

## UXC-10: 저장 보기

`SavedViewService`는 `{id,ownerId,workspaceId,name,filters,sort,revision}`를 저장한다. name 최대 100자, 개인·공간당 최대 100개, 필터는 UXC-03의 허용 schema만 수용한다. 기본 보기 예시는 내 담당 문서·최근 변경·검토 기한 경과다. 샘플은 실제 결과로 오인되지 않게 최초 선택 후 실행한다.

GET/POST `/convenience/views`, PATCH/DELETE `/convenience/views/:id`로 본인만 관리한다. 수정·정렬·삭제는 revision CAS를 사용하고 URL은 정의 ID만 가진다. 저장 당시는 접근할 수 있어도 실행 시 현재 권한을 다시 검사한다. 결과 제목·개수·권한을 캐시하지 않는다. 다른 계정의 동일 URL은 정의를 읽을 수 없다. 기본값은 비공개이며 팀 공유 보기를 개인 저장만으로 생성하지 않는다.

## 동시에 진행된 PR의 재사용 경계

작성 중 main에 [전체 로드맵 계획 PR #44](https://github.com/wontaeJeong/agent-knowledge-hub/pull/44)가 반영되고 다음 구현 PR이 추가됐다. 아래는 해당 head의 소스 확인이며 병합/최종 인수 상태는 실행 시 다시 확인한다. 본 설계는 그 계획을 대체하지 않는 사용자 편의 보완이다.

| PR | 이번 설계에서 재사용할 코드 | 남은 설계 작업 |
| --- | --- | --- |
| #45 일괄 편집 | `server/workflows/bulk.ts`, `BulkEditor.tsx`, 최대 50건/10분 preview·항목별 CAS/부분 결과 | UXC-09의 속성 폼·정본 속성/발행 버전 연결·영속 재시작/중복 방지. 50건/10분 계약을 유지하고 별도 100건/5분 API를 만들지 않음 |
| #46 검색 경로 통합 | 에이전트/쿠키 MCP와 ScopedSearch의 현재/과거·scope·cursor 검사 | UXC-03의 전역 사람용 검색·quick-open·필터 UI·IME/키보드. 공통 검색을 다시 구현하지 않음 |
| #47 문서 탐색 | `document-navigation.tsx`의 DocumentBody/PersonalDocuments/RelatedDocuments/LinkCompletion과 workflow navigation/link search | UXC-02의 구독 목록·페이지화/정렬, UXC-07의 안정 참조/발행 인덱스·페이지화, UXC-08의 버전 고정 안정 문단/코드 복사. 기존 목차·본문 검색·백링크를 재개발하지 않음 |

## 인수 기준과 검증

다음은 **예정된 인수 기준**이며 현재 통과 결과가 아니다. 각 작업은 연결된 기존 기준의 나머지 수용 조건도 유지한다.

| 작업 | 완료를 판단할 실제 행동 |
| --- | --- |
| UXC-01 | 어느 화면에서나 알림 확인·정확한 대상 이동. 일괄 읽음 직후 새 커밋 알림은 미읽음. 중복 이벤트·여러 탭·권한 철회·보관/복원 시험 |
| UXC-02 | 즐겨찾기 추가 후 목록에 보이고 해제/정렬·재방문이 동작. 철회 자료는 제목까지 사라지고 계정별 목록 분리 |
| UXC-03 | 한글 조합·코드 식별자 검색, 키보드만으로 열기/닫기, 늦은 이전 응답 차단. 과거 검색과 현재 권고의 표시 구분 |
| UXC-04 | owner-only 개인 공간과 팀 공간 각각 빈 초안부터 모델 없이 최초 문서 발행까지 수행. 개인 저장은 검색에 안 나오고 공유·발행 검토를 거침. 이중 제출/재연결/초안 계보 철회 회귀 |
| UXC-05 | 자신의 초안·요청·담당 검토·실패 작업만 표시하고 정확한 이어가기. 한 위젯 실패 시 나머지 유지. 읽음과 업무 완료 분리 |
| UXC-06 | 3단계 경로·자식 탐색, 이동 후 옛 링크 열기. 순환·ACL 확대·보존/삭제 경합 거절. 키보드 이동과 모바일 초점 확인 |
| UXC-07 | 동명 문서 선택, 이름 변경 후 링크 유지, 초안 링크 미노출. 출발점/대상/원본 중 하나를 철회하면 백링크·카운트 숨김 |
| UXC-08 | 반복 제목·코드·표·한글 검색과 정확한 위치 이동. 문단 삭제 안내·고정 버전·Clipboard 거부·XSS 회귀 |
| UXC-09 | JSON 없이 속성 편집·필수 정책 안내. 50건 미리보기→부분 성공/검토 필요/실패를 구분하고 재시도 중복 없음 |
| UXC-10 | 저장 조건을 재로그인 후 재실행하고 조건 수정 충돌 안내. 다른 사용자와 철회된 자료 노출 없음 |

공통 검증은 기존 `npm run check`, 필요한 DB 파일의 `scripts/test-server.mjs`, 실제 1440px/390px·라이트/다크·키보드·한글 IME 화면 캡처를 포함한다. 서버의 실사용 자료/IdP·3만 사용자 부하·의미 품질·운영 배포는 별도 인수이며 이 설계의 단위/합성 시험으로 대체하지 않는다.

## 위험·도입과 완료 상태

- 가장 큰 위험은 알림/개인 목록/백링크의 측면 정보 노출, 최초 문서의 원본/독자 계보, 이동·일괄 변경과 삭제/권한 경합, 복구한 입력의 타 계정 노출이다. 각 구현 PR의 차단 회귀에 포함한다.
- 서버·schema를 먼저 호환 추가한 뒤 해당 UI를 연결한다. 준비되지 않은 API는 성공 목업으로 대체하지 않는다. 배포 롤백은 UI 진입을 되돌리고 기존 경로를 보존하며 원본·버전·감사 데이터를 삭제하지 않는다.
- 날짜를 고정한 완료 일정이나 효과 수치는 약속하지 않는다. 1차(01/02/05) → 2차(03/04) → 3차(06/07/08/09) → 4차(10)의 순서와 의존성은 [구현 플랜](../plans/2026-11-16-essential-convenience.md)에 있다.
- 작성·검토 완료와 제품 구현 완료를 분리한다. 현재 본 문서의 추가 경로는 계획이며 기존 구현 상태를 승격하지 않는다.
