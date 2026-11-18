import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ApiError, type Identity, type OperationalApi } from "../api";
import { usePersonalKey, personalFailure } from "./personal-client";
import {
  SearchPage,
  type SearchHandoff,
  type SearchComposition,
} from "./SearchPage";
import {
  normalizeSearchFilters,
  type SearchFilters,
  type SearchItem,
} from "./search-client";
import { NavigationProtection } from "./Navigation";
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
  searchEntry?: boolean;
  handoff?: SearchHandoff;
  onIdentityChanged?: () => void;
  onDiscardHandoff?: () => void;
  onOpen: (item: SearchItem) => boolean | void;
  onView: (id?: string) => void;
};
const root = "/convenience/views";
export const viewHref = (spaceId: string, view?: string) =>
  convenienceHref({ kind: "section", section: "saved-views", spaceId, view });

// Bind retries to the exact draft and reuse the key only while the outcome is unknown.
type RetryKey = { key: string; id: string };
function useViewMutation(
  api: OperationalApi,
  onFailure?: (e: unknown) => void,
  retained?: React.RefObject<RetryKey | null>,
  accessEpoch?: React.RefObject<number>,
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false),
    locked = useRef(false),
    localRetry = useRef<RetryKey | null>(null);
  const retry = retained ?? localRetry;
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
    const epoch = accessEpoch?.current;
    const isCurrent = () => active.current && epoch === accessEpoch?.current;
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
      if (isCurrent()) {
        retry.current = null;
        done(result.id);
      }
    } catch (e) {
      if (isCurrent()) {
        onFailure?.(e);
        setError(personalFailure(e));
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  const clearError = useCallback(() => setError(""), []);
  return { busy, error, submit, clearError };
}

type SaveFormProps = {
  composition?: SearchComposition;
  draftName?: React.RefObject<string | undefined>;
  filters: SearchFilters;
  disabled: boolean;
  view?: View;
  onSaved: (id: string) => void;
};
export function SaveViewForm({
  api,
  onFailure,
  retainedRetry,
  ...props
}: SaveFormProps & {
  api: OperationalApi;
  onFailure?: (e: unknown) => void;
  retainedRetry?: React.RefObject<RetryKey | null>;
}) {
  const mutation = useViewMutation(api, onFailure, retainedRetry);
  return <ViewForm {...props} mutation={mutation} />;
}
function ViewForm({
  filters,
  disabled,
  view,
  onSaved,
  composition,
  draftName,
  mutation,
}: SaveFormProps & { mutation: ReturnType<typeof useViewMutation> }) {
  const [name, setName] = useState(draftName?.current ?? view?.name ?? "");
  const [composingName, setComposingName] = useState(false);
  const updateName = (value: string) => {
    if (mutation.busy) return;
    if (draftName) draftName.current = value;
    setName(value);
  };

  return (
    <form
      className="saved-view-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          disabled ||
          composingName ||
          !name.trim() ||
          Array.from(name.trim()).length > 100
        )
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
          disabled={mutation.busy}
          value={name}
          data-search-field="view-name"
          onChange={(event) => updateName(event.target.value)}
          onCompositionStart={(event) => {
            if (mutation.busy) return;
            setComposingName(true);
            composition?.start(event.currentTarget, (value) => {
              updateName(value);
              setComposingName(false);
            });
          }}
          onCompositionEnd={(event) => {
            if (composition) composition.end();
            else {
              updateName(event.currentTarget.value);
              setComposingName(false);
            }
          }}
          required
        />
      </label>
      <button
        disabled={
          disabled ||
          composingName ||
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
  // Erasing sensitive handoff data does not start another search. Only an
  // explicitly delivered search revision should replace this session.
  const deliveredRevision = useRef<number | undefined>(undefined);
  if (
    props.handoff &&
    props.handoff.api === props.api &&
    props.handoff.identityKey === props.spaceId + ":" + props.principalId
  )
    deliveredRevision.current = props.handoff.revision;
  const generation = usePersonalKey(
    props.api,
    JSON.stringify([
      props.spaceId,
      props.principalId,
      props.viewId,
      props.searchEntry,
      deliveredRevision.current,
    ]),
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
  onIdentityChanged,
  onDiscardHandoff,
  searchEntry,
  handoff,
}: SavedViewsProps) {
  const [rows, setRows] = useState<View[] | null>(null),
    [error, setError] = useState(""),
    [example, setExample] = useState<SearchFilters | null>(null),
    [confirmId, setConfirmId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true),
    [epoch, setEpoch] = useState(0),
    [conflict, setConflict] = useState(false);
  const sequence = useRef(0),
    accessEpoch = useRef(0),
    pristineEditor = useRef<string | null>(null),
    savedNavigation = useRef(false),
    entryHandoff = useRef(handoff),
    base = useRef<View | null>(null),
    draftName = useRef<string | undefined>(undefined),
    retainedRetry = useRef<RetryKey | null>(null),
    dirty = useRef(false),
    denied = useRef(false),
    pendingComposition = useRef<(() => boolean) | null>(null),
    focusRestore = useRef<{
      key: string;
      start: number | null;
      end: number | null;
      direction: "forward" | "backward" | "none" | null;
    } | null>(null);
  const focus = useCurrentListFocus<HTMLElement>({
    enabled: !searchEntry && !viewId && !example,
    rowSelector: "[data-view-row]",
    fallbackSelector: "[data-view-fallback]",
    message: "보기 목록이 변경되었습니다.",
  });
  const mismatch = useRef(onIdentityChanged);
  mismatch.current = onIdentityChanged;
  const clearHandoff = useRef(onDiscardHandoff);
  clearHandoff.current = onDiscardHandoff;
  const discard = useCallback((e: unknown) => {
    sequence.current++;
    denied.current = true;
    accessEpoch.current++;
    pristineEditor.current = null;
    pendingComposition.current = null;
    base.current = null;
    entryHandoff.current = undefined;
    clearHandoff.current?.();
    draftName.current = undefined;
    retainedRetry.current = null;
    dirty.current = false;
    focusRestore.current = null;
    setEpoch((n) => n + 1);
    setRows(null);
    setExample(null);
    setConflict(false);
    setChecking(false);
    setConfirmId(null);
    setError(personalFailure(e));
  }, []);
  const editorSignature = useCallback(() => {
    const inputs = focus.container.current?.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("[data-search-field]");
    if (!inputs?.length) return null;
    return JSON.stringify(
      Array.from(inputs, (control) => [
        control.dataset.searchField,
        control instanceof HTMLInputElement && control.type === "checkbox"
          ? control.checked
          : control.value,
      ]),
    );
  }, [focus.container]);
  const hasUnsaved = useCallback(() => {
    if (denied.current || savedNavigation.current) return false;
    if (!viewId) {
      const name = focus.container.current?.querySelector<HTMLInputElement>(
        '[data-search-field="view-name"]',
      );
      return !!(name?.value ?? draftName.current)?.trim();
    }
    const current = editorSignature();
    return current !== null && pristineEditor.current !== null
      ? current !== pristineEditor.current
      : dirty.current;
  }, [viewId, focus.container, editorSignature]);
  const suspend = useCallback(() => {
    // Read the native IME buffer before detaching either form and before a
    // fast server response can replace its base revision.
    dirty.current = hasUnsaved();
    pendingComposition.current?.();
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      focus.container.current?.contains(active) &&
      !active.hasAttribute("data-view-retry")
    ) {
      const key = active.dataset.searchField;
      focusRestore.current = key
        ? {
            key,
            start:
              active instanceof HTMLInputElement ? active.selectionStart : null,
            end:
              active instanceof HTMLInputElement ? active.selectionEnd : null,
            direction:
              active instanceof HTMLInputElement
                ? active.selectionDirection
                : null,
          }
        : null;
    }
    setChecking(true);
    setEpoch((n) => n + 1);
    setError("");
    setConfirmId(null);
    return ++sequence.current;
  }, [focus.container, hasUnsaved]);
  const onVerificationError = useCallback(
    (e: unknown) => {
      if (
        e instanceof ApiError &&
        ([401, 403, 404].includes(e.status) || e.code === "SESSION_CHANGED")
      ) {
        discard(e);
      } else if (
        !(e instanceof ApiError) ||
        e.status >= 500 ||
        [408, 429].includes(e.status)
      ) {
        suspend();
        setError(personalFailure(e));
      }
    },
    [discard, suspend],
  );
  const mutation = useViewMutation(
    api,
    onVerificationError,
    retainedRetry,
    accessEpoch,
  );
  const clearMutationError = mutation.clearError;
  const refresh = useCallback(
    async (replace = false) => {
      denied.current = false;
      const seq = suspend();
      try {
        let data: View[];
        if (searchEntry) {
          const identity = await api.get<Identity>("/me");
          if (seq !== sequence.current) return;
          if (
            identity.principalId !== principalId ||
            identity.workspaceId !== spaceId
          ) {
            discard(new Error("사용자 또는 공간이 변경되었습니다."));
            mismatch.current?.();
            return;
          }
          if (
            identity.capabilities &&
            !identity.capabilities.includes("knowledge.read")
          )
            throw new ApiError("검색 권한이 없습니다.", 403, "FORBIDDEN");
          data = [];
        } else
          data = viewId
            ? [await api.get<View>(root + "/" + viewId)]
            : (await api.get<{ items: View[] }>(root)).items;
        if (seq !== sequence.current) return;
        if (
          data.some(
            (view) =>
              view.ownerId !== principalId ||
              view.workspaceId !== spaceId ||
              (viewId && view.id !== viewId),
          )
        ) {
          discard(new Error("사용자 또는 공간이 변경되었습니다."));
          mismatch.current?.();
          return;
        }
        if (viewId && data[0]?.revision !== base.current?.revision) {
          if (base.current && dirty.current && !replace) setConflict(true);
          else {
            base.current = data[0];
            pristineEditor.current = null;
            draftName.current = undefined;
            retainedRetry.current = null;
            dirty.current = false;
            setConflict(false);
          }
        }
        clearMutationError();
        setRows(data);
        setChecking(false);
      } catch (e) {
        if (seq !== sequence.current) return;
        setError(personalFailure(e));
        onVerificationError(e);
      }
    },
    [
      api,
      principalId,
      spaceId,
      viewId,
      searchEntry,
      discard,
      suspend,
      onVerificationError,
      clearMutationError,
    ],
  );
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      if (!denied.current && document.visibilityState !== "hidden")
        void refresh();
    };
    const onVisibility = () => {
      if (denied.current) return;
      if (document.visibilityState === "hidden") suspend();
      else void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      sequence.current++;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, suspend]);
  useLayoutEffect(() => {
    if (checking || !rows || !focusRestore.current) return;
    const { key, start, end, direction } = focusRestore.current;
    focusRestore.current = null;
    if (
      document.activeElement !== document.body &&
      !document.activeElement?.hasAttribute("data-view-retry")
    )
      return;
    const control = Array.from(
      focus.container.current?.querySelectorAll<HTMLElement>(
        "[data-search-field]",
      ) ?? [],
    ).find((node) => node.dataset.searchField === key);
    control?.focus({ preventScroll: true });
    if (control instanceof HTMLInputElement && start !== null && end !== null)
      control.setSelectionRange(start, end, direction ?? undefined);
  }, [checking, rows, focus.container]);
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
  const selected = viewId ? base.current : null;
  useLayoutEffect(() => {
    if (selected && !checking && pristineEditor.current === null)
      pristineEditor.current = editorSignature();
  }, [selected, checking, editorSignature]);
  const finishSave = (id: string) => {
    pristineEditor.current = editorSignature();
    dirty.current = false;
    if (viewId) {
      void refresh(true);
      return;
    }
    savedNavigation.current = true;
    try {
      onView(id);
    } finally {
      savedNavigation.current = false;
    }
  };
  return (
    <section
      className={searchEntry ? undefined : "op-panel saved-views"}
      aria-label={searchEntry ? undefined : "개인 저장 보기"}
      ref={focus.container}
      onFocusCapture={focus.onFocusCapture}
      onChangeCapture={() => {
        if (!mutation.busy) dirty.current = hasUnsaved();
      }}
    >
      <NavigationProtection dirty={hasUnsaved} />
      {!searchEntry && (
        <h2 data-view-fallback tabIndex={-1}>
          {viewId
            ? !checking && selected
              ? selected.name
              : "저장 보기"
            : "내 저장 보기"}
        </h2>
      )}
      {viewId && <a {...link()}>목록으로</a>}
      {error && <p role="alert">{error}</p>}
      {checking && !error && <p role="status">불러오는 중…</p>}
      {(!searchEntry || error) && (
        <button
          type="button"
          onClick={() => void refresh()}
          data-view-retry
          disabled={mutation.busy}
        >
          다시 불러오기
        </button>
      )}
      {mutation.error && !selected && !example && !searchEntry && !error && (
        <p role="alert">{mutation.error}</p>
      )}
      <span role="status">{focus.notice}</span>
      {rows && !checking && !viewId && !searchEntry && (
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
                disabled={mutation.busy}
                onClick={() => {
                  if (
                    hasUnsaved() &&
                    !window.dispatchEvent(
                      new Event("akh:before-navigate", { cancelable: true }),
                    )
                  )
                    return;
                  draftName.current = undefined;
                  retainedRetry.current = null;
                  dirty.current = false;
                  setExample(
                    normalizeSearchFilters(
                      index === 0
                        ? { businessOwner: principalId }
                        : index === 2
                          ? { reviewDateTo: new Date().toISOString() }
                          : { sort: "recent" },
                    ),
                  );
                }}
              >
                {label}
              </button>
            ),
          )}
        </>
      )}
      {conflict && !checking && (
        <div role="alert">
          서버의 보기가 변경되었습니다. 입력을 확인한 뒤 최신 정의를 선택하세요.
          <button onClick={() => void refresh(true)}>
            미저장 입력을 버리고 최신 정의 사용
          </button>
        </div>
      )}
      {(selected || (rows && (searchEntry || (!viewId && example)))) && (
        <SearchPage
          key={selected?.revision ?? JSON.stringify(example)}
          api={api}
          identityKey={spaceId + ":" + principalId}
          verification={{
            checking,
            saving: mutation.busy,
            epoch,
            onFailure: onVerificationError,
            pendingComposition,
            onDraftChanged: () => {
              dirty.current = true;
            },
          }}
          initialFilters={selected?.filters ?? example ?? undefined}
          handoff={entryHandoff.current}
          onOpen={onOpen}
          renderSave={(filters, disabled, composition) => (
            <ViewForm
              mutation={mutation}
              filters={filters}
              disabled={disabled || conflict}
              composition={composition}
              draftName={draftName}
              view={selected ?? undefined}
              onSaved={finishSave}
            />
          )}
        />
      )}
    </section>
  );
}
