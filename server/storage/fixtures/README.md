# 수집기 fixture

`opencode-2.2.2-synthetic.json`은 2026-10-30 로컬 설치된 `opencode v2.2.2`에서 별도 합성 시험 세션을 만들고 `POST /api/session/{sessionID}/synthetic`에 `resume:false`로 한글 시험 문구를 등록해 받은 **실제 HTTP API 응답 형식**이다. 모델 호출·도구 실행은 하지 않았다. 메시지/세션 ID만 익명화했다. 사용자 업무 대화·자격증명·추론 내용은 포함하지 않았다.

`opencode-2.2.2-assistant.json`은 같은 버전의 `GET /api/session/{sessionID}/message/{messageID}`에서 이 저장소 수집기 구현 작업의 **실제 완료된 assistant 응답**을 가져와 익명화했다. 메시지·호출 ID와 모델 식별자를 바꾸고, 도구 입력/출력 및 reasoning 문구를 대체했으며 native provider 필드와 파일 스냅샷은 제거했다. 실제 상태·시각·4개 도구 결과의 배열 구조와 한 도구의 복수 텍스트 결과 구조는 유지했다. 사용자 업무 자료·자격증명·원래 reasoning은 fixture에 보존하지 않았다.

현재 사용 가능한 범위는 명시 선택한 `api.synthetic-message`다. `api.assistant-message`는 응답에 세션 ID가 없고 호출자 문자열로 실제 세션을 증명할 수 없어 `ARTIFACT_SESSION_UNVERIFIED`로 차단한다. 기존 assistant 성공·출력 필터 시험은 이 제한 때문에 차단 회귀로 대체했다. 신뢰할 수 있는 외부 authority가 실제 artifact와 세션을 결합하고 선택·제외·권한을 검증하기 전까지 재활성화하지 않는다. 실제 호스트/원격 결합은 미구현·미검증이다. 전체 세션 export/다른 버전/도구 설치 승인은 검증했다고 주장하지 않는다.
