import { useLayoutEffect, useRef, useState } from "react";
import type { OperationalApi } from "./api";
import { Button } from "../ui/primitives";
type Preview = {
  mutationId?: string;
  token: string;
  previewToken?: string;
  expiresAt: string;
  items: {
    id: string;
    status: string;
    expectedRevision?: number;
    patch?: unknown;
    before?: unknown;
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
    [hiddenIds, setHiddenIds] = useState<string[]>([]),
    [uncertainIds, setUncertainIds] = useState<string[]>([]),
    [kind, setKind] = useState("tags"),
    [value, setValue] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [recovery, setRecovery] = useState<Preview | null>(null),
    [results, setResults] = useState<Outcome[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const epoch = useRef(0);
  const [receipt, setReceipt] = useState<string | null>(null),
    [jobStatus, setJobStatus] = useState("");
  async function readReceipt(id: string, request: number) {
    const affected = [
      ...new Set([...ids, ...results.map((item) => item.id), ...uncertainIds]),
    ];
    let r;
    try {
      r = await api.get<{
        status: string;
        error?: string;
        items: Outcome[];
      }>(`/workflows/bulk/${id}`);
    } catch (e) {
      if (request !== epoch.current) return;
      const status =
        e && typeof e === "object" && "status" in e
          ? Number(e.status)
          : undefined;
      setResults([]);
      setIds([]);
      setError(e instanceof Error ? e.message : "결과 조회 실패");
      if (status === 401 || status === 403 || status === 404) {
        setHiddenIds((old) => [...new Set([...old, ...affected])]);
        setUncertainIds([]);
        setReceipt(null);
        if (status === 401) onExpired();
      } else {
        setUncertainIds(affected);
      }
      return;
    }
    if (request !== epoch.current) return;
    const visible = new Set(r.items.map((i) => i.id));
    const omitted = affected.filter((id) => !visible.has(id));
    setHiddenIds((old) => [
      ...new Set([...old.filter((id) => !visible.has(id)), ...omitted]),
    ]);
    setUncertainIds([]);
    const unfinished = new Set(
      r.items
        .filter((i) => i.status !== "applied" && i.status !== "needs-review")
        .map((i) => i.id),
    );
    setIds(affected.filter((id) => unfinished.has(id)));
    setResults(r.items);
    setJobStatus(r.status);
    setError(r.error ?? "");
  }

  useLayoutEffect(() => {
    epoch.current++;
    setReceipt(null);
    setJobStatus("");
    setIds([]);
    setHiddenIds([]);
    setUncertainIds([]);
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
    setReceipt(null);
    setJobStatus("");
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
    if (!apply) {
      setPreview(null);
      setRecovery(null);
      setReceipt(null);
      setJobStatus("");
      setResults([]);
    }
    try {
      const chosen = preview ?? recovery;
      if (apply && chosen) {
        const r = await api.post<{
          id?: string;
          status?: string;
          items?: Outcome[];
        }>(
          "/workflows/bulk/apply",
          chosen.previewToken
            ? {
                previewToken: chosen.previewToken,
                mutationId: chosen.mutationId,
              }
            : { token: chosen.token },
        );
        if (request !== epoch.current) return;
        if (r.id) {
          setReceipt(r.id);
          setJobStatus(r.status ?? "queued");
          setRecovery(null);
          await readReceipt(r.id, request);
        } else if (r.items) {
          setResults(r.items);
          setRecovery(
            r.items.some(
              (i) => i.status === "unconfirmed" || i.code === "NOT_PROCESSED",
            )
              ? chosen
              : null,
          );
        }
        setPreview(null);
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
        if (request === epoch.current) {
          const unavailable = r.items
            .filter((i) => i.status !== "ready")
            .map((i) => i.id);
          setHiddenIds((old) => [...new Set([...old, ...unavailable])]);
          setIds((old) => old.filter((id) => !unavailable.includes(id)));
          setPreview({
            ...r,
            mutationId: crypto.randomUUID(),
            items: r.items.filter((i) => i.status === "ready"),
          });
        }
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
        setHiddenIds(pages.map((p) => p.id));
        setIds([]);
        setRecovery(null);
        setResults([]);
        if (e.status === 401) onExpired();
      }
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  const editingDisabled = busy || uncertainIds.length > 0;
  const terminal = ["dead", "cancelled", "succeeded"].includes(jobStatus);
  const retryIds = results
    .filter(
      (r) =>
        ["stale", "denied", "failed", "unconfirmed"].includes(r.status) ||
        r.code === "NOT_PROCESSED" ||
        (r.status === "pending" && terminal),
    )
    .map((r) => r.id);
  return (
    <details>
      <summary>여러 문서의 태그·위치·보관 변경</summary>
      <p>
        최대 50개 문서를 선택해 변경 내용을 확인합니다. 적용은 문서별로 처리하며
        권한이나 기준이 달라진 대상은 별도 표시합니다. 태그 변경은 검토 요청으로
        접수합니다.
      </p>
      {uncertainIds.length > 0 && (
        <p role="status">작업 결과를 다시 조회하면 확인된 문서를 표시합니다.</p>
      )}
      {hiddenIds.length > 0 && (
        <p role="status">
          현재 접근하거나 변경할 수 없는 선택을 제거했습니다. 필요한 문서는
          권한을 확인한 뒤 다시 선택하세요.
        </p>
      )}
      <fieldset disabled={editingDisabled}>
        <legend>대상 문서</legend>
        {pages
          .filter(
            (p) => !hiddenIds.includes(p.id) && !uncertainIds.includes(p.id),
          )
          .slice(0, 1000)
          .map((p) => (
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
          disabled={editingDisabled}
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
            disabled={editingDisabled}
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
            disabled={editingDisabled}
            onChange={(e) => {
              change();
              setValue(e.target.value);
            }}
          >
            <option value="">최상위</option>
            {pages
              .filter(
                (p) =>
                  !hiddenIds.includes(p.id) && !uncertainIds.includes(p.id),
              )
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
          disabled={editingDisabled}
          onChange={(e) => {
            change();
            setReason(e.target.value);
          }}
        />
      </label>
      <Button
        disabled={
          busy || !ids.length || !reason.trim() || (!!receipt && !terminal)
        }
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
                {i.status === "ready"
                  ? (pages.find((p) => p.id === i.id)?.title ?? "선택 문서")
                  : "선택 문서"}{" "}
                ·{" "}
                {i.status === "ready"
                  ? `적용 가능 · 기준 ${i.expectedRevision}`
                  : "접근 또는 변경 불가"}
                {i.status === "ready" && (
                  <pre
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {i.before !== undefined &&
                      `변경 전: ${JSON.stringify(i.before)}\n`}
                    {`변경 후: ${JSON.stringify(i.patch)}`}
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
      {receipt && (
        <section aria-label="일괄 작업 상태">
          <p role="status">
            {jobStatus === "queued"
              ? "접수됨 · 작업자 처리 대기"
              : jobStatus === "running"
                ? "처리 중"
                : jobStatus === "succeeded"
                  ? "항목 처리 완료 · 아래 결과 확인"
                  : "작업 중단 · 결과와 사유 확인"}
          </p>
          <Button
            disabled={busy}
            onClick={() => {
              const request = ++epoch.current;
              setBusy(true);
              void readReceipt(receipt, request).finally(() => {
                if (request === epoch.current) setBusy(false);
              });
            }}
          >
            처리 결과 새로고침
          </Button>
        </section>
      )}
      {results.length > 0 && (
        <section aria-label="일괄 변경 결과">
          <p>
            아래 결과와 재확인 대상을 확인하세요. 문서 목록을 새로고침하면 이
            결과 화면을 닫고 현재 권한으로 다시 불러옵니다.
          </p>
          <ul>
            {results.map((r) => (
              <li key={r.id}>
                {r.status === "denied"
                  ? "선택 문서"
                  : (pages.find((p) => p.id === r.id)?.title ??
                    "선택 문서")}{" "}
                ·{" "}
                {r.status === "applied"
                  ? "적용됨"
                  : r.status === "needs-review"
                    ? "검토 필요"
                    : r.status === "pending"
                      ? "대기"
                      : r.status === "denied"
                        ? "변경 권한 없음"
                        : r.status === "stale"
                          ? "기준 변경 · 다시 미리보기"
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
            disabled={busy || !retryIds.length || (!!receipt && !terminal)}
            onClick={() => {
              change();
              setIds(retryIds);
            }}
          >
            실패 대상 다시 미리보기
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              const request = epoch.current;
              void onChanged().catch(() => {
                if (request === epoch.current)
                  setError(
                    "적용 결과는 유지됩니다. 문서 목록을 새로고침하지 못했습니다.",
                  );
              });
            }}
          >
            결과 확인 후 문서 목록 새로고침
          </Button>
        </section>
      )}
    </details>
  );
}
