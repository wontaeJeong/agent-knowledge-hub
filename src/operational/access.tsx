import { useEffect, useState, useCallback } from "react";
import { ApiError, OperationalApi, pageItems } from "./api";
import { Button } from "../ui/primitives";
import { ServiceAccountsPanel } from "./service-accounts";
const delegated = [
  "knowledge.read",
  "source.create",
  "changeset.propose",
  "personal.sync",
  "local.copy",
  "lint.run",
];
const actionLabels: Record<string, string> = {
  "knowledge.read": "지식 읽기",
  "source.create": "원본 제안 등록",
  "changeset.propose": "변경 제안",
  "personal.sync": "개인 작업본 동기화",
  "local.copy": "허용된 자료의 로컬 복사",
  "lint.run": "점검 실행",
};
export const selectedActions = (actions: string[]) =>
  actions.filter((a) => delegated.includes(a));
interface Effective {
  role: string;
  paths: { role: string; via: string }[];
  space: {
    id: string;
    namespaceId: string;
    namespaceKind: string;
    namespaceSlug: string;
    slug: string;
    visibility: string;
    policyVersion: number;
    owner: boolean;
  };
  grants: {
    id: string;
    principalId?: string;
    groupId?: string;
    role: string;
    revoked: boolean;
    expiresAt?: string;
  }[];
}
interface Team {
  id: string;
  slug: string;
  name: string;
  role: string;
  version: number;
}
interface Group {
  id: string;
  teamId: string;
  name: string;
}
interface Credential {
  id: string;
  actions: string[];
  expiresAt: string;
  revoked: boolean;
  lastUsedAt: string | null;
}
interface Invitation {
  id: string;
  team_id?: string;
  teamId?: string;
  kind: string;
  status: string;
  expires_at?: string;
  expiresAt?: string;
}
interface Share {
  id: string;
  pageId?: string;
  page_id?: string;
  version: number;
  principalId?: string;
  principal_id?: string;
  expiresAt?: string;
  expires_at?: string;
  revoked: boolean;
}
interface ReviewRule {
  documentType: string;
  minimumApprovals: number;
  reviewerIds: string[];
}
export function AccessPanel({
  api,
  capabilities,
  onExpired,
  onChanged,
  onSelect,
}: {
  api: OperationalApi;
  capabilities: string[];
  onExpired: () => void;
  onChanged: () => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [access, setAccess] = useState<Effective | null>(null),
    [teams, setTeams] = useState<Team[]>([]),
    [groups, setGroups] = useState<Group[]>([]),
    [credentials, setCredentials] = useState<Credential[]>([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [shares, setShares] = useState<Share[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false);
  const [spaceSlug, setSpaceSlug] = useState(""),
    [teamSlug, setTeamSlug] = useState(""),
    [teamName, setTeamName] = useState(""),
    [teamId, setTeamId] = useState(""),
    [groupName, setGroupName] = useState(""),
    [groupPeople, setGroupPeople] = useState("");
  const [principal, setPrincipal] = useState(""),
    [groupId, setGroupId] = useState(""),
    [role, setRole] = useState("read"),
    [expiry, setExpiry] = useState(""),
    [reviewers, setReviewers] = useState(""),
    [minimum, setMinimum] = useState(1);
  const [tokenActions, setTokenActions] = useState(["knowledge.read"]),
    [tokenExpiry, setTokenExpiry] = useState(""),
    [invitePrincipal, setInvitePrincipal] = useState(""),
    [inviteExpiry, setInviteExpiry] = useState(""),
    [transfer, setTransfer] = useState(false);
  const [reviewRules, setReviewRules] = useState<ReviewRule[]>([]),
    [ruleType, setRuleType] = useState("official-standard"),
    [ruleMinimum, setRuleMinimum] = useState(2),
    [ruleReviewers, setRuleReviewers] = useState("");
  const [sharePage, setSharePage] = useState(""),
    [shareVersion, setShareVersion] = useState(1),
    [shareRecipient, setShareRecipient] = useState(""),
    [shareExpiry, setShareExpiry] = useState("");
  const [listPage, setListPage] = useState(0);
  const admin = capabilities.includes("space.admin"),
    policy = capabilities.includes("policy.strengthen");
  const csv = (value: string) =>
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const iso = (value: string) => new Date(value).toISOString();
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        setSecret("");
        setAccess(null);
        setCredentials([]);
        setShares([]);
        setGroups([]);
        setInvitations([]);
        setTeams([]);
        if (e.status === 401) onExpired();
      }
      setError(e instanceof Error ? e.message : "서버 요청에 실패했습니다.");
    },
    [onExpired],
  );
  const load = useCallback(async () => {
    const me = await api.me();
    const [a, t, g, c, i, s] = await Promise.all([
      capabilities.includes("knowledge.read")
        ? api.get<Effective>(
            `/spaces/${encodeURIComponent(me.workspaceId)}/access`,
          )
        : Promise.resolve(null),
      api.get<{ items: Team[] }>("/teams"),
      api.get<{ items: Group[] }>("/groups"),
      api.get<{ items: Credential[] }>("/credentials"),
      api.get<{ items: Invitation[] }>("/invitations"),
      admin
        ? api.get<{ items: Share[] }>("/shares")
        : Promise.resolve({ items: [] }),
    ]);
    setAccess(a);
    setTeams(t.items);
    setGroups(g.items);
    setCredentials(c.items);
    setInvitations(i.items);
    setShares(s.items);
    if (policy) {
      const p = await api.get<{
        minimumApprovals: number;
        reviewerIds: string[];
        documentTypes?: ReviewRule[];
      }>("/review-policy");
      setMinimum(p.minimumApprovals);
      setReviewers(p.reviewerIds.join(", "));
      setReviewRules(p.documentTypes ?? []);
    }
  }, [api, admin, policy, capabilities.includes("knowledge.read")]);
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) fail(e);
    });
    return () => {
      active = false;
    };
  }, [load, fail]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    setSecret("");
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (path: string, body: unknown = {}) =>
    api.request(path, "DELETE", body);
  const version = access?.space.policyVersion;
  return (
    <section className="op-panel">
      <h2>공간과 접근 권한</h2>
      <p>
        개인·팀 소유권, 공개 범위, 공간 역할과 원본 제한은 별개입니다.
        Admin·Owner도 원본 권한을 우회할 수 없습니다.
      </p>
      {error && (
        <p role="alert" className="op-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">권한을 다시 확인하고 저장하고 있습니다…</p>}
      {access && (
        <>
          <h3>
            @{access.space.namespaceSlug}/{access.space.slug}
          </h3>
          <p>
            소유: {access.space.namespaceKind === "personal" ? "개인" : "팀"} ·
            범위: {access.space.visibility} · 역할: {access.role} · 정책 v
            {version}
            {access.space.owner ? " · 소유자" : ""}
          </p>
          <details>
            <summary>내 권한의 경로</summary>
            <ul>
              {access.paths.map((p, n) => (
                <li key={n}>
                  {p.role} · {p.via}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <details>
        <summary>개인 공간 만들기 · 팀 공간 추가</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const s = await api.post<{ id: string }>("/spaces", {
                slug: spaceSlug,
                ...(teamId ? { teamId } : {}),
              });
              setNotice("Private 공간을 만들었습니다.");
              onSelect(s.id);
            });
          }}
        >
          <label>
            공간 이름 (영문 소문자·숫자·하이픈)
            <input
              value={spaceSlug}
              onChange={(e) => setSpaceSlug(e.target.value)}
              pattern="[a-z0-9][a-z0-9-]{0,63}"
              required
              disabled={busy}
            />
          </label>
          <label>
            소유자
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={busy}
            >
              <option value="">개인</option>
              {teams
                .filter((t) => t.role === "owner")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    팀 @{t.slug}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            Private 공간 생성
          </Button>
        </form>
      </details>
      <details>
        <summary>팀 생성</summary>
        <p>인증된 팀 생성 권한이 있어야 합니다. 팀 기본 권한은 none입니다.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.post("/teams", { slug: teamSlug, name: teamName });
              setNotice("팀을 만들었습니다. 공간 접근 권한은 따로 부여하세요.");
            });
          }}
        >
          <label>
            팀 식별 이름
            <input
              value={teamSlug}
              onChange={(e) => setTeamSlug(e.target.value)}
              pattern="[a-z0-9][a-z0-9-]{0,63}"
              required
              disabled={busy}
            />
          </label>
          <label>
            팀 표시 이름
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              required
              maxLength={100}
              disabled={busy}
            />
          </label>
          <Button type="submit" disabled={busy}>
            팀 생성 요청
          </Button>
        </form>
      </details>
      {teams.some((t) => t.role === "owner") && (
        <details>
          <summary>팀 멤버 초대·소유권 이관·접근 그룹</summary>
          <label>
            관리 팀
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={busy}
            >
              <option value="">팀 선택</option>
              {teams
                .filter((t) => t.role === "owner")
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    @{t.slug}
                  </option>
                ))}
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (
                  transfer &&
                  !window.confirm(
                    "상대가 수락하면 팀 소유권이 이관됩니다. 진행할까요?",
                  )
                )
                  return;
                await api.post(
                  `/teams/${encodeURIComponent(teamId)}/${transfer ? "ownership-transfer" : "invitations"}`,
                  {
                    principalId: invitePrincipal,
                    expiresAt: iso(inviteExpiry),
                  },
                );
                setNotice("상대의 수락을 기다리는 요청을 만들었습니다.");
              });
            }}
          >
            <label>
              초대할 사용자 ID
              <input
                required
                value={invitePrincipal}
                onChange={(e) => setInvitePrincipal(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              초대 만료 (현재 기기 시각대)
              <input
                type="datetime-local"
                required
                value={inviteExpiry}
                onChange={(e) => setInviteExpiry(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={transfer}
                onChange={(e) => setTransfer(e.target.checked)}
                disabled={busy}
              />
              팀 소유권 이관 요청 (일반 초대와 다름)
            </label>
            <Button type="submit" disabled={busy || !teamId}>
              {transfer ? "이관 요청" : "멤버 초대"}
            </Button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post("/groups", {
                  teamId,
                  name: groupName,
                  principalIds: csv(groupPeople),
                });
                setNotice(
                  "접근 그룹을 만들었습니다. 공간 역할은 따로 부여하세요.",
                );
              });
            }}
          >
            <label>
              그룹 이름
              <input
                required
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={100}
                disabled={busy}
              />
            </label>
            <label>
              이미 참여 중인 사용자 ID (쉼표 구분)
              <input
                value={groupPeople}
                onChange={(e) => setGroupPeople(e.target.value)}
                disabled={busy}
              />
            </label>
            <Button type="submit" disabled={busy || !teamId}>
              접근 그룹 생성
            </Button>
          </form>
          {groups
            .filter((g) => g.teamId === teamId)
            .map((g) => (
              <article key={g.id}>
                <strong>{g.name}</strong>
                <code>{g.id}</code>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (
                        !window.confirm(
                          "위 사용자 ID 목록으로 이 그룹의 멤버 전체를 교체할까요? 기존 승인은 재검토됩니다.",
                        )
                      )
                        return;
                      await api.post(`/groups/${g.id}/members`, {
                        principalIds: csv(groupPeople),
                        expectedVersion: teams.find((t) => t.id === teamId)
                          ?.version,
                      });
                      setNotice("그룹 멤버를 변경했습니다.");
                    })
                  }
                >
                  위 목록으로 멤버 교체
                </Button>
              </article>
            ))}
        </details>
      )}
      <details>
        <summary>받은 초대·이관 요청 ({invitations.length})</summary>
        {invitations.map((i) => (
          <article key={i.id}>
            <p>
              {i.kind === "owner-transfer" ? "팀 소유권 이관" : "팀 참여"} ·{" "}
              {i.teamId ?? i.team_id} · {i.status}
            </p>
            <Button
              disabled={busy || i.status !== "pending"}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("이 요청을 수락할까요?")) return;
                  await api.post(`/invitations/${i.id}/accept`, {});
                  setNotice("요청을 수락했습니다.");
                })
              }
            >
              수락
            </Button>
          </article>
        ))}
      </details>
      {admin && access?.space.namespaceKind === "team" && (
        <details>
          <summary>공간 역할 부여·회수·기본 독자</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post("/grants", {
                  ...(groupId ? { groupId } : { principalId: principal }),
                  role,
                  expectedVersion: version,
                  ...(expiry ? { expiresAt: iso(expiry) } : {}),
                });
                setNotice(
                  "공간 역할을 변경했습니다. 기존 승인은 재검토해야 합니다.",
                );
              });
            }}
          >
            <label>
              사용자 ID
              <input
                value={principal}
                onChange={(e) => {
                  setPrincipal(e.target.value);
                  setGroupId("");
                }}
                disabled={busy}
              />
            </label>
            <label>
              또는 접근 그룹
              <select
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setPrincipal("");
                }}
                disabled={busy}
              >
                <option value="">그룹 선택 안 함</option>
                {groups
                  .filter((g) => g.teamId === access.space.namespaceId)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              역할
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={busy}
              >
                {["read", "triage", "write", "maintain", "admin"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              역할 만료 (선택)
              <input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                disabled={busy}
              />
            </label>
            <Button type="submit" disabled={busy || (!principal && !groupId)}>
              역할 부여
            </Button>
          </form>
          {pageItems(access.grants, listPage).map((g) => (
            <article key={g.id}>
              <p>
                {g.principalId ?? g.groupId} · {g.role} ·{" "}
                {g.revoked ? "회수됨" : (g.expiresAt ?? "만료 없음")}
              </p>
              <Button
                disabled={busy || g.revoked}
                onClick={() =>
                  run(async () => {
                    if (!window.confirm("이 공간 역할을 즉시 회수할까요?"))
                      return;
                    await remove(`/grants/${g.id}`, {
                      expectedVersion: version,
                    });
                    setNotice("역할을 회수했습니다.");
                  })
                }
              >
                역할 회수
              </Button>
            </article>
          ))}
          {access.grants.length > 25 && (
            <div className="op-actions">
              <Button
                disabled={!listPage}
                onClick={() => setListPage((p) => p - 1)}
              >
                이전 25건
              </Button>
              <Button
                disabled={(listPage + 1) * 25 >= access.grants.length}
                onClick={() => setListPage((p) => p + 1)}
              >
                다음 25건
              </Button>
            </div>
          )}
          <p>
            기본 독자를 바꾸어도 기존 원본·문서별 제한은 유지됩니다. Company
            승격은 별도 운영자 정책 절차를 따릅니다.
          </p>
          <div className="op-actions">
            {["private", "team"].map((visibility) => (
              <Button
                key={visibility}
                disabled={busy || access.space.visibility === visibility}
                onClick={() =>
                  run(async () => {
                    if (
                      !window.confirm(
                        `${visibility} 기본 독자로 변경할까요? 문서별 제한을 자동 확대하지 않습니다.`,
                      )
                    )
                      return;
                    await api.post("/visibility", {
                      visibility,
                      expectedVersion: version,
                      confirmImpact: true,
                    });
                    setNotice("공간 기본 독자를 변경했습니다.");
                  })
                }
              >
                {visibility === "private" ? "Private로 변경" : "Team으로 변경"}
              </Button>
            ))}
          </div>
        </details>
      )}
      {policy && (
        <details>
          <summary>독립 인간 검토 정책</summary>
          <p>
            작성자 본인·서비스 주체는 승인할 수 없습니다. 담당 검토자는 현재
            Maintain 이상 권한도 필요합니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (
                  !window.confirm(
                    "검토 정책을 변경하면 기존 승인은 다시 검토해야 합니다. 진행할까요?",
                  )
                )
                  return;
                await api.post("/review-policy", {
                  minimumApprovals: minimum,
                  reviewerIds: csv(reviewers),
                  expectedVersion: version,
                });
                setNotice("독립 검토 정책을 갱신했습니다.");
              });
            }}
          >
            <label>
              필요 승인 수
              <input
                type="number"
                min={1}
                max={10}
                value={minimum}
                onChange={(e) => setMinimum(Number(e.target.value))}
                disabled={busy}
              />
            </label>
            <label>
              지정 검토자 ID (쉼표 구분)
              <input
                value={reviewers}
                onChange={(e) => setReviewers(e.target.value)}
                disabled={busy}
              />
            </label>
            <Button type="submit" disabled={busy}>
              검토 정책 갱신
            </Button>
          </form>
          {admin && (
            <details>
              <summary>문서 유형별 검토 · 공식 기준 보호</summary>
              <p>
                공식 기준은 <code>official-standard</code> 정책과 서로 다른 지정
                인간 검토자 2명 이상이 필요합니다. 로컬 정책 설정이 실제 부서
                승인이나 실행 검증을 자동 증명하지 않습니다.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (
                      !window.confirm(
                        "이 유형의 검토자를 공간의 지정 인간 검토자에도 포함하고 정책을 갱신할까요? 기존 승인은 다시 검토해야 합니다.",
                      )
                    )
                      return;
                    const rule = {
                      documentType: ruleType.trim(),
                      minimumApprovals: ruleMinimum,
                      reviewerIds: csv(ruleReviewers),
                    };
                    await api.post("/review-policy", {
                      minimumApprovals: minimum,
                      reviewerIds: [
                        ...new Set([...csv(reviewers), ...rule.reviewerIds]),
                      ],
                      documentTypes: [
                        ...reviewRules.filter(
                          (r) => r.documentType !== rule.documentType,
                        ),
                        rule,
                      ],
                      expectedVersion: version,
                    });
                    setNotice("유형별 독립 검토 정책을 갱신했습니다.");
                  });
                }}
              >
                <label>
                  문서 유형 (기존 분류명 또는 official-standard)
                  <input
                    value={ruleType}
                    onChange={(e) => setRuleType(e.target.value)}
                    maxLength={100}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  필요한 독립 승인 수
                  <input
                    type="number"
                    min={ruleType === "official-standard" ? 2 : 1}
                    max={10}
                    value={ruleMinimum}
                    onChange={(e) => setRuleMinimum(Number(e.target.value))}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  지정 인간 검토자 ID (쉼표 구분)
                  <input
                    value={ruleReviewers}
                    onChange={(e) => setRuleReviewers(e.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <Button type="submit" disabled={busy || !access}>
                  유형별 검토 정책 저장
                </Button>
              </form>
              {reviewRules.map((rule) => (
                <article key={rule.documentType}>
                  <h4>
                    {rule.documentType} · {rule.minimumApprovals}명 승인
                  </h4>
                  <p>{rule.reviewerIds.join(", ")}</p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setRuleType(rule.documentType);
                      setRuleMinimum(rule.minimumApprovals);
                      setRuleReviewers(rule.reviewerIds.join(", "));
                    }}
                  >
                    이 규칙 편집
                  </Button>
                  {access?.space.owner && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          if (
                            !window.confirm(
                              "이 문서 유형의 검토 규칙을 제거할까요? 공식 기준 규칙을 제거하면 해당 본문은 읽기 전용으로 보호됩니다.",
                            )
                          )
                            return;
                          await api.post("/review-policy", {
                            minimumApprovals: minimum,
                            reviewerIds: csv(reviewers),
                            documentTypes: reviewRules.filter(
                              (r) => r.documentType !== rule.documentType,
                            ),
                            expectedVersion: version,
                          });
                          setNotice("유형별 검토 규칙을 제거했습니다.");
                        })
                      }
                    >
                      Owner 확인 후 규칙 제거
                    </Button>
                  )}
                </article>
              ))}
            </details>
          )}
        </details>
      )}
      {admin && access?.space.namespaceKind === "team" && (
        <details>
          <summary>버전 고정 공유 · 만료·철회</summary>
          <p>
            수신자도 현재 원본·파생 입력에 접근할 수 있어야 합니다. 링크가 원본
            권한을 우회하지 않습니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.post("/shares", {
                  pageId: sharePage,
                  version: shareVersion,
                  principalId: shareRecipient,
                  expiresAt: iso(shareExpiry),
                  actions: ["knowledge.read"],
                  expectedVersion: version,
                });
                setNotice("인증된 수신자용 고정 버전 공유를 만들었습니다.");
              });
            }}
          >
            <label>
              문서 ID
              <input
                required
                value={sharePage}
                onChange={(e) => setSharePage(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              고정 버전
              <input
                required
                type="number"
                min={1}
                value={shareVersion}
                onChange={(e) => setShareVersion(Number(e.target.value))}
                disabled={busy}
              />
            </label>
            <label>
              수신자 ID
              <input
                required
                value={shareRecipient}
                onChange={(e) => setShareRecipient(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              공유 만료
              <input
                required
                type="datetime-local"
                value={shareExpiry}
                onChange={(e) => setShareExpiry(e.target.value)}
                disabled={busy}
              />
            </label>
            <Button type="submit" disabled={busy}>
              수신자 지정 공유
            </Button>
          </form>
          {shares.map((s) => (
            <article key={s.id}>
              <p>
                {s.pageId ?? s.page_id} · v{s.version} ·{" "}
                {s.principalId ?? s.principal_id} ·{" "}
                {s.expiresAt ?? s.expires_at}
              </p>
              <a
                href={`/?app=1&space=${encodeURIComponent(access.space.id)}#share-${encodeURIComponent(s.id)}`}
              >
                공유 고유 링크
              </a>
              <Button
                disabled={busy || s.revoked}
                onClick={() =>
                  run(async () => {
                    await remove(`/shares/${s.id}`, {
                      expectedVersion: version,
                    });
                    setNotice("공유를 철회했습니다.");
                  })
                }
              >
                공유 철회
              </Button>
            </article>
          ))}
        </details>
      )}
      <details>
        <summary>에이전트 제한 토큰</summary>
        <p>
          현재 공간과 본인의 현재 권한을 넘을 수 없습니다. 승인·발행·관리 권한은
          위임하지 않습니다. 비밀값은 발급 직후에만 표시됩니다.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const c = await api.post<{ secret: string }>("/credentials", {
                actions: selectedActions(tokenActions),
                expiresAt: iso(tokenExpiry),
              });
              setSecret(c.secret);
              setNotice(
                "제한 토큰을 발급했습니다. 안전한 비밀 저장소에 보관하세요.",
              );
            });
          }}
        >
          <fieldset>
            <legend>허용 작업</legend>
            {delegated
              .filter((a) => capabilities.includes(a))
              .map((a) => (
                <label key={a}>
                  <input
                    type="checkbox"
                    checked={tokenActions.includes(a)}
                    onChange={(e) =>
                      setTokenActions((old) =>
                        e.target.checked
                          ? [...old, a]
                          : old.filter((v) => v !== a),
                      )
                    }
                    disabled={busy}
                  />
                  {actionLabels[a]}
                </label>
              ))}
          </fieldset>
          <label>
            토큰 만료
            <input
              type="datetime-local"
              required
              value={tokenExpiry}
              onChange={(e) => setTokenExpiry(e.target.value)}
              disabled={busy}
            />
          </label>
          <Button type="submit" disabled={busy || !tokenActions.length}>
            제한 토큰 발급
          </Button>
        </form>
        {secret && (
          <div role="status">
            <label>
              이번에만 표시되는 비밀값
              <textarea readOnly value={secret} spellCheck={false} />
            </label>
            <Button onClick={() => setSecret("")}>비밀값 숨기기</Button>
          </div>
        )}
        {credentials.map((c) => (
          <article key={c.id}>
            <code>{c.id}</code>
            <p>
              {c.actions.map((a) => actionLabels[a] ?? a).join(", ")} · 만료{" "}
              {c.expiresAt} · {c.revoked ? "철회됨" : "활성"} · 마지막 사용{" "}
              {c.lastUsedAt ?? "기록 없음"}
            </p>
            <Button
              disabled={busy || c.revoked}
              onClick={() =>
                run(async () => {
                  if (!window.confirm("이 제한 토큰을 즉시 철회할까요?"))
                    return;
                  await remove(`/credentials/${c.id}`);
                  setNotice("토큰을 철회했습니다.");
                })
              }
            >
              토큰 철회
            </Button>
          </article>
        ))}
      </details>
      {access && (
        <ServiceAccountsPanel
          api={api}
          allowed={admin && access.space.namespaceKind === "team"}
          policyVersion={access.space.policyVersion}
          onChanged={async () => {
            await load();
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
