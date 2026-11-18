# 편의 기능 연결 인수 기록

2026-11-18, 제품 기준 커밋 `89526375956d28b6b84e160218795ba99cdccdee`. C12는 C1~C11이 병합된 제품을 검사했다. 아래 새 브라우저 실행은 하나의 팀 공간에서 작성한 **같은 문서**를 추적한다. 각 이전 PR 링크에는 그 PR의 소스·환경·캡처와 실패 이력이 있다.

## 한 문서의 실행 경로

| 단계 | 관찰한 결과 |
| --- | --- |
| 모델 장애 | 허용된 루프백 합성 모델에 의미 검색 요청이 1회 도달해 HTTP 503을 받았다. 실제 작업자가 결과 없이 `queued / MODEL_UNAVAILABLE`를 기록했다. 추가 재시도가 실행되기 전의 관찰이다. |
| 저장·복구 | 작성자가 390px에서 제목 다음 입력으로 Tab 이동하고 개인 초안을 서버에 저장했다. 새로고침 뒤 원문을 확인하고, 다음 초안 POST의 연결을 끊었다. 재접속 후 ‘이전 입력 복구’를 직접 선택해 바뀐 Markdown과 내부 링크를 같은 초안에 저장했다. |
| 원본 검토·발행 | 작성자가 본문과 editor·reviewer·reader 독자를 고정했다. 독립 reviewer가 원본 공개를 승인하고 작성자가 지식 검토를 요청했다. reviewer가 변경 집합을 승인한 뒤 별도 버튼으로 발행했다. PostgreSQL에 같은 본문의 v1 한 건과 `user-submission`이 기록됐다. |
| 검색·즐겨찾기 | 합성 한글 조합 중 350ms 동안 작성한 제목의 검색 POST 0건. 확정 뒤 정확한 고유 제목의 POST가 200을 반환하고, 응답 항목에 발행한 page ID가 든 것을 확인했다. Enter로 연 URL·문서 고유 링크가 이 ID와 일치했다. 이어서 즐겨찾기에 추가했다. 즐겨찾기 목록에서 Enter로 같은 문서를 다시 열었다. |
| 백링크·댓글·알림 | 새 문서의 Markdown 링크로 기존 ‘주제’를 열고 백링크에서 새 문서로 돌아왔다. reviewer를 멘션한 댓글을 남기고 실제 이벤트 처리를 실행했다. 작성 응답의 201·댓글 UUID·v1·수신자를 확인했다. 수신자 알림이 연 문서 URL·고유 링크 및 `#comment-ID`가 작성 결과와 일치했고 해당 요소에 같은 본문이 있었다. |
| 홈·내 작업함 | 홈과 내 작업함의 초안 링크로 각각 이동했다. 재개 URL의 draft ID가 처음 저장한 값과 같고, 내 작업함에서 Enter로 연 제목이 저장한 제목과 일치했다. |
| 권한·기간 만료 | 같은 reader의 ‘주제’ 백링크 조회에서 새 문서 ID를 먼저 확인했다. 해당 원본의 reader ACL 한 행을 삭제하자 같은 조회의 200 응답에서 그 ID가 빠졌다. 새 문서 탐색은 404였고 로딩 후 거절 안내가 표시됐으며 발행 제목 heading은 보이지 않았다. 별도로 만료한 작성자 세션과 비활성화한 reviewer의 실제 `/me` 응답은 각각 401이었다. |

Chromium 158.0.8127.18, 390×844, 밝은 테마, PostgreSQL 17.11, 임시 포트와 UUID 전용 DB를 사용했다. 실제 OidcAuth와 합성 UserInfo를 사용했고 브라우저 세션은 fixture로 발급했다. 검사 후 전용 DB 무존재를 조회했다. 실행별 ID와 결과, 세 화면, 재현 코드를 함께 제공한다. [최근 성공 실행의 JSON·화면·SHA-256](latest.md) · [실행 코드](capture.ts)

<details><summary>같은 범위 재실행</summary>

지원 Node 24와 의존성을 설치하고 Chromium이 설치된 Playwright 모듈 경로, CREATE DATABASE 가능한 루프백 전용 테스트 DB를 제공한다. 실행마다 고유 DB를 생성한다. 시딩을 일회성 자식 프로세스에서 실행해 풀이 반환되기 전에 실패해도 해당 연결을 회수한다. 정상 실행은 브라우저, 작업자, 서버 세 개, 풀, 생성한 DB, 관리자 풀의 정리 결과를 각각 확인한다. DROP이 거절되면 DB 이름과 사유를 실패 기록에 남긴다.

캡처는 OS가 만든 전용 임시 경로에 모은다. 12단계와 8개 정리의 성공을 확인한 뒤 UUID별 파일을 복사하고 각각의 SHA-256을 검산한다. 마지막에 `latest.md`를 원자적으로 교체하며, 이전 실행 디렉터리는 보존한다. 실패 시 콘솔의 `FAILED_RECORD`가 해당 실행의 임시 진단 JSON을 가리킨다. [정리·게시 구현](capture-support.mjs)

```sh
npm run build
AKH_C12_SYNTHETIC=1 TEST_DATABASE_URL="$LOOPBACK_TEST_DB_URL" \
  PLAYWRIGHT_MODULE="$LOCAL_PLAYWRIGHT_MODULE" \
  node_modules/.bin/tsx docs/ui-validation/2026-11-18-convenience-acceptance/capture.ts
```

같은 환경 변수로 `node --test docs/ui-validation/2026-11-18-convenience-acceptance/capture-lifecycle.test.mjs`를 실행하면 실패 경로를 검사한다.

</details>

## 기능별 근거

‘연결’은 사용자 동작과 실제 서버 경로를 뜻한다. ‘브라우저’의 C12는 위 단일 실행, PR은 해당 시점의 별도 실행이다. 모든 행의 운영 인수는 **미실행**이다. 각 행 마지막 칸에 추가로 확인해야 할 조건을 적었다.

| 기능 · 병합 커밋 | 구현 | 연결 | 자동 검사 | 브라우저 | 남은 조건 · 운영 인수 |
| --- | --- | --- | --- | --- | --- |
| 공통 탐색 C1 #63 `a1dba1f` | [위치 해석·생성](../../../src/operational/convenience/route.ts) | 공간별 메뉴, 예전 문서·댓글·공유와 로그인 복귀, 정확한 업무 위치 | [경로](../../../src/operational/convenience/route.test.ts) · [메뉴](../../../src/operational/convenience/Navigation.test.tsx) | C12 댓글 앵커·초안 URL, [PR 화면](../../pr-assets/convenience-navigation/README.md) | 사내 IdP 로그인 왕복 미검증 |
| UXC-01 알림 C2 #67 `d4c5282` | [수신함](../../../server/collaboration/inbox.ts) | 멘션·outbox → 벨·수신함 → 현재 권한의 대상. 순번 경계와 개별 읽음·보관 | [지연·중복·경합](../../../server/collaboration/inbox.test.ts) · [UI](../../../src/operational/convenience/inbox.test.tsx) | C12 실제 댓글, [이전 벨·일괄 읽음](../2026-11-17-personal-inbox/README.md) | 운영 디렉터리·전달 지연 미검증 |
| UXC-02 개인 목록 C3 #69 `d4048bd` | [개인 목록](../../../server/convenience/personal.ts) | 즐겨찾기·방문·구독 및 공간별 정렬 CAS | [호환 HTTP](../../../server/convenience/personal-http.test.ts) · [목록 UI](../../../src/operational/convenience/personal.test.tsx) | C12 즐겨찾기 재방문, [개인 목록 PR](../2026-11-17-personal-library/README.md) | 후보 한도 10,000개, 프로세스별 cursor·다중 인스턴스 부하 미검증 |
| UXC-03 검색 C5 #70 `83b00f4` | [검색 화면](../../../src/operational/convenience/SearchPage.tsx) · [빠른 열기](../../../src/operational/convenience/QuickOpen.tsx) | quick-open → 상세 검색·고정 버전, 모델 중단 중 키워드 검색 | [검색 UI](../../../src/operational/convenience/search.test.tsx) · [현재·과거 키워드 검색](../../../server/questions/service.test.ts) | C12 합성 조합·Enter, [검색 PR](../2026-11-17-global-search/README.md) | 실제 OS IME·대규모 색인 지연 미검증 |
| UXC-04 작성 C6 #71 `0def475` | [작성기](../../../src/operational/convenience/DocumentComposer.tsx) · [공개 검토](../../../server/workflows/new-document.ts) | pageId 없는 개인 초안 → 고정 공개본 → 지식 승인 → v1 | [팀·개인·템플릿·중복](../../../server/workflows/new-document.test.ts) · [복구](../../../src/operational/convenience/exact-recovery.test.tsx) | C12 팀 공간, [이전 개인/팀·거절/충돌](../2026-11-17-new-document/README.md) | EDT-001 전체 왕복 미충족. 초기 390px 조회의 일시적 503 원인 미확정 |
| UXC-05 홈 C4 #72 `de4e150` | [홈 집계](../../../server/convenience/home.ts) · [내 작업](../../../src/operational/convenience/MyTasks.tsx) | 허용된 초안·검토·작업 → 원래 대상. 위젯별 조회와 실패 | [서버](../../../server/convenience/home.test.ts) · [갱신](../../../src/operational/convenience/home-refresh.test.tsx) | C12 홈·작업 초안 재개, [기존 위젯 부분 실패](../2026-11-17-personal-home/README.md) | 다중 인스턴스 cursor·공간 전체 digest 비용 미평가 |
| UXC-06 구조 C7 #73 `3b8f310` | [트리·이동](../../../server/convenience/structure.ts) | 위치·독자 재검사 → 같은 ID로 이동, 복제는 초안 | [서버](../../../server/convenience/structure-final.test.ts) · [트리 UI](../../../src/operational/convenience/structure.test.tsx) | [PR 트리·390px·이전 링크](../2026-11-18-document-structure/README.md) | 운영 트리 규모·부하 미검증 |
| UXC-07 링크 C8 #74 `79a90cc` | [발행 링크](../../../server/convenience/links.ts) | 발행된 참조만 색인 → 현재 열람 가능한 백링크 | [링크](../../../server/convenience/links.test.ts) · [이관](../../../server/convenience/links-migration.test.ts) | C12 양방향 탐색·철회, [PR 동명·복원](../2026-11-18-internal-links/README.md) | KNO-007 도메인별 권위 우선순위, KNO-010 병합 안내 미충족 |
| UXC-08 읽기 C9 #75 `29a892b` | [읽기](../../../src/operational/convenience/DocumentReader.tsx) · [앵커](../../../server/convenience/anchors.ts) | 현재/고정 버전·안정적 문단·본문 찾기와 복사 대안 | [앵커](../../../server/convenience/anchors.test.ts) · [읽기 UI](../../../src/operational/convenience/reader.test.tsx) | [반복 제목·삭제 문단·복사 거절 PR](../2026-11-18-document-reader/README.md) | EDT-001 전체 편집·내보내기·가져오기 의미 보존, 실물 보조기기 미검증 |
| UXC-09 속성 C10 #76 `f7583ec` | [속성](../../../server/convenience/properties.ts) · [일괄 변경](../../../server/convenience/bulk.ts) | 속성 폼·최대 50건/10분 preview → 영속 작업·항목 결과·독립 태그 검토 | [재실행·부분 결과](../../../server/convenience/bulk.test.ts) · [기존 별명](../../../server/workflows/bulk.test.ts) | [속성·일괄 결과와 구 UI](../2026-11-18-properties-bulk/README.md) | 구 UI가 새 검토 상태를 실패로 표시. 운영 전환·롤백 검증 필요 |
| UXC-10 저장 보기 C11 #77 `da638cc`, #78 `8952637` | [개인 보기](../../../server/convenience/views.ts) · [화면](../../../src/operational/convenience/SavedViews.tsx) | 본인·공간별 조건 CAS와 같은 예시 재선택 → 현재 권한 재검색 | [저장·충돌](../../../server/convenience/views.test.ts) · [폐기·복구 UI](../../../src/operational/convenience/views.test.tsx) | [기존 4조건·같은 예시 취소/수락](../2026-11-18-saved-views/README.md) | 148 이전 writer 교체·사내 인증 전환 미검증 |

## Review Focus와 실행 범위

| 계획 항목 | 구현 및 검사 | 연결된 화면 · 남은 조건 |
| --- | --- | --- |
| 1. 계정·공간 전환 시 늦은 응답과 개인 내용 | C1/2/3/5/11의 세션·요청 세대와 C6의 재검증된 복구. [공간 전환·탐색](../../../src/operational/convenience/Navigation.test.tsx) · [계정 전환·지연 검색 응답](../../../src/operational/convenience/search.test.tsx) · [보기](../../../src/operational/convenience/views.test.tsx) | C12의 세션 만료·identity 비활성 응답과 개별 PR의 브라우저 계정 교체. 운영 IdP·다중 기기 미검증 |
| 2. 동시 읽음·outbox 지연 | C2의 커밋된 수신 순번으로 읽음 경계 고정. [중복·지연·stale 탭](../../../server/collaboration/inbox.test.ts) | C12 단일 댓글, 중복/일괄 읽음은 [알림 PR](../2026-11-17-personal-inbox/README.md). 실제 재전달 지연 분포 미측정 |
| 3. 최초 초안·복제·템플릿의 계보 | C6의 독자·원본·의존 버전 고정, C7 복제. [새 문서](../../../server/workflows/new-document.test.ts) · [구조](../../../server/convenience/structure.test.ts) | C12 독립 공개 승인과 별도 발행, 복제·템플릿은 기능별 검증. 회사 정책으로 운영 검증 필요 |
| 4. 이동·백링크·일괄 작업과 권한·보존 경합 | C7/8/10 실행시 현재 정책과 삭제·보존 검사. [구조](../../../server/convenience/structure-final.test.ts) · [링크](../../../server/convenience/links.test.ts) · [일괄](../../../server/convenience/bulk.test.ts) | C12 원본 철회와 백링크, [부분 처리 PR](../2026-11-18-properties-bulk/README.md). 운영 규모의 경합·재해 복구 미검증 |
| 5. 반복 제목·IME·키보드·좁은 화면·복사 거부 | C5/6/7/9의 조합 보류·본문 위치·복사 실패 안내. [검색](../../../src/operational/convenience/search.test.tsx) · [읽기](../../../src/operational/convenience/reader.test.tsx) | C12 390px 키보드·합성 조합·복구. [고정 앵커·Clipboard 거절](../2026-11-18-document-reader/README.md). 실제 OS IME·스크린리더 미실행 |

## 이관·호환·롤백

- 실제 schema 순서는 140 수신함 → 141 개인 정렬 → 142 공개 검토 → 143 트리 → 144 발행 링크 → 145 일괄 작업 → 146 개인 보기 → 147 감사 확장 → 148 새 쓰기 검사다. 140은 순번의 배치 backfill과 재시작, 141은 기존 방문·즐겨찾기 보존을 검증한다. 142의 새 테이블에 대해 팀·개인 발행, 같은 요청의 재접수와 재시작시 검토 사유 보존을 검사한다. [140](../../../server/collaboration/inbox-upgrade.test.ts) · [141](../../../server/convenience/personal-http.test.ts) · [142](../../../server/workflows/manual-disclosure.test.ts)
- 143은 500행 단위를 넘는 정렬 backfill, 트랜잭션 롤백과 재시작을 검사한다. 144는 재개 가능한 링크 재구성과 기존 버전의 바이트·승인 해시 보존을 검사한다. 145는 기존 버전 보존과 재시작, 작업자가 멈춘 뒤 동일 archive 재시도의 단일 적용을 검사한다. [143](../../../server/convenience/structure-migration.test.ts) · [144](../../../server/convenience/links-migration.test.ts) · [145](../../../server/convenience/bulk-migration.test.ts) · [작업 재실행](../../../server/convenience/bulk.test.ts)
- 146~148은 기존 정의·감사 영수증 보존과 중단한 DDL의 롤백을 검사한다. 148 적용 후의 신규 쓰기는 작업 종류와 시각을 요구한다. 147 형식으로 쓰는 구 프로세스를 먼저 교체해야 한다. DB의 트랜잭션 롤백 검증과 운영 바이너리·데이터 전체 복구는 각각 별도 조건이다. [검사](../../../server/convenience/views-migration.test.ts) · [기존 영수증](../../../server/convenience/views-erasure.test.ts)
- 구 문서·댓글·공유 링크, 알림의 개별 읽음, 기존 작성 draft/edit, 구 bulk preview/apply 별명에 대한 회귀가 있다. C12에서는 구 `#notifications`와 문서·댓글 링크, 초안 저장 경로를 직접 사용했다. 구 UI만 복귀하면 새 태그 작업의 검토 상태를 제대로 표현할 수 없어 현행 UI에서 영수증을 확인해야 한다. [이동](../../../src/operational/convenience/route.test.ts) · [기존 알림 읽음 HTTP](../../../server/runtime/collaboration-host.test.ts) · [작성](../../../server/workflows/workflows.test.ts) · [이전 UI 확인](../2026-11-18-properties-bulk/README.md)

## 검사와 미충족 기준

- 최종 하네스의 실패 경로 시험 4개가 통과했다. 실제 마이그레이션 실패로 초기화 풀이 반환되지 않은 경우와 첫 PNG 저장 후 중단한 경우에 각 실행의 DB가 사라지고 공개 파일 해시가 유지됐다. 별도 연결을 잡아 둔 자기 DB는 DROP이 정직하게 실패했고 정확한 DB 이름이 보고됐다. 이후 다른 자원 정리가 실행됐으며 시험 종료 시 자기 연결을 닫고 DB를 정리했다. 불완전한 결과·정리, 세트 이름 충돌에서도 기존 인덱스와 세트가 보존됐다. [시험](capture-lifecycle.test.mjs) · [원출력 발췌](lifecycle-checks.txt)
- 제품 소스가 같은 기준 커밋 `8952637`의 전체 실행 결과다. 이번 독립 리뷰 보강에서 새로 실행한 항목은 Chromium 연결 흐름, 두 환경의 overlay validator와 Compose HTTP/정리다.
- `npm run check`에서 프런트엔드 572개, Node 48개, import 16개, 평가 도구 41개, 251개 요구사항의 로드맵·수용 문구·운영 상태 정합성, 서버 타입, 빌드, 정적 HTTP smoke를 통과했다. 번들 크기 경고가 남았다.
- `npm run test:server`는 테스트 러너 13개와 UUID별 독립 PostgreSQL DB에서 서버 파일 **160/160, 시험 1,289개**를 통과했다. 각 파일 종료 후 생성한 DB를 정리했고 전체 명령 종료 코드는 0이다.
- `kubectl version --client` v1.36.1, `node scripts/k8s/test.mjs` 38개 통과. CI 합성 STG/PROD overlay를 만들고 양쪽 validator 통과 및 미설정 template 양쪽 거절을 확인했다. 고유 Compose 프로젝트를 빌드해 healthy와 실제 HTML·JS/CSS·브랜드·MIME·404 smoke를 확인하고 컨테이너와 네트워크를 정리했다. 네이티브 Kind 백업·복원과 사내 배포는 수행하지 않았다. [validator·Compose 원출력 발췌](infrastructure.txt) · [CI 정의](../../../.github/workflows/ci.yml)
- EDT-001은 일부 자료 왕복과 읽기 도구가 있지만 전체 편집·내보내기·가져오기에서 코드·표·내부 링크 의미 보존의 인수가 열려 있다. KNO-007 도메인별 권위 우선순위와 KNO-010 문서 병합의 권한 재확인·대상·사유 안내도 미충족이다. C8의 과거 CI `44161579437`는 보존 의존성을 과대 해석해 물리 보존 회귀 4개가 실패했다. 수정 후 회귀와 과거 실패를 각각 기록했다. [원 요구사항](../../requirements/requirements.json) · [자료 왕복 검사](../../../server/storage/roundtrip.test.ts) · [C8 실패와 수정](../2026-11-18-internal-links/README.md)
- C10 CI `44195108660`의 주간 재시도 시점 시험 실패는 DB·앱 시계 경계 회귀로 기록됐다. `44207497816`은 157개 서버 파일 중 149개 통과 후 20분 한도로 취소됐고 종합 검사가 실패했다. 현재 CI 서버 작업의 제한은 30분이다. [실수 기록](../../MISTAKE_LOG.md) · [CI 정의](../../../.github/workflows/ci.yml)
- 사내 SSO 로그인, 실제 OS IME·스크린리더, 다중 인스턴스 3만 사용자 부하, 실데이터 보존/복구, 모델 종합의 품질·지식 누적·후속 에이전트 효과는 별도 인수가 필요하다. C12에서 사람의 수동 작성과 검토 경로를 실행했다. [평가 계약](../../EVALUATION.md)
