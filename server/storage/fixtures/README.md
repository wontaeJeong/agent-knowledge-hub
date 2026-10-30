# 수집기 fixture

`opencode-2.2.2-synthetic.json`은 2026-10-30 로컬 설치된 `opencode v2.2.2`에서 별도 합성 시험 세션을 만들고 `POST /api/session/{sessionID}/synthetic`에 `resume:false`로 한글 시험 문구를 등록해 받은 **실제 HTTP API 응답 형식**이다. 모델 호출·도구 실행은 하지 않았다. 메시지/세션 ID만 익명화했다. 사용자 업무 대화·자격증명·추론 내용은 포함하지 않았다.

`opencode-2.2.2-assistant.json`은 같은 버전의 `GET /api/session/{sessionID}/message/{messageID}`에서 이 저장소 수집기 구현 작업의 **실제 완료된 assistant 응답**을 가져와 익명화했다. 메시지·호출 ID와 모델 식별자를 바꾸고, 도구 입력/출력 및 reasoning 문구를 대체했으며 native provider 필드와 파일 스냅샷은 제거했다. 실제 상태·시각·4개 도구 결과의 배열 구조와 한 도구의 복수 텍스트 결과 구조는 유지했다. 사용자 업무 자료·자격증명·원래 reasoning은 fixture에 보존하지 않았다.

지원 범위는 사용자가 명시 선택한 `api.synthetic-message`와 `api.assistant-message`다. 후자는 완료된 assistant 텍스트와 별도로 선택한 완료 tool 텍스트 출력을 보존하고 reasoning·native·도구 입력·미선택/미완료 출력을 제외하며 누락 개수를 제공한다. 전체 세션 export/다른 버전/도구 설치 승인은 검증했다고 주장하지 않는다. 수집된 도구 출력도 독립 실행 증거로 자동 승인하지 않는다.
