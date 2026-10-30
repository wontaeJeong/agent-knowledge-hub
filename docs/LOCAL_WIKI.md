# 로컬 위키 커넥터 — 첫 수직 구현

**합성 자료로만 사용한다.** 실제 파일 저장·HTTP 통신·STDIO MCP를 제공하지만 운영 서버/SSO/DB, Windows 설치형 배포, 실제 Codex/OpenCode/Cowork 앱 호환 검증은 아직 없다. 기존 웹 데모의 localStorage와 이 커넥터는 별도이며 서로 자동 이전하지 않는다.

## 사용자 경험과 현재 범위

목표는 기존 에이전트 앱에 위키 연결을 한 번 추가한 뒤 자연어로 개인 지식을 읽고 수정하는 것이다. 개발자에게는 CLI도 제공한다. 비개발자에게 Node 설치·환경변수·CLI 관리를 요구하는 상태를 완성된 배포 UX로 간주하지 않는다. 아래는 **개발자 통합/시험 절차**다.

- 공통 엔진이 로컬 JSON 작업본을 보존한다. 하네스에 동기화 기능을 기대하지 않는다.
- 호스트에 연결된 동안 자동 동기화하고, 종료 후에는 실행하지 않는다. 다음 연결 시 재개한다.
- **로컬 커넥터의 상시 실행은 제품 범위에서 제외한다.** 향후 구현 대기 항목이 아니며, 호스트 연결이 끝난 뒤 별도 daemon·OS 서비스·시작 프로그램·예약 작업으로 동기화를 계속하지 않는다. 연결 종료 때 미전송 변경을 보존하고 다음 연결 때 재개하는 방식만 지원한다.
- 이 결정은 사용자 PC의 로컬 동기화 수명주기에만 적용한다. 서버의 지속 작업·재시도·예약 유지관리 요구사항을 삭제하거나 축소하지 않는다.
- 최신 허용 텍스트·연결·출처 식별자만 복제한다. 원본·첨부 본문과 전체 과거 이력은 복제하지 않는다.
- 개인 저장과 공유 변경 제안은 분리한다. 공유본을 수정해도 개인 파생본이 만들어지고 공유본은 유지된다.
- 여러 PC는 별도 디렉토리를 쓴다. 같은 디렉토리를 두 프로세스가 동시에 열면 `WORKSPACE_LOCKED`다.
- 충돌은 기준/로컬/원격을 보존한다. 첫 구현은 같은 문서의 비중첩 수정도 보수적으로 충돌 처리한다.
- MCP는 병합안을 준비할 수 있지만 병합 확정과 공유 승인/발행은 CLI로 분리했다. CLI 플래그 자체가 사람이 실제 검토했다는 보안 증거는 아니며 호스트의 shell 권한 정책도 필요하다.
- 첫 공유 제안은 **한 페이지 단위**다. 기존 지식 엔진의 여러 페이지 원자 발행과 결합한 것으로 표시하지 않는다. 운영 연결 전 의존 변경 집합으로 확장해야 한다.

## LLM Wiki North Star와의 통합 위치

이 커넥터의 **개인 저장·동기화·공유 제안**은 지식의 원본 편입이나 Ingest → Query → Lint가 아니다. `wiki_write`는 개인 작업본만 수정하고 `wiki_propose_change`는 한 페이지의 선택 revision을 제안한다. 기존 웹 데모의 복수 페이지 지식 컴파일/검증/발행 경로와 **서로 다른 정본**인 현재 상태를 유지하고 있으며, 완료된 통합으로 표시하지 않는다.

향후 공통 서버 서비스에서 원본·권한·근거 계보·의존 변경 집합을 검증하면서 개인 작업본을 활용하는 방안은 [지식 누적 통합 계획](KNOWLEDGE_INTEGRATION.md)과 [ADR 004 제안](adr/004-unified-knowledge-service.md)을 참고한다. ADR은 아직 채택되지 않았고, KI-01~08은 미실행 수용 설계다.

[설계](superpowers/specs/2026-10-29-local-personal-wiki-design.md) · [구현 계획](superpowers/plans/2026-10-29-local-personal-wiki.md)

## 합성 원격 서비스 실행

지원되는 Node.js 22.12+ LTS와 의존성이 필요하다.

```sh
npm ci
npm run wiki -- serve scripts/wiki-connector/example-config.json
```

`127.0.0.1:8091`에서만 대기한다. example-config.json의 토큰은 공개된 합성 예시이며 비밀이 아니다. 실제 자격증명으로 재사용하지 않는다. `syntheticOnly: true` 없는 CLI 설정은 거부한다. 서비스 저장은 `.local-wiki-demo/remote.store/`에 남으며 Ctrl+C로 종료한다. 이 파일 서비스는 ADR 003의 운영 PostgreSQL 요구를 대체하지 않는다.

## 로컬 클라이언트 연결

macOS/Linux 개발 셸 예시:

```sh
export AGENT_KNOWLEDGE_HUB_WIKI_URL=http://127.0.0.1:8091/sync
export AGENT_KNOWLEDGE_HUB_WIKI_TOKEN=synthetic-alice-not-a-secret
export AGENT_KNOWLEDGE_HUB_WIKI_DIR="$HOME/.agent-knowledge-hub/synthetic-device-a"
npm run wiki -- sync
npm run wiki -- read demo-guide team-demo
```

Windows PowerShell 대응 설정(Windows에서 실기 검증하지 않음):

```powershell
$env:AGENT_KNOWLEDGE_HUB_WIKI_URL = 'http://127.0.0.1:8091/sync'
$env:AGENT_KNOWLEDGE_HUB_WIKI_TOKEN = 'synthetic-alice-not-a-secret'
$env:AGENT_KNOWLEDGE_HUB_WIKI_DIR = "$env:USERPROFILE\.agent-knowledge-hub\synthetic-device-a"
npm run wiki -- sync
```

MCP는 `node <절대경로>/scripts/wiki-connector/mcp.mjs`로 실행한다. MCP STDOUT은 프로토콜 전용이다. CLI stdout과 npm의 안내 출력을 MCP transport에 섞지 않도록 직접 node 엔트리를 연결한다.

### OpenCode V2 설정 예시

`command`의 경로를 실제 절대경로로 바꾼다. 환경변수는 **호스트 프로세스가 볼 수 있는 방식**으로 설정해야 하며 다른 셸에만 설정하면 GUI 앱이 상속하지 않을 수 있다.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "personal-wiki": {
        "type": "local",
        "command": ["node", "/ABSOLUTE/PATH/agent-knowledge-hub/scripts/wiki-connector/mcp.mjs"],
        "environment": {
          "AGENT_KNOWLEDGE_HUB_WIKI_URL": "{env:AGENT_KNOWLEDGE_HUB_WIKI_URL}",
          "AGENT_KNOWLEDGE_HUB_WIKI_TOKEN": "{env:AGENT_KNOWLEDGE_HUB_WIKI_TOKEN}",
          "AGENT_KNOWLEDGE_HUB_WIKI_DIR": "{env:AGENT_KNOWLEDGE_HUB_WIKI_DIR}"
        }
      }
    }
  }
}
```

### Codex 설정 예시

```toml
[mcp_servers.personal_wiki]
command = "node"
args = ["/ABSOLUTE/PATH/agent-knowledge-hub/scripts/wiki-connector/mcp.mjs"]
env_vars = ["AGENT_KNOWLEDGE_HUB_WIKI_URL", "AGENT_KNOWLEDGE_HUB_WIKI_TOKEN", "AGENT_KNOWLEDGE_HUB_WIKI_DIR"]
```

Windows JSON 경로에서는 역슬래시를 이스케이프해야 한다. 위 설정은 문서 기반 예시이며 실제 호스트 연결 시험 결과가 아니다. Claude Desktop `.mcpb`, Cowork 플러그인·설치·서명·업데이트 UX는 후속 범위다. Claude 원격 커넥터는 클라우드 발신이므로 사내망 로컬 접근의 대체재로 가정하지 않는다.

## 동기화·충돌·공유

**후속 권한 설계:** [권한 모델](ACCESS_CONTROL.md)과 [ADR 005](adr/005-github-style-access-control.md)는 로컬을 저장 위치로, 개인/팀을 소유권으로 구분한다. 공간별 5역할과 자료 반출 정책을 공통 서버에서 판단하고 개인→팀은 고정 revision의 명시적 제안으로 연결하는 **미구현 계약**이다. 아래 합성 `personal`/`team-demo`·reviewer 토큰이 그 역할/소유권을 구현한 것은 아니다. 연결 중 동기화 수명주기와 보호 조회 전 현재 권한 확인은 유지한다.

도구: `wiki_status`, `wiki_search`, `wiki_read`, `wiki_write`, `wiki_sync`, `wiki_conflicts`, `wiki_prepare_merge`, `wiki_propose_change`.

`wiki_write` 입력은 `{page: {id,title,content,spaceId,version,localCopyAllowed:true,links:[],sourceRefs:[]}}`다. 기존 공유본은 `wiki_read` 결과의 메타데이터·출처를 유지한 채 수정한다. 개인본은 `spaceId: personal`, 같은 ID로 저장된다. `wiki_read`의 기본은 개인본 우선이며 공유본은 `spaceId`를 명시한다. 검색은 두 종류를 별도 결과로 반환한다. 개인본 버전과 공유본 버전을 혼동하지 않는다.

클라이언트 상태는 `pending`, `conflicts`, `error`, `lastSync`를 구분한다. `lastSync`가 과거에 존재해도 현재 오류가 있으면 성공으로 해석하지 않는다. CLI `sync`는 한 번만 실행하며 연결 중 자동 실행은 MCP 엔트리가 담당한다.

충돌이 생기면 MCP로 양쪽 내용을 읽고 `wiki_prepare_merge`로 병합안을 만든다. CLI로 `conflicts`를 열어 본문·제안·해시를 검토한 뒤:

```sh
npm run wiki -- confirm-merge demo-guide <검토한-제안-해시> --human-reviewed
```

새 원격 편집은 해시 확인을 무효화한다. 서버의 기준 버전 검사도 적용해 확인과 전송 사이의 경쟁에서도 조용히 덮어쓰지 않는다. 같은 로컬 디렉토리를 MCP가 열고 있으면 CLI를 병행할 수 없으므로 호스트 연결을 끊고 CLI로 검토한 뒤 재연결한다. 이 제한을 없애는 네이티브 확인 UX는 후속 작업이다.

공유 제안 입력은 `{id: 'pr-one', pageId: 'demo-guide', targetSpaceId: 'team-demo', baseVersion: 1, personalVersion: 1}`이며 먼저 개인 변경이 동기화돼 있어야 한다. `personalVersion`은 읽고 제출하기로 선택한 개인본 revision이고 `baseVersion`은 공유 기준 revision이다. JSON 파일로 저장해 `npm run wiki -- propose <파일>` 또는 MCP로 제출한다. 제출 시 개인본이 다른 기기에서 바뀌었으면 `STALE_PERSONAL_VERSION`으로 거부하며 최신 내용을 확인한 뒤 다시 선택한다. 제출 이후 개인 편집도 기존 제안 내용을 바꾸지 않는다.

검토자는 별도 셸에서 합성 reviewer 토큰을 설정하고 `show-proposal <id>`, `approve <id>`, `publish <id>`를 사용한다. reviewer 자격은 서버 설정에서만 해석하며 MCP에 승인/발행 도구는 없다. 승인 후 공유 기준이 바뀌면 발행을 거부한다. 기존 공유본에 대한 개인 fork가 오래되면 새 공유 기준을 검토해 갱신하는 rebase 도구는 아직 없으므로 기존 fork의 제안을 강제로 발행하지 않는다.

## 보안·복구·성능의 한계

- 읽기 권한과 로컬 반출 허용은 다르다. 서비스가 `localCopyAllowed: true`로 지정한 합성 자료만 사용한다. 등급별 운영 반출 정책·기기 암호화·보관 기간은 미결 운영 게이트다.
- 본문 읽기·검색·충돌/병합안 조회 전 현재 권한/버전 메타데이터를 서버에 확인한다. 변경 없는 본문은 로컬에서 읽는다. 서버 확인 실패 시 캐시를 제공하지 않으므로 완전한 오프라인 열람은 아니다.
- 자동 polling 다운로드는 최신 전체 스냅샷이다. 업로드는 변경 페이지만 보낸다. 대량 데이터 delta 다운로드·검색 인덱스·paging은 후속 최적화이며 현재 HTTP JSON 상한은 요청/응답 각각 1 MiB다. 한 페이지 본문 상한은 200,000자다.
- 서로 다른 공간에 같은 문서 ID가 있을 수 있다. 첫 구현의 개인본 슬롯은 ID별 하나이므로 다른 공간의 같은 ID를 편집하려 하면 `PAGE_ID_COLLISION`으로 거부하고 기존 draft를 보존한다. 다른 공간의 출처로 조용히 바꾸지 않으며, 공간별 독립 fork 슬롯은 후속 확장이다.
- 권한 회수 시 다음 정상 권한 확인/동기화에서 캐시·충돌·병합안을 제거한다. 이미 반출된 파일/OS 백업/사용자 복사를 완전히 회수할 수 없다. 오류나 권한 서비스 중단 동안 디스크 사본이 자동 삭제됐다고 주장하지 않는다.
- 자격증명은 환경변수로 전달하고 상태 파일에 기록하지 않는다. 작업 디렉토리는 endpoint/토큰 해시에 묶이며 계정·토큰 교체 시 새 디렉토리를 사용한다. 토큰 회전 시 자동 재바인딩은 미구현이다.
- 네트워크 요청은 5초 제한과 redirect 금지를 적용한다. HTTPS가 기본이며 합성 개발용 `127.0.0.1`만 평문 HTTP를 허용한다. TLS 검증을 끄지 않는다.
- 상태는 임시 파일+rename으로 교체하고 손상된 상태를 빈 데이터로 초기화하지 않는다. 파일 fsync는 하지만 모든 OS/전원 장애의 내구성을 보장하지 않는다. 기존 JSON 작업본을 덮어쓰며 복구하지 말고 복사본을 보존해 조사한다.
- 종료 시 타이머·요청·잠금을 정리한다. 비정상 종료의 잠금은 기록된 PID가 존재하지 않을 때만 복구한다. PID 재사용·권한 불명확 시 잠금을 유지한다.
- 이 버전은 자동 자연어 병합·원본 등록·원본/첨부 조회 API·모델 Ingest/Query/Lint 통합을 제공하지 않는다. 기존 엔진을 대체하지 않으며 운영 전 동일 지식 서비스·서버 ACL·의존 집합 발행에 통합해야 한다.
- 성능/에이전트 품질 개선 수치는 측정하지 않았다. 초기 다운로드·polling·권한 조회까지 포함한 비교가 필요하다.

## 검증

```sh
node --test scripts/wiki-connector/*.test.mjs
npm test
npm run check:requirements
npm run build
```

실제 파일, loopback HTTP, 두 작업 디렉토리, 공식 SDK가 실행하는 MCP 자식 프로세스로 시험한다. 이 결과를 Windows·호스트 제품·프로덕션 권한·PostgreSQL·지식 품질 검증으로 확대하지 않는다.
