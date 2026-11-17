import { useEffect, useRef, useState } from "react";
import type { OperationalApi } from "../api";
import { Button } from "../../ui/primitives";
import { documentHref } from "../api";
import { usePersonalKey } from "./personal-client";
type Props = {
  api: OperationalApi;
  spaceId: string;
  pageId: string;
  version: number;
  onError: (e: unknown) => void;
};
type Page = {
  pageId: string;
  version: number;
  items: { id: string; title: string; version: number }[];
  nextCursor: string | null;
};
export function Backlinks(props: Props) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.pageId}:${props.version}`,
  );
  return <CurrentBacklinks key={key} {...props} />;
}
function CurrentBacklinks({ api, spaceId, pageId, version, onError }: Props) {
  const [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(""),
    [cursor, setCursor] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0),
    [history, setHistory] = useState<(string | null)[]>([]);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    let live = true;
    setData(null);
    setError("");
    void api
      .get<Page>(
        `/convenience/pages/${encodeURIComponent(pageId)}/backlinks${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
      )
      .then((r) => {
        if (!live) return;
        if (r.version !== version || r.pageId !== pageId)
          throw Error("발행본이 변경되었습니다. 문서를 다시 여세요.");
        setData(r);
      })
      .catch((e) => {
        if (live) {
          setError("백링크를 불러오지 못했습니다. 처음부터 다시 조회하세요.");
          report.current(e);
        }
      });
    return () => {
      live = false;
    };
  }, [api, pageId, version, cursor, refresh]);
  useEffect(() => {
    const reload = () => {
      setData(null);
      setHistory([]);
      setCursor(null);
      setRefresh((x) => x + 1);
    };
    window.addEventListener("focus", reload);
    const timer = setInterval(reload, 60000);
    return () => {
      window.removeEventListener("focus", reload);
      clearInterval(timer);
    };
  }, []);
  return (
    <section aria-label="이 문서를 참조하는 문서">
      <h4>이 문서를 참조하는 문서</h4>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button
            onClick={() => {
              setHistory([]);
              setCursor(null);
              setRefresh((x) => x + 1);
            }}
          >
            백링크 다시 조회
          </Button>
        </>
      ) : data ? (
        <>
          <ul>
            {data.items.map((item) => (
              <li key={item.id}>
                <a href={documentHref(spaceId, item.id)}>{item.title}</a> · v
                {item.version}
              </li>
            ))}
          </ul>
          {!data.items.length && (
            <p>현재 열람 가능한 발행 백링크가 없습니다.</p>
          )}
          <div className="op-actions">
            {history.length > 0 && (
              <Button
                onClick={() => {
                  setCursor(history.at(-1)!);
                  setHistory((x) => x.slice(0, -1));
                }}
              >
                이전 백링크
              </Button>
            )}
            {data.nextCursor && (
              <Button
                onClick={() => {
                  setHistory((x) => [...x, cursor]);
                  setCursor(data.nextCursor);
                }}
              >
                다음 백링크
              </Button>
            )}
          </div>
        </>
      ) : (
        <p role="status">백링크 권한 확인 중…</p>
      )}
    </section>
  );
}
