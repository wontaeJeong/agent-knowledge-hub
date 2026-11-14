# 버전 비교·선택 복원 UI 검증

Chromium, 로컬 Vite http://127.0.0.1:5183/?app=1#versions, Node24.22.2. 합성 API의 synthetic-reviewer/synthetic-space와 문서1개·버전2개·발행 묶음1개를 사용했다. 실제 SSO·서버·사내 자료·모델 수용 검증이 아니다.

- desktop-1440.png:1440×1000. 버전 비교의 줄 번호/변경, 과거 속성 미확인, 선택 복원의 필드·별도 검토 안내.
- mobile-390.png:390×844. 문서 전체 scrollWidth375이며 비교 표만 가로 스크롤한다. Enter 키로 비교 실행, 발행 묶음 선택까지 확인했다.
- revoked-390.png:버전 API403 이후 비교 본문과 병합 입력이 없어짐을 locator hidden 완료 뒤 확인했다. 첫 click 직후의 임시 상태를 완료 증거로 사용하지 않았다.
- 최초 getByLabel exact selector는 옵션 텍스트가 포함되는 label 때문에 timeout이었고 일반 label matcher로 정상 동작을 확인했다.

추가 자동 검증은 실제 React deferred 응답의 사용자 변경 fence,25줄 이후 비교,발행 묶음 페이지 이동과 문서 변경 초기화다. 실제 DB/native HTTP 시험은 별도 실행했으며 fixture 화면을 그 증거로 대체하지 않는다.

독립 리뷰 수정 후 cross-page-desktop-1440.png/cross-page-mobile-390.png: 첫 목록 v30–v6에서 다음 목록 v5–v1로 이동해 이전 버전만 v1을 선택했다. 대상 v30이 유지되었고 키보드 Enter 비교가 `{from:1,to:30,offset:0}`를 보냈다. 가로 스크롤 표에 본문을 유지하며 페이지 가로 넘침은 없다. 합성 UI와 서버 실제 발행 통합 증거를 구분한다.
