import { useEffect, useRef, useState } from "react";
import type { OperationalApi } from "./api";
import { Button } from "../ui/primitives";
type Preview = {
  token: string;
  expiresAt: string;
  items: {
    id: string;
    status: string;
    expectedRevision?: number;
    patch?: unknown;
  }[];
};
type Outcome = { id: string; status: string; code?: string; revision?: number };
export function BulkEditor({
  api,
  pages,
  scope,
  onChanged,
  onExpired,
}: {
  api: OperationalApi;
  pages: { id: string; title: string }[];
  scope: string;
  onChanged: () => Promise<void>;
  onExpired: () => void;
}) {
  const [ids, setIds] = useState<string[]>([]),
    [kind, setKind] = useState("tags"),
    [value, setValue] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [recovery, setRecovery] = useState<Preview | null>(null),
    [results, setResults] = useState<Outcome[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setIds([]);
    setPreview(null);
    setRecovery(null);
    setResults([]);
    setError("");
    setBusy(false);
    return () => {
      epoch.current++;
    };
  }, [scope, api]);
  function change() {
    epoch.current++;
    setPreview(null);
    setRecovery(null);
    setResults([]);
    setError("");
    setBusy(false);
  }
  async function run(apply = false) {
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    if (!apply) setPreview(null);
    try {
      const chosen = preview ?? recovery;
      if (apply && chosen) {
        const r = await api.post<{ items: Outcome[] }>(
          "/workflows/bulk/apply",
          { token: chosen.token },
        );
        if (request !== epoch.current) return;
        setResults(r.items);
        setRecovery(
          r.items.some(
            (i) => i.status === "unconfirmed" || i.code === "NOT_PROCESSED",
          )
            ? chosen
            : null,
        );
        setPreview(null);
        try {
          await onChanged();
        } catch {
          if (request === epoch.current)
            setError(
              "적용 결과는 아래에 표시됩니다. 문서 목록을 새로고침하지 못했습니다.",
            );
        }
      } else {
        const operation =
          kind === "tags"
            ? {
                kind,
                tags: value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : kind === "move"
              ? { kind, parentId: value.trim() || null }
              : { kind };
        const r = await api.post<Preview>("/workflows/bulk/preview", {
          pageIds: ids,
          operation,
          reason,
        });
        if (request === epoch.current) setPreview(r);
      }
    } catch (e) {
      if (request !== epoch.current) return;
      if (apply) {
        setRecovery(preview ?? recovery);
      } else {
        setResults([]);
      }
      setPreview(null);
      setError(e instanceof Error ? e.message : "요청 실패");
      if (
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        [401, 403].includes(Number(e.status))
      ) {
        setIds([]);
        setRecovery(null);
        setResults([]);
        if (e.status === 401) onExpired();
      }
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>여러 문서의 태그·위치·보관 변경</summary>
      <p>
        최대 50개 문서를 선택해 변경 내용을 확인합니다. 적용은 문서별로 처리하며
        권한이나 기준이 달라진 대상은 실패로 표시합니다.
      </p>
      <fieldset disabled={busy}>
        <legend>대상 문서</legend>
        {pages.slice(0, 1000).map((p) => (
          <label key={p.id} style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={ids.includes(p.id)}
              disabled={!ids.includes(p.id) && ids.length >= 50}
              onChange={(e) => {
                change();
                setIds((v) =>
                  e.target.checked
                    ? [...v, p.id]
                    : v.filter((id) => id !== p.id),
                );
              }}
            />
            {p.title}
          </label>
        ))}
      </fieldset>
      <label>
        변경 종류
        <select
          value={kind}
          disabled={busy}
          onChange={(e) => {
            change();
            setKind(e.target.value);
            setValue("");
          }}
        >
          <option value="tags">태그 교체</option>
          <option value="move">상위 문서 변경</option>
          <option value="archive">보관</option>
        </select>
      </label>
      {kind === "tags" && (
        <label>
          새 태그 (쉼표 구분)
          <input
            value={value}
            disabled={busy}
            maxLength={3000}
            onChange={(e) => {
              change();
              setValue(e.target.value);
            }}
          />
        </label>
      )}
      {kind === "move" && (
        <label>
          상위 문서
          <select
            value={value}
            disabled={busy}
            onChange={(e) => {
              change();
              setValue(e.target.value);
            }}
          >
            <option value="">최상위</option>
            {pages
              .filter((p) => !ids.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        변경 이유
        <input
          value={reason}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => {
            change();
            setReason(e.target.value);
          }}
        />
      </label>
      <Button
        disabled={busy || !ids.length || !reason.trim()}
        onClick={() => void run()}
      >
        변경 미리보기
      </Button>
      {preview && (
        <section aria-label="일괄 변경 미리보기">
          <p>확인 유효 시각: {preview.expiresAt}</p>
          <ul>
            {preview.items.map((i) => (
              <li key={i.id}>
                {pages.find((p) => p.id === i.id)?.title ?? "선택 문서"} ·{" "}
                {i.status === "ready"
                  ? `적용 가능 · 기준 ${i.expectedRevision}`
                  : "접근 또는 변경 불가"}
                {i.status === "ready" && (
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {JSON.stringify(i.patch, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <Button
            disabled={busy || !preview.items.some((i) => i.status === "ready")}
            onClick={() => void run(true)}
          >
            미리보기 내용 적용
          </Button>
        </section>
      )}
      {busy && <p role="status">처리 중입니다.</p>}
      {error && <p role="alert">{error}</p>}
      {recovery && (
        <Button disabled={busy} onClick={() => void run(true)}>
          동일 요청의 처리 결과 다시 확인
        </Button>
      )}
      {results.length > 0 && (
        <section aria-label="일괄 변경 결과">
          <ul>
            {results.map((r) => (
              <li key={r.id}>
                {pages.find((p) => p.id === r.id)?.title ?? "선택 문서"} ·{" "}
                {r.status === "applied"
                  ? "적용됨"
                  : r.status === "unconfirmed"
                    ? "처리 확인 필요"
                    : r.status === "skipped"
                      ? "제외됨"
                      : "실패"}{" "}
                {r.code}
              </li>
            ))}
          </ul>
          <Button
            onClick={() => {
              change();
              setIds(
                results
                  .filter(
                    (r) =>
                      r.status === "failed" ||
                      r.status === "unconfirmed" ||
                      r.code === "NOT_PROCESSED",
                  )
                  .map((r) => r.id),
              );
            }}
          >
            실패 대상 다시 미리보기
          </Button>
        </section>
      )}
    </details>
  );
}
