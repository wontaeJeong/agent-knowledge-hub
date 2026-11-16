# 요구사항·구현 현황 정비 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 코드와 문서의 차이를 정리하고, 전체 요구사항을 보존한 채 다음 구현 순서와 검증 기준을 명확히 한다.

**Architecture:** 현재 실행 경로는 `docs/CURRENT_STATUS.md`, 요구사항 운영·우선순위·보완 검증은 `docs/requirements/MAINTENANCE.md`에 모은다. 과거 설계와 실행 기록은 시점을 표시하고 현재 현황으로 연결한다.

**Tech Stack:** Markdown, 기존 JSON 요구사항, Node 24의 기존 검증 명령.

**Spec:** 2026-11-14 대화의 구현/요구사항 검토 및 사용자의 “필요한 정비까지 반영해서 PR과 머지” 지시. 제품 불변식은 `docs/LLM_WIKI_CORE.md`, 출시 조건은 `docs/requirements/README.md`.

## Global Constraints

- 기준 `main@9883fbe`에서 별도 worktree를 사용한다.
- 기존 239+12 요구사항의 ID·필수 분류·수용 기준·미검증 상태를 보존한다.
- North Star 의미, ADR 004/005의 제안 상태, 미이관 공간의 기존 3역할 유지 요구를 변경하지 않는다. 알려진 구현 격차로 기록한다.
- 앱·서버 코드와 UI를 변경하지 않는다. 기능 구현·실행 검증·운영 인수를 구분한다.
- 사용자가 승인한 PR 생성·머지를 실행하되 최종 커밋 CI와 독립 리뷰를 확인한다.

## Review Focus

- 과거 “미구현” 설명을 현재 코드 전체의 설명으로 읽게 되는 문서: 시점·현재 현황 링크 확인.
- 모듈 존재만으로 기능 전체가 연결됐다고 오인하는 표: 실제 runtime/App 연결 근거 확인.
- 순서/위험도 분류가 필수 요구사항 면제로 해석될 위험: 원본 JSON 불변 비교와 출시 조건 문구 확인.
- 문서 보완이 품질 향상·호환성 해결·실환경 인수로 읽힐 위험: 미실행/미충족 명시 확인.
- 평가의 문서 개수·고정 인용·합성 라벨을 의미 품질로 오인할 위험: 보완 시나리오와 독립 판정 조건 확인.

### Task 1: 현황과 요구사항 운영 기준을 하나의 검토 단위로 정비

**Files:** Create `docs/CURRENT_STATUS.md`, `docs/requirements/MAINTENANCE.md`; modify README, 현황을 설명하는 docs, AGENT_HANDOFF, MISTAKE_LOG.

**Interfaces:** 기존 요구사항 JSON과 서버/UI 소스는 읽기 근거이며 수정하지 않는다. 새 현황 문서가 과거 상태 문서의 공통 진입점이 된다.

- [ ] 기준 worktree에서 Node 24 `npm ci`와 `npm run check`를 실행한다. Expected: 종료 코드 0.
- [ ] 실제 실행 경로·부분 연결·차단·평가 한계를 소스 링크와 함께 기록한다.
- [ ] 위험도/적용 조건/개발 순서/검증 상태를 분리하고 CORE-003/006/012·검토 비용·부하 가정의 보완 검증을 기록한다.
- [ ] 과거 문서에 시점과 현재 현황을 표시하고 명백히 오래된 현재형 설명을 수정한다.
- [ ] 상대 링크·요구사항 ID·보호 파일 불변·`git diff --check`를 검사한다. Expected: 누락·변경·공백 오류 0.
- [ ] Node 24 `npm run check`를 실행하고 실제 결과·남은 조건을 인계에 기록한다. Expected: 종료 코드 0.
- [ ] 문서 변경을 커밋하고 독립 리뷰, PR 최종 커밋 CI 통과 후 squash merge한다. 기본 체크아웃은 최신 main으로 fast-forward한다.
