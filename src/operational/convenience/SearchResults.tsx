import { Fragment } from "react";
import type { SearchItem } from "./search-client";
export function MatchedText({
  text,
  query,
  snippet = false,
}: {
  text: string;
  query: string;
  snippet?: boolean;
}) {
  const at = query
    ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    : -1;
  const start = snippet ? Math.max(0, at - 70) : 0;
  const end = snippet ? Math.min(text.length, start + 240) : text.length;
  const value = text.slice(start, end),
    match = at - start;
  return (
    <>
      {start > 0 ? "…" : ""}
      {at >= start && at < end ? (
        <Fragment>
          {value.slice(0, match)}
          <mark>{value.slice(match, match + query.length)}</mark>
          {value.slice(match + query.length)}
        </Fragment>
      ) : (
        value
      )}
      {end < text.length ? "…" : ""}
    </>
  );
}
export function SearchDescription({
  item,
  query,
}: {
  item: SearchItem;
  query: string;
}) {
  return (
    <>
      <p className="search-metadata">
        {item.isCurrentVersion === false
          ? "과거 버전 · 현재 권고 아님"
          : item.isCurrentVersion === true
            ? item.currentRecommendation
              ? "현재 버전 · 현재 권고 대상"
              : "현재 버전 · 현재 권고 여부 확인 안 됨"
            : "버전 고정 조회 · 현재 여부 알 수 없음"}{" "}
        · v{item.version} · 유형: {item.metadata?.type ?? "알 수 없음"} · 환경:{" "}
        {item.metadata?.environment ?? "알 수 없음"} · 검토 예정일:{" "}
        {item.metadata?.reviewDate ?? "알 수 없음"}
      </p>
      <p className="search-snippet">
        <MatchedText text={item.content} query={query} snippet />
      </p>
    </>
  );
}
