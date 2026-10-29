# 재사용과 출처

## 이번 코드에 실제 사용한 구성요소

React·React DOM, Vite·TypeScript, Lucide React, marked·DOMPurify, Vitest를 npm 패키지로 사용한다. 아이콘 팩의 PNG 생성은 sharp를 사용한다. 정확한 버전은 package-lock.json, 라이선스 개요는 THIRD_PARTY_NOTICES.md에 있다.

기존 agent-admission-gate 브랜드 팩에서 확인한 plum 팔레트 4개를 재사용했다. 심볼은 같은 제품군의 인상을 유지한 새 SVG이며 Gate 로고 원본을 포함하지 않는다. 웹·기능 컴포넌트는 원본 코드가 없어 실제로 복사하지 않았고 UI_INTEGRATION.md에 교체 지점을 명시했다.

## 기존 후보 코드의 취급

공개 LLM 위키 후보의 제품 코드는 이번 레포로 복사하지 않았다. 이전 검토의 설계 아이디어와 기능 범위 구분을 반영했다. 전체 코드 재사용 전에 다음 계약을 확인한다.

- 현재 도구 버전과 수집 포맷이 맞는가
- 구조 검사와 실제 근거 의미 검증이 구분돼 있는가
- 그룹별 ACL과 원본 파생 권한을 강제할 수 있는가
- 본문 변경·승인 내용 고정·의존 그룹 발행이 지원되는가
- 작업 수락과 큐 장애 시 누락 없는 복구가 가능한가
- 필요한 기능이 실제 라이선스와 에디션에서 사용 가능한가

고정 커밋별 기존 소스 검토는 requirements/source-audit.json과 review.md에 보존한다. 해당 저장소의 현재 운영 적합성을 인증한 것은 아니다.
