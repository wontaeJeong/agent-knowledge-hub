import { useEffect, useRef, useState } from "react";
import { ApiError, type OperationalApi } from "./api";
import { resolveJob } from "./jobs-client";
type IndexStatus = {
  status: "ready" | "degraded";
  engine: string;
  observedAt: string;
  indexBytes: string | null;
  freshness: {
    mode: string;
    lastContentMutationObservedAt: string | null;
    workspaceRevision: string | null;
    lagSeconds: null;
  };
  lastSuccess: { at: string; kind: "migration" | "rebuild" };
  lastAttemptAt: string | null;
  lastFailure: { at: string; code: string } | null;
  progress: { command: string; phase: string }[];
};
export function SearchIndexPanel({
  api,
  capabilities,
  onExpired,
}: {
  api: OperationalApi;
  capabilities: string[];
  onExpired?: () => void;
}) {
  const allowed =
    capabilities.includes("jobs.global") &&
    capabilities.includes("space.admin");
  const [status, setStatus] = useState<IndexStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [job, setJob] = useState<string | null>(null);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    nonce = useRef<string | null>(null);
  function fail(e: unknown) {
    setError(
      e instanceof Error ? e.message : "검색 색인 상태를 확인하지 못했습니다.",
    );
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      setStatus(null);
      nonce.current = null;
      if (e.status === 401) onExpired?.();
    }
  }
  async function load(current = generation.current) {
    try {
      const value = await api.get<IndexStatus>("/search/index");
      if (current === generation.current) setStatus(value);
    } catch (e) {
      if (current === generation.current) fail(e);
    }
  }
  useEffect(() => {
    const current = ++generation.current;
    controller.current?.abort();
    nonce.current = null;
    setStatus(null);
    setJob(null);
    setBusy(false);
    setError("");
    setNotice("");
    if (allowed) void load(current);
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [api, allowed]);
  async function rebuild() {
    if (busy) return;
    const current = generation.current;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setBusy(true);
    setError("");
    setNotice("");
    nonce.current ??= crypto.randomUUID();
    const key = nonce.current;
    try {
      const receipt = await api.post(
        "/search/index/rebuild",
        { idempotency_key: key },
        key,
      );
      const result = await resolveJob<{ rebuilt: boolean }>(api, receipt, {
        expectQueued: true,
        signal: abort.signal,
        onProgress: (value) => {
          if (current === generation.current) {
            setJob(value.id + ": " + value.status);
            if (["dead", "cancelled"].includes(value.status))
              nonce.current = null;
          }
        },
      });
      if (!result.rebuilt)
        throw Error("검색 색인 재구축 결과를 확인하지 못했습니다.");
      if (current === generation.current) {
        nonce.current = null;
        setNotice("검색 색인 재구축이 완료되었습니다.");
        await load(current);
      }
    } catch (e) {
      if (current === generation.current) {
        fail(e);
        if (!(e instanceof ApiError && [401, 403, 404].includes(e.status)))
          await load(current);
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (!allowed) return null;
  return (
    <section aria-label="검색 색인 운영">
      <h3>검색 색인</h3>
      <p>
        커밋된 본문은 PostgreSQL 색인에 같은 트랜잭션으로 반영됩니다. 재구축은
        작업 큐에서 실행하며, 실행 중 쓰기 요청이 잠시 대기할 수 있습니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {job && <p role="status">재구축 작업 {job}</p>}
      {!status ? (
        <p>색인 상태 미확인</p>
      ) : (
        <>
          <dl>
            <dt>색인 상태</dt>
            <dd>{status.status === "ready" ? "정상" : "점검 필요"}</dd>
            <dt>상태 확인 시각</dt>
            <dd>{status.observedAt}</dd>
            <dt>현재 공간의 본문 변경 관측</dt>
            <dd>
              {status.freshness.lastContentMutationObservedAt ?? "기록 없음"}
            </dd>
            <dt>마지막 성공</dt>
            <dd>
              {status.lastSuccess.kind === "migration"
                ? "초기 색인 생성"
                : "색인 재구축"}{" "}
              · {status.lastSuccess.at}
            </dd>
            <dt>색인 크기</dt>
            <dd>
              {status.indexBytes === null
                ? "미확인"
                : Number(status.indexBytes).toLocaleString("ko-KR") + " bytes"}
            </dd>
            <dt>최근 재구축 실패</dt>
            <dd>
              {status.lastFailure
                ? status.lastFailure.at + " · " + status.lastFailure.code
                : "기록 없음"}
            </dd>
          </dl>
          {status.progress.map((p, i) => (
            <p key={i}>PostgreSQL 진행 단계: {p.phase}</p>
          ))}
        </>
      )}
      <div className="op-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError("");
            void load();
          }}
        >
          색인 상태 새로고침
        </button>
        <button type="button" disabled={busy} onClick={() => void rebuild()}>
          {busy ? "검색 색인 재구축 대기 중" : "검색 색인 재구축"}
        </button>
      </div>
    </section>
  );
}
