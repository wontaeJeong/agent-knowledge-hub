# Task E 구현·연결 경계

대상: EDT-002, VER-012. **이 패키지만으로 두 요구사항 전체 수용 완료가 아니다.**

## 실제 제공

- `WorkflowService.saveDraft`: 기존 수동 저장과 같은 revision CAS. 선택적 UUID `mutationId`는 요청 해시와 결과를 함께 기록한다. 응답 유실 재시도는 같은 결과를 돌려주며 뒤의 승자를 덮어쓰지 않는다. 초안 이력·원본·의존 페이지 상한을 유지하고 클라이언트의 라벨 제거로 계보를 제거하지 않는다. 기존 발행/선택 revision commitGuard·원본 정정·상위 문서 분리 코드는 대체하지 않는다.
- `DraftRecoveryService.permission(ctx, metadata)` / `validate(ctx,{binding})`: 반드시 정본 `authorizeInTransaction`의 `local.copy`와 전체 페이지/원본 이력, 명시적 원본 플래그를 확인한다. `data.export`는 로컬 작업 복구에 추가 요구하지 않는다. 사용자/공간은 서버 Context에서 확인한다. 역할·권한을 담은 JWT가 아닌 해시 nonce 기반 복구 바인딩만 발급한다. 5분 만료이며 재수화는 현재 신원·ACL·정책·계보와 서버 revision을 재확인한다.
- `RecoveryCache`: 허용된 본문만 개인 평문 캐시로 보관. 항목 128KiB, 총 512KiB, 10건, 최대 5분. 로그인 토큰/CSRF/키/역할은 기록하지 않는다. 캐시의 내용·라벨은 서버 권한이 아니다. 온라인 재검사 실패/만료 시 삭제하고 화면에 반환하지 않는다. 만료된 허용으로 새 로컬 쓰기를 하지 않는다.
- `DraftAutosave`: 한 번에 한 CAS, 입력 후 최대 1초 내 시도, blur/online 시 재시도, 명시적 충돌 해결 후 새 CAS. 저장 대기/진행/확인/오프라인/충돌/실패를 구분한다. 닫기 전 전송은 최선의 시도일 뿐 보장하지 않는다. 연결 해제 후 daemon/OS 서비스는 없다.
- `ContentRetentionService`: 유형별 기간(빈 값은 영구), 기본 자동 삭제 비활성. `previewRetention`, `executeRetention`, `retentionTick`, `setPolicy`, `setHold`, `receipts`. 실제 제품/가져오기/질문/버전/협업/정련 참조와 공통 CAS 저장 그래프를 읽고 오류 시 닫힌다. 미리보기 해시+정책 revision을 다시 검사한다. 현재 실제 삭제 대상은 **참조되지 않는 만료 개인 초안과 해당 초안의 복구/중복방지/이력 복사본**이다. 삭제·원장 tombstone·완료 영수증은 같은 트랜잭션이며 실패는 롤백 후 실패 영수증으로 남긴다.
- `operations_erased_artifacts`의 비본문 `draft` retirement 기록은 기존 독립 서명 복구 원장에 자동 포함된다. 복원된 오래된 행도 일반 초안 읽기/쓰기/복구 경로에서 차단된다. `replayRetentionTombstones`는 복원 격리 해제 전에 오래된 평문 복사본을 제거하기 위한 호스트 연결점이다.
- 평문을 가진 새 테이블은 `workflow_` 접두사를 사용하여 기존 별도 승인 법정 삭제 그래프/권한 있는 삭제 함수의 실제 대상에 포함된다. 일반 보존 서비스는 법정 삭제나 전체 공간 삭제를 호출하지 않는다. 정련의 append-only 기록도 일반 보존에서 삭제하지 않는다.

## 호스트가 연결해야 하는 정확한 지점

`handleRetentionRoute(input,{recovery,retention})`를 인증·현재 신원·CSRF·선택 공간·본문 크기 검증 **후** 기존 라우트 체인에 연결한다. 실제 런타임 HTTP 테스트는 `createRuntimeHandler({operations: input => handleRetentionRoute(...)})` 확장점으로 연결하여 실행한다. 운영 `main.ts`/HTTP 디스패처는 이 작업의 소유 범위 밖이라 수정하지 않았다.

| Method     | `/api/v1` 이후 경로              | 함수                             |
| ---------- | -------------------------------- | -------------------------------- |
| POST       | `/workflows/recovery/permission` | `recovery.permission`            |
| POST       | `/workflows/recovery/validate`   | `recovery.validate`              |
| GET / POST | `/retention/policy`              | `retention.policy` / `setPolicy` |
| POST       | `/retention/holds`               | `retention.setHold`              |
| POST       | `/retention/preview`             | `retention.previewRetention`     |
| POST       | `/retention/execute`             | `retention.executeRetention`     |
| GET        | `/retention/receipts`            | `retention.receipts`             |

기존 `/workflows/drafts` 저장 경로는 그대로 사용하며 `mutationId`만 선택적으로 추가한다. `WorkflowPanel`의 기존 `api`, `principalId`, `spaceId`, `capabilities` props가 실제 인증 신원/공간을 전달해야 한다. 정상 편집 폼에 자동 저장/복구/충돌 UI를 연결했다. `space.admin`일 때 같은 패널 안에 `RetentionPanel`을 표시한다. 대상·참조·영수증은 각각 25건씩 탐색한다.

기존 서버 coordinator가 `retentionTick(workspaceId)`를 호출해야 한다. 생성자의 `workerGuard(db,workspaceId)`는 현재 디렉터리/서비스 담당·호스트 정책을 확인해야 하며 `serviceName`은 인증된 사용자 대신 가장한 관리자 계정이 아닌 명시적 서버 서비스 이름이다. 두 설정이 없으면 실행을 거부한다. 정책이 비활성이면 자동 삭제하지 않는다. 새 daemon/OS 서비스는 추가하지 않는다.

## 남은 소프트웨어·검증 조건

1. 발행 버전/원본 버전/실행 결과의 기간·실제 개수·보존 참조는 표시하지만 불변 이력의 의존성 안전 가지치기는 미구현이다. `IMMUTABLE_HISTORY_REQUIRES_REVIEWED_PRUNING`으로 차단하며 설정만으로 삭제됐다고 표시하지 않는다. VER-012 전체 미완료다. 원본별 독립 보존 기간 필드도 추가하지 않았다.
2. 운영 라우트·현재 서비스/디렉터리 guard가 있는 주기 coordinator·복원 승격 전 replay 연결은 통합 담당자의 작업이다. 격리 해제 전 replay 없이 물리적 평문 제거 완료를 주장할 수 없다.
3. 유형별 법적 보존은 기존 서명 원장에 workspace hold mirror로도 남긴다. 일반 보존은 유형을 구분하지만 기존 법정 삭제/CAS 보호는 이를 더 보수적으로 공간 전체 보존으로 취급할 수 있다. 별도 해제 근거 없이 이를 우회하지 않는다.
4. 실제 Chromium 390px/1440px·한국어 IME/키보드·브라우저 프로세스 재시작 인수는 아직 실행하지 않았다. 브라우저 캐시 인스턴스 재생성과 실제 OIDC/HTTP/DB 재접속 시험을 실제 브라우저 인수로 올리지 않는다.
5. 한 preview의 제품 행은 최대 10,000건, 공통 CAS 그래프는 기존 100,000건 한도이며 초과/SQL 오류 시 실패한다. 더 큰 공간의 점진적 그래프 처리와 정책별 작업 분할은 남아 있다.
6. 사용자가 이전에 파일로 내보낸 사본, 브라우저 자체 백업/물리 저장 장치의 완전 삭제는 보장하지 않는다. 5분 허용은 오프라인 권한을 영구 보증하거나 과거 복사본의 즉시 회수를 보증하지 않는다.

## 평가·North Star

검토 가능한 변경 후보와 계보를 장애/권한 철회 뒤에도 안전하게 유지하여 Ingest → 검토 → 발행 순환의 불변식 5·6·8을 보강한다. 기존 발행 지식을 변경하거나 효과 향상을 주장하지 않는다. 근거 없는 TTL 삭제보다 보존/차단과 미구현을 표시하는 대안을 택했다. 품질/후속 에이전트 성능은 평가 계약의 대조 실험 전까지 목표다.

검증 파일: `server/retention/{recovery,retention,http}.test.ts`, `src/operational/draft-recovery.test.ts`, 기존 `server/workflows/workflows.test.ts` 및 `server/access/access.test.ts`. 실제 런타임 HTTP 시험은 OIDC userinfo fixture·DB 세션·CSRF를 거쳐 commit 후 응답 유실/다른 탭 승자/재접속 CAS/명시 병합, 로컬 복사 금지 0건 저장, 재시작 캐시의 신원/원본 철회 차단을 확인한다. 가짜 시계로 만료와 보존 기간을 확인하고, DB 삭제 실패 rollback 및 기존 법정 삭제가 새 평문 복사본을 찾는 것도 시험한다.
