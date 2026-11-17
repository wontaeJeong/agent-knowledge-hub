import { useState } from "react";
import { Button } from "../../ui/primitives";
import {
  inboxHref,
  inboxTypeLabels,
  useInbox,
  type InboxProps,
} from "./inbox-client";
import "./inbox.css";
import { useInboxFocus } from "./inbox-focus";
export function NotificationInbox(props: InboxProps) {
  const [state, setState] = useState("all"),
    [type, setType] = useState(""),
    [cursor, setCursor] = useState<string | null>(null);
  const query = new URLSearchParams({
    state,
    limit: "25",
    ...(type ? { type } : {}),
    ...(cursor ? { cursor } : {}),
  }).toString();
  const inbox = useInbox(props, query);
  const focus = useInboxFocus<HTMLElement>();
  return (
    <section ref={focus.container} onFocusCapture={focus.onFocusCapture} className="op-panel personal-inbox" aria-label="개인 알림함">
      <h2>알림함</h2>
      <span className="inbox-live" role="status">{focus.notice}</span>
      <p>읽음과 보관은 검토·작업 상태를 변경하지 않습니다.</p>
      <div className="inbox-filters">
        <label>
          상태{" "}
          <select
            aria-label="알림 상태"
            data-inbox-focus-fallback
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setCursor(null);
            }}
          >
            <option value="all">전체</option>
            <option value="unread">읽지 않음</option>
            <option value="archived">보관</option>
          </select>
        </label>
        <label>
          유형{" "}
          <select
            aria-label="알림 유형"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setCursor(null);
            }}
          >
            <option value="">모든 유형</option>
            {Object.entries(inboxTypeLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={inbox.busy} onClick={() => void inbox.refresh()}>
          새로고침
        </Button>
        <Button
          disabled={inbox.busy || !inbox.page || !inbox.page.unreadCount}
          onClick={() => void inbox.readAll()}
        >
          확인한 알림 모두 읽음
        </Button>
      </div>
      {inbox.error ? (
        <p role="alert">
          {inbox.error}{" "}
          <Button
            onClick={() => {
              setCursor(null);
              void inbox.refresh();
            }}
          >
            다시 불러오기
          </Button>
        </p>
      ) : !inbox.page ? (
        <p role="status">알림을 불러오는 중입니다.</p>
      ) : (
        <>
          <p>읽지 않음 {inbox.page.unreadCount}건</p>
          <ul className="inbox-list">
            {inbox.page.items.map((item) => (
              <li key={item.id} data-inbox-row>
                <div>
                  <span>
                    {inboxTypeLabels[item.type]} ·{" "}
                    {item.readAt ? "읽음" : "읽지 않음"}
                  </span>
                  <a
                    href={inboxHref(props.spaceId, item.target)}
                    onClick={(e) => {
                      if (props.onNavigate?.(e.currentTarget.href) === false)
                        e.preventDefault();
                    }}
                  >
                    {item.title}
                  </a>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString("ko-KR")}
                  </time>
                </div>
                <div className="inbox-actions">
                  <Button
                    disabled={inbox.busy}
                    onClick={() =>
                      void inbox.setState(item, { read: !item.readAt })
                    }
                  >
                    {item.readAt ? "읽지 않음으로 표시" : "읽음으로 표시"}
                  </Button>
                  <Button
                    disabled={inbox.busy}
                    onClick={() =>
                      void inbox.setState(item, { archived: !item.archivedAt })
                    }
                  >
                    {item.archivedAt ? "보관 해제" : "보관"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {inbox.page.items.length === 0 && <p>표시할 알림이 없습니다.</p>}
          <div className="inbox-actions">
            {cursor && (
              <Button onClick={() => setCursor(null)}>처음으로</Button>
            )}
            {inbox.page.nextCursor && (
              <Button onClick={() => setCursor(inbox.page!.nextCursor)}>
                다음 25건
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
