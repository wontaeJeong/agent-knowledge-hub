# 에이전트 인계

## 2026-10-29 운영형 서버·OIDC·kind 수직 연결 (진행 중)

- 사용자 결정: 동시접속10명 이하, 운영K8s/로컬kind, 개발Keycloak/운영사내SSO, 현재DeepSeek/향후온프레미스 교체. 추가 질문 없이 PR·머지까지 진행하도록 요청했다. 대규모 확장 최적화만 후순위이며 기존251개 기준은 보존한다.
- 서버: 표준OIDC+PKCE/state/nonce/JWKS, issuer+subject 신원, DB세션/CSRF, 매 요청 UserInfo/현재 DB권한 검사, 원본/변경 집합/발행/Query/답변/Lint/시도 기록과 쿠키 인증 REST/MCP를 연결했다. 기존 PostgreSQL 원자 발행과 멱등 영수증을 재사용한다.
- UI: 기본진입은 서버정본 운영UI, 기존합성데모는 `/?demo=1`로 분리한다. 한국어 원본/편입/검토/발행/질문/재편입/Lint/작업/사용량과25건 목록·인용고정버전 경로를 제공한다. 역할선택/localStorage를 운영인증/정본으로 사용하지 않는다.
- 배포: `Dockerfile.server`, Kustomize base/local/stg/prod, 로컬Keycloak 고정subject, 별도DB/PVC, 마이그레이션 성공 후 앱배포, Secret 직접주입, 개발설정/미고정이미지 운영차단을 추가했다. 회사도메인/SSO/TLS/CNI/저장소를 임의 추정하지 않는다. 상세는 [OPERATIONAL_SETUP](OPERATIONAL_SETUP.md).
- 실제 실행: 지원Node24.22.2에서 초기 서버41개 DB시험·클라이언트/도구 회귀·251개 연결검사·서버타입/빌드 통과. 전용kind의PostgreSQL/Keycloak/앱과마이그레이션Job이준비됨. 실제브라우저OIDC로그인/세션만료시보호화면제거/재로그인/발췌질문을확인했다. 합성2사용자의 편입·승인·원자발행·재시도·인용질문·재편입제안·Lint·무권한차단을 HTTP로실행했다. 변경중최종시험숫자는후속기록을따른다.
- 실제모델: DeepSeek `deepseek-flash` 합성연결호출200과실제토큰50개(입력39/출력11)를확인했다. 최초자연어질문E2E는검색이조사를처리하지못해근거부족으로정상보류되어전체시험은실패했다. 이를성공/모델종합으로바꾸지않고검색RED→GREEN을추가했으며배포후재실행대기다.
- 백업: AES256-GCM+scrypt암호화/변조·오키거부, 체크섬manifest, 로컬폐기DB복원도구를추가했다. 실제DB덤프161610bytes의암호화/복원에서페이지237·버전265·원본221개를확인했으며복원단계307ms였다. 이는합성시험DB의수치이며사내RPO/RTO·blob일관성·독립보관을검증한것이아니다.
- 브라우저: 합성발행본화면390px에서문서너비390/높이1178/첫제목145px,1440px에서너비1440/높이1000/첫제목107px. 실제캡처는 `docs/pr-assets/operational/`에있다. 최종이미지에서추가화면·키보드·인용·사용량재검증이남는다.
- 리뷰: UI/배포7건의검토중6건수정확인,사용량의별도401경로를공통처리로옮기는후속수정중이다. 서버독립리뷰의모델전체입력계보/질의전체의존성/발행후page-ACL계보3건은중요차단이며RED→GREEN수정중이다. 해결전머지/보안완료로표시하지않는다.
- 환경: 기본Colima2GiB에서우리신규kind노드OOM을실측했다. 기존프로젝트는중지하지않고실패한우리합성cluster만정리한뒤별도비활성4GiB profile `knowledge-hub-dev`를생성했다. Docker기본context는변경하지않고 `DOCKER_CONTEXT=colima-knowledge-hub-dev`로분리한다.28080/28081을사용한다.
- 남은범위: **전체251개구현완료/사내운영인수완료가아니다.** 지속작업lease/재시도/무인일정·취소/예산,개인커넥터공통서버통합,서비스계정MCP/업무context/outcome,초안/수동편집/복원전체·공유/첨부·댓글/알림·삭제/권한변경운영UI,blob저장/일관백업/감사외부보호,실제토큰비용영속계측,실모델의미품질/후속에이전트대조평가,사내SSO/TLS/CNI/스토리지/운영알림과인수는미충족이다. 현재jobs는영속시도기록이지자동재개worker가아니다. 정책·담당자승인을기술구현으로대체하지않는다。
- 추적: `node scripts/release-status.mjs /external/path/report.json`이원래수용기준251행을보존해부분근거와미검증을출력한다.부분구현경로만으로운영통과상태를자동승격하지않는다.

## 현재 상태

2026-10-29 후속 구현: PostgreSQL 내부 발행 서비스, DB membership/자료 allowlist, 승인 권한 스냅샷, 원자 발행·멱등 영수증, 감사/사용 기록과 사용량 대시보드를 추가했다. 상세는 [SERVER_FOUNDATION.md](SERVER_FOUNDATION.md). 아래 기존 데모 상태 설명은 계속 유효하며 새 서비스가 SSO/업무 UI/API 전체를 운영용으로 대체한 것은 아니다.

React 로컬 데모와 도메인 엔진, UI 교체 경계, 기준 239개와 핵심 순환 12개 요구사항, 앱 내 로드맵, 아이콘 팩을 제공한다. 선택적 로컬 모델 중계와 별도의 합성 개발용 로컬 위키 커넥터/STDIO MCP를 제공한다. 제품 서버·SSO·운영 커넥터·무인 스케줄러·인증된 운영 MCP는 아직 없다. 로드맵의 데모 매핑은 부분 시연 범위이지 프로덕션 완료 수가 아니다.

## 2026-10-29 로컬 위키–LLM Wiki 통합 설계 제안 (문서만)

- 최신 `main`의 커넥터 합성 동기화/단일 페이지 공유 제안과, 브라우저 `src/domain/wiki.ts`의 다중 페이지 컴파일·Query·Lint가 분리된 점을 확인했다.
- `docs/KNOWLEDGE_INTEGRATION.md`에 공통 정본·원본/개인본/발행본 구분, P0/P1/P2 전환 순서와 KI-01~08의 **미실행** 통합 수용 시나리오를 정의했다.
- `docs/adr/004-unified-knowledge-service.md`는 공통 서버 지식 서비스를 정본으로 삼는 **제안(Proposed)**이다. 사용자/제품 책임자의 리뷰 없이 채택·구현 완료로 취급하지 않는다.
- README·AGENTS·LOCAL_WIKI·ARCHITECTURE·ROADMAP·AGENT_INTERFACE·EVALUATION의 문서 탐색 경로를 연결한다. North Star 원문·런타임 `wiki/SCHEMA.md`·기존 251개 요구사항·앱 코드는 변경하지 않는다.
- 검증 범위는 문서 링크/변경 내용 확인으로 한정된다. 모델 의미 품질, 운영 인증/MCP, DB 트랜잭션, KI-01~08 실행, K8s 배포를 이 문서 PR의 통과 결과로 표시하지 않는다.

## 2026-10-29 로컬 개인 위키 커넥터 첫 수직 구현

- 사용자 결정: 로컬/개인/공유 분리, 개인 자동 동기화, 여러 PC·에이전트 충돌 보존, 병합안 사람 확인, 공유는 명시적 변경 제안. 공유 레벨은 미정이며 상시 실행은 먼 미래 범위로 제외했다. 개발자 하네스와 기존 에이전트 Desktop/Cowork 사용자가 대상이지 자체 Windows 제품 앱 개발이 아니다.
- 관련 요구사항: GOV-003·004, ACL-001·004~007·009·013·014, EDT-002·003, VER-005·007·009, REV-004~006, LIF-008~010, INT-001·002, CORE-002~007·009~012. 기존 요구사항·수용 기준·미검증 상태를 변경하지 않았다.
- 변경 파일: `scripts/wiki-connector/`의 protocol/store/service/dev-server/client/mcp/cli 및 실제 파일·HTTP·SDK/CLI 시험, 합성 example-config.json; package.json/lock, .gitignore, README, ARCHITECTURE, AGENT_INTERFACE, LOCAL_WIKI와 연결 설계/계획 문서.
- 실제 행동: JSON 작업본 원자 교체·잠금, 연결 중 직렬 자동 동기화와 재시작, 개인 공간 격리, 버전 CAS·중복 요청 방지, 충돌 세 버전과 해시 고정 병합안, 개인→공유 스냅샷 제안·검토자 승인·발행. MCP에는 공유 승인/발행·병합 확정 도구가 없다. 호스트 EOF에서 종료한다.
- 판단/기존 지식 영향: 기존 웹 데모와 지식 엔진은 그대로 보존했다. 파일 서버는 합성 loopback 검증용이며 운영 PostgreSQL/SSO를 대체하지 않는다. 개인 저장·공유 승격과 원본/파생 계보를 구분하며 기존 North Star·런타임 규칙 의미는 변경하지 않았다.
- 안전 선택: 권한·버전 metadata 확인 뒤 로컬 본문을 제공하므로 본문 반복 전송은 피하지만 권한 네트워크 호출은 남는다. 권한 불명확 시 열람/검색/충돌 조회를 차단한다. 로컬 보관은 반출이며 이미 복사된 평문 회수는 보장하지 않는다. 토큰은 환경변수로만 전달하고 redirect 금지·크기/시간 상한을 적용한다.
- 구현 한계: 단일 페이지 제안, 전체 최신 스냅샷 다운로드, 1 MiB HTTP 상한, 같은 문서 충돌의 보수적 수동 처리다. 일반 Markdown 폴더 편집·delta/paging·개인 fork rebase·기존 UI/다중 페이지 Ingest/Query/Lint 통합은 남아 있다. 운영 인증·ACL·DB·첨부/원본 조회·Windows 설치형 배포·실제 호스트 실기·의미/성능 효과는 미완료다. 완전한 오프라인 열람을 약속하지 않는다.
- 독립 리뷰: 다른 공간의 같은 ID가 draft/출처를 덮어쓰는 문제와 제출 직전 다른 기기의 개인 revision이 선택될 수 있는 문제를 실제 HTTP 회귀로 RED→GREEN 확인했다. 공간 충돌은 `PAGE_ID_COLLISION`으로 기존 draft를 보존하고, 제출은 `personalVersion`을 권한 갱신 전에 고정해 서버에서 CAS 검사한다. 미해결 Critical/Important 지적은 없다. 리뷰의 운영/포장/의미 품질 제외 항목은 아래 제약 그대로 남긴다.
- 최종 검증: 리뷰 수정 후 지원 Node 22.23.4에서 `npm test` 32 Vitest + 33 Node(커넥터 28개와 기존 모델 5개), `check:requirements` 251개, `build`, `git diff --check` 통과. 수정 전 Node 24 추가 회귀도 통과했다. 직접 추가한 SDK/Zod 라이선스 원문과 고지 보존, `npm audit --omit=dev` 취약점 0개를 확인했다. 최신 main 브랜드 통합 후 주 청크는 510.31 kB이며 기존 500 kB 경고 유형을 유지한다. 운영/Windows 검증으로 확대하지 않는다.

## 2026-10-29 이름 통일과 North Star 문서화

- 관련 요구사항: GOV-001·010, CORE-001~012, KNO-002·005·006·009·013·014, EVA-001~010. 기존 251개 요구사항/수용 기준과 35개 인수 시험 계획은 변경하지 않았다. 새 의미 품질 평가의 완료 상태도 올리지 않았다.
- 제품 기준: `docs/LLM_WIKI_CORE.md`에 원전/프로젝트 확장/현재 데모를 분리하고 Agent-Native Knowledge & Experience Platform 목표, 불변식·Non-Goals·판단 기준·명시 승인에 의한 변경 관리를 추가했다. `AGENTS.md`에 작업별 참조를 통합하고 `CLAUDE.md`는 공통 지침 참조만 남겼다.
- 평가/단계: `docs/EVALUATION.md`는 누적 대조 실험, KE-01~08, 계보·상충·시간·후속 에이전트 성공률의 **미실행 설계**다. `docs/ROADMAP.md`에 현재 격차와 P0~P3 평가 연결을 추가하고 기존 이행표를 보존했다. README에서 연결한다.
- 런타임 경계: `wiki/SCHEMA.md`의 기존 규칙은 유지했다. 장기 규칙은 비활성 설계 참조이며 현행 출력 계약·도구 권한·정책 버전을 확장하지 않는다. 활성화는 별도 구현/버전 변경/평가가 필요하다.
- 이름 변경 파일: package.json/lock, index.html, src/App.tsx·styles.css, src/adapters/repository.ts와 회귀 시험, src/domain/wiki.ts, scripts의 브랜드·모델·데모·배포 생성기, compose.yaml, .env.example, brand-kit 및 public/brand, 개발·모델·운영 문서에 `agent-knowledge-hub`를 적용했다. 외부 LLM Wiki 원전과 다른 프로젝트명은 유지한다.
- 업그레이드: 환경변수는 `AGENT_KNOWLEDGE_HUB_LLM_BASE_URL`, `AGENT_KNOWLEDGE_HUB_LLM_MODEL`, `AGENT_KNOWLEDGE_HUB_LLM_API_KEY`, `AGENT_KNOWLEDGE_HUB_DEMO_PORT`로 변경한다. 기존 환경 설정은 새 이름으로 갱신해야 한다. 브라우저 상태/테마는 새 저장 키로 이전하며 쓰기 실패 시 기존 값을 보존한다. 새 키가 우선이고 초기화는 이전 상태 키도 제거한다.
- 규칙 식별자: 앞선 이름 통일로 `agent-knowledge-hub/2`를 사용한다. 예전 식별자로 생성된 미결/승인 변경 집합은 발행 시 충돌하며, 최신 규칙으로 다시 생성·검토·승인해야 한다. 이를 우회해 발행하지 않는다.
- 검증: `npm test` 32 Vitest + 5 Node 통과, `npm run check:requirements` 251개 통과, `npm run build` 통과(브랜드 PR 통합 후 510.25 kB 주 청크 크기 경고), `git diff --check` 통과. K8s 문서 통합 시 Markdown 상대 경로 73개/32문서 존재 확인. 새 문구 존재를 검사하는 형식적 테스트는 추가하지 않았다. 독립 리뷰에서 일곱 질문에 답변 가능하며 수정 지적 없음을 확인했다.
- 브라우저: 로컬 실행기의 새 포트 변수로 실행하고 1440px/390px에서 제목/브랜드와 가로 넘침 없음을 확인했다. PR #2의 새 브랜드 통합 후에도 두 너비에서 이미지 로드·이름 잘림 없음(하단 이름 16px)을 다시 확인했다. 워드마크·README 배너 PNG도 전체 이름을 확인했다. 이것은 전체 모바일·접근성·제품 순환 검증이 아니다.
- PR 통합: 사용자 승인으로 K8s 설계 PR #1과 새 브랜드 PR #2를 main에 먼저 반영하고 최신 main을 통합했다. 새 Linked K 에셋·24개 아이콘·CSS·메타데이터·브랜드 ZIP 구조는 #2를 보존하고, 기존 상태/테마 이전·새 환경변수·규칙 식별자·North Star는 이 작업을 보존했다. #2의 당시 호환성 설명보다 이 절의 최종 업그레이드 안내를 우선한다.
- 남은 제약: 실제 모델 의미 종합, 지식 누적/에이전트 성능 평가, 서버 ACL/DB, API/MCP, 무인 정련, 시간/계보 모델, Docker/배포 실행은 이 작업에서 구현·측정하지 않았다. North Star 보호는 문서상 절차이며 CI 강제는 아니다. 도구 산출물은 커밋하지 않는다.

## 2026-10-29 개발환경·PR CI 보강

- 머지 준비 후속: 사용자 머지 승인 후 최신 main의 브랜드/로컬 위키 PR을 통합했다. `.gitignore`의 양쪽 제외 항목과 `wiki`/`wiki:mcp` 명령을 모두 보존하고, 전체 `test`에 기존 개발 도구 및 새 커넥터 회귀를 모두 명시 등록했다. 합성 로컬 위키 데이터도 Docker 컨텍스트에서 제외했다. Node24 `check`: Vitest32 + Node47(하위 테스트 포함), 요구사항251·빌드·HTTP smoke 통과. 최신 브랜드 기준 번들 경고는 510.31 kB다.
- 두 번째 main 통합: CI 대기 중 반영된 서버 기반 PR #6의 migration 회귀·서버 명령·사용량 UI를 보존했다. `check`에 DB 없는 서버 타입검사를 포함하고, 미적용 PostgreSQL CI 패치를 독립 서비스 job으로 반영해 최종 게이트가 서버 실패도 차단한다. 최신 Node24 `check`: Vitest35+Node48, 별도 폐기용 PostgreSQL17.6에서 서버26 통과 후 컨테이너 정리. 요구사항251·빌드/HTTP·actionlint 통과, 청크 경고511.20 kB. 과거 적용용 패치는 재적용하지 않도록 SERVER_FOUNDATION에 기록했다.

- 요구사항 연결: OPS-002·003·014, SEC-012, EVA-007의 개발 지원/회귀 기반. 기존 수용 기준·프로덕션 상태는 변경하지 않았다. 지식 편입/질문/점검·원본/권한/승인 불변식의 기존 회귀를 재사용하며 의미 품질/후속 에이전트 성능 개선을 주장하지 않는다.
- 변경 파일: `package.json`/lock, `.nvmrc`, `.npmrc`, `.editorconfig`, `.gitignore`, `.dockerignore`, `scripts/doctor.mjs`/시험, `scripts/smoke.mjs`/시험, `Dockerfile`, `nginx/default.conf`, `compose.yaml`, `.github/workflows/ci.yml`, PR 템플릿, README·DEVELOPMENT·TESTING·작업 계획.
- 개발 계약: Node 22.12+인 22.x 또는 24.x LTS/npm10+, 새 환경은24. 비지원 엔진 설치 차단, `npm run doctor`, `check`, `typecheck`, `test:watch`, `test:smoke`. 모델 키/DB/Docker 없이 기본 검사 가능. 기존 대량 포맷 부채를 앱 변경으로 섞지 않는다.
- CI: PR/main/merge queue/수동 이벤트, Ubuntu22/24·macOS24·Windows24, 고정 SHA Actions/읽기 전용 토큰·중복 취소·시간 제한, 정적 artifact 7일, Docker build/health/HTTP/항상 정리, 최종 `check` 게이트. 실제 운영 배포는 없으며 main 보호 규칙은 별도 관리자 설정이 필요하다.
- 실제 검증: Node22/24 `npm ci`/`check`(32 Vitest+19 Node, 251개 매핑·build·HTTP), 최소 Node22.12.0 `check`, Node25 설치 거부, Docker Linux aarch64 실제 빌드/health/HTTP/정리, actionlint·diff 검사 통과. Docker에서 발견한 webmanifest MIME 오류는 custom Nginx 설정으로 수정 후 동일 검사 통과. [PR #5](https://github.com/wontaeJeong/agent-knowledge-hub/pull/5)의 [Actions 40860406846](https://github.com/wontaeJeong/agent-knowledge-hub/actions/runs/40860406846)에서 네 OS/Node 조합+Docker+최종 게이트 6개 job 성공 및 artifact 업로드 확인. 독립 코드 리뷰 결함 없음·별도 진단/smoke14개 통과. 자세한 근거는 TESTING 참조.
- 운영 영향/제한: 앱 기능·지식 상태·권한/발행 로직은 변경하지 않았다. Compose 포트는 기본8080 loopback을 유지하며 환경변수로 변경 가능하다. 원래의 510.25 kB 빌드 경고·포맷 부채, 운영 서버/CD·실제 모델 품질·브라우저 E2E·부하/복구 검증은 남아 있다. Docker 기반 이미지는 기존의 가변 태그를 유지한다. 사용자의 마지막 지시에 따라 PR까지만 진행하며 머지하지 않는다.

## 다음 작업

### 2026-10-29 서버 기반·사용량 작업 인계

- 요구사항: CORE-002~004, ACL-001~005·009, REV-004~006, VER-005, SEC-009, OPS-004, GOV-009·OPS-006의 일부 구현. 기존 251개 상태/수용 기준과 35개 인수 시험 계획은 완료로 변경하지 않았다.
- 변경 파일: `server/` 서비스·저장소·마이그레이션 3개/DB 시험, `scripts/migrate.mts`, 시험 compose/CI, `src/domain/usage.ts`·집계 어댑터·대시보드·CSS·App 탐색, 패키지/라이선스, README·ARCHITECTURE·SERVER_FOUNDATION 및 캡처.
- 보안/발행: 권한 교집합과 연결 대상 실효 접근 검사, 승인 시 ACL 고정, 승인 후 source/base/body/policy/ACL 변경 차단, 현재 권한으로 replay·과거 제목 검사, SQL/성공 계측 실패 rollback. 독립 리뷰의 중요 결함 3건을 시험으로 재현하고 수정했다.
- 사용량: 실제 DB에 주체/작업/성공·실패/시각/ms 기록, 본인/검토자 workspace 범위와 UTC 7/30일 집계. 모델 토큰/비용은 미수집(null). 현재 데모 업무 UI/페이지뷰를 수집하거나 운영 사용량이라고 주장하지 않는다.
- UI: 데스크톱/모바일 19개 캡처를 PR에 첨부. 실측 시험 응답/미연결/UI fixture를 구분한다. 측정 화면 높이 1576/1782px, 첫 결론 264/334px, 그래프 글자 14px, 표 내부 스크롤을 확인했다.
- 최종 로컬 검증(Node 24.22.2/PostgreSQL 17.6): `npm test` 35 Vitest + 6 Node, `npm run test:server` 26개 통과. `check:server`, `check:requirements`(251개), `build`, `db:migrate`(재실행), `git diff --check` 통과. 주 청크 511.15 kB 크기 경고는 남는다. 서버 CI 확장은 현재 OAuth 토큰의 workflow 권한 부족으로 푸시가 거부되어 `docs/ci-server-tests.patch`로 분리했다. 기존 CI만 실행되며 서버 DB 회귀 자동화는 권한 있는 담당자가 패치를 적용해야 한다. SSO·실제 모델·업무 UI 서버 전환·K8s 배포/백업복원·운영 부하 검증은 미실행이다.
- 다음 작업: 실제 인증/그룹·UI/API 계약 연결, 반려/수정·재검토 운영 흐름, Query/Lint/작업 영속화와 나머지 1차 릴리즈 필수 게이트를 순차 구현한다. workspace 단위 잠금은 초기 선택이며 대규모 처리량을 보장하지 않는다.
- PR: https://github.com/wontaeJeong/agent-knowledge-hub/pull/6 . UI 캡처 19개 모두 PR 본문에 첨부하고 원격 이미지 응답을 확인했다. 병합은 사용자 승인 대기다.
- PR 생성 후 최신 `origin/main`의 확정 원본 Folio 심볼 변경(670f5a9)을 보존해 통합했다. 충돌은 TESTING의 양쪽 검증 기록을 모두 보존해 해결했다. 전체 35+6+26개 시험/251개 요구사항/타입/빌드를 다시 통과했고 최종 주 청크 경고는 511.20 kB다. 최신 심볼로 캡처 19개도 다시 생성했다.
- 사용자 머지 승인 후 PR #7의 로컬 개인 위키 커넥터(c03079d)도 보존해 통합했다. 패키지 시험 명령은 양쪽 시험을 모두 실행하며 lockfile의 의존성/버전을 합쳤다. Node 24.22.2에서 `npm ci`, 클라이언트 35개+Node 34개+서버 26개(총 95개), 요구사항 251개/서버 타입/빌드가 통과했다. 업무 UI 산출물 해시는 변경 전과 같아 캡처 19개는 계속 유효하다. 커넥터의 합성 파일 서비스와 PostgreSQL 기반 서비스를 이미 통합했다고 주장하지 않는다.

### 기존 후속 순서

1. docs/LLM_WIKI_CORE.md와 wiki/SCHEMA.md의 지식 누적 순환을 기준으로 사내 권한·자료 등급·UI 계약을 확정한다. Gate UI의 실제 경로와 지침을 확인해 어댑터로 재사용한다.
2. 원본·변경 집합·발행·인용·관계 메타데이터를 서버 저장소와 트랜잭션으로 옮긴다. 현재 localStorage를 인증된 서버 권한으로 대체한다.
3. 실제 사내 모델로 연속 편입·질문·점검의 익명화 평가셋을 실행한다. 오프라인 결과와 모델 평가 결과를 분리한다.
4. OpenCode/Claude Code의 배포 버전 fixture와 인증된 MCP 검색·읽기·등록·변경 제안을 공통 서비스에 연결한다.
5. 지속 작업·무인 일정·사용 결과 환류·권한 철회 전파와 전체 운영·보안·복구 게이트를 구현한다.

## 0.2 변경 기록

CORE-001~008의 일부 로컬 동작을 추가했다. 원본 기준 239개를 보존하고 CORE-001~012 추가 기준을 앱 로드맵에 함께 추적한다. 지식 컴파일 화면, 여러 페이지 변경 집합, 승인 내용 고정과 일괄 발행, 발행본 질문·고정 버전 인용, 답변 재편입, 실제 규칙 Lint, 선택적 실제 모델 중계 코드를 제공한다. 모델 오류·근거 오류는 반영하지 않는다. MCP·SSO·지속 DB·무인 일정·실제 사내 모델 평가의 완료를 의미하지 않는다. 검증 근거는 TESTING.md에 기록한다.

작업별로 요구사항 ID, 코드 변경, 도메인 및 통합 검증, 운영상 영향, 남은 제약을 이 문서 또는 연결 작업 기록에 갱신한다. 모든 요구사항의 원래 수용 기준을 보존한다. 모델·UI·백엔드를 동시에 대규모 변경해 검증 책임이 섞이지 않도록 변경 단위를 구분한다.

## 2026-10-29: 최초 K8s 릴리즈 설계 문서화

- 관련 요구사항: OPS-001~014, NFR-001~010, JOB-001~012 및 SEC/권한·발행 일관성 요구사항(기존 ID의 수용 기준은 변경하지 않음).
- 추가: `docs/adr/003-single-cluster-initial-release.md`, `docs/K8S_RELEASE.md`, `docs/SCALING_PLAN.md`. README·AGENTS·ARCHITECTURE·OPERATIONS에 참조 경로 추가.
- 내용: 동일 클러스터 STG/PROD 분리, 환경별 App 1/DB 1 목표, 운영 필수 게이트, 30,000 사용자에 대한 부하 측정·확장 조건 명시.
- 검증: 문서 변경과 기존 저장소의 현재 구현 대조. **K8s 배포·백업 복원·실부하/성능 검증은 수행하지 않음.** 제품 서버·SSO·DB·K8s 매니페스트는 계속 미구현.

## 상태 기록 양식

```text
요구사항 ID:
변경한 행동:
재사용한 사내 모듈과 실제 경로:
검증 명령 및 실제 결과:
권한·발행·복구 영향:
남은 미충족 조건:
다음 담당 역할:
```

## 2026-10-29 브랜드 갱신

제품 브랜드를 agent-knowledge-hub으로 확정했다. 기존 브랜드 에셋 54개 전체를 교체하고 총 74개 파일의 브랜드 팩을 제공한다. Linked K 심볼, 라이트·다크·단색·타일, 폰트 윤곽이 포함된 워드마크, 배너·공유 카드·프로필·빈 상태 일러스트, 24개 커스텀 UI 아이콘을 새로 작성했다. src/ui/brand-icons.json을 앱 BrandIcon과 에셋 생성기가 공유한다. public/brand, HTML 메타데이터, 앱 표시명, 패키지명과 README를 갱신했다.

요구사항 연결: 일반 위키 UI·사내 컴포넌트 이식·접근성에 관한 기존 수용 기준을 유지하며, 새 프로덕션 기능의 완료로 승격하지 않는다. brand-kit/asset-manifest.json에 개별 파일의 SHA-256을 기록하고 npm run brand로 다시 생성한다. 기존 localStorage 키·모델 환경변수 FOLIO_*·정책 ID folio-wiki/2는 저장 데이터와 실행 설정의 호환성을 위해 유지한다. 앱 표시 브랜드와 내부 호환 식별자를 구분한다. 포장 스크립트는 새 이름을 사용하고 전체 패키지 안에 중복 아이콘 ZIP을 넣지 않는다.

검증: 기존 도메인 28개와 모델 중계 5개, 251개 요구사항 연결 검사, TypeScript·프로덕션 빌드, SVG 파싱·PNG 크기·ICO 다중 크기·manifest 경로와 SHA-256 검사를 수행한다. 최종 실행 결과와 브라우저 확인은 docs/TESTING.md에 기록한다.

## 2026-10-29 확정 심볼 복원

사용자가 최초 Folio Wiki의 기존 아이콘을 그대로 쓰기로 결정했다. 육각형·펼친 책의 원본 path와 비율·선 두께·plum 색상을 복원하며, 이름은 agent-knowledge-hub으로 유지한다. 이전 Linked K 및 후속 캐릭터 후보는 현재 확정 브랜드가 아니다. 생성기·앱의 hub 아이콘·favicon·워드마크·배너·공유 카드·미리보기를 원본 심볼 기준으로 갱신했다.

이 변경은 UI 식별과 사내 브랜드 일관성을 개선한다. 지식 편입·질문·점검 순환·권한·근거·평가 계약은 변경하지 않는다. 기존 지식 데이터·모델·운영 문서의 최신 변경을 보존했다. 에셋 원본 대조와 재생성·빌드로 확인하며 지식 품질이나 운영 완료에 관한 새 주장을 추가하지 않는다.
