import { useEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "../api";
import {
  normalizeSearchFilters,
  type SearchFilters,
} from "../../domain/search-filters";
export { normalizeSearchFilters, type SearchFilters };
export type SearchItem = {
  pageId: string;
  version: number;
  versionId: string;
  at: string;
  title: string | null;
  content: string;
  historical: boolean;
  currentRecommendation: boolean;
  isCurrentVersion?: boolean;
  metadataStatus: "known" | "unknown";
  metadata: {
    type?: string;
    environment?: string;
    reviewDate?: string | null;
  } | null;
  unknownMetadataKeys: string[];
  href: string;
};
export type SearchPage = {
  items: SearchItem[];
  nextCursor: string | null;
  asof: string;
};
export function searchDocuments(
  api: OperationalApi,
  filters: unknown,
  options: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<SearchPage> {
  return api.post(
    "/questions/search",
    normalizeSearchFilters({
      ...normalizeSearchFilters(filters),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    }),
    undefined,
    options.signal,
  );
}
/** UI calendar values use this device's local time; the server contract stays ISO UTC. */
export function searchDateToIso(value: string): string | undefined {
  if (!value) return undefined;
  if (value.endsWith("Z"))
    return normalizeSearchFilters({ periodFrom: value }).periodFrom;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (!match) throw Error("날짜와 시각을 확인하세요.");
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((v) => Number(v ?? 0));
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, millisecond);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  )
    throw Error("날짜와 시각을 확인하세요.");
  return date.toISOString();
}
export function searchDateToLocal(value: string): string {
  const iso = searchDateToIso(value);
  if (!iso) return "";
  const date = new Date(iso),
    pad = (n: number) => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() || date.getMilliseconds() ? `:${pad(date.getSeconds())}${date.getMilliseconds() ? "." + String(date.getMilliseconds()).padStart(3, "0") : ""}` : ""}`;
}
export const searchFailure = (e: unknown) =>
  e instanceof ApiError && ["STALE_CURSOR", "STALE_VERSION"].includes(e.code)
    ? "검색 기준이나 권한이 변경되었습니다. 처음부터 다시 검색하세요."
    : e instanceof Error
      ? e.message
      : "검색을 불러오지 못했습니다.";
/** Bound to the actual API instance and filter signature, including before effects run. */
export function useDocumentSearch(
  api: OperationalApi,
  filters: SearchFilters,
  composing: boolean,
  quick = false,
  verification?: { epoch: number; onFailure: (e: unknown) => void },
) {
  const signature = JSON.stringify([filters, verification?.epoch]);
  const [inputRevision, setInputRevision] = useState(0);
  const [result, setResult] = useState<{
    api: OperationalApi;
    signature: string;
    page: SearchPage | null;
    error: string;
    busy: boolean;
  } | null>(null);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const current = useRef({ api, signature });
  current.current = { api, signature };
  const invalidate = (restartDebounce = true) => {
    generation.current++;
    controller.current?.abort();
    setResult(null);
    // Raw edits can keep the same canonical scope after trimming or tag parsing.
    if (restartDebounce) setInputRevision((revision) => revision + 1);
  };
  async function run(cursor?: string | null) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const request = ++generation.current,
      bound = { api, signature };
    setResult({ ...bound, page: null, error: "", busy: true });
    try {
      const page = await searchDocuments(api, filters, {
        limit: quick ? 10 : filters.limit,
        cursor,
        signal: abort.signal,
      });
      if (
        !abort.signal.aborted &&
        request === generation.current &&
        current.current.api === api &&
        current.current.signature === signature
      )
        setResult({ ...bound, page, error: "", busy: false });
    } catch (e) {
      if (
        !abort.signal.aborted &&
        request === generation.current &&
        current.current.api === api &&
        current.current.signature === signature
      ) {
        verification?.onFailure(e);
        setResult({
          ...bound,
          page: null,
          error: searchFailure(e),
          busy: false,
        });
      }
    }
  }
  useEffect(() => {
    controller.current?.abort();
    generation.current++;
    if (composing || (quick && !filters.query)) return;
    const timer = setTimeout(() => void run(), 200);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
      generation.current++;
    };
    // The normalized signature is the complete search binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, signature, composing, quick, inputRevision]);
  useEffect(() => {
    if (verification) return; // The saved view first revalidates its definition.
    const refresh = () => {
      invalidate(false); // This refresh supplies its own immediate request.
      if (!composing && (!quick || filters.query)) void run();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  });
  const visible =
    result?.api === api && result.signature === signature && !composing
      ? result
      : null;
  return {
    page: visible?.page ?? null,
    error: visible?.error ?? "",
    busy: visible?.busy ?? false,
    run,
    invalidate,
  };
}
