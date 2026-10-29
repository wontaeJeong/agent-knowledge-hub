# 개발환경과 PR 검증

앱은 합성 자료와 브라우저 localStorage를 사용하는 로컬 데모다. 기본 개발·테스트에는 모델 키, Docker, Python, DB가 필요 없다. 아래 절차는 제품 기능의 운영 수용 기준 통과를 뜻하지 않는다.

## 처음 시작하기

지원 환경은 **Node 22.12 이상인 22.x 또는 24.x LTS, npm 10 이상**이다. 새 환경은 Node 24를 권장한다. `.nvmrc`와 `package.json`의 `engines`를 확인한다. Node 20/25/26 등 선언하지 않은 버전은 설치 단계에서 거부한다. 의존성의 지원 범위와 확인한 LTS만 지원하며 새 LTS는 CI를 추가한 뒤 범위를 넓힌다.

```bash
git clone https://github.com/wontaeJeong/agent-knowledge-hub.git
cd agent-knowledge-hub
# nvm을 사용하는 macOS/Linux 개발자는 nvm install && nvm use
node --version
npm --version
npm ci
npm run doctor
npm run check
npm run dev
```

Windows에서도 Node 24 설치 후 같은 npm 명령을 사용한다. nvm은 필수가 아니다. `npm ci`는 잠금 파일과 다른 의존성을 임의로 갱신하지 않는다. 의존성을 의도적으로 바꾸는 경우에만 `npm install`과 변경된 `package-lock.json`을 함께 검토한다. Node 버전을 바꾼 뒤에는 네이티브 패키지를 위해 `npm ci`를 다시 실행한다.

Vite 개발 주소는 터미널에 표시되며 기본 5173이다. `npm run dev -- --port 5174 --strictPort`로 충돌을 명시적으로 확인할 수 있다. Vite는 기존 설정상 모든 인터페이스에 바인딩하므로 신뢰하는 개발 네트워크에서만 사용한다. 로컬 한정은 `npm run dev -- --host 127.0.0.1`을 사용한다.

## 자주 쓰는 명령

| 명령 | 용도 |
| --- | --- |
| `npm run doctor` | 지원 Node와 개발 의존성 존재 확인. 비밀값을 출력하지 않으며 잠금 파일 동기화 검사를 대신하지 않음 |
| `npm run check` | 진단 → 전체 테스트 → 251개 요구사항 연결 → 타입검사/빌드 → HTTP smoke. PR CI와 동일 |
| `npm test` | 전체 도메인 및 Node HTTP/개발 도구 회귀. 모델 호출은 로컬 가짜 공급자로 검사 |
| `npm run test:watch` | Vitest 도메인 테스트 감시. Node 도구 테스트는 포함하지 않음 |
| `npm exec vitest -- run src/domain/wiki.test.ts` | 특정 도메인 테스트만 실행 |
| `node --test scripts/model-api.test.mjs` | 특정 Node HTTP 계약만 실행 |
| `npm run typecheck` | TypeScript 프로젝트 검사만 실행 |
| `npm run build` | 타입검사와 프로덕션 형식의 정적 빌드 (`dist/`) |
| `npm run test:smoke` | 기존 빌드를 로컬 데모 서버로 띄워 검사 후 성공/실패 모두 서버 종료 |
| `npm run test:smoke -- http://127.0.0.1:8080` | 이미 떠 있는 정적 서버 검사. 서버를 종료하지 않음 |
| `npm run preview` | 빌드된 정적 파일 확인 (모델 중계 없음) |
| `npm run demo` | 빌드된 데모와 선택적 모델 중계. 소스 체크아웃에서는 먼저 build 필요 |

Smoke는 HTML 앱 루트, 연결된 JS/CSS/브랜드 파일의 상태·MIME·비어 있지 않은 본문, 없는 파일의 404를 검사한다. 기본은 빈 포트를 선택한다. `AGENT_KNOWLEDGE_HUB_DEMO_PORT`를 지정하면 해당 포트를 사용하며 다른 서버가 점유하면 실패한다. 브라우저에서 JavaScript를 실행하거나 화면·접근성·실제 모델 의미 품질을 검사하지는 않는다. Node 테스트 파일을 추가하면 `package.json`의 `test` 명령에도 등록한다.

모델 없이 개발할 때 `.env`를 만들 필요 없다. 실제 모델 설정은 [.env.example](../.env.example)과 [MODEL_SETUP.md](MODEL_SETUP.md)를 따른다. Vite 개발 서버/preview가 모델 중계 서버는 아니다. 모델은 `npm run build` 후 `npm run demo`에서 연결한다. 키는 서버 환경에만 두고 `VITE_`에 넣지 않는다. `.env`와 로컬 에이전트 상태는 Git 및 Docker 빌드 컨텍스트에서 제외한다.

## Docker로 동일 정적 데모 확인

Docker Engine/Desktop와 Compose v2 이상이 별도로 필요하다. 기본 포트는 loopback의 8080이다.

```bash
docker compose up --build --wait --wait-timeout 90
npm run test:smoke -- http://127.0.0.1:8080
docker compose down
```

포트 변경은 `AGENT_KNOWLEDGE_HUB_HTTP_PORT` 환경변수로 한다 (예: Bash `AGENT_KNOWLEDGE_HUB_HTTP_PORT=18080 docker compose up --build --wait`; PowerShell `$env:AGENT_KNOWLEDGE_HUB_HTTP_PORT='18080'`). Node 데모 포트 변수와 별개다. CI는 고유 Compose 프로젝트와 자동 할당 포트(`0`)로 다른 실행과 격리하며 항상 정리한다. 컨테이너는 Nginx 정적 서버이며 Node 모델 중계/DB/인증을 포함하지 않는다.

## PR CI와 CD의 경계

`.github/workflows/ci.yml`은 PR, main push, merge queue, 수동 실행에서 다음을 수행한다.

1. Ubuntu Node 22/24, macOS Node 24, Windows Node 24에서 `npm ci`와 `npm run check`.
2. Ubuntu에서 실제 Docker 이미지 빌드 → health 대기 → 같은 HTTP smoke → 컨테이너 정리.
3. Ubuntu Node 24의 검증된 `dist/`를 7일 보관하는 `static-demo-<commit>` artifact로 제공. Actions 실행 화면에서 다운로드하고 압축을 푼 뒤 `npm run test:smoke -- <정적 서버 주소>`로 재확인할 수 있다. 모델 중계를 포함한 배포 패키지는 아니다.
4. 모든 매트릭스와 Docker가 성공해야 마지막 `check`가 성공. 실패·취소·건너뜀은 통과로 처리하지 않는다.

같은 PR의 새 실행은 이전 실행을 취소하며 PR 브랜치 push와 PR 이벤트의 중복 실행을 피한다. GitHub 토큰은 `contents: read`만 부여하고 checkout 자격증명은 남기지 않는다. 외부 PR에도 모델 키·배포 자격증명이 필요 없다. Actions는 검토 가능한 commit SHA로 고정한다. 이 설정은 GitHub.com hosted runner 기준이며 다른 서버/runner로 이식 시 Actions 버전과 artifact 호환성을 따로 확인한다.

**자동 운영 배포는 없다.** 운영 백엔드·배포 환경·승인/자격증명이 아직 없으므로 정적 artifact와 컨테이너 검증을 운영 CD 완료로 표현하지 않는다. 저장소 관리자는 main 보호 규칙/ruleset에서 `check`를 필수 검사로 지정해야 한다. 워크플로 파일만으로 머지를 강제로 차단하지 못한다. 이 작업은 저장소 보호 설정이나 자동 머지를 임의 변경하지 않는다. 운영 전 요구사항은 [K8S_RELEASE.md](K8S_RELEASE.md)를 따른다.

## 문제 해결

- `EBADENGINE`: `node --version` 확인 후 Node 24로 전환하고 `npm ci`. `--force`나 engine-strict 해제로 우회하지 않는다.
- 잠금 파일 불일치: PR의 `package.json`/lock 변경을 대조한다. 단순 설치 실패를 숨기려고 lock을 삭제하지 않는다.
- 네트워크/CA 오류: 승인 npm 미러·프록시·회사 CA를 npm 사용자 설정으로 적용한다. TLS 검증을 끄거나 토큰을 저장소에 쓰지 않는다.
- `Packaged build not found`: Git 체크아웃에는 `demo-dist`가 없으므로 `npm run build`부터 실행한다.
- 포트 충돌: demo는 `AGENT_KNOWLEDGE_HUB_DEMO_PORT`, Compose는 `AGENT_KNOWLEDGE_HUB_HTTP_PORT`, Vite는 `--port`를 사용한다.
- Docker health 실패: `docker compose logs`, `docker compose ps`로 조사하고 작업 후 `docker compose down`. 다른 작업의 프로젝트를 삭제하지 않는다.
- 주 청크 500 kB 경고: 기존 510.25 kB 경고가 남아 있다. 이번 작업은 앱 기능/분할을 바꾸거나 경고 한도를 올려 감추지 않는다.
- `npm run format`은 파일을 실제 변경한다. 기존 앱 파일 네 곳에 Prettier 부채가 있어 전체 포맷을 CI 게이트로 추가하지 않았다. 기능 작업과 무관한 대량 포맷은 별도 PR로 분리한다.
