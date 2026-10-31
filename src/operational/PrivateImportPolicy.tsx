import { useEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "./api";
import { Button } from "../ui/primitives";
export interface PrivateImportPolicySnapshot {
  importId: string;
  importRevision: number;
  revision: number;
  classification: string;
  approvedInputRevision: number | null;
  grants: readonly {
    destinationId: string;
    purpose: string;
    fingerprint: string;
  }[];
  destinations: readonly {
    id: string;
    revision: number;
    fingerprint: string;
    purposes: readonly string[];
    classifications: readonly string[];
  }[];
  modelConfigured: boolean;
  modelDestinationId: string | null;
  modelDestinationApproved: boolean;
  transmissionFeaturesEnabled: boolean;
  currentInputApproved: boolean;
  impact: string;
}
const path = (id: string) => `/policy/imports/${encodeURIComponent(id)}`;
export function privateImportApproved(
  policy: PrivateImportPolicySnapshot | null,
  id: string,
  revision: number,
  dirty: boolean,
): boolean {
  if (
    !policy ||
    dirty ||
    policy.importId !== id ||
    policy.importRevision !== revision ||
    policy.approvedInputRevision !== revision ||
    policy.modelConfigured !== true ||
    policy.modelDestinationApproved !== true ||
    policy.transmissionFeaturesEnabled !== true ||
    policy.currentInputApproved !== true
  )
    return false;
  const d = policy.destinations.find((d) => d.id === policy.modelDestinationId);
  return (
    !!d &&
    d.purposes.includes("organize") &&
    d.classifications.includes(policy.classification) &&
    policy.grants.some(
      (g) =>
        g.destinationId === d.id &&
        g.purpose === "organize" &&
        g.fingerprint === d.fingerprint,
    )
  );
}
export async function approvePrivateImport(
  api: OperationalApi,
  policy: PrivateImportPolicySnapshot,
  destinationId: string,
  classification: string,
  impactConfirmed: boolean,
) {
  const d = policy.destinations.find((d) => d.id === destinationId);
  if (
    !impactConfirmed ||
    !policy.modelConfigured ||
    !policy.modelDestinationApproved ||
    !policy.transmissionFeaturesEnabled ||
    destinationId !== policy.modelDestinationId ||
    !d?.purposes.includes("organize") ||
    !d.classifications.includes(classification)
  )
    throw Error("현재 사전 등록된 모델 목적지·자료 등급·영향을 확인하세요.");
  await api.request(path(policy.importId), "PUT", {
    expectedRevision: policy.revision,
    expectedImportRevision: policy.importRevision,
    classification,
    grants: [
      { destinationId: d.id, purpose: "organize", fingerprint: d.fingerprint },
    ],
    impactAcknowledged: true,
  });
  return api.get<PrivateImportPolicySnapshot>(path(policy.importId));
}
/** Model start NEVER PATCHes selection: doing so would invalidate the approval. */
export async function startApprovedPrivateImport(
  api: OperationalApi,
  id: string,
  revision: number,
  key: string,
) {
  const current = await api.get<PrivateImportPolicySnapshot>(path(id));
  if (!privateImportApproved(current, id, revision, false))
    throw Error(
      "현재 입력 버전의 모델 전송 승인이 필요합니다. 선택을 저장·분석한 뒤 목적지와 자료 등급을 다시 확인하세요.",
    );
  return api.post(
    `/imports/${encodeURIComponent(id)}/runs`,
    { revision, mode: "model" },
    key,
  );
}
export function PrivateImportPolicy({
  api,
  importId,
  revision,
  dirty,
  disabled,
  refresh,
  onState,
  onExpired,
}: {
  api: OperationalApi;
  importId: string;
  revision: number;
  dirty: boolean;
  disabled: boolean;
  refresh: number;
  onState: (p: PrivateImportPolicySnapshot | null) => void;
  onExpired: () => void;
}) {
  const [policy, setPolicy] = useState<PrivateImportPolicySnapshot | null>(
      null,
    ),
    [destination, setDestination] = useState(""),
    [classification, setClassification] = useState(""),
    [impact, setImpact] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(false),
    epoch = useRef(0);
  const fail = (e: unknown) => {
    if (!mounted.current) return;
    onState(null);
    setError(
      e instanceof ApiError && e.status === 409
        ? "입력 또는 정책 버전이 변경되었습니다. 최신 자료를 열어 다시 승인하세요."
        : e instanceof Error
          ? e.message
          : "승인 정보를 확인하지 못했습니다.",
    );
    if (e instanceof ApiError && e.status === 401) onExpired();
  };
  useEffect(() => {
    mounted.current = true;
    epoch.current++;
    let current = true;
    onState(null);
    setPolicy(null);
    setImpact(false);
    setBusy(false);
    setError("");
    api
      .get<PrivateImportPolicySnapshot>(path(importId))
      .then((p) => {
        if (current) {
          setPolicy(p);
          onState(p);
          const d = p.destinations.find((d) => d.id === p.modelDestinationId);
          const valid = privateImportApproved(p, importId, revision, false);
          setDestination(valid ? d!.id : "");
          setClassification(valid ? p.classification : "");
        }
      })
      .catch((e) => {
        if (current) fail(e);
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [api, importId, revision, refresh, onState]);
  const d = policy?.destinations.find((d) => d.id === destination);
  const allowed = privateImportApproved(policy, importId, revision, dirty);
  const configured =
    policy?.modelConfigured === true &&
    policy.modelDestinationApproved === true &&
    policy.transmissionFeaturesEnabled === true;
  return (
    <section aria-label="개인 원본 모델 전송 승인" className="op-notice">
      <h4>모델 전송 승인 · 현재 입력 버전 {revision}</h4>
      <p>
        업로드·열람은 전송 허가가 아닙니다. 현재 수집 자료를 업로드한 본인이
        사전 등록된 목적지·등급을 확인해야 합니다. 공유·발행·사내 승인이
        아닙니다.
      </p>
      <p role="status">
        {dirty
          ? "선택을 바꿨습니다. 선택 적용 · 입력 다시 분석 후 다시 승인하세요."
          : !policy
            ? "승인 상태를 확인하는 중입니다."
            : allowed
              ? "현재 입력 버전의 명시적 전송 승인이 확인되었습니다."
              : !configured
                ? "모델 미설정·목적지 미등록 또는 기능 비활성으로 모델 정리가 차단되었습니다. 운영자가 현재 모델 목적지와 정책을 먼저 구성해야 합니다."
                : "모델 정리는 차단되어 있습니다. 아래에서 현재 입력의 전송을 명시적으로 승인하세요."}
      </p>
      {error && <p role="alert">{error}</p>}
      {policy && (
        <fieldset
          disabled={
            disabled ||
            busy ||
            dirty ||
            !configured ||
            policy.importRevision !== revision
          }
        >
          <legend>현재 입력·목적지 확인 · 정책 버전 {policy.revision}</legend>
          <label>
            사전 등록 목적지{" "}
            <select
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                setClassification("");
                setImpact(false);
              }}
            >
              <option value="">목적지를 직접 선택하세요</option>
              {policy.destinations
                .filter(
                  (d) =>
                    d.id === policy.modelDestinationId &&
                    d.purposes.includes("organize"),
                )
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id} · 버전 {d.revision}
                  </option>
                ))}
            </select>
          </label>
          <label>
            자료 등급{" "}
            <select
              value={classification}
              onChange={(e) => {
                setClassification(e.target.value);
                setImpact(false);
              }}
            >
              <option value="">자료 등급을 직접 선택하세요</option>
              {d?.classifications.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          {d && (
            <p>
              목적: organize · 목적지 지문{" "}
              <code style={{ overflowWrap: "anywhere" }}>{d.fingerprint}</code>
            </p>
          )}
          <p>
            {policy.impact} 기존 위키 문맥의 원본 제한도 별도로 적용됩니다. 입력
            범위·버전·목적지 변경은 이전 승인을 무효화합니다.
          </p>
          <label>
            <input
              type="checkbox"
              checked={impact}
              onChange={(e) => setImpact(e.target.checked)}
            />
            현재 입력 버전 {revision}의 선택 자료 전송 범위와 영향을
            확인했습니다.
          </label>
          <Button
            disabled={!d || !classification || !impact}
            onClick={async () => {
              const current = epoch.current;
              setBusy(true);
              setError("");
              try {
                const p = await approvePrivateImport(
                  api,
                  policy,
                  destination,
                  classification,
                  impact,
                );
                if (mounted.current && epoch.current === current) {
                  setPolicy(p);
                  onState(p);
                  setImpact(false);
                }
              } catch (e) {
                if (epoch.current === current) fail(e);
              } finally {
                if (mounted.current && epoch.current === current)
                  setBusy(false);
              }
            }}
          >
            현재 입력의 전송 승인 저장
          </Button>
        </fieldset>
      )}
    </section>
  );
}
