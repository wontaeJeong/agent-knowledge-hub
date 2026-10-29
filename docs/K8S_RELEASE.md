# Kubernetes 1차 릴리즈: 배포 구조와 운영 최소 기준

> **상태: 배포 목표/실행 전 체크리스트.** 현재 저장소는 React/Vite 기반 로컬 데모(§localStorage§, 선택적 로컬 Node 모델 중계)다. K8s 매니페스트, 서버 DB, SSO, 서버 권한 검증, 지속 작업 시스템은 아직 구현·검증되지 않았다. 이 문서는 완료 보고서가 아니다.
>
> 결정 근거: [ADR 003](adr/003-single-cluster-initial-release.md) · 장기 규모: [SCALING_PLAN.md](SCALING_PLAN.md) · 기존 요구사항: [ROADMAP.md](ROADMAP.md)

## 1. 범위와 배포 원칙

- **클러스터:** 단일 Kubernetes 클러스터(기존 사내 공용 인프라 사용 가정).
- **환경:** §agent-knowledge-hub-stg§, §agent-knowledge-hub-prod§ 두 네임스페이스. 별도 DB, Secret, 설정, 서비스 계정, PVC, 권한, 백업 대상.
- **애플리케이션:** 환경별 정상 상태 §replicas: 1§인 Deployment 1개를 목표로 한다. 1차 버전에서는 프런트/백 API의 실제 프로세스 구성은 기존 코드 전환 시 정하되, DB를 앱 컨테이너와 같은 Pod에 넣지 않는다.
- **DB:** 각 환경에 독립적인 PostgreSQL **인스턴스 1개**. 클러스터 표준 PostgreSQL 오퍼레이터(예: CNPG)가 이미 있다면 1-instance 클러스터를 우선 검토한다. 아니라면 백업·운영 책임을 포함하여 단일 DB StatefulSet 또는 관리형 DB를 평가한다. 오퍼레이터 설치 여부는 미확인이다.
- **도메인/Ingress/TLS:** STG/PROD에 서로 다른 호스트·라우트·인증 경계 사용. 실제 FQDN은 사내 배포 시 결정한다.
- **파일/원본:** 첨부·원본은 DB와 구별되는 영속 저장소(승인된 오브젝트 저장소 등)로 분리한다. Pod 임시 파일시스템을 원본 저장소로 사용하지 않는다.
- **이미지:** 같은 immutable 이미지 digest를 STG 검증 후 PROD로 승격하고, 설정/Secret은 환경별로 주입한다. §latest§ 태그 의존 배포 금지.

§§§mermaid
flowchart LR
  U["사내 사용자 / 인증된 에이전트"] --> I["Ingress / TLS"]
  subgraph K["단일 Kubernetes 클러스터"]
    subgraph S["agent-knowledge-hub-stg"]
      IS["STG Route / Service"] --> AS["App Pod x1"]
      AS --> DS["PostgreSQL x1 + STG PVC"]
    end
    subgraph P["agent-knowledge-hub-prod"]
      IP["PROD Route / Service"] --> AP["App Pod x1"]
      AP --> DP["PostgreSQL x1 + PROD PVC"]
    end
  end
  I --> IS
  I --> IP
§§§

위 도식은 **목표 논리 토폴로지**다. 현재 코드에서 다중 사용자 앱·API·DB가 실제 동작한다는 의미가 아니다. 필요 시 파일 오브젝트 저장소, SSO, 모델 게이트웨이 등 승인된 외부 시스템을 각 환경별 설정으로 연결한다.

## 2. 생성할 리소스와 경계

| 범주 | 최초 목표 | 주의 |
| --- | --- | --- |
| Namespace | §agent-knowledge-hub-stg§ / §agent-knowledge-hub-prod§ | 서로 다른 Secret·권한·쿼터 |
| App | Deployment, Service, Ingress/Gateway, readiness/liveness/startup probe | 정상 상태 replica 1은 HA가 아님 |
| DB | 독립 PostgreSQL 1개/환경, PVC, Service, 백업 구성 | DB는 앱과 다른 Pod, 백업 복원 검증 |
| 보안 | ServiceAccount, 최소 권한 RBAC, NetworkPolicy, TLS, Secret | 기본 차단 후 필요한 방향만 허용; 사용 CNI의 NetworkPolicy 지원 확인 |
| 자원 | requests/limits, ResourceQuota, 필요 시 LimitRange | STG가 PROD 자원을 독점하지 않도록 측정 기반 설정 |
| 운영 | 배포 이력, 로그·메트릭·알림, DB 마이그레이션 절차 | 애플리케이션 장애와 모델 장애를 구분 |
| 자료 | 환경별 원본/첨부 영속화 및 접근 통제 | 외부 저장소도 STG/PROD 버킷/경로 및 자격증명 분리 |

STG가 PROD 데이터베이스, 원본 저장소, Secret 또는 사용자 토큰에 접근할 수 없어야 한다. 테스트 fixture·익명화 데이터 사용을 원칙으로 한다. 교차 네임스페이스 통신은 기본 거부하며, DNS·Ingress·DB·IdP·승인된 모델/저장소 등 꼭 필요한 경로만 허용한다. 실제 정책은 클러스터 CNI·Ingress·Secret 관리 방식에 맞게 작성한다.

**하나의 클러스터**는 장애 영역도 공유한다. 노드/StorageClass/Ingress Controller/Control Plane 등 클러스터 범위 장애로 STG와 PROD가 함께 멈출 수 있으므로 두 네임스페이스를 별도 장애 도메인으로 표현하지 않는다.

## 3. 1차 릴리즈에서 일부러 하지 않는 일

- HPA와 앱 다중 replica, 무중단을 보장하는 롤링 배포, DB primary/standby HA, 읽기 복제본
- 처음부터 Redis/메시지 브로커/전용 검색엔진/서비스 메시 추가
- 사용자 수만으로 정한 DB 샤딩, 다중 클러스터·멀티리전 DR
- 계측 전 임의의 CPU, 메모리, 동시 요청 수치 확정

이 제외 범위는 **최적화/고가용성**에만 해당한다. 실사용자의 지식·버전·검토·발행을 브라우저에만 저장하거나 권한 검증을 생략해도 된다는 뜻이 아니다.

## 4. 1차 실사용 릴리즈의 필수 게이트

이 항목은 사용자 수와 무관하다. 단지 현재 데모를 사내 K8s에 올려 **합성 데이터로 시연**한다면 별도로 §demo-only§라고 표시하고, 실사용 지식 및 민감 자료를 받지 않는다.

- [ ] 서버 기반 인증(사내 IdP/SSO), 주체·그룹·역할 및 **서버 ACL** 강제. 읽기·검색·근거·과거 버전·MCP/API·내보내기 포함
- [ ] §localStorage§를 다중 사용자 진실의 원천으로 사용하지 않음. PostgreSQL에 원본 메타데이터/위키/발행/버전/승인/감사/작업 상태의 일관된 영속 모델 구현
- [ ] 변경 집합 발행의 DB 트랜잭션, 중복 요청 멱등성, 기준 버전 충돌/권한 재검사. Pod 재시작 시 중복 발행 없음
- [ ] 파일/원본 영속화 및 크기·유형 검증, URL 수집/모델/도구의 보안 경계. 공개 범위 확대 방지
- [ ] PROD와 STG의 DB/PVC/비밀/백업/권한 격리 및 환경별 ingress/TLS 검증
- [ ] DB 백업 주기·보관·복구 주체·임시 복구 환경과 원본 저장소의 일관된 복원 시험 기록. RPO/RTO를 정의하고 실측; PVC만 보유하는 것은 백업이 아님
- [ ] DB schema migration의 실패/롤백 전략, 배포 이미지 digest 고정, STG 검증 → PROD 승격, 장애 시 이전 이미지 복귀 동선
- [ ] 기동/준비/생존 상태, 종료 중 요청 처리, 자원 requests/메모리 limit, 로그/메트릭/오류 알림, 용량 감시. 실제 운영 담당자 지정
- [ ] 외부 모델 및 수집기가 실패해도 발행·권한 불변식을 지킴. 실패/재시도를 성공으로 위장하지 않음
- [ ] 이 문서의 '미구현'과 실제 배포 결과·인수 증거를 분리해서 기록. 기존 OPS/SEC/JOB/NFR 수용 기준과 충돌하지 않게 관리

## 5. 운영/배포 시 예상할 중단

앱 replica가 1이면 새 이미지 배포 중 일시적 2개 Pod를 띄우는 RollingUpdate(여분 용량 필요) 또는 다운타임을 받아들이는 Recreate 중 하나를 선택해야 한다. **§replicas: 1§은 롤링 업데이트 동안 정확히 1 Pod만 존재함을 뜻하지 않는다.** DB 단일 인스턴스의 재시작/업그레이드에도 중단이 있다. 최초 배포 시 사용자에게 이 가용성 제한을 고지한다.

실행 중 스케줄러를 웹 프로세스에만 묶거나 인메모리 큐에 작업을 보유하지 않는다. 첫 단계에서는 같은 앱 프로세스가 작업을 처리하더라도 **DB에 작업 수락·상태·임대·재시도 정보를 영속화하고** 이후 작업자를 분리할 수 있게 한다.

## 6. 실행 계획(구현 작업으로 남은 항목)

1. 실제 서버 API 및 PostgreSQL 스키마·SSO/권한·원본 저장소가 준비되면 컨테이너 구성을 확정한다.
2. Kustomize overlays(§stg§, §prod§) 또는 팀 표준 Helm 방식 중 **하나**를 선택하여 동일 템플릿에서 두 환경을 선언적으로 생성한다. 현재 레포에는 배포 템플릿이 없다.
3. 네임스페이스 기본 정책, app/DB/PVC/Ingress, Secret 공급 방식을 선언적으로 반영한다.
4. STG에서 실제 배포·마이그레이션·장애·복구를 검증한 뒤 동일 이미지 digest를 PROD로 승격한다.
5. 실측 지표가 쌓이면 [SCALING_PLAN.md](SCALING_PLAN.md)의 순서로 증설한다.

### 참조

- [Kubernetes: Namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/)
- [Kubernetes: Multi-tenancy / NetworkPolicy](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
- [Kubernetes: StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
