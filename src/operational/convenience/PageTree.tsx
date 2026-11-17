import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, FolderTree } from "lucide-react";
import { Button } from "../../ui/primitives";
import { ApiError, documentHref, type OperationalApi } from "../api";
import { usePersonalKey } from "./personal-client";
import "./structure.css";
export interface StructureNode {
  id: string;
  title: string;
  version: number;
  revision: number;
  hasChildren: boolean;
}
interface TreePage {
  items: StructureNode[];
  revision: string;
  nextCursor: string | null;
  partial?: boolean;
}
interface Props {
  api: OperationalApi;
  spaceId: string;
  principalId: string;
  pageId?: string;
  refreshKey?: string;
  onSelect?: (id: string) => boolean | void;
  onMobileSelect?: (id: string) => boolean | void;
  onChoose?: (node: StructureNode) => void;
}
function branchPath(parentId: string | null, cursor?: string | null) {
  const q = new URLSearchParams({ limit: "25" });
  if (parentId) q.set("parentId", parentId);
  if (cursor) q.set("cursor", cursor);
  return "/convenience/tree?" + q;
}
export function PageTree(props: Props) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.principalId}:${props.refreshKey ?? ""}`,
  );
  return <TreeBranch key={key} {...props} parentId={null} />;
}
function TreeBranch({
  parentId,
  ...props
}: Props & { parentId: string | null }) {
  const [page, setPage] = useState<TreePage | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]);
  const generation = useRef(0);
  async function load(cursor?: string | null) {
    const n = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await props.api.get<TreePage>(branchPath(parentId, cursor));
      if (n === generation.current) {
        setPage(next);
        setExpanded([]);
      }
    } catch (e) {
      if (n === generation.current) {
        setPage(null);
        setError(
          e instanceof ApiError && e.code === "STALE_CURSOR"
            ? "문서 목록이 변경되었습니다. 다시 불러오세요."
            : "문서 목록을 불러오지 못했습니다.",
        );
      }
    } finally {
      if (n === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [props.api, parentId]);
  return (
    <div className="document-tree-branch" aria-busy={busy}>
      {error && (
        <p role="alert">
          {error} <Button onClick={() => void load()}>다시 불러오기</Button>
        </p>
      )}
      {!page && !error && <p role="status">문서 목록을 불러오는 중…</p>}
      {page && (
        <>
          <ul>
            {page.items.map((node) => (
              <li key={node.id}>
                <div className="document-tree-row">
                  {node.hasChildren ? (
                    <button
                      className="icon-button"
                      aria-expanded={expanded.includes(node.id)}
                      aria-label={`${node.title} 하위 문서 ${expanded.includes(node.id) ? "접기" : "펼치기"}`}
                      onClick={() =>
                        setExpanded((old) =>
                          old.includes(node.id)
                            ? old.filter((x) => x !== node.id)
                            : [...old, node.id],
                        )
                      }
                    >
                      {expanded.includes(node.id) ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                  ) : (
                    <span className="document-tree-leaf" />
                  )}
                  {props.onChoose ? (
                    <button
                      className="document-tree-pick"
                      onClick={() => props.onChoose?.(node)}
                    >
                      {node.title}
                    </button>
                  ) : (
                    <a
                      aria-current={
                        props.pageId === node.id ? "page" : undefined
                      }
                      href={documentHref(props.spaceId, node.id)}
                      onClick={(e) => {
                        if (
                          props.onSelect &&
                          !e.ctrlKey &&
                          !e.metaKey &&
                          !e.shiftKey &&
                          !e.altKey
                        ) {
                          e.preventDefault();
                          props.onSelect(node.id);
                        }
                      }}
                    >
                      {node.title}
                    </a>
                  )}
                </div>
                {expanded.includes(node.id) && (
                  <TreeBranch {...props} parentId={node.id} />
                )}
              </li>
            ))}
          </ul>
          {!page.items.length && !page.nextCursor && (
            <p>표시할 문서가 없습니다.</p>
          )}
          {page.partial && (
            <p>목록 일부를 확인했습니다. 계속 탐색할 수 있습니다.</p>
          )}
          {page.nextCursor && (
            <Button disabled={busy} onClick={() => void load(page.nextCursor)}>
              다음 문서
            </Button>
          )}
        </>
      )}
    </div>
  );
}
export function StructureDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button,input,select,a")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="overlay">
      <section
        className="modal document-structure-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                "button:not([disabled]),input,select,a[href]",
              ) ?? [],
            );
            const first = items[0],
              last = items.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <Button onClick={onClose}>닫기</Button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function DocumentTreeNavigation(props: Props) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("[data-document-heading]")?.focus(),
    );
  };
  return (
    <>
      <nav className="document-tree-desktop" aria-label="문서 트리">
        <h3>
          <FolderTree size={18} /> 문서 트리
        </h3>
        <PageTree {...props} />
      </nav>
      <Button className="document-tree-toggle" onClick={() => setOpen(true)}>
        문서 트리 열기
      </Button>
      {open && (
        <StructureDialog title="문서 트리" onClose={close}>
          <PageTree
            {...props}
            onSelect={(id) => {
              if ((props.onMobileSelect ?? props.onSelect)?.(id) !== false) setOpen(false);
            }}
          />
        </StructureDialog>
      )}
    </>
  );
}
interface ControlsProps extends Props {
  pageId: string;
  version: number;
  revision: number;
  capabilities: string[];
  onChanged: () => Promise<void>;
  canLeave?: () => boolean;
}
export function DocumentStructureControls(props: ControlsProps) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.principalId}:${props.pageId}:${props.revision}:${props.capabilities.join(",")}`,
  );
  return <Controls key={key} {...props} />;
}
function Controls(props: ControlsProps) {
  const [open, setOpen] = useState(false),
    [parent, setParent] = useState<StructureNode | null>(null),
    [page, setPage] = useState<TreePage | null>(null),
    [before, setBefore] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const positionGeneration = useRef(0);
  const pending = useRef<{ key: string; id: string } | null>(null),
    alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const n = ++positionGeneration.current;
    if (!open) return;
    let live = true;
    setPage(null);
    setBefore("");
    void props.api
      .get<TreePage>(branchPath(parent?.id ?? null))
      .then((x) => {
        if (live && n === positionGeneration.current) setPage(x);
      })
      .catch(() => {
        if (live && n === positionGeneration.current)
          setError(
            "이동 위치를 불러오지 못했습니다. 창을 닫고 다시 시도하세요.",
          );
      });
    return () => {
      live = false;
      positionGeneration.current++;
    };
  }, [open, parent?.id, props.api]);
  async function run(kind: "move" | "duplicate" | "child") {
    if (working.current || props.canLeave?.() === false) return;
    if (kind === "move" && (!reason.trim() || !page)) {
      setError("이동 이유와 현재 배치 위치를 확인하세요.");
      return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    const body =
      kind === "move"
        ? {
            pageId: props.pageId,
            parentId: parent?.id ?? null,
            beforeId: before || null,
            expectedRevision: props.revision,
            expectedStructureRevision: page!.revision,
            reason: reason.trim(),
          }
        : kind === "duplicate"
          ? { pageId: props.pageId, version: props.version, parentId: null }
          : {
              expectedRevision: 0,
              title: "새 문서",
              content: "## 새 문서\n\n",
              parentId: props.pageId,
            };
    const key = JSON.stringify([kind, body]);
    if (pending.current?.key !== key)
      pending.current = { key, id: crypto.randomUUID() };
    const mutationId = pending.current.id;
    try {
      const result = await props.api.post<{ id: string }>(
        kind === "move"
          ? "/convenience/pages/move"
          : kind === "duplicate"
            ? "/convenience/pages/duplicate"
            : "/workflows/drafts",
        {
          ...body,
          ...(kind === "child" ? { id: "child-" + mutationId } : {}),
          mutationId,
        },
      );
      if (!alive.current) return;
      pending.current = null;
      if (kind === "move") {
        setOpen(false);
        setNotice("문서 위치를 저장했습니다.");
        await props.onChanged();
      } else
        window.location.assign(
          `/?app=1&space=${encodeURIComponent(props.spaceId)}&section=compose&draft=${encodeURIComponent(result.id)}`,
        );
    } catch (e) {
      if (alive.current) {
        setError(
          e instanceof Error ? e.message : "요청을 완료하지 못했습니다.",
        );
        if (
          e instanceof ApiError &&
          ["STALE_VERSION", "STALE_CURSOR"].includes(e.code)
        ) {
          pending.current = null;
          setPage(null);
        }
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="document-structure-controls"
      aria-label="문서 구조 작업"
    >
      <div className="op-actions">
        {props.capabilities.includes("knowledge.protect") && (
          <Button
            onClick={() => {
              setError("");
              setOpen(true);
            }}
          >
            문서 이동
          </Button>
        )}
        {props.capabilities.includes("draft.write") && (
          <>
            <Button disabled={busy} onClick={() => void run("duplicate")}>
              개인 초안으로 복제
            </Button>
            <Button disabled={busy} onClick={() => void run("child")}>
              하위 문서 작성
            </Button>
          </>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !open && <p role="alert">{error}</p>}
      {open && (
        <StructureDialog
          title="문서 이동"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p>대상 상위 문서: {parent?.title ?? "최상위"}</p>
          <Button disabled={busy} onClick={() => setParent(null)}>
            최상위 선택
          </Button>
          <PageTree
            api={props.api}
            spaceId={props.spaceId}
            principalId={props.principalId}
            onChoose={(node) => {
              if (!busy) setParent(node);
            }}
          />
          <label>
            배치 위치
            <select
              aria-label="배치 위치"
              disabled={busy || !page}
              value={before}
              onChange={(e) => setBefore(e.target.value)}
            >
              <option value="">마지막</option>
              {page?.items
                .filter((x) => x.id !== props.pageId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} 앞
                  </option>
                ))}
            </select>
          </label>
          {page?.nextCursor && (
            <Button
              disabled={busy}
              onClick={() => {
                const n = ++positionGeneration.current;
                setPage(null);
                void props.api
                  .get<TreePage>(
                    branchPath(parent?.id ?? null, page.nextCursor),
                  )
                  .then((value) => {
                    if (alive.current && n === positionGeneration.current) {
                      setBefore("");
                      setPage(value);
                    }
                  })
                  .catch(() => {
                    if (alive.current && n === positionGeneration.current)
                      setError("목록이 변경되었습니다. 이동 창을 다시 여세요.");
                  });
              }}
            >
              다음 배치 위치
            </Button>
          )}
          <details className="document-drag-placement">
            <summary>끌어서 배치 위치 선택</summary>
            <p>
              현재 문서를 대상 문서 앞에 끌어놓으세요. 위 배치 위치 선택으로도
              같은 작업을 할 수 있습니다.
            </p>
            <div
              className="document-drag-source"
              draggable={!busy && !!page}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", props.pageId);
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              현재 문서
            </div>
            <ul>
              {page?.items
                .filter((x) => x.id !== props.pageId)
                .map((x) => (
                  <li
                    key={x.id}
                    data-before-id={x.id}
                    onDragOver={(e) => {
                      if (!busy) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (
                        !busy &&
                        e.dataTransfer.getData("text/plain") === props.pageId
                      )
                        setBefore(x.id);
                    }}
                  >
                    {x.title} 앞{before === x.id ? " · 선택됨" : ""}
                  </li>
                ))}
            </ul>
          </details>
          <label>
            이동 이유
            <input
              aria-label="이동 이유"
              maxLength={2000}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button disabled={busy || !page} onClick={() => void run("move")}>
            이동 적용
          </Button>
        </StructureDialog>
      )}
    </section>
  );
}
