import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  KeyRound,
  LockKeyhole,
  Plug,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { Badge, Button } from "../ui/primitives";
import { consoleLabel } from "./console";
import type { ConsoleTab } from "./console";
import {
  allowedOperations,
  changeManagement,
  createManagement,
} from "./management";
import type { ManagementAction, SpaceRole, Visibility } from "./management";
import { ConsoleTable } from "./ConsoleTable";
import type { ConsoleRow } from "./ConsoleTable";
import { PreviewDialog } from "./PreviewDialog";
import type { PreviewOperation } from "./PreviewDialog";
import { Coverage } from "./FeatureCoverage";

const sections = [
  "users",
  "access",
  "agents",
  "integrations",
  "policies",
  "lifecycle",
  "activity",
  "evaluation",
  "coverage",
];
function Info({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="console-info">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
function Definition({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="console-definition">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
const roleOptions = ["Read", "Triage", "Write", "Maintain", "Admin"];

/** All mutations below belong to an explicit, memory-only synthetic scenario. */
export function Management({
  section,
  preview,
  navigate,
}: {
  section: ConsoleTab;
  preview: boolean;
  navigate: (tab: ConsoleTab) => void;
}) {
  const [state, setState] = useState(createManagement);
  const [selected, setSelected] = useState<string | null>(null);
  const [operation, setOperation] = useState<PreviewOperation | null>(null);
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState("전체");
  useEffect(() => {
    setSelected(null);
    setNotice("");
    setCategory("전체");
    setOperation(null);
  }, [section]);
  if (!sections.includes(section)) return null;
  if (section === "coverage") return <Coverage navigate={navigate} />;
  if (!preview)
    return (
      <section className="op-panel console-mock-boundary">
        <LockKeyhole size={32} />
        <Badge tone="amber">관리 API 미연결 · 목업 별도 제공</Badge>
        <h2>{consoleLabel(section)}</h2>
        <p>
          현재 운영 서버는 이 관리 기능을 제공하지 않습니다. 현행
          reader/editor/reviewer 권한은 그대로이며, 이 화면이 Admin/Owner 권한을
          부여하지 않습니다.
        </p>
        <p>
          독립 미리보기에서 합성 사용자·공간·에이전트로 화면과 동작을 확인할 수
          있습니다. 실제 세션·자료·권한은 전달하지 않습니다.
        </p>
        <a className="button primary" href={`/?preview=1#${section}`}>
          독립 목업 열기 <ArrowUpRight size={16} />
        </a>
        <Button variant="ghost" onClick={() => navigate("coverage")}>
          전체 기능과 남은 조건
        </Button>
      </section>
    );
  const act = (action: ManagementAction) => {
    if (!preview) throw Error("운영 상태를 목업으로 변경할 수 없습니다.");
    // Dialog submissions are synchronous and retain validation errors until corrected.
    const next = changeManagement(state, action);
    setState(next);
    setNotice(next.events[0].detail);
  };
  const confirm = (
    title: string,
    description: string,
    action: ManagementAction,
  ) => setOperation({ title, description, run: () => act(action) });
  const record = (title: string, description: string) =>
    confirm(title, description, {
      type: "record",
      detail: `${title} 확인 예시 · 실제 실행/전송 없음`,
    });
  const row = (id: string, cells: ReactNode[], search: string): ConsoleRow => ({
    id,
    cells,
    search,
  });
  const detail = (title: string, children: ReactNode) => (
    <section className="op-panel console-detail" aria-label="선택 항목 상세">
      <div className="op-section-head">
        <h2>{title}</h2>
        <Button onClick={() => setSelected(null)}>상세 닫기</Button>
      </div>
      {children}
    </section>
  );
  const person = state.people.find((p) => p.id === selected);
  const space = state.spaces.find((p) => p.id === selected);
  const credential = state.credentials.find((p) => p.id === selected);
  const doc = state.documents.find((p) => p.id === selected);
  return (
    <div className="console-management">
      <div className="console-management-boundary">
        <ShieldCheck size={18} />
        <span>
          <strong>합성 관리 시나리오</strong> · ADR 005의 역할·소유권은
          제안입니다. 현행 인증/권한 구현을 교체하지 않습니다. 모든 동작은
          새로고침하면 사라집니다.
        </span>
        <Button
          variant="ghost"
          onClick={() =>
            setOperation({
              title: "목업 상태 초기화",
              description:
                "이 미리보기에서 변경한 관리 상태만 초기화합니다. 실제 앱에는 영향이 없습니다.",
              run: () => {
                setState(createManagement());
                setSelected(null);
                setNotice("관리 목업을 초기화했습니다.");
              },
            })
          }
        >
          목업 초기화
        </Button>
      </div>
      {notice && (
        <p className="op-notice" role="status">
          {notice}
        </p>
      )}

      {section === "users" && (
        <>
          <section className="op-panel">
            <div className="op-section-head">
              <div>
                <h2>사람과 책임 주체</h2>
                <p className="muted">
                  에이전트 환경의 접근·검토·인계 책임을 관리합니다. 사용자
                  생산성 순위는 제공하지 않습니다.
                </p>
              </div>
              <Button
                variant="primary"
                onClick={() =>
                  setOperation({
                    title: "팀 구성원 초대",
                    description:
                      "합성 초대 대기를 만듭니다. 실제 메일/가입/공간 권한은 생기지 않습니다. 수락 후 별도 공간 역할과 새 독자 영향을 확인해야 합니다.",
                    fields: [
                      { name: "name", label: "표시 이름" },
                      { name: "email", label: "합성 이메일", type: "email" },
                    ],
                    submit: "초대 대기 만들기",
                    run: (data) =>
                      act({
                        type: "invite",
                        name: String(data.get("name")),
                        email: String(data.get("email")),
                      }),
                  })
                }
              >
                <Plus size={16} /> 구성원 초대
              </Button>
            </div>
            <ConsoleTable
              caption="팀 구성원과 초대"
              columns={["사용자", "팀", "공간 역할", "상태", "권한 부여 경로"]}
              rows={state.people.map((p) =>
                row(
                  p.id,
                  [
                    <span>
                      <strong>{p.name}</strong>
                      <small className="console-cell-sub">{p.email}</small>
                    </span>,
                    p.owner ? `${p.team} · Owner` : p.team,
                    <Badge tone="plum">{p.role}</Badge>,
                    <Badge tone={p.status === "활성" ? "green" : "amber"}>
                      {p.status}
                    </Badge>,
                    p.path,
                  ],
                  `${p.name} · ${p.email} ${p.role} ${p.status} ${p.path}`,
                ),
              )}
              select={setSelected}
            />
          </section>
          {person &&
            detail(
              `${person.name} · 계정과 실효 권한`,
              <>
                <Definition
                  items={[
                    ["신원", <code>{person.id} · 합성 subject</code>],
                    ["현재 상태", person.status],
                    ["공간 역할", person.role],
                    ["부여 경로", person.path],
                    [
                      "만료",
                      person.status === "초대 대기"
                        ? "7일 후 만료 · 예시"
                        : "사내 멤버십 유효 기간 내",
                    ],
                    [
                      "자료 제한",
                      "모든 원본/상위 제한의 교집합. Admin도 우회 불가.",
                    ],
                  ]}
                />
                <div className="op-actions">
                  <Button
                    onClick={() =>
                      setOperation({
                        title: "공간 역할 변경",
                        description:
                          "새 역할은 이 공간에만 적용하는 예시입니다. 기존 그룹 Read 경로는 남고 관련 승인·토큰·캐시는 재검토 대상입니다. 역할 상승도 기존 토큰 발급 상한을 늘리지 않습니다.",
                        fields: [
                          {
                            name: "role",
                            label: "새 공간 역할",
                            options: roleOptions,
                            value: person.role,
                          },
                        ],
                        run: (data) =>
                          act({
                            type: "role",
                            id: person.id,
                            role: String(data.get("role")) as SpaceRole,
                          }),
                      })
                    }
                  >
                    역할 영향 확인
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      confirm(
                        person.status === "초대 대기"
                          ? "초대 취소"
                          : "계정 상태 변경",
                        "계정 중지는 모든 세션·위임을 차단하는 운영 계약입니다. 마지막 Owner는 보호됩니다. 작성 이력은 보존합니다. 이 화면은 예시만 변경합니다.",
                        {
                          type: "person",
                          id: person.id,
                          status:
                            person.status === "초대 대기"
                              ? "초대 취소"
                              : person.status === "중지"
                                ? "활성"
                                : "중지",
                        },
                      )
                    }
                  >
                    {person.status === "초대 대기"
                      ? "초대 취소"
                      : person.status === "중지"
                        ? "활성화 예시"
                        : "중지 예시"}
                  </Button>
                  <Button
                    onClick={() =>
                      record(
                        "세션 전체 철회",
                        "웹 세션 2개·위임 1개에 대한 철회 영향 예시입니다. 실제 세션 API는 미연결입니다.",
                      )
                    }
                  >
                    세션 2개 · 철회 예시
                  </Button>
                </div>
              </>,
            )}
          <div className="console-two-col">
            <section className="op-panel">
              <h2>팀 · 접근 그룹</h2>
              <Definition
                items={[
                  ["소유 팀", "플랫폼팀 · Owner 김하늘"],
                  ["플랫폼 그룹", "활성 3명 · 공간 Read 경로"],
                  ["지식 검토 그룹", "활성 1명 · Maintain + 지정 검토자"],
                  ["팀 기본 권한", "none · 가입만으로 Private 접근 불가"],
                ]}
              />
              <div className="op-actions">
                <Button
                  onClick={() =>
                    record(
                      "그룹 멤버십 변경 영향",
                      "박지우를 플랫폼 그룹에서 제외해도 직접 Write는 남습니다. 이 확인은 실제 멤버를 변경하지 않습니다.",
                    )
                  }
                >
                  멤버십 영향 미리보기
                </Button>
                <Button
                  onClick={() =>
                    record(
                      "소유권 이전 요청",
                      "마지막 Owner를 제거하기 전 새 인간 Owner의 수락과 원자 이전이 필요합니다. 서비스 주체는 Owner가 될 수 없습니다.",
                    )
                  }
                >
                  소유권 이전 절차
                </Button>
              </div>
            </section>
            <section className="op-panel">
              <h2>접근 요청과 인계</h2>
              {state.requests.map((r) => (
                <Info key={r.id} title={`${r.name} · ${r.status}`}>
                  <p>{r.resource}</p>
                  <Button
                    disabled={r.status !== "대기"}
                    onClick={() =>
                      confirm(
                        "접근 요청 분류",
                        "검토 필요로 분류하는 예시이며 실제 권한은 부여하지 않습니다. 새 독자·원본 영향 검토 후 서버에서 grant를 결정해야 합니다.",
                        { type: "request", id: r.id, status: "검토 필요" },
                      )
                    }
                  >
                    영향 검토로 보내기
                  </Button>
                </Info>
              ))}
              <p className="muted">
                계정 중지 시 팀 지식·근거·작성 이력은 유지하고 미처리 검토와
                담당자를 인계합니다.
              </p>
            </section>
          </div>
        </>
      )}

      {section === "access" && (
        <>
          <section className="op-panel">
            <div className="op-section-head">
              <h2>공간별 소유권과 접근</h2>
              <Badge>역할 ≠ 공개 범위 ≠ 저장 위치</Badge>
            </div>
            <p>
              로컬은 위치, 개인·팀은 소유권입니다. Company는 사내 인증 독자이며
              인터넷 공개가 아닙니다. 공식 기준 여부는 별도 검토를 따릅니다.
            </p>
            <ConsoleTable
              caption="예시 지식 공간"
              columns={[
                "공간",
                "소유자",
                "공개 범위",
                "내 역할 · 예시",
                "자료 제한",
              ]}
              rows={state.spaces.map((s) =>
                row(
                  s.id,
                  [
                    s.name,
                    s.owner,
                    <Badge>{s.visibility}</Badge>,
                    s.role,
                    s.restriction,
                  ],
                  `${s.name} · ${s.owner} ${s.visibility} ${s.role}`,
                ),
              )}
              select={setSelected}
            />
          </section>
          {space &&
            detail(
              space.name,
              <>
                <Definition
                  items={[
                    [
                      "저장 위치",
                      space.personal
                        ? "서버 개인본 · 로컬 연결과 별개"
                        : "서버 발행본이 정본",
                    ],
                    ["소유권", space.owner],
                    ["공개 범위", space.visibility],
                    [
                      "실효 권한",
                      `${space.role} ∩ 현재 원본/자료 제한 ∩ 위임 상한 ∩ 작업 정책`,
                    ],
                    ["제한", space.restriction],
                    ["공식성", "팀 지식 · Company 공개와 공식 기준은 별개"],
                  ]}
                />
                <div className="op-actions">
                  <Button
                    onClick={() =>
                      setOperation({
                        title: "공개 범위 영향 확인",
                        description:
                          "축소는 검색·답변·공유·캐시에 재적용합니다. 확대는 제한 원본과 담당 부서 검토가 필요하여 이 목업에서는 차단합니다. 개인 공간은 Private만 가능합니다.",
                        fields: [
                          {
                            name: "visibility",
                            label: "공개 범위",
                            options: ["Private", "Team", "Company"],
                            value: space.visibility,
                          },
                        ],
                        run: (data) =>
                          act({
                            type: "visibility",
                            id: space.id,
                            visibility: String(
                              data.get("visibility"),
                            ) as Visibility,
                          }),
                      })
                    }
                  >
                    공개 범위 변경 예시
                  </Button>
                  <Button
                    onClick={() =>
                      record(
                        "공간 이전 · 위험 작업",
                        "선택 공간의 이전/삭제는 소유 Owner 확정과 새 독자/근거 영향 검토가 필요합니다. 실제 이전/삭제를 실행하지 않습니다.",
                      )
                    }
                  >
                    위험 작업과 소유권
                  </Button>
                </div>
              </>,
            )}
          <section className="op-panel">
            <h2>역할과 작업 상한</h2>
            <ConsoleTable
              caption="제안 역할별 행동"
              columns={["역할", "허용하는 행동", "여전히 필요한 조건"]}
              rows={[
                [
                  "Read",
                  "발행본·고정 버전 조회, 질문",
                  "로컬 복사·반출·모델 전송은 별도 허가",
                ],
                [
                  "Triage",
                  "검토 큐 분류·검토 요청",
                  "전체 입력 근거 접근 · 자기 지정 불가",
                ],
                [
                  "Write",
                  "원본 등록·변경안·Lint",
                  "공유 정본 직접 덮어쓰기 불가",
                ],
                [
                  "Maintain",
                  "보호 강화·조건부 승인/발행",
                  "지정 인간 검토자 · 독립 승인",
                ],
                [
                  "Admin",
                  "공간 접근·설정 관리",
                  "원본 제한·보호 정책 우회 불가",
                ],
              ].map(([role, action, limit]) =>
                row(
                  role,
                  [role, action, limit],
                  `${role} · ${action} ${limit}`,
                ),
              )}
            />
          </section>
        </>
      )}

      {section === "agents" && (
        <>
          <section className="console-agent-hero op-panel">
            <div className="console-service-icon">
              <Bot size={30} />
            </div>
            <div>
              <Badge tone="plum">팀 소유 서비스 주체 · 목업</Badge>
              <h2>knowledge-maintainer</h2>
              <p>
                읽기와 편입 제안에 한정된 실행 신원입니다. 사람
                Owner·검토자·발행자가 될 수 없습니다.
              </p>
            </div>
            <Definition
              items={[
                ["담당자", "플랫폼팀 · 김하늘"],
                ["공간", "@platform/engineering"],
                ["수명주기", "담당자·만료·폐기·회전 필요"],
              ]}
            />
          </section>
          <section className="op-panel">
            <div className="op-section-head">
              <div>
                <h2>범위가 제한된 자격증명</h2>
                <p className="muted">
                  실제 Bearer 인증은 미연결입니다. 토큰 원문은
                  생성/표시/저장하지 않습니다.
                </p>
              </div>
              <Button
                variant="primary"
                onClick={() =>
                  setOperation({
                    title: "범위 토큰 메타데이터 예시",
                    description:
                      "발급자 현재 권한 ∩ 지정 공간 ∩ 작업 ∩ 만료가 상한입니다. 승인·발행·멤버/정책 관리는 위임하지 않습니다. 예시 메타데이터만 추가합니다.",
                    fields: [
                      { name: "name", label: "토큰 이름" },
                      {
                        name: "owner",
                        label: "책임 담당자",
                        value: "플랫폼팀 · 김하늘",
                      },
                      {
                        name: "operation",
                        label: "허용 작업",
                        options: allowedOperations,
                      },
                      {
                        name: "days",
                        label: "만료까지 일수 (1~90)",
                        type: "number",
                        value: "7",
                      },
                    ],
                    run: (data) =>
                      act({
                        type: "credential",
                        name: String(data.get("name")),
                        owner: String(data.get("owner")),
                        operations: [String(data.get("operation"))],
                        days: Number(data.get("days")),
                      }),
                  })
                }
              >
                <KeyRound size={16} /> 범위 토큰 예시
              </Button>
            </div>
            <ConsoleTable
              caption="자격증명 메타데이터"
              columns={[
                "이름",
                "담당자",
                "허용 작업",
                "만료",
                "상태",
                "최근 사용",
              ]}
              rows={state.credentials.map((c) =>
                row(
                  c.id,
                  [
                    c.name,
                    c.owner,
                    <code>{c.operations.join(", ")}</code>,
                    `${c.days}일 · 예시`,
                    <Badge tone={c.status === "활성" ? "green" : "red"}>
                      {c.status}
                    </Badge>,
                    c.lastUsed,
                  ],
                  `${c.name} · ${c.owner} ${c.operations} ${c.status}`,
                ),
              )}
              select={setSelected}
            />
          </section>
          {credential &&
            detail(
              credential.name,
              <>
                <p>
                  대상 환경: 미리보기 · 공간: platform · 원문: 재조회
                  불가(생성하지 않음). 권한 확대는 새 발급이 필요하며 현재 권한
                  축소는 즉시 교집합에 반영해야 합니다.
                </p>
                <div className="op-actions">
                  <Button
                    disabled={credential.status === "폐기"}
                    variant="danger"
                    onClick={() =>
                      confirm(
                        "자격증명 폐기 예시",
                        "해당 예시 메타데이터를 폐기 상태로 바꿉니다. 실제 토큰과 세션에는 영향이 없습니다.",
                        { type: "revoke", id: credential.id },
                      )
                    }
                  >
                    폐기 예시
                  </Button>
                  <Button
                    onClick={() =>
                      record(
                        "자격증명 회전 계획",
                        "새 상한을 검토해 신규 발급 → 연결 확인 → 기존 토큰 폐기 순서입니다. 실제 키 교체는 서버 비밀 저장소에서 수행합니다.",
                      )
                    }
                  >
                    회전 절차
                  </Button>
                </div>
              </>,
            )}
          <div className="console-two-col">
            <section className="op-panel">
              <h2>API · MCP 연결 계약</h2>
              <p>
                현재 운영 MCP는 쿠키 세션 인증입니다. 이 목업의 서비스
                주체·Bearer 토큰과 혼동하지 마세요.
              </p>
              <pre>{`POST /mcp\nknowledge_search → 고정 버전과 근거 읽기\n편입 제안 → 인간 검토 → 발행\n질문 결과 → 파생 후보로 재편입`}</pre>
              <Button
                onClick={() =>
                  record(
                    "연결 가이드 확인",
                    "현재 서버의 실제 도구 이름·입출력은 docs/AGENT_INTERFACE.md와 API 계약을 기준으로 합니다. 이 가이드가 새 토큰 인증을 활성화하지 않습니다.",
                  )
                }
              >
                설정 전 확인 사항
              </Button>
            </section>
            <section className="op-panel">
              <h2>업무 맥락 · 분량 예산</h2>
              <Definition
                items={[
                  ["프로젝트/환경", "플랫폼 · Ubuntu · 예시"],
                  ["버전 고정", "각 인용의 pageId + version 보존"],
                  ["읽기 예산", "8,000자 · 예시 정책 (미연결)"],
                  ["금지 작업", "독립 검토·발행·접근 확대 위임"],
                ]}
              />
              <Button
                onClick={() =>
                  record(
                    "업무 맥락 미리보기",
                    "적용 환경·제약·상충·근거·미확인 항목을 분량 예산 안에서 반환하는 목표 계약입니다. 실제 context API는 미연결입니다.",
                  )
                }
              >
                반환 맥락 미리보기
              </Button>
            </section>
          </div>
        </>
      )}

      {section === "integrations" && (
        <>
          <section className="op-panel">
            <h2>연결 경로와 수집 경계</h2>
            <div className="console-integration-grid">
              {[
                [
                  "서버 REST · MCP",
                  "쿠키 인증 경로 구현",
                  "이 목업은 서버에 연결하지 않음",
                ],
                [
                  "개인 로컬 위키",
                  "별도 합성 커넥터",
                  "연결 중 동기화 · 공통 서비스 통합 미완료",
                ],
                ["업무 도구 수집기", "미연결", "허용된 산출물만 명시 선택"],
                [
                  "모델 게이트웨이",
                  "서버 설정 필요",
                  "허용 목적지·모델·전송 정책 확인",
                ],
              ].map(([name, status, desc]) => (
                <Info key={name} title={name}>
                  <Badge tone="amber">{status}</Badge>
                  <p>{desc}</p>
                  <Button
                    onClick={() =>
                      record(
                        `${name} 연결 진단 예시`,
                        "합성 설정의 인증 방식·자료 선택·ACL 최신성·전송 목적지를 확인하는 화면입니다. 실제 네트워크 테스트는 하지 않습니다.",
                      )
                    }
                  >
                    <Plug size={15} /> 진단 항목 보기
                  </Button>
                </Info>
              ))}
            </div>
          </section>
          <section className="op-panel">
            <div className="op-section-head">
              <h2>서버 자동화 · 예산</h2>
              <Badge tone={state.paused ? "amber" : "neutral"}>
                {state.paused
                  ? "신규 수락 중지 예시"
                  : "설정 예시 · 실행되지 않음"}
              </Badge>
            </div>
            <Definition
              items={[
                ["주간 점검", state.schedule],
                [
                  "작업별 호출 예산",
                  `${state.budget}건 · 예시 · 실제 과금 제한 아님`,
                ],
                ["실행 보장", "지속 worker/임대/재시도·자동 실행 미연결"],
                [
                  "로컬 커넥터",
                  "호스트 연결 중에만 동기화. 연결 종료 후 daemon/예약 실행 없음.",
                ],
              ]}
            />
            <div className="op-actions">
              <Button
                onClick={() =>
                  setOperation({
                    title: "일정 · 예산 설정 예시",
                    description:
                      "서버 유지관리 일정의 UI 목업입니다. 설정 저장과 실제 무인 실행은 다릅니다. 로컬 상시 실행은 제공하지 않습니다.",
                    fields: [
                      {
                        name: "schedule",
                        label: "일정 · 시간대",
                        value: state.schedule,
                      },
                      {
                        name: "budget",
                        label: "작업별 호출 예산 (1~10000)",
                        type: "number",
                        value: String(state.budget),
                      },
                    ],
                    run: (d) =>
                      act({
                        type: "schedule",
                        schedule: String(d.get("schedule")),
                        budget: Number(d.get("budget")),
                      }),
                  })
                }
              >
                일정 · 예산 변경
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  confirm(
                    "신규 작업 수락 전환 예시",
                    "신규 수락 중지와 실행 중 작업 취소는 다릅니다. 이미 시작한 외부 부작용의 회수를 보장하지 않습니다.",
                    { type: "pause" },
                  )
                }
              >
                {state.paused ? "수락 재개 예시" : "긴급 중지 예시"}
              </Button>
              <Button
                onClick={() =>
                  record(
                    "재시도 · 취소 요청 예시",
                    "멱등 키·기준 버전·현재 ACL을 다시 검사하고, 취소 요청됨/실제 중단됨을 분리해야 합니다. 실제 worker 제어는 미연결입니다.",
                  )
                }
              >
                작업 제어 미리보기
              </Button>
            </div>
          </section>
          <section className="op-panel">
            <h2>수집 · 제외 · 연결 신선도</h2>
            <Definition
              items={[
                ["수집 범위", "명시 선택 산출물만 · 대화 전체 자동 수집 금지"],
                ["제외 대상", "개인 비밀 · 키 · 미선택 파일 · 제한 원본"],
                ["외부 ACL", "최신 확인 실패 시 보호 내용 제공 차단"],
                ["로컬 상태 예시", "미전송 2건 · 충돌 1건 · 다음 연결 시 재개"],
              ]}
            />
            <Button
              onClick={() =>
                record(
                  "수집 동의와 제외 정책",
                  "수집 목적·원본 시스템·현재 독자·보존 기간·모델 목적지를 고지하고 명시 선택합니다. 실제 수집/업로드는 하지 않습니다.",
                )
              }
            >
              수집 정책 확인
            </Button>
          </section>
        </>
      )}

      {section === "policies" && (
        <>
          <section className="op-panel">
            <div className="op-section-head">
              <h2>검토 · 보호 규칙</h2>
              <Badge tone="plum">제안 정책 · UI 목업</Badge>
            </div>
            <Definition
              items={[
                ["팀 발행", state.policy],
                ["고정 대상", "본문·근거/전체 입력·기준 버전·독자·정책 해시"],
                ["재검토", "내용/기준/원본/독자/정책/검토자 자격 변경 시"],
                ["공식 기준", "담당 부서 별도 검토 · Company와 별개"],
                ["자동 반영", "에이전트 승인/발행 금지 · 관리자 우회 없음"],
              ]}
            />
            <div className="op-actions">
              <Button
                onClick={() =>
                  setOperation({
                    title: "보호 규칙 강화",
                    description:
                      "독립 인간 검토·자기 승인 금지는 줄일 수 없습니다. 보호 범위를 추가하는 예시입니다. 실제 정책 변경은 하지 않습니다.",
                    fields: [
                      {
                        name: "policy",
                        label: "추가 보호 범위",
                        value: "공식 기준 · 근거 변경",
                      },
                    ],
                    run: (d) =>
                      act({ type: "policy", policy: String(d.get("policy")) }),
                  })
                }
              >
                보호 강화 예시
              </Button>
              <Button
                onClick={() =>
                  record(
                    "모델 · 자료 전송 정책",
                    "허용 목적지·원본 등급·반출 동의·작업별 예산을 서버에서 검사해야 합니다. 프롬프트 내부 지시문은 권한이 아닙니다.",
                  )
                }
              >
                전송 · 민감정보 정책
              </Button>
            </div>
          </section>
          <section className="op-panel">
            <h2>수신자 지정 공유</h2>
            <p>
              링크 복사는 기존 권한 탐색이고 새 독자 권한 부여가 아닙니다. 아래
              공유는 문서·버전·수신자·만료를 한정한 제안 grant의 예시입니다.
            </p>
            <ConsoleTable
              caption="활성 공유 예시"
              columns={[
                "문서",
                "수신자",
                "버전 · 자식 범위",
                "만료",
                "상태",
                "동작",
              ]}
              rows={state.shares.map((s) =>
                row(
                  s.id,
                  [
                    s.title,
                    s.recipient,
                    s.version,
                    s.expiry,
                    <Badge>{s.status}</Badge>,
                    <Button
                      disabled={s.status === "철회"}
                      onClick={() =>
                        confirm(
                          "공유 철회 예시",
                          "다음 본문·첨부·변환본·고정 버전 요청에 현재 권한을 재적용해야 합니다. 실제 grant에는 영향이 없습니다.",
                          { type: "share", id: s.id },
                        )
                      }
                    >
                      철회 예시
                    </Button>,
                  ],
                  `${s.title} · ${s.recipient} ${s.status}`,
                ),
              )}
            />
            <div className="op-actions">
              <Button
                onClick={() =>
                  record(
                    "수신자 공유 제안",
                    "플랫폼팀의 활성 멤버 → 읽을 수 있는 문서 고정 v3 → 기존 자식만 → 7일 만료를 가정합니다. 원본 독자 교집합 밖이면 차단합니다. 이 확인은 새 grant를 만들지 않습니다.",
                  )
                }
              >
                새 공유 영향 확인
              </Button>
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${window.location.origin}/?preview=1#knowledge`)
                    .then(
                      () =>
                        setNotice(
                          "목업 탐색 링크를 복사했습니다. 데이터/권한은 전달하지 않습니다.",
                        ),
                      () =>
                        setNotice(
                          "복사할 수 없습니다. 주소창의 목업 주소를 복사하세요.",
                        ),
                    );
                }}
              >
                <Copy size={15} /> 기존 권한 링크 복사
              </Button>
            </div>
          </section>
          <section className="op-panel">
            <h2>반출 · 선택 정책 · 위험 작업</h2>
            <Definition
              items={[
                [
                  "익명 공개 / 외부 게스트",
                  "선택 요구사항 보존 · 기본 비활성 · 별도 승인 전 차단",
                ],
                [
                  "원본 정제본 공개",
                  "원본 공개 결정 권한자의 별도 결정·새 자료 필요",
                ],
                ["원본 철회", "파생본·답변·과거 버전·캐시까지 영향 확인"],
                ["자료 등급", "Admin/Owner도 원본 제한 우회 불가"],
              ]}
            />
            <Button
              variant="danger"
              onClick={() =>
                record(
                  "원본 철회 영향 미리보기",
                  "예시 영향: 파생 지식 2개·답변 1개·검토 1건. 실제 계보 조회/철회는 미연결이며 이 숫자는 합성 시나리오입니다.",
                )
              }
            >
              원본 철회 영향 보기
            </Button>
          </section>
        </>
      )}

      {section === "lifecycle" && (
        <>
          <section className="op-panel">
            <div className="op-section-head">
              <h2>편집 · 버전 · 보존</h2>
              <label className="console-inline-filter">
                상태
                <select
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setSelected(null);
                  }}
                >
                  {["전체", "발행", "보관", "휴지통"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              개인 초안과 발행본을 분리하고 변경 제안으로 공유합니다. 복원은 새
              버전이며 과거 권한을 복구하지 않습니다.
            </p>
            <ConsoleTable
              key={category}
              caption="지식 수명주기 예시"
              columns={["문서", "버전", "상태", "로컬 복사", "검증"]}
              rows={state.documents
                .filter((d) => category === "전체" || d.status === category)
                .map((d) =>
                  row(
                    d.id,
                    [
                      d.title,
                      `v${d.version}${d.draft ? " · 개인 초안 있음" : ""}`,
                      <Badge>{d.status}</Badge>,
                      d.localCopy ? "정책 확인 후 허용" : "금지",
                      d.verification,
                    ],
                    `${d.title} · ${d.status} ${d.verification}`,
                  ),
                )}
              select={setSelected}
            />
          </section>
          {doc &&
            detail(
              doc.title,
              <>
                <Definition
                  items={[
                    ["현재 버전", `v${doc.version} · 합성`],
                    [
                      "원본 근거",
                      "원본 스냅샷·전체 입력 계보와 현재 제한 보존",
                    ],
                    ["검토 기한", "2026-11-06 · 예시 (수정일과 검증일은 별도)"],
                    [
                      "담당자 / 인계",
                      "플랫폼팀 · 담당자 중지 시 대체 검토자 지정",
                    ],
                    [
                      "반출",
                      doc.localCopy
                        ? "읽기와 별도 허가·현재 정책 검사 필요"
                        : "원본 정책으로 금지",
                    ],
                  ]}
                />
                {doc.draft && (
                  <details>
                    <summary>저장한 개인 초안 · 발행되지 않음</summary>
                    <pre>{doc.draft}</pre>
                  </details>
                )}
                <div className="op-actions">
                  <Button
                    onClick={() =>
                      setOperation({
                        title: "개인 초안 편집 예시",
                        description:
                          "이 목업의 개인 초안만 변경합니다. 현재 발행본과 독자는 바뀌지 않습니다. 실제 공유는 고정 revision의 변경 제안·독립 검토가 필요합니다.",
                        fields: [
                          {
                            name: "content",
                            label: "초안 Markdown",
                            type: "textarea",
                            value:
                              doc.draft ??
                              `## ${doc.title}\n\n적용 환경: Ubuntu\n근거: 원본 고정 버전\n한계: 독립 실행 미검증`,
                          },
                        ],
                        submit: "개인 초안 예시 저장",
                        run: (d) =>
                          act({
                            type: "draft",
                            id: doc.id,
                            content: String(d.get("content")),
                          }),
                      })
                    }
                  >
                    개인 초안 편집
                  </Button>
                  <Button
                    onClick={() =>
                      confirm(
                        "이전 버전 복원 예시",
                        `고정 이전 본문을 새 v${doc.version + 1}로 만드는 상태 예시입니다. 현재 권한은 유지합니다. 실제 서버 복원/검토는 미연결입니다.`,
                        { type: "restore", id: doc.id },
                      )
                    }
                  >
                    새 버전으로 복원 예시
                  </Button>
                  <Button
                    onClick={() =>
                      confirm(
                        "보관 상태 변경 예시",
                        "발행 검색과 원본 보존을 구분합니다. 원본/답변/공유·보존 정책 영향은 실제 서버에서 검사해야 합니다.",
                        {
                          type: "document",
                          id: doc.id,
                          status: doc.status === "보관" ? "발행" : "보관",
                        },
                      )
                    }
                  >
                    {doc.status === "보관" ? "보관 해제 예시" : "보관 예시"}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() =>
                      confirm(
                        "휴지통 이동 예시",
                        "보존 기간 이후 영구 삭제·법적 보존·백업 정리는 별도 승인 작업입니다. 실제 삭제는 하지 않습니다.",
                        { type: "document", id: doc.id, status: "휴지통" },
                      )
                    }
                  >
                    휴지통 예시
                  </Button>
                  <Button
                    onClick={() =>
                      confirm(
                        "내보내기 영향 확인",
                        "읽기 권한만으로 내보낼 수 없습니다. 반출 금지 자료는 목업에서도 차단합니다. 파일 다운로드는 하지 않습니다.",
                        { type: "export", id: doc.id },
                      )
                    }
                  >
                    반출 가능 여부 확인
                  </Button>
                </div>
              </>,
            )}
          <section className="op-panel">
            <h2>작성 · 첨부 · 협업</h2>
            <div className="console-integration-grid">
              <Info title="문서 속성과 템플릿">
                <p>
                  페이지 트리·유형·담당자·태그·적용 환경·수동 보호 영역을 갖춘
                  초안으로 시작합니다.
                </p>
                <Button
                  onClick={() =>
                    record(
                      "템플릿 선택 예시",
                      "실패 사례 템플릿: 문제 → 환경/버전 → 시도 → 결과/증거 → 적용 한계 → 후속 검증. 문서 생성 API는 미연결입니다.",
                    )
                  }
                >
                  실패 사례 템플릿
                </Button>
              </Info>
              <Info title="첨부 · 가져오기">
                <p>
                  파일/변환본 검사·현재 ACL·보존 정책이 필요합니다. 이 화면은
                  실제 파일을 읽거나 업로드하지 않습니다.
                </p>
                <Button
                  onClick={() =>
                    record(
                      "첨부/가져오기 사전 검사",
                      "파일 형식·크기·악성 내용·원본 범위·중복·검토용 변환본·현재 접근을 검사해야 합니다. 운영 업로드는 미연결입니다.",
                    )
                  }
                >
                  첨부 정책 확인
                </Button>
              </Info>
              <Info title="댓글 · 멘션 · 구독">
                <p>
                  고정 문단/버전 연결, 검토 요청, 해결 상태와 알림을 함께
                  유지합니다.
                </p>
                <Button
                  onClick={() =>
                    record(
                      "댓글 · 검토 요청 예시",
                      "고정 v3의 적용 조건 문단에 후속 검증을 요청하는 예시입니다. 실제 댓글/멘션 발송은 하지 않습니다.",
                    )
                  }
                >
                  검토 요청 예시
                </Button>
              </Info>
            </div>
          </section>
        </>
      )}

      {section === "activity" && (
        <>
          <div className="console-two-col">
            <section className="op-panel">
              <h2>알림함 · 조치가 필요한 변화</h2>
              <Info title="제한 원본 변경 · 재검토 필요">
                <p>
                  예시: 원본 접근 범위 변경으로 기존 승인이 무효화되었습니다.
                  발행 전 새 독자/근거를 확인하세요.
                </p>
                <Button onClick={() => navigate("review")}>검토함 이동</Button>
              </Info>
              <Info title="담당자 인계 · 미처리 작업">
                <p>
                  예시: 검토 요청 1건과 갱신 기한 1건의 대체 담당자가
                  필요합니다.
                </p>
                <Button onClick={() => navigate("users")}>
                  책임 주체 보기
                </Button>
              </Info>
              <Button
                onClick={() =>
                  confirm(
                    "알림 수신 설정",
                    "개인 알림 수신 설정만 바꾸는 예시입니다. 중요 보안/인계 통지는 조직 정책을 따라야 합니다. 실제 발송은 없습니다.",
                    { type: "notifications" },
                  )
                }
              >
                {state.notifications
                  ? "개인 알림 켜짐 · 변경"
                  : "개인 알림 꺼짐 · 변경"}
              </Button>
            </section>
            <section className="op-panel">
              <h2>운영 준비 · 실제 검증 필요</h2>
              <Definition
                items={[
                  ["환경", "STG / PROD 별도 자격증명·DB"],
                  ["상태 확인", "프로세스 health와 업무 readiness 분리"],
                  ["백업/복원", "CLI 기반 구현 · 현재 결과는 미조회"],
                  ["보관/감사", "보호·독립 저장소·책임자 확인 필요"],
                  ["사고 대응", "계정/키 철회 · 전송 차단 · 증거 보존"],
                ]}
              />
              <Button
                onClick={() =>
                  record(
                    "복구 훈련 계획",
                    "DB·원본/blob·정책·감사를 같은 시점으로 복구하고 현재 권한/삭제 기록을 재검증해야 합니다. 실제 백업/복원은 실행하지 않습니다.",
                  )
                }
              >
                백업 · 복구 절차
              </Button>
            </section>
          </div>
          <section className="op-panel">
            <h2>목업 활동 기록</h2>
            <p>
              아래는 이 브라우저 메모리의 예시 작업입니다. 변경 불가 감사 로그나
              운영 실행 증거가 아닙니다. 실제 원문·키를 남기지 않습니다.
            </p>
            <ConsoleTable
              caption="합성 활동 기록"
              columns={["작업", "시각 · UTC", "추적 ID"]}
              rows={state.events.map((e) =>
                row(
                  e.id,
                  [
                    e.detail,
                    new Date(e.at).toISOString().replace("T", " ").slice(0, 19),
                    <code>{e.id}</code>,
                  ],
                  `${e.detail} · ${e.id} ${e.at}`,
                ),
              )}
            />
          </section>
        </>
      )}

      {section === "evaluation" && (
        <>
          <section className="op-panel console-evaluation-lead">
            <Badge tone="amber">미평가 · 결과 수치 없음</Badge>
            <h2>호출 성공보다, 다음 업무에서의 유용성</h2>
            <p>
              지식 사용 여부만 바꾼 동일 모델·도구·예산·과제의 대조 실험으로
              후속 에이전트 효과를 검증합니다. 승인율·조회 수를 과제 성공률로
              표시하지 않습니다.
            </p>
          </section>
          <section className="op-panel">
            <ConsoleTable
              caption="평가와 검증 계획"
              columns={["평가 축", "확인할 근거", "대조/실패 조건", "상태"]}
              rows={[
                [
                  "근거 정확성",
                  "주장별 원본 위치·버전·독립 증거",
                  "잘못된 인용·반복 인용 중복 집계",
                ],
                [
                  "지식 발전",
                  "새 근거에 따른 결론·조건 수정",
                  "문서만 증가하고 기존 결론 불변",
                ],
                [
                  "상충·시간·환경",
                  "동일 조건/환경 차이·유효 시점",
                  "과거 유효 사실 삭제·무근거 확정",
                ],
                [
                  "경험 재사용",
                  "다른 과제의 적용 결과·실패 보존",
                  "단일 사례의 보편 규칙화",
                ],
                [
                  "후속 업무 효과",
                  "동일 과제 knowledge on/off",
                  "모델·도구·예산 차이에 따른 혼입",
                ],
                [
                  "안전 회귀",
                  "권한 철회·과거 버전·재시도",
                  "무권한 노출·부분/중복 발행",
                ],
              ].map(([name, evidence, condition]) =>
                row(
                  name,
                  [
                    name,
                    evidence,
                    condition,
                    <Badge tone="amber">미실행</Badge>,
                  ],
                  `${name} · ${evidence} ${condition}`,
                ),
              )}
            />
            <div className="op-actions">
              <Button
                onClick={() =>
                  record(
                    "평가 실행 계획 확인",
                    "고정 평가셋/holdout·데이터 버전·모델/규칙 해시·동일 예산·실패 원문과 실행 증거를 먼저 고정합니다. 실제 평가를 실행하지 않습니다.",
                  )
                }
              >
                평가 계획 미리보기
              </Button>
              <Button
                onClick={() =>
                  setOperation({
                    title: "업무 결과 환류 예시",
                    description:
                      "보고된 성공·실패는 독립 검증과 다릅니다. 실행 증거·환경·적용 지식 버전을 함께 기록하고 재검토 후보로 보냅니다. 운영 outcome API는 미연결입니다.",
                    fields: [
                      {
                        name: "result",
                        label: "적용 결과 · 합성 예시",
                        type: "textarea",
                        value:
                          "환경: Ubuntu\n적용 지식: 고정 v3\n관찰: 인증서 검증 오류 지속\n독립 실행 증거: 미첨부\n후속: Python 별도 신뢰 저장소 확인",
                      },
                    ],
                    run: (d) =>
                      act({
                        type: "record",
                        detail: `업무 결과 환류 후보 예시 · ${String(d.get("result")).slice(0, 100)} · 독립 검증 아님`,
                      }),
                  })
                }
              >
                결과 · 반증 환류 예시
              </Button>
            </div>
          </section>
        </>
      )}
      <p className="console-management-footnote">
        <Check size={15} /> 목업 제공 ≠ 서버 기능 완료 ≠ 운영 수용 완료.{" "}
        <Button variant="ghost" onClick={() => navigate("coverage")}>
          251개 기능과 남은 조건 확인
        </Button>
      </p>
      {operation && (
        <PreviewDialog operation={operation} close={() => setOperation(null)} />
      )}
    </div>
  );
}
