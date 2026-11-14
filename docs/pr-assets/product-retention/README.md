# 보존 정책·일정 화면 확인

Chromium + Node24 Vite, 1440×1000/390×844. 합성 사용자·공간·서비스 실행 주체와 API로 확인했다. 정책의 소유자 범위와 자료 유형별 기간, 영수증의 제품 기록 정리/물리 정리 대기/보존 건수를 구분했다. 모바일 scrollWidth375/viewport390으로 페이지 가로 넘침이 없었고 표는 자체 가로 스크롤을 유지했다.

일정의 ‘승인된 보존 정책 실행’을 선택하면 모델 토큰/비용 입력이 사라졌다. 키보드 Enter 저장과 확인창 수락 뒤 합성 요청에서 kind=retention, policyRevision=4, pageIds/sourceIds=[], 예약 tokens/costMicros=0과 선택한 서비스 자격 증명을 확인했다. 일정 저장은 실제 실행 증거가 아니다. 실제 native HTTP→scheduler→worker DB 검증은 별도 회귀 결과를 따른다.

첫 UI 시도는 hash 이동만으로 이전 합성 실행 주체 목록을 유지해 credential 선택과 저장 확인이 timeout됐다. 페이지를 다시 로드해 fixture 목록을 반영한 뒤 재실행했다. 초기 정책 fixture의 sourceSnapshots 키를 실제 sourceVersions로 수정하고 180일 표시를 확인한 뒤 캡처했다. 서버 오류나 성공으로 바꿔 기록하지 않는다. 실제 회사 계정·보존 자료·정책·외부 물리 삭제를 검증하지 않았다. 공통 헤더 문구 정비는 P2 PR을 따른다.
