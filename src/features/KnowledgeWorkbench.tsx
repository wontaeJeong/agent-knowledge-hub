import { useEffect, useState } from "react";
import {
  BookOpen,
  GitBranch,
  Search,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  Loader2,
  Link2,
  FileText,
} from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Button, Badge, Empty } from "../ui/primitives";
import type { State, Source } from "../domain/types";
import { makeId } from "../domain/id";
import {
  compileOffline,
  createBatch,
  enqueueBatch,
  memory,
  decideBatch,
  answerOffline,
  saveAnswer,
  fileAnswer,
  runLint,
  current,
  readable,
} from "../domain/wiki";
import type { Mode } from "../domain/wiki";
import { compileModel, answerModel } from "../adapters/model";

const example = `## 지식: Python requests의 CA 번들
적용 환경: Debian 12 / Python 3.12 / requests 2.x
시스템에 사내 CA를 설치해도 requests가 certifi 번들을 사용하면 실패할 수 있습니다.
REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt 를 지정하고 사내 테스트 URL에서 200 응답을 확인했습니다.
- 사실: requests-ca-bundle | Debian12/requests2.x | 별도 경로 지정 필요
예외: 라이브러리와 이미지에 따라 CA 경로가 다를 수 있습니다. TLS 검증은 유지합니다.

## 지식: Debian 이미지의 TLS 검증
승인된 CA를 /usr/local/share/ca-certificates/에 복사한 다음 update-ca-certificates를 실행합니다.
검증 결과: Debian 12 테스트 컨테이너에서 HTTPS 호출 성공.
- 사실: tls-verification | Debian12 | 활성화 유지
원본은 합성 실행 기록입니다. 실제 사내 환경 검증을 대체하지 않습니다.`;
const conflicting = `## 지식: Python requests의 CA 번들
과거 작업자가 남긴 상충하는 합성 기록입니다. 현재 권고로 채택하지 마세요.
- 사실: requests-ca-bundle | Debian12/requests2.x | 별도 경로 지정 불필요
동일 적용 조건의 이전 기록과 다르므로 재현 검증이 필요합니다.`;
const issueNames = {
  "broken-link": "깨진 연결",
  orphan: "고립 페이지",
  stale: "검증 시점",
  contradiction: "상충 기록",
  "missing-evidence": "근거 누락",
};
const statusNames = {
  pending: "검토 대기",
  approved: "승인됨",
  published: "발행됨",
  rejected: "반려됨",
  conflict: "충돌 · 재실행 필요",
};
function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(
          marked.parse(text, { async: false }) as string,
        ),
      }}
    />
  );
}
export function KnowledgeWorkbench({
  state,
  apply,
  notify,
  initialTab,
}: {
  state: State;
  apply: (fn: (s: State) => State) => boolean;
  notify: (text: string) => void;
  initialTab?: string;
}) {
  const [tab, setTab] = useState(initialTab ?? "ingest");
  const [mode, setMode] = useState<Mode>("offline");
  const [config, setConfig] = useState<{ configured: boolean; model?: string }>(
    { configured: false },
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sourceTitle, setSourceTitle] = useState(
    "Python HTTPS 문제 해결 · 실행 산출물",
  );
  const [sourceText, setSourceText] = useState(example);
  const [question, setQuestion] = useState(
    "Python requests 인증서 오류를 어떻게 해결하고 검증하나요?",
  );
  const [target, setTarget] = useState("container-ca");
  const [preview, setPreview] = useState<string | null>(null);
  const k = memory(state),
    pages = readable(state),
    canWrite = state.role !== "reader";
  const sources = state.sources.filter(
    (s) =>
      s.scope !== "private" &&
      (state.role !== "reader" || s.scope === "company"),
  );
  const visibleBatches = k.batches.filter((b) =>
    b.updates.every((d) => state.role !== "reader" || d.scope === "company"),
  );
  const answers = k.answers.filter((a) =>
    a.citations.every((c) => pages.some((p) => p.id === c.pageId)),
  );
  useEffect(() => {
    fetch("/api/model/config")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then(setConfig)
      .catch(() => setConfig({ configured: false }));
  }, []);
  async function ingest() {
    setError("");
    setBusy("ingest");
    try {
      const ids = selected.length
        ? selected
        : sources.filter((s) => !s.processed).map((s) => s.id);
      const b =
        mode === "model"
          ? await compileModel(state, ids)
          : createBatch(state, compileOffline(state, ids), ids, "offline");
      if (apply((s) => enqueueBatch(s, b))) {
        setSelected([]);
        notify(`${b.updates.length}개 페이지의 변경 집합을 생성했습니다.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function ask() {
    setError("");
    setBusy("query");
    try {
      const a =
        mode === "model"
          ? await answerModel(state, question)
          : answerOffline(state, question);
      apply((s) => saveAnswer(s, a));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function register(conflict = false) {
    setError("");
    const p = pages.find((p) => p.id === target);
    if (!p || !sourceTitle.trim() || !sourceText.trim()) {
      setError("제목·본문·대상 지식을 입력하세요.");
      return;
    }
    const src: Source = {
      id: makeId(),
      title: conflict ? "동일 조건의 상충 실험 기록" : sourceTitle,
      content: conflict ? conflicting : sourceText,
      scope: p.scope,
      project: "platform-runtime",
      tool: "데모 산출물",
      verification: "미검증",
      createdAt: new Date().toISOString(),
      processed: false,
      targetPageId: target,
    };
    if (
      apply((s) => {
        if (s.role === "reader") throw Error("독자는 등록할 수 없습니다.");
        return { ...s, sources: [src, ...s.sources] };
      })
    ) {
      setSelected([src.id]);
      notify("원본을 수집함에 보존했습니다. 편입을 실행하세요.");
    }
  }
  return (
    <div className="page-wrap compiler">
      <div className="page-heading">
        <div className="title-with-icon">
          <Sparkles size={28} />
          <div>
            <h1>지식 컴파일</h1>
            <p>자료를 연결하고, 질문으로 확장하고, 점검하며 축적합니다.</p>
          </div>
        </div>
        <Badge tone="plum">Ingest · Query · Lint</Badge>
      </div>
      <div className="compiler-mode">
        <label>
          실행 엔진{" "}
          <select
            value={mode}
            disabled={!!busy}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            <option value="offline">오프라인 · 구조 기반</option>
            <option value="model" disabled={!config.configured}>
              연결된 모델
              {config.configured ? ` · ${config.model}` : " · 서버 설정 필요"}
            </option>
          </select>
        </label>
        <span>
          {mode === "offline"
            ? "원본의 ‘## 지식:’와 ‘사실:’를 읽습니다. 자연어 의미 추론은 하지 않습니다."
            : "선택한 자료와 관련 발행본을 서버에 설정한 모델로 전송합니다."}
        </span>
      </div>
      <div className="tabs compiler-tabs">
        {[
          ["ingest", "자료 편입", <GitBranch size={16} />],
          ["query", "질문과 축적", <Search size={16} />],
          ["lint", "주간 점검", <ShieldCheck size={16} />],
          ["index", "지식 인덱스", <BookOpen size={16} />],
        ].map(([id, label, icon]) => (
          <button
            key={id as string}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id as string);
              setError("");
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="compiler-error" role="alert">
          {error}
        </div>
      )}
      {tab === "ingest" && (
        <>
          <div className="compiler-grid">
            <section className="compiler-panel">
              <div className="section-title">
                <h2>1. 원본 등록</h2>
                <Badge>RAW</Badge>
              </div>
              <p className="muted">
                LLM과 해결한 업무 결과와 실행 근거를 선택해서 남기세요.
              </p>
              <label className="field">
                <span>산출물 제목</span>
                <input
                  value={sourceTitle}
                  onChange={(e) => setSourceTitle(e.target.value)}
                />
              </label>
              <label className="field">
                <span>연결할 주제</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {pages
                    .filter((p) => p.scope !== "private")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>산출물과 검증 기록</span>
                <textarea
                  rows={12}
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                />
              </label>
              <div className="compiler-actions">
                <Button
                  variant="primary"
                  disabled={!canWrite || !!busy}
                  onClick={() => register()}
                >
                  원본 등록
                </Button>
                <Button
                  variant="ghost"
                  disabled={!canWrite || !!busy}
                  onClick={() => register(true)}
                >
                  상충 자료 예시 등록
                </Button>
              </div>
            </section>
            <section className="compiler-panel">
              <div className="section-title">
                <h2>2. 위키로 편입</h2>
                <Badge>
                  {sources.filter((s) => !s.processed).length}개 대기
                </Badge>
              </div>
              <p className="muted">
                원본은 유지하고 주제·개념 페이지와 연결을 함께 제안합니다.
              </p>
              <div className="compiler-source-list">
                {sources.map((s) => (
                  <label className="compiler-source" key={s.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(s.id)}
                      disabled={!canWrite || !!busy}
                      onChange={(e) =>
                        setSelected((prev) =>
                          e.target.checked
                            ? [...prev, s.id]
                            : prev.filter((x) => x !== s.id),
                        )
                      }
                    />
                    <span>
                      <strong>{s.title}</strong>
                      <small>
                        {s.processed ? "편입 완료 · 재편입 가능" : "편입 대기"}{" "}
                        · {s.scope} · {s.verification}
                      </small>
                    </span>
                    <details>
                      <summary>원본</summary>
                      <pre>{s.content}</pre>
                    </details>
                  </label>
                ))}
              </div>
              <Button
                variant="primary"
                disabled={!canWrite || !!busy}
                onClick={ingest}
              >
                {busy === "ingest" ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Sparkles size={15} />
                )}{" "}
                {busy === "ingest" ? "자료와 위키 종합 중…" : "선택 자료 편입"}
              </Button>
              <p className="muted">
                선택하지 않으면 편입 대기 자료를 처리합니다. 승인 전에는
                발행본이 바뀌지 않습니다.
              </p>
            </section>
          </div>
          <div className="section-title">
            <h2>3. 변경 집합 검토</h2>
            <span>{visibleBatches.length}개 집합</span>
          </div>
          {!visibleBatches.length && (
            <Empty
              title="자료를 위키로 편입해보세요"
              description="기존 주제와 새 개념 페이지가 한 변경 집합으로 도착합니다."
            />
          )}
          {visibleBatches.map((b) => (
            <section className="compiler-panel batch-card" key={b.id}>
              <div className="section-title">
                <h2>{b.title}</h2>
                <Badge
                  tone={
                    b.status === "published"
                      ? "green"
                      : b.status === "conflict"
                        ? "red"
                        : "amber"
                  }
                >
                  {statusNames[b.status]}
                </Badge>
              </div>
              <p>{b.reason}</p>
              <div className="batch-meta">
                {b.mode === "model" ? "모델 생성" : "오프라인 구조 편입"} ·{" "}
                {b.updates.length}개 페이지 · 원본 {b.snapshots.length}개 ·{" "}
                {b.policyVersion}
              </div>
              {b.updates.map((d) => (
                <details key={d.id} className="draft-detail">
                  <summary>
                    <FileText size={15} />
                    {d.title}
                    <Badge>
                      {d.baseVersion
                        ? `v${d.baseVersion} → v${d.baseVersion + 1}`
                        : "새 페이지"}
                    </Badge>
                    <span>{d.links.length}개 연결</span>
                  </summary>
                  <div className="compiler-diff">
                    <div>
                      <h4>현재 발행본</h4>
                      <pre>
                        {state.pages.find((p) => p.id === d.id)
                          ? current(state.pages.find((p) => p.id === d.id)!)
                              .content
                          : "새로 만드는 지식입니다."}
                      </pre>
                    </div>
                    <div>
                      <h4>제안된 전체 내용</h4>
                      <Markdown text={d.content} />
                    </div>
                  </div>
                </details>
              ))}
              <div className="compiler-actions">
                <span className="muted">
                  모든 페이지의 기준 버전·원본·범위를 함께 검사합니다.
                </span>
                {["pending", "approved"].includes(b.status) && (
                  <Button
                    disabled={state.role !== "reviewer" || !!busy}
                    onClick={() => apply((s) => decideBatch(s, b.id, "reject"))}
                  >
                    반려
                  </Button>
                )}
                {b.status === "pending" && (
                  <Button
                    variant="primary"
                    disabled={state.role !== "reviewer" || !!busy}
                    onClick={() =>
                      apply((s) => decideBatch(s, b.id, "approve"))
                    }
                  >
                    변경 집합 승인
                  </Button>
                )}
                {b.status === "approved" && (
                  <Button
                    variant="primary"
                    disabled={state.role !== "reviewer" || !!busy}
                    onClick={() =>
                      apply((s) => decideBatch(s, b.id, "publish"))
                    }
                  >
                    승인 집합 전체 발행
                  </Button>
                )}
                {b.status === "published" && (
                  <Button onClick={() => setTab("index")}>
                    인덱스 보기 <ArrowRight size={14} />
                  </Button>
                )}
              </div>
            </section>
          ))}
        </>
      )}
      {tab === "query" && (
        <>
          <section className="compiler-panel">
            <h2>발행된 위키에 질문하기</h2>
            <p className="muted">
              자료 편입·승인·발행 후 질문하면 새 지식이 답변의 근거로 쓰입니다.
            </p>
            <label className="field">
              <span>업무 질문</span>
              <textarea
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <div className="compiler-actions">
              <Button
                variant="primary"
                disabled={!!busy || !question.trim()}
                onClick={ask}
              >
                {busy === "query" ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Search size={15} />
                )}{" "}
                위키에 질문
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  setQuestion("양자컴퓨터 냉각 비용의 검증 결과는?")
                }
              >
                근거 부족 질문 예시
              </Button>
            </div>
          </section>
          {answers.map((a) => (
            <section className="compiler-panel" key={a.id}>
              <div className="section-title">
                <h2>{a.question}</h2>
                <Badge tone={a.insufficient ? "amber" : "plum"}>
                  {a.mode === "model" ? "모델 답변" : "근거 발췌"}
                </Badge>
              </div>
              <Markdown text={a.content} />
              <div className="citation-list">
                {a.citations.map((c, i) => (
                  <a
                    key={`${c.pageId}-${i}`}
                    href={`#/snapshot/${c.pageId}/${c.version}`}
                  >
                    <Link2 size={14} />[{i + 1}] {c.title} · v{c.version}
                  </a>
                ))}
              </div>
              <div className="compiler-actions">
                <span className="muted">
                  답변은 파생 지식이며 독립적인 검증 증거가 아닙니다.
                </span>
                <Button
                  disabled={
                    !canWrite || a.insufficient || !!busy || !!a.filedBatchId
                  }
                  onClick={() => {
                    if (apply((s) => fileAnswer(s, a.id))) {
                      notify(
                        "답변을 변경 집합으로 제안했습니다. 승인 후 위키에 축적됩니다.",
                      );
                      setTab("ingest");
                    }
                  }}
                >
                  {a.filedBatchId ? "편입 제안됨" : "답변을 위키로 편입"}
                </Button>
              </div>
            </section>
          ))}
          {!answers.length && (
            <Empty
              title="질문도 지식으로 남습니다"
              description="근거를 확인하고 유용한 답변을 위키의 새 페이지로 편입하세요."
            />
          )}
        </>
      )}
      {tab === "lint" && (
        <>
          <section className="compiler-panel">
            <div className="section-title">
              <h2>Weekly · 위키 건강 점검</h2>
              <Badge>실제 규칙 검사</Badge>
            </div>
            <p>
              현재 발행본의 깨진 링크·고립 페이지·근거 누락·검증 시점과 동일
              조건의 구조화 사실 충돌을 검사합니다.
            </p>
            <p className="muted">
              자연어 전반의 의미 모순을 판별하는 기능은 후속 구현입니다. 이
              검사는 결과를 임의로 고치거나 공식성을 올리지 않습니다.
            </p>
            <Button
              variant="primary"
              disabled={!canWrite || !!busy}
              onClick={() => apply(runLint)}
            >
              Weekly 점검 실행
            </Button>
            {k.lintAt && (
              <small className="batch-meta">
                마지막 실행 {new Date(k.lintAt).toLocaleString("ko-KR")}
              </small>
            )}
          </section>
          {k.issues
            .filter((i) =>
              i.pageIds.every((id) => pages.some((p) => p.id === id)),
            )
            .map((i) => (
              <section className="compiler-panel lint-issue" key={i.id}>
                <Badge tone={i.kind === "contradiction" ? "red" : "amber"}>
                  {issueNames[i.kind]}
                </Badge>
                <p>{i.detail}</p>
                <div className="citation-list">
                  {i.pageIds.map((id) => (
                    <a key={id} href={`#/wiki/${id}`}>
                      {pages.find((p) => p.id === id)?.title}{" "}
                      <ArrowRight size={13} />
                    </a>
                  ))}
                </div>
              </section>
            ))}
          {k.lintAt && !k.issues.length && (
            <Empty
              title="현재 규칙에서 발견된 문제가 없습니다"
              description="의미 정확성이나 실제 운영 준비가 검증됐다는 뜻은 아닙니다."
            />
          )}
        </>
      )}
      {tab === "index" && (
        <>
          <div className="notice">
            <BookOpen size={17} />
            <span>
              현재 발행본의 인덱스입니다. 미발행 제안은 포함하지 않습니다. 각
              페이지는 ID·버전·근거·연결을 보존합니다.
            </span>
          </div>
          {pages.map((p) => (
            <section className="compiler-panel index-entry" key={p.id}>
              <div className="section-title">
                <a href={`#/wiki/${p.id}`}>
                  <h2>{p.title}</h2>
                </a>
                <Badge>v{current(p).number}</Badge>
              </div>
              <p>{p.summary}</p>
              <div className="batch-meta">
                {p.id} · 원본 {current(p).sourceIds.length}개 · 구조화 사실{" "}
                {p.facts?.length ?? 0}개 · {p.scope}
              </div>
              <div className="citation-list">
                {(p.links ?? [])
                  .filter((id) => pages.some((p) => p.id === id))
                  .map((id) => (
                    <a key={id} href={`#/wiki/${id}`}>
                      {pages.find((p) => p.id === id)?.title}{" "}
                      <ArrowRight size={13} />
                    </a>
                  ))}
              </div>
              <Button
                variant="ghost"
                onClick={() => setPreview(preview === p.id ? null : p.id)}
              >
                {preview === p.id ? "본문 접기" : "본문 미리보기"}
              </Button>
              {preview === p.id && <Markdown text={current(p).content} />}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
