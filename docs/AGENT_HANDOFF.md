# 에이전트 인계

## 운영 기능 체크포인트 — 부분 구현

- 후속 통합: PR #18의 배포된 migration 009를 보존하고 기존 브랜치의 접근 이관 migration을 010–015로 순서대로 조정한다. API 키와 기존 서비스 자격증명의 범위·현재 권한을 각각 검사하며, 원본 반출 승인과 모델 사용량 계측을 함께 유지한다. 이 통합의 최종 테스트·CI 결과는 PR을 기준으로 확인한다.
- SystemOne은 `AGENT_KNOWLEDGE_HUB_SYSTEMONE_DESTINATION_ID`에 등록된 정확한 endpoint와 `assessment` 목적의 모든 원본별 명시 승인이 없으면 전송을 거부한다. 결과 반환 전 현재 계보·권한·정책도 다시 확인한다. 이는 사내 승인이나 실제 모델 품질 검증이 아니다.
- 법적 삭제의 임시 안전 경계: 공간에 API 키·장치·모델 계측 기록이 있으면 자료별/전체 삭제와 복원 재적용을 차단한다. 삭제 이력이 있는 공간의 새 키·장치 발급과 계측도 보수적으로 차단한다. 이는 자격증명 취소·비식별화, 계측 보존과 동시 요청·복원 경합 처리의 완성본이 아니며 후속 PR에서 실제 지원을 구현해야 한다. 삭제가 차단되면 성공이나 전체 삭제로 보고하지 않는다.
- 관련 범위: ACL/IAM, COL, EDT, VER, JOB, SEC, OPS와 CORE 지식 순환. 기존 요구사항의 전체 수용 완료가 아니다. 변경은 `server/`의 접근·작업·정책·편입·보존·운영 모듈과 `src/operational/`, K8s 배포 도구 및 관련 테스트에 걸친다.
- Node 24 환경에서 `npm run check`와 파일별 독립 PostgreSQL DB를 사용하는 `npm run test:server` 83개 파일이 현재 통합 트리에서 통과했다. 이는 이후 main 통합 및 최종 CI 결과를 대체하지 않는다. 초안 복구 경로는 실제 서버 핸들러에서 인증·CSRF 뒤 연결하고 회수 검사를 유지했다.
- 질문·버전 메타데이터·협업의 일부 호스트 연결, 보존의 주기 실행 및 전체 삭제 범위, 수집기 권한, 실제 브라우저·최종 이미지/IdP·운영 인수는 미완료 또는 미검증이다. Owner가 확인되지 않은 기존 공간은 격리되므로 기존 3역할 호환성에 제한이 있다. reviewer를 Owner로 추정하지 않는다.
- 실제 DeepSeek 평가 `evaluation-05a7d023183e5e89`: 33개 배정 중 32개 완료, 1개 시간 초과, 인용 안전성 실패 3개, 합성 라벨 일치 10개, 종료 코드 1이다. 품질 및 업무 효과는 미확인이다.

## 2026-10-30: 최신 main K8s 운영 사이트 도구 내용 통합

- 내용 출처: `fb8298acca1987fb5f62a62a260534f29bc20594`(PR #15). 활성 merge 기준 `a9cfcdbdd5ce842e07e77def277ddb3132187c15` 이후 16개 파일의 추가분을 현재 작업에 적용했다. 이 기록은 내용 반영이며 최신 커밋의 ancestry 병합 완료 선언이 아니다. coordinator가 기존 merge 완료 후 실제 최신 커밋을 병합해야 한다.
- OPS-001~014, NFR-001~010, SEC-007~013, JOB-007 관련: `prepare-site.mjs`의 STG/PROD 비밀 없는 site·Ingress/제한 egress·Quota·digest 생성, `deploy-site.mjs`의 Secret 사전 검사·동일 이미지 승격·DB→migration→App 순서, `release.mjs`의 namespace/DB/TLS/NetworkPolicy 가드를 유지한다. 기존 전체 운영 후속 구현·테마·브랜드 기록은 보존했다.
- 호환: site migration은 공통 `release.mjs` factory로 `migrate:server`와 DATABASE_URL/선택적 ACCESS_BOOTSTRAP_JSON만 전달한다. 앱의 모델·감사 Secret이나 PVC를 상속하지 않는다. Secret 환경변수 allowlist를 명시된 운영 키로만 확장하고 감사/서명/metrics 강도·독립성 및 사용 시 backup keyring 일치를 검사한다. 권한·issuer·기능·목적지 registry 정책을 Secret으로 덮어쓸 수 없다.
- site는 base의 blob/audit/backup PVC를 환경별 namespace에서 상속한다. DB·backup staging·blob·audit·backup 총 5 PVC/45Gi에 맞춰 synthetic fixture와 예제 quota를 60Gi로 수정했다. StorageClass는 DB와 일반 PVC에 적용한다. 이는 실제 용량 보증이 아니다. 선택적 명시 registry는 실제 코드 계약의 주소/용도/분류만 허용하며 기본 `[]`다. egress/업로드 자체는 원본 반출 승인이 아니다.
- CI K8s job은 `scripts/k8s/test.mjs`로 오직 native Kind·전용 DB가 필요한 `operations-backup-db.test.mjs`만 제외하며 미실행을 출력한다. 나머지 operations/TLS/format/release 시험을 포함한다. 해당 Kind 게이트는 별도 실제 실행 근거로만 보고한다. CI aggregate `check`에 k8s를 포함한다.
- 이 단위의 실제 검증: Node24 `node scripts/k8s/test.mjs` **38/38 통과**(대상 upstream deploy/prepare/순차 배포 시험과 기존 release/manifests/local-secrets 및 나머지 operations 포함). native Kind·전용 DB 시험 하나는 runner가 명시적으로 미실행 표시한다. 4개 실행 모듈 `node --check`, `git diff --check` 통과. synthetic STG/PROD 생성물의 production guard 모두 통과, 미설정 STG/PROD 템플릿 모두 거부. 렌더된 환경별 4 일반 PVC + DB claim의 namespace/StorageClass·5 PVC/60Gi quota·기본 빈 registry를 별도 assertion으로 확인했다. 최신 `productionFailures` 가드 본문과 보조 함수는 upstream과 byte-identical임을 확인했다. 실제 클러스터 배포·IdP/TLS/CNI 집행·운영 인수·최신 GitHub CI 통과를 이 내용 반영으로 주장하지 않는다.

## 2026-10-30: 1차 K8s 운영 사이트 생성/검증/순차 배포 도구 (PR 작업)

- 기준: 최신 main `31b7d9a`의 서버/OIDC/DB/Kustomize 구조 유지. OPS-001~014, NFR-001~010, SEC-007~013, JOB-007 등 운영/영속성 계약에 대한 기능 보강이며 기존 인수 상태는 변경하지 않는다.
- 구현: `scripts/k8s/prepare-site.mjs`로 STG/PROD 비밀 없는 오버레이·Ingress controller ingress·OIDC/model 제한 egress·Quota·digest 생성, `deploy-site.mjs`로 정적 리소스/실제 Secret/동일 이미지 승격 점검과 DB→migration→App 순서 보장. `release.mjs`의 네임스페이스/DB/Ingress/NetPol 미비 거부. 예제·CI synthetic fixture 및 테스트 추가.
- 보안/격리: Secret 값을 git/파일 출력하지 않으며 앱 DB URL과 DB password 일치 검사, PROD 명시적 승인 필요. 실사용 DNS/인증서, 실제 네트워크 집행, 백업 복원, 서버 측 인수·부하는 추가 검증 필요.
- 검증: CI에 K8s unit + Kustomize 렌더링/production guard 테스트 추가(실행 결과는 GitHub Actions에서 확인). 로컬 도구 환경의 kubectl/사내 클러스터·실제 운영 배포 시험을 수행했다고 주장하지 않는다.

## 2026-10-30 전체 운영 기능 후속 구현 — 진행 중

**부분 구현을 전체 완료로 보고하지 않는다.** [계속 실행 계획](superpowers/plans/2026-10-30-complete-operational-workflows.md)의 파일·작업 DB를 분리해 진행하고 있다. 기본 체크아웃은 `main`, 후속 작업은 기존 전용 워크트리의 `feat/complete-operational-workflows`다.

- 공간 권한: `389c7c1`의 `server/access/`, migrations006–009, core/runtime 연결은 개인/팀 소유권·5역할·팀/접근 그룹·수락형 초대/소유권 이관·정책 CAS·지정된 독립 인간 검토·현재 권한과 교차하는 제한 토큰·원본별 반출 정책을 구현한다. reviewer를 Owner/Admin으로 자동 승격하지 않는다. 미지정 레거시 공간은 격리하며 `ACCESS_BOOTSTRAP_JSON`으로 검증한 주체를 명시적으로 채택한다. ADR 004/005의 조직 승인이나 사내 권한 인수 완료를 뜻하지 않는다.
- 작성·협업: `server/workflows/`, migration020, `src/operational/workflows.tsx`는 개인 초안 revision CAS, 승인 전 발행본과 분리한 편집/버전 복원 제안, 트리 순환 방지·속성·보호·보관/휴지통/현재 권한 복구, 버전·정확한 문단 발췌에 고정한 댓글/수정/삭제/해결, 구독·멘션·현재 권한 알림/환경설정, 즐겨찾기/최근 조회, 개인 템플릿, 접근 요청, 불변 원본 정정·철회를 제공한다. 템플릿의 원본 페이지·버전·독자 제한도 제안까지 유지한다. 원본 정정의 독자 재검사·정정 계보 기록을 등록 트랜잭션 안에서 수행하고 새 본문은 미검증으로 시작한다.
- 웹: `src/operational/access.tsx`와 앱/API 연결에 공간 선택·권한 경로·개인/팀 공간 생성·초대/이관·접근 그룹·grant/회수·공개 범위·독립 검토 정책·수신자 지정 고정 버전 공유·제한 토큰을 추가했다. 선택 공간은 `X-Space-Id`이며 전환하면 보호 화면/입력을 새 컴포넌트로 분리한다. 초기 공간이 없는 사용자는 내용 API를 호출하지 않고 공간 생성부터 시작한다. 문서·댓글·공유 링크는 불변 공간/문서 ID와 현재 권한으로 열며 로그인 복귀 힌트에는 ID만 저장한다. 브라우저 저장 차단 시 안전한 고정 앱 복귀를 유지한다.
- 에이전트/개인 커넥터: `server/agents/`, migration023, 기존 `scripts/wiki-connector/client.mjs`를 연결했다. `/api/v1/agent/{search,read,context,artifacts,changesets,outcomes}`, `/api/v1/agent/mcp`, `/api/v1/connector`는 같은 서버 신원·현재 ACL·원본/입력 계보·core 제안 서비스를 사용한다. SDK 도구는 `wiki_search/read/get_context/submit_artifact/propose_change/report_outcome`이며 승인·발행 도구가 없다. 원본/제안/성과 요청 영수증은 도메인 트랜잭션과 함께 저장하고 재시도도 현재 접근을 재검사한다. 컨텍스트 예산은 보수적인 UTF-8 바이트 상한이며 모델 tokenizer의 실제 token 수로 표시하지 않는다.
- 개인 동기화는 PostgreSQL의 사용자별 작업 revision과 기존 연결 중 동기화·충돌 보존 경로를 사용한다. 정확히 선택한 revision을 제안 commit에서도 검사하고 발행본은 바꾸지 않는다. `local.copy`는 명시 위임과 모든 원본의 현재 반출 정책을 함께 요구한다. 서비스 실패 시 기존 로컬 캐시를 열지 않는다. 상시 로컬 daemon은 추가하지 않는다. 에이전트 성공/실패 보고는 `verified:false` 관측이며 `agent_review_signals`로 재검토를 요청할 뿐 독립 실행 증거나 공식 지식으로 자동 승격하지 않는다.
- 관련 기준: GOV-003/004, IAM-002/005/009/010, ACL-001~014, EDT-001~007/011, VER-001~010, REV-001~009, SHR-001~009, LIF-001~004/007, INT-001/002/006, CORE-002~011과 KI-01/02/04/05/06/07의 구현 경로다. 원래 수용 기준·상태를 이 설명만으로 accepted로 바꾸지 않는다.
- 실제 실행 근거: 17:38의 공유 트리에서 `npm run check`(전체 npm 시험·251개 연결·서버 타입·빌드·정적 HTTP smoke)와 real-DB `vitest run server --maxWorkers=1` 220/220건을 실행했다. 이후 추가한 원본 정정 경쟁/검증 계승 회귀를 포함한 최종 결과는 이어지는 실행 기록과 PR의 최종 head CI를 기준으로 한다. MCP SDK1.32.2 클라이언트와 기존 로컬 커넥터가 실제 loopback HTTP/DB/임시 작업 디렉토리에서 동작하는 시험을 추가했다. 실제 OpenCode/Codex/Desktop 제품 호스트·Windows 검증으로 확대하지 않는다.
- 후속 연결 검증: 22:08의 작성/편입 API·권한/DB·SDK/커넥터·세션/프로브·대기열 접수/조회/취소 대상 19파일 **104건 통과**, `npm test`의 프런트엔드76건+Node48건·요구사항251개 연결·빌드 통과. 실제 서비스 요청은 202 접수와 실행 결과를 구분하고 원래 주체·살아 있는 부모 세션/현재 디렉터리·전체 입력 계보·fence를 효과 commit 직전에 검사한다. 이전 MCP 경로도 운영 설정에서는 직접 모델을 실행하지 않는다. 저장 답변 재열람도 질문자와 현재 전체 입력 권한을 재검사하고 내부 ACL은 응답하지 않는다. 전체 서버 타입 검사는 별도 작업 중인 `operations/released-imports.ts:160` 진단이 남은 시점을 포함하므로 위 대상 검증을 전역 최종 통과로 표시하지 않는다.
- 실제 모델 평가는 `deepseek-flash` 합성33개 배정 중32개 완료/1개 시간 초과/3개 인용 안전성 실패였다. 고정 합성 라벨 일치는10개이며 실제 업무 성공률이나 지식 활용 효과로 해석하지 않는다. 비용/토큰의 불완전 합계는 null로 보존했고 평가 종료 코드1을 통과로 바꾸거나 정답을 수정하지 않았다.
- 계속할 작업: 파일/blob·수집/가져오기/내보내기, 지속 작업/일정/예산/실제 모델 계측, 주장·시간·경험 정련/고정 대조 평가, DB+blob 일관 백업/삭제 재적용/감사 외부 보호/관측과 운영 UI는 별도 모듈 작업 및 최종 runtime 통합·실제 kind 검증이 진행 중이다. 현재 화면·서비스가 있다는 이유로 모든 251개 수용 조건·사내 운영 인수나 지식/후속 에이전트 성능 개선을 완료로 표시하지 않는다. 실제 새 브라우저 390/1440px·최종 이미지/IdP/모델/10사용자 혼합 부하·독립 보안 리뷰·PR/CI/머지는 계속 실행해야 한다.
## 2026-10-30 PR #14 테마 대응 브랜드, 최신 운영 콘솔과 통합

- PR #16의 운영 콘솔·관리 목업·대시보드를 보존하고, 기존 PR #14를 최신 main에 통합했다. 랜딩·데모·`ConsoleShell` 브랜드 마크는 모두 원형을 유지한 `BrandMark` SVG 및 의미 기반 색상 토큰을 사용한다. 마크의 원본 경로/8·6 stroke는 `src/ui/brand-mark.json`을 공유한다.
- `src/main.tsx`는 운영/목업 `preview` 진입 로직을 유지하면서 저장된 테마와 동적 파비콘 반영을 추가했다. 원래 PR의 `src/operational/App.tsx` 헤더 변경은 새 구조의 `ConsoleShell`을 사용하도록 대체했다. 기존 서버·권한·편입·위키 정책 및 251개 요구사항 상태는 변경하지 않는다.
- 런타임 SVG와 favicon만 자동 색 변경한다. PNG·OG·ICO·배너는 고정 Plum 원본이고, 다른 팔레트 선택 UI는 별도 작업이다. 검증은 새 병합 커밋의 CI 결과를 기준으로 판단한다.

## 2026-10-30 에이전트 운영 콘솔 · 누락 관리 UI 목업

- 사용자 요청: 에이전트에게 지식을 제공하는 환경을 중심으로 웹 UI·필수 관리 누락을 재점검하고 미구현 기능은 목업으로 제공, 의미 있는 대시보드·목업 제시, 최신 코드 기준 PR/머지까지 진행. 추가 질문 없이 판단하도록 위임했다.
- 기준: 처음 `e89921c`에서 시작했고 작업 중 병합된 최신 `origin/main@31b7d9a`를 통합했다. 실제 ImportWorkbench/AccessManager, Organization·Team/공간5역할/초대, 독립 검토 자격·분류와 서버 편입 worker를 보존한다. 최신 구현을 과거 설계 문구 때문에 목업으로 덮지 않는다.
- 구현: 공통 그룹별 사이드바/모바일 접기·hash 직접 링크/뒤로·앞으로/테마·본문 이동, 운영 개요의 접근 지식·검토/발행 대기·본인 작업/실패·조치 링크·7일 호출, 정확한 계측/분모·미점검/미수집/미평가 경계. 기존7개 업무 화면과 실제 자료입력/접근관리를 보존했다.
- 독립 `/?preview=1`: 네트워크/로그인 없는 메모리 API/관리 상태. 사용자/초대/역할·세션 영향, 공간/소유/공개, 서비스 주체·허용 범위 토큰 메타데이터/폐기, 연동/예약·예산/중지, 검토·공유/반출, 초안/복원/보관/휴지통·첨부/협업, 알림/감사·복구, 평가/성과 환류를 시연한다. 일부 동작은 설명·확인 시나리오이며 실제 기능 성공으로 표시하지 않는다. 251개 원 요구사항 검색/25건 페이지·수용 기준·탐색 경로를 제공하며 기준/운영 상태를 올리지 않는다. [계약/한계](AGENT_CONSOLE.md).
- 변경 파일: `src/entry.ts`, `src/main.tsx`, `src/operational/App.tsx`, ConsoleShell/Overview·console.css, preview adapter, management state/ManagementPreview/PreviewDialog/ConsoleTable/FeatureCoverage/ImportPreview와 테스트, `UsageDashboard.tsx` 계측 설명, 이 인계/README·설계/계획·화면 계약과 캡처.
- 관련 ID: GOV-001/003/005/009, IAM-001~011, ACL-002/010/011, SHR-001~012, EDT/VER/LIF의 편집·복원/보존·반출, REV-001~009, MGR/JOB/INT/SEC/OPS 관리·관측, EVA-001~010, UX-001~008, CORE-002~012. 화면 연결/목업은 해당 ID의 전체 수용 기준 충족 증거가 아니다. 기존251개/35개 인수 시험과 North Star·런타임 규칙 의미는 보존한다.
- 독립 리뷰: 중요3건(늦은401, 목록실패의0건표시, 초대취소→중지→활성화 우회)을 실제 RED→GREEN으로 수정했다. 이전 세션의 늦은 목록 응답도 무시한다. 최신 편입 worker와 별도 예약 유지관리의 범위 오인을 수정했다. 브라우저에서 발견한 dialog Tab 순환/Escape/초점복귀도 수정 후 재실행했다.
- 실제 로컬 검증: Node24.22.2 `npm ci`/`npm run check` 통과. 클라이언트61개+Node48개+파서/정리15개, 요구사항251개, 서버 타입 검사, 빌드·HTTP smoke. 390/1440px 18화면(36레이아웃),62 UI assertion, API요청0/pageerror0. 실제 앱 라우트는 합성 HTTP 계약으로 AccessManager·ImportWorkbench/0건집계 보존7검사, 세션/오류3검사를 통과했다. [원시 결과·화면·동일fixture 전후](pr-assets/agent-console/README.md).
- 전후: 최신main과 같은244호출fixture의 실제 앱 사용량 화면, 모바일 첫결론779→522px/문서2738→2616px, 데스크톱581→380px/문서2280→2145px. 그래프14px·표행53.75px 유지. 새 개요 첫판단232px/369px(데스크톱/모바일). 화면 레이아웃 비교이며 지식/에이전트 효과나 성능 개선 주장이 아니다.
- 남은 한계: 전역 계정/세션 관리·서비스 주체/Bearer·수신자grant·예약 유지관리·범용편집/공유/수명주기·알림/운영 제어는 추가 서버 연결/검증 필요. 이 작업의 브라우저 검증은 실제 사내SSO/DB/LLM·운영 인수나 전체 접근성 인증이 아니다. PostgreSQL/다중OS·Docker 회귀는 PR의 실제 CI 결과를 따른다. PR/머지 결과는 후속 원격 기록으로 확인한다.

## 2026-10-30 PR #12와 공개 랜딩 PR #13 통합

- 최신 `main@e89921c`를 PR #12에 병합했다. `server/runtime/auth.ts`의 충돌은 Organization/개인 공간 권한 처리에 필요한 import와 공개 랜딩의 `workspaceHref` import를 모두 보존해 해결했다. OIDC 로그인 성공 후 `/?app=1`로 복귀하며, 자료 편입·조직/Team/공간 권한 동작은 유지한다. 이 인계 문서의 두 작업 기록도 모두 보존했다.
- 관련 기준: GOV-001/003, ACL·INT·SEC 및 CORE 순환. 요구사항·North Star·런타임 위키 규칙의 의미는 변경하지 않았다.
- 통합 상태에서 `npm ci`와 `npm run check`를 통과했다. 클라이언트 43개, Node 회귀 48개, 편입 순수 15개, 251개 요구사항 연결, 서버 타입 검사, 프로덕션 빌드와 정적 HTTP smoke를 확인했다. `git diff --check`도 통과했다.
- PostgreSQL/OIDC 통합과 OS·Node 매트릭스·Docker 회귀는 이 병합 커밋의 GitHub CI를 기준으로 확인한다. 이번 충돌 해결이 실제 사내 IdP·모델 의미 품질·운영 인수를 새로 검증했다는 뜻은 아니다.

## 2026-10-30 웹 자료 편입과 실제 조직 권한 구현 (구현 PR #12)

- 사용자의 추가 지시: 이전 열린 PR 모두 머지, 설계뿐 아니라 실제 기능 구현·PR. #11을 main@1e521db1에 squash merge했다. 이번 변경은 그 뒤의 구현이다.
- 실행 계약: [IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md). 개인 붙여넣기/파일 업로드, 안전한 파싱, 영속 worker/재개/취소, 기존 위키와 모델 정리, 원본 공개 검토, 독립 지식 검토/원자 발행, 같은 REST/SDK MCP 경로를 구현했다. 개인 Owner는 본인 전용 위키 저장 경로를 사용한다.
- 실제 권한: Organization Owner/Member, Team, 개인/조직 공간, 직접/Team 5역할·만료·실효 경로, 수락/만료/취소 초대, 마지막 Owner, 지정 검토자, 감사·철회·명시적 기존 공간 이관. OIDC 그룹은 이관 후 제품 grant를 덮어쓰지 않는다. 원본 ACL은 Owner에게도 상한이다.
- 주요 파일: server/imports/*, server/access{,-http,.test}.ts, migrations/006·007, runtime auth/http/mcp/model, repository/publication, domain imports/access, 운영 UI ImportWorkbench/AccessManager. 초기 App1/DB1에서 원본 조각은 제한된 PostgreSQL bytea로 보관하며 별도 broker/object store를 필수화하지 않는다.
- 관련 요구사항: COL-002/005/012/013, JOB 지속 작업, GOV/ACL/SHR/REV/VER/INT/SEC/OPS와 CORE 순환. 기존 251개 요구사항·35개 인수 시나리오는 변경하지 않았다. North Star·wiki/SCHEMA.md 의미도 변경하지 않는다.
- 현재 로컬 근거: npm run check 통과(기존 테스트 + 편입 순수 15개, 서버 타입/빌드/요구사항/정적 smoke), PGlite 보조 DB에서 새 편입/HTTP/SDK MCP·접근 관리 회귀 24개 통과. 실제 PostgreSQL 첫 CI는 116개 중 115개 통과 후 기존 /me DTO 호환성 기대 한 건으로 실패했고, 미이관 공간의 응답 형태를 보존해 수정했다. 개인 저장·OIDC 회수·Triage/사용량 회귀를 추가했다. 최종 PG CI는 PR 커밋 상태를 따른다.
- 의미 품질은 실제 외부 LLM/실사용 자료 대조로 아직 측정하지 않았다. 브라우저 Chromium 153에서 실제 웹 붙여넣기→서버 분석→개인 정리→별도 원본 공개 검토→독립 지식 승인/원자 발행→독자 열람을 통과했다. 1440px/390px에서 가로 넘침/JS 오류가 없었고 캡처·JSON 증거는 docs/pr-assets/ingestion에 둔다. QA 모델은 결정적 계약 fixture다. Company/Guest/Public·범위 Bearer/서비스 주체·실제 로컬 커넥터 통합·전체 251개 구현/운영 인수 완료라고 표시하지 않는다. Organization 관리 전환·Team 생성/멤버 추가/공간 Write 부여도 같은 실제 UI에서 확인했다. 500개 발언의 원문 근거를 청크 통합 후에도 보존하는 회귀를 추가했다. 아래 이전 인계는 당시 변경 범위의 기록이다.

## 2026-10-30 공개 랜딩과 Memory·RAG·Wiki 역할 안내

- 사용자 요청: 웹 첫 진입에 랜딩페이지를 두고 왜 위키를 쓰는지, Memory·RAG와 무엇이 다른지 명확히 설명한다. 기준 `main@1e521db`에서 별도 브랜치로 구현하며 병렬 진행 중인 웹 편입/권한 PR의 완료를 전제하지 않는다.
- 화면: 기존 브랜드 심볼/plum 토큰의 라이트·다크 소개, 목적·원본→연결 지식 예시, 역할 비교표, 일주일치 대화의 Memory/RAG/Wiki 선택형 결과, Ingest→Review→Query→Lint & Feedback, 근거/권한/사람·에이전트 원칙, FAQ와 시작 버튼. 실제 처리 결과/장기 목표와 현재 기능을 구분한다. 새 안내 계약은 [LANDING_PAGE.md](LANDING_PAGE.md).
- 진입: `/`는 로그인·API 없이 소개를 표시한다. `/?app=1` 서버 UI와 `/?demo=1` 합성 시연은 각각 지연 로드한다. 기존 데모 hash 경로를 유지하고 OIDC 성공 후에는 고정 `/?app=1`로 복귀한다. 원본/지식/ACL/승인/발행 엔진을 변경하지 않으며 루트 주소 자체가 권한을 부여하지 않는다.
- 변경 파일: `src/landing/`, `src/entry.ts`와 테스트, `src/main.tsx`, `index.html`, `server/runtime/auth.ts`의 성공 redirect와 기존 DB 회귀 assertion, 기존 명시 데모 테스트명, README·ARCHITECTURE·OPERATIONAL_SETUP·이 인계 및 화면 계약/증거.
- 관련 기준: GOV-001, CORE-002~007·009의 목적과 순환을 사람이 이해하도록 설명한다. 기존 251개 요구사항/운영 인수 상태를 완료로 바꾸지 않는다. 새 지식·후속 에이전트 성능 효과를 주장하지 않고 EVALUATION의 대조 실험 대상으로 유지한다. North Star·런타임 규칙의 의미는 변경하지 않았다.
- 실제 검증: Node 24.22.1/npm 11.9.0에서 `npm ci`, `npm run check` 통과(클라이언트 43개 + Node 48개, 251개 연결 검사, 서버 타입 검사, 빌드·정적 HTTP smoke). 새 테스트는 공개 렌더링의 API 미호출/앵커/CTA와 명시 진입 경계를 검증한다. `git diff --check` 통과.
- 브라우저: production dist + Chromium153에서 320/390/768/1440px의 페이지 가로 넘침 없음, 소개 API/앱 청크 미요청, 선택 예시·Enter·FAQ·테마/저장 차단·모바일 표 내부 스크롤, 서버 로그인 안내(합성401)·데모/hash 이동을 확인했고 pageerror는0개다. [캡처와 고정 결과](pr-assets/landing/README.md).
- 제한: 브라우저의 보호 앱 진입은 합성401로 확인했다. 실제 IdP/DB 로그인·운영 배포·모델 의미 품질·SEO·전체 접근성 인수를 로컬에서 새로 검증한 것은 아니다. OIDC 성공 redirect assertion은 PR CI의 PostgreSQL 회귀에서 실제 실행한다. 클라이언트 렌더링과 query 기반 앱 진입을 유지한다. GitHub CI 결과는 PR의 실제 상태를 따른다.

## 2026-10-30 로컬·개인·팀 GitHub식 권한 설계 (문서만)

- 사용자 요청: 기존 로컬/개인/팀(공유) 컨셉에 GitHub식 권한을 설계하고 PR로 제출한다. 이 작업은 설계 제안이며 런타임 권한 구현·운영 인수·자동 머지 요청이 아니다.
- 기준: `main@ec148ef9`의 실제 OIDC·DB 세션, 3역할·자료 allowlist·전체 모델 입력 계보·승인 ACL 검사를 확인했다. 합성 로컬 커넥터와 운영 서비스 통합은 아직 미완료다. 과거의 서버 미구현 설명으로 최신 코드를 판단하지 않는다.
- 새 문서: [ACCESS_CONTROL.md](ACCESS_CONTROL.md)와 [ADR 005](adr/005-github-style-access-control.md). 로컬 위치/개인·팀 소유권/Private·Team·Company/공간별 Read·Triage·Write·Maintain·Admin을 분리한다. 팀 Owner/Member·접근 그룹·기본 none·자료 제한·정제본 공개·수신자 한정 공유·개인 revision 제안·독립 사람 검토·토큰 상한·철회/소유권 이전·사용량/관리 UX를 정의한다. ADR 005는 **Proposed**이며 ADR 004의 상태나 North Star 의미를 변경하지 않는다.
- 이관: 현행 `workspaces` 공간 ID와 원본/본문 allowlist를 보존한다. reviewer를 Admin/팀 Owner로 자동 승격하지 않으며 구승인/구세션·토큰의 재검토/재인증, OIDC 재로그인의 grant 복원 방지, 소유권 불명 자료 격리·쓰기 차단·호환성/복구 검증을 요구한다.
- 연결 파일: README·AGENTS·ARCHITECTURE·SECURITY·LOCAL_WIKI·KNOWLEDGE_INTEGRATION·AGENT_INTERFACE·API_CONTRACT·ROADMAP과 이 인계 문서. 제안 API 경계와 구현 순서를 추가했다. 앱/서버/마이그레이션/패키지/워크플로·런타임 `wiki/SCHEMA.md`는 변경하지 않았다.
- 관련 기준: GOV-003/004/005/009, ACL-001~014, SHR-001~012, REV-002~006/009, VER-005/009, INT-001/002/006, LIF-008/010, SEC-009/010/011, OPS-004, CORE-002~006/009. 기존 251개 요구사항·35개 인수 시나리오의 내용/수/미검증 상태와 운영 작업표는 그대로다. AC-01~24는 기존 기준을 구체화하는 **미실행 설계 사례**이며 제품 요구사항/통과 결과 수에 합산하지 않는다.
- North Star 판단: Ingest→Query→Lint·질문 재편입·개인 파생본이 같은 원본/현재 권한으로 기존 지식을 갱신하도록 경계를 정의한다. 독립 검토·근거 교집합·응답/발행 직전 재검사를 유지한다. 문서/동기화 수와 지식/에이전트 성능 개선을 혼동하지 않는다. 의미 품질/후속 업무 효과는 EVALUATION의 대조 실험 대상이다.
- 실제 로컬 검증: Node 24.22.1/npm 11.9.0에서 `npm ci`와 `npm run check` 통과. 클라이언트 40개+Node 48개, 251개 요구사항 연결, 서버 타입 검사·빌드·정적 HTTP smoke 통과. 문서 상대 링크·Markdown 표 구조·24개 AC ID 연속성·참조 요구사항 ID·`git diff --check`를 확인했다. 새 문구를 검사하는 영구 테스트는 추가하지 않았다.
- 제한: 새 5역할·팀/그룹/수신자 grant·독립 검토·Bearer/서비스 주체·개인 커넥터 공통 서버 연결·관리 UI·새 API는 이 PR에서 구현/실행하지 않았다. DB 서버 회귀·실제 IdP/Windows/호스트·K8s/운영/반출·AC-01~24·지식 품질 시험을 새로 수행한 결과로 표시하지 않는다. GitHub CI 결과는 해당 PR의 실제 상태를 기준으로 한다.

## 2026-10-29 운영형 서버·OIDC·kind 수직 연결

**전체 251개 구현 완료나 사내 운영 인수 완료가 아니다.** 다음은 구현한 수직 경로와 실제 실행 근거이며, 남은 소프트웨어·환경 조건은 아래에 따로 남긴다.

- 사용자 결정: 동시접속 10명 이하, 운영 K8s/로컬 kind, 개발 Keycloak/운영 사내 SSO, 현재 DeepSeek/향후 온프레미스 교체. 추가 질문 없이 PR·머지까지 요청했다. 대규모 확장 최적화만 후순위이며 기존 251개 기준을 보존한다.
- 서버: OIDC+PKCE/state/nonce/JWKS, issuer+subject 신원, DB 세션/CSRF, 매 요청 UserInfo/현재 DB 권한, 원본/변경 집합/원자 발행/Query/답변/Lint/시도 기록, 쿠키 인증 REST/MCP를 연결했다. 실제 모델의 전체 입력 계보와 원본·페이지 ACL을 결과/재편입/발행/과거 버전에도 보존한다.
- UI: 기본 진입은 서버 정본 UI, 기존 합성 데모는 `/?demo=1`로 분리한다. 한국어 원본/편입/검토/발행/질문/재편입/Lint/작업/사용량, 25건 목록과 고정 인용 버전을 제공한다. 역할 선택/localStorage를 운영 인증/정본으로 사용하지 않는다.
- 배포: `Dockerfile.server`, Kustomize base/local/stg/prod, 로컬 Keycloak 고정 subject, 별도 DB/PVC, migration 성공 후 앱 배포, Secret 주입과 미설정/가변 이미지 운영 차단을 추가했다. 실제 회사 도메인·SSO·TLS·CNI·저장소는 추정하지 않는다. [설정/기동/제한](OPERATIONAL_SETUP.md).
- 실행 검증: Node 24.22.2 `npm run check`의 클라이언트 40개+Node 48개, 251개 연결 검사, 서버 타입/빌드/HTTP smoke 통과. 전용 kind DB의 서버 83개 회귀와 배포/추적 10개 통과. UTF-8 한글/이모지가 네트워크 청크 경계에서 손상되는 기존 읽기를 재현하고, 바이트 상한 확인 후 한 번만 디코딩하도록 수정했다. 실제 Keycloak의 3역할·원본→다중 페이지 편입→승인·원자 발행/멱등 재시도→인용 질문→재편입 제안→Lint·ACL/CSRF 거부를 실행했다.
- 실제 모델: 최초 자연어 질문의 조사 토큰 검색 실패와 DeepSeek thinking의 출력6000/추론5642토큰 JSON 잘림을 재현하고 성공으로 치환하지 않았다. 검색·선택적 thinking 설정·잘림 거부 RED→GREEN 후 최종 이미지에서 `deepseek-flash` 편입·승인/발행12,233ms, 자연어 질문3,128ms/인용4개를 확인했다. thinking=disabled를 명시했고 온프레미스 기본 옵션으로 보내지 않는다. 의미 품질/업무 효과 평가는 아니다.
- 제한된 읽기 측정: 최종 3개 합성 주체의 10개 인증 세션, 50/50 요청 성공, p95 158ms/전체516ms. 고유 사용자 10명의 혼합 부하·대용량·장기 안정성이나 사내 SLO 검증으로 확대하지 않는다. 이전 실행과 코드/입력/설정이 달라 성능 개선 비교로도 사용하지 않는다.
- 백업: AES256-GCM+scrypt/체크섬의 DB 백업 161610bytes를 로컬 폐기용 DB로 복원했다. 페이지 237·버전 265·원본 221개, 복원 단계 307ms였다. 테스트 workspace를 포함한 합성 DB이며 blob 일관성·독립 보관·사내 RPO/RTO는 별도다.
- 브라우저: 실제 OIDC 로그인/세션 만료 보호 화면 제거/재로그인, 자연어 발췌와 고정 버전, 사용량 401의 전체 보호 상태 제거를 확인했다. 390px 지식 화면 너비390/높이1178/첫 제목145px, 1440px 너비1440/높이1000/첫 제목107px. 사용량 모바일 높이2797/첫 집계730px, 그래프14px·키보드 내부 스크롤을 확인했다. [캡처/고정 결과](pr-assets/operational/README.md).
- 리뷰: UI/배포7건·서버 입력 계보3건·최종 schema 기동 차단/실행 중 세션·IdP 철회2건을 수정하고 독립 재검토에서 모두 addressed를 확인했다. 후속 provider 잘림 수정도 중요 결함 없음 판정이다. 최종 이미지의 실제 모델 실행 중 로그아웃200 → 응답401/UNAUTHENTICATED와 content 미반환을 확인했다. 전체 제품/사내 운영 인수 승인이 아니라 구현한 수직 경로의 리뷰다. PR/CI/머지 결과는 후속 기록을 따른다.
- 환경: 기본 Colima 2GiB에서 우리 노드의 OOM을 관찰했다. 기존 프로젝트는 중지하지 않고 실패한 우리 합성 cluster만 정리한 뒤 별도 4GiB profile `knowledge-hub-dev`를 생성했다. Docker 기본 context는 유지하고 `DOCKER_CONTEXT=colima-knowledge-hub-dev`로 분리한다. 앱/IdP는 28080/28081이다.
- 남은 소프트웨어: 지속 작업 lease/재시도/무인 일정·취소/예산, 개인 커넥터 공통 서버 통합, 서비스 계정 MCP/업무 context/outcome, 초안·수동 편집·전체 복원·공유·첨부·댓글·알림·삭제/권한 변경 운영 UI, blob 저장/일관 백업/감사 외부 보호, 실제 토큰·비용 영속 계측, 모델 의미 품질/후속 에이전트 대조 평가. 현재 jobs는 영속 시도 기록이지 자동 재개 worker가 아니다.
- 남은 운영 인수: 실제 사내 SSO/TLS/CNI/스토리지/독립 백업·삭제 정책/알림 수신자·책임자·혼합 부하와 품질/보안 기준. 정책·담당자 승인을 기술 구현으로 대체하지 않는다.
- 추적: [251개 항목별 미완료 작업표](requirements/operational-backlog.json)는 원래 ID/제목/우선순위/수용 기준을 그대로 보존하고, 항목별 구현 작업·실패/검증 사례·근거 심볼·소프트웨어 미구현/현장 검증/정책 차단을 구분한다. 모두 open이며 accepted는 0개다. `node scripts/release-status.mjs /external/path/report.json`의 간단 집계는 4개 ID 부분 근거만 연결한 별도 요약이며 작업표나 구현 완료 증거를 대체하지 않는다.
- PR: https://github.com/wontaeJeong/agent-knowledge-hub/pull/10 . 사용자 사전 머지 요청에 따라 중요 지적 해결·새 이미지 재검증·필수 CI 이후 병합한다. 실제 원격 상태/최종 head 검사와 병합 여부는 이 PR 기록이 기준이다. 이 기록의 전체 미구현/사내 운영 인수 제한은 PR 병합으로 사라지지 않는다.

## 서버 기반 첫 단계의 기록 (위 후속 기록 우선)

2026-10-29 후속 구현: PostgreSQL 내부 발행 서비스, DB membership/자료 allowlist, 승인 권한 스냅샷, 원자 발행·멱등 영수증, 감사/사용 기록과 사용량 대시보드를 추가했다. 상세는 [SERVER_FOUNDATION.md](SERVER_FOUNDATION.md). 아래 기존 데모 상태 설명은 계속 유효하며 새 서비스가 SSO/업무 UI/API 전체를 운영용으로 대체한 것은 아니다.

React 로컬 데모와 도메인 엔진, UI 교체 경계, 기준 239개와 핵심 순환 12개 요구사항, 앱 내 로드맵, 아이콘 팩을 제공한다. 선택적 로컬 모델 중계와 별도의 합성 개발용 로컬 위키 커넥터/STDIO MCP를 제공한다. 제품 서버·SSO·운영 커넥터·무인 스케줄러·인증된 운영 MCP는 아직 없다. 로드맵의 데모 매핑은 부분 시연 범위이지 프로덕션 완료 수가 아니다.

## 2026-10-29 로컬 커넥터 상시 실행 제외 확정

- 사용자 지시로 로컬 커넥터 상시 실행을 먼 미래 과제가 아닌 **제품 범위 밖**으로 확정했다. 연결 중 자동 동기화, 종료 시 미전송 변경 보존, 다음 연결 시 재개는 유지한다. 별도 daemon·OS 서비스·시작 프로그램·예약 작업은 동기화 수단으로 제공하지 않는다.
- 변경 파일: README, ARCHITECTURE, LOCAL_WIKI, ROADMAP, 로컬 위키 설계/계획, 이 인계 문서. 제품 코드와 현재 연결 수명주기는 변경하지 않았다.
- 관련 기준: EDT-002의 저장/복구, VER-005의 충돌 보존, INT-002·CORE-009의 MCP 연결 경계와 연관된다. JOB-001~012·MGR 일정·CORE-011 등 **서버 측** 지속 작업/예약 유지관리 요구사항과 기존 251개 수용 기준은 변경하지 않는다. North Star의 지식 유지 순환·근거·권한 불변식도 유지한다.
- 판단: 설치/운영 부담을 줄이고 호스트 연결 수명주기만 사용한다. 그 대가로 연결 종료 중 새 원격 변경이나 미전송 변경은 동기화되지 않고 다음 연결을 기다린다. 지식 효과/성능 개선을 새로 주장하지 않는다.
- 검증 결과: Node 24.22.2의 `npm ci`·`npm run check` 통과. Vitest 35개 + Node 48개(연결 종료·재연결/자동 polling 회귀 포함), 요구사항 251개, 서버 타입 검사, 빌드·정적 HTTP smoke 통과. 기존 511.20 kB 주 청크 경고는 유지한다. 독립 문서 리뷰에서 차단 지적 없음, `git diff --check` 통과. 서버 DB 시험·운영·실제 앱 호환 검증을 새로 수행한 것으로 표시하지 않는다.

## 2026-10-29 로컬 위키–LLM Wiki 통합 설계 제안 (문서만)

- 최신 `main`의 커넥터 합성 동기화/단일 페이지 공유 제안과, 브라우저 `src/domain/wiki.ts`의 다중 페이지 컴파일·Query·Lint가 분리된 점을 확인했다.
- `docs/KNOWLEDGE_INTEGRATION.md`에 공통 정본·원본/개인본/발행본 구분, P0/P1/P2 전환 순서와 KI-01~08의 **미실행** 통합 수용 시나리오를 정의했다.
- `docs/adr/004-unified-knowledge-service.md`는 공통 서버 지식 서비스를 정본으로 삼는 **제안(Proposed)**이다. 사용자/제품 책임자의 리뷰 없이 채택·구현 완료로 취급하지 않는다.
- README·AGENTS·LOCAL_WIKI·ARCHITECTURE·ROADMAP·AGENT_INTERFACE·EVALUATION의 문서 탐색 경로를 연결한다. North Star 원문·런타임 `wiki/SCHEMA.md`·기존 251개 요구사항·앱 코드는 변경하지 않는다.
- 검증 범위는 문서 링크/변경 내용 확인으로 한정된다. 모델 의미 품질, 운영 인증/MCP, DB 트랜잭션, KI-01~08 실행, K8s 배포를 이 문서 PR의 통과 결과로 표시하지 않는다.

## 2026-10-29 로컬 개인 위키 커넥터 첫 수직 구현

- 사용자 결정: 로컬/개인/공유 분리, 개인 자동 동기화, 여러 PC·에이전트 충돌 보존, 병합안 사람 확인, 공유는 명시적 변경 제안. 공유 레벨은 미정이며 로컬 커넥터 상시 실행은 위 후속 결정에 따라 제품 범위에서 제외한다. 개발자 하네스와 기존 에이전트 Desktop/Cowork 사용자가 대상이지 자체 Windows 제품 앱 개발이 아니다.
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

## 2026-10-31 저장소 운영 기준

- 범위: 작은 기능 단위 PR, UI 변경 PR의 화면 캡처, 실수·실패와 재발 방지 기록. 제품 요구사항 ID의 수용 상태나 지식 순환·권한·North Star 의미는 바꾸지 않는다.
- 변경: `AGENTS.md`, `README.md`, `docs/DEVELOPMENT.md`, `docs/PR_WORKFLOW.md`, `docs/MISTAKE_LOG.md`. 기록은 실제 관찰과 미확인을 구분하며 비밀·개인 정보·원문을 제외한다.
- 검증: 문서 링크와 `git diff --check`를 확인한다. 저장소 규칙의 실제 준수와 향후 실수 감소 효과는 운영 중 별도로 확인해야 한다.
