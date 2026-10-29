# agent-knowledge-hub 개발 기준

목표는 LLM 업무 산출물을 검토 가능한 사내 지식으로 축적하고 지속 운영하는 서비스다. 현재 코드는 동작 가능한 로컬 데모다. 데모라는 이유로 전체 제품 요구사항을 삭제하거나 MVP 제약으로 축소하지 않는다.

## 제품의 중심

- docs/LLM_WIKI_CORE.md, docs/AGENT_INTERFACE.md, wiki/SCHEMA.md와 ADR 002를 따른다.
- 핵심은 에이전트가 연결된 지식을 작성·유지하는 Ingest → Query → Lint와 질문 결과 재편입이다. 사람의 탐색·검토 경험도 유지한다.
- 새 자료를 한 문서에 단순 추가하는 흐름이나 MCP 연결만으로 이 핵심을 구현했다고 표시하지 않는다.
- wiki/SCHEMA.md는 업무 지식 유지관리용 런타임 규칙이며 이 파일은 앱 개발용이다.
- 오프라인 구조 편입·발췌·명시 사실 검사와 실제 모델 종합을 구분한다. 모델 오류를 가짜 성공으로 감추지 않는다.

## 먼저 읽을 파일

README.md, docs/ARCHITECTURE.md, docs/UI_INTEGRATION.md, docs/ROADMAP.md, docs/SECURITY.md와 작업 대상 요구사항을 읽는다. K8s 배포·서버 영속화·운영 설계 변경 시 docs/K8S_RELEASE.md, docs/SCALING_PLAN.md와 docs/adr/003-single-cluster-initial-release.md도 따른다. 기준 요구사항은 docs/requirements/requirements.json, 핵심 순환 추가 기준은 docs/requirements/core-requirements.json이며 앱 로드맵 데이터는 src/data/roadmap.json이다. 기존 리뷰 근거는 docs/requirements/review.md와 source-audit.json에 있다.

## 사내 레포로 이식할 때

- agent-admission-gate 소스 접근이 가능해지면 해당 레포의 AGENTS.md와 실제 디자인 토큰·프리미티브를 우선 확인한다.
- 기존 API·권한·UI 컴포넌트를 추정해 이름을 만들거나 이미 연동했다고 주장하지 않는다.
- src/ui/primitives.tsx의 공개 props를 유지하는 어댑터를 우선한다. 기존 컴포넌트 복사와 라이선스는 회사 정책을 따른다.
- 도메인 엔진에서 UI 컴포넌트나 프레임워크를 import하지 않는다.

## 구현 상태의 정직성

- localStorage·역할 선택·결정적 매니저는 실서비스의 저장소·인증·LLM이 아니다.
- 브라우저 기능이 존재해도 프로덕션 수용 기준을 통과한 것으로 올리지 않는다.
- 실제 모델을 연결한 뒤에만 호출 공급자·모델·비용·실행 추적을 표시한다.
- 검증 증거 없는 성공 진술을 실행 검증으로 승격하지 않는다.
- 일정 설정과 실제 무인 실행을 구분하고, 오류를 성공으로 덮지 않는다.

## 변경 불변식

1. 원본 접근 범위를 넓히는 자동 편입을 막고 서버에서도 같은 규칙을 구현한다.
2. 승인한 내용과 기준 버전이 달라지면 재검토한다. 발행 직전에 권한을 다시 확인한다.
3. 버전 복원은 새 버전을 만들며 현재 권한을 복원하지 않는다.
4. 재시도와 중복 이벤트는 중복 발행을 만들면 안 된다.
5. 초기 상태·실험 데이터·실제 사내 자료를 분리한다. 비밀키를 VITE_ 변수와 클라이언트 코드에 넣지 않는다.
6. 외부 검색·모델·도구·전송은 회사 정책이 허용한 대상만 사용한다.

## 작업 완료와 문서

변경한 요구사항 ID, 변경 파일, 검증 결과와 남은 제약을 docs/AGENT_HANDOFF.md에 갱신한다. 코드 수정 시 의미 있는 도메인 및 통합 회귀를 검증하고 npm test, check:requirements, build를 통과시킨다. 실제 도구 수집기는 배포 버전의 익명화 fixture로 검증한다.

로드맵 단계는 개발 순서이며 필수 요구사항 제외 사유가 아니다. 필수 요구사항을 운영 전 검증하고, 아직 미구현인 프로덕션 기능은 화면과 문서에서 사실대로 표시한다. 전체 위키 제품을 가져오려면 docs/REUSE.md의 권한·본문 변경·발행·라이선스 검증을 먼저 충족한다.
