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
  }>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    if (!initialTargetId) return;
    void api
      .get<{ items: T[] }>("/changesets")
      .then((response) => {
        if (!active) return;
        const selected = response.items.find(
          (item) =>
            item.id === initialTargetId &&
            item.status !== "rejected" &&
            item.status !== "withdrawn",
        );
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
  return children(result.items);
}
