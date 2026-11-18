import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { OperationalApi } from "../api";
import { usePersonalKey, personalFailure } from "./personal-client";
import { SearchPage } from "./SearchPage";
import {
  normalizeSearchFilters,
  type SearchFilters,
  type SearchItem,
} from "./search-client";
import { convenienceHref } from "./route";
import { useCurrentListFocus } from "./list-focus";

interface View {
  id: string;
  ownerId: string;
  workspaceId: string;
  name: string;
  filters: SearchFilters;
  sort: SearchFilters["sort"];
  revision: number;
}
export type SavedViewsProps = {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  viewId?: string;
  onOpen: (item: SearchItem) => boolean | void;
  onView: (id?: string) => void;
};
const root = "/convenience/views";
export const viewHref = (spaceId: string, view?: string) =>
  convenienceHref({ kind: "section", section: "saved-views", spaceId, view });

// Bind retries to the exact draft and reuse the key only while the outcome is unknown.
function useViewMutation(api: OperationalApi) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false),
    locked = useRef(false),
    retry = useRef<{ key: string; id: string } | null>(null);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function submit(
    path: string,
    method: string,
    body: Record<string, unknown>,
    done: (id: string) => void,
  ) {
    if (locked.current) return;
    const key = JSON.stringify([path, method, body]);
    if (retry.current?.key !== key)
      retry.current = { key, id: crypto.randomUUID() };
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ id: string }>(
        path,
        method,
        { ...body, mutationId: retry.current.id },
        retry.current.id,
      );
      if (active.current) {
        retry.current = null;
        done(result.id);
      }
    } catch (e) {
      if (active.current) setError(personalFailure(e));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return { busy, error, submit };
}

export function SaveViewForm({
  api,
  filters,
  disabled,
  view,
  onSaved,
}: {
  api: OperationalApi;
  filters: SearchFilters;
  disabled: boolean;
  view?: View;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(view?.name ?? "");
  const mutation = useViewMutation(api);
  return (
    <form
      className="saved-view-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !name.trim() || Array.from(name.trim()).length > 100)
          return;
        void mutation.submit(
          view ? root + "/" + view.id : root,
          view ? "PATCH" : "POST",
          {
            name: name.trim(),
            filters,
            sort: filters.sort,
            expectedRevision: view?.revision ?? 0,
          },
          onSaved,
        );
      }}
    >
      <label>
        보기 이름
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <button
        disabled={
          disabled ||
          mutation.busy ||
          !name.trim() ||
          Array.from(name.trim()).length > 100
        }
      >
        {view ? "보기 변경 저장" : "개인 보기 저장"}
      </button>
      {Array.from(name.trim()).length > 100 && (
        <span role="alert">이름은 100자까지 입력할 수 있습니다.</span>
      )}
      {mutation.error && <span role="alert">{mutation.error}</span>}
    </form>
  );
}
export function SavedViews(props: SavedViewsProps) {
  const generation = usePersonalKey(
    props.api,
    JSON.stringify([props.spaceId, props.principalId, props.viewId]),
  );
  return <ViewsSession key={generation} {...props} />;
}
function ViewsSession({
  api,
  spaceId,
  principalId,
  viewId,
  onOpen,
  onView,
}: SavedViewsProps) {
  const [rows, setRows] = useState<View[] | null>(null),
    [error, setError] = useState(""),
    [example, setExample] = useState<SearchFilters | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const sequence = useRef(0),
    mutation = useViewMutation(api);
  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    setError("");
    setRows(null);
    setConfirmId(null);
    try {
      const data = viewId
        ? [await api.get<View>(root + "/" + viewId)]
        : (await api.get<{ items: View[] }>(root)).items;
      if (seq === sequence.current) setRows(data);
    } catch (e) {
      if (seq === sequence.current) setError(personalFailure(e));
    }
  }, [api, viewId]);
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);
  const focus = useCurrentListFocus<HTMLElement>({
    rowSelector: "[data-view-row]",
    fallbackSelector: "[data-view-fallback]",
    message: "보기 목록이 변경되었습니다.",
  });
  const link = (id?: string) => ({
    href: viewHref(spaceId, id),
    onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (
        event.button ||
        event.metaKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      onView(id);
    },
  });
  const selected = viewId ? rows?.[0] : undefined;
  return (
    <section
      className="op-panel saved-views"
      aria-label="개인 저장 보기"
      ref={focus.container}
      onFocusCapture={focus.onFocusCapture}
    >
      <h2 data-view-fallback tabIndex={-1}>
        {viewId ? (selected?.name ?? "저장 보기") : "내 저장 보기"}
      </h2>
      {viewId && <a {...link()}>목록으로</a>}
      {error && <p role="alert">{error}</p>}
      {!rows && !error && <p role="status">불러오는 중…</p>}
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={mutation.busy}
      >
        다시 불러오기
      </button>
      {mutation.error && <p role="alert">{mutation.error}</p>}
      <span role="status">{focus.notice}</span>
      {rows && !viewId && (
        <>
          {!rows.length && (
            <p>
              저장한 보기가 없습니다. 검색 화면에서 조건에 이름을 붙여
              저장하세요.
            </p>
          )}
          <ul className="saved-view-list">
            {rows.map((view, index) => (
              <li key={view.id} data-view-row>
                <a {...link(view.id)}>{view.name}</a>
                <div>
                  {(["up", "down"] as const).map((direction) => {
                    const neighbor =
                      rows[index + (direction === "up" ? -1 : 1)];
                    const label = direction === "up" ? "위로" : "아래로";
                    return (
                      <button
                        key={direction}
                        disabled={!neighbor || mutation.busy}
                        aria-label={view.name + " " + label}
                        onClick={() =>
                          void mutation.submit(
                            root + "/" + view.id,
                            "PATCH",
                            {
                              direction,
                              neighborId: neighbor.id,
                              neighborRevision: neighbor.revision,
                              expectedRevision: view.revision,
                            },
                            () => void refresh(),
                          )
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                  {confirmId === view.id ? (
                    <>
                      <button
                        disabled={mutation.busy}
                        onClick={() =>
                          void mutation.submit(
                            root + "/" + view.id,
                            "DELETE",
                            { expectedRevision: view.revision },
                            () => void refresh(),
                          )
                        }
                      >
                        삭제 확인
                      </button>
                      <button onClick={() => setConfirmId(null)}>취소</button>
                    </>
                  ) : (
                    <button
                      disabled={mutation.busy}
                      aria-label={view.name + " 삭제"}
                      onClick={() => setConfirmId(view.id)}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <h3>예시 보기</h3>
          {["내 담당 문서", "최근 변경", "검토 기한 경과"].map(
            (label, index) => (
              <button
                type="button"
                key={label}
                onClick={() =>
                  setExample(
                    normalizeSearchFilters(
                      index === 0
                        ? { businessOwner: principalId }
                        : index === 2
                          ? { reviewDateTo: new Date().toISOString() }
                          : { sort: "recent" },
                    ),
                  )
                }
              >
                {label}
              </button>
            ),
          )}
        </>
      )}
      {(selected || (!viewId && example)) && (
        <SearchPage
          key={selected?.revision ?? JSON.stringify(example)}
          api={api}
          identityKey={spaceId + ":" + principalId}
          initialFilters={selected?.filters ?? example!}
          onOpen={onOpen}
          renderSave={(filters, disabled) => (
            <SaveViewForm
              api={api}
              filters={filters}
              disabled={disabled}
              view={selected}
              onSaved={(id) => (viewId ? void refresh() : onView(id))}
            />
          )}
        />
      )}
    </section>
  );
}
