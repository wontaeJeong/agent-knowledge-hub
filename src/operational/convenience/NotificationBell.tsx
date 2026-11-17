import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "../../ui/primitives";
import {
  inboxHref,
  inboxTypeLabels,
  useInbox,
  type InboxProps,
} from "./inbox-client";
import "./inbox.css";
export function NotificationBell(
  props: InboxProps & { onOpenInbox: () => void },
) {
  const { page, error, refresh } = useInbox(props, "state=all&limit=5");
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
      if (event.key === "Tab" && panel.current) {
        const nodes = [
          ...panel.current.querySelectorAll<HTMLElement>("a,button"),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", close);
    panel.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div className="inbox-bell">
      <button
        ref={trigger}
        type="button"
        className="btn"
        aria-label={`알림${page ? ` · 읽지 않음 ${page.unreadCount}건` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={18} />
        <span>알림</span>
        {page && page.unreadCount > 0 && (
          <span className="inbox-count">{page.unreadCount}</span>
        )}
      </button>
      {open && (
        <div
          ref={panel}
          className="inbox-preview"
          role="dialog"
          aria-label="최근 알림"
        >
          <h2>최근 알림</h2>
          {error ? (
            <>
              <p role="alert">{error}</p>
              <Button onClick={() => void refresh()}>다시 시도</Button>
            </>
          ) : !page ? (
            <p role="status">알림을 불러오는 중입니다.</p>
          ) : (
            <>
              <ul>
                {page.items.map((item) => (
                  <li key={item.id}>
                    <a
                      href={inboxHref(props.spaceId, item.target)}
                      onClick={(e) => {
                        if (props.onNavigate?.(e.currentTarget.href) === false)
                          e.preventDefault();
                      }}
                    >
                      <span>
                        {inboxTypeLabels[item.type]}
                        {!item.readAt && " · 읽지 않음"}
                      </span>
                      <strong>{item.title}</strong>
                    </a>
                  </li>
                ))}
              </ul>
              {page.items.length === 0 && <p>표시할 알림이 없습니다.</p>}
            </>
          )}
          <div className="inbox-actions">
            <Button
              onClick={() => {
                setOpen(false);
                props.onOpenInbox();
              }}
            >
              전체 알림
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              닫기
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
