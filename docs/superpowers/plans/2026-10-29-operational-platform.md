# Operational Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** K8s에서 실제 인증·DB·모델 지식 순환이 동작하는 10명 이하 운영 앱을 구현하고 검증 후 PR/머지한다.
**Architecture:** 기존 TypeScript 도메인과 PostgreSQL 발행 서비스를 재사용한다. OIDC 서버 세션의 REST/MCP와 별도의 서버 연결 UI, kind/Kustomize 배포를 추가한다.
**Tech Stack:** Node24, TypeScript, React, PostgreSQL17, OIDC/Keycloak, Kubernetes/kind.
**Spec:** `docs/superpowers/specs/2026-10-29-operational-platform-design.md`

## Global Constraints

- 동시접속 10명 이하. 스케일 최적화는 후순위다.
- 운영 Kubernetes, 로컬 kind, Compose 필수 의존 없음.
- 기존 251개 요구사항과 North Star를 축소/완료 위장하지 않는다.
- DeepSeek→온프레미스는 서버 설정 교체, 비밀 노출 금지.
- 사용자 부재 중 합리적 기본값으로 계속 진행; 사내 검증은 별도 차단 항목이다.
- 원본/파생 ACL, 승인 내용 고정, 원자 발행, 멱등성 유지.

## Review Focus

- 로그인 재전송/CSRF/임의 사용자 주입은 인증을 우회하지 못한다.
- 철회 후 검색·답변·이전 버전에서 본문/제목이 유출되지 않는다.
- 모델 지연 중 권한/기준 변경 시 결과 발행을 거부한다.
- 작업 재시작/발행 응답 소실 시 중복 발행하지 않는다.
- 운영 설정 누락/개발 비밀번호/가짜 백업은 배포 통과로 표시하지 않는다.

### Task 1: 실행 가능한 서버와 인증된 지식 순환

**Files:** `server/runtime/`, `server/migrations/004-*.sql`, `server/*.test.ts`, `package.json`/lock.
**Interfaces:** consumes `KnowledgeService`, `transaction`, `loadState`; produces `npm run start:server` at port8080 and JSON REST `/api/v1` below. Authentication `/auth/login`, `/auth/callback`, POST `/auth/logout`. GET `/api/v1/me` → `{principalId, role, workspaceId, csrfToken}`. GET pages → `{items:[{id,title,summary,version,content}]}`. GET sources → `{items:Source[]}`. POST sources → Source with `readers:string[]` explicit. GET members → `{items:[{principalId,role}]}`. GET changesets → `{items:[{id,hash,status,updates}]}`. POST ingest `{sourceIds,mode:'model'|'offline'}` → `{id,hash}`. POST changesets/:id/approve|publish|reject `{hash}` plus Idempotency-Key. POST query `{question,mode}` → Answer. POST answers/:id/file → changeset. POST lint → `{issues}`. GET jobs → `{items}`. GET model → `{configured,model}`. GET healthz/readyz; static dist serves operational UI. All mutating API requires CSRF header X-CSRF-Token and Origin, JSON.
- [ ] Write tests for real HTTP authentication rejection, filtered DB views, source→compile→approval→publication→query→fileAnswer→Lint, model failure and restart/idempotency.
- [ ] Run targeted tests and observe RED.
- [ ] Implement server with standard audited OIDC library, DB sessions, configured role groups, filtered server state only, bounded inputs, safe error/secret handling. Durable job state and model API adapter. Keep old demo explicit and separate.
- [ ] Run Node24 full suites/type/build; record uncovered spec features honestly.
- [ ] Commit task, independent review, address important findings.

### Task 2: Operational React client

**Files:** `src/operational/`, `src/main.tsx`.
**Interfaces:** consumes Task1 exact REST DTOs. Default deployed app uses operational client; legacy demo only explicit `?demo=1`.
- [ ] Write API contract tests for failure/CSRF and server-mode selection; observe RED.
- [ ] Implement accessible Korean login/logout, published knowledge/search, sources upload/selection, changeset diff/approve/publish/reject, query/citations/file, Lint, jobs and usage. No browser role switch or localStorage truth.
- [ ] Run test/build and actual 390/1440 browser with real server; fix defects.
- [ ] Commit and independent review.

### Task 3: Kubernetes/kind deployment and operational gates

**Files:** `deploy/`, `scripts/k8s/`, `Dockerfile.server`, deployment docs.
**Interfaces:** consumes Task1 env (`DATABASE_URL`, `APP_ORIGIN`, OIDC_* config, AGENT_KNOWLEDGE_HUB_LLM_*), port8080, healthz/readyz and migration command.
- [ ] Write manifest/script validation tests: no plaintext production secrets, isolated namespaces, persistent DB, nonroot app, actual required rollout/migration/probes. Observe RED before scripts.
- [ ] Implement base + local/stg/prod overlays, local Keycloak realm/groups fixtures, local secrets generated outside Git, kind setup/build/load/apply/migrate/readiness, backup/restore operational scripts.
- [ ] Deploy to dedicated kind cluster, exercise actual login and DB/restart/model flow; do not touch existing cluster.
- [ ] Run manifest tests, backup+restore and 10-session workload; report measurements and deployment limitations, commit.

### Task 4: Whole-branch acceptance, inventory and PR

**Files:** requirement evidence inventory, `docs/AGENT_HANDOFF.md`, README and operating runbook.
- [ ] Map all 251 rows to actual implementation/test evidence or explicit remaining blockers. Do not mark unsupported feature complete.
- [ ] Run npm test, requirements, server checks/tests, build, kind E2E and security/restore regressions.
- [ ] Independent whole-branch review, RED→GREEN important fixes and rerun affected/full checks.
- [ ] Commit/push, open PR with actual results/remaining conditions, wait for required CI, merge only if safe and green. User already authorized merge.

## Progress

- User directed unattended execution on 2026-10-29; extra design approval prompts waived. Architecture choices are implementer defaults, not company policy approval.
- Initial environment has Docker/kind/kubectl and GitHub authentication. Node25 default must be replaced with Node24 for verification. Existing kind cluster `agentcask-mvp` is out of scope.
