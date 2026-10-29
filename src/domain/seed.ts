import type { State, Page } from "./types";
const stamp = "2026-10-26T08:30:00.000Z";
const page = (
  id: string,
  title: string,
  summary: string,
  category: string,
  content: string,
  extras: Partial<Page> = {},
): Page =>
  ({
    id,
    title,
    summary,
    category,
    content,
    scope: "company",
    status: "팀 검토",
    owner: "플랫폼팀",
    tags: ["플랫폼"],
    versions: [
      {
        id: `${id}-v1`,
        number: 1,
        content,
        author: "김민서",
        reason: "초기 지식 등록",
        at: stamp,
        sourceIds:
          id === "container-ca"
            ? ["src-ca"]
            : id === "team-decisions"
              ? ["src-adr"]
              : [],
      },
    ],
    favorite: false,
    reused: 0,
    ...extras,
  }) as Page;
export const caContent = `## 증상\n컨테이너에서 사내 HTTPS 서비스 호출 시 CERTIFICATE_VERIFY_FAILED 오류가 발생합니다.\n\n## 원인\n호스트에 설치된 사내 루트 CA는 컨테이너에 자동 전달되지 않습니다. 이미지의 신뢰 저장소에 CA가 있어야 합니다. [근거 1]\n\n## 적용 방법\nDebian 계열 이미지에 승인된 CA 인증서를 복사하고 신뢰 저장소를 갱신합니다.\n\n\`\`\`dockerfile\nCOPY company-root.crt /usr/local/share/ca-certificates/\nRUN update-ca-certificates\n\`\`\`\n\n## 적용 범위\nDebian / Ubuntu 기반 이미지에서 확인했습니다. Python 라이브러리별 별도 신뢰 저장소 사용 여부는 추가 확인이 필요합니다.\n\n## 주의사항\nTLS 검증을 끄는 방법은 사용하지 않습니다. 인증서는 사내 승인 경로에서 받으세요.`;
export const seed: State = {
  schemaVersion: 1,
  role: "reviewer",
  schedule: { daily: "09:00", weekly: "월요일 09:30", enabled: true },
  pages: [
    page(
      "container-ca",
      "컨테이너에서 사내 CA 인증서 적용하기",
      "인증서 오류의 원인부터 이미지별 설정과 검증까지.",
      "개발 환경",
      caContent,
      {
        favorite: true,
        status: "실행 검증",
        reused: 12,
        tags: ["인증서", "Docker", "트러블슈팅"],
      },
    ),
    page(
      "release-checklist",
      "서비스 배포 전 확인할 것",
      "작은 변경도 같은 기준으로 안전하게 배포합니다.",
      "운영 가이드",
      "## 배포 전\n변경 내역, 마이그레이션과 복구 경로를 확인합니다.\n\n## 배포 중\n준비 상태와 오류율을 확인하고 영향을 제한합니다.\n\n## 배포 후\n핵심 사용자 흐름과 관측 지표를 확인하고 결과를 남깁니다.",
      {
        status: "공식 기준",
        favorite: true,
        reused: 8,
        tags: ["배포", "체크리스트"],
      },
    ),
    page(
      "api-key",
      "API 키 발급과 안전한 보관",
      "발급·회수·회전 작업에 필요한 공통 기준.",
      "보안 · 인증",
      "## 발급\n사용 목적과 최소 권한을 정해 발급합니다.\n\n## 보관\n소스와 업무 산출물에 키 원문을 남기지 않습니다.\n\n## 회수\n사용 종료와 퇴사 시 키를 회수하고 사용 이력을 확인합니다.",
      { status: "공식 기준", reused: 6, tags: ["인증", "API"] },
    ),
    page(
      "team-decisions",
      "플랫폼 설계 결정 기록",
      "선택한 방법과 선택하지 않은 이유를 함께 남깁니다.",
      "기술 설계",
      "## 결정\n장기 실행 작업을 요청 처리와 분리합니다.\n\n## 배경\n문서 편입 작업의 처리 시간이 길어져 사용자의 읽기 요청에 영향을 줄 수 있습니다.\n\n## 대안\n별도 작업자와 지속 작업 기록을 사용하고 중복 전달에 대비합니다.",
      { scope: "team", reused: 4, tags: ["ADR", "아키텍처"] },
    ),
    page(
      "private-notes",
      "모델 비교 실험 메모",
      "공유 전 확인하고 있는 개인 실험 결과.",
      "개인 수집함",
      "## 실험 계획\n동일한 문서와 질문으로 근거 일치율을 비교합니다.\n\n## 상태\n아직 검증하지 않은 가설입니다.",
      {
        scope: "private",
        status: "미검증",
        tags: ["개인"],
        versions: [
          {
            id: "private-v1",
            number: 1,
            content:
              "## 실험 계획\n동일 질문의 근거 정확성을 비교합니다. 미검증 메모입니다.",
            author: "나",
            reason: "개인 초안",
            at: stamp,
            sourceIds: [],
          },
        ],
      },
    ),
  ],
  sources: [
    {
      id: "src-ca",
      title: "Debian 컨테이너의 인증서 오류 해결 기록",
      tool: "Claude Code",
      project: "platform-runtime",
      content:
        "Debian 이미지에 사내 CA를 설치한 후 HTTPS 호출이 정상 동작했습니다. 인증서 검증은 유지합니다.",
      scope: "company",
      verification: "실행 증거 첨부",
      createdAt: stamp,
      processed: true,
      targetPageId: "container-ca",
    },
    {
      id: "src-python",
      title: "Python requests 인증서 경로 추가 검증",
      tool: "OpenCode",
      project: "platform-runtime",
      content:
        "Python requests가 certifi의 별도 CA 번들을 사용하는 환경에서는 시스템 CA 설치만으로 해결되지 않았습니다. REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt 를 지정한 뒤 사내 테스트 엔드포인트에 200 응답을 확인했습니다. Debian 12 + Python 3.12 환경의 합성 예시입니다.",
      scope: "company",
      verification: "실행 증거 첨부",
      createdAt: "2026-10-26T09:00:00.000Z",
      processed: false,
      targetPageId: "container-ca",
    },
    {
      id: "src-adr",
      title: "비동기 작업 실행 방식 설계 대화",
      tool: "Claude Code",
      project: "platform-core",
      content:
        "요청과 작업자 분리, 지속 작업 기록과 재시도를 검토했습니다. 아직 실행 검증하지 않은 팀 설계 제안입니다.",
      scope: "team",
      verification: "작성자 확인",
      createdAt: stamp,
      processed: true,
      targetPageId: "team-decisions",
    },
  ],
  changes: [],
  runs: [],
  shares: [],
  audit: [
    {
      id: "a-seed",
      at: stamp,
      actor: "김민서",
      kind: "지식 등록",
      detail: "컨테이너 CA 가이드와 초기 지식 4개를 준비했습니다.",
    },
  ],
};
