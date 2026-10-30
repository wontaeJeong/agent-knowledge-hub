# Agent-Native Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최신 서버 UI를 보존하면서 에이전트 운영 개요와 누락 기능의 명시적·체험 가능한 목업을 제공한다.

**Architecture:** 운영 앱에 공통 탐색과 집계를 추가한다. 별도 preview 진입점은 메모리 전용 API/관리 상태를 사용하며 실제 서버 오류의 fallback이 아니다. 관리 화면과 요구사항 목록은 독립 파일로 분리한다.

**Tech Stack:** 기존 React 19 / TypeScript / Vite / Vitest / CSS tokens, 추가 런타임 의존성 없음. Node 24.

**Spec:** `docs/superpowers/specs/2026-10-30-agent-console-design.md`

## Global Constraints

- 최신 시작점 e89921c. 기본 저장소 main 무수정, 기존 전용 작업 브랜치 사용.
- 한국어 안내, 브랜드 심볼 불변, 실제·목업·미수집·미실행 구별.
- ADR005 제안은 UI 목업만. reviewer 자동 관리 승격/서버 권한 교체 없음.
- 기존 251개 수용 기준·운영 미검증 상태 유지.
- 목업 메모리 전용, 실제 키/외부 API 없음. 표 25건·내부 스크롤.

## Review Focus

- 서버 장애/401에서 예시가 대신 보이거나 보호 데이터가 남지 않는가.
- 0건/실패/미수집 지표가 성공·무료·성능 향상으로 오인되지 않는가.
- 초대·마지막 Owner·서비스 주체·권한 제한이 목업에서도 명료한가.
- 긴 식별자/한글·390px·키보드에서 표/탐색/확인 화면이 사용 가능한가.
- 직접 링크/뒤로가기/미지 경로/새로고침에도 화면 및 목업 경계가 유지되는가.

### Task 1: 명시적 preview와 운영 개요의 데이터 계약
**Files:** `src/entry.ts`, `src/main.tsx`, `src/operational/console.ts`, `preview.ts`, 각 테스트.
**Interfaces:** `ConsoleTab`, `readConsoleTab(hash)`, `summarizeConsole(data)`, `PreviewApi extends OperationalApi`.
- [ ] preview 진입 우선순위·미지 경로·집계 분모·미실행 Lint·네트워크 0회·지원하지 않는 목업 mutation 거부 테스트를 작성하고 RED 확인.
- [ ] 명시적 메모리 fixture/adapter와 개요 집계를 구현해 GREEN 확인.

### Task 2: 운영 셸·대시보드와 기존 흐름 연결
**Files:** `src/operational/App.tsx`, `ConsoleShell.tsx`, `Overview.tsx`, `console.css`.
**Interfaces:** App의 `preview?: boolean`, Shell의 active tab/navigation/identity, Overview의 현재 접근 범위 집계.
- [ ] SSR의 실제/목업 배지·관리 진입 경계·지표 분모를 먼저 검증.
- [ ] 그룹별 탐색·hash/뒤로가기·모바일 메뉴·테마·개요/집계 실패 재시도를 구현.
- [ ] 기존 서버 업무 흐름과 세션 만료 시 상태 제거를 유지하고 회귀 확인.

### Task 3: 관리 목업·전체 기능 목록
**Files:** `src/operational/management.ts`, `Management.tsx`, `Coverage.tsx`, 각 테스트.
**Interfaces:** `ManagementSection`, 메모리 상태 및 검증된 액션, 요구사항별 화면 매핑.
- [ ] 사용자/초대/마지막 Owner·서비스 주체 범위·수신자 공유/로컬 반출 제한 상태 전이와 251개 유일 매핑 테스트 RED.
- [ ] 사용자·공간/접근·에이전트·연동·보호/공유·수명주기·알림/감사·평가/운영 목업, 검색·필터·상세·확인·페이지·초기화 구현 GREEN.
- [ ] 실제 앱에서는 목업 진입 안내만, preview에서만 메모리 편집 허용.

### Task 4: 브라우저 검증·인계·PR/머지
**Files:** `docs/AGENT_HANDOFF.md`, `docs/AGENT_CONSOLE.md`, `docs/pr-assets/agent-console/`, README.
- [ ] 최신 main 변경 재확인 및 필요시 통합, 전체 `npm run check`와 diff 검사.
- [ ] 390/1440px 라이트/다크·기존 화면·관리 동작·키보드·통신 격리 실제 브라우저 확인 및 캡처·수치 보존.
- [ ] 독립 코드 리뷰 후 지적 해결/재검증.
- [ ] 문서/계획 체크 갱신·커밋·푸시·PR 생성·필수 CI 성공 확인 후 사용자 사전 승인에 따라 머지. 시작/종료 기본 main·worktree 상태 확인.
