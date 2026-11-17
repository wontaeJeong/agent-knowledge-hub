import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/primitives";
import { documentHref, type OperationalApi } from "../api";
import {
  libraryLabels,
  personalChanged,
  personalFailure,
  usePersonalKey,
  type LibraryKind,
  type LibraryPage,
} from "./personal-client";
import "./personal.css";
interface Scope {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  onError?: (e: unknown) => void;
  onNavigate?: (href: string) => boolean | void;
}
interface Props extends Scope {
  kind: LibraryKind;
  refreshKey?: string;
  compact?: boolean;
}
export function PersonalLibrary(props: Props) {
  const key = usePersonalKey(
    props.api,
    `${props.principalId}:${props.spaceId}:${props.kind}:${props.refreshKey ?? ""}`,
  );
  return <LibrarySession key={key} {...props} />;
}
function LibrarySession({
  api,
  spaceId,
  kind,
  onError,
  onNavigate,
  compact,
}: Props) {
  const [result, setResult] = useState<{
      page: LibraryPage;
      cursor: string | null;
    } | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const page = result?.cursor === cursor ? result.page : null;
  const active = useRef(false),
    mutationBusy = useRef(false),
    sequence = useRef(0),
    container = useRef<HTMLElement>(null),
    interaction = useRef<{ node: HTMLButtonElement; left: boolean } | null>(
      null,
    ),
    focus = useRef<{
      pageId: string;
      direction: number;
      interaction: { node: HTMLButtonElement; left: boolean };
    } | null>(null),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  const refresh = useCallback(async () => {
    if (!active.current || mutationBusy.current) return false;
    const seq = ++sequence.current;
    setError("");
    try {
      const result = await api.get<LibraryPage>(
        `/workflows/${kind}?${new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) })}`,
      );
      if (active.current && seq === sequence.current)
        setResult({ page: result, cursor });
    } catch (e) {
      if (active.current && seq === sequence.current) {
        setResult(null);
        focus.current = null;
        interaction.current = null;
        setError(personalFailure(e));
        errorHandler.current?.(e);
      }
    }
  }, [api, kind, cursor]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const reload = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", reload);
    window.addEventListener("akh:personal-changed", reload);
    document.addEventListener("visibilitychange", reload);
    const timer = setInterval(reload, 30000);
    return () => {
      active.current = false;
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener("focus", reload);
      window.removeEventListener("akh:personal-changed", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [refresh]);
  useEffect(() => {
    const leave = (event: Event) => {
      const current = interaction.current;
      if (
        current &&
        event.target instanceof Node &&
        !current.node.contains(event.target)
      )
        current.left = true;
    };
    document.addEventListener("focusin", leave);
    document.addEventListener("pointerdown", leave, true);
    return () => {
      document.removeEventListener("focusin", leave);
      document.removeEventListener("pointerdown", leave, true);
      interaction.current = null;
      focus.current = null;
    };
  }, []);
  useEffect(() => {
    if (page && !busy && focus.current) {
      const target = focus.current;
      focus.current = null;
      interaction.current = null;
      if (
        target.interaction.left ||
        (document.activeElement !== target.interaction.node &&
          document.activeElement !== document.body)
      )
        return;
      const row = Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          "[data-personal-page]",
        ) ?? [],
      ).find((row) => row.dataset.personalPage === target.pageId);
      const exact = row?.querySelector<HTMLButtonElement>(
        `button[data-direction="${target.direction}"]`,
      );
      const next =
        exact && !exact.disabled
          ? exact
          : (row?.querySelector<HTMLElement>("button:not(:disabled)") ??
            row?.querySelector<HTMLElement>("a") ??
            container.current?.querySelector<HTMLElement>(
              "[data-personal-fallback]",
            ));
      next?.focus({ preventScroll: true });
    }
  }, [page, busy]);
  const reorder = async (
    index: number,
    step: number,
    initiator: HTMLButtonElement,
  ) => {
    if (!page || busy || mutationBusy.current) return;
    const currentInteraction = {
      node: initiator,
      left: document.activeElement !== initiator,
    };
    interaction.current = currentInteraction;
    mutationBusy.current = true;
    const ids = page.items.map((item) => item.id);
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      await api.post("/workflows/favorites/reorder", {
        pageIds: ids,
        expectedRevision: page.revision,
        mutationId: crypto.randomUUID(),
      });
      if (!active.current || seq !== sequence.current) return;
      mutationBusy.current = false;
      focus.current = {
        pageId: page.items[index].id,
        direction: step,
        interaction: currentInteraction,
      };
      if (cursor) setCursor(null);
      else await refresh();
    } catch (e) {
      if (active.current && seq === sequence.current) {
        setResult(null);
        focus.current = null;
        interaction.current = null;
        setError(personalFailure(e));
        errorHandler.current?.(e);
      }
    } finally {
      mutationBusy.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      ref={container}
      className={compact ? "personal-library" : "op-panel personal-library"}
      aria-label={libraryLabels[kind]}
    >
      <h3>{libraryLabels[kind]}</h3>
      <div className="op-actions">
        <Button
          disabled={busy}
          data-personal-fallback
          onClick={() => {
            if (cursor) setCursor(null);
            else void refresh();
          }}
        >
          처음부터 새로고침
        </Button>
        {cursor && (
          <Button disabled={busy} onClick={() => setCursor(null)}>
            첫 페이지
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !page ? (
        <p role="status">현재 접근 권한을 확인하는 중입니다.</p>
      ) : (
        <>
          <ul className="personal-library-list">
            {page.items.map((item, index) => (
              <li key={item.id} data-personal-page={item.id}>
                <div>
                  <a
                    href={documentHref(spaceId, item.id)}
                    onClick={(e) => {
                      if (onNavigate?.(e.currentTarget.href) === false)
                        e.preventDefault();
                    }}
                  >
                    {item.title}
                  </a>
                  <span> · v{item.version}</span>
                  {kind === "recent" && item.at && (
                    <time dateTime={item.at}>
                      {new Date(item.at).toLocaleString("ko-KR")}
                    </time>
                  )}
                </div>
                {kind === "favorites" && (
                  <div className="personal-library-order">
                    {[-1, 1].map((step) => {
                      const label = `${item.title} ${step < 0 ? "위로" : "아래로"} 이동`;
                      return (
                        <Button
                          key={step}
                          data-direction={step}
                          aria-label={label}
                          disabled={
                            busy ||
                            index + step < 0 ||
                            index + step >= page.items.length
                          }
                          onClick={(event) =>
                            void reorder(index, step, event.currentTarget)
                          }
                        >
                          {step < 0 ? "위로" : "아래로"}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!page.items.length && <p>표시할 문서 없음</p>}
          {page.nextCursor && (
            <Button disabled={busy} onClick={() => setCursor(page.nextCursor)}>
              다음 25개
            </Button>
          )}
        </>
      )}
    </section>
  );
}
interface ControlsProps extends Scope {
  pageId: string;
}
export function DocumentPersonalControls(props: ControlsProps) {
  const key = usePersonalKey(
    props.api,
    `${props.principalId}:${props.spaceId}:${props.pageId}`,
  );
  return <ControlSession key={key} {...props} />;
}
function ControlSession({ api, pageId, onError }: ControlsProps) {
  const [state, setState] = useState<{
      favorite: boolean;
      subscribed: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(false),
    mutationBusy = useRef(false),
    sequence = useRef(0),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  const path = `/workflows/pages/${encodeURIComponent(pageId)}`;
  const refresh = useCallback(async () => {
    if (!active.current || mutationBusy.current) return false;
    const seq = ++sequence.current;
    setError("");
    try {
      const value = await api.get<{ favorite: boolean; subscribed: boolean }>(
        `${path}/personal-state`,
      );
      if (active.current && seq === sequence.current) {
        setState(value);
        return true;
      }
    } catch (e) {
      if (active.current && seq === sequence.current) {
        setState(null);
        setError(personalFailure(e));
        errorHandler.current?.(e);
      }
    }
  }, [api, path]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const reload = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", reload);
    window.addEventListener("akh:personal-changed", reload);
    const timer = setInterval(reload, 30000);
    return () => {
      active.current = false;
      sequence.current++;
      clearInterval(timer);
      window.removeEventListener("focus", reload);
      window.removeEventListener("akh:personal-changed", reload);
    };
  }, [refresh]);
  const toggle = async (kind: "favorite" | "subscribe", enabled: boolean) => {
    if (busy || !state || mutationBusy.current) return;
    mutationBusy.current = true;
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      await api.post(`${path}/${kind}`, { enabled });
      if (!active.current || seq !== sequence.current) return;
      mutationBusy.current = false;
      const refreshed = await refresh();
      if (active.current && refreshed) personalChanged();
    } catch (e) {
      if (active.current && seq === sequence.current) {
        setState(null);
        setError(personalFailure(e));
        errorHandler.current?.(e);
      }
    } finally {
      mutationBusy.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <div className="op-actions" aria-label="개인 문서 설정">
      {error ? (
        <p role="alert">{error}</p>
      ) : !state ? (
        <p role="status">개인 설정 확인 중</p>
      ) : (
        <>
          <Button
            aria-pressed={state.favorite}
            aria-disabled={busy}
            onClick={() => void toggle("favorite", !state.favorite)}
          >
            {state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
          </Button>
          <Button
            aria-pressed={state.subscribed}
            aria-disabled={busy}
            onClick={() => void toggle("subscribe", !state.subscribed)}
          >
            {state.subscribed ? "구독 해제" : "알림 구독"}
          </Button>
        </>
      )}
      {error && (
        <Button onClick={() => void refresh()}>개인 설정 다시 확인</Button>
      )}
    </div>
  );
}
