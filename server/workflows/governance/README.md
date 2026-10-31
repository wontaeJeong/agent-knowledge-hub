# 문서 운영 계약 (Task C)

대상: GOV-005, EDT-005, ACL-011, CLB-003. Ingest → 검토 → 발행 → 재검토 순환에서 책임·필수 속성·권한 상한·독립 검토를 유지한다. 담당자 지정과 승인 자격/권한 부여는 별개다. 모델 품질이나 업무 효과를 입증하는 변경은 아니다.

## 호스트 연결

- `new GovernanceService(pool, mandatoryAuthorizer)`와 `handleGovernanceRoute(input, service)`를 인증·CSRF·선택 공간 검증 뒤에 연결한다. `Context`는 호스트에서만 생성한다. 주입 authorizer는 canonical 권한을 좁힐 수 있지만 대체하지 못한다.
- 호스트 공용 오류 매핑에 `governanceErrorStatuses` (`PROPERTY_REQUIRED:409`)를 합친다. 알려지지 않은 DB/정책 오류는 성공한 빈 목록으로 숨기지 않는다.
- `GovernanceWorkbench` (`src/operational/governance.tsx`)에 기존 인증/CSRF API 함수를 제공한다. 경로는 `/api/v1/governance/...` 전체 경로다. `capabilities`, `onChanged`, `onExpired`를 연결하고 사용자/공간 변경 시 보호된 기존 화면을 폐기한다. 기존 `OperationalApi.request` 어댑터는 `/api/v1` 접두사를 한 번만 적용해야 한다.
- 발행 경계는 **이미** `server/publication.ts`에 연결되어 있다. `permissions`에서 현재 `workflow_document_state.data.properties`, 현재 유형(새 문서는 `연결된 지식`), 담당자 레코드와 정책 revision을 검사한다. 승인·발행에서 block 누락은 `PROPERTY_REQUIRED`; warn은 제안·승인·발행 응답의 선택적 `warnings`와 batch의 `reviewWarnings`에 남는다. 빈 warnings는 기존 DTO를 변경하지 않는다. 경고는 콘텐츠 해시에 넣지 않고 정책/메타데이터는 ACL fingerprint에 넣는다.
- 작업함과 검토함의 `propertyWarnings`는 현재 정책을 다시 계산하여 UI에 실제 누락 키·경고/차단을 표시한다. 기존 runtime HTTP 승인 경로는 core 승인 반환값을 현재 버리므로, coordinator는 `await service.core.approve(...)`의 선택적 warnings를 기존 `{id,hash}` 응답에 병합해야 한다. (`server/runtime/http.ts` 승인 분기.) 새 작업함 외 기존 발행 화면도 같은 경고를 표시하도록 연결한다.
- `dueReviewWork(db, ctx, now)`는 현재 권한으로 필터한 `{pageId,version,ownerId,backupId,dueAt}[]`를 제공한다. 유형 주기와 명시 검토일을 소비하며 문서가 거짓이라는 상태로 바꾸지 않는다. Task F는 수신자의 현재 원본/문서 권한·부재·활성 상태를 실제 전송 직전에 다시 확인해야 한다.
- `handoffInbox(ctx)`는 현재 비활성/멤버십·접근 상실 담당자를 검사해 중복 없는 영속 인계 작업을 생성한다. HTTP 호출 때뿐 아니라 운영 호스트의 주기 작업에서 현재 자격이 있는 인간 관리자 Context로 호출할 수 있다. **스케줄 연결 자체는 이 패키지에서 하지 않는다.**
- migration102는 확정했다. 이전 migration은 수정하지 않았다. 기존 `workflow_access_requests`에 page 기본값과 revision/결정 메타데이터를 추가하므로 기존 requestAccess 경로의 요청도 처리한다.

## HTTP

모든 변경 DTO는 strict다. body의 principalId/workspaceId/권한/context를 허용하지 않는다.

| Method | `/api/v1/governance` 아래 경로 | 동작 |
|---|---|---|
| GET | `/workbench` | 현재 보이는 문서·명시 담당자·관리 가능한 제안·유형 정책 |
| GET | `/pages/:id/eligible-owners`, `/pages/:id/history` | 실제 현재 인간 후보 / 접근 가능한 문서 결정 이력 |
| POST | `/pages/:id/owner` | `{expectedRevision,ownerId,backupId,reason}` |
| POST | `/type-policy` | `{expectedRevision,documentType,requiredKeys,mode?='warn',cadenceDays?=null,reason}` |
| GET | `/handoffs`, `/access-inbox`, `/review-inbox` | 인계 / 관리자 요청 결정함 / 현재 자격·접근을 가진 검토함 |
| POST | `/access-requests` | `{resourceId,resourceType?='page',reason}` → 존재 여부와 무관한 `{accepted:true}` |
| POST | `/access-requests/:id/decision` | `{expectedRevision,expectedVersion,decision:'approve'|'reject',reason}` |
| GET | `/changesets/:id/eligible-reviewers`, `/changesets/:id/history` | proposer와 다른 실제 현재 지정 인간 검토자 / 배정 이유·개정 이력 |
| POST | `/changesets/:id/assignment` | `{expectedRevision,assigneeIds,backupId,deadline,absentIds,reason}` |

접근 승인은 **기존 공간 읽기 역할과 현재 활성 팀 멤버십을 이미 가진 인간**에게만 정확한 현재 페이지 버전을 확인한 후 page raw ACL을 추가한다. 전체 현재/보존 provenance, 모든 원본, 의존 문서 및 조상 상한을 검사한다. 원본·조상·공간 역할을 자동 부여하지 않는다. 승인은 정책 epoch를 올리고 기존 승인을 무효화하며 버전/정책/결정 이유를 동일 트랜잭션 이력에 남긴다. 공간 권한 이관 요청은 별도 정책이 필요하므로 이 API에서 `resourceType:'space'`를 허용하지 않는다.

## 검증과 남은 통합

- 테스트는 실제 PostgreSQL fixture와 canonical access를 사용한다. 감사 저장 실패 후 page ACL과 요청 결정이 함께 롤백되는 회귀, 숨은 문서·개인 import 제안 식별자 비노출, 담당자 비활성 인계, 원본 상한, 배정 변경 승인 무효화, 발행 필수 속성 및 기본 유형을 포함한다.
- UI의 서버 렌더링 회귀는 로딩/관리자 컨트롤 분리/25건 페이지 분할/오류 문구를 확인한다. 실제 390px·1440px 상호작용/키보드 및 운영 HTTP 호스트 통합은 coordinator 연결 후 별도로 검증해야 한다. 단독 모듈/SSR 테스트를 Task C 전체 완료라고 보고하지 않는다.
- 독립 메타데이터 버전 스냅샷은 Task D다. 현재 검사는 실제 mutable workflow 속성을 사용하며 과거 버전의 속성을 복원했다고 주장하지 않는다.
