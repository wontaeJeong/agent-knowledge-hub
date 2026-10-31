import { useEffect, useState } from "react";
import { Button } from "../ui/primitives";

type Grant = { destinationId: string; purpose: string; fingerprint: string };
type SourcePolicy = {
  source_id: string;
  revision: number;
  classification: string;
  grants: Grant[];
};
type Configuration = {
  features: { feature: string; enabled: boolean; revision: number }[];
  destinations: {
    id: string;
    purposes: string[];
    classifications: string[];
    fingerprint: string;
    revision: number;
  }[];
  impact: string;
};
export interface PolicyProps {
  api: <T>(
    path: string,
    options?: { method: string; body: unknown },
  ) => Promise<T>;
  capabilities: readonly string[];
  sourceOptions: readonly { id: string; title: string }[];
  onChanged: () => void;
  onExpired: () => void;
}
export function policyFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNAUTHENTICATED|401/.test(message)) return "expired";
  if (/STALE_VERSION|409/.test(message)) return "conflict";
  return "error";
}
/** Host supplies its existing authenticated/CSRF API adapter. No identity, URL,
 * credential, company approval or arbitrary destination registration inputs. */
export function PolicyManager({
  api,
  capabilities,
  sourceOptions,
  onChanged,
  onExpired,
}: PolicyProps) {
  const [config, setConfig] = useState<Configuration>();
  const [sourceId, setSourceId] = useState("");
  const [policy, setPolicy] = useState<SourcePolicy>();
  const [status, setStatus] = useState("정책을 불러오는 중입니다.");
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState(false);
  const allowed = capabilities.includes("space.admin");
  const fail = (error: unknown) => {
    const state = policyFailure(error);
    setStatus(
      state === "expired"
        ? "인증이 만료되었습니다."
        : state === "conflict"
          ? "정책이 변경되었습니다. 다시 불러온 뒤 검토하세요."
          : "정책 요청에 실패했습니다. 변경은 확인되지 않았습니다.",
    );
    if (state === "expired") onExpired();
  };
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    api<Configuration>("/api/v1/policy")
      .then((value) => {
        if (alive) {
          setConfig(value);
          setStatus(
            "비활성 기능은 직접 API·에이전트·예약 작업에서도 차단됩니다.",
          );
        }
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [api, allowed]);
  useEffect(() => {
    setPolicy(undefined);
    setImpact(false);
    if (!sourceId || !allowed) return;
    let alive = true;
    api<SourcePolicy>(`/api/v1/policy/sources/${encodeURIComponent(sourceId)}`)
      .then((p) => {
        if (alive) setPolicy(p);
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [sourceId, api, allowed]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    try {
      await api(path, { method: "PUT", body });
      setConfig(await api<Configuration>("/api/v1/policy"));
      if (sourceId)
        setPolicy(
          await api<SourcePolicy>(
            `/api/v1/policy/sources/${encodeURIComponent(sourceId)}`,
          ),
        );
      setImpact(false);
      setStatus(
        "정책 변경을 저장했습니다. 기존 대기 작업은 새 정책을 다시 검사해야 합니다.",
      );
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  if (!allowed)
    return (
      <p role="status">
        정책 관리는 현재 공간의 인간 관리자만 사용할 수 있습니다.
      </p>
    );
  if (sourceOptions.length > 200)
    return (
      <p role="alert">원본 목록을 200건 이하로 좁힌 뒤 정책 관리를 여세요.</p>
    );
  return (
    <section aria-label="전송 및 기능 정책">
      <h2>전송 및 기능 정책</h2>
      <p role="status">{status}</p>
      <p>
        읽기 권한은 모델 전송 허가가 아닙니다. 원본 정책이 없으면 전송을
        차단합니다. 아래 허용은 사전 등록된 목적지에 대한 로컬 정책이며 사내
        승인이 아닙니다.
      </p>
      <fieldset disabled={busy || !config}>
        <legend>기능 사용</legend>
        {config?.features.map((f) => (
          <div key={f.feature}>
            <span>
              {f.feature}: {f.enabled ? "활성" : "비활성 — 실행 차단"}
            </span>{" "}
            <Button
              onClick={() =>
                void mutate(`/api/v1/policy/features/${f.feature}`, {
                  enabled: !f.enabled,
                  expectedRevision: f.revision,
                })
              }
            >
              {f.enabled ? "비활성화" : "다시 활성화"}
            </Button>
          </div>
        ))}
      </fieldset>
      <label>
        원본 선택{" "}
        <select
          value={sourceId}
          disabled={busy}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">원본을 선택하세요</option>
          {sourceOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      {policy && config && (
        <fieldset disabled={busy}>
          <legend>원본별 전송 허용 · 버전 {policy.revision}</legend>
          <label>
            자료 등급{" "}
            <select
              value={policy.classification}
              onChange={(e) => {
                setPolicy({
                  ...policy,
                  classification: e.target.value,
                  grants: [],
                });
                setImpact(false);
              }}
            >
              {[
                ...new Set([
                  policy.classification,
                  ...config.destinations.flatMap((d) => d.classifications),
                ]),
              ].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          {config.destinations.length === 0 ? (
            <p>
              사용 가능한 사전 등록 목적지가 없습니다. 관리자가 임의 URL을
              승인할 수 없습니다.
            </p>
          ) : (
            config.destinations
              .filter((d) => d.classifications.includes(policy.classification))
              .map((d) => (
                <fieldset key={d.id}>
                  <legend>
                    {d.id} · 목적지 버전 {d.revision}
                  </legend>
                  {d.purposes.map((p) => {
                    const checked = policy.grants.some(
                      (g) =>
                        g.destinationId === d.id &&
                        g.purpose === p &&
                        g.fingerprint === d.fingerprint,
                    );
                    return (
                      <label key={p}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const rest = policy.grants.filter(
                              (g) =>
                                !(g.destinationId === d.id && g.purpose === p),
                            );
                            setPolicy({
                              ...policy,
                              grants: e.target.checked
                                ? [
                                    ...rest,
                                    {
                                      destinationId: d.id,
                                      purpose: p,
                                      fingerprint: d.fingerprint,
                                    },
                                  ]
                                : rest,
                            });
                            setImpact(false);
                          }}
                        />
                        {p}
                      </label>
                    );
                  })}
                </fieldset>
              ))
          )}
          <p>{config.impact}</p>
          <label>
            <input
              type="checkbox"
              checked={impact}
              onChange={(e) => setImpact(e.target.checked)}
            />
            전체 파생 페이지·대기 작업에 미치는 영향을 확인했습니다.
          </label>
          <Button
            disabled={!impact}
            onClick={() =>
              void mutate(
                `/api/v1/policy/sources/${encodeURIComponent(sourceId)}`,
                {
                  expectedRevision: policy.revision,
                  classification: policy.classification,
                  grants: policy.grants,
                  impactAcknowledged: true,
                },
              )
            }
          >
            검토한 정책 저장
          </Button>
        </fieldset>
      )}
    </section>
  );
}
