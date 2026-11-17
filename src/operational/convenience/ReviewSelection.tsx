import { useEffect, useState, type ReactNode } from "react";
import type { OperationalApi } from "../api";
/** /changesets is exhaustive and enforces current queue/source/page/lineage access. */
export function ReviewSelection<T extends { id: string; status?: string }>({
  api,
  initialTargetId,
  items,
  children,
}: {
  api: OperationalApi;
  initialTargetId?: string;
  items: T[];
  children: (items: T[]) => ReactNode;
}) {
  const [result, setResult] = useState<{
    id: string;
    items: T[];
    error?: string;
    outcome?: { status?: string; reviewFeedback?: { reason: string } };
  }>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    if (!initialTargetId) return;
    void api
      .get<{ items: T[] }>("/changesets")
      .catch(() => ({ items: [] as T[] }))
      .then(async (response) => {
        if (!active) return;
        const selected = response.items.find(
          (item) =>
            item.id === initialTargetId &&
            item.status !== "rejected" &&
            item.status !== "withdrawn",
        );
        if (!selected) {
          const exact = await api.get<
            T & { readOnly?: boolean; reviewFeedback?: { reason: string } }
          >(`/changesets/${encodeURIComponent(initialTargetId)}`);
          if (!active) return;
          if (exact.id !== initialTargetId || exact.status === "withdrawn")
            throw Error("NOT_FOUND");
          setResult({ id: initialTargetId, items: [], outcome: exact });
          return;
        }
        setResult({
          id: initialTargetId,
          items: selected ? [selected] : [],
          ...(!selected
            ? { error: "대상이 없거나 현재 접근할 수 없습니다." }
            : {}),
        });
      })
      .catch(() => {
        if (active)
          setResult({
            id: initialTargetId,
            items: [],
            error: "대상이 없거나 현재 접근할 수 없습니다.",
          });
      });
    return () => {
      active = false;
    };
  }, [api, initialTargetId, items]);
  if (!initialTargetId) return children(items);
  if (!result || result.id !== initialTargetId)
    return <p role="status">검토 대상을 확인하고 있습니다.</p>;
  if (result.error) return <p role="alert">{result.error}</p>;
  if (result.outcome)
    return (
      <section aria-label="선택한 검토 결과">
        <h2>검토 상태</h2>
        <p>
          {(
            {
              pending: "검토 대기",
              approved: "승인 · 발행 전",
              rejected: "반려 · 수정 요청",
              published: "발행",
            } as Record<string, string>
          )[result.outcome.status ?? ""] ?? "현재 상태 확인"}
        </p>
        {result.outcome.reviewFeedback && (
          <p>{result.outcome.reviewFeedback.reason}</p>
        )}
      </section>
    );
  return children(result.items);
}
