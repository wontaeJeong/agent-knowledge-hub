# 1차 릴리즈 기반: PostgreSQL 발행 서비스 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1차 실사용 릴리즈를 위한 서버 영속 모델과 원자적 변경 집합 발행을 실제 PostgreSQL에서 검증한다.

**Architecture:** 기존 UI/로컬 데모를 유지하면서 `server/`에 공통 서비스와 PostgreSQL 저장소를 추가한다. 페이지·버전·원본·변경 집합·승인·발행 영수증·감사·권한을 분리하고 workspace 행 잠금으로 변경을 직렬화한다. HTTP/SSO/MCP와 UI 연결은 후속 단위이며, 인증 어댑터가 확인한 주체만 호출하는 내부 서비스다.

**Tech Stack:** 기존 TypeScript/Vitest, PostgreSQL, node-postgres(`pg`). DB 통합 시험은 Docker PostgreSQL에서 실행한다.

**Spec:** `docs/K8S_RELEASE.md` §4, ADR 003, `docs/SECURITY.md`, `docs/API_CONTRACT.md`, `docs/LLM_WIKI_CORE.md` 불변식 1~8. 사용자가 서버 저장소·원자 발행부터 구현하고 PR까지 진행하도록 승인했다.

## Global Constraints

- 1차 릴리즈 목표: 단일 클러스터, STG/PROD 분리, 환경별 App 1/PostgreSQL 1. 이번 PR은 그 일부이지 릴리즈 완료가 아니다.
- 기존 251개 요구사항/35개 인수 시험 계획과 데모 행동을 보존한다.
- 원본 본문 불변, 승인 대상 고정, 기준 변경 시 재검토, 발행 직전 권한 검사, 재시도 중복 방지.
- 브라우저 `role`과 요청 데이터는 인증/권한 근거가 아니다. 서비스는 DB membership와 resource reader 집합을 사용한다.
- 서비스는 내부 호출만 제공한다. SSO·그룹 동기화·HTTP·MCP·작업·백업·배포 완료를 주장하지 않는다.
- UI 변경 시 변경 화면/상태를 1440px/390px에서 캡처하여 PR에 첨부한다. UI 변경이 없으면 PR에 명시한다.

## Review Focus

- 같은 발행의 동시 호출/재시작 후 재호출: 버전·감사·영수증 하나만 생성.
- 승인 후 원본/본문/규칙/기준/권한 변경: 전체 발행 차단.
- 다중 원본 권한: 기존 페이지의 독자가 원본 교집합을 초과하면 차단, 새 페이지는 교집합만 허용.
- 관계·과거 버전·근거: 현재 권한 없으면 존재/본문을 노출하지 않음.
- 트랜잭션 중 DB 오류: 페이지 일부·승인·감사·멱등 기록이 남지 않음.

## Task 1: 영속 모델과 마이그레이션

**Files:** `server/migrations/001-knowledge.sql`, `server/database.ts`, `server/database.test.ts`, `server/test-support.ts`, `compose.test.yaml`, `tsconfig.server.json`, `package.json`/lock.

**Interfaces:** `migrate(pool: Pool): Promise<void>`, `transaction<T>(pool, workspaceId, operation): Promise<T>`. 풀은 호출자가 소유한다. migration은 명시 실행하며 app 기동에 묶지 않는다.

- [x] RED: 실제 DB에서 반복 migration과 rollback, 이후 도메인 시험에서 원본/버전 제약 검증.
- [x] GREEN: workspace, membership, resource ACL, sources, pages, versions, batches, approvals, publications, requests, audit 테이블과 migration checksum/잠금 구현.
- [x] `npm run test:server` 통과 후 커밋.

## Task 2: 서버 권한·원본·조회

**Files:** `server/repository.ts`, `server/service.ts`, `server/service.test.ts`.

**Interfaces:** `KnowledgeService(pool)`; 모든 메서드는 `Context {workspaceId, principalId}`를 받는다. `registerSource(ctx, source, readers)`, `readPage(ctx, id, version?)`를 제공한다. membership 역할은 `reader|editor|reviewer`; reader 집합은 서버 DB에 저장한 명시적 사용자 ID 집합이다.

- [x] RED: 다른 workspace/미등록 주체 접근 거부, 원본 덮어쓰기 거부, 과거 버전의 현재 원본 권한 검사.
- [x] GREEN: DB membership/ACL 검사, 원본 등록, 현재/고정 버전 조회 구현. 원본 독자는 workspace 구성원만 허용한다. 원본·페이지별 allowlist는 초기 계약이며 조직 그룹/상속/철회 전파는 후속이다.
- [x] `npm run test:server` 통과 후 커밋.

## Task 3: 변경 제안·승인·원자 발행

**Files:** `server/service.ts`, `server/repository.ts`, `server/service.test.ts`.

**Interfaces:** `propose(ctx, updates: Draft[], sourceIds: string[]): Promise<{id, hash}>`, `approve(ctx, id, hash): Promise<void>`, `publish(ctx, id, hash, idempotencyKey): Promise<{batchId, versions}>`. hash는 SHA-256 승인 내용 식별자다. 기존 `createBatch/enqueueBatch/decideBatch` 검사를 재사용하되 신원/감사/권한은 서버가 결정한다.

- [x] RED: 주제+개념 일괄 발행, 승인 내용/기준/원본 변경 거부, 비검토자 거부, source reader 교집합 및 관계 권한, 동시 발행/재시작 후 replay, 키 재사용 충돌, SQL 실패 rollback.
- [x] GREEN: workspace 잠금 아래 정본 로드 → 권한 재확인 → 도메인 검사 → 모든 페이지/버전/근거·감사·영수증 commit. 변경 집합 hash/승인/멱등 요청을 DB에 보존한다. 현재 권한 검사는 replay에도 적용한다.
- [x] `npm run test:server` 통과 후 커밋.

## Task 4: 문서·검증·리뷰·PR

**Files:** `docs/SERVER_FOUNDATION.md`, `docs/AGENT_HANDOFF.md`, `docs/ARCHITECTURE.md`, README, 본 계획.

- [x] 실제 실행법·연결 경계·DB 직렬화 한계·후속 릴리즈 게이트와 요구사항 CORE-002~004/ACL-001~005/REV-004~006/VER-005/SEC-009/OPS-004를 기록한다. 전체 요구사항 완료 상태는 올리지 않는다.
- [x] `npm test`, `npm run test:server`, `npm run check:requirements`, `npm run build`, `npm run check:server`, `git diff --check` 실행.
- [x] 독립 전체 변경 리뷰 후 중요 지적은 RED→GREEN으로 수정한다.
- [ ] UI diff 확인. UI 변경 시 캡처, 미변경 시 PR에 명시. 검증 결과를 포함해 커밋/푸시/PR 생성. 사용자 승인 전 병합하지 않는다.

## 추가 승인 범위: 사용 기록과 사용량 대시보드

사용자가 구현 중 추가 요청했다. Task 3 후 `server/usage.ts`와 시험을 추가해 각 서비스 호출의 주체·작업·성공/실패·시간·소요시간을 DB에 보존한다. 본문/질문/토큰/비밀은 수집하지 않는다. 감사는 상태 변경과 같은 트랜잭션, 사용 기록은 실패/조회도 포함하는 별도 기록이다. 계측 저장 실패는 성공으로 숨기지 않는다.

`GET /api/v1/usage?days=7|30`는 인증 어댑터 주입형 `server/http.ts`에서 제공한다. 일반 구성원은 본인 집계만, 검토자는 workspace 전체 집계만 볼 수 있다. 사용자별 명세 노출은 이번 범위가 아니다. 전체 수·성공·실패·활성 사용자·UTC 일별/작업별 분포를 반환하고 모델 토큰/비용은 미수집(null)으로 반환한다. 이 응답은 공급자 사용량을 측정한 것이 아니다.

`src/features/UsageDashboard.tsx`와 `src/adapters/usage.ts`에 기간 선택·요약·일별 막대·작업별 표를 추가하고 App의 별도 사용량 경로에서 연결한다. 현재 데모 서버에는 인증된 API가 없으므로 연결 불가/재시도 상태를 정직하게 표시하며 합성 실측치를 자동 대체하지 않는다. 실제 DB 기록→HTTP 집계→UI 렌더링을 통합 시험하고 브라우저에서는 실측 시험 데이터 화면과 미연결/빈 상태를 구분해 캡처한다. SSR 렌더링 시험으로 수치·분모·접근성·미수집 표기를 검증한다. 전체 UI 연결은 인증 어댑터가 있는 호스트 앱에서만 가능하며 데모가 운영 서버가 되지는 않는다.

## 실행 기록

- 사용자 재지시: 추가 승인 대기 대신 구현을 진행하고 PR을 생성한다. 현재 세션에서 직접 구현한다.
- 사전 확인: Docker daemon 29.2.1 사용 가능. 호스트 기본 PostgreSQL은 응답 없음. 시험 전용 컨테이너를 사용하고 기존 데모 compose는 유지한다.
- 최종 검증: Node 24.22.2/PostgreSQL 17.6, 클라이언트 35+Node 6+서버 26개 통과, 251개 요구사항/서버 타입/빌드/마이그레이션 재실행 통과. 주 청크 511.15 kB 경고 유지.
- 독립 리뷰 3개 중요 지적 RED→GREEN으로 수정. 과거 버전은 현재 제목 근거도 읽을 수 있어야 반환하는 보수적 정책을 적용했다. 그 때문에 과거 조회 가용성이 더 엄격할 수 있으며 전체 과거 메타데이터 모델은 후속이다.
- UI 캡처 19개와 실제 표시 크기/미수집 범위는 `docs/SERVER_FOUNDATION.md`에 기록했다. 실제 운영 릴리즈 완료 선언이 아니다.
