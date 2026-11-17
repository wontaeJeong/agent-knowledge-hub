import { useLayoutEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "../api";
import { Button } from "../../ui/primitives";
import {
  documentPropertiesSchema,
  propertyWarnings,
  type DocumentProperties,
  type PropertyPolicy,
} from "../../domain/document-properties";
type Detail = {
  metadata: {
    number: number;
    settingsRevision: number;
    category: string;
    summary: string;
    tags: string[];
    properties: Record<string, string>;
    environment: DocumentProperties["environment"];
    workflowData: { reviewDue?: string | null };
  };
  policies: PropertyPolicy[];
  owner: { revision: number; owner_id: string; backup_id: string } | null;
};
const empty: DocumentProperties = {
  category: "",
  summary: "",
  tags: [],
  properties: {},
  environment: "",
  reviewDue: null,
};
export function PropertiesForm({
  api,
  pageId,
  scope,
  canAssignOwner,
  onExpired,
  onReadUnavailable,
  recheckDocument,
}: {
  api: OperationalApi;
  pageId: string;
  scope: string;
  canAssignOwner: boolean;
  onExpired: () => void;
  onReadUnavailable: (error: ApiError) => void;
  recheckDocument: (error: ApiError) => void;
}) {
  const key = scope + ":" + pageId,
    epoch = useRef(0),
    mutation = useRef(crypto.randomUUID());
  const [loaded, setLoaded] = useState<{ key: string; detail: Detail } | null>(
      null,
    ),
    [value, setValue] = useState(empty),
    [tags, setTags] = useState(""),
    [advanced, setAdvanced] = useState("{}"),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [owners, setOwners] = useState<string[]>([]),
    [owner, setOwner] = useState(""),
    [backup, setBackup] = useState("");
  function clearProtected() {
    setLoaded(null);
    setValue(empty);
    setTags("");
    setAdvanced("{}");
    setOwner("");
    setBackup("");
    setOwners([]);
    setReason("");
    setNotice("");
    mutation.current = crypto.randomUUID();
  }
  const path = `/workflows/pages/${encodeURIComponent(pageId)}/properties`;
  async function readProperties(n: number) {
    try {
      let detail = await api.get<Detail>(path);
      if (n !== epoch.current) return;
      let eligible: { id: string }[] = [];
      if (canAssignOwner) {
        try {
          eligible = (
            await api.get<{ items: { id: string }[] }>(
              `/governance/pages/${encodeURIComponent(pageId)}/eligible-owners`,
            )
          ).items;
        } catch (e) {
          if (n !== epoch.current) return;
          if (!(e instanceof ApiError) || ![403, 404].includes(e.status))
            throw e;
          // Owner assignment is a separate capability. Confirm the page read again.
          detail = await api.get<Detail>(path);
        }
      }
      if (n !== epoch.current) return;
      const m = detail.metadata;
      const { environment: _legacyEnvironment, ...properties } = m.properties;
      setValue({
        category: m.category,
        summary: m.summary,
        tags: m.tags,
        properties,
        environment: Object.hasOwn(m, "environment")
          ? m.environment
          : (m.properties.environment ?? ""),
        reviewDue: m.workflowData.reviewDue ?? null,
      });
      setTags(m.tags.join(", "));
      setAdvanced(JSON.stringify(properties, null, 2));
      setOwners(eligible.map((x) => x.id));
      setOwner(detail.owner?.owner_id ?? "");
      setBackup(detail.owner?.backup_id ?? "");
      setLoaded({ key, detail });
      setError("");
    } catch (e) {
      if (n !== epoch.current) {
        if (e instanceof ApiError && [403, 404].includes(e.status))
          recheckDocument(e);
        return;
      }
      ++epoch.current;
      clearProtected();
      setError(e instanceof Error ? e.message : "속성을 불러오지 못했습니다.");
      if (e instanceof ApiError) {
        if (e.status === 401) onExpired();
        if ([403, 404].includes(e.status)) onReadUnavailable(e);
      }
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  useLayoutEffect(() => {
    const n = ++epoch.current;
    clearProtected();
    setError("");
    setBusy(false);
    void readProperties(n);
    return () => {
      ++epoch.current;
    };
  }, [api, key, canAssignOwner]);
  function edit(patch: Partial<DocumentProperties>) {
    setValue((v) => ({ ...v, ...patch }));
    mutation.current = crypto.randomUUID();
    setNotice("");
  }
  const detail = loaded?.key === key ? loaded.detail : null;
  if (!detail)
    return (
      <section aria-label="문서 속성">
        <p role={error ? "alert" : "status"}>
          {error || "속성을 불러오는 중입니다."}
        </p>
      </section>
    );
  const warnings = propertyWarnings(
    {
      ...value,
      tags: tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    detail.policies,
    detail.owner?.owner_id,
  );
  async function save(assign = false) {
    const n = epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (assign) {
        await api.post(`/governance/pages/${pageId}/owner`, {
          expectedRevision: detail!.owner?.revision ?? 0,
          ownerId: owner,
          backupId: backup,
          reason,
        });
        if (n === epoch.current) {
          setLoaded((x) =>
            x
              ? {
                  ...x,
                  detail: {
                    ...x.detail,
                    owner: {
                      revision: (x.detail.owner?.revision ?? 0) + 1,
                      owner_id: owner,
                      backup_id: backup,
                    },
                  },
                }
              : null,
          );
          setNotice("담당자를 저장했습니다. 접근 권한은 변경되지 않았습니다.");
        }
      } else {
        const parsed = documentPropertiesSchema.parse({
          ...value,
          tags: tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          properties: JSON.parse(advanced),
        });
        await api.post(`/workflows/pages/${pageId}/properties`, {
          ...parsed,
          expectedVersion: detail!.metadata.number,
          expectedRevision: detail!.metadata.settingsRevision,
          reason,
          mutationId: mutation.current,
        });
        if (n === epoch.current)
          setNotice(
            "속성 검토를 요청했습니다. 승인·발행 전에는 현재 문서가 유지됩니다.",
          );
      }
    } catch (e) {
      if (e instanceof ApiError && [403, 404].includes(e.status)) {
        if (n === epoch.current) {
          ++epoch.current;
          clearProtected();
        }
        // The parent checks the captured identity/selection and owns sibling read ordering.
        recheckDocument(e);
        return;
      }
      if (n !== epoch.current) return;
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
      if (e instanceof ApiError && e.status === 401) {
        ++epoch.current;
        clearProtected();
        onExpired();
      }
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label="문서 속성" className="property-form">
      <p>유형·태그·요약·속성 변경은 독립 검토와 발행 후 반영됩니다.</p>
      <fieldset disabled={busy}>
        <legend>문서 속성</legend>
        <label>
          문서 유형
          <input
            value={value.category}
            maxLength={100}
            onChange={(e) => edit({ category: e.target.value })}
          />
        </label>
        <label>
          태그 (쉼표 구분)
          <input
            value={tags}
            maxLength={3000}
            onChange={(e) => {
              setTags(e.target.value);
              edit({});
            }}
          />
        </label>
        <label>
          적용 환경
          <input
            value={
              typeof value.environment === "object" && value.environment
                ? JSON.stringify(value.environment)
                : (value.environment ?? "")
            }
            maxLength={2000}
            onChange={(e) => edit({ environment: e.target.value })}
          />
        </label>
        <label>
          검토일
          <input
            type="date"
            value={value.reviewDue?.slice(0, 10) ?? ""}
            onChange={(e) =>
              edit({
                reviewDue: e.target.value
                  ? e.target.value + "T00:00:00Z"
                  : null,
              })
            }
          />
        </label>
        <label>
          요약
          <textarea
            rows={3}
            value={value.summary}
            maxLength={10000}
            onChange={(e) => edit({ summary: e.target.value })}
          />
        </label>
        {[
          ...new Set([
            ...Object.keys(value.properties),
            ...((
              detail.policies.find((p) => p.document_type === value.category) ??
              detail.policies.find((p) => p.document_type === "*")
            )?.required_keys ?? []),
          ]),
        ]
          .filter(
            (k) =>
              ![
                "environment",
                "businessOwner",
                "summary",
                "tags",
                "reviewDue",
              ].includes(k),
          )
          .map((k) => (
            <label key={k}>
              {k}
              <input
                value={value.properties[k] ?? ""}
                onChange={(e) => {
                  const properties = {
                    ...value.properties,
                    [k]: e.target.value,
                  };
                  edit({ properties });
                  setAdvanced(JSON.stringify(properties, null, 2));
                }}
              />
            </label>
          ))}
        <details>
          <summary>고급 속성 JSON</summary>
          <label>
            문자열 속성 객체
            <textarea
              rows={4}
              value={advanced}
              onChange={(e) => {
                setAdvanced(e.target.value);
                edit({});
              }}
            />
          </label>
        </details>
        <label>
          변경 이유
          <input
            value={reason}
            maxLength={2000}
            onChange={(e) => {
              setReason(e.target.value);
              mutation.current = crypto.randomUUID();
            }}
          />
        </label>
      </fieldset>
      {warnings.map((w) => (
        <p key={w.key} role={w.mode === "block" ? "alert" : "status"}>
          필수 속성: {w.key} ·{" "}
          {w.mode === "block" ? "입력 후 검토 요청 가능" : "정책 권고"}
        </p>
      ))}
      <Button
        disabled={
          busy ||
          !reason.trim() ||
          !value.category.trim() ||
          warnings.some((w) => w.mode === "block")
        }
        onClick={() => void save()}
      >
        속성 검토 요청
      </Button>
      <fieldset disabled={busy || !canAssignOwner}>
        <legend>업무 담당자</legend>
        <p>담당자 지정은 접근 권한 또는 검토자 자격을 부여하지 않습니다.</p>
        {canAssignOwner ? (
          <>
            <label>
              업무 담당자
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">선택</option>
                {owners.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
            <label>
              대체 담당자
              <select
                value={backup}
                onChange={(e) => setBackup(e.target.value)}
              >
                <option value="">선택</option>
                {owners
                  .filter((id) => id !== owner)
                  .map((id) => (
                    <option key={id}>{id}</option>
                  ))}
              </select>
            </label>
            <Button
              disabled={
                busy || !reason.trim() || !owner || !backup || owner === backup
              }
              onClick={() => void save(true)}
            >
              담당자 저장
            </Button>
          </>
        ) : (
          <p>
            {detail.owner
              ? `${detail.owner.owner_id} · 대체 ${detail.owner.backup_id}`
              : "미지정"}{" "}
            · 변경은 공간 관리자에게 요청하세요.
          </p>
        )}
      </fieldset>
      {busy && <p role="status">요청 중입니다.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
