import { useEffect, useState } from "react";
import { Button } from "../ui/primitives";
import type { OperationalApi } from "./api";

export type IdentityApi = <T>(
  path: string,
  options?: { method: string; body: unknown },
) => Promise<T>;
const identityAdapters = new WeakMap<object, IdentityApi>();
export function identityApiAdapter(
  api: Pick<OperationalApi, "request">,
): IdentityApi {
  let adapter = identityAdapters.get(api);
  if (!adapter) {
    adapter = <T,>(path: string, options?: { method: string; body: unknown }) =>
      api.request<T>(
        path.replace(/^\/api\/v1(?=\/)/, ""),
        options?.method ?? "GET",
        options?.body,
      );
    identityAdapters.set(api, adapter);
  }
  return adapter;
}
export interface IdentityProps {
  api: IdentityApi;
  onExpired: () => void;
  emergencyEnabled?: boolean;
  directoryEnabled?: boolean;
  pageOptions?: readonly { id: string; title: string }[];
}
type Page<T> = { items: T[]; total: number; offset: number; limit: number };
type Session = {
  id: string;
  label: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  active: boolean;
};
type Emergency = {
  id: string;
  reason: string;
  pageIds: string[];
  actions: string[];
  revision: number;
  expiresAt: string;
  status: string;
  own: boolean;
  canDecide: boolean;
};
type Binding = {
  key: string;
  label: string;
  active: boolean;
  revision: number;
};
const states: Record<string, string> = {
  pending: "승인 대기",
  approved: "승인됨",
  rejected: "거절됨",
  expired: "만료됨",
  revoked: "철회됨",
};
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "시각 확인 불가"
    : parsed.toLocaleString("ko-KR");
}
function Pager({
  offset,
  total,
  onPage,
}: {
  offset: number;
  total: number;
  onPage: (n: number) => void;
}) {
  return (
    <nav aria-label="목록 페이지">
      <Button
        disabled={offset === 0}
        onClick={() => onPage(Math.max(0, offset - 25))}
      >
        이전 25건
      </Button>
      <span>
        {" "}
        {total === 0 ? 0 : offset + 1}–{Math.min(offset + 25, total)} / {total}
        건{" "}
      </span>
      <Button
        disabled={offset + 25 >= total}
        onClick={() => onPage(offset + 25)}
      >
        다음 25건
      </Button>
    </nav>
  );
}
/** All identity and approver IDs are derived by server. Account UI has no
 * principal/operator/group-proof input or credential/CSRF display. */
export function IdentityManager({
  api,
  onExpired,
  emergencyEnabled = false,
  directoryEnabled = false,
  pageOptions = [],
}: IdentityProps) {
  const [sessions, setSessions] = useState<Page<Session>>(),
    [emergencies, setEmergencies] = useState<Page<Emergency>>(),
    [bindings, setBindings] = useState<Page<Binding>>();
  const [sessionOffset, setSessionOffset] = useState(0),
    [emergencyOffset, setEmergencyOffset] = useState(0),
    [bindingOffset, setBindingOffset] = useState(0);
  const [status, setStatus] = useState("계정 정보를 불러오는 중입니다."),
    [busy, setBusy] = useState(false),
    [generation, setGeneration] = useState(0);
  const [reason, setReason] = useState(""),
    [pageId, setPageId] = useState(""),
    [minutes, setMinutes] = useState(10),
    [action, setAction] = useState("queue.triage"),
    [confirmLogout, setConfirmLogout] = useState(false);
  function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNAUTHENTICATED|401/.test(message)) {
      setSessions(undefined);
      setEmergencies(undefined);
      setBindings(undefined);
      setStatus("인증이 만료되었습니다. 다시 로그인하세요.");
      onExpired();
    } else
      setStatus(
        /STALE_VERSION|409/.test(message)
          ? "다른 변경이 있습니다. 새로 고친 뒤 다시 검토하세요."
          : "요청을 확인하지 못했습니다. 변경 성공으로 표시하지 않습니다.",
      );
  }
  useEffect(() => {
    let active = true;
    setSessions(undefined);
    setEmergencies(undefined);
    setBindings(undefined);
    const tasks = [
      api<Page<Session>>(
        `/api/v1/identity/sessions?offset=${sessionOffset}`,
      ).then((v) => {
        if (active) setSessions(v);
      }),
    ];
    if (emergencyEnabled)
      tasks.push(
        api<Page<Emergency>>(
          `/api/v1/identity/emergencies?offset=${emergencyOffset}`,
        ).then((v) => {
          if (active) setEmergencies(v);
        }),
      );
    if (directoryEnabled)
      tasks.push(
        api<Page<Binding>>(
          `/api/v1/identity/directory-bindings?offset=${bindingOffset}`,
        ).then((v) => {
          if (active) setBindings(v);
        }),
      );
    Promise.all(tasks)
      .then(() => {
        if (active) setStatus("현재 서버 상태를 불러왔습니다.");
      })
      .catch((e) => {
        if (active) fail(e);
      });
    return () => {
      active = false;
    };
  }, [
    api,
    sessionOffset,
    emergencyOffset,
    bindingOffset,
    emergencyEnabled,
    directoryEnabled,
    generation,
  ]);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    current = false,
  ) {
    setBusy(true);
    try {
      const result = await api<{ idpLogout?: string }>(path, { method, body });
      if (current) {
        setSessions(undefined);
        setEmergencies(undefined);
        setBindings(undefined);
        setStatus(
          result.idpLogout === "completed"
            ? "제품 세션과 외부 인증 세션을 종료했습니다."
            : result.idpLogout === "failed"
              ? "제품 세션은 모두 종료했습니다. 외부 인증 종료는 실패했습니다."
              : "제품 세션을 종료했습니다. 외부 인증 서비스 로그아웃은 구성되지 않았습니다.",
        );
        onExpired();
      } else {
        setStatus("서버에서 변경을 확인했습니다.");
        setReason("");
        setGeneration((n) => n + 1);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="내 계정과 긴급 접근">
      <h2>내 계정과 세션</h2>
      <p role="status">{status}</p>
      <p>
        내 세션만 표시합니다. 공간 관리자여도 다른 사용자의 세션이나 인증 비밀은
        조회할 수 없습니다. 활동 갱신은 절대 만료를 연장하지 않습니다.
      </p>
      <fieldset disabled={busy}>
        <legend>로그인 세션</legend>
        {sessions ? (
          <>
            <ul>
              {sessions.items.map((s) => (
                <li key={s.id}>
                  <strong>
                    {s.label}
                    {s.current ? " · 현재 세션" : ""}
                  </strong>
                  <dl>
                    <dt>상태</dt>
                    <dd>{s.active ? "활성" : "만료됨"}</dd>
                    <dt>시작</dt>
                    <dd>{date(s.createdAt)}</dd>
                    <dt>최근 활동</dt>
                    <dd>{date(s.lastSeenAt)}</dd>
                    <dt>절대 만료</dt>
                    <dd>{date(s.expiresAt)}</dd>
                  </dl>
                  <Button
                    onClick={() =>
                      void mutate(
                        `/api/v1/identity/sessions/${s.id}`,
                        "DELETE",
                        {},
                        s.current,
                      )
                    }
                  >
                    이 세션 종료
                  </Button>
                </li>
              ))}
            </ul>
            <Pager
              offset={sessionOffset}
              total={sessions.total}
              onPage={setSessionOffset}
            />
          </>
        ) : (
          <p>세션 목록을 확인 중입니다.</p>
        )}
        <label>
          <input
            type="checkbox"
            checked={confirmLogout}
            onChange={(e) => setConfirmLogout(e.target.checked)}
          />{" "}
          내 모든 세션과 실행 권한 종료를 확인합니다.
        </label>
        <Button
          disabled={!confirmLogout || !sessions}
          onClick={() =>
            void mutate("/api/v1/identity/logout-all", "POST", {}, true)
          }
        >
          내 모든 세션 종료
        </Button>
      </fieldset>
      {emergencyEnabled && (
        <>
          <h3>한시적 사고 대응 접근</h3>
          <p>
            최대 30분, 독립된 플랫폼 승인자 승인 후에만 적용됩니다. 원본
            접근·근거 계보·외부 전송·삭제·법적 보존 제한은 그대로 유지되며
            관리자나 Owner로 승격되지 않습니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate("/api/v1/identity/emergencies", "POST", {
                reason,
                pageIds: [pageId],
                actions: [action],
                minutes,
              });
            }}
          >
            <fieldset disabled={busy}>
              <legend>긴급 접근 요청</legend>
              <label>
                명시적 사고 대응 사유
                <textarea
                  required
                  minLength={10}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                대상 문서
                <select
                  required
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                >
                  <option value="">문서 선택</option>
                  {pageOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                동작
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="knowledge.read">읽기</option>
                  <option value="queue.triage">검토 대기열 분류</option>
                  <option value="triage.manage">사고 분류 관리</option>
                </select>
              </label>
              <label>
                유효 시간(분)
                <input
                  type="number"
                  min={1}
                  max={30}
                  required
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
              <Button
                type="submit"
                disabled={!pageId || reason.trim().length < 10}
              >
                독립 승인 요청
              </Button>
            </fieldset>
          </form>
          <fieldset disabled={busy}>
            <legend>요청 상태</legend>
            {emergencies ? (
              <>
                <ul>
                  {emergencies.items.map((e) => (
                    <li key={e.id}>
                      <strong>{states[e.status] ?? "상태 확인 필요"}</strong>
                      <p>{e.reason}</p>
                      <p>
                        문서: {e.pageIds.join(", ")} · 동작:{" "}
                        {e.actions.join(", ")} · 고정 만료: {date(e.expiresAt)}
                      </p>
                      {e.canDecide && (
                        <>
                          <Button
                            onClick={() =>
                              void mutate(
                                `/api/v1/identity/emergencies/${e.id}/decision`,
                                "POST",
                                {
                                  expectedRevision: e.revision,
                                  decision: "approved",
                                },
                              )
                            }
                          >
                            범위 검토 후 승인
                          </Button>
                          <Button
                            onClick={() =>
                              void mutate(
                                `/api/v1/identity/emergencies/${e.id}/decision`,
                                "POST",
                                {
                                  expectedRevision: e.revision,
                                  decision: "rejected",
                                },
                              )
                            }
                          >
                            거절
                          </Button>
                        </>
                      )}
                      {(e.own || e.canDecide) &&
                        ["pending", "approved"].includes(e.status) && (
                          <Button
                            onClick={() =>
                              void mutate(
                                `/api/v1/identity/emergencies/${e.id}/revoke`,
                                "POST",
                                { expectedRevision: e.revision },
                              )
                            }
                          >
                            요청 철회
                          </Button>
                        )}
                    </li>
                  ))}
                </ul>
                <Pager
                  offset={emergencyOffset}
                  total={emergencies.total}
                  onPage={setEmergencyOffset}
                />
              </>
            ) : (
              <p>요청 상태를 확인 중입니다.</p>
            )}
          </fieldset>
        </>
      )}
      {directoryEnabled && (
        <fieldset disabled={busy}>
          <legend>검증된 디렉터리 그룹 연결</legend>
          <p>
            서버에 등록된 연결만 관리합니다. 이름 입력이나 그룹 소속 주장으로
            권한을 얻을 수 없습니다. 제품에서 수동 철회한 소속은 재동기화로
            복구되지 않습니다.
          </p>
          {bindings ? (
            <>
              <ul>
                {bindings.items.map((b) => (
                  <li key={b.key}>
                    {b.label} · {b.active ? "연결 활성" : "연결 비활성"} · 개정{" "}
                    {b.revision}{" "}
                    <Button
                      onClick={() =>
                        void mutate(
                          "/api/v1/identity/directory-bindings",
                          "PUT",
                          {
                            key: b.key,
                            expectedRevision: b.revision,
                            active: !b.active,
                          },
                        )
                      }
                    >
                      {b.active ? "연결 해제" : "연결 승인"}
                    </Button>
                  </li>
                ))}
              </ul>
              <Pager
                offset={bindingOffset}
                total={bindings.total}
                onPage={setBindingOffset}
              />
            </>
          ) : (
            <p>승인 가능한 연결을 확인 중입니다.</p>
          )}
        </fieldset>
      )}
      <Button disabled={busy} onClick={() => setGeneration((n) => n + 1)}>
        현재 상태 새로 고침
      </Button>
    </section>
  );
}
