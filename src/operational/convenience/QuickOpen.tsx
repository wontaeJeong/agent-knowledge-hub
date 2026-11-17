import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import type { OperationalApi } from "../api";
import {
  normalizeSearchFilters,
  useDocumentSearch,
  type SearchItem,
} from "./search-client";
import { MatchedText, SearchDescription } from "./SearchResults";
import { usePersonalKey } from "./personal-client";
import "./search.css";
type Props = {
  api: OperationalApi;
  onOpen: (item: SearchItem) => boolean | void;
  onClose: () => void;
  onSearch?: (query: string) => boolean | void;
};
export function QuickOpen(props: Props) {
  const key = usePersonalKey(props.api, "");
  return <QuickOpenSession key={key} {...props} />;
}
function QuickOpenSession({ api, onOpen, onClose, onSearch }: Props) {
  const [query, setQuery] = useState(""),
    [composing, setComposing] = useState(false),
    [active, setActive] = useState(-1);
  const panel = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    id = useId();
  const search = useDocumentSearch(
    api,
    normalizeSearchFilters({ query, sort: "title", limit: 10 }),
    composing,
    true,
  );
  const items = search.page?.items ?? [];
  useEffect(() => {
    input.current?.focus();
  }, []);
  useLayoutEffect(() => {
    setActive(-1);
  }, [search.page]);
  useEffect(() => {
    if (active >= 0)
      panel.current
        ?.querySelectorAll<HTMLElement>('[role="option"]')
        [active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const open = (item: SearchItem) => {
    if (onOpen(item) !== false) onClose();
  };
  return (
    <div className="search-overlay">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="문서 빠른 열기"
        className="quick-open"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing || e.keyCode === 229)
            return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const controls = Array.from(
              panel.current!.querySelectorAll<HTMLElement>(
                'input,button,a[href],[tabindex="0"]',
              ),
            ).filter((el) => !el.hasAttribute("disabled"));
            const first = controls[0],
              last = controls.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2>문서 빠른 열기</h2>
        <label htmlFor={id}>제목·본문 키워드</label>
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={
            items[active] ? `${id}-option-${active}` : undefined
          }
          value={query}
          maxLength={2000}
          onCompositionStart={() => {
            search.invalidate();
            setComposing(true);
            setActive(-1);
          }}
          onCompositionEnd={(e) => {
            setQuery(e.currentTarget.value);
            setComposing(false);
          }}
          onChange={(e) => {
            search.invalidate();
            setQuery(e.target.value);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || composing || e.keyCode === 229)
              return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (items.length)
                setActive((n) =>
                  e.key === "ArrowDown"
                    ? (n + 1) % items.length
                    : (n <= 0 ? items.length : n) - 1,
                );
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              open(items[active]);
            }
          }}
        />
        <p>제목 우선 최대 10건 · 현재 발행본 · Ctrl/Cmd+K</p>
        {search.error && <p role="alert">{search.error}</p>}
        <p role="status">
          {composing
            ? "입력 조합 중"
            : search.busy
              ? "검색 중…"
              : search.page
                ? `${items.length}건 표시${search.page.nextCursor ? " · 추가 결과는 상세 검색에서 확인하세요." : ""}`
                : query
                  ? "입력 완료 후 검색합니다."
                  : "키워드를 입력하세요."}
        </p>
        <ul id={`${id}-list`} role="listbox" aria-label="검색 문서">
          {items.map((item, n) => (
            <li
              id={`${id}-option-${n}`}
              key={`${item.pageId}:${item.version}`}
              role="option"
              aria-selected={active === n}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => open(item)}
              className={active === n ? "is-active" : ""}
            >
              <strong>
                <MatchedText
                  text={item.title ?? "제목 정보 없음"}
                  query={query.trim()}
                />
              </strong>
              <SearchDescription item={item} query={query.trim()} />
            </li>
          ))}
        </ul>
        <div className="search-actions">
          {onSearch && (
            <button
              type="button"
              disabled={composing}
              onClick={() => {
                if (onSearch(query.trim()) !== false) onClose();
              }}
            >
              상세 검색
            </button>
          )}
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
export function GlobalSearch({
  api,
  identityKey,
  onOpen,
  onSearch,
}: {
  api: OperationalApi;
  identityKey: string;
  onOpen: Props["onOpen"];
  onSearch: (query: string) => boolean | void;
}) {
  const [opened, setOpened] = useState<number | null>(null),
    trigger = useRef<HTMLButtonElement>(null),
    returnTo = useRef<HTMLElement | null>(null),
    container = useRef<HTMLDivElement>(null);
  const bound = usePersonalKey(api, identityKey),
    mounted = useRef(bound);
  mounted.current = bound;
  const open = opened === bound;
  const show = () => {
    returnTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : trigger.current;
    setOpened(bound);
  };
  const close = (restore = true) => {
    const inside = container.current?.contains(document.activeElement);
    setOpened(null);
    if (restore && inside) {
      const expected = bound;
      queueMicrotask(() => {
        if (
          mounted.current === expected &&
          returnTo.current?.isConnected &&
          (document.activeElement === document.body ||
            container.current?.contains(document.activeElement))
        )
          returnTo.current.focus({ preventScroll: true });
      });
    }
  };
  useEffect(() => {
    setOpened(null);
    returnTo.current = null;
  }, [bound]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        e.altKey ||
        e.shiftKey ||
        !(e.ctrlKey || e.metaKey) ||
        e.key.toLowerCase() !== "k"
      )
        return;
      const target = e.target instanceof Element ? e.target : null;
      if (
        target?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="dialog"],[role="alertdialog"],dialog[open]',
        )
      )
        return;
      e.preventDefault();
      show();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [bound]);
  return (
    <div ref={container} className="global-search">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
      >
        검색 <kbd>⌘/Ctrl K</kbd>
      </button>
      {open && (
        <QuickOpen
          api={api}
          onClose={() => close()}
          onOpen={(item) => {
            const accepted = onOpen(item);
            if (accepted !== false) close(false);
            return false;
          }}
          onSearch={(query) => {
            const accepted = onSearch(query);
            if (accepted !== false) close(false);
            return false;
          }}
        />
      )}
    </div>
  );
}
