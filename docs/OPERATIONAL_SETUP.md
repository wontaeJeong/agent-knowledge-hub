# K8s 운영 앱과 로컬 kind 개발

이 문서는 운영형 전환 경로다. 기존 정적 데모와 다르며 **문서 또는 manifest가 있다는 이유만으로 운영 인수 완료를 뜻하지 않는다.** 현재 실제 실행 근거·미충족 항목은 AGENT_HANDOFF/TESTING을 함께 확인한다.

## 기본 구성

- 운영은 STG/PROD 분리 namespace의 앱1/PostgreSQL1이다. 최초 부하 계약은 동시 사용자10명 이하다. 다중 replica/DB HA/자동 확장은 후순위이며 중단 없는 운영을 보장하지 않는다.
- 로컬도 앱/DB/Keycloak을 kind에 올린다. Compose는 필수 개발 경로가 아니다.
- 신원은 표준 OIDC issuer+subject, 개발 Keycloak 그룹을 역할로 매핑한다. 운영에서는 실제 사내 SSO/가입 허용/그룹 정책을 입력해야 한다.
- 모델은 서버의 OpenAI 호환 adapter다. 현재 DeepSeek 설정을 쓰고 사내에서는 base URL/model/key를 온프레미스 endpoint로 교체한다.
- 공개 소개는 `/`, 운영 UI는 `/?app=1`, 기존 합성 시연은 명시적인 `/?demo=1`이다. 소개는 로그인/API 없이 표시되며 SSO 성공 후에는 운영 UI로 복귀한다. 정적 데모 실행기는 로그인/DB/API를 제공하지 않는다.

## 로컬 준비

Node24 LTS, npm10+, Docker, kubectl, kind가 필요하다. Docker에는 최소4GiB 메모리와 디스크 여유를 확보한다. 여러 프로젝트가 같은 VM을 쓰면 추가 여유가 필요하다. 다른 프로젝트를 중지하거나 기존 Docker VM을 임의 재시작하지 않는다.

macOS Colima에서 별도 VM이 필요하다면 기존 profile을 바꾸지 않고 다음처럼 분리할 수 있다.

```sh
colima start --profile knowledge-hub-dev --cpu 2 --memory 4 --disk 20 --activate=false
export DOCKER_CONTEXT=colima-knowledge-hub-dev
```

전용 cluster 이름은 `knowledge-hub-dev`, kubectl context는 `kind-knowledge-hub-dev`다. 스크립트의 kubectl 작업은 context/namespace를 명시한다. kind 자체는 생성 시 기본 kubecontext를 바꿀 수 있으므로 필요하면 기존 context로 복귀한다.

```sh
npm ci
node scripts/k8s/local.mjs up
node scripts/k8s/local.mjs status
node scripts/k8s/local.mjs logs
```

앱 `http://localhost:28080`, IdP `http://localhost:28081`을 사용한다. 다른 프로젝트가 쓰던18080은 점유하지 않는다. 로컬 합성 계정은 `reviewer`, `writer`, `reader`이고 비밀번호는 모두 `local-test-only`다. `disabled`는 로그인 거부 사례다. 이 계정·HTTP·Keycloak `start-dev`는 **로컬 overlay에만** 존재한다. 운영에 복사하지 않는다.

기본 모델은 미연결이다. 서버 설정 파일에서 필요한 세 값만 읽어 Kubernetes Secret에 넣을 수 있다. 파일을 shell로 실행하거나 전체 환경을 복사하지 않는다.

```sh
node scripts/k8s/local.mjs up --model-env /absolute/path/to/private.env --allow-model-transmission --model-thinking disabled
```

인식하는 키는 `AGENT_KNOWLEDGE_HUB_LLM_BASE_URL`, `_MODEL`, `_API_KEY`이며 개발 설정의 `AGENT_OPT_MODEL_BASE_URL`, `AGENT_OPT_MODEL_ID`, `AGENT_OPT_MODEL_API_KEY`도 입력 어댑터로 읽는다. `--allow-model-transmission` 또는 명시적인 `AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION=true` 없이는 모델 전송을 허용하지 않는다. 외부 DeepSeek 시험에는 합성 자료만 사용한다. 사내 자료를 외부로 보낼 권한으로 해석하지 않는다. Secret·키·설정 파일은 Git/프런트/PR에 넣지 않는다.

DeepSeek의 기본 thinking 모드는 추론도 `max_tokens` 예산을 소비한다. 실제 시험에서 6000토큰 중 5642토큰이 추론에 쓰여 `finish_reason=length`로 JSON이 잘렸다. 로컬 구조화 출력 시험은 `--model-thinking disabled`(서버 `AGENT_KNOWLEDGE_HUB_LLM_THINKING=disabled`)를 명시한다. `enabled`도 지원하지만 잘린 응답은 JSON이 파싱돼도 `MODEL_OUTPUT_LIMIT`로 거부한다. 이 설정은 기본값이 없으며 온프레미스/다른 OpenAI 호환 서버에는 설정하지 않으면 `thinking` 필드를 전송하지 않는다. 온프레미스로 전환할 때 공급자별 옵션도 함께 검토한다. thinking 비활성화가 의미 품질을 개선했다는 주장은 하지 않는다.

설치 순서는 인프라 → DB 준비 → 단일 migration Job 성공 → 앱 적용/재시작 → rollout 확인이다. migration 실패 시 새 앱 rollout을 하지 않는다. 기존 버전이 실행 중인 업그레이드는 backward-compatible migration만 사용한다. DB 파괴적 변경/다운그레이드는 별도 검토한다.

Keycloak fixture 사용자 UUID를 고정하여 개발 IdP Pod 재생성 시 DB의 주체 참조를 유지한다. 운영 IdP 영속화/복구를 이 개발 fixture로 대신하지 않는다. 권한을 시험하려면 우선 검토자와 작성자로 한 번씩 로그인하여 허용된 membership를 만들고 자료 등록 시 독자를 명시한다.

## 개발·회귀

```sh
npm run check
node --test scripts/k8s/*.test.mjs
kubectl kustomize deploy/overlays/local
```

운영 이미지는 `Dockerfile.server`이고 정적 데모 `Dockerfile`과 구분한다. 단일 앱8080에서 UI/업무 API/인증을 제공한다. migration과 업무 시작은 별도 명령이다. 빠른 로컬 서버 개발은 kind DB/IdP를 명시적으로 port-forward하고 환경을 공급하여 수행할 수 있다. 최종 배포 시험은 실제 이미지로 다시 한다.

## 운영 site overlay

`deploy/overlays/stg`, `prod`는 **미설정 안전 템플릿**이다. CHANGE-ME/invalid 호스트가 있는 그대로 운영에 적용하지 않는다. 실제 환경 파일은 별도 site overlay/비밀 관리로 공급한다.

다음은 운영 전 필수 입력/실행 항목이다.

1. 실제 APP_ORIGIN/IngressClass/FQDN/TLS와 OIDC issuer/client/secret/그룹-역할 매핑. HTTP/개발 우회 금지.
2. 환경별 DB/PVC/StorageClass/비밀·백업 격리. 앱 계정과 DB 운영자 권한의 분리.
3. 동일한 불변 이미지 digest를 STG에서 검증 후 PROD로 승격. 앱·migration·DB 등 모든 실행 이미지 고정.
4. namespace 기본 거부 NetworkPolicy에 실제 ingress-controller 및 IdP/model/blob IP/서비스 허용 경로를 추가하고, 사용 CNI에서 실제 차단/허용 시험. 기본 kind CNI는 집행 증거가 아니다.
5. 실제 원본/첨부 저장소, 독립 백업 보관 대상·암호키·보관 기간·삭제 정책·복구 담당자.
6. 관측/오류·백업 실패 알림의 실제 수신자와 담당자. 조직 승인 품질/보안/비용 임계값.
7. 사내 SSO 비활성화/철회, 모델 장애, DB 재시작, 백업복원, 10개 인증 세션 혼합 부하의 인수 기록.

```sh
node scripts/k8s/validate-production.mjs /path/to/reviewed/site-overlay
```

이 검사는 리소스별 immutable image/개발 placeholder/평문 Secret/HTTPS·TLS/기본 거부 정책을 정적으로 검사한다. 통과가 실제 인증·네트워크·복원·지식 품질을 보장하지는 않는다. 기본 템플릿이 검사에 실패하는 것은 의도된 배포 차단이다.

## DB 백업과 폐기용 복원 검증

```sh
# 키는 운영 비밀 저장소에서 환경으로 공급한다. 키와 백업은 분리 보관한다.
node scripts/k8s/backup.mjs kind-knowledge-hub-dev agent-knowledge-hub-local /external/private-backups
node scripts/k8s/verify-restore.mjs /external/private-backups/knowledge-TIMESTAMP.akh-backup
```

환경 `AGENT_KNOWLEDGE_HUB_BACKUP_KEY`는32자 이상이어야 한다. AES-256-GCM+scrypt로 pg_dump를 암호화하고 SHA-256 manifest를 별도로 저장한다. 잘못된 키/변조는 거부한다. 파일·폴더는0600/0700이며 키를 명령행 인자로 받지 않는다. 복원 검증은 로컬 cluster에 직접 생성한 임시 DB에만 복원하고 그것만 정리한다. 기존 운영 DB를 덮어쓰지 않는다.

현재 도구는 **DB 백업/로컬 복원 검증**이다. 외부 blob과 일관된 manifest·독립 스토리지 자동 보관·스케줄/보관·삭제 tombstone 재적용·사내 복원 시간 측정까지 제공됐다고 주장하지 않는다. 같은 디스크의 파일/PVC만으로 운영 백업 완료가 아니다. 실제 운영 인수에서 이 미충족 조건을 해결해야 한다.

## 제한의 보고

원래 251개 기준별 남은 구현 작업·검증 사례·외부/소프트웨어 차단은 [operational-backlog.json](requirements/operational-backlog.json)에 있다. 각 행의 수용 기준은 원문과 같으며 전체 상태는 open이다. 이 작업표의 존재도 구현·인수 완료가 아니다.

실패/미실행/미수집을0 또는 성공으로 표시하지 않는다. 모델이 실제 호출됐다는 사실은 의미 품질/지식 누적 개선의 증거가 아니다. 기존251개 수용 기준은 유지하며 기능 구현·kind 시험·사내 운영 인수를 별도로 추적한다. 남은 조건이 있으면 민감 자료 운영을 승인하지 않는다.
