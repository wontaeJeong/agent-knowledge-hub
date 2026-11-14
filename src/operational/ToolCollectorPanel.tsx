import { useEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "./api";
import { Button } from "../ui/primitives";

type Connection = {
  id: string;
  label: string;
  active: boolean;
  revision: number;
  version: string;
  allowedSessionIds: string[];
};
export function ToolCollectorPanel({
  api,
  onExpired,
}: {
  api: OperationalApi;
  onExpired?: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [connectionId, setConnectionId] = useState(""),
    [sessionId, setSessionId] = useState("");
  const [artifactId, setArtifactId] = useState(""),
    [title, setTitle] = useState(""),
    [project, setProject] = useState("선택 자료"),
    [format, setFormat] = useState("api.assistant-message"),
    [toolIds, setToolIds] = useState("");
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const generation = useRef(0),
    expired = useRef(onExpired);
  expired.current = onExpired;
  const current = connections.find((c) => c.id === connectionId);
  function clear() {
    setConnections([]);
    setConnectionId("");
    setSessionId("");
    setArtifactId("");
    setTitle("");
    setProject("선택 자료");
    setToolIds("");
    setMessage("");
  }
  function fail(e: unknown) {
    clear();
    setError(e instanceof Error ? e.message : "자료를 가져오지 못했습니다.");
    if (e instanceof ApiError && e.status === 401) expired.current?.();
  }
  async function load() {
    const n = ++generation.current;
    try {
      const result = await api.get<{ items: Connection[] }>(
        "/storage/collector-connections",
      );
      if (n !== generation.current) return;
      setConnections(result.items);
      setLoaded(true);
      const first = result.items.find((c) => c.active);
      setConnectionId(first?.id ?? "");
      setSessionId(first?.allowedSessionIds[0] ?? "");
    } catch (e) {
      if (n === generation.current) {
        setLoaded(true);
        fail(e);
      }
    }
  }
  useEffect(() => {
    clear();
    setBusy(false);
    setLoaded(false);
    setError("");
    void load();
    return () => {
      generation.current++;
    };
  }, [api]);
  async function mutate(action: () => Promise<string>) {
    const n = ++generation.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (n !== generation.current) return;
      setMessage(result);
      await load();
    } catch (e) {
      if (n === generation.current) fail(e);
    } finally {
      if (n === generation.current || n + 1 === generation.current)
        setBusy(false);
    }
  }
  return (
    <section className="op-panel" aria-labelledby="tool-collector-title">
      <h2 id="tool-collector-title">선택한 도구 자료 가져오기</h2>
      <p>
        승인된 개인 연결에서 선택한 메시지만 가져옵니다. 개인 원본으로 저장하며
        공유 발행은 별도 검토가 필요합니다. 연결 중 요청에만 실행됩니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!loaded && <p role="status">승인된 연결을 확인하고 있습니다.</p>}
      {loaded && !connections.some((c) => c.active) && (
        <p>
          승인된 연결이 없습니다. 지원 버전과 세션 소유권을 확인한 연결이
          필요합니다. 기존 연결을 철회했다면 서버에서 별도 승인해야 다시 사용할
          수 있습니다.
        </p>
      )}
      {connections.some((c) => c.active) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!current) return;
            void mutate(async () => {
              const result = await api.post<{
                id: string;
                duplicate: boolean;
                stale?: boolean;
              }>(
                `/storage/collector-connections/${encodeURIComponent(current.id)}/collect`,
                {
                  expectedRevision: current.revision,
                  sessionId,
                  artifactId,
                  format,
                  selectedToolIds: toolIds
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  title,
                  project,
                },
              );
              return result.duplicate
                ? result.stale
                  ? "더 최신 자료가 이미 저장되어 이전 자료는 추가하지 않았습니다."
                  : "이미 저장된 개인 원본입니다."
                : "개인 원본으로 저장했습니다. 원본 · 편입에서 내용을 확인하세요.";
            });
          }}
        >
          <label>
            승인된 연결
            <select
              disabled={busy}
              value={connectionId}
              onChange={(e) => {
                setConnectionId(e.target.value);
                setSessionId(
                  connections.find((c) => c.id === e.target.value)
                    ?.allowedSessionIds[0] ?? "",
                );
                setArtifactId("");
                setToolIds("");
              }}
            >
              {connections
                .filter((c) => c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · OpenCode {c.version}
                  </option>
                ))}
            </select>
          </label>
          <label>
            승인된 세션
            <select
              disabled={busy}
              value={sessionId}
              onChange={(e) => {
                setSessionId(e.target.value);
                setArtifactId("");
                setToolIds("");
              }}
            >
              {current?.allowedSessionIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            자료 형식
            <select
              disabled={busy}
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="api.assistant-message">
                완료된 assistant 메시지
              </option>
              <option value="api.synthetic-message">
                선택한 synthetic 메시지
              </option>
            </select>
          </label>
          <label>
            메시지 ID
            <input
              aria-label="메시지 ID"
              required
              pattern="msg_[a-zA-Z0-9]+"
              disabled={busy}
              value={artifactId}
              onChange={(e) => setArtifactId(e.target.value)}
            />
          </label>
          <label>
            선택할 도구 출력 ID (쉼표로 구분)
            <input
              disabled={busy || format !== "api.assistant-message"}
              value={toolIds}
              onChange={(e) => setToolIds(e.target.value)}
            />
          </label>
          <p>
            추론·도구 입력·내부 데이터는 가져오지 않습니다. 선택한 도구 출력도
            미검증 기록이며 실행 성공을 보증하지 않습니다.
          </p>
          <label>
            자료 제목
            <input
              aria-label="자료 제목"
              required
              maxLength={300}
              disabled={busy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            프로젝트 표시
            <input
              required
              maxLength={200}
              disabled={busy}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
          </label>
          <p>
            지원 버전은 요청 시 다시 확인합니다. 버전 변경·제외 정책·권한 철회가
            확인되면 저장하지 않습니다.
          </p>
          <div className="op-actions">
            <Button type="submit" disabled={busy || !sessionId || !current}>
              {busy ? "확인 중…" : "선택 자료 가져오기"}
            </Button>
            <Button
              type="button"
              disabled={busy || !current}
              onClick={() => {
                if (
                  !current ||
                  !window.confirm(
                    "이 개인 도구 연결을 철회할까요? 다시 사용하려면 별도 서버 승인이 필요합니다.",
                  )
                )
                  return;
                void mutate(async () => {
                  await api.post(
                    `/storage/collector-connections/${encodeURIComponent(current.id)}/revoke`,
                    { expectedRevision: current.revision },
                  );
                  return "연결을 철회했습니다.";
                });
              }}
            >
              연결 철회
            </Button>
          </div>
        </form>
      )}
      <Button
        disabled={busy}
        onClick={() => {
          setError("");
          void load();
        }}
      >
        연결 상태 새로 고침
      </Button>
    </section>
  );
}
