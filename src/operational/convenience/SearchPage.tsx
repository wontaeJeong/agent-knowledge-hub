import { useCurrentListFocus } from "./list-focus";
import { useState, type ReactNode } from "react";
import type { OperationalApi } from "../api";
import { usePersonalKey } from "./personal-client";
import {
  normalizeSearchFilters,
  searchDateToIso,
  searchDateToLocal,
  type SearchFilters,
  useDocumentSearch,
  type SearchItem,
} from "./search-client";
import { MatchedText, SearchDescription } from "./SearchResults";
import "./search.css";
const fields = [
  ["type", "문서 유형"],
  ["businessOwner", "업무 담당자"],
  ["tags", "태그 (쉼표 구분)"],
  ["state", "문서 상태"],
  ["project", "프로젝트"],
  ["environment", "환경"],
  ["periodFrom", "작성 기간 시작"],
  ["periodTo", "작성 기간 끝"],
  ["reviewDateFrom", "검토 예정일 시작"],
  ["reviewDateTo", "검토 예정일 끝"],
] as const;
export type SearchHandoff = {
  api: OperationalApi;
  identityKey: string;
  revision: number;
  query: string;
};
type ViewCheck = {
  checking: boolean;
  epoch: number;
  onDenied: (e: unknown) => void;
};
type SaveControls = (filters: SearchFilters, disabled: boolean) => ReactNode;
const dateKeys = new Set([
  "periodFrom",
  "periodTo",
  "reviewDateFrom",
  "reviewDateTo",
]);
export function SearchPage(props: {
  verification?: ViewCheck;
  initialFilters?: SearchFilters;
  renderSave?: SaveControls;
  api: OperationalApi;
  identityKey: string;
  handoff?: SearchHandoff;
  onOpen: (item: SearchItem) => boolean | void;
}) {
  const key = usePersonalKey(props.api, props.identityKey);
  const handoff =
    props.handoff?.api === props.api &&
    props.handoff.identityKey === props.identityKey
      ? props.handoff
      : undefined;
  return (
    <SearchSession
      key={`${key}:${handoff?.revision ?? "none"}`}
      api={props.api}
      onOpen={props.onOpen}
      initial={
        props.initialFilters ??
        normalizeSearchFilters({ query: handoff?.query ?? "" })
      }
      verification={props.verification}
      renderSave={props.renderSave}
    />
  );
}
function SearchSession({
  api,
  onOpen,
  initial,
  verification,
  renderSave,
}: {
  api: OperationalApi;
  onOpen: (item: SearchItem) => boolean | void;
  initial: SearchFilters;
  verification?: ViewCheck;
  renderSave?: SaveControls;
}) {
  const [query, setQuery] = useState(initial.query),
    [composing, setComposing] = useState(false),
    [raw, setRaw] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        fields.map(([key]) => {
          const value = initial[key];
          return [
            key,
            Array.isArray(value)
              ? value.join(", ")
              : dateKeys.has(key) && value
                ? searchDateToLocal(value)
                : (value ?? ""),
          ];
        }),
      ),
    ),
    [historical, setHistorical] = useState(initial.historical),
    [sort, setSort] = useState(initial.sort),
    [archived, setArchived] = useState(
      initial.archived === undefined ? "" : String(initial.archived),
    );
  const candidate = {
    query,
    historical,
    ...Object.fromEntries(
      Object.entries(raw).filter(
        ([key, value]) => key !== "tags" && value.trim(),
      ),
    ),
    tags:
      raw.tags === initial.tags.join(", ")
        ? initial.tags
        : (raw.tags
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean) ?? []),
    ...(archived ? { archived: archived === "true" } : {}),
    limit: initial.limit,
    sort,
  };
  let validation = "";
  let filters = normalizeSearchFilters({ query, historical, limit: 25 });
  try {
    filters = normalizeSearchFilters({
      ...candidate,
      ...Object.fromEntries(
        Object.entries(raw)
          .filter(([key, value]) => dateKeys.has(key) && value)
          .map(([key, value]) => {
            const original = initial[key as keyof SearchFilters];
            return [
              key,
              typeof original === "string" &&
              searchDateToLocal(original) === value
                ? original
                : searchDateToIso(value),
            ];
          }),
      ),
    });
  } catch {
    validation =
      "조건 형식이나 기간 순서를 확인하세요. 날짜와 시각은 이 기기의 현지 시각을 사용합니다.";
  }
  const [expanded, setExpanded] = useState(false);
  const search = useDocumentSearch(
    api,
    filters,
    composing || !!validation || !!verification?.checking,
    false,
    verification,
  );
  const focus = useCurrentListFocus<HTMLElement>({
    enabled: !verification?.checking,
    rowSelector: ".search-results li",
    fallbackSelector: "[data-search-fallback]",
    message: "검색 결과가 변경되어 현재 검색 입력으로 초점을 옮겼습니다.",
  });
  const change = (action: () => void) => {
    search.invalidate();
    action();
  };
  if (verification?.checking) return null;
  return (
    <section
      ref={focus.container}
      onFocusCapture={focus.onFocusCapture}
      className="op-panel search-page"
      aria-label="전역 키워드 검색"
    >
      <h2>전역 키워드 검색</h2>
      <p>
        현재 권한으로 읽을 수 있는 발행본을 검색합니다. 모델을 호출하거나 질문을
        저장하지 않습니다.
      </p>
      <form
        onCompositionStart={(event) => {
          if (
            event.target instanceof HTMLInputElement &&
            event.target.type === "text"
          )
            change(() => setComposing(true));
        }}
        onCompositionEnd={(event) => {
          const control = event.target;
          if (!(control instanceof HTMLInputElement) || control.type !== "text")
            return;
          const field = control.dataset.searchField;
          const value = control.value;
          change(() => {
            if (field === "query") setQuery(value);
            else if (field && fields.some(([key]) => key === field))
              setRaw((values) => ({ ...values, [field]: value }));
            setComposing(false);
          });
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!composing && !validation) void search.run();
        }}
      >
        <span role="status">{focus.notice}</span>
        <label>
          제목·본문 키워드
          <input
            data-search-fallback
            data-search-field="query"
            maxLength={2000}
            value={query}
            onChange={(e) => change(() => setQuery(e.target.value))}
          />
        </label>
        <details
          open={expanded}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary>유형·태그·담당자·환경·상태·기간 조건</summary>
          <p>
            기간은 이 기기의 현지 시각(
            {Intl.DateTimeFormat().resolvedOptions().timeZone})을 사용합니다.
          </p>
          <div className="search-filters">
            {fields.map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  data-search-field={key}
                  type={dateKeys.has(key) ? "datetime-local" : "text"}
                  step={dateKeys.has(key) ? "0.001" : undefined}
                  maxLength={key === "tags" ? 4000 : 200}
                  value={raw[key] ?? ""}
                  onChange={(e) =>
                    change(() =>
                      setRaw((s) => ({ ...s, [key]: e.target.value })),
                    )
                  }
                />
              </label>
            ))}
            <label>
              결과 정렬
              <select
                data-search-field="sort"
                value={sort}
                onChange={(e) =>
                  change(() => setSort(e.target.value as SearchFilters["sort"]))
                }
              >
                <option value="recent">최근 변경순</option>
                <option value="title">제목순</option>
              </select>
            </label>
            <label>
              보관 여부
              <select
                data-search-field="archived"
                value={archived}
                onChange={(e) => change(() => setArchived(e.target.value))}
              >
                <option value="">기본</option>
                <option value="true">보관됨</option>
                <option value="false">보관되지 않음</option>
              </select>
            </label>
          </div>
        </details>
        <label>
          <input
            type="checkbox"
            data-search-field="historical"
            checked={historical}
            onChange={(e) => change(() => setHistorical(e.target.checked))}
          />
          과거 버전 포함 (현재 권고 아님)
        </label>
        <button disabled={composing || !!validation || search.busy}>
          검색
        </button>
      </form>
      {renderSave?.(filters, composing || !!validation)}
      {(validation || search.error) && (
        <p role="alert">{validation || search.error}</p>
      )}
      <p role="status">
        {search.busy
          ? "검색 중…"
          : search.page
            ? `${search.page.items.length}건 표시${search.page.nextCursor ? " · 다음 결과 있음" : ""}`
            : composing
              ? "입력 조합 중"
              : "입력 완료 후 검색합니다."}
      </p>
      <ul className="search-results">
        {search.page?.items.map((item) => (
          <li key={`${item.pageId}:${item.version}`}>
            <button type="button" onClick={() => onOpen(item)}>
              <MatchedText
                text={item.title ?? "제목 정보 없음"}
                query={filters.query}
              />
            </button>
            <SearchDescription item={item} query={filters.query} />
          </li>
        ))}
      </ul>
      {search.page?.nextCursor && (
        <button
          type="button"
          onClick={() => void search.run(search.page!.nextCursor)}
        >
          다음 결과 {filters.limit}건
        </button>
      )}
      {search.error && (
        <button type="button" onClick={() => void search.run()}>
          처음부터 다시 검색
        </button>
      )}
    </section>
  );
}
