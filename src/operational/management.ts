/** Synthetic management scenarios. NOT an authorization policy or server repository. */
export type SpaceRole = "Read" | "Triage" | "Write" | "Maintain" | "Admin";
export type Person = {
  id: string;
  name: string;
  email: string;
  team: string;
  role: SpaceRole;
  owner: boolean;
  status: "활성" | "중지" | "초대 대기" | "초대 취소";
  path: string;
};
export type Visibility = "Private" | "Team" | "Company";
export type ManagementState = {
  people: Person[];
  spaces: {
    id: string;
    name: string;
    owner: string;
    personal: boolean;
    visibility: Visibility;
    role: SpaceRole;
    restriction: string;
  }[];
  credentials: {
    id: string;
    name: string;
    owner: string;
    operations: string[];
    days: number;
    status: "활성" | "폐기";
    lastUsed: string;
  }[];
  documents: {
    id: string;
    title: string;
    version: number;
    status: "발행" | "보관" | "휴지통";
    localCopy: boolean;
    verification: string;
    draft?: string;
  }[];
  shares: {
    id: string;
    title: string;
    recipient: string;
    version: string;
    expiry: string;
    status: "활성" | "철회";
  }[];
  events: { id: string; at: string; detail: string }[];
  requests: { id: string; name: string; resource: string; status: string }[];
  paused: boolean;
  schedule: string;
  budget: number;
  policy: string;
  notifications: boolean;
};
export const allowedOperations = [
  "knowledge.read",
  "source.create",
  "changeset.propose",
  "personal.sync",
  "local.copy",
];
export function createManagement(): ManagementState {
  return {
    people: [
      {
        id: "owner",
        name: "김하늘",
        email: "haneul@example.test",
        team: "플랫폼팀",
        role: "Admin",
        owner: true,
        status: "활성",
        path: "팀 Owner · 소유 공간 Admin",
      },
      {
        id: "maintainer",
        name: "이서준",
        email: "seojun@example.test",
        team: "플랫폼팀",
        role: "Maintain",
        owner: false,
        status: "활성",
        path: "지식 검토 그룹 · 지정 인간 검토자",
      },
      {
        id: "writer",
        name: "박지우",
        email: "jiwoo@example.test",
        team: "플랫폼팀",
        role: "Write",
        owner: false,
        status: "활성",
        path: "직접 Write + 플랫폼 그룹 Read",
      },
      {
        id: "reader",
        name: "정수민",
        email: "sumin@example.test",
        team: "플랫폼팀",
        role: "Read",
        owner: false,
        status: "활성",
        path: "공개 범위 Team · 발행본만",
      },
    ],
    spaces: [
      {
        id: "platform",
        name: "@platform/engineering",
        owner: "플랫폼팀",
        personal: false,
        visibility: "Team",
        role: "Admin",
        restriction: "제한 근거 2개 · 독자 교집합 유지",
      },
      {
        id: "security",
        name: "@platform/security",
        owner: "플랫폼팀",
        personal: false,
        visibility: "Private",
        role: "Read",
        restriction: "명시적으로 부여한 독자만",
      },
      {
        id: "personal",
        name: "@haneul/personal",
        owner: "김하늘",
        personal: true,
        visibility: "Private",
        role: "Admin",
        restriction: "본인 전용 · 로컬 위치와 별개",
      },
    ],
    credentials: [
      {
        id: "token-reader",
        name: "knowledge-reader",
        owner: "플랫폼팀 · 김하늘",
        operations: ["knowledge.read"],
        days: 7,
        status: "활성",
        lastUsed: "2026-10-30 09:00 UTC · 예시",
      },
    ],
    documents: [
      {
        id: "ca",
        title: "컨테이너 신뢰 저장소 운영 지식",
        version: 3,
        status: "발행",
        localCopy: true,
        verification: "검토됨 · 독립 실행 미검증",
      },
      {
        id: "restricted",
        title: "제한 원본 기반 네트워크 지식",
        version: 2,
        status: "발행",
        localCopy: false,
        verification: "재검증 필요 · 원본 제한",
      },
      {
        id: "legacy",
        title: "이전 배포 환경 가이드",
        version: 1,
        status: "보관",
        localCopy: true,
        verification: "대체 문서 지정 대기",
      },
    ],
    shares: [
      {
        id: "share-1",
        title: "컨테이너 신뢰 저장소 운영 지식",
        recipient: "플랫폼 그룹 · 3명",
        version: "고정 v3 · 현재 자식만",
        expiry: "2026-11-06 09:00 UTC · 예시",
        status: "활성",
      },
    ],
    requests: [
      {
        id: "request-1",
        name: "정수민",
        resource: "현재 공간 · Write 요청",
        status: "대기",
      },
    ],
    events: [
      {
        id: "initial",
        at: "2026-10-30T00:00:00Z",
        detail: "합성 시나리오 시작 · 운영 감사 기록이 아닙니다.",
      },
    ],
    paused: false,
    schedule: "월요일 09:30 · Asia/Seoul",
    budget: 100,
    policy: "독립 인간 검토 1명 · 자기 승인 금지",
    notifications: true,
  };
}
export type ManagementAction =
  | { type: "invite"; name: string; email: string }
  | { type: "person"; id: string; status: Person["status"] }
  | { type: "role"; id: string; role: SpaceRole }
  | {
      type: "credential";
      name: string;
      owner: string;
      operations: string[];
      days: number;
    }
  | { type: "revoke"; id: string }
  | { type: "visibility"; id: string; visibility: Visibility }
  | {
      type: "document";
      id: string;
      status: ManagementState["documents"][number]["status"];
    }
  | { type: "draft"; id: string; content: string }
  | { type: "restore"; id: string }
  | { type: "export"; id: string }
  | { type: "share"; id: string }
  | { type: "request"; id: string; status: string }
  | { type: "pause" }
  | { type: "schedule"; schedule: string; budget: number }
  | { type: "policy"; policy: string }
  | { type: "notifications" }
  | { type: "record"; detail: string };
export function changeManagement(
  previous: ManagementState,
  action: ManagementAction,
): ManagementState {
  const s = structuredClone(previous);
  let detail = "";
  const id = () => crypto.randomUUID();
  switch (action.type) {
    case "invite": {
      const email = action.email.trim().toLowerCase();
      if (!action.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        throw Error("이름과 올바른 합성 이메일을 입력하세요.");
      if (s.people.some((p) => p.email === email))
        throw Error("이미 등록된 구성원 또는 초대입니다.");
      s.people.push({
        id: id(),
        name: action.name.trim(),
        email,
        team: "플랫폼팀",
        role: "Read",
        owner: false,
        status: "초대 대기",
        path: "수락 전 권한 없음",
      });
      detail = "초대 대기 등록 · 실제 메일 전송 없음 · 수락 전 권한 없음";
      break;
    }
    case "person": {
      const p = s.people.find((p) => p.id === action.id);
      if (!p) throw Error("구성원을 찾을 수 없습니다.");
      if (
        (p.status === "초대 대기" || p.status === "초대 취소") &&
        action.status !== "초대 취소"
      )
        throw Error(
          "미수락 초대는 계정 상태로 전환할 수 없습니다. 초대 취소만 가능합니다.",
        );
      if (
        p.owner &&
        action.status !== "활성" &&
        s.people.filter((x) => x.owner && x.status === "활성").length <= 1
      )
        throw Error(
          "마지막 Owner는 중지하거나 제거할 수 없습니다. 수락된 소유권 이전이 먼저 필요합니다.",
        );
      if (
        (p.status === "초대 대기" || p.status === "초대 취소") &&
        action.status === "활성"
      )
        throw Error("초대를 대신 수락할 수 없습니다.");
      p.status = action.status;
      detail = `${p.name} 상태 ${action.status} · 세션·팀 위임·승인·캐시 영향 재검토 예시`;
      break;
    }
    case "role": {
      const p = s.people.find((p) => p.id === action.id);
      if (!p || p.status !== "활성")
        throw Error("활성 멤버에게만 공간 역할을 부여합니다.");
      if (p.owner && action.role !== "Admin")
        throw Error(
          "Owner의 소유 공간 Admin은 역할 변경으로 제거할 수 없습니다.",
        );
      p.role = action.role;
      p.path = `직접 ${action.role} · 기존 그룹 Read 경로 유지`;
      detail = `${p.name} 공간 역할 ${action.role} · 관련 승인 무효화/토큰 상한/기존 그룹 경로 재검토 예시`;
      break;
    }
    case "credential": {
      if (
        !action.name.trim() ||
        !action.owner.trim() ||
        !Number.isInteger(action.days) ||
        action.days < 1 ||
        action.days > 90 ||
        !action.operations.length ||
        action.operations.some((x) => !allowedOperations.includes(x))
      )
        throw Error(
          "담당자·1~90일 만료·허용 작업이 필요합니다. 승인·발행·관리는 위임할 수 없습니다.",
        );
      s.credentials.push({
        id: id(),
        name: action.name.trim(),
        owner: action.owner.trim(),
        operations: [...action.operations],
        days: action.days,
        status: "활성",
        lastUsed: "미사용 · 예시",
      });
      detail =
        "자격증명 메타데이터 예시 추가 · 실제 토큰은 생성하지 않았습니다.";
      break;
    }
    case "revoke": {
      const c = s.credentials.find((c) => c.id === action.id);
      if (!c) throw Error("자격증명이 없습니다.");
      c.status = "폐기";
      detail = `${c.name} 폐기 예시 · 원문 재조회 없음`;
      break;
    }
    case "visibility": {
      const space = s.spaces.find((x) => x.id === action.id);
      if (!space) throw Error("공간이 없습니다.");
      if (space.personal && action.visibility !== "Private")
        throw Error(
          "개인 공간은 본인 전용입니다. 팀 공간으로 별도 변경 제안하세요.",
        );
      if (
        space.visibility !== action.visibility &&
        action.visibility !== "Private"
      )
        throw Error(
          "공개 확대는 원본별 새 독자 영향과 담당 부서 검토가 필요합니다. 이 목업에서는 차단합니다.",
        );
      space.visibility = action.visibility;
      detail = "공개 범위 축소 예시 · 검색/기존 답변/공유/캐시 재검사 필요";
      break;
    }
    case "document": {
      const doc = s.documents.find((d) => d.id === action.id);
      if (!doc) throw Error("문서가 없습니다.");
      doc.status = action.status;
      detail = `${doc.title} ${action.status} 예시 · 현재 원본 제한과 보존 정책 유지`;
      break;
    }
    case "draft": {
      const doc = s.documents.find((d) => d.id === action.id);
      if (!doc || !action.content.trim())
        throw Error("문서와 초안 본문이 필요합니다.");
      doc.draft = action.content;
      detail = `${doc.title} 개인 초안 예시 저장 · 발행본 v${doc.version} 유지`;
      break;
    }
    case "restore": {
      const doc = s.documents.find((d) => d.id === action.id);
      if (!doc) throw Error("문서가 없습니다.");
      doc.version += 1;
      detail = `${doc.title} 복원 v${doc.version} 예시 · 과거 권한 복원 없음 · 실제 서비스에서는 변경 제안/검토 필요`;
      break;
    }
    case "export": {
      const doc = s.documents.find((d) => d.id === action.id);
      if (!doc?.localCopy)
        throw Error(
          "읽기 권한은 반출 허가가 아닙니다. 이 자료는 내보내기가 금지되어 있습니다.",
        );
      detail = `${doc.title} 반출 영향 확인 예시 · 파일 다운로드/본문 전송 없음`;
      break;
    }
    case "share": {
      const share = s.shares.find((x) => x.id === action.id);
      if (!share) throw Error("공유가 없습니다.");
      share.status = "철회";
      detail =
        "수신자 공유 철회 예시 · 다음 본문/첨부/고정 버전 요청에도 재검사 필요";
      break;
    }
    case "request": {
      const request = s.requests.find((x) => x.id === action.id);
      if (!request) throw Error("접근 요청이 없습니다.");
      request.status = action.status;
      detail = "접근 요청 분류 예시 · 실제 grant 부여 없음";
      break;
    }
    case "pause":
      s.paused = !s.paused;
      detail = `서버 작업 신규 수락 ${s.paused ? "중지" : "재개"} 예시 · 실행 중 작업 강제 중단 아님`;
      break;
    case "schedule":
      if (
        !action.schedule.trim() ||
        !Number.isInteger(action.budget) ||
        action.budget < 1 ||
        action.budget > 10000
      )
        throw Error("일정과 1~10000의 호출 예산을 입력하세요.");
      s.schedule = action.schedule.trim();
      s.budget = action.budget;
      detail = "일정/예산 설정 예시 · 실제 무인 실행/과금 제한 없음";
      break;
    case "policy":
      if (!action.policy.trim()) throw Error("보호 범위를 입력하세요.");
      s.policy = `독립 인간 검토 1명 · 자기 승인 금지 · ${action.policy.trim()}`;
      detail = "보호 규칙 강화 예시 · 기존 승인 재검토 필요";
      break;
    case "notifications":
      s.notifications = !s.notifications;
      detail = "개인 알림 수신 설정 예시 · 실제 발송 없음";
      break;
    case "record":
      detail = action.detail;
      break;
  }
  s.events.unshift({ id: id(), at: new Date().toISOString(), detail });
  return s;
}
