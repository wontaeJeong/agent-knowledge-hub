import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, OperationalApi, type Identity } from "./api";
import {
  defaultSelection,
  type ImportView,
  type ImportSelection,
  type ImportResult,
  type ImportRecord,
  type StatementKind,
} from "../domain/imports";
import { Button, Badge } from "../ui/primitives";

const labels: Record<string, string> = {
  uploading: "업로드 중",
  finalized: "서버 접수됨",
  ready: "입력 확인 가능",
  queued: "대기",
  running: "처리 중",
  parsed: "입력 분석 완료",
  review_ready: "정리 완료 · 공유 전 검토 필요",
  no_changes: "새 지식 후보 없음",
  failed: "실패",
  authorization_required: "재인증 후 재개 필요",
  cancelled: "취소됨",
  proposed: "공유 변경 제안 생성됨",
};
const kinds: Record<StatementKind, string> = {
  statement: "작성자 진술",
  proposal: "제안",
  decision_report: "결정 기록 후보",
  question: "미해결 질문",
  commitment: "작업 약속",
  completion_claim: "완료 주장 · 실행 증거 아님",
  observation: "관측 진술",
};
const checksum = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const base64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};
interface Disclosure {
  id: string;
  title: string;
  authorId: string;
  audience: string[];
  hash: string;
  result: ImportResult;
  records: ImportRecord[];
}
export default function ImportWorkbench({
  api,
  identity,
  members,
  onExpired,
  onReview,
}: {
  api: OperationalApi;
  identity: Identity;
  members: { principalId: string; role: string }[];
  onExpired: () => void;
  onReview: () => void;
}) {
  const [items, setItems] = useState<
    { id: string; title: string; status: string }[]
  >([]);
  const [view, setView] = useState<ImportView | null>(null),
    [selection, setSelection] = useState<ImportSelection>(defaultSelection);
  const [files, setFiles] = useState<File[]>([]),
    [paste, setPaste] = useState(""),
    [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  const [config, setConfig] = useState<{
    personal: boolean;
    partSize: number;
    maxFileSize: number;
    reviewers: string[];
    canReviewDisclosure: boolean;
  } | null>(null);
  const [reviewer, setReviewer] = useState(""),
    [audience, setAudience] = useState<string[]>([identity.principalId]);
  const [disclosures, setDisclosures] = useState<Disclosure[]>([]);
  const active = useRef(true),
    generation = useRef(0),
    selectionDirty = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  const fail = useCallback(
    (e: unknown) => {
      if (!active.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setView(null);
        setItems([]);
        setDisclosures([]);
        setFiles([]);
        setPaste("");
        onExpired();
      }
      setError(e instanceof Error ? e.message : "자료 처리에 실패했습니다.");
    },
    [onExpired],
  );
  const list = useCallback(async () => {
    const [data, c, queue] = await Promise.all([
      api.get<{ items: typeof items }>("/imports"),
      api.get<NonNullable<typeof config>>("/imports/config"),
      api.get<{ items: Disclosure[] }>("/import-disclosures"),
    ]);
    if (active.current) {
      setItems(data.items);
      setConfig(c);
      setDisclosures(queue.items);
    }
  }, [api]);
  useEffect(() => {
    void list().catch(fail);
  }, [list, fail]);
  const open = useCallback(
    async (id: string, start = 0, replaceSelection = true) => {
      const current = ++generation.current;
      const next = await api.get<ImportView>(`/imports/${id}?offset=${start}`);
      if (active.current && current === generation.current) {
        setView(next);
        setOffset(start);
        if (replaceSelection && !selectionDirty.current)
          setSelection(next.selection);
      }
    },
    [api],
  );
  const pending = view?.runs.some((r) =>
    ["queued", "running"].includes(r.status),
  );
  useEffect(() => {
    if (!view?.id || !pending) return;
    const id = view.id;
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped) void open(id, offset, false).catch(fail);
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      generation.current++;
    };
  }, [view?.id, pending, offset, open, fail]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      if (active.current) await list();
    } catch (e) {
      fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const upload = () =>
    perform(async () => {
      const chosen = paste.trim()
        ? [...files, new File([paste], "붙여넣기.txt", { type: "text/plain" })]
        : files;
      if (!chosen.length) throw Error("텍스트나 파일을 먼저 선택하세요.");
      const payload = [] as {
        id: string;
        name: string;
        size: number;
        sha256: string;
        bytes: Uint8Array;
      }[];
      for (const f of chosen) {
        if (f.size > (config?.maxFileSize || 25 * 1024 * 1024))
          throw Error("파일별 최대 25 MiB입니다.");
        const bytes = new Uint8Array(await f.arrayBuffer());
        payload.push({
          id: crypto.randomUUID(),
          name: f.name,
          size: bytes.length,
          sha256: await checksum(bytes),
          bytes,
        });
      }
      let id: string;
      if (
        view?.status === "uploading" &&
        view.files.length === payload.length &&
        payload.every((f) =>
          view.files.some(
            (old) =>
              old.name === f.name &&
              old.size === f.size &&
              old.sha256 === f.sha256,
          ),
        )
      ) {
        id = view.id;
        for (const f of payload)
          f.id = view.files.find(
            (old) => old.name === f.name && old.sha256 === f.sha256,
          )!.id;
      } else {
        id = (
          await api.post<{ id: string }>(
            "/imports",
            {
              title: title.trim() || chosen[0].name,
              files: payload.map(({ bytes, ...metadata }) => metadata),
            },
            crypto.randomUUID(),
          )
        ).id;
      }
      let sent = 0;
      const total = payload.reduce((n, f) => n + f.size, 0);
      await open(id);
      for (const f of payload)
        for (
          let start = 0, part = 0;
          start < f.bytes.length;
          start += config?.partSize || 262144, part++
        ) {
          const bytes = f.bytes.subarray(
            start,
            start + (config?.partSize || 262144),
          );
          await api.post(`/imports/${id}/files/${f.id}/parts/${part}`, {
            data: base64(bytes),
            sha256: await checksum(bytes),
          });
          sent += bytes.length;
          if (active.current)
            setMessage(`선택 자료 업로드 ${Math.round((sent / total) * 100)}%`);
        }
      await api.post(`/imports/${id}/finalize`, {}, crypto.randomUUID());
      selectionDirty.current = false;
      await open(id);
      setFiles([]);
      setPaste("");
      setMessage(
        "업로드를 수락했습니다. 서버가 입력을 분석합니다. 탭을 닫아도 서버 수락 작업은 이어집니다. 로그아웃/취소는 실행을 제한합니다.",
      );
    });
  const saveSelection = async () => {
    if (!view) throw Error("먼저 자료를 선택하세요.");
    const result = await api.request<{ revision: number }>(
      `/imports/${view.id}/selection`,
      "PATCH",
      selection,
      undefined,
      { "If-Match": String(view.revision) },
    );
    selectionDirty.current = false;
    return result.revision;
  };
  const apply = () =>
    perform(async () => {
      if (!view) return;
      await saveSelection();
      await api.post(`/imports/${view.id}/finalize`, {}, crypto.randomUUID());
      await open(view.id);
    });
  const start = (mode: "model" | "offline") =>
    perform(async () => {
      if (!view) return;
      const revision = await saveSelection();
      await api.post(
        `/imports/${view.id}/runs`,
        { revision, mode },
        crypto.randomUUID(),
      );
      await open(view.id);
      setMessage(
        mode === "model"
          ? "근거와 기존 위키를 비교해 정리하고 있습니다. 공유 발행은 별도 검토를 거칩니다."
          : "구조 미리보기만 실행합니다. 모델 의미 종합이나 위키 반영은 수행하지 않습니다.",
      );
    });
  const update = <K extends keyof ImportSelection>(
    field: K,
    value: ImportSelection[K],
  ) => {
    selectionDirty.current = true;
    setSelection((s) => ({ ...s, [field]: value }));
  };
  const latest = view?.runs.find((r) => r.result);
  useEffect(() => {
    if (latest?.result)
      document
        .getElementById("import-result")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [latest?.id, latest?.status]);
  return (
    <section
      className="op-panel import-workbench"
      aria-label="자료 넣기와 자동 정리"
    >
      <div className="op-section-head">
        <h2>자료 넣기 · 자동 정리</h2>
        <Button
          disabled={busy}
          onClick={() =>
            perform(async () => {
              await list();
              if (view) await open(view.id, offset, false);
            })
          }
        >
          새로고침
        </Button>
      </div>
      <p>
        메신저 대화 내보내기, 문서, 메모를 넣으면 근거를 보존하며 기존 지식과
        비교해 정리합니다. 선택 자료는 개인 수집함에 저장되며 팀 공개는 별도
        검토가 필요합니다.
      </p>
      {error && (
        <div role="alert" className="op-error">
          {error}
        </div>
      )}
      {message && (
        <p role="status" className="op-notice">
          {message}
        </p>
      )}
      <div className="import-grid">
        <section aria-labelledby="import-input">
          <h3 id="import-input">1. 입력할 자료</h3>
          <label>
            자료 이름
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder="예: 플랫폼팀 10월 3주 대화"
            />
          </label>
          <label>
            텍스트 붙여넣기
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={6}
              placeholder="허용된 대화나 업무 메모만 선택해 넣으세요."
            />
          </label>
          <div
            className="import-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              setFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <label>
              파일 선택 또는 여기에 놓기
              <input
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.jsonl,.csv,.zip"
                onChange={(e) => setFiles(Array.from(e.target.files || []))}
              />
            </label>
            <p>
              TXT · Markdown · JSON/JSONL · CSV · Slack JSON ZIP / 파일별 25
              MiB, 전체 100 MiB
            </p>
            {files.map((f, i) => (
              <p key={i}>
                {f.name} · {Math.ceil(f.size / 1024)} KiB
              </p>
            ))}
          </div>
          <Button
            variant="primary"
            disabled={busy || (!files.length && !paste.trim())}
            onClick={upload}
          >
            {view?.status === "uploading"
              ? "같은 파일로 업로드 재개"
              : "개인 수집함에 업로드"}
          </Button>
          <p className="op-muted">
            원문은 서버에 저장됩니다. 파일의 URL/첨부는 자동으로 가져오지
            않습니다. 민감정보를 제외한 뒤 허용된 자료만 올리세요.
          </p>
        </section>
        <section aria-labelledby="import-inbox">
          <h3 id="import-inbox">개인 수집함</h3>
          {items.length ? (
            <ul className="import-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-current={view?.id === item.id ? "true" : undefined}
                    onClick={() =>
                      perform(async () => {
                        selectionDirty.current = false;
                        await open(item.id);
                      })
                    }
                  >
                    {item.title}{" "}
                    <span>{labels[item.status] || item.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>아직 넣은 자료가 없습니다.</p>
          )}
        </section>
      </div>
      {view && (
        <>
          <section className="import-section">
            <h3>2. 입력 범위 확인 · {view.title}</h3>
            <Badge>{labels[view.status] || view.status}</Badge>
            <Button
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "이 수집 자료와 개인 정리 결과를 삭제하고 공유 원본 접근을 철회합니다. 연결된 위키는 현재 원본 권한 검사로 차단됩니다. 계속할까요?",
                  )
                )
                  return;
                void perform(async () => {
                  await api.request(`/imports/${view.id}`, "DELETE", {});
                  generation.current++;
                  setView(null);
                  setSelection(defaultSelection);
                  setMessage(
                    "수집 자료를 삭제하고 공유 원본 접근을 철회했습니다.",
                  );
                });
              }}
            >
              자료 철회·삭제
            </Button>
            <div className="import-fields">
              <label>
                입력 형식
                <select
                  value={selection.format}
                  disabled={busy || pending}
                  onChange={(e) =>
                    update(
                      "format",
                      e.target.value as ImportSelection["format"],
                    )
                  }
                >
                  <option value="auto">자동 인식</option>
                  <option value="text">TXT/대화 텍스트</option>
                  <option value="json">공통 JSON/Slack JSON</option>
                  <option value="csv">CSV 컬럼 매핑</option>
                </select>
              </label>
              <label>
                인코딩
                <select
                  value={selection.encoding}
                  disabled={busy || pending}
                  onChange={(e) =>
                    update(
                      "encoding",
                      e.target.value as ImportSelection["encoding"],
                    )
                  }
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="euc-kr">한국어 EUC-KR/CP949</option>
                  <option value="utf-16le">UTF-16 LE</option>
                </select>
              </label>
              <label>
                원본 타임존
                <select
                  value={selection.timezone}
                  disabled={busy || pending}
                  onChange={(e) =>
                    update(
                      "timezone",
                      e.target.value as ImportSelection["timezone"],
                    )
                  }
                >
                  <option value="unknown">확인 안 됨</option>
                  <option value="Asia/Seoul">Asia/Seoul</option>
                  <option value="UTC">UTC</option>
                </select>
              </label>
              <label>
                기존 위키 관련 주제
                <input
                  value={selection.project}
                  disabled={busy || pending}
                  onChange={(e) => update("project", e.target.value)}
                  placeholder="예: Redis · 배포"
                />
              </label>
              <label>
                원본 대화 구분 ID
                <input
                  value={selection.namespace}
                  disabled={busy || pending}
                  onChange={(e) => update("namespace", e.target.value)}
                  placeholder="모르면 비워두기"
                />
              </label>
              <label>
                시작 날짜
                <input
                  type="date"
                  value={selection.from}
                  disabled={busy || pending}
                  onChange={(e) => update("from", e.target.value)}
                />
              </label>
              <label>
                종료 날짜
                <input
                  type="date"
                  value={selection.to}
                  disabled={busy || pending}
                  onChange={(e) => update("to", e.target.value)}
                />
              </label>
            </div>
            {(selection.format === "csv" ||
              view.parsed?.formats.includes("csv")) && (
              <fieldset>
                <legend>CSV 헤더 매핑</legend>
                <div className="import-fields">
                  {(
                    Object.keys(
                      selection.csv,
                    ) as (keyof ImportSelection["csv"])[]
                  ).map((key) => (
                    <label key={key}>
                      {
                        {
                          text: "본문",
                          author: "화자",
                          time: "시각",
                          id: "원본 ID",
                          conversation: "대화방",
                        }[key]
                      }
                      <input
                        value={selection.csv[key]}
                        onChange={(e) =>
                          update("csv", {
                            ...selection.csv,
                            [key]: e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="op-actions">
              <Button
                disabled={busy || pending || view.status === "uploading"}
                onClick={apply}
              >
                선택 적용 · 입력 다시 분석
              </Button>
              {selection.excludedIds.length > 0 && (
                <Button
                  disabled={busy || pending}
                  onClick={() => update("excludedIds", [])}
                >
                  제외 {selection.excludedIds.length}건 초기화
                </Button>
              )}
            </div>
            {view.parsed && (
              <>
                <p>
                  선택 {view.parsed.counts.selected}건 · 제외{" "}
                  {view.parsed.counts.excluded}건 · 입력 내 중복{" "}
                  {view.parsed.counts.duplicates}건 · 삭제 이벤트{" "}
                  {view.parsed.counts.deleted}건
                </p>
                {view.parsed.warnings.length > 0 && (
                  <details open>
                    <summary>
                      누락·불확실성 안내 {view.parsed.warnings.length}건
                    </summary>
                    <ul>
                      {view.parsed.warnings.slice(0, 20).map((w, i) => (
                        <li key={i}>{w.detail}</li>
                      ))}
                    </ul>
                    <label>
                      <input
                        type="checkbox"
                        checked={selection.acknowledgeWarnings}
                        onChange={(e) => {
                          setSelection((s) => ({
                            ...s,
                            acknowledgeWarnings: e.target.checked,
                          }));
                        }}
                      />
                      누락/제외·신원/원본 ACL 미확인 범위를 확인했습니다.
                    </label>
                  </details>
                )}
                <details>
                  <summary>
                    원문 확인 · {offset + 1}~
                    {Math.min(offset + 50, view.parsed.counts.selected)}건
                  </summary>
                  {view.parsed.records.map((r) => (
                    <article className="import-record" key={r.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!selection.excludedIds.includes(r.id)}
                          onChange={(e) =>
                            update(
                              "excludedIds",
                              e.target.checked
                                ? selection.excludedIds.filter(
                                    (id) => id !== r.id,
                                  )
                                : [...selection.excludedIds, r.id],
                            )
                          }
                        />
                        정리에 포함
                      </label>
                      <p>
                        {r.author} · {r.occurredRaw || "시각 미상"} · {r.event}{" "}
                        · {r.anchor.entry} / {r.anchor.location}
                      </p>
                      <pre>{r.text || "삭제 이벤트"}</pre>
                    </article>
                  ))}
                  <div className="op-actions">
                    <Button
                      disabled={busy || offset === 0}
                      onClick={() =>
                        perform(() =>
                          open(view.id, Math.max(0, offset - 50), false),
                        )
                      }
                    >
                      이전 50건
                    </Button>
                    <Button
                      disabled={
                        busy || offset + 50 >= view.parsed.counts.selected
                      }
                      onClick={() =>
                        perform(() => open(view.id, offset + 50, false))
                      }
                    >
                      다음 50건
                    </Button>
                  </div>
                </details>
                {selectionDirty.current && (
                  <p role="status">
                    입력 범위를 바꿨습니다. ‘선택 적용 · 입력 다시 분석’을 먼저
                    실행하세요.
                  </p>
                )}
                <div className="op-actions">
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      pending ||
                      selectionDirty.current ||
                      (view.parsed.warnings.length > 0 &&
                        !selection.acknowledgeWarnings)
                    }
                    onClick={() => start("model")}
                  >
                    선택 자료 자동 정리
                  </Button>
                  <Button
                    disabled={busy || pending || selectionDirty.current}
                    onClick={() => start("offline")}
                  >
                    구조만 확인 · 모델 미사용
                  </Button>
                </div>
              </>
            )}
          </section>
          <section className="import-section">
            <h3>3. 서버 처리 상태</h3>
            <p>
              탭 종료 후에도 서버 수락 작업은 이어집니다. 세션/권한 만료는 정지
              후 재인증이 필요합니다.
            </p>
            {view.runs.map((run) => (
              <article key={run.id} className="import-run">
                <strong>
                  {run.cancelRequested && run.status === "running"
                    ? "취소 요청됨 · 응답 정리 대기"
                    : labels[run.status] || run.status}
                </strong>{" "}
                · {run.stage} · 시도 {run.attempt}
                {run.errorCode && (
                  <p role="status">
                    {run.errorCode} · 입력/세션/모델 설정을 확인하세요. 실패한
                    결과는 반영하지 않았습니다.
                  </p>
                )}
                {["queued", "running"].includes(run.status) && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await api.post(`/import-runs/${run.id}/cancel`, {});
                        await open(view.id, offset, false);
                      })
                    }
                  >
                    작업 취소 요청
                  </Button>
                )}
                {["failed", "authorization_required", "cancelled"].includes(
                  run.status,
                ) && (
                  <Button
                    disabled={busy || pending}
                    onClick={() =>
                      perform(async () => {
                        await api.post(`/import-runs/${run.id}/resume`, {});
                        await open(view.id, offset, false);
                      })
                    }
                  >
                    현재 권한으로 재개
                  </Button>
                )}
                {run.changeSet && (
                  <Button onClick={onReview}>공유 변경 검토로 이동</Button>
                )}
              </article>
            ))}
          </section>
          {latest?.result && (
            <section className="import-section" id="import-result">
              <h3>4. 정리 후보 · 공유 전</h3>
              <p>
                처리 {latest.result.coverage.processed}/
                {latest.result.coverage.selected}건 · 모델 호출{" "}
                {latest.result.calls}회 ·{" "}
                {latest.result.mode === "model"
                  ? "모델 제안 · 사실/공식성 검증 아님"
                  : "구조 미리보기 · 의미 종합 미실행"}
              </p>
              {latest.result.topics.map((t) => (
                <article className="import-topic" key={t.key}>
                  <h4>{t.title}</h4>
                  <p>{t.summary}</p>
                  <p>
                    {t.targetPageId
                      ? `기존 페이지 갱신 제안: ${t.targetPageId}`
                      : "신규 지식 후보"}
                  </p>
                  <details open={t.statements.length <= 10}>
                    <summary>발언과 원문 근거 {t.statements.length}건</summary>
                    {t.statements.map((s, i) => (
                      <div className="import-statement" key={i}>
                        <Badge>{kinds[s.kind]}</Badge>
                        <p>{s.text}</p>
                        <p className="op-muted">{s.context}</p>
                        <blockquote>{s.quote}</blockquote>
                        <small>원문 근거 {s.recordId}</small>
                      </div>
                    ))}
                  </details>
                  <details>
                    <summary>제안할 전체 Markdown</summary>
                    <pre>{t.content}</pre>
                  </details>
                </article>
              ))}
              {latest.result.excluded.length > 0 && (
                <details>
                  <summary>
                    지식 후보에서 제외 {latest.result.excluded.length}건
                  </summary>
                  <ul>
                    {latest.result.excluded.slice(0, 50).map((e, i) => (
                      <li key={i}>
                        {e.reason} · {e.recordId}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {latest.status === "review_ready" && config?.personal && (
                <div>
                  <p>
                    개인 공간의 본인 전용 지식으로 저장합니다. 다른 사용자에게
                    공개되지 않습니다.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await api.post(
                          `/import-runs/${latest.id}/save-personal`,
                          {},
                        );
                        setMessage("내 개인 위키에 저장했습니다.");
                        onReview();
                      })
                    }
                  >
                    내 개인 위키에 저장
                  </Button>
                </div>
              )}
              {latest.status === "review_ready" && !config?.personal && (
                <fieldset>
                  <legend>선택 원본의 팀 공개 검토 요청</legend>
                  <p>
                    업로드한 대화는 현재 원본 ACL을 증명하지 않습니다. 별도
                    지정된 공개 검토자가 원본·새 독자를 검토해야 공유 변경안을
                    만들 수 있습니다. 지식 승인/발행은 그 다음 단계입니다.
                  </p>
                  <label>
                    공개 검토자
                    <select
                      aria-label="공개 검토자"
                      value={reviewer}
                      onChange={(e) => {
                        setReviewer(e.target.value);
                        setAudience((a) => [
                          ...new Set([...a, e.target.value]),
                        ]);
                      }}
                    >
                      <option value="">검토자 선택</option>
                      {config?.reviewers
                        .filter((id) => id !== identity.principalId)
                        .map((id) => (
                          <option value={id} key={id}>
                            {id}
                          </option>
                        ))}
                    </select>
                  </label>
                  {!config?.reviewers.length && (
                    <p>
                      서버에 공개 결정 담당자가 설정되지 않았습니다. 개인 정리는
                      사용할 수 있고, 조직이 지정한 담당자 설정 후 팀 공유를
                      요청할 수 있습니다.
                    </p>
                  )}
                  <fieldset>
                    <legend>승인 후 공유할 독자</legend>
                    {members.map((m) => (
                      <label className="import-reader" key={m.principalId}>
                        <input
                          type="checkbox"
                          checked={audience.includes(m.principalId)}
                          disabled={
                            m.principalId === identity.principalId ||
                            m.principalId === reviewer
                          }
                          onChange={(e) =>
                            setAudience((a) =>
                              e.target.checked
                                ? [...a, m.principalId]
                                : a.filter((id) => id !== m.principalId),
                            )
                          }
                        />
                        {m.principalId} · {m.role}
                      </label>
                    ))}
                  </fieldset>
                  <Button
                    disabled={busy || !reviewer || identity.role === "reader"}
                    onClick={() =>
                      perform(async () => {
                        await api.post(`/import-runs/${latest.id}/disclosure`, {
                          reviewerId: reviewer,
                          readers: audience,
                          sourceAuthorization:
                            "request_authorized_source_review",
                        });
                        setMessage(
                          "선택한 원본/정리 결과만 공개 검토자에게 제출했습니다. 나머지 개인 수집함은 공유하지 않았습니다.",
                        );
                      })
                    }
                  >
                    선택 원본과 새 독자 검토 요청
                  </Button>
                </fieldset>
              )}
            </section>
          )}
        </>
      )}
      {config?.canReviewDisclosure && (
        <section className="import-section">
          <h3>내게 요청된 원본 공개 검토</h3>
          <p>
            이 승인은 선택 원본의 공개 결정을 기록합니다. 공식 지식 승인/발행은
            변경 검토에서 별도로 수행합니다.
          </p>
          {disclosures.length ? (
            disclosures.map((d) => (
              <article key={d.id} className="import-topic">
                <h4>{d.title}</h4>
                <p>
                  제안자 {d.authorId} · 공개 대상 {d.audience.join(", ")}
                </p>
                <p>
                  입력의 공개 권한·누락/민감 정보·현재 근거 접근을 확인하세요.
                </p>
                <details>
                  <summary>제출된 선택 원본 {d.records.length}건</summary>
                  {d.records.map((r) => (
                    <div className="import-record" key={r.id}>
                      <strong>
                        {r.author} · {r.occurredRaw || "시각 미상"}
                      </strong>
                      <pre>{r.text}</pre>
                    </div>
                  ))}
                </details>
                {d.result.topics.map((t) => (
                  <details key={t.key}>
                    <summary>{t.title} · 전체 제안</summary>
                    <pre>{t.content}</pre>
                  </details>
                ))}
                <Button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api.post(
                        `/import-runs/${d.id}/approve-disclosure`,
                        { hash: d.hash },
                      );
                      setMessage(
                        "원본 공개 결정을 기록하고 공유 변경안을 만들었습니다. 변경 검토에서 별도 승인·발행하세요.",
                      );
                      onReview();
                    })
                  }
                >
                  이 원본·독자 공개 승인 및 변경안 생성
                </Button>
              </article>
            ))
          ) : (
            <p>현재 접근 가능한 공개 검토 요청이 없습니다.</p>
          )}
        </section>
      )}
    </section>
  );
}
