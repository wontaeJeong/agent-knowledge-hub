# Local Personal Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 연결 중 자동 동기화하는 로컬 MCP 커넥터와 개인→공유 변경 제안의 실제 합성 통신 경로를 구현한다.

**Architecture:** Node 공통 엔진은 지속 JSON 작업본과 HTTP transport를 분리한다. loopback 합성 개발 서비스는 개인 공간과 공유 승인 경계를 실행하며 기존 웹 데모를 대체하지 않는다. STDIO MCP와 CLI가 같은 엔진을 사용한다.

**Tech Stack:** Node.js 22.12+, JavaScript ESM, 공식 MCP SDK v1, Zod, node:test, 기존 Vitest/TypeScript/Vite 검증.

**Spec:** `docs/superpowers/specs/2026-10-29-local-personal-wiki-design.md`

## Global Constraints

- 로컬 커넥터 상시 실행은 제품 범위에서 제외하며 향후 구현 과제가 아니다. 연결 중에만 자동 동기화하고 미전송 변경은 보존해 재연결 시 재개한다. 서버 측 지속 작업·예약 유지관리 요구사항은 유지한다.
- 첨부·원본 본문·전체 과거 이력은 복제하지 않는다.
- 개인 자동 저장은 공유 발행이 아니다. MCP에 승인/발행/병합 확정 도구를 제공하지 않는다.
- 기존 251개 수용 기준과 North Star를 변경하지 않는다. 합성 개발 서비스는 운영 인증/DB가 아니다.
- 손상 상태·오류·권한 불명확을 빈 상태/성공으로 감추지 않는다.

## Review Focus

1. 서버 수락 후 응답 유실: 변경 ID로 재시도해 중복 버전이 없어야 한다(Task 2).
2. 동기화 도중 로컬 편집: 직렬화로 새 draft를 잃지 않아야 한다(Task 2).
3. 호스트 종료와 잠금: EOF로 프로세스가 종료되고 재연결이 가능해야 한다(Task 3).
4. 현재 권한 확인 실패: 캐시 검색/열람을 차단하며 토큰을 오류에 노출하지 않아야 한다(Task 2).
5. 검토 중 개인/공유 버전 변화: 제출 스냅샷을 보존하고 공유 기준 변경 시 발행을 차단해야 한다(Task 1).

## 파일 구조

`scripts/wiki-connector/`에 protocol.mjs(검증), store.mjs(원자 저장/잠금), service.mjs(합성 서비스 규칙), dev-server.mjs(loopback HTTP), client.mjs(동기화), mcp.mjs(STDIO 도구), cli.mjs(실행/사람 확인)를 둔다. 같은 디렉토리의 *.test.mjs로 실제 파일·HTTP·SDK 경계를 검증한다. README·아키텍처·인터페이스·인계에 새 범위와 제약을 연결한다.

### Task 1: 지속 상태와 개인/공유 서비스

**Files:** Create `scripts/wiki-connector/{protocol,store,service,dev-server}.mjs`, `service.test.mjs`.

**Interfaces:** `createService({file,identities,pages})` → `request(token, action, payload)`. `openStore(directory)` → `{read,write,close}`. 서비스 action은 `snapshot`, `push`, `propose`, `approve`, `publish`다. `push`는 `{mutationId,baseVersion,page}`, `propose`는 `{id,pageId,targetSpaceId,baseVersion}`를 받는다. 인증 주체는 identities에서만 결정한다.

- [x] 기준 버전 충돌·동일 mutation 재시도·개인 격리·승인 전 공유본 불변·제출 후 개인 변경·발행 재검사·손상 파일·잠금 회귀 시험을 먼저 작성한다.
- [x] `node --test scripts/wiki-connector/service.test.mjs` 실행, 미구현 실패 확인.
- [x] 요청 스키마·영속 상태·직렬 서비스·loopback HTTP 경계를 구현한다. 개발 서비스의 모든 자료는 합성 입력이며 로컬 복제 허용이 필요하다.
- [x] 같은 명령으로 통과 확인 후 커밋한다.

### Task 2: 로컬 동기화와 충돌 보존

**Files:** Create `scripts/wiki-connector/client.mjs`, `client.test.mjs`.

**Interfaces:** `openClient({directory,url,token,intervalMs})` → `{write(page),sync(),read(id),search(query),status(),conflicts(),prepareMerge(id,content),confirmMerge(id,hash),propose(input),start(),close()}`. HTTP는 Task 1의 action DTO를 소비한다. 모든 메서드는 Promise이며 start/close가 timer/request/lock 수명주기를 소유한다.

- [x] 실제 loopback 서버와 두 디렉토리로 업로드·재시작·동시 충돌·원격 확인 실패·철회·응답 유실 멱등성·개인/공유 검색 구별 시험을 작성한다.
- [x] `node --test scripts/wiki-connector/client.test.mjs` 실행, 미구현 실패 확인.
- [x] durable draft와 기준 버전을 분리한다. 하나의 직렬 큐로 write/sync/read를 실행한다. HTTP redirect 금지, 제한된 JSON, timeout, 토큰 비노출. read/search 전에 metadata 권한 확인, 네트워크 오류 시 fail closed.
- [x] 충돌은 세 버전 보존. 병합 제안 해시와 현재 원격 revision으로 CLI 확인을 고정한다. 첫 구현은 같은 문서 비중첩 편집도 보수적 충돌 처리한다.
- [x] 같은 명령으로 통과 확인 후 커밋한다.

### Task 3: 호스트 연결과 사용자 진입점

**Files:** Create `scripts/wiki-connector/{mcp,cli}.mjs`, `mcp.test.mjs`, `docs/LOCAL_WIKI.md`; Modify `package.json`, `package-lock.json`, README, ARCHITECTURE, AGENT_INTERFACE, AGENT_HANDOFF.

**Interfaces:** STDIO entry `mcp.mjs`는 `AGENT_KNOWLEDGE_HUB_WIKI_URL`, `AGENT_KNOWLEDGE_HUB_WIKI_TOKEN`, `AGENT_KNOWLEDGE_HUB_WIKI_DIR`를 사용한다. CLI는 `serve`, `status`, `sync`, `write`, `prepare-merge`, `confirm-merge`, `propose`, `approve`, `publish`를 제공한다. `serve`는 합성 설정 파일과 loopback 개발 서버만 실행한다.

- [x] 공식 SDK client로 MCP 자식 프로세스의 도구 목록·쓰기·검색·공유 자동 발행 없음·EOF 종료·재시작을 시험한다.
- [x] `node --test scripts/wiki-connector/mcp.test.mjs` 실행, 미구현 실패 확인.
- [x] SDK의 McpServer/StdioServerTransport와 Zod를 사용한다. stdout은 MCP 전용이며 실패는 sanitized error로 반환한다. CLI 확정은 사람이 본 해시를 명시적으로 요구한다.
- [x] 사용 예시·호스트별 미검증 포장·보안 제한·상시 실행 제외를 문서화한다. npm test에 새 node:test를 포함한다.
- [x] `npm test`, `npm run check:requirements`, `npm run build`, `git diff --check` 및 독립 리뷰 후 커밋한다.

## 실행 기록

- 사용자 승인: 추천안으로 구현·PR·머지까지 명시 요청. 중간 진행 재승인 없이 inline 실행한다.
- baseline: 32 Vitest + 5 Node 시험 통과. 현재 Node 25.7.0은 기존 Vitest 지원 범위 밖이라는 npm 경고가 있어 지원 Node 버전으로 최종 검증한다.
- 설계 선택: 운영 백엔드를 임의로 JSON으로 교체하지 않고 합성 loopback 서비스를 별도로 제공한다. Windows 설치형 패키지·실기 검증을 지원 완료로 주장하지 않는다.
- 최종: 독립 리뷰 Important 2건을 재현해 RED→GREEN으로 수정했다. 공간 간 ID 충돌은 기존 draft 보존/거부, 제출은 권한 갱신 전 개인 revision 고정 및 서버 CAS로 처리한다. Node 22에서 32 Vitest + 33 Node, 251개 요구사항 검사, 빌드 통과. 운영/포장/지식 품질 제약은 설계와 LOCAL_WIKI에 보존한다.
