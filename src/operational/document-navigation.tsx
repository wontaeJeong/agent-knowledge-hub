import { Backlinks } from "./convenience/Backlinks";
import { PersonalLibrary } from "./convenience/PersonalLibrary";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown, type AttachmentReader } from "../ui/Markdown";
import { Button } from "../ui/primitives";
import { documentHref, OperationalApi } from "./api";

type Item = { id: string; title: string; version: number };
type Neighborhood = {
  pageId: string;
  version: number;
  links: Item[];
  backlinks: Item[];
  related: Item[];
  truncated: Record<"links" | "backlinks" | "related", boolean>;
};
export function DocumentBody({ content, readAttachment }: { content: string; readAttachment?: AttachmentReader }) {
  const body = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<
    { id: string; title: string; level: number }[]
  >([]);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0),
    [position, setPosition] = useState(0);
  const jump = (target: HTMLElement) => {
    target.scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: true });
  };
  useEffect(() => {
    const element = body.current!;
    // Decorate the canonical safe renderer without replacing its event-bound DOM.
    for (const mark of element.querySelectorAll("mark[data-match]")) {
      const parent = mark.parentNode!;
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
      parent.normalize();
    }
    const headings = Array.from(
      element.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"),
    );
    setOutline(
      headings.map((heading, i) => {
        heading.id = `document-section-${i}`;
        heading.tabIndex = -1;
        return {
          id: heading.id,
          title: heading.textContent ?? "",
          level: Number(heading.tagName[1]),
        };
      }),
    );
    const needle = query.trim().toLocaleLowerCase();
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.parentElement?.closest("math,svg,[data-diagram],button,figure,[role=status],.markdown-help")) continue;
      nodes.push(node);
    }
    let matches = 0;
    if (needle)
      for (const node of nodes) {
        const text = node.textContent ?? "",
          lower = text.toLocaleLowerCase();
        let start = 0,
          index = lower.indexOf(needle);
        if (index < 0) continue;
        const fragment = document.createDocumentFragment();
        while (index >= 0) {
          fragment.append(text.slice(start, index));
          const mark = document.createElement("mark");
          mark.textContent = text.slice(index, index + needle.length);
          mark.tabIndex = -1;
          mark.dataset.match = String(matches++);
          fragment.append(mark);
          start = index + needle.length;
          index = lower.indexOf(needle, start);
        }
        fragment.append(text.slice(start));
        node.replaceWith(fragment);
      }
    setCount(matches);
    setPosition(0);
  }, [content, query]);
  useEffect(() => {
    body.current
      ?.querySelectorAll<HTMLElement>("mark[data-match]")
      .forEach((mark, i) => {
        if (i === position) mark.setAttribute("aria-current", "true");
        else mark.removeAttribute("aria-current");
      });
  }, [count, position, query]);
  const move = (step: number) => {
    const next = (position + step + count) % count;
    setPosition(next);
    const target = body.current?.querySelector<HTMLElement>(
      `mark[data-match="${next}"]`,
    );
    if (target) jump(target);
  };
  return (
    <section className="op-document-reader" aria-label="문서 읽기">
      <nav aria-label="문서 목차">
        <h4>목차</h4>
        {outline.length ? (
          <ol>
            {outline.map((item) => (
              <li
                key={item.id}
                style={{ marginInlineStart: `${(item.level - 1) * 0.65}rem` }}
              >
                <Button
                  onClick={() => {
                    const target = body.current?.querySelector<HTMLElement>(
                      `#${item.id}`,
                    );
                    if (target) jump(target);
                  }}
                >
                  {item.title}
                </Button>
              </li>
            ))}
          </ol>
        ) : (
          <p>제목 없음</p>
        )}
      </nav>
      <div className="op-actions">
        <label>
          문서 내 검색
          <input
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span role="status">
          {count ? `${position + 1} / ${count}` : "일치 0건"}
        </span>
        <Button disabled={!count} onClick={() => move(-1)}>
          이전 일치
        </Button>
        <Button disabled={!count} onClick={() => move(1)}>
          다음 일치
        </Button>
        <Button disabled={!count} onClick={() => move(0)}>
          현재 위치로 이동
        </Button>
      </div>
      <div ref={body}><Markdown text={content} readAttachment={readAttachment} /></div>
    </section>
  );
}
function Documents({ items, spaceId }: { items: Item[]; spaceId: string }) {
  return items.length ? (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <a href={documentHref(spaceId, item.id)}>{item.title}</a> · v
          {item.version}
        </li>
      ))}
    </ul>
  ) : (
    <p>표시할 문서 없음</p>
  );
}
export function PersonalDocuments({
  api,
  spaceId,
  principalId = "",
  refreshKey,
  onError,
}: {
  api: OperationalApi;
  spaceId: string;
  principalId?: string;
  refreshKey: string;
  onError: (error: unknown) => void;
}) {
  return (
    <section aria-label="개인 문서 목록">
      <h3>내 문서</h3>
      <div className="op-personal-documents">
        {(["favorites", "recent", "subscriptions"] as const).map((kind) => (
          <PersonalLibrary
            key={kind}
            kind={kind}
            api={api}
            spaceId={spaceId}
            principalId={principalId}
            refreshKey={refreshKey}
            onError={onError}
            compact
          />
        ))}
      </div>
    </section>
  );
}
export function RelatedDocuments({
  api,
  spaceId,
  pageId,
  version,
  onError,
}: {
  api: OperationalApi;
  spaceId: string;
  pageId: string;
  version: number;
  onError: (error: unknown) => void;
}) {
  const sequence = useRef(0);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Neighborhood | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      const request = ++sequence.current;
      setData(null);
      setError("");
      try {
        const result = await api.get<Neighborhood>(
          `/workflows/pages/${encodeURIComponent(pageId)}/navigation`,
        );
        if (active && request === sequence.current) {
          if (result.version !== version) {
            setError("발행본이 변경되었습니다. 문서를 다시 여세요.");
            return;
          }
          setData(result);
        }
      } catch (cause) {
        if (active && request === sequence.current) {
          setError("주변 문서를 불러오지 못했습니다.");
          onError(cause);
        }
      }
    };
    if (open) void load();
    const focus = () => {
      if (open) void load();
    };
    window.addEventListener("focus", focus);
    const timer = setInterval(focus, 60000);
    return () => {
      active = false;
      sequence.current++;
      window.removeEventListener("focus", focus);
      clearInterval(timer);
    };
  }, [api, spaceId, pageId, version, open, onError]);
  return (
    <details
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
        if (!e.currentTarget.open) setData(null);
      }}
    >
      <summary>연결·백링크·관련 문서</summary>
      <p>연결한 문서·같은 태그 각 최대 20건 · 백링크는 25건씩 표시</p>
      {open && <Backlinks api={api} spaceId={spaceId} pageId={pageId} version={version} onError={onError}/>}
      {error ? (
        <p role="alert">{error}</p>
      ) : data ? (
        (
          [
            ["links", "연결한 문서"],
            ["related", "같은 태그의 문서"],
          ] as const
        ).map(([key, label]) => (
          <section key={key}>
            <h4>{label}</h4>
            <Documents items={data[key]} spaceId={spaceId} />
            {data.truncated[key] && (
              <p>처음 20건만 표시합니다. 문서 검색으로 범위를 좁히세요.</p>
            )}
          </section>
        ))
      ) : open ? (
        <p role="status">현재 접근 권한을 확인하는 중입니다.</p>
      ) : null}
    </details>
  );
}
export function LinkCompletion({
  api,
  spaceId,
  onInsert,
  onError,
  query: externalQuery,
}: {
  api: OperationalApi;
  spaceId: string;
  query?: string;
  onInsert: (markdown: string, target: { id: string; version: number }) => void;
  onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState(externalQuery ?? ""),
    [items, setItems] = useState<Item[]>([]),
    [busy, setBusy] = useState(false),
    [searched, setSearched] = useState(false);
  const request = useRef(0);
  const currentInsert = useRef(onInsert);
  useLayoutEffect(() => {
    currentInsert.current = onInsert;
  }, [onInsert]);
  useEffect(() => {
    const clear = () => {
      request.current++;
      setItems([]);
      setBusy(false);
      setSearched(false);
    };
    window.addEventListener("focus", clear);
    return () => {
      request.current++;
      window.removeEventListener("focus", clear);
    };
  }, [api, spaceId]);
  useEffect(()=>{if(externalQuery!==undefined){request.current++;setItems([]);setSearched(false);setQuery(externalQuery);}},[externalQuery]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = () => {
    const sequence = ++request.current;
    setItems([]);
    setBusy(true);
    setSearched(false);
    void api
      .post<{ items: Item[] }>("/workflows/links/search", { query, limit:10 })
      .then((result) => {
        if (sequence === request.current) {
          setItems(result.items);
          setSearched(true);
        }
      })
      .catch((error) => {
        if (sequence === request.current) {
          setItems([]);
          onError(error);
        }
      })
      .finally(() => {
        if (sequence === request.current) setBusy(false);
      });
  };
  useEffect(() => {
    if (!query.trim()) return;
    searchTimer.current = setTimeout(search, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // A query change starts a fresh bounded server request; manual submit cancels this timer.
  }, [api, spaceId, query]);
  return (
    <section aria-label="내부 링크 삽입" onKeyDown={e=>{if(!["ArrowDown","ArrowUp"].includes(e.key)||e.nativeEvent.isComposing)return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-link-choice]"));const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;e.preventDefault();buttons[(index+(e.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();}}>
      {externalQuery === undefined && <form
        onSubmit={(e) => {
          e.preventDefault();
          if (searchTimer.current) clearTimeout(searchTimer.current);
          search();
        }}
      >
        <label>
          내부 문서 검색
          <input
            value={query}
            maxLength={200}
            onChange={(e) => {
              request.current++;
              setQuery(e.target.value);
              setItems([]);
              setSearched(false);
              setBusy(false);
            }}
          />
        </label>
        <Button type="submit" disabled={busy || !query.trim()}>
          링크 후보 검색
        </Button>
      </form>}
      {items.length ? (
        <ul role="listbox" aria-label="링크 후보">
          {items.map((item) => (
            <li key={item.id} role="option" aria-selected="false">
              <span>{item.id} · </span>
              <Button
                data-link-choice="true"
                disabled={busy}
                onClick={() => {
                  const sequence = ++request.current;
                  setItems([]);
                  setBusy(true);
                  setSearched(false);
                  void api
                    .post<{ items: Item[] }>("/workflows/links/search", {
                      query: item.id,
                    })
                    .then((result) => {
                      if (sequence !== request.current) return;
                      const current = result.items.find(
                        (candidate) => candidate.id === item.id,
                      );
                      if (!current)
                        throw Error(
                          "문서를 찾을 수 없거나 현재 접근할 수 없습니다.",
                        );
                      const title = current.title.replace(/[\\[\]]/g, "\\$&");
                      currentInsert.current(
                        `[${title}](${documentHref(spaceId, current.id)})`,
                        { id: current.id, version: current.version },
                      );
                    })
                    .catch((error) => {
                      if (sequence === request.current) onError(error);
                    })
                    .finally(() => {
                      if (sequence === request.current) setBusy(false);
                    });
                }}
              >
                {item.title} · 링크 삽입
              </Button>
            </li>
          ))}
        </ul>
      ) : searched ? (
        <p>현재 접근 가능한 일치 문서 없음</p>
      ) : null}
    </section>
  );
}
