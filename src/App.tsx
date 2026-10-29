import { useEffect, useState, useRef, lazy, Suspense } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  Inbox,
  LayoutGrid,
  Link2,
  ListFilter,
  Loader2,
  LockKeyhole,
  Menu,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Badge, Button, Empty, Modal } from "./ui/primitives";
import { BrandIcon } from "./ui/BrandIcon";
import { demoRepository, readStoredValue } from "./adapters/repository";
import {
  canReview,
  canWrite,
  latest,
  reduce,
  resolveShare,
  visiblePages,
  visibleSources,
} from "./domain/engine";
import type { Action, Change, Page, Run, Scope, State } from "./domain/types";
import { makeId } from "./domain/id";
import roadmap from "./data/roadmap.json";
const UsageDashboard = lazy(() =>
  import("./features/UsageDashboard").then((m) => ({
    default: m.UsageDashboard,
  })),
);
const KnowledgeWorkbench = lazy(() =>
  import("./features/KnowledgeWorkbench").then((m) => ({
    default: m.KnowledgeWorkbench,
  })),
);
import {
  compileOffline,
  createBatch,
  enqueueBatch,
  runLint,
} from "./domain/wiki";

const scopeText: Record<Scope, string> = {
  company: "전사 공유",
  team: "플랫폼팀",
  private: "나만 보기",
};
const date = (v: string) =>
  new Date(v).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
const time = (v: string) =>
  new Date(v).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
const statusText: Record<Change["status"], string> = {
  pending: "검토 대기",
  approved: "승인됨",
  published: "발행됨",
  rejected: "반려됨",
  conflict: "충돌 · 재검토",
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
function PageIcon({
  category,
  size = 21,
}: {
  category: string;
  size?: number;
}) {
  return category === "보안 · 인증" ? (
    <ShieldCheck size={size} />
  ) : category === "운영 가이드" ? (
    <Workflow size={size} />
  ) : category === "기술 설계" ? (
    <GitBranch size={size} />
  ) : (
    <FileText size={size} />
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function App() {
  const [state, setState] = useState<State>(() => demoRepository.load());
  const stateRef = useRef(state);
  stateRef.current = state;
  const [route, setRoute] = useState(() => location.hash.slice(1) || "/");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("전체 지식");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<
    "source" | "share" | "versions" | "edit" | "help" | "reset" | null
  >(null);
  const [theme, setTheme] = useState(
    () =>
      readStoredValue("agent-knowledge-hub.theme", "folio.theme") || "light",
  );
  const [running, setRunning] = useState<Run["kind"] | null>(null);

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareFixed, setShareFixed] = useState(false);
  const [shareDuration, setShareDuration] = useState("7");
  const [editing, setEditing] = useState("");
  const [editBase, setEditBase] = useState(1);
  const [mobile, setMobile] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [roadmapSearch, setRoadmapSearch] = useState("");
  const [phase, setPhase] = useState("전체");
  useEffect(() => {
    const cb = () => {
      setRoute(location.hash.slice(1) || "/");
      setModal(null);
      setSelectedVersion(null);
      setSourceId(null);
      setMobile(false);
    };
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("agent-knowledge-hub.theme", theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!modal && !sourceId) return;
    const prev = document.activeElement as HTMLElement;
    const t = setTimeout(
      () =>
        document
          .querySelector<HTMLElement>(".modal button, .modal input")
          ?.focus(),
      0,
    );
    const cb = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(null);
        setSourceId(null);
      }
      if (e.key === "Tab") {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not(:disabled),.modal input,.modal select,.modal textarea,.modal a[href]",
          ),
        );
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", cb);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", cb);
      prev?.focus();
    };
  }, [modal, sourceId]);
  const notify = (msg: string) => setToast(msg);
  const send = (action: Action) => {
    try {
      const next = reduce(state, action);
      demoRepository.save(next);
      setState(next);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const go = (to: string) => {
    location.hash = to;
  };
  const pages = visiblePages(state);
  const sources = visibleSources(state);
  const page = pages.find((p) => p.id === route.split("/")[2]);
  const active = route.startsWith("/wiki/")
    ? "wiki"
    : route === "/"
      ? "home"
      : route.slice(1).split("/")[0];
  const pending = state.changes.filter((c) =>
    ["pending", "approved"].includes(c.status),
  ).length;
  const applyKnowledge = (transition: (s: State) => State) => {
    try {
      const next = transition(stateRef.current);
      demoRepository.save(next);
      stateRef.current = next;
      setState(next);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  const runManager = (kind: Run["kind"]) => {
    setRunning(kind);
    const ok = applyKnowledge((s) => {
      if (kind === "Weekly") return runLint(s);
      const ids = s.sources
        .filter((x) => !x.processed && x.scope !== "private")
        .map((x) => x.id);
      return enqueueBatch(
        s,
        createBatch(s, compileOffline(s, ids), ids, "offline"),
      );
    });
    setRunning(null);
    if (ok) {
      notify(`${kind} 실행 결과를 확인하세요.`);
      go(kind === "Weekly" ? "/compile/lint" : "/compile");
    }
  };
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      notify("링크를 복사했습니다.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify("자동 복사가 허용되지 않았습니다. 아래 링크를 직접 복사하세요.");
    }
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "agent-knowledge-hub-export.json";
    a.click();
    URL.revokeObjectURL(url);
    notify("데모 데이터를 내보냈습니다.");
  }
  function submitSource(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = send({
      type: "ADD_SOURCE",
      source: {
        id: makeId(),
        title: String(f.get("title")),
        content: String(f.get("content")),
        tool: String(f.get("tool")),
        project: String(f.get("project")) || "demo-project",
        scope: f.get("scope") as Scope,
        verification: f.get("verification") as "미검증",
        targetPageId: String(f.get("target")),
        processed: false,
        createdAt: new Date().toISOString(),
      },
    });
    if (ok) {
      setModal(null);
      notify("수집함에 등록했습니다. 매니저를 실행해 변경안을 만드세요.");
      go("/sources");
    }
  }
  const profile =
    state.role === "reviewer"
      ? { name: "김민서", initial: "민" }
      : state.role === "editor"
        ? { name: "이도윤", initial: "윤" }
        : { name: "박서연", initial: "서" };
  const title =
    active === "home"
      ? "지식 공간"
      : active === "compile"
        ? "지식 컴파일"
        : active === "sources"
          ? "산출물 수집함"
          : active === "review"
            ? "변경 검토"
            : active === "manager"
              ? "위키 매니저"
              : active === "activity"
                ? "활동 기록"
                : active === "roadmap"
                  ? "제품 로드맵"
                  : active === "settings"
                    ? "연동 · 설정"
                    : active === "usage"
                      ? "사용량 대시보드"
                      : page?.category || "위키";
  function navItem(
    url: string,
    label: string,
    icon: ReactNode,
    count?: number,
  ) {
    return (
      <a
        className={`nav-item ${(url === "/" ? active === "home" : active === url.slice(1)) ? "active" : ""}`}
        href={`#${url}`}
      >
        {icon}
        <span>{label}</span>
        {!!count && <span className="count">{count}</span>}
      </a>
    );
  }
  function pageList(items: Page[]) {
    return (
      <div className="page-list">
        <div className="table-head">
          <span>문서</span>
          <span>상태</span>
          <span>담당</span>
          <span>업데이트</span>
        </div>
        {items.map((p) => (
          <div className="page-row" key={p.id}>
            <a href={`#/wiki/${p.id}`} className="page-main">
              <span className="page-icon">
                <PageIcon category={p.category} />
              </span>
              <span>
                <strong>{p.title}</strong>
                <small>{p.summary}</small>
              </span>
            </a>
            <span>
              <Badge
                tone={
                  p.status === "공식 기준"
                    ? "plum"
                    : p.status === "실행 검증"
                      ? "green"
                      : "neutral"
                }
              >
                {p.status === "실행 검증" && <Check size={11} />} {p.status}
              </Badge>
            </span>
            <span className="row-owner">
              <span className="avatar tiny">플</span>
              {p.owner}
            </span>
            <span className="row-date">
              {date(latest(p).at)}
              <button
                aria-label={`${p.title} 즐겨찾기`}
                className={`star-button ${p.favorite ? "on" : ""}`}
                onClick={() => send({ type: "FAVORITE", id: p.id })}
              >
                <Star size={15} fill={p.favorite ? "currentColor" : "none"} />
              </button>
            </span>
          </div>
        ))}
      </div>
    );
  }
  const filtered = pages.filter(
    (p) =>
      (filter !== "즐겨찾기" || p.favorite) &&
      (filter !== "전사 지식" || p.scope === "company") &&
      (filter !== "팀 지식" || p.scope === "team") &&
      `${p.title} ${p.summary} ${p.tags.join(" ")} ${latest(p).content}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (filter === "최근 변경")
    filtered.sort(
      (a, b) => Date.parse(latest(b).at) - Date.parse(latest(a).at),
    );
  const shared = route.startsWith("/shared/")
    ? resolveShare(state, route.split("/")[2])
    : null;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <a href="#/" className="brand" aria-label="agent-knowledge-hub 홈">
          <img
            src={theme === "dark" ? "/brand/mark-dark.svg" : "/brand/mark.svg"}
            alt=""
          />
          <span className="brand-name">
            <span className="brand-prefix">
              agent-<i>DEMO</i>
            </span>
            <strong>knowledge-hub</strong>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-symbol">P</span>
          <span>
            Platform workspace<small>우리의 경험이 연결되는 곳</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <button
          className="sidebar-search"
          onClick={() => {
            go("/");
            setTimeout(
              () => document.getElementById("wiki-search")?.focus(),
              100,
            );
          }}
        >
          <Search size={15} />
          지식 검색<span>⌕</span>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItem("/usage", "사용량 대시보드", <LayoutGrid size={17} />)}
          {navItem("/", "지식 공간", <BrandIcon name="hub" size={17} />)}
          {navItem(
            "/sources",
            "산출물 수집함",
            <BrandIcon name="inbox" size={17} />,
            sources.filter((s) => !s.processed).length,
          )}
          {navItem(
            "/review",
            "변경 검토",
            <BrandIcon name="branch" size={17} />,
            pending,
          )}
          {navItem(
            "/compile",
            "지식 컴파일",
            <BrandIcon name="compile" size={17} />,
          )}
          {navItem(
            "/manager",
            "위키 매니저",
            <BrandIcon name="manager" size={17} />,
          )}
          {navItem(
            "/activity",
            "활동 기록",
            <BrandIcon name="history" size={17} />,
          )}
        </nav>
        <div className="nav-label section-label">
          PINNED <Star size={11} />
        </div>
        <div className="pinned">
          {pages
            .filter((p) => p.favorite)
            .map((p) => (
              <a
                key={p.id}
                href={`#/wiki/${p.id}`}
                className={page?.id === p.id ? "selected" : ""}
              >
                <FileText size={14} />
                <span>{p.title}</span>
              </a>
            ))}
        </div>
        <div className="sidebar-bottom">
          {navItem(
            "/roadmap",
            "제품 로드맵",
            <BrandIcon name="roadmap" size={16} />,
          )}
          {navItem(
            "/settings",
            "연동 · 설정",
            <BrandIcon name="settings" size={16} />,
          )}
          <button className="profile" onClick={() => setModal("help")}>
            <span className="avatar">{profile.initial}</span>
            <span>
              {profile.name}
              <small>플랫폼팀 · 데모 사용자</small>
            </span>
            <CircleHelp size={16} />
          </button>
        </div>
      </aside>
      {mobile && (
        <div className="sidebar-backdrop" onClick={() => setMobile(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="메뉴 열기"
            onClick={() => setMobile(!mobile)}
          >
            <Menu size={19} />
          </button>
          <span className="crumb">
            워크스페이스 <ChevronRight size={13} /> <b>{title}</b>
          </span>
          <div className="top-actions">
            <span className="local-indicator">
              <span />
              로컬 데모
            </span>
            <select
              aria-label="데모 역할"
              className="role-select"
              value={state.role}
              onChange={(e) =>
                send({ type: "ROLE", role: e.target.value as State["role"] })
              }
            >
              <option value="reviewer">검토자 · 김민서</option>
              <option value="editor">작성자 · 이도윤</option>
              <option value="reader">독자 · 박서연</option>
            </select>
            <button
              className="icon-button"
              aria-label="테마 전환"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button
              className="avatar small"
              aria-label="데모 안내"
              onClick={() => setModal("help")}
            >
              {profile.initial}
            </button>
          </div>
        </header>
        <main id="main-content">
          {active === "usage" && (
            <Suspense
              fallback={<p role="status">사용량 화면을 불러오는 중입니다…</p>}
            >
              <UsageDashboard />
            </Suspense>
          )}
          {active === "home" && (
            <div className="home page-wrap">
              <div className="eyebrow">
                <span className="eyebrow-line" /> PLATFORM KNOWLEDGE
              </div>
              <div className="page-heading">
                <div>
                  <h1>
                    우리 팀의 지식 공간<span className="heading-dot">.</span>
                  </h1>
                  <p>한 번의 해결이, 다음 사람의 출발점이 되도록.</p>
                </div>
                <Button
                  variant="primary"
                  disabled={!canWrite(state)}
                  onClick={() => setModal("source")}
                >
                  <Plus size={16} />
                  산출물 등록
                </Button>
              </div>
              <div className="home-overview">
                <section className="featured">
                  <div className="featured-top">
                    <Badge tone="plum">
                      <BookOpen size={12} /> 이어 읽기
                    </Badge>
                    <span className="featured-page-count">
                      {pages.length}개의 연결된 지식
                    </span>
                  </div>
                  <a className="featured-link" href="#/wiki/container-ca">
                    <h2>
                      컨테이너에서 사내 CA
                      <br />
                      인증서 적용하기 <ArrowRight size={22} />
                    </h2>
                  </a>
                  <p>
                    동료의 문제 해결 과정과 검증 결과를 한곳에서 확인하세요.
                  </p>
                  <div className="featured-footer">
                    <span className="avatar-stack">
                      <i>민</i>
                      <i>윤</i>
                      <i>서</i>
                    </span>
                    <span>
                      {state.pages[0].reused}번의 재사용 ·{" "}
                      {latest(state.pages[0]).sourceIds.length}개 근거
                    </span>
                    <span className="featured-lines" aria-hidden="true">
                      <BrandIcon name="hub" size={94} strokeWidth={0.8} />
                    </span>
                  </div>
                </section>
                <section className="manager-teaser">
                  <div className="teaser-title">
                    <span className="sparkle-box">
                      <Sparkles size={18} />
                    </span>
                    <span>
                      지식은 계속 다듬어집니다<small>Wiki manager</small>
                    </span>
                  </div>
                  <p>
                    새로운 경험을 기존 지식에 연결하고,
                    <br />
                    필요한 변경을 검토할 수 있게 준비해요.
                  </p>
                  <div className="teaser-metric">
                    <span>
                      <i className="status-dot" />
                      {
                        sources.filter(
                          (x) => !x.processed && x.scope !== "private",
                        ).length
                      }
                      개 산출물 편입 대기
                    </span>
                    <a href="#/manager">
                      점검하기 <ArrowRight size={14} />
                    </a>
                  </div>
                </section>
              </div>
              <div className="section-heading">
                <div className="tabs">
                  {["전체 지식", "즐겨찾기", "최근 변경"].map((x) => (
                    <button
                      key={x}
                      className={filter === x ? "active" : ""}
                      onClick={() => setFilter(x)}
                    >
                      {x}
                      {x === "전체 지식" && <span>{pages.length}</span>}
                    </button>
                  ))}
                </div>
                <div className="list-tools">
                  <div className="search-input">
                    <Search size={15} />
                    <input
                      aria-label="지식 검색"
                      id="wiki-search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="문서, 태그, 내용 검색"
                    />
                  </div>
                  <select
                    aria-label="공간 필터"
                    value={
                      ["전사 지식", "팀 지식"].includes(filter) ? filter : ""
                    }
                    onChange={(e) => setFilter(e.target.value || "전체 지식")}
                  >
                    <option value="">모든 공간</option>
                    <option>전사 지식</option>
                    <option>팀 지식</option>
                  </select>
                </div>
              </div>
              {filtered.length ? (
                pageList(filtered)
              ) : (
                <Empty
                  title="검색 결과가 없어요"
                  description="다른 단어나 공간을 선택해보세요."
                />
              )}
              <div className="home-bottom">
                <span>
                  <Link2 size={14} /> 흩어진 산출물을, 연결된 지식으로
                </span>
                <button onClick={() => setModal("help")}>
                  데모 사용법 <ArrowRight size={13} />
                </button>
              </div>
              <div className="walkthrough">
                <FlaskConical size={16} />
                <span>
                  <b>3분 시연</b> 수집함의 새 사례를 점검하고, 검토 후 가이드에
                  발행해보세요.
                </span>
                <a href="#/manager">
                  시작하기 <ArrowRight size={14} />
                </a>
              </div>
            </div>
          )}

          {active === "wiki" &&
            (page ? (
              <div className="document-layout">
                <article className="document">
                  <a className="back-link" href="#/">
                    <ArrowLeft size={14} /> 지식 공간
                  </a>
                  <div className="document-top">
                    <span className="page-icon big">
                      <PageIcon category={page.category} size={27} />
                    </span>
                    <div className="document-actions">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSelectedVersion(null);
                          setModal("versions");
                        }}
                      >
                        <History size={15} />v{latest(page).number}
                      </Button>
                      <Button
                        onClick={() => setModal("share")}
                        disabled={!canWrite(state)}
                      >
                        <Link2 size={15} />
                        공유
                      </Button>
                      <Button
                        onClick={() => {
                          setEditing(latest(page).content);
                          setEditBase(latest(page).number);
                          setModal("edit");
                        }}
                        disabled={!canWrite(state)}
                      >
                        <Code2 size={15} />
                        편집
                      </Button>
                    </div>
                  </div>
                  <h1>{page.title}</h1>
                  <p className="doc-description">{page.summary}</p>
                  <div className="doc-meta">
                    <Badge
                      tone={
                        page.status === "공식 기준"
                          ? "plum"
                          : page.status === "실행 검증"
                            ? "green"
                            : "neutral"
                      }
                    >
                      {page.status}
                    </Badge>
                    <span>{scopeText[page.scope]}</span>
                    <span>{page.owner}</span>
                    <span>{date(latest(page).at)} 업데이트</span>
                  </div>
                  <Markdown text={latest(page).content} />
                  <div className="feedback">
                    <span>
                      <CheckCheck size={17} />이 지식이 문제 해결에 도움이
                      됐나요?
                    </span>
                    <Button
                      onClick={() => {
                        send({
                          type: "FEEDBACK",
                          id: page.id,
                          result: "해결됨",
                        });
                        notify("재사용 결과를 기록했습니다.");
                      }}
                    >
                      해결됐어요
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        send({
                          type: "FEEDBACK",
                          id: page.id,
                          result: "추가 확인 필요",
                        });
                        notify("추가 확인 의견을 기록했습니다.");
                      }}
                    >
                      추가 확인 필요
                    </Button>
                  </div>
                </article>
                <aside className="doc-rail">
                  <h4>이 지식의 근거</h4>
                  <p>원본과 확인 결과를 함께 읽어보세요.</p>
                  {latest(page).sourceIds.map((id, i) => {
                    const s = sources.find((x) => x.id === id);
                    return s ? (
                      <button
                        className="source-ref"
                        key={id}
                        onClick={() => setSourceId(id)}
                      >
                        <span className="ref-number">{i + 1}</span>
                        <span>
                          <strong>{s.title}</strong>
                          <small>
                            {s.tool} · {s.verification}
                          </small>
                        </span>
                        <ExternalLink size={13} />
                      </button>
                    ) : null;
                  })}
                  <div className="rail-divider" />
                  <h4>문서 정보</h4>
                  <dl>
                    <dt>담당</dt>
                    <dd>{page.owner}</dd>
                    <dt>공개 범위</dt>
                    <dd>{scopeText[page.scope]}</dd>
                    <dt>발행 버전</dt>
                    <dd>v{latest(page).number}</dd>
                    <dt>재사용</dt>
                    <dd>{page.reused}회</dd>
                  </dl>
                  <div className="tag-list">
                    {page.tags.map((t) => (
                      <span key={t}># {t}</span>
                    ))}
                  </div>
                  <div className="rail-note">
                    <ShieldCheck size={16} />
                    <p>
                      모든 예시는 합성 자료입니다. 표시된 검증 상태는 시연용
                      데이터입니다.
                    </p>
                  </div>
                </aside>
              </div>
            ) : (
              <Empty
                title="문서를 열 수 없어요"
                description="문서가 없거나 현재 데모 역할에서 볼 수 없는 공간입니다."
              >
                <Button onClick={() => go("/")}>지식 공간으로</Button>
              </Empty>
            ))}

          {active === "sources" && (
            <div className="page-wrap">
              <div className="page-heading">
                <div className="title-with-icon">
                  <Inbox size={27} />
                  <div>
                    <h1>산출물 수집함</h1>
                    <p>LLM으로 만든 결과가 지식으로 이어지는 출발점.</p>
                  </div>
                </div>
                <Button
                  variant="primary"
                  disabled={!canWrite(state)}
                  onClick={() => setModal("source")}
                >
                  <Plus size={16} />
                  산출물 등록
                </Button>
              </div>
              <div className="notice">
                <LockKeyhole size={16} />
                <span>
                  실제 도구에 연결하지 않습니다. 예시 산출물을 직접 등록하고
                  공개 범위를 확인할 수 있어요.
                </span>
              </div>
              <div className="source-table">
                {sources.map((s) => (
                  <button
                    className="source-item"
                    key={s.id}
                    onClick={() => setSourceId(s.id)}
                  >
                    <span
                      className={`tool-icon ${s.tool === "OpenCode" ? "opencode" : ""}`}
                    >
                      <Code2 size={20} />
                    </span>
                    <span className="source-info">
                      <strong>{s.title}</strong>
                      <small>
                        {s.tool} <i>·</i> {s.project} <i>·</i>{" "}
                        {scopeText[s.scope]}
                      </small>
                    </span>
                    <Badge tone={s.processed ? "green" : "amber"}>
                      {s.processed ? "편입 처리됨" : "편입 대기"}
                    </Badge>
                    <span className="muted">{date(s.createdAt)}</span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
              <div className="inline-footer">
                {sources.filter((s) => !s.processed).length}개 대기{" "}
                <span>·</span> 등록된 원본은 변경안의 근거로 보존됩니다.
                <a href="#/manager">
                  매니저로 이동 <ArrowRight size={14} />
                </a>
              </div>
            </div>
          )}

          {active === "review" && (
            <div className="page-wrap">
              <div className="page-heading">
                <div className="title-with-icon">
                  <GitBranch size={27} />
                  <div>
                    <h1>변경 검토</h1>
                    <p>왜 바뀌는지 확인하고, 승인한 지식만 발행하세요.</p>
                  </div>
                </div>
                <Badge tone="plum">{pending}개 이전 변경안</Badge>
              </div>
              <div className="notice">
                <GitBranch size={17} />
                <span>
                  새 편입·질문 결과의 변경 집합은 지식 컴파일에서 검토합니다.
                </span>
                <Button onClick={() => go("/compile")}>변경 집합 보기</Button>
              </div>
              {!state.changes.length ? (
                <Empty
                  title="아직 검토할 변경안이 없어요"
                  description="매니저가 새 산출물을 정리하면 이곳에 변경안이 도착합니다."
                >
                  <Button variant="primary" onClick={() => go("/manager")}>
                    매니저 점검하기 <ArrowRight size={15} />
                  </Button>
                </Empty>
              ) : (
                state.changes.map((c) => (
                  <section className="change-card" key={c.id}>
                    <div className="change-head">
                      <span className="change-symbol">
                        <GitBranch size={20} />
                      </span>
                      <div>
                        <h3>{c.title}</h3>
                        <p>
                          기준 v{c.baseVersion} · {c.sourceIds.length}개 새 근거
                          · {date(c.createdAt)}
                        </p>
                      </div>
                      <Badge
                        tone={
                          c.status === "published"
                            ? "green"
                            : c.status === "conflict"
                              ? "red"
                              : "amber"
                        }
                      >
                        {statusText[c.status]}
                      </Badge>
                    </div>
                    <div className="change-reason">
                      <Sparkles size={15} />
                      {c.reason}
                    </div>
                    <div className="diff">
                      <div>
                        <header>
                          현재 발행본 <span>v{c.baseVersion}</span>
                        </header>
                        <pre>{c.before}</pre>
                      </div>
                      <div className="added">
                        <header>
                          제안된 내용 <span>전체 본문</span>
                        </header>
                        <pre>{c.after}</pre>
                      </div>
                    </div>
                    <div className="change-sources">
                      {c.sourceIds.map((id) => (
                        <button key={id} onClick={() => setSourceId(id)}>
                          <FileText size={13} />
                          {state.sources.find((s) => s.id === id)?.title}
                        </button>
                      ))}
                    </div>
                    <footer>
                      <span>
                        <ShieldCheck size={14} />
                        승인과 발행은 별도 단계입니다.
                      </span>
                      <div>
                        {["pending", "approved"].includes(c.status) && (
                          <Button
                            variant="ghost"
                            disabled={!canReview(state)}
                            onClick={() => send({ type: "REJECT", id: c.id })}
                          >
                            반려
                          </Button>
                        )}
                        {c.status === "pending" && (
                          <Button
                            variant="primary"
                            disabled={!canReview(state)}
                            onClick={() => {
                              send({ type: "APPROVE", id: c.id });
                              notify("승인했습니다. 발행 버튼으로 반영하세요.");
                            }}
                          >
                            <Check size={15} />
                            변경 승인
                          </Button>
                        )}
                        {c.status === "approved" && (
                          <Button
                            variant="primary"
                            disabled={!canReview(state)}
                            onClick={() => {
                              send({ type: "PUBLISH", id: c.id });
                              notify("발행 결과를 확인하세요.");
                            }}
                          >
                            <CheckCheck size={15} />
                            승인한 변경 발행
                          </Button>
                        )}
                        {c.status === "published" && (
                          <Button onClick={() => go(`/wiki/${c.pageId}`)}>
                            문서 보기 <ArrowRight size={14} />
                          </Button>
                        )}
                        {c.status === "conflict" && (
                          <span className="error-text">
                            원본을 새 산출물로 다시 등록해 재검토하세요.
                          </span>
                        )}
                      </div>
                    </footer>
                  </section>
                ))
              )}
            </div>
          )}

          {active === "compile" && (
            <Suspense
              fallback={<div className="page-wrap">지식 컴파일을 여는 중…</div>}
            >
              <KnowledgeWorkbench
                key={route}
                state={state}
                apply={applyKnowledge}
                notify={notify}
                initialTab={route.split("/")[2]}
              />
            </Suspense>
          )}

          {active === "manager" && (
            <div className="page-wrap">
              <div className="page-heading">
                <div className="title-with-icon">
                  <Sparkles size={27} />
                  <div>
                    <h1>위키 매니저</h1>
                    <p>지식의 정리는 꾸준하게, 중요한 결정은 사람에게.</p>
                  </div>
                </div>
                <Badge tone="plum">위키 편입 · 실제 규칙 점검</Badge>
              </div>
              <div className="notice">
                <FlaskConical size={16} />
                <span>
                  Daily는 여러 페이지의 변경 집합을, Weekly는 실제 점검 결과를
                  만듭니다. 지식 컴파일에서 모델 모드를 선택할 수 있습니다.
                  일정은 설정만 저장합니다.
                </span>
              </div>
              <div className="manager-grid">
                {(["Daily", "Weekly"] as const).map((kind) => (
                  <section className="manager-card" key={kind}>
                    <div className="manager-card-top">
                      <span className="manager-icon">
                        {kind === "Daily" ? (
                          <Sun size={25} />
                        ) : (
                          <Workflow size={25} />
                        )}
                      </span>
                      <Badge>{kind === "Daily" ? "매일" : "매주"}</Badge>
                    </div>
                    <h2>{kind} 정리</h2>
                    <p>
                      {kind === "Daily"
                        ? "새 산출물을 관련 문서에 연결하고 변경안을 준비합니다."
                        : "발행본의 연결·근거·검증 시점과 구조화 사실 충돌을 검사합니다."}
                    </p>
                    <ul>
                      {(kind === "Daily"
                        ? [
                            "대기 산출물 편입",
                            "적용 조건과 원본 연결",
                            "여러 페이지의 변경 집합 생성",
                          ]
                        : [
                            "깨진 연결과 고립 문서 확인",
                            "근거와 검증 시점 확인",
                            "동일 조건의 사실 충돌 확인",
                          ]
                      ).map((t) => (
                        <li key={t}>
                          <Check size={13} />
                          {t}
                        </li>
                      ))}
                    </ul>
                    <div className="schedule-label">
                      <Clock3 size={14} />
                      {kind === "Daily"
                        ? state.schedule.daily
                        : state.schedule.weekly}{" "}
                      <span>설정 예시</span>
                    </div>
                    <Button
                      variant={kind === "Daily" ? "primary" : "secondary"}
                      disabled={!!running || !canWrite(state)}
                      onClick={() => runManager(kind)}
                    >
                      {running === kind ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <Play size={14} />
                      )}{" "}
                      {running === kind ? "실행 중" : "데모 점검 실행"}
                    </Button>
                  </section>
                ))}
              </div>
              <div className="section-title">
                <h2>최근 실행</h2>
                <span>{state.runs.length}회</span>
              </div>
              {!state.runs.length ? (
                <Empty
                  title="첫 점검을 실행해보세요"
                  description="지식 컴파일에서 편입 결과와 주간 점검 결과를 확인하세요."
                />
              ) : (
                state.runs.map((r) => (
                  <div className="run-row" key={r.id}>
                    <span className="run-check">
                      <Check size={17} />
                    </span>
                    <div>
                      <strong>{r.kind} 점검 완료</strong>
                      <small>
                        {date(r.at)} {time(r.at)} · 결정적 데모 엔진
                      </small>
                      {r.issues.map((i) => (
                        <p key={i}>{i}</p>
                      ))}
                    </div>
                    <span>
                      {r.sources}개 자료 <ArrowRight size={12} /> {r.changes}개
                      변경안
                    </span>
                    <a href="#/review">
                      검토하기 <ArrowRight size={14} />
                    </a>
                  </div>
                ))
              )}
            </div>
          )}

          {active === "activity" && (
            <div className="page-wrap">
              <div className="page-heading">
                <div>
                  <h1>활동 기록</h1>
                  <p>무엇이 바뀌었고, 누가 확인했는지 한눈에.</p>
                </div>
                <Button onClick={exportData}>
                  <ArrowDownToLine size={15} />
                  데모 기록 내보내기
                </Button>
              </div>
              <div className="notice">
                <History size={15} />
                <span>
                  이 브라우저의 시연 기록입니다. 위변조 방지 서버 감사 로그는
                  로드맵에 포함됩니다.
                </span>
              </div>
              <div className="timeline">
                {state.audit.map((a) => (
                  <div className="timeline-item" key={a.id}>
                    <span className="timeline-dot" />
                    <div>
                      <span className="timeline-kind">{a.kind}</span>
                      <p>{a.detail}</p>
                      <small>
                        {a.actor} <i>·</i> {date(a.at)} {time(a.at)}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {active === "roadmap" && (
            <div className="page-wrap">
              <div className="page-heading">
                <div>
                  <h1>데모에서 사내 운영까지</h1>
                  <p>
                    기존 239개와 핵심 순환 12개 요구사항의 시연 범위와 운영
                    완료를 구분합니다.
                  </p>
                </div>
                <Badge tone="amber">운영 인수 0 / {roadmap.length}</Badge>
              </div>
              <div className="roadmap-phases">
                {[
                  "P0 기반 계약",
                  "P1 기능 통합",
                  "P2 운영 준비",
                  "P3 조직 확대",
                ].map((p, i) => (
                  <button
                    key={p}
                    onClick={() => setPhase(p)}
                    className={phase === p ? "active" : ""}
                  >
                    <span>0{i + 1}</span>
                    <strong>{p.substring(3)}</strong>
                    <small>
                      {
                        [
                          "인증 · 권한 · 근거",
                          "수집 · 편집 · 검토",
                          "보안 · 관측 · 복구",
                          "규모 · 도구 · 협업",
                        ][i]
                      }
                    </small>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
              <div className="section-heading">
                <div className="tabs">
                  <button
                    className={phase === "전체" ? "active" : ""}
                    onClick={() => setPhase("전체")}
                  >
                    전체 요구사항
                  </button>
                  <button
                    className={phase === "demo" ? "active" : ""}
                    onClick={() => setPhase("demo")}
                  >
                    로컬 시연 범위
                  </button>
                </div>
                <div className="search-input">
                  <Search size={14} />
                  <input
                    aria-label="요구사항 검색"
                    placeholder="ID 또는 기능 검색"
                    value={roadmapSearch}
                    onChange={(e) => setRoadmapSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="requirement-list">
                {roadmap
                  .filter(
                    (r) =>
                      (phase === "전체" ||
                        (phase === "demo" && r.demoCoverage) ||
                        r.phase === phase) &&
                      `${r.id} ${r.title} ${r.domain}`.includes(roadmapSearch),
                  )
                  .map((r) => (
                    <details key={r.id}>
                      <summary>
                        <code>{r.id}</code>
                        <strong>{r.title}</strong>
                        <span className="requirement-domain">{r.domain}</span>
                        <Badge tone={r.demoCoverage ? "plum" : "neutral"}>
                          {r.demoCoverage ? "로컬 시연" : "로드맵"}
                        </Badge>
                        <ChevronDown size={14} />
                      </summary>
                      <div>
                        <p>{r.requirement}</p>
                        <p>
                          <b>수용 기준</b> {r.acceptance}
                        </p>
                        <small>
                          {r.phase} · {r.priority} · 프로덕션 상태: 미검증{" "}
                          {r.demoCoverage && "· 브라우저 데모만 구현"}
                        </small>
                      </div>
                    </details>
                  ))}
              </div>
            </div>
          )}

          {active === "settings" && (
            <div className="page-wrap narrow">
              <div className="page-heading">
                <div>
                  <h1>연동 · 설정</h1>
                  <p>사내 환경으로 이어 붙이기 위한 경계를 확인하세요.</p>
                </div>
              </div>
              <section className="settings-section">
                <h2>데모 실행 환경</h2>
                <div className="settings-row">
                  <div>
                    <strong>브라우저 로컬 저장</strong>
                    <p>새로고침해도 이 브라우저의 데이터가 유지됩니다.</p>
                  </div>
                  <Badge tone="green">사용 중</Badge>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>LLM 도구 · 모델</strong>
                    <p>
                      모델 연결은 .env 설정 후 Node 실행기의 지식 컴파일에서
                      선택합니다. 도구 자동 수집은 후속 구현입니다. 기존
                      Repository와 Manager 경계를 서버 구현으로 교체합니다.
                    </p>
                  </div>
                  <Badge>로드맵</Badge>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>agent-admission-gate UI</strong>
                    <p>
                      공통 primitives와 의미 토큰을 교체 지점으로 제공합니다.
                      실제 소스는 포함하지 않았습니다.
                    </p>
                  </div>
                  <Badge tone="plum">교체 경계</Badge>
                </div>
              </section>
              <section className="settings-section">
                <h2>매니저 일정 예시</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    send({
                      type: "SCHEDULE",
                      daily: String(f.get("daily")),
                      weekly: String(f.get("weekly")),
                      enabled: true,
                    });
                    notify(
                      "일정 예시를 저장했습니다. 자동 실행은 하지 않습니다.",
                    );
                  }}
                >
                  <div className="form-grid">
                    <Field label="Daily">
                      <input
                        type="time"
                        name="daily"
                        defaultValue={state.schedule.daily}
                        required
                      />
                    </Field>
                    <Field label="Weekly">
                      <select
                        name="weekly"
                        defaultValue={state.schedule.weekly}
                      >
                        {["월요일 09:30", "수요일 09:30", "금요일 17:00"].map(
                          (x) => (
                            <option key={x}>{x}</option>
                          ),
                        )}
                      </select>
                    </Field>
                  </div>
                  <Button type="submit" disabled={!canWrite(state)}>
                    일정 예시 저장
                  </Button>
                </form>
              </section>
              <section className="settings-section">
                <h2>데이터 관리</h2>
                <div className="settings-row">
                  <div>
                    <strong>데모 데이터 내보내기</strong>
                    <p>
                      문서 버전·근거·변경안·작업 이력을 JSON으로 저장합니다.
                    </p>
                  </div>
                  <Button onClick={exportData}>
                    <ArrowDownToLine size={14} />
                    내보내기
                  </Button>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>처음 상태로 되돌리기</strong>
                    <p>
                      이 브라우저에서 추가한 데이터와 공유 링크를 삭제합니다.
                    </p>
                  </div>
                  <Button variant="danger" onClick={() => setModal("reset")}>
                    초기화
                  </Button>
                </div>
              </section>
            </div>
          )}

          {active === "snapshot" &&
            (() => {
              const citedPage = pages.find((p) => p.id === route.split("/")[2]);
              const citedVersion = citedPage?.versions.find(
                (v) => v.number === Number(route.split("/")[3]),
              );
              return citedPage && citedVersion ? (
                <div className="page-wrap narrow">
                  <Badge tone="plum">
                    인용한 발행본 · v{citedVersion.number}
                  </Badge>
                  <h1>{citedPage.title}</h1>
                  <p className="muted">
                    현재 v{latest(citedPage).number} · 아래는 답변에서 인용한
                    고정 버전입니다.
                  </p>
                  <Markdown text={citedVersion.content} />
                  <Button onClick={() => go(`/wiki/${citedPage.id}`)}>
                    현재 문서 보기
                  </Button>
                </div>
              ) : (
                <Empty
                  title="인용 버전을 열 수 없습니다"
                  description="현재 역할과 문서 버전을 확인하세요."
                />
              );
            })()}

          {active === "shared" &&
            (shared ? (
              <div className="page-wrap narrow">
                <Badge tone="plum">공유 문서 · 이 브라우저에서만 유효</Badge>
                <h1>{shared.page.title}</h1>
                <div className="doc-meta">
                  v{shared.version.number} · {scopeText[shared.page.scope]}
                </div>
                <Markdown text={shared.version.content} />
              </div>
            ) : (
              <Empty
                title="유효하지 않은 공유 링크예요"
                description="만료·철회됐거나 다른 브라우저의 링크입니다. 이 데모는 서버 공유를 제공하지 않습니다."
              >
                <Button onClick={() => go("/")}>지식 공간으로</Button>
              </Empty>
            ))}
          {![
            "home",
            "wiki",
            "sources",
            "review",
            "manager",
            "compile",
            "activity",
            "usage",
            "roadmap",
            "settings",
            "shared",
            "snapshot",
          ].includes(active) && (
            <Empty
              title="페이지를 찾을 수 없어요"
              description="지식 공간에서 다시 시작하세요."
            >
              <Button onClick={() => go("/")}>지식 공간으로</Button>
            </Empty>
          )}
        </main>
        <footer className="app-footer">
          <span>
            agent-knowledge-hub <i>·</i> 합성 데이터 / 로컬 저장 / 오프라인·모델
            선택
          </span>
          <a href="#/roadmap">
            구현 범위와 로드맵 <ArrowRight size={12} />
          </a>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === "source" && (
        <Modal title="새 산출물 등록" onClose={() => setModal(null)}>
          <p className="modal-intro">
            LLM과 함께 만든 결과를 기존 지식에 연결해보세요.
          </p>
          <form onSubmit={submitSource}>
            <Field label="산출물 제목">
              <input
                name="title"
                required
                maxLength={150}
                placeholder="예: Alpine 이미지 인증서 설정 검증"
              />
            </Field>
            <div className="form-grid">
              <Field label="생성 도구">
                <select name="tool">
                  <option>OpenCode</option>
                  <option>Claude Code</option>
                  <option>수동 등록</option>
                </select>
              </Field>
              <Field label="프로젝트">
                <input
                  name="project"
                  defaultValue="platform-runtime"
                  maxLength={120}
                />
              </Field>
            </div>
            <Field label="연결할 지식">
              <select
                name="target"
                defaultValue={
                  pages.find((p) => p.scope === "private")?.id ?? pages[0]?.id
                }
              >
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="결과와 적용 조건">
              <textarea
                name="content"
                required
                rows={5}
                maxLength={20000}
                placeholder="어떤 환경에서 무엇을 확인했나요? 실제 자격증명은 입력하지 마세요."
              />
            </Field>
            <div className="form-grid">
              <Field label="공개 범위">
                <select name="scope">
                  <option value="private">나만 보기</option>
                  <option value="team">플랫폼팀</option>
                  <option value="company">전사 공유</option>
                </select>
              </Field>
              <Field
                label="확인 상태"
                hint="실행 증거의 진위를 확인하지 않는 데모입니다."
              >
                <select name="verification">
                  <option>미검증</option>
                  <option>작성자 확인</option>
                  <option>실행 증거 첨부</option>
                </select>
              </Field>
            </div>
            <div className="modal-footer">
              <Button type="button" onClick={() => setModal(null)}>
                취소
              </Button>
              <Button type="submit" variant="primary">
                수집함에 등록 <ArrowRight size={15} />
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {sourceId &&
        (() => {
          const s = sources.find((x) => x.id === sourceId);
          return (
            <Modal title="산출물 원본" onClose={() => setSourceId(null)}>
              {s ? (
                <>
                  <div className="source-detail">
                    <Badge tone="plum">{s.tool}</Badge>
                    <h2>{s.title}</h2>
                    <p>
                      {s.project} · {scopeText[s.scope]} · {date(s.createdAt)}
                    </p>
                    <div className="source-verification">
                      <ShieldCheck size={15} />
                      {s.verification} <span>합성 시연 데이터</span>
                    </div>
                    <Markdown text={s.content} />
                  </div>
                  <Button
                    onClick={() => {
                      setSourceId(null);
                      go(`/wiki/${s.targetPageId}`);
                    }}
                  >
                    연결된 지식 보기 <ArrowRight size={14} />
                  </Button>
                </>
              ) : (
                <p>현재 범위에서 원본을 볼 수 없습니다.</p>
              )}
            </Modal>
          );
        })()}
      {modal === "versions" && page && (
        <Modal title="버전 기록" wide onClose={() => setModal(null)}>
          <div className="version-layout">
            <div className="version-list">
              {[...page.versions].reverse().map((v) => (
                <button
                  key={v.id}
                  className={
                    (selectedVersion ?? latest(page).number) === v.number
                      ? "active"
                      : ""
                  }
                  onClick={() => setSelectedVersion(v.number)}
                >
                  <strong>
                    v{v.number}
                    {v.number === latest(page).number && (
                      <Badge tone="green">현재</Badge>
                    )}
                  </strong>
                  <span>{v.reason}</span>
                  <small>
                    {date(v.at)} {time(v.at)} · {v.author}
                  </small>
                </button>
              ))}
            </div>
            <div className="version-content">
              <Markdown
                text={
                  (
                    page.versions.find((v) => v.number === selectedVersion) ||
                    latest(page)
                  ).content
                }
              />
            </div>
          </div>
          <div className="modal-footer">
            <span className="muted">
              복원은 새 버전을 만들며 현재 공개 범위를 유지합니다.
            </span>
            <Button
              disabled={
                !selectedVersion ||
                selectedVersion === latest(page).number ||
                !canReview(state)
              }
              onClick={() => {
                if (
                  selectedVersion &&
                  send({
                    type: "RESTORE",
                    id: page.id,
                    version: selectedVersion,
                  })
                ) {
                  setModal(null);
                  notify("선택한 내용으로 새 버전을 만들었습니다.");
                }
              }}
            >
              선택 버전 복원
            </Button>
          </div>
        </Modal>
      )}
      {modal === "edit" && page && (
        <Modal title="문서 편집" wide onClose={() => setModal(null)}>
          <div className="notice compact">
            데모에서는 저장 시 새 버전으로 즉시 발행됩니다. 운영용 초안·검토는
            로드맵 항목입니다.
          </div>
          <textarea
            className="editor"
            aria-label="Markdown 본문"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
          />
          <div className="modal-footer">
            <Button onClick={() => setModal(null)}>취소</Button>
            <Button
              variant="primary"
              disabled={!editing.trim()}
              onClick={() => {
                if (
                  send({
                    type: "SAVE_PAGE",
                    id: page.id,
                    content: editing,
                    baseVersion: editBase,
                  })
                ) {
                  setModal(null);
                  notify("새 버전으로 저장했습니다.");
                }
              }}
            >
              새 버전 저장
            </Button>
          </div>
        </Modal>
      )}
      {modal === "share" && page && (
        <Modal title="지식 공유" onClose={() => setModal(null)}>
          <div className="notice compact">
            <LockKeyhole size={16} />
            실제 사내 공유가 아닌 동일 브라우저 안에서의 링크 동작 시연입니다.
          </div>
          <p className="modal-intro">{page.title}</p>
          <div className="form-grid">
            <Field label="공유 버전">
              <select
                value={shareFixed ? "fixed" : "latest"}
                onChange={(e) => setShareFixed(e.target.value === "fixed")}
              >
                <option value="latest">항상 최신 발행본</option>
                <option value="fixed">현재 v{latest(page).number} 고정</option>
              </select>
            </Field>
            <Field label="만료">
              <select
                value={shareDuration}
                onChange={(e) => setShareDuration(e.target.value)}
              >
                <option value="1">1일 후</option>
                <option value="7">7일 후</option>
                <option value="30">30일 후</option>
              </select>
            </Field>
          </div>
          <Button
            variant="primary"
            onClick={() =>
              send({
                type: "SHARE",
                share: {
                  id: makeId(),
                  pageId: page.id,
                  version: shareFixed ? latest(page).number : undefined,
                  expiresAt: new Date(
                    Date.now() + Number(shareDuration) * 86400000,
                  ).toISOString(),
                  revoked: false,
                },
              })
            }
          >
            <Plus size={14} />
            데모 공유 링크 만들기
          </Button>
          <div className="share-list">
            {state.shares
              .filter((s) => s.pageId === page.id)
              .map((s) => (
                <div key={s.id}>
                  <div>
                    <Badge tone={s.revoked ? "neutral" : "green"}>
                      {s.revoked
                        ? "철회됨"
                        : s.version
                          ? `v${s.version} 고정`
                          : "최신본"}
                    </Badge>
                    <small>{date(s.expiresAt)} 만료</small>
                  </div>
                  <input
                    readOnly
                    aria-label="공유 링크"
                    value={`${location.origin}${location.pathname}#/shared/${s.id}`}
                  />
                  <div>
                    <Button
                      disabled={s.revoked}
                      onClick={() =>
                        copy(
                          `${location.origin}${location.pathname}#/shared/${s.id}`,
                        )
                      }
                    >
                      {copied ? <Check size={13} /> : <Copy size={13} />}복사
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={s.revoked}
                      onClick={() => send({ type: "REVOKE_SHARE", id: s.id })}
                    >
                      철회
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal
          title="agent-knowledge-hub 데모 안내"
          onClose={() => setModal(null)}
        >
          <p>
            사내 업무 산출물이 검토된 지식으로 축적되는 흐름을 시연합니다. 실제
            시스템과 계정에는 연결되지 않습니다.
          </p>
          <ol className="help-steps">
            <li>
              <b>위키 매니저</b>에서 Daily 점검을 실행하세요.
            </li>
            <li>
              <b>변경 검토</b>에서 근거와 추가 사례를 확인하세요.
            </li>
            <li>
              <b>승인 → 발행</b> 후 문서의 새 버전을 읽으세요.
            </li>
            <li>
              <b>버전 복원·공유·재사용 피드백</b>을 시험하세요.
            </li>
          </ol>
          <p className="muted">
            실제 보안·무인 스케줄러·다중 사용자 저장은 미구현입니다. 모델 연결은
            지식 컴파일에서 선택합니다. 화면 상단 역할 전환은 UX 시연이며 보안
            경계가 아닙니다.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              setModal(null);
              go("/manager");
            }}
          >
            시연 시작 <ArrowRight size={15} />
          </Button>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="데모를 초기화할까요?" onClose={() => setModal(null)}>
          <p>
            이 브라우저에 추가한 산출물, 변경안, 문서 버전과 공유 링크를
            삭제합니다.
          </p>
          <div className="modal-footer">
            <Button onClick={() => setModal(null)}>취소</Button>
            <Button
              variant="danger"
              onClick={() => {
                try {
                  const next = demoRepository.reset();
                  setState(next);
                  setModal(null);
                  go("/");
                  notify("처음 상태로 되돌렸습니다.");
                } catch {
                  notify(
                    "저장소에 접근할 수 없습니다. 브라우저 설정을 확인하세요.",
                  );
                }
              }}
            >
              초기화
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
