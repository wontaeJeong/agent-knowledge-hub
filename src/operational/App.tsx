import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ApiError, OperationalApi } from "./api";
import type { Identity } from "./api";
import type { Source } from "../domain/types";
import type { Answer, Draft, Issue } from "../domain/wiki";
import { Button, Badge } from "../ui/primitives";
import "./styles.css";

interface PublishedPage { id: string; title: string; summary: string; version: number; content: string; scope?: string }
interface ChangeSet { id: string; hash: string; status: string; updates: Draft[] }
interface Job { id: string; status: string; kind?: string; operation?: string; error?: string }
type Tab = "knowledge" | "sources" | "review" | "query" | "lint" | "jobs";
const labels: Record<Tab, string> = { knowledge: "발행 지식", sources: "원본과 편입", review: "변경 검토", query: "질문과 재편입", lint: "위키 점검", jobs: "작업 상태" };
const safeMarkdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }));
const statusLabels: Record<string, string> = { pending: "검토 대기", approved: "승인됨", published: "발행됨", rejected: "반려됨", conflict: "충돌", queued: "대기", running: "실행 중", succeeded: "완료", failed: "실패", cancelled: "취소됨" };

export default function OperationalApp() {
  const api = useMemo(() => new OperationalApi(), []);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("knowledge");
  const [pages, setPages] = useState<PublishedPage[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [changes, setChanges] = useState<ChangeSet[]>([]);
  const [members, setMembers] = useState<{ principalId: string; role: string }[]>([]);
  const [selectedReaders, setSelectedReaders] = useState<string[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [model, setModel] = useState<{ configured: boolean; model: string | null }>({ configured: false, model: null });
  const [mode, setMode] = useState<"model" | "offline">("model");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [question, setQuestion] = useState("");

  const load = useCallback(async () => {
    const [p, s, c, m, j, config] = await Promise.all([
      api.get<{ items: PublishedPage[] }>("/pages"), api.get<{ items: Source[] }>("/sources"),
      api.get<{ items: ChangeSet[] }>("/changesets"), api.get<{ items: { principalId: string; role: string }[] }>("/members"),
      api.get<{ items: Job[] }>("/jobs"), api.get<{ configured: boolean; model: string | null }>("/model"),
    ]);
    setPages(p.items); setSources(s.items); setChanges(c.items); setMembers(m.items); setJobs(j.items); setModel(config);
  }, [api]);
  useEffect(() => {
    let active = true;
    api.me().then(async (me) => { if (!active) return; setIdentity(me); setSelectedReaders([me.principalId]); await load(); })
      .catch((e: unknown) => { if (active && !(e instanceof ApiError && e.status === 401)) setError(e instanceof Error ? e.message : "서버 연결 실패"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, load]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "요청에 실패했습니다."); } finally { setBusy(false); }
  };
  const write = identity?.role !== "reader";
  const review = identity?.role === "reviewer";
  const [pageNumber, setPageNumber] = useState(0);
  const filtered = pages.filter((p) => `${p.title} ${p.summary} ${p.content}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const visible = filtered.slice(pageNumber * 25, (pageNumber + 1) * 25);

  return <div className="operational-app">
    <a className="op-skip" href="#op-main">본문으로 이동</a>
    <header className="op-header"><a href="/" className="op-brand"><img src="/brand/symbol-light.svg" alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} /><span>agent-knowledge-hub</span></a>
      {identity && <div className="op-account"><Badge tone="plum">{identity.role === "reviewer" ? "검토자" : identity.role === "editor" ? "작성자" : "독자"}</Badge><span title={identity.principalId}>{identity.workspaceId}</span><Button disabled={busy} onClick={() => perform(async () => { await api.logout(); window.location.assign("/"); })}>로그아웃</Button></div>}
    </header>
    <main id="op-main" className="op-main">
      <h1>검토한 지식이 다음 업무로 이어집니다</h1>
      <p className="op-lead">원본과 근거를 보존하고, 변경을 검토한 뒤 발행합니다. 승인과 모델의 추론은 독립적인 사실 검증을 대신하지 않습니다.</p>
      {error && <div className="op-error" role="alert"><strong>요청을 완료하지 못했습니다.</strong><p>{error}</p><Button disabled={busy} onClick={() => perform(load)}>다시 연결</Button></div>}
      {notice && <div className="op-notice" role="status">{notice}</div>}
      {loading ? <p role="status">인증 상태와 서버 지식을 확인하고 있습니다…</p> : !identity ? <section className="op-panel"><h2>조직 계정으로 로그인</h2><p>접근 가능한 공간과 문서는 서버에서 확인합니다. 로컬 시연 데이터와 운영 지식은 분리됩니다.</p><a className="button primary" href="/auth/login">SSO 로그인</a></section> : <>
        <nav className="op-nav" aria-label="지식 업무">{(Object.keys(labels) as Tab[]).map((key) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); setError(""); }}>{labels[key]}{key === "review" && <span> {changes.filter((c) => c.status === "pending").length}</span>}</button>)}</nav>
        <div className="op-context"><span>서버 정본 · {pages.length}개 접근 가능 발행본</span><span>모델: {model.configured ? model.model : "미연결"}</span><label>실행 방식 <select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as "model" | "offline")}><option value="model">실제 모델</option><option value="offline">구조 검사·발췌 (모델 미사용)</option></select></label></div>
        {busy && <p role="status" className="op-progress">서버에서 처리하고 있습니다. 창을 반복 제출하지 마세요.</p>}
        {tab === "knowledge" && <section className="op-panel"><div className="op-section-head"><h2>발행 지식</h2><Button disabled={busy} onClick={() => perform(load)}>새로고침</Button></div><label>제목·요약·본문 검색<input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPageNumber(0); }} placeholder="업무에 필요한 지식 찾기" /></label>
          {!filtered.length && <p>현재 접근 가능한 발행 지식이 없습니다. 원본을 편입하고 검토·발행하면 여기에 표시됩니다.</p>}
          <div className="op-page-list">{visible.map((page) => <article key={page.id}><details><summary><strong>{page.title}</strong><Badge>v{page.version}</Badge><span>{page.summary}</span></summary><div className="op-markdown" dangerouslySetInnerHTML={{ __html: safeMarkdown(page.content) }} /><small>페이지 {page.id} · 현재 조회 버전 {page.version}</small></details></article>)}</div>
          {filtered.length > 25 && <div className="op-actions"><Button disabled={!pageNumber} onClick={() => setPageNumber((p) => p - 1)}>이전</Button><span>{pageNumber + 1} / {Math.ceil(filtered.length / 25)}</span><Button disabled={(pageNumber + 1) * 25 >= filtered.length} onClick={() => setPageNumber((p) => p + 1)}>다음</Button></div>}
        </section>}
        {tab === "sources" && <>
          {write && <section className="op-panel"><h2>원본 등록</h2><p>공유할 자료만 선택 등록하세요. 아래 독자에게 허용한 범위를 파생 지식이 자동으로 넓히지 않습니다.</p><form onSubmit={(e) => { e.preventDefault(); void perform(async () => {
            const source: Source = { id: `source-${crypto.randomUUID()}`, title, content, tool: "manual", project: "기본", scope: "team", verification: "미검증", createdAt: new Date().toISOString(), processed: false, targetPageId: "topic-main" };
            await api.post("/sources", { source, readers: [...new Set([identity.principalId, ...selectedReaders])] }); setTitle(""); setContent(""); setNotice("원본을 서버에 보존했습니다. 편입은 아래에서 별도로 실행하세요.");
          }); }}><label>제목<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label><label>원본 본문<textarea required maxLength={100000} rows={8} value={content} onChange={(e) => setContent(e.target.value)} /></label><fieldset><legend>열람을 허용할 구성원</legend>{members.map((m) => <label className="op-check" key={m.principalId}><input type="checkbox" disabled={m.principalId === identity.principalId} checked={m.principalId === identity.principalId || selectedReaders.includes(m.principalId)} onChange={(e) => setSelectedReaders((all) => e.target.checked ? [...all, m.principalId] : all.filter((id) => id !== m.principalId))} /><span>{m.principalId} ({m.role})</span></label>)}</fieldset><Button type="submit" variant="primary" disabled={busy}>원본 보존</Button></form></section>}
          <section className="op-panel"><h2>접근 가능한 원본</h2><p>모델 모드는 기존 발행본과 종합하는 변경을 제안합니다. 구조 모드는 자연어 의미 종합을 하지 않습니다.</p>{sources.length === 0 && <p>등록한 원본이 없습니다.</p>}{sources.map((s) => <details key={s.id} className="op-source"><summary><label className="op-check" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedSources.includes(s.id)} onChange={(e) => setSelectedSources((ids) => e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id))} /><span>{s.title}</span></label></summary><pre>{s.content}</pre><small>{s.id} · {s.verification}</small></details>)}<Button variant="primary" disabled={busy || !write || !selectedSources.length || (mode === "model" && !model.configured)} onClick={() => perform(async () => { await api.post("/ingest", { sourceIds: selectedSources, mode }, crypto.randomUUID()); setNotice("편입 요청을 수락했습니다. 변경 검토 또는 작업 상태에서 결과를 확인하세요."); setTab("review"); })}>선택 원본 편입</Button></section>
        </>}
        {tab === "review" && <section className="op-panel"><h2>변경 집합 검토</h2><p>의존 페이지는 함께 발행됩니다. 내용·원본·기준 버전·권한이 바뀌면 다시 검토해야 합니다.</p>{!changes.length && <p>아직 변경 제안이 없습니다.</p>}{changes.map((c) => <article key={c.id} className="op-change"><div className="op-section-head"><h3>{c.updates[0]?.title || c.id} 외 {Math.max(0, c.updates.length - 1)}개</h3><Badge tone={c.status === "published" ? "green" : "amber"}>{statusLabels[c.status] || c.status}</Badge></div><small className="op-id">{c.id} · 내용 해시 {c.hash}</small>{c.updates.map((d) => <details key={d.id}><summary>{d.title} · 기준 v{d.baseVersion} → v{d.baseVersion + 1}</summary><div className="op-diff"><div><h4>현재 발행본</h4><pre>{pages.find((p) => p.id === d.id)?.content || "새 페이지"}</pre></div><div><h4>변경 제안</h4><pre>{d.content}</pre></div></div><p>근거: {d.sourceIds.join(", ")}</p></details>)}{review && <div className="op-actions"><Button disabled={busy || c.status !== "pending"} onClick={() => perform(async () => { await api.post(`/changesets/${encodeURIComponent(c.id)}/approve`, { hash: c.hash }); setNotice("해당 내용과 기준을 고정해 승인했습니다. 발행은 별도 작업입니다."); })}>승인</Button><Button variant="primary" disabled={busy || c.status !== "approved"} onClick={() => perform(async () => { await api.post(`/changesets/${encodeURIComponent(c.id)}/publish`, { hash: c.hash }, crypto.randomUUID()); setNotice("변경 집합 전체를 발행했습니다."); })}>승인 집합 발행</Button><Button variant="danger" disabled={busy || !["pending", "approved"].includes(c.status)} onClick={() => perform(async () => { await api.post(`/changesets/${encodeURIComponent(c.id)}/reject`, { hash: c.hash }); setNotice("변경 집합을 반려했습니다."); })}>반려</Button></div>}</article>)}</section>}
        {tab === "query" && <section className="op-panel"><h2>근거 기반 질문</h2><form onSubmit={(e) => { e.preventDefault(); void perform(async () => { setAnswer(null); const result = await api.post<Answer>("/query", { question, mode }); setAnswer(result); }); }}><label>질문<textarea required maxLength={4000} rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="적용 환경과 버전을 함께 적어주세요." /></label><Button type="submit" variant="primary" disabled={busy || (mode === "model" && !model.configured)}>발행 지식에 질문</Button></form>{answer && <article className="op-answer"><h3>{answer.insufficient ? "근거가 부족합니다" : "답변과 근거"}</h3><Badge>{answer.mode === "model" ? "모델 종합" : "발행본 발췌"}</Badge><div className="op-markdown" dangerouslySetInnerHTML={{ __html: safeMarkdown(answer.content) }} /><ol>{answer.citations.map((c, i) => <li key={i}><strong>{c.title} · v{c.version}</strong><blockquote>{c.quote}</blockquote></li>)}</ol><p>이 답변은 파생 결과입니다. 독립적인 새 원본 증거로 취급하지 않습니다.</p><Button disabled={busy || !write || answer.insufficient || !!answer.filedBatchId} onClick={() => perform(async () => { await api.post(`/answers/${encodeURIComponent(answer.id)}/file`, {}); setNotice("답변을 검토 가능한 변경 제안으로 등록했습니다."); setTab("review"); })}>답변을 위키에 재편입 제안</Button></article>}</section>}
        {tab === "lint" && <section className="op-panel"><h2>지식 건강 점검</h2><p>깨진 연결·고립·근거와 검증 시점 누락·명시 사실 상충을 검사합니다. 구조 점검은 자연어 진실성 검증이 아닙니다.</p><Button variant="primary" disabled={busy || !write} onClick={() => perform(async () => { const result = await api.post<{ issues: Issue[] }>("/lint", {}); setIssues(result.issues); })}>서버 위키 점검</Button>{issues !== null && <><p role="status">현재 접근 범위에서 {issues.length}개 점검 항목을 찾았습니다.</p><ul>{issues.map((i) => <li key={i.id}><strong>{i.kind}</strong> — {i.detail}</li>)}</ul></>}</section>}
        {tab === "jobs" && <section className="op-panel"><div className="op-section-head"><h2>지속 작업 상태</h2><Button disabled={busy} onClick={() => perform(load)}>새로고침</Button></div><p>실패·취소·미실행은 성공으로 집계하지 않습니다.</p>{!jobs.length ? <p>등록된 작업이 없습니다.</p> : <div className="op-table-scroll" tabIndex={0} aria-label="작업 목록 가로 스크롤"><table><thead><tr><th>작업 ID</th><th>종류</th><th>상태</th><th>오류</th></tr></thead><tbody>{jobs.map((j) => <tr key={j.id}><td>{j.id}</td><td>{j.kind || j.operation}</td><td>{statusLabels[j.status] || j.status}</td><td>{j.error || "—"}</td></tr>)}</tbody></table></div>}</section>}
      </>}
      <footer className="op-footer">서버 저장 · 현재 권한 재검사 · 검토 후 발행<span>실제 모델 품질과 운영 인수 결과는 별도 검증 기록을 따릅니다.</span></footer>
    </main>
  </div>;
}
