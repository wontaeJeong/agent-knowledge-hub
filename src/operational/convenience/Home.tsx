import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/primitives";
import { ApiError, type OperationalApi } from "../api";
import { personalFailure, usePersonalKey } from "./personal-client";
import { useCurrentListFocus } from "./list-focus";
import "./personal.css";
import "./Home.css";
type Widget =
  | "recent"
  | "favorites"
  | "drafts"
  | "requests"
  | "revisions"
  | "reviews"
  | "failedJobs"
  | "accessRequests";
interface Item {
  id: string;
  title: string;
  state: string;
  href: string;
  assigned?: boolean;
  stale?: boolean;
}
interface Page {
  status: "ready" | "error";
  items: Item[];
  nextCursor: string | null;
  partial?: boolean;
}
type Summary = Record<Widget, Page>;
const labels: Record<Widget, string> = {
  recent: "최근 문서",
  favorites: "즐겨찾기",
  drafts: "내 초안",
  requests: "내가 요청한 검토",
  revisions: "수정 요청",
  reviews: "담당 · 검토 가능한 변경",
  failedJobs: "실패 작업",
  accessRequests: "내 접근 요청",
};
const states: Record<string, string> = {
  "access-pending": "접근 검토 대기",
  "access-approved": "접근 승인",
  "access-rejected": "접근 반려",
  "disclosure-submitted": "초안 공개 승인 · 지식 검토 요청됨",
  "disclosure-pending": "초안 공개 검토 대기",
  "disclosure-pending-confirmation": "개인 공개 확인 대기",
  "disclosure-approved": "초안 공개 승인 · 지식 검토 전",
  "disclosure-rejected": "초안 공개 반려",
  pending: "검토 대기",
  approved: "승인됨 · 발행 전",
  published: "발행됨",
  rejected: "반려됨",
  conflict: "충돌",
  dead: "실패",
  queued: "재시도 대기",
  succeeded: "완료",
  cancelled: "취소됨",
};
export interface HomeProps {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  capabilities: readonly string[];
  tasksOnly?: boolean;
  onError?: (e: unknown) => void;
  onNavigate?: (href: string) => boolean | void;
}
export function Home(props: HomeProps) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.principalId}:${props.capabilities.join(",")}:${props.tasksOnly}`,
  );
  return <HomeSession key={key} {...props} />;
}
function HomeSession({
  api,
  tasksOnly,
  onError,
  onNavigate,
  capabilities,
}: HomeProps) {
  const [summary, setSummary] = useState<Summary | null>(null),
    [error, setError] = useState("");
  const active = useRef(false),
    seq = useRef(0),
    handler = useRef(onError);
  handler.current = onError;
  const refresh = useCallback(async () => {
    const n = ++seq.current;
    setSummary(null);
    setError("");
    try {
      const h = await api.get<Summary>("/convenience/home");
      if (active.current && n === seq.current) setSummary(h);
    } catch (e) {
      if (active.current && n === seq.current) {
        setError(personalFailure(e));
        handler.current?.(e);
      }
    }
  }, [api]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const reload = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    const timer = setInterval(reload, 30000);
    return () => {
      active.current = false;
      seq.current++;
      clearInterval(timer);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [refresh]);
  const focus = useCurrentListFocus<HTMLDivElement>({
    rowSelector: "[data-home-item]",
    fallbackSelector: "[data-home-summary-fallback]",
    message: "목록이 변경되어 홈 안내로 초점을 옮겼습니다.",
  });
  const widgets = (Object.keys(labels) as Widget[]).filter(
    (k) => !tasksOnly || !["recent", "favorites"].includes(k),
  );
  return (
    <div ref={focus.container} onFocusCapture={focus.onFocusCapture}>
      {focus.notice && <p role="status">{focus.notice}</p>}
      <p tabIndex={-1} data-home-summary-fallback>
        읽음은 업무 완료를 뜻하지 않습니다. 검토 승인과 실제 발행은 별도
        단계입니다.
      </p>
      {error ? (
        <section className="op-panel" role="alert">
          <p>{error}</p>
          <Button onClick={() => void refresh()}>홈 다시 불러오기</Button>
        </section>
      ) : !summary ? (
        <p role="status">내 문서와 작업을 불러오는 중…</p>
      ) : (
        <div className="op-personal-documents personal-home">
          {widgets.map((widget) => (
            <HomeWidget
              key={widget}
              widget={widget}
              initial={summary[widget]}
              api={api}
              onError={onError}
              onNavigate={onNavigate}
              capabilities={capabilities}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function HomeWidget({
  widget,
  initial,
  api,
  onError,
  onNavigate,
  capabilities,
}: {
  widget: Widget;
  initial: Page;
  api: OperationalApi;
  onError?: HomeProps["onError"];
  onNavigate?: HomeProps["onNavigate"];
  capabilities: readonly string[];
}) {
  const [page, setPage] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    seq = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      seq.current++;
    };
  }, []);
  const focus = useCurrentListFocus<HTMLElement>({
    rowSelector: "[data-home-item]",
    fallbackSelector: "[data-home-fallback]",
    message: "목록이 변경되어 현재 항목으로 초점을 옮겼습니다.",
  });
  const read = async (cursor?: string | null) => {
    const n = ++seq.current;
    setBusy(true);
    setError("");
    setPage({ status: "error", items: [], nextCursor: null });
    try {
      const result = await api.get<Page>(
        `/convenience/home?${new URLSearchParams({ widget, ...(cursor ? { cursor } : {}) })}`,
      );
      if (live.current && n === seq.current) setPage(result);
    } catch (e) {
      if (live.current && n === seq.current) {
        setError(personalFailure(e));
        if (e instanceof ApiError && e.status === 401) onError?.(e);
      }
    } finally {
      if (live.current && n === seq.current) setBusy(false);
    }
  };
  const permitted = widget !== "drafts" || capabilities.includes("draft.write");
  return (
    <section
      ref={focus.container}
      onFocusCapture={focus.onFocusCapture}
      className="op-panel personal-library"
      data-home-widget={widget}
      aria-busy={busy}
    >
      <h2 tabIndex={-1} data-home-fallback>
        {labels[widget]}
      </h2>
      {focus.notice && <p role="status">{focus.notice}</p>}
      {busy ? (
        <p role="status">불러오는 중…</p>
      ) : page.status === "error" ? (
        <p role="alert">{error || "목록을 불러오지 못했습니다."}</p>
      ) : (
        <>
          {!page.items.length && (
            <p>
              {page.partial
                ? "현재 구간에 표시할 항목이 없습니다. 다음 구간을 확인하세요."
                : "항목이 없습니다."}
            </p>
          )}
          <ul className="personal-library-list personal-home-list">
            {page.items.map((item) => (
              <li key={item.id} data-home-item={item.id}>
                <div>
                  {permitted ? (
                    <a
                      href={item.href}
                      onClick={(e) => {
                        if (onNavigate?.(item.href) === false)
                          e.preventDefault();
                      }}
                    >
                      {item.title}
                    </a>
                  ) : (
                    <span>{item.title}</span>
                  )}
                  <p>
                    {states[item.state] ?? item.state}
                    {item.assigned ? " · 담당 검토" : ""}
                    {item.stale ? " · 기준 변경 · 재검토 필요" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="op-actions">
        <Button disabled={busy} onClick={() => void read()}>
          {page.status === "error" ? "다시 시도" : "새로 고침"}
        </Button>
        {page.nextCursor && (
          <Button disabled={busy} onClick={() => void read(page.nextCursor)}>
            다음 25개
          </Button>
        )}
      </div>
    </section>
  );
}
