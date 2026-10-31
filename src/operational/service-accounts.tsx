import { useState, useEffect, useCallback } from "react";
import { OperationalApi, pageItems } from "./api";
import { Button } from "../ui/primitives";
const scopes = {
  "knowledge.read": "지식 읽기",
  "source.create": "원본 등록",
  "changeset.propose": "변경 제안",
  "lint.run": "위키 점검",
  "personal.sync": "개인 작업본 동기화",
  "local.copy": "정책이 허용한 로컬 복사",
};
export function serviceCredentialInput(actions: string[], expiresAt: string) {
  if (
    !actions.length ||
    actions.some((action) => !Object.hasOwn(scopes, action))
  )
    throw Error("승인·발행·관리 권한은 서비스 토큰에 위임할 수 없습니다.");
  return {
    actions: [...new Set(actions)],
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
interface Account {
  id: string;
  name: string;
  sponsorId: string;
  expiresAt: string;
  active: boolean;
}
interface Credential {
  id: string;
  spaceId: string;
  actions: string[];
  expiresAt: string;
  revoked: boolean;
  lastUsedAt?: string | null;
}
export function ServiceAccountsPanel({
  api,
  allowed,
  policyVersion,
  onChanged,
}: {
  api: OperationalApi;
  allowed: boolean;
  policyVersion: number;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<Account[]>([]),
    [credentials, setCredentials] = useState<Record<string, Credential[]>>({}),
    [page, setPage] = useState(0),
    [name, setName] = useState(""),
    [expiry, setExpiry] = useState(""),
    [sponsor, setSponsor] = useState(""),
    [actions, setActions] = useState<string[]>(["knowledge.read"]),
    [tokenExpiry, setTokenExpiry] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [secret, setSecret] = useState("");
  const load = useCallback(async () => {
    if (!allowed) return;
    setItems(
      (await api.get<{ items: Account[] }>("/service-principals")).items,
    );
  }, [api, allowed]);
  useEffect(() => {
    let active = true;
    setItems([]);
    setCredentials({});
    setPage(0);
    setSecret("");
    void load().catch((e) => {
      if (active)
        setError(
          e instanceof Error ? e.message : "서비스 주체를 조회하지 못했습니다.",
        );
    });
    return () => {
      active = false;
    };
  }, [load]);
  if (!allowed) return null;
  const tokens = async (id: string) =>
    setCredentials((old) => ({ ...old, [id]: [] }));
  const refreshTokens = async (id: string) => {
    const rows = await api.get<{ items: Credential[] }>(
      `/service-principals/${encodeURIComponent(id)}/credentials`,
    );
    setCredentials((old) => ({ ...old, [id]: rows.items }));
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    setSecret("");
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "작업을 완료하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>서비스 실행 주체 · 예약 유지관리</summary>
      <p>
        서비스는 실제 책임 사용자와 만료가 있는 별도 주체입니다. 승인·발행
        권한을 위임하지 않습니다. 기본 Read이며 작업에 필요한 공간 역할과 원본
        독자는 별도로 제한하세요.
      </p>
      {error && (
        <p role="alert" className="op-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            const created = await api.post<Account>("/service-principals", {
              name,
              expiresAt: new Date(expiry).toISOString(),
            });
            setNotice(
              `서비스 ${created.id}을 만들었습니다. 생성한 사람이 책임 사용자입니다. 필요한 최소 공간 역할을 별도로 부여하세요.`,
            );
            setName("");
          });
        }}
      >
        <label>
          서비스 이름
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
            disabled={busy}
          />
        </label>
        <label>
          서비스 만료 (현재 기기 시각대)
          <input
            type="datetime-local"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <Button type="submit" disabled={busy}>
          책임 사용자에 연결된 서비스 생성
        </Button>
      </form>
      <fieldset>
        <legend>선택 서비스의 토큰·책임 사용자 변경 입력</legend>
        <label>
          새 책임 사용자 ID (변경할 때만 입력)
          <input
            value={sponsor}
            onChange={(e) => setSponsor(e.target.value)}
            disabled={busy}
          />
        </label>
        <p>
          ‘책임/만료 갱신’은 위 서비스 만료를 사용합니다. 토큰 만료는 아래에서
          따로 정합니다.
        </p>
        {Object.entries(scopes).map(([scope, label]) => (
          <label key={scope}>
            <input
              type="checkbox"
              checked={actions.includes(scope)}
              onChange={(e) =>
                setActions((old) =>
                  e.target.checked
                    ? [...old, scope]
                    : old.filter((x) => x !== scope),
                )
              }
              disabled={busy}
            />
            {label}
          </label>
        ))}
        <label>
          토큰 만료 (서비스 만료 이내)
          <input
            type="datetime-local"
            value={tokenExpiry}
            onChange={(e) => setTokenExpiry(e.target.value)}
            disabled={busy}
          />
        </label>
      </fieldset>
      {pageItems(items, page).map((item) => (
        <article key={item.id}>
          <h4>
            {item.name} · {item.active ? "활성" : "비활성"}
          </h4>
          <code>{item.id}</code>
          <p>
            책임 사용자 {item.sponsorId} · 만료 {item.expiresAt}
          </p>
          <div className="op-actions">
            <Button
              disabled={busy || !item.active || !sponsor.trim() || !expiry}
              onClick={() =>
                perform(async () => {
                  if (
                    !window.confirm(
                      "현재 팀의 활성 인간에게 서비스 책임을 이전하고 만료를 변경할까요?",
                    )
                  )
                    return;
                  await api.post(`/service-principals/${item.id}`, {
                    sponsorId: sponsor.trim(),
                    expiresAt: new Date(expiry).toISOString(),
                    expectedVersion: policyVersion,
                  });
                  setNotice("책임 사용자와 서비스 만료를 갱신했습니다.");
                })
              }
            >
              책임/만료 갱신
            </Button>
            <Button
              disabled={busy || !item.active || !tokenExpiry || !actions.length}
              onClick={() =>
                perform(async () => {
                  const c = await api.post<{ secret: string }>(
                    `/service-principals/${item.id}/credentials`,
                    serviceCredentialInput(actions, tokenExpiry),
                  );
                  setSecret(c.secret);
                  setNotice(
                    "서비스 제한 토큰을 발급했습니다. 비밀값은 이번에만 표시합니다.",
                  );
                  await refreshTokens(item.id);
                })
              }
            >
              선택 권한으로 토큰 발급
            </Button>
            <Button
              disabled={busy}
              onClick={() => perform(() => refreshTokens(item.id))}
            >
              토큰 상태 조회
            </Button>
            <Button
              disabled={busy || !item.active}
              onClick={() =>
                perform(async () => {
                  if (
                    !window.confirm(
                      "서비스를 비활성화하고 모든 토큰을 철회할까요? 예약 작업도 현재 권한 재검사에서 중단됩니다.",
                    )
                  )
                    return;
                  await api.request(
                    `/service-principals/${item.id}`,
                    "DELETE",
                    {},
                  );
                  await tokens(item.id);
                  setNotice("서비스와 토큰을 비활성화했습니다.");
                })
              }
            >
              서비스·모든 토큰 철회
            </Button>
          </div>
          {(credentials[item.id] ?? []).map((c) => (
            <div key={c.id}>
              <code>{c.id}</code>
              <p>
                {c.actions
                  .map((a) => scopes[a as keyof typeof scopes] ?? a)
                  .join(", ")}{" "}
                · 만료 {c.expiresAt} · {c.revoked ? "철회됨" : "활성"} · 마지막
                사용 {c.lastUsedAt ?? "없음"}
              </p>
              <Button
                disabled={busy || c.revoked}
                onClick={() =>
                  perform(async () => {
                    if (
                      !window.confirm(
                        "이 서비스 토큰만 철회할까요? 새 토큰의 연결을 먼저 확인하세요.",
                      )
                    )
                      return;
                    await api.request(
                      `/service-principals/${item.id}/credentials/${c.id}`,
                      "DELETE",
                      {},
                    );
                    await refreshTokens(item.id);
                    setNotice("선택한 서비스 토큰을 철회했습니다.");
                  })
                }
              >
                토큰 하나 철회
              </Button>
            </div>
          ))}
        </article>
      ))}
      {items.length > 25 && (
        <div className="op-actions">
          <Button disabled={!page} onClick={() => setPage((p) => p - 1)}>
            이전 25건
          </Button>
          <span>
            {page + 1} / {Math.ceil(items.length / 25)}
          </span>
          <Button
            disabled={(page + 1) * 25 >= items.length}
            onClick={() => setPage((p) => p + 1)}
          >
            다음 25건
          </Button>
        </div>
      )}
      {secret && (
        <div role="status">
          <label>
            이번에만 표시되는 서비스 토큰
            <textarea value={secret} readOnly spellCheck={false} />
          </label>
          <Button onClick={() => setSecret("")}>비밀값 숨기기</Button>
        </div>
      )}
    </details>
  );
}
