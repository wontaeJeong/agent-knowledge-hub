import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, OperationalApi } from "./api";
import { resolveJob } from "./jobs-client";
type Answer = {
  id: string;
  version: number;
  content: string;
  insufficient: boolean;
  citations: { pageId: string; version: number; title: string }[];
};
type Thread = {
  id: string;
  revision: number;
  title: string;
  contextOmitted: boolean;
  turns: {
    id: string;
    question: string;
    mode: string;
    status: string;
    jobId: string | null;
    answer: Answer | null;
  }[];
};
type SearchItem = {
  pageId: string;
  version: number;
  title: string | null;
  content: string;
  historical: boolean;
  currentRecommendation: boolean;
  metadataStatus: string;
  href: string;
};
type SearchPage = { items: SearchItem[]; nextCursor: string | null };
type FeedbackItem = {
  id: string;
  answerId: string;
  version: number;
  category: string;
  reason: string;
  work: {
    pageId: string;
    version: number;
    status: string;
    recipientIds: string[];
  }[];
};
const root = "/questions";
type TurnRequest = {
  threadId: string;
  expectedRevision: number;
  question: string;
  mode: "offline" | "model";
  nonce: string;
};
export function questionRequest(
  previous: TurnRequest | null,
  threadId: string,
  revision: number,
  question: string,
  mode: "offline" | "model",
  makeNonce: () => string = () => crypto.randomUUID(),
): TurnRequest {
  if (
    previous &&
    previous.threadId === threadId &&
    previous.question === question &&
    previous.mode === mode
  )
    return previous;
  return {
    threadId,
    expectedRevision: revision,
    question,
    mode,
    nonce: makeNonce(),
  };
}
/** No browser persistence: protected prompts/history are cleared on scope/identity failure. */
export function QuestionsWorkbench({
  api,
  identityKey,
}: {
  api: OperationalApi;
  identityKey: string;
}) {
  const [boundIdentity, setBoundIdentity] = useState(identityKey);
  const [thread, setThread] = useState<Thread | null>(null),
    [threads, setThreads] = useState<{ id: string; revision: number }[]>([]),
    [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [question, setQuestion] = useState(""),
    [mode, setMode] = useState<"offline" | "model">("offline"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [turnPage, setTurnPage] = useState(0);
  const [results, setResults] = useState<SearchPage>({
      items: [],
      nextCursor: null,
    }),
    [search, setSearch] = useState({
      query: "",
      type: "",
      businessOwner: "",
      tags: "",
      state: "",
      project: "",
      environment: "",
      periodFrom: "",
      periodTo: "",
      reviewDateFrom: "",
      reviewDateTo: "",
      archived: "",
      historical: false,
    });
  const [feedbackAnswer, setFeedbackAnswer] = useState<Answer | null>(null),
    [category, setCategory] = useState("incorrect"),
    [reason, setReason] = useState("");
  const [feedbackInbox, setFeedbackInbox] = useState<{
    items: FeedbackItem[];
    nextCursor: string | null;
  }>({ items: [], nextCursor: null });
  const accepted = useRef<TurnRequest | null>(null),
    feedbackNonce = useRef(""),
    generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  function clear() {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setThread(null);
    setThreads([]);
    setResults({ items: [], nextCursor: null });
    setQuestion("");
    setReason("");
    setFeedbackAnswer(null);
    setFeedbackInbox({ items: [], nextCursor: null });
    setSearch({
      query: "",
      type: "",
      businessOwner: "",
      tags: "",
      state: "",
      project: "",
      environment: "",
      periodFrom: "",
      periodTo: "",
      reviewDateFrom: "",
      reviewDateTo: "",
      archived: "",
      historical: false,
    });
    accepted.current = null;
    feedbackNonce.current = "";
  }
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : "요청을 처리하지 못했습니다.");
    if (
      e instanceof ApiError &&
      ([401, 403, 404].includes(e.status) ||
        [
          "STALE_VERSION",
          "POLICY_CHANGED",
          "MODEL_POLICY_CHANGED",
          "FEATURE_DISABLED",
        ].includes(e.code))
    )
      clear();
  }
  async function list(cursor?: string) {
    const current = generation.current;
    const data = await api.get<{
      items: { id: string; revision: number }[];
      nextCursor: string | null;
    }>(
      `${root}/threads${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (current === generation.current) {
      setThreads(data.items);
      setThreadCursor(data.nextCursor);
    }
  }
  async function read(id: string) {
    const current = generation.current;
    const value = await api.get<Thread>(
      `${root}/threads/${encodeURIComponent(id)}`,
    );
    if (current === generation.current) {
      setThread(value);
      setTurnPage(Math.max(0, Math.ceil(value.turns.length / 25) - 1));
    }
    return value;
  }
  useEffect(() => {
    clear();
    const current = generation.current;
    setBoundIdentity(identityKey);
    setError("");
    setNotice("");
    void api
      .get<{
        items: { id: string; revision: number }[];
        nextCursor: string | null;
      }>(`${root}/threads`)
      .then((r) => {
        if (generation.current === current) {
          setThreads(r.items);
          setThreadCursor(r.nextCursor);
        }
      })
      .catch((e) => {
        if (generation.current === current) fail(e);
      });
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [api, identityKey]);
  // Refresh protected state when returning to this screen; never resurrect from localStorage.
  useEffect(() => {
    const id = thread?.id;
    if (!id) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void read(id).catch(fail);
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [api, thread?.id]);
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const current = generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    try {
      let target = thread;
      if (!target) {
        const created = await api.post<{ id: string; revision: number }>(
          `${root}/threads`,
          {},
        );
        target = {
          ...created,
          title: "새 대화",
          turns: [],
          contextOmitted: false,
        };
        if (generation.current !== current) return;
        setThread(target);
      }
      accepted.current = questionRequest(
        accepted.current,
        target.id,
        target.revision,
        question,
        mode,
      );
      const { threadId: _threadId, ...request } = accepted.current;
      const receipt = await api.post(
        `${root}/threads/${encodeURIComponent(target.id)}/turns`,
        request,
        request.nonce,
      );
      await resolveJob(api, receipt, {
        expectQueued: true,
        signal: abort.signal,
        onProgress: (j) => {
          if (generation.current === current)
            setNotice(
              `작업 ${j.id} · ${j.status} (접수는 답변 완료가 아닙니다)`,
            );
        },
      });
      if (generation.current !== current) return;
      await read(target.id);
      setQuestion("");
      accepted.current = null;
      setNotice(
        mode === "offline"
          ? "발행본의 실제 발췌가 완료되었습니다. 의미 모델 답변이 아닙니다."
          : "모델 답변을 저장했습니다. 근거와 적용 조건을 확인하세요.",
      );
      await list();
    } catch (e) {
      if (generation.current === current) fail(e);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  function searchBody(cursor?: string | null) {
    const entries = Object.fromEntries(
      Object.entries(search).filter(
        ([k, v]) => k !== "tags" && k !== "archived" && v !== "",
      ),
    );
    return {
      ...entries,
      tags: search.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      ...(search.archived ? { archived: search.archived === "true" } : {}),
      limit: 25,
      ...(cursor ? { cursor } : {}),
    };
  }
  async function find(event?: FormEvent, cursor?: string | null) {
    event?.preventDefault();
    setError("");
    const current = generation.current;
    try {
      const page = await api.post<SearchPage>(
        `${root}/search`,
        searchBody(cursor),
      );
      if (current === generation.current) setResults(page);
    } catch (e) {
      if (current === generation.current) {
        setResults({ items: [], nextCursor: null });
        fail(e);
      }
    }
  }
  async function report(event: FormEvent) {
    event.preventDefault();
    if (!feedbackAnswer || busy) return;
    setBusy(true);
    setError("");
    feedbackNonce.current ||= crypto.randomUUID();
    const current = generation.current;
    try {
      const result = await api.post<{ work: { status: string }[] }>(
        `${root}/feedback`,
        {
          answerId: feedbackAnswer.id,
          version: feedbackAnswer.version,
          category,
          reason,
          nonce: feedbackNonce.current,
        },
        feedbackNonce.current,
      );
      if (generation.current !== current) return;
      setNotice(
        result.work.some((w) => w.status === "pending-unassigned")
          ? "피드백이 접수되었으나 일부 문서는 담당자 미배정입니다. 승인·실행 검증이 아닙니다."
          : "고정 답변·문서 버전의 재검토 후보를 담당자에게 등록했습니다. 승인·실행 검증이 아닙니다.",
      );
      setFeedbackAnswer(null);
      setReason("");
      feedbackNonce.current = "";
    } catch (e) {
      if (current === generation.current) fail(e);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function readFeedback(cursor?: string | null) {
    const current = generation.current;
    try {
      const result = await api.get<{
        items: FeedbackItem[];
        nextCursor: string | null;
      }>(
        `${root}/feedback${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (current === generation.current) setFeedbackInbox(result);
    } catch (e) {
      if (current === generation.current) fail(e);
    }
  }
  const fields = [
    ["type", "문서 유형"],
    ["businessOwner", "업무 담당자"],
    ["tags", "태그 (쉼표 구분)"],
    ["state", "문서 상태"],
    ["project", "프로젝트"],
    ["environment", "환경"],
    ["periodFrom", "작성 기간 시작 (ISO 날짜·시간)"],
    ["periodTo", "작성 기간 끝 (ISO 날짜·시간)"],
    ["reviewDateFrom", "검토 예정일 시작 (ISO 날짜·시간)"],
    ["reviewDateTo", "검토 예정일 끝 (ISO 날짜·시간)"],
  ] as const;
  if (boundIdentity !== identityKey)
    return (
      <section role="status">
        사용자·공간 변경을 확인하는 동안 이전 보호 내용을 숨겼습니다.
      </section>
    );
  return (
    <section aria-label="질문과 검색" className="panel">
      <h2>질문과 후속 대화</h2>
      <p>
        대화는 작성자에게만 보입니다. 후속 질문마다 현재 접근권한·원본·전송
        정책을 다시 확인합니다. 발췌·모델 결과와 독립 실행 증거는 다릅니다.
      </p>
      {error && (
        <p role="alert">
          {error} 권한·정책이 바뀌면 보호된 화면 내용을 지웁니다. 새로
          조회하세요.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <nav aria-label="내 대화">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            controller.current?.abort();
            setThread(null);
            setQuestion("");
            accepted.current = null;
          }}
        >
          새 대화
        </button>
        {threads.map((t) => (
          <button
            type="button"
            disabled={busy}
            key={t.id}
            onClick={() => {
              setQuestion("");
              accepted.current = null;
              void read(t.id).catch(fail);
            }}
          >
            대화 {t.id}
          </button>
        ))}
        {threadCursor && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void list(threadCursor).catch(fail)}
          >
            다음 대화 25건
          </button>
        )}
      </nav>
      {thread && (
        <>
          <h3>{thread.title}</h3>
          {thread.contextOmitted && (
            <p role="status">
              접근권한·원본·전송 정책 변경으로 이전 내 대화 일부를 제외했습니다.
              제외된 내용은 다시 보내지 않습니다.
            </p>
          )}
          <ol>
            {thread.turns
              .slice(turnPage * 25, (turnPage + 1) * 25)
              .map((turn) => (
                <li key={turn.id}>
                  <h4>질문</h4>
                  <p
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {turn.question}
                  </p>
                  {turn.answer ? (
                    <>
                      <p>
                        {turn.mode === "offline"
                          ? "오프라인 발췌"
                          : "모델 답변"}{" "}
                        · 고정 답변 v{turn.answer.version}
                      </p>
                      <p
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {turn.answer.content}
                      </p>
                      {turn.answer.insufficient && (
                        <p>근거가 부족합니다. 공식 지식으로 간주하지 마세요.</p>
                      )}
                      <ul>
                        {turn.answer.citations.map((c, i) => (
                          <li key={i}>
                            <a
                              href={`/api/v1/pages/${encodeURIComponent(c.pageId)}/versions/${c.version}`}
                            >
                              {c.title} · v{c.version}
                            </a>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={() => {
                          setFeedbackAnswer(turn.answer);
                          setReason("");
                          feedbackNonce.current = "";
                        }}
                      >
                        이 답변의 오류·인용·노출 신고
                      </button>
                    </>
                  ) : (
                    <p>
                      답변 미완료 · {turn.status}
                      {turn.jobId ? ` · 작업 ${turn.jobId}` : ""}
                    </p>
                  )}
                </li>
              ))}
          </ol>
          {turnPage > 0 && (
            <button type="button" onClick={() => setTurnPage((p) => p - 1)}>
              이전 대화 25건
            </button>
          )}
          {(turnPage + 1) * 25 < thread.turns.length && (
            <button type="button" onClick={() => setTurnPage((p) => p + 1)}>
              다음 대화 25건
            </button>
          )}
        </>
      )}
      <form onSubmit={ask}>
        <label>
          질문
          <textarea
            required
            maxLength={20000}
            value={question}
            disabled={busy}
            onChange={(e) => {
              setQuestion(e.target.value);
              accepted.current = null;
            }}
          />
        </label>
        <label>
          실행 방식
          <select
            value={mode}
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as "offline" | "model");
              accepted.current = null;
            }}
          >
            <option value="offline">오프라인 — 발행본 발췌</option>
            <option value="model">정책이 허용한 실제 모델</option>
          </select>
        </label>
        <p>
          복사한 인용문도 원본 정책의 적용 대상입니다. 자유 입력의 출처를
          자동으로 증명할 수는 없습니다.
        </p>
        <button disabled={busy || !question.trim()}>
          {busy ? "작업 상태 확인 중…" : "질문 접수"}
        </button>
      </form>
      {feedbackAnswer && (
        <form onSubmit={report}>
          <h3>고정 답변 피드백 · v{feedbackAnswer.version}</h3>
          <p>재검토 요청이며 승인·독립 실행 증거가 아닙니다.</p>
          <label>
            유형
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                feedbackNonce.current = "";
              }}
            >
              <option value="incorrect">내용 오류</option>
              <option value="citationmissing">인용 누락</option>
              <option value="exposure">정보 노출</option>
            </select>
          </label>
          <label>
            이유
            <textarea
              required
              maxLength={5000}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                feedbackNonce.current = "";
              }}
            />
          </label>
          <button disabled={busy || !reason.trim()}>재검토 요청 등록</button>
          <button
            type="button"
            onClick={() => {
              setFeedbackAnswer(null);
              setReason("");
            }}
          >
            취소
          </button>
        </form>
      )}
      <details>
        <summary>답변 피드백 재검토함</summary>
        <p>
          신고자의 주장과 정확한 문서 버전을 검토합니다. 승인·검증 상태를
          자동으로 바꾸지 않으며 다른 사람의 비공개 질문·답변 본문은 제공하지
          않습니다.
        </p>
        <button type="button" onClick={() => void readFeedback()}>
          현재 허용된 재검토 후보 조회
        </button>
        <ul>
          {feedbackInbox.items.map((item) => (
            <li key={item.id}>
              <h3>
                답변 {item.answerId} · v{item.version}
              </h3>
              <p>
                {item.category === "incorrect"
                  ? "내용 오류"
                  : item.category === "citationmissing"
                    ? "인용 누락"
                    : "정보 노출"}{" "}
                · 미검증 주장
              </p>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {item.reason}
              </p>
              <ul>
                {item.work.map((w) => (
                  <li key={`${w.pageId}:${w.version}`}>
                    <a
                      href={`/api/v1/pages/${encodeURIComponent(w.pageId)}/versions/${w.version}`}
                    >
                      {w.pageId} · v{w.version}
                    </a>{" "}
                    ·{" "}
                    {w.status === "pending-unassigned"
                      ? "담당자 미배정"
                      : "재검토 대기"}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {feedbackInbox.nextCursor && (
          <button
            type="button"
            onClick={() => void readFeedback(feedbackInbox.nextCursor)}
          >
            다음 피드백 25건
          </button>
        )}
      </details>
      <h2>범위·과거 버전 검색</h2>
      <p>
        과거 버전은 현재 권고가 아닙니다. 기록하지 않았던 과거 속성은 ‘알 수
        없음’이며 현재 속성으로 채우지 않습니다.
      </p>
      <form onSubmit={find}>
        <label>
          본문·제목 검색
          <input
            maxLength={2000}
            value={search.query}
            onChange={(e) => {
              setSearch((s) => ({ ...s, query: e.target.value }));
              setResults({ items: [], nextCursor: null });
            }}
          />
        </label>
        <details>
          <summary>유형·담당자·태그·상태·기간·환경 필터</summary>
          {fields.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                maxLength={200}
                value={search[key]}
                onChange={(e) => {
                  setSearch((s) => ({ ...s, [key]: e.target.value }));
                  setResults({ items: [], nextCursor: null });
                }}
              />
            </label>
          ))}
          <label>
            보관 여부
            <select
              value={search.archived}
              onChange={(e) => {
                setSearch((s) => ({ ...s, archived: e.target.value }));
                setResults({ items: [], nextCursor: null });
              }}
            >
              <option value="">모두</option>
              <option value="true">보관됨</option>
              <option value="false">보관되지 않음</option>
            </select>
          </label>
        </details>
        <label>
          <input
            type="checkbox"
            checked={search.historical}
            onChange={(e) => {
              setSearch((s) => ({ ...s, historical: e.target.checked }));
              setResults({ items: [], nextCursor: null });
            }}
          />
          실제 과거 버전 포함 (현재 권고 아님)
        </label>
        <button>검색</button>
      </form>
      <ul>
        {results.items.map((item) => (
          <li key={`${item.pageId}:${item.version}`}>
            <a href={item.href}>
              {item.title ?? "과거 제목 기록 없음"} · v{item.version}
            </a>
            <p>
              {item.historical
                ? "과거 버전 · 현재 권고 아님"
                : item.currentRecommendation
                  ? "현재 권고 대상"
                  : "현재 권고 대상 아님"}{" "}
              ·{" "}
              {item.metadataStatus === "unknown"
                ? "과거 속성 알 수 없음"
                : "기록된 속성"}
            </p>
            <details>
              <summary>고정 버전 본문</summary>
              <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {item.content}
              </p>
            </details>
          </li>
        ))}
      </ul>
      {results.nextCursor && (
        <button
          type="button"
          onClick={() => void find(undefined, results.nextCursor)}
        >
          다음 결과 25건
        </button>
      )}
    </section>
  );
}
