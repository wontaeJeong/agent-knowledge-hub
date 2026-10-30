import { useCallback, useEffect, useState } from "react";
import { ApiError, type Identity, type OperationalApi } from "./api";
import {
  spaceRoles,
  type AccessState,
  type AccessSpace,
  type AccessInvitation,
  type SpaceRole,
} from "../domain/access";
import { Button } from "../ui/primitives";

export default function AccessManager({
  api,
  identity,
  onExpired,
  onChanged,
}: {
  api: OperationalApi;
  identity: Identity;
  onExpired: () => void;
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<AccessState | null>(null),
    [spaces, setSpaces] = useState<AccessSpace[]>([]),
    [invitations, setInvitations] = useState<AccessInvitation[]>([]),
    [organizations, setOrganizations] = useState<
      { id: string; name: string; role: string }[]
    >([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [target, setTarget] = useState(""),
    [name, setName] = useState(""),
    [org, setOrg] = useState(""),
    [team, setTeam] = useState(""),
    [who, setWho] = useState(""),
    [role, setRole] = useState<SpaceRole>("Read"),
    [inviteKind, setInviteKind] = useState<"member" | "owner" | "space">(
      "member",
    ),
    [expires, setExpires] = useState("");
  const [query, setQuery] = useState(""),
    [directory, setDirectory] = useState<{ id: string; name: string }[]>([]),
    [confirmed, setConfirmed] = useState(false);
  const load = useCallback(async () => {
    const [s, p, i, o] = await Promise.all([
      api.get<AccessState>("/access"),
      api.get<{ items: AccessSpace[] }>("/access/spaces"),
      api.get<{ items: AccessInvitation[] }>("/access/invitations"),
      api.get<{ items: { id: string; name: string; role: string }[] }>(
        "/access/organizations",
      ),
    ]);
    setState(s);
    setSpaces(p.items);
    setInvitations(i.items);
    setOrganizations(o.items);
  }, [api]);
  const act = async (fn: () => Promise<unknown>, message = "변경했습니다.") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      await onChanged();
      setNotice(message);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired();
      else
        setError(
          e instanceof Error ? e.message : "접근 설정을 불러오지 못했습니다.",
        );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (!active) return;
      if (e instanceof ApiError && e.status === 401) onExpired();
      else setError(e instanceof Error ? e.message : "접근 설정 오류");
    });
    return () => {
      active = false;
    };
  }, [load, onExpired]);
  const roleSelect = (
    value: SpaceRole,
    change: (v: SpaceRole) => void,
    label: string,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => change(e.target.value as SpaceRole)}
        disabled={busy}
      >
        {spaceRoles.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="op-panel access-manager" aria-busy={busy}>
      <div className="op-section-head">
        <h2>공간 · 접근 멤버</h2>
        <Button
          disabled={busy}
          onClick={() => void act(load, "최신 권한을 확인했습니다.")}
        >
          새로고침
        </Button>
      </div>
      <p>
        Organization은 소유 조직, Team은 접근 그룹, 지식 공간은 저장소에
        해당합니다. 원본과 문서의 제한된 독자는 공간 역할과 별도로 적용됩니다.
      </p>
      {error && (
        <p role="alert" className="op-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="op-notice">
          {notice}
        </p>
      )}
      <div className="access-grid">
        <section>
          <h3>접근 가능한 공간</h3>
          <label>
            공간 선택
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">선택하세요</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.organization ?? "개인"} / {s.name} · {s.role}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={busy || !target || target === identity.workspaceId}
            onClick={() =>
              void act(async () => {
                await api.post("/access/switch", { spaceId: target });
                window.location.assign("/");
              })
            }
          >
            선택 공간으로 이동
          </Button>
          <p>
            현재 공간: {state?.space?.name ?? identity.workspaceId} ·{" "}
            {state?.space?.role ?? identity.role}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const s = await api.post<{ id: string }>("/access/spaces", {
                  name: "개인 지식",
                });
                setTarget(s.id);
              }, "본인 전용 개인 공간을 준비했습니다. 선택 후 이동하세요.")
            }
          >
            내 개인 공간 준비
          </Button>
        </section>
        <section>
          <h3>받은 초대</h3>
          {!invitations.length && <p>대기 중인 초대가 없습니다.</p>}
          {invitations.map((i) => (
            <article key={i.id} className="access-card">
              <strong>
                {i.organization} {i.space ? "/ " + i.space : ""} · {i.role}
              </strong>
              <p>만료: {new Date(i.expiresAt).toLocaleString()}</p>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      api.post("/access/invitations/" + i.id + "/accept", {}),
                    "초대를 수락했습니다. 공간 목록에서 선택하세요.",
                  )
                }
              >
                초대 수락
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    api.post("/access/invitations/" + i.id + "/cancel", {}),
                  )
                }
              >
                거절
              </Button>
            </article>
          ))}
        </section>
      </div>
      <details>
        <summary>조직 · 공간 만들기</summary>
        <label>
          새 이름
          <input
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button
          disabled={busy || !name.trim()}
          onClick={() =>
            void act(() => api.post("/access/organizations", { name }))
          }
        >
          Organization 만들기
        </Button>
        <p>
          조직 생성은 배포의 허용 정책에 따릅니다. 생성자는 첫 Owner가 됩니다.
        </p>
        <label>
          소유 조직
          <select value={org} onChange={(e) => setOrg(e.target.value)}>
            <option value="">선택하세요</option>
            {organizations
              .filter((o) => o.role === "owner")
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
        <Button
          disabled={busy || !org || !name.trim()}
          onClick={() =>
            void act(async () => {
              const s = await api.post<{ id: string }>("/access/spaces", {
                name,
                organizationId: org,
              });
              setTarget(s.id);
            }, "Private 공간을 만들었습니다. 공간 목록에서 이동하세요.")
          }
        >
          조직의 Private 공간 만들기
        </Button>
      </details>
      {state && !state.managed && (
        <section className="access-card">
          <h3>기존 공간의 권한 관리 전환</h3>
          <p>
            이 공간은 기존 OIDC 그룹 역할을 사용합니다. 배포 운영자가 지정한
            초기 Owner만 조직 관리로 전환할 수 있습니다. 기존 reviewer는
            Maintain, editor는 Write, reader는 Read로 옮기고 원본 ACL을
            보존합니다.
          </p>
          {state.bootstrapAllowed && (
            <>
              <label>
                조직 이름
                <input
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                현재 접근 멤버를 이관하고, 내 계정을 첫 Owner로 지정함을
                확인했습니다.
              </label>
              <Button
                disabled={busy || !confirmed || !name.trim()}
                onClick={() =>
                  void act(async () => {
                    await api.post("/access/bootstrap", {
                      name,
                      confirm:
                        "adopt-existing-members-and-preserve-source-acls",
                    });
                    window.location.assign("/");
                  })
                }
              >
                조직 관리로 전환
              </Button>
            </>
          )}
        </section>
      )}
      {state?.managed && (
        <>
          <h3>
            {state.space?.organization ?? "개인 소유"} / {state.space?.name}
          </h3>
          <p>
            내 역할 {state.space?.role} ·{" "}
            {state.space?.visibility === "team"
              ? "조직 멤버 기본 Read"
              : "Private"}{" "}
            · 개인 자료는 본인에게만 보입니다.
          </p>
          {!state.capabilities.manageSpace && (
            <p>
              멤버·Team·공간 설정은 Admin 또는 Organization Owner가 관리합니다.
            </p>
          )}
          {state.capabilities.manageSpace && (
            <>
              <h3>멤버의 실효 권한</h3>
              <div className="access-table">
                <table>
                  <thead>
                    <tr>
                      <th>멤버</th>
                      <th>조직 역할</th>
                      <th>공간 역할 · 부여 경로</th>
                      <th>조직 관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.members.map((m) => (
                      <tr key={m.principalId}>
                        <td>
                          <strong>{m.name}</strong>
                          <small title={m.principalId}>{m.principalId}</small>
                        </td>
                        <td>{m.organizationRole ?? "개인 Owner"}</td>
                        <td>
                          {m.role ?? "접근 없음"}
                          <small>
                            {m.paths.join(" / ") || "부여 경로 없음"}
                          </small>
                        </td>
                        <td>
                          {state.capabilities.manageOrganization && (
                            <>
                              {m.organizationRole === "owner" && (
                                <Button
                                  disabled={busy}
                                  onClick={() =>
                                    void act(() =>
                                      api.request(
                                        "/access/members/" + m.principalId,
                                        "PATCH",
                                        { role: "member" },
                                      ),
                                    )
                                  }
                                >
                                  Member로 변경
                                </Button>
                              )}
                              <Button
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      "조직의 직접 역할과 모든 Team 경로를 회수합니다. 제한 원본의 이전 ACL만으로 접근을 되살리지 않습니다.",
                                    )
                                  )
                                    void act(() =>
                                      api.request(
                                        "/access/members/" + m.principalId,
                                        "DELETE",
                                        {},
                                      ),
                                    );
                                }}
                              >
                                조직에서 제거
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>지식 검토자 지정</h3>
              <p>
                Maintain/Admin 역할과 검토자 지정을 함께 갖춰야 승인·발행할 수
                있습니다. 본인 제안은 승인할 수 없으며, 지정 변경은 기존 승인을
                무효화합니다.
              </p>
              {state.members
                .filter((m) => m.role === "Maintain" || m.role === "Admin")
                .map((m) => (
                  <label key={m.principalId}>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={state.reviewers.includes(m.principalId)}
                      onChange={(e) =>
                        void act(() =>
                          api.post("/access/reviewers", {
                            principalId: m.principalId,
                            enabled: e.target.checked,
                          }),
                        )
                      }
                    />
                    {m.name} · {m.role}
                  </label>
                ))}
              {state.space?.orgId && (
                <>
                  <details open>
                    <summary>멤버 초대 · 역할 부여</summary>
                    <p>
                      초대는 7일 후 만료됩니다. 수락 전에는 권한을 부여하지
                      않습니다. 공간 첫 직접 권한과 Owner 지정은 대상자의 수락이
                      필요합니다.
                    </p>
                    {state.capabilities.manageOrganization && (
                      <>
                        <label>
                          사내 멤버 찾기
                          <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            minLength={2}
                          />
                        </label>
                        <Button
                          disabled={busy || query.trim().length < 2}
                          onClick={() =>
                            void act(
                              async () =>
                                setDirectory(
                                  (
                                    await api.get<{
                                      items: { id: string; name: string }[];
                                    }>(
                                      "/access/directory?q=" +
                                        encodeURIComponent(query),
                                    )
                                  ).items,
                                ),
                              "로그인 이력이 있는 허용된 신원입니다.",
                            )
                          }
                        >
                          멤버 검색
                        </Button>
                        <ul>
                          {directory.map((d) => (
                            <li key={d.id}>
                              <button
                                type="button"
                                onClick={() => setWho(d.id)}
                              >
                                {d.name} · {d.id}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <label>
                      대상 멤버 ID
                      <input
                        value={who}
                        maxLength={200}
                        onChange={(e) => setWho(e.target.value)}
                      />
                    </label>
                    <label>
                      초대 종류
                      <select
                        value={inviteKind}
                        onChange={(e) =>
                          setInviteKind(e.target.value as typeof inviteKind)
                        }
                      >
                        {state.capabilities.manageOrganization && (
                          <>
                            <option value="member">Organization Member</option>
                            <option value="owner">Organization Owner</option>
                          </>
                        )}
                        <option value="space">이 공간 Collaborator</option>
                      </select>
                    </label>
                    {roleSelect(role, setRole, "부여할 공간 역할")}
                    <Button
                      disabled={
                        busy ||
                        !who ||
                        (inviteKind !== "space" &&
                          !state.capabilities.manageOrganization)
                      }
                      onClick={() =>
                        void act(
                          () =>
                            api.post("/access/invitations", {
                              principalId: who,
                              role: inviteKind === "space" ? role : inviteKind,
                              ...(inviteKind === "space"
                                ? { workspaceId: identity.workspaceId }
                                : {}),
                            }),
                          "초대를 만들었습니다. 대상자는 받은 초대에서 수락할 수 있습니다.",
                        )
                      }
                    >
                      초대 만들기
                    </Button>
                  </details>
                  <h3>직접 · Team 공간 역할</h3>
                  {state.grants.map((g) => (
                    <article key={g.id} className="access-card">
                      <strong>
                        {g.principalId
                          ? (state.members.find(
                              (m) => m.principalId === g.principalId,
                            )?.name ?? g.principalId)
                          : "Team: " +
                            state.teams.find((t) => t.id === g.teamId)?.name}
                      </strong>
                      <p>
                        {g.role} ·{" "}
                        {g.expiresAt
                          ? "만료 " + new Date(g.expiresAt).toLocaleString()
                          : "만료 없음"}
                      </p>
                      {roleSelect(
                        g.role,
                        (v) =>
                          void act(() =>
                            api.post("/access/grants", {
                              ...(g.principalId
                                ? { principalId: g.principalId }
                                : { teamId: g.teamId }),
                              role: v,
                              ...(g.expiresAt &&
                              new Date(g.expiresAt) > new Date()
                                ? { expiresAt: g.expiresAt }
                                : {}),
                            }),
                          ),
                        "역할 변경 " + g.id,
                      )}
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api.request(
                                "/access/grants/" + g.id,
                                "DELETE",
                                {},
                              ),
                            "해당 경로를 회수했습니다. 다른 직접/Team/Owner/공개 경로가 있으면 접근은 남습니다.",
                          )
                        }
                      >
                        이 역할 경로 회수
                      </Button>
                    </article>
                  ))}
                  <label>
                    역할을 부여할 Team
                    <select
                      value={team}
                      onChange={(e) => setTeam(e.target.value)}
                    >
                      <option value="">선택하세요</option>
                      {state.teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {roleSelect(role, setRole, "Team 공간 역할")}
                  <label>
                    역할 만료 (선택)
                    <input
                      type="datetime-local"
                      value={expires}
                      onChange={(e) => setExpires(e.target.value)}
                    />
                  </label>
                  <Button
                    disabled={busy || !team}
                    onClick={() =>
                      void act(() =>
                        api.post("/access/grants", {
                          teamId: team,
                          role,
                          ...(expires
                            ? { expiresAt: new Date(expires).toISOString() }
                            : {}),
                        }),
                      )
                    }
                  >
                    Team에 공간 역할 부여
                  </Button>
                  {state.capabilities.manageOrganization && (
                    <>
                      <h3>Organization Teams</h3>
                      <label>
                        새 Team 이름
                        <input
                          value={name}
                          maxLength={100}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                      <Button
                        disabled={busy || !name.trim()}
                        onClick={() =>
                          void act(() => api.post("/access/teams", { name }))
                        }
                      >
                        Team 만들기
                      </Button>
                      {state.teams.map((t) => (
                        <details key={t.id}>
                          <summary>
                            {t.name} · {t.members.length}명
                          </summary>
                          {state.members
                            .filter((m) => m.organizationRole)
                            .map((m) => (
                              <label key={m.principalId}>
                                <input
                                  type="checkbox"
                                  checked={t.members.includes(m.principalId)}
                                  disabled={busy}
                                  onChange={(e) =>
                                    void act(() =>
                                      api.request(
                                        "/access/teams/" +
                                          t.id +
                                          "/members/" +
                                          m.principalId,
                                        e.target.checked ? "POST" : "DELETE",
                                        {},
                                      ),
                                    )
                                  }
                                />
                                {m.name}
                              </label>
                            ))}
                        </details>
                      ))}
                    </>
                  )}
                  <h3>발행본 기본 공개 범위</h3>
                  <p>
                    조직 공개는 조직 멤버에게 공간 Read를 줍니다. 기존
                    원본·문서의 더 좁은 독자 제한은 그대로 적용되며, 제목과
                    본문은 그 제한을 통과해야 보입니다.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    원본 ACL은 유지되고 공간의 기본 독자만 변경됨을
                    확인했습니다.
                  </label>
                  <Button
                    disabled={busy || !confirmed}
                    onClick={() =>
                      void act(() =>
                        api.post("/access/visibility", {
                          visibility:
                            state.space?.visibility === "private"
                              ? "team"
                              : "private",
                          revision: state.space?.revision,
                          confirm: "source-acls-remain-restricted",
                        }),
                      )
                    }
                  >
                    {state.space?.visibility === "private"
                      ? "조직 멤버에게 기본 Read 부여"
                      : "Private로 변경"}
                  </Button>
                  <h3>보낸 초대</h3>
                  {state.invitations.map((i) => (
                    <p key={i.id}>
                      {i.principalId} · {i.role} ·{" "}
                      {new Date(i.expiresAt).toLocaleDateString()}{" "}
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.post(
                              "/access/invitations/" + i.id + "/cancel",
                              {},
                            ),
                          )
                        }
                      >
                        초대 취소
                      </Button>
                    </p>
                  ))}
                </>
              )}
              <details>
                <summary>접근 변경 감사 기록</summary>
                <ul>
                  {state.audit.map((a, i) => (
                    <li key={i}>
                      {new Date(a.at).toLocaleString()} · {a.operation} ·{" "}
                      {a.actorId}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
