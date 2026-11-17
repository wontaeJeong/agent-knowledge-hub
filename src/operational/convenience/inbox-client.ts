import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "../api";
import { convenienceHref } from "./route";
export const inboxTypeLabels = {
  mention: "멘션",
  "document-updated": "문서 변경",
  "review-requested": "검토 요청",
  "review-decided": "검토 결정",
  "review-due": "검토 기한",
  "job-succeeded": "작업 완료",
  "job-failed": "작업 실패",
  "access-decided": "접근 요청 결정",
};
export type InboxType = keyof typeof inboxTypeLabels;
export type InboxTarget =
  | { kind: "document"; pageId: string }
  | { kind: "comment"; pageId: string; commentId: string }
  | { kind: "review" | "job" | "access-request"; id: string };
export interface InboxItem {
  id: string;
  sequence: number;
  revision: number;
  type: InboxType;
  createdAt: string;
  readAt: string | null;
  archivedAt: string | null;
  target: InboxTarget;
  title: string;
  actionState: string;
}
export interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
  unreadCount: number;
  readBoundary: string;
}
export interface InboxProps {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  onExpired?: () => void;
  onNavigate?: (href: string) => boolean | void;
}
export function inboxHref(spaceId: string, target: InboxTarget) {
  return convenienceHref(
    target.kind === "document" || target.kind === "comment"
      ? {
          kind: "document",
          spaceId,
          document: target.pageId,
          ...(target.kind === "comment" ? { comment: target.commentId } : {}),
        }
      : {
          kind: "section",
          spaceId,
          section: "tasks",
          targetKind: target.kind,
          targetId: target.id,
        },
  );
}
const inboxFailure = (e: unknown) =>
  e instanceof ApiError && ["INVALID_BOUNDARY", "STALE_CURSOR"].includes(e.code)
    ? "목록이 변경되었습니다. 다시 불러온 뒤 시도하세요."
    : e instanceof ApiError &&
        ["MUTATION_CONFLICT", "STALE_VERSION"].includes(e.code)
      ? "다른 창에서 알림 상태가 변경되었습니다. 다시 불러오세요."
      : e instanceof Error
        ? e.message
        : "알림 요청을 완료하지 못했습니다.";
const notify = () => {
  window.dispatchEvent(new Event("akh:inbox-changed"));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("akh-inbox");
    channel.postMessage("changed");
    channel.close();
  }
};
export function useInbox(
  { api, spaceId, principalId, onExpired }: InboxProps,
  query: string,
) {
  const [page, setPage] = useState<InboxPage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    owner = useRef(`${spaceId}:${principalId}`),
    expired = useRef(onExpired);
  expired.current = onExpired;
  const key = `${spaceId}:${principalId}`;
  if (owner.current !== key) {
    owner.current = key;
    generation.current++;
  }
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api.get<InboxPage>(`/collaboration/inbox?${query}`);
      if (request !== generation.current) return;
      setPage(result);
      setError("");
    } catch (e) {
      if (request !== generation.current) return;
      setPage(null);
      setError(inboxFailure(e));
      if (e instanceof ApiError && e.status === 401) expired.current?.();
    }
  }, [api, query, key]);
  useEffect(() => {
    setPage(null);
    setError("");
    void refresh();
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      if (timer) clearInterval(timer);
      if (document.visibilityState !== "hidden")
        timer = setInterval(() => void refresh(), 30000);
    };
    const focus = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const visible = () => {
      schedule();
      focus();
    };
    const changed = () => void refresh();
    schedule();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("akh:inbox-changed", changed);
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("akh-inbox")
        : null;
    if (channel) channel.onmessage = changed;
    return () => {
      generation.current++;
      if (timer) clearInterval(timer);
      channel?.close();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("akh:inbox-changed", changed);
    };
  }, [refresh]);
  const mutate = async (path: string, body: unknown) => {
    generation.current++;
    setBusy(true);
    try {
      await api.post(path, body);
      await refresh();
      notify();
    } catch (e) {
      setPage(null);
      setError(inboxFailure(e));
      if (e instanceof ApiError && e.status === 401) expired.current?.();
    } finally {
      setBusy(false);
    }
  };
  return {
    page,
    error,
    busy,
    refresh,
    setState: (
      item: InboxItem,
      patch: { read?: boolean; archived?: boolean },
    ) =>
      mutate(`/collaboration/inbox/${encodeURIComponent(item.id)}/state`, {
        ...patch,
        expectedRevision: item.revision,
        mutationId: crypto.randomUUID(),
      }),
    readAll: () =>
      page
        ? mutate("/collaboration/inbox/read-all", {
            boundary: page.readBoundary,
            mutationId: crypto.randomUUID(),
          })
        : Promise.resolve(),
  };
}
