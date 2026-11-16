import { useEffect, useRef, useState } from "react";
import type { OperationalApi } from "./api";
import { Button } from "../ui/primitives";
type Preview = {
  token: string;
  expiresAt: string;
  recipientId: string;
  items: {
    pageId: string;
    title: string;
    version: number;
    parentId: string | null;
    audienceChange: "unchanged";
  }[];
};
export function ShareSelection({
  api,
  scope,
  onChanged,
  onExpired,
}: {
  api: OperationalApi;
  scope: string;
  onChanged: () => Promise<void>;
  onExpired: () => void;
}) {
  const [root, setRoot] = useState(""),
    [recipient, setRecipient] = useState(""),
    [children, setChildren] = useState(false),
    [expiry, setExpiry] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const epoch = useRef(0);
  function clear() {
    epoch.current++;
    setPreview(null);
    setSelected([]);
    setNotice("");
    setError("");
    setBusy(false);
  }
  useEffect(() => {
    clear();
    return () => {
      epoch.current++;
    };
  }, [api, scope]);
  async function run(apply = false) {
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (apply && preview) {
        const r = await api.post<{ items: unknown[] }>("/shares/selection", {
          token: preview.token,
          pageIds: selected,
          expiresAt: new Date(expiry).toISOString(),
        });
        if (request !== epoch.current) return;
        setPreview(null);
        setSelected([]);
        setNotice(`${r.items.length}개 고정 버전 공유를 만들었습니다.`);
        try {
          await onChanged();
        } catch {
          setError("공유 생성 후 목록을 새로고침하지 못했습니다.");
        }
      } else {
        setPreview(null);
        const r = await api.post<Preview>("/shares/preview", {
          rootPageId: root,
          principalId: recipient,
          includeDescendants: children,
        });
        if (request !== epoch.current) return;
        setPreview(r);
        setSelected(r.items.map((p) => p.pageId));
      }
    } catch (e) {
      if (request !== epoch.current) return;
      setPreview(null);
      setSelected([]);
      setError(e instanceof Error ? e.message : "공유 확인 실패");
      if (typeof e === "object" && e && "status" in e && e.status === 401)
        onExpired();
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>자식 문서 선택과 공유 영향 확인</summary>
      <p>
        현재 수신자가 원본과 문서에 접근할 수 있는 고정 버전만 공유합니다.
        문서·원본의 독자 범위는 넓어지지 않으며 이후 생긴 자식 문서는 포함하지
        않습니다.
      </p>
      <label>
        기준 문서 ID
        <input
          value={root}
          disabled={busy}
          onChange={(e) => {
            clear();
            setRoot(e.target.value);
          }}
        />
      </label>
      <label>
        공유 수신자 ID
        <input
          value={recipient}
          disabled={busy}
          onChange={(e) => {
            clear();
            setRecipient(e.target.value);
          }}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={children}
          disabled={busy}
          onChange={(e) => {
            clear();
            setChildren(e.target.checked);
          }}
        />
        현재 자식 문서 후보 포함
      </label>
      <Button disabled={busy || !root || !recipient} onClick={() => void run()}>
        공유 대상 미리보기
      </Button>
      {preview && (
        <section aria-label="공유 영향 미리보기">
          <p>
            수신자: {preview.recipientId} · 확인 유효 시각: {preview.expiresAt}
          </p>
          <ul>
            {preview.items.map((p) => (
              <li key={p.pageId}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(p.pageId)}
                    disabled={busy}
                    onChange={(e) =>
                      setSelected((v) =>
                        e.target.checked
                          ? [...v, p.pageId]
                          : v.filter((id) => id !== p.pageId),
                      )
                    }
                  />
                  {p.title} · v{p.version} · 현재 독자 범위 유지
                </label>
              </li>
            ))}
          </ul>
          <label>
            선택 공유 만료
            <input
              type="datetime-local"
              value={expiry}
              disabled={busy}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !selected.length || !expiry}
            onClick={() => void run(true)}
          >
            선택한 고정 버전 공유
          </Button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">확인 중입니다.</p>}
    </details>
  );
}
