# 개인 대화 화면 확인

Chromium, Node24 Vite, 1440×1000 및390×844. 합성 사용자·공간·API를 사용했다. 완료 답변/고정 인용 버전과 후속 대기 질문, 재개·취소 버튼을 확인했다. 모바일에서 취소 버튼에 키보드 Enter를 입력해 canceled 상태로 변경됨을 확인했다. 이후 대화 상세403 응답을 주고 기다린 결과 비공개 답변과 대화 제목이 모두 사라졌다. 문서 scrollWidth375/viewport390으로 가로 넘침이 없었다.

이미지는 UI 동작 증거이며 실제 회사 계정·모델·자료를 사용한 검증이 아니다. 실제 HTTP·PostgreSQL·큐·모델 loopback 통합은 별도 테스트 기록을 따른다. 기존 공통 헤더 문구 정비는 P2 PR에 포함된다.

리뷰 수정 후 review-desktop-1440.png/review-mobile-390.png: 기본 primary-space에서 UI로 secondary-space를 선택하고 인용을 열었다. 실제 요청의 X-Space-Id=secondary-space를 확인했으며 다른 공간의 같은 ID로 이동하지 않고 화면 안에 고정 본문을 표시했다. null revision/불투명 continuation 합성 응답과 ‘이전 대화 불러오기’로 이전·최근 답변이 모두 표시됨을 확인했다. 모바일 scrollWidth390/viewport390. 최초 fixture는 secondary를 기본 공간으로 줘 헤더가 필요 없는 상태였으므로 이를 다른 공간 검증으로 세지 않았고 실제 공간 전환 뒤 다시 확인했다. 실제 서버 토큰 검증과 22턴 조회는 별도 DB 회귀를 따른다.
