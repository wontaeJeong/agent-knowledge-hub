import { useEffect, useState, useCallback, useRef } from "react";
import { ApiError, OperationalApi, pageItems, documentHref } from "./api";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { StoragePanel } from "./storage";
import { Button } from "../ui/primitives";
import type { Page } from "../domain/types";
import {
  DraftAutosave,
  RecoveryCache,
  draftRequest,
  saveStatusLabel,
  type RecoveryBinding,
  type RecoveredDraft,
  type SaveStatus,
  type RecoveryValidation,
} from "./draft-recovery";

interface PrivateDraft {
  id: string;
  revision: number;
  title: string;
  content: string;
  pageId?: string;
  baseVersion?: number;
  sourceIds?: string[];
  dependencyVersions?: Record<string, number>;
}
interface DocumentDetail {
  page: Page;
  settings: {
    revision: number;
    state: string;
    parent_id: string | null;
    data: {
      protected?: boolean;
      reason?: string;
      properties?: Record<string, string>;
    };
  };
}
interface Comment {
  id: string;
  principal_id: string;
  revision: number;
  version: number;
  anchor: string;
  content: string;
  resolved: boolean;
  deleted: boolean;
}
interface Notice {
  id: string;
  page_id: string;
  title: string;
  kind: string;
  read_at: string | null;
}
interface TrashItem {
  id: string;
  title: string;
  revision: number;
}
interface Template {
  id: string;
  revision: number;
  title: string;
  content: string;
  originPageId?: string;
  originVersion?: number;
}
export function draftInput(
  draft: PrivateDraft,
  content: string,
  _displayedVersion: number,
) {
  return {
    id: draft.id,
    expectedRevision: draft.revision,
    title: draft.title,
    content,
    pageId: draft.pageId,
    baseVersion: draft.baseVersion,
    ...(draft.sourceIds ? { sourceIds: draft.sourceIds } : {}),
    ...(draft.dependencyVersions
      ? { dependencyVersions: draft.dependencyVersions }
      : {}),
  };
}

export function SourceLifecycle({
  api,
  sourceId,
  canCorrect,
  canWithdraw,
  canSetPolicy = false,
  perform,
}: {
  api: OperationalApi;
  sourceId: string;
  canCorrect: boolean;
  canWithdraw: boolean;
  canSetPolicy?: boolean;
  perform: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [content, setContent] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  if (!canCorrect && !canWithdraw && !canSetPolicy) return null;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await perform(fn);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>원본 정정·철회</summary>
      <p>
        원본을 덮어쓰지 않습니다. 정정본은 별도 원본으로 등록한 뒤 편입·검토해야
        합니다. 철회하면 관련 지식의 접근과 발행을 다시 검사합니다.
      </p>
      {notice && <p role="status">{notice}</p>}
      <label>
        정정·철회 이유
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          disabled={busy}
        />
      </label>
      {canCorrect && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (
                !window.confirm(
                  "별도 불변 원본을 등록할까요? 기존 원본·발행본은 덮어쓰지 않습니다.",
                )
              )
                return;
              const created = await api.post<{ id: string }>(
                `/workflows/sources/${encodeURIComponent(sourceId)}/correct`,
                { id: crypto.randomUUID(), content, reason },
              );
              setNotice(
                `정정 원본 ${created.id}을 등록했습니다. 별도로 편입·검토하세요.`,
              );
              setContent("");
            });
          }}
        >
          <label>
            정정된 원본 본문
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              maxLength={100000}
              disabled={busy}
            />
          </label>
          <Button type="submit" disabled={busy || !reason.trim()}>
            별도 원본으로 정정
          </Button>
        </form>
      )}
      {canWithdraw && (
        <Button
          disabled={busy || !reason.trim()}
          onClick={() =>
            run(async () => {
              if (
                !window.confirm(
                  "원본을 철회할까요? 이 원본에 의존하는 지식은 보이지 않거나 재검토가 필요해집니다.",
                )
              )
                return;
              await api.post(
                `/workflows/sources/${encodeURIComponent(sourceId)}/withdraw`,
                { reason },
              );
              setNotice("원본을 철회했습니다.");
            })
          }
        >
          원본 철회 확인
        </Button>
      )}
      {canSetPolicy && (
        <SourceEgressPolicy api={api} sourceId={sourceId} perform={perform} />
      )}
    </details>
  );
}

function SourceEgressPolicy({
  api,
  sourceId,
  perform,
}: {
  api: OperationalApi;
  sourceId: string;
  perform: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [policy, setPolicy] = useState<{
      localCopyAllowed: boolean;
      exportAllowed: boolean;
      policyVersion: number;
    } | null>(null),
    [busy, setBusy] = useState(false);
  const path = `/sources/${encodeURIComponent(sourceId)}/policy`;
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !policy && !busy) {
          setBusy(true);
          void perform(async () => {
            setPolicy(await api.get(path));
          }).finally(() => setBusy(false));
        }
      }}
    >
      <summary>원본 반출 정책 · 관리자</summary>
      <p>
        기본은 금지입니다. 승인된 운영 정책에 따라 허용하세요. 이미 복사한
        파일의 완전한 사후 회수를 보장하지 않습니다. 이 설정 자체는 원본
        시스템·조직의 승인 증거가 아닙니다.
      </p>
      {policy && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !window.confirm(
                "현재 원본과 파생 지식의 로컬 복사·내보내기 허용을 변경할까요? 기존 독자 제한은 유지됩니다.",
              )
            )
              return;
            setBusy(true);
            void perform(async () => {
              const next = await api.post<{ policyVersion: number }>(path, {
                localCopyAllowed: policy.localCopyAllowed,
                exportAllowed: policy.exportAllowed,
                expectedVersion: policy.policyVersion,
              });
              setPolicy({ ...policy, policyVersion: next.policyVersion });
            }).finally(() => setBusy(false));
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={policy.localCopyAllowed}
              onChange={(e) =>
                setPolicy({ ...policy, localCopyAllowed: e.target.checked })
              }
              disabled={busy}
            />
            허용된 독자의 로컬 복사 허용
          </label>
          <label>
            <input
              type="checkbox"
              checked={policy.exportAllowed}
              onChange={(e) =>
                setPolicy({ ...policy, exportAllowed: e.target.checked })
              }
              disabled={busy}
            />
            허용된 독자의 내보내기 허용
          </label>
          <Button type="submit" disabled={busy}>
            반출 정책 변경 확인
          </Button>
        </form>
      )}
    </details>
  );
}
function Pager({
  count,
  page,
  set,
}: {
  count: number;
  page: number;
  set: (p: number) => void;
}) {
  if (count <= 25) return null;
  return (
    <div className="op-actions">
      <Button disabled={!page} onClick={() => set(page - 1)}>
        이전 25건
      </Button>
      <span>
        {page + 1} / {Math.ceil(count / 25)} · 전체 {count}건
      </span>
      <Button disabled={(page + 1) * 25 >= count} onClick={() => set(page + 1)}>
        다음 25건
      </Button>
    </div>
  );
}
export function WorkflowPanel({
  api,
  pages,
  capabilities,
  onChanged,
  onExpired,
  principalId,
  spaceId,
  initialPageId,
}: {
  api: OperationalApi;
  pages: { id: string; title: string }[];
  capabilities: string[];
  onChanged: () => Promise<void>;
  onExpired: () => void;
  principalId?: string;
  spaceId?: string;
  initialPageId?: string;
}) {
  const [selected, setSelected] = useState(initialPageId ?? "");
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [drafts, setDrafts] = useState<PrivateDraft[]>([]);
  const [notifications, setNotifications] = useState<Notice[]>([]);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<PrivateDraft | null>(null);
  const [content, setContent] = useState("");
  const autosave = useRef<DraftAutosave | null>(null);
  const recoveryCache = useRef<RecoveryCache | null>(null);
  const recoveryGrant = useRef<RecoveryBinding | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [localRecovery, setLocalRecovery] = useState<RecoveredDraft | null>(
    null,
  );
  const [localCopyNotice, setLocalCopyNotice] = useState(
    "로컬 복사 허용을 확인하기 전에는 브라우저에 본문을 보관하지 않습니다.",
  );
  const [conflictServer, setConflictServer] = useState<PrivateDraft | null>(
    null,
  );
  const [conflictRevision, setConflictRevision] = useState(0);
  const resumeRecovery = useRef<RecoveredDraft | null>(null);
  const identityScope = `${principalId ?? ""}:${spaceId ?? ""}`;
  const previousIdentity = useRef(identityScope);
  const identityChanged = previousIdentity.current !== identityScope;
  useEffect(() => {
    if (previousIdentity.current !== identityScope) {
      previousIdentity.current = identityScope;
      autosave.current?.dispose();
      recoveryCache.current?.clearAll();
      recoveryGrant.current = null;
      resumeRecovery.current = null;
      setDraft(null);
      setContent("");
      setDetail(null);
      setLocalRecovery(null);
    }
  }, [identityScope]);
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [anchor, setAnchor] = useState("");
  const [mentions, setMentions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commentPage, setCommentPage] = useState(0);
  const [draftPage, setDraftPage] = useState(0);
  const [templatePage, setTemplatePage] = useState(0);
  const [notificationPage, setNotificationPage] = useState(0);
  const [trashPage, setTrashPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [parent, setParent] = useState("");
  const [properties, setProperties] = useState("{}");
  const [editingComment, setEditingComment] = useState<{
    id: string;
    content: string;
  } | null>(null);
  const can = (action: string) => capabilities.includes(action);
  const write = can("draft.write"),
    propose = can("changeset.propose"),
    manage = can("lifecycle.manage");
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        recoveryCache.current?.clearAll();
        recoveryGrant.current = null;
        autosave.current?.dispose();
        setLocalRecovery(null);
        setDetail(null);
        setComments([]);
        setDraft(null);
        setContent("");
        setDrafts([]);
        setNotifications([]);
        setTemplates([]);
        setTrash([]);
        if (e.status === 401) onExpired();
      }
      setError(e instanceof Error ? e.message : "요청을 완료하지 못했습니다.");
    },
    [onExpired],
  );
  // A cached body is never assigned to UI fields until a fresh identity and the
  // server's current full-lineage/local.copy/CAS check have succeeded.
  useEffect(() => {
    setLocalRecovery(null);
    if (!principalId || !spaceId || !selected || !detail || draft) return;
    const abort = new AbortController();
    let active = true;
    try {
      recoveryCache.current ??= new RecoveryCache(window.localStorage);
    } catch {
      return;
    }
    void recoveryCache.current
      .recover(principalId, spaceId, selected, async (binding) => {
        const identity = await draftRequest<{
          principalId: string;
          workspaceId: string;
        }>(api, "/me", undefined, abort.signal);
        if (
          identity.principalId !== principalId ||
          identity.workspaceId !== spaceId
        )
          throw new ApiError("현재 계정 또는 공간이 변경되었습니다.", 403);
        return draftRequest<RecoveryValidation>(
          api,
          "/workflows/recovery/validate",
          { binding },
          abort.signal,
        );
      })
      .then((recovered) => {
        if (active) setLocalRecovery(recovered);
      })
      .catch((e) => {
        if (active) {
          setContent("");
          setDraft(null);
          setLocalRecovery(null);
          setLocalCopyNotice(
            "이전 입력은 현재 권한·정책을 확인할 수 없어 브라우저에서 제거했습니다. 오프라인 복원은 제공하지 않습니다.",
          );
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            fail(e);
        }
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [api, principalId, spaceId, selected, detail?.page.id, draft?.id, fail]);
  useEffect(() => {
    if (!draft || !principalId || !spaceId || identityChanged) return;
    let active = true;
    const original = draft;
    const grantAbort = new AbortController();
    recoveryGrant.current = null;
    try {
      recoveryCache.current ??= new RecoveryCache(window.localStorage);
    } catch {
      /* Server autosave remains available. */
    }
    const resuming = resumeRecovery.current;
    resumeRecovery.current = null;
    const instance = new DraftAutosave(
      original,
      async (input, signal) => {
        try {
          return await draftRequest<PrivateDraft>(
            api,
            "/workflows/drafts",
            input,
            signal,
          );
        } catch (e) {
          if (
            active &&
            e instanceof ApiError &&
            [401, 403, 404].includes(e.status)
          )
            fail(e);
          throw e;
        }
      },
      (state) => {
        if (!active) return;
        setSaveStatus(state.status);
        setDraft(state.draft);
        if (state.status === "saved")
          recoveryCache.current?.clear(principalId, spaceId, selected);
        else
          recoveryCache.current?.write(
            recoveryGrant.current,
            state.draft,
            state.content,
            state.pending,
          );
        if (state.status === "conflict") {
          // Readback remains current-authorized; never overwrite the unsent side.
          void draftRequest<{ items: PrivateDraft[] }>(
            api,
            "/workflows/drafts",
            undefined,
            instance.abort.signal,
          )
            .then((result) => {
              if (!active) return;
              const server =
                result.items.find((d) => d.id === original.id) ?? null;
              setConflictServer(server);
              setConflictRevision(server?.revision ?? 0);
            })
            .catch((e) => {
              if (active) fail(e);
            });
        }
      },
      resuming?.pending,
    );
    autosave.current = instance;
    setSaveStatus(instance.status);
    instance.content = content;
    if (resuming?.validation.status === "conflict") {
      instance.conflict(resuming.validation.serverDraft);
      setConflictServer(resuming.validation.serverDraft);
      setConflictRevision(resuming.validation.revision);
    }
    const permission = async () => {
      if (!active) return;
      try {
        const d = instance.draft;
        const binding = await draftRequest<RecoveryBinding>(
          api,
          "/workflows/recovery/permission",
          {
            id: d.id,
            pageId: d.pageId,
            baseVersion: d.baseVersion,
            expectedRevision: d.revision,
            sourceIds: d.sourceIds ?? [],
            dependencyVersions: d.dependencyVersions ?? {},
          },
          grantAbort.signal,
        );
        if (!active) return;
        if (
          binding.principalId !== principalId ||
          binding.workspaceId !== spaceId
        ) {
          fail(new ApiError("현재 계정 또는 공간이 변경되었습니다.", 403));
          return;
        }
        recoveryGrant.current = binding;
        setLocalCopyNotice(
          "로컬 복사가 허용된 입력만 최대 5분·항목 128KiB·전체 512KiB/10건 한도로 임시 보관합니다. 재시작 복원에는 온라인 권한 재확인이 필요합니다.",
        );
        if (instance.content !== instance.draft.content || instance.pending)
          recoveryCache.current?.write(
            binding,
            instance.draft,
            instance.content,
            instance.pending,
          );
      } catch (e) {
        if (!active) return;
        recoveryGrant.current = null;
        if (e instanceof ApiError)
          recoveryCache.current?.clear(principalId, spaceId, selected);
        setLocalCopyNotice(
          "브라우저 복구 보관은 허용되지 않거나 현재 확인할 수 없습니다. 서버 자동 저장만 사용하며 미전송 입력은 재시작 시 유실될 수 있습니다.",
        );
        if (e instanceof ApiError && [401, 404].includes(e.status)) fail(e);
      }
    };
    void permission();
    const renewal = setInterval(() => {
      if (navigator.onLine) void permission();
    }, 60000);
    const flush = () => {
      void instance.flush();
    };
    const reconnect = () => {
      void permission().then(flush);
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("pagehide", flush); // best-effort only, never guaranteed delivery
    if (content !== original.content && instance.status !== "conflict")
      instance.edit(content);
    return () => {
      active = false;
      grantAbort.abort();
      instance.dispose();
      clearInterval(renewal);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pagehide", flush);
      recoveryGrant.current = null;
      autosave.current = null;
      recoveryCache.current?.clearAll();
    };
    // The coordinator owns revisions/content after initialization; remount only for identity/space/draft changes.
  }, [api, principalId, spaceId, selected, draft?.id, fail, identityChanged]);
  const flushDraft = async () => {
    const saved = await autosave.current?.flush();
    if (!saved)
      throw Error(
        "개인 초안의 서버 저장을 확인하지 못했습니다. 연결 또는 충돌을 확인하세요.",
      );
    setDraft(saved);
    return saved;
  };
  const load = useCallback(async () => {
    const [d, n, t, x] = await Promise.all([
      write
        ? api.get<{ items: PrivateDraft[] }>("/workflows/drafts")
        : Promise.resolve({ items: [] }),
      api.get<{ items: Notice[] }>("/workflows/notifications"),
      write
        ? api.get<{ items: Template[] }>("/workflows/templates")
        : Promise.resolve({ items: [] }),
      manage
        ? api.get<{ items: TrashItem[] }>("/workflows/trash")
        : Promise.resolve({ items: [] }),
    ]);
    setDrafts(d.items);
    setNotifications(n.items);
    setTemplates(t.items);
    setTrash(x.items);
  }, [api, write, manage]);
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) fail(e);
    });
    return () => {
      active = false;
    };
  }, [load, fail]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setComments([]);
    setCommentPage(0);
    setHistoryPage(0);
    setDraft(null);
    setContent("");
    setReason("");
    if (selected)
      void Promise.all([
        api.get<DocumentDetail>(
          `/workflows/pages/${encodeURIComponent(selected)}`,
        ),
        api.get<{ items: Comment[] }>(
          `/workflows/pages/${encodeURIComponent(selected)}/comments`,
        ),
      ])
        .then(([d, c]) => {
          if (!active) return;
          setDetail(d);
          setComments(c.items);
          const commentId = window.location.hash.match(
            /^#comment-([a-zA-Z0-9_-]{1,100})$/,
          )?.[1];
          if (commentId) {
            const index = c.items.findIndex((item) => item.id === commentId);
            if (index >= 0) setCommentPage(Math.floor(index / 25));
            else
              setError(
                "댓글이 없거나 현재 접근할 수 없습니다. 다른 문단으로 이동하지 않았습니다.",
              );
          }
          setParent(d.settings.parent_id ?? "");
          setProperties(
            JSON.stringify(d.settings.data.properties ?? {}, null, 2),
          );
        })
        .catch((e) => {
          if (active) fail(e);
        });
    return () => {
      active = false;
    };
  }, [api, selected, fail]);
  useEffect(() => {
    const commentId = window.location.hash.match(
      /^#comment-([a-zA-Z0-9_-]{1,100})$/,
    )?.[1];
    if (!commentId || !comments.length) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(`comment-${commentId}`)
        ?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [comments, commentPage]);
  const refreshDocument = async () => {
    if (!selected) return;
    const [d, c] = await Promise.all([
      api.get<DocumentDetail>(
        `/workflows/pages/${encodeURIComponent(selected)}`,
      ),
      api.get<{ items: Comment[] }>(
        `/workflows/pages/${encodeURIComponent(selected)}/comments`,
      ),
    ]);
    setDetail(d);
    setComments(c.items);
  };
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      await onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const latest = detail?.page.versions.at(-1);
  const pagePath = `/workflows/pages/${encodeURIComponent(selected)}`;
  const state = async (next: string) => {
    if (!detail || !reason.trim())
      throw Error("문서 상태를 바꾸는 이유를 입력하세요.");
    if (
      !window.confirm(
        `${detail.page.title}: ${next === "trash" ? "휴지통으로 이동" : next === "archived" ? "보관" : "활성화"}할까요? 현재 접근 권한은 유지됩니다.`,
      )
    )
      return;
    await api.post(`${pagePath}/state`, {
      expectedRevision: detail.settings.revision,
      state: next,
      reason,
    });
    if (next === "trash") {
      setSelected("");
      setDetail(null);
    } else await refreshDocument();
    setNotice("문서 상태를 변경했습니다.");
  };
  return (
    <section className="op-panel">
      <h2>편집과 협업</h2>
      <p>
        개인 초안은 본인에게만 보입니다. 검토·승인 전에는 발행본이 바뀌지
        않습니다.
      </p>
      {error && (
        <p role="alert" className="op-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">서버에 저장하고 있습니다…</p>}
      {localRecovery && !draft && (
        <section
          role="dialog"
          aria-label="개인 초안 입력 복구"
          aria-modal="false"
        >
          <h3>이 브라우저의 미전송 입력 복구</h3>
          <p>
            현재 계정·공간·원본 권한·로컬 복사 정책을 서버에서 확인했습니다.
            자동으로 덮어쓰지 않습니다.
          </p>
          <p>
            문서 {localRecovery.draft.title} · 기준 v
            {localRecovery.draft.baseVersion} · 서버 r
            {localRecovery.validation.revision}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              action(async () => {
                const validation = await draftRequest<RecoveryValidation>(
                  api,
                  "/workflows/recovery/validate",
                  { binding: localRecovery.binding },
                );
                resumeRecovery.current = { ...localRecovery, validation };
                setDraft(localRecovery.draft);
                setContent(localRecovery.content);
                setLocalRecovery(null);
              })
            }
          >
            권한 재확인 후 입력 복구
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (principalId && spaceId)
                recoveryCache.current?.clear(principalId, spaceId, selected);
              setLocalRecovery(null);
            }}
          >
            보관 입력 버리기
          </Button>
        </section>
      )}
      <label>
        문서 선택
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => {
            if (
              draft &&
              content !== draft.content &&
              !window.confirm("저장하지 않은 입력을 닫을까요?")
            )
              return;
            setSelected(e.target.value);
          }}
        >
          <option value="">문서를 선택하세요</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      {detail && latest && (
        <>
          <h3>
            {detail.page.title} · v{latest.number}
          </h3>
          {spaceId && (
            <a href={documentHref(spaceId, detail.page.id)}>문서 고유 링크</a>
          )}
          <details open>
            <summary>현재 발행본 본문 · v{latest.number}</summary>
            <div
              className="op-markdown"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  marked.parse(latest.content, { async: false }),
                ),
              }}
            />
          </details>
          <StoragePanel
            key={`${spaceId}:${selected}`}
            api={api}
            parent={{ kind: "page", id: selected }}
            baseVersion={latest.number}
            transport={(path, init) => api.transport(path, init)}
            canCreate={can("source.create")}
            canExport={can("data.export")}
            onChanged={onChanged}
          />
          <p>
            상태:{" "}
            {detail.settings.state === "active"
              ? "활성"
              : detail.settings.state === "archived"
                ? "보관"
                : "휴지통"}{" "}
            · 보호: {detail.settings.data.protected ? "설정됨" : "설정 안 됨"}
          </p>
          <div className="op-actions">
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.post(`${pagePath}/favorite`, { enabled: true });
                  setNotice("즐겨찾기에 추가했습니다.");
                })
              }
            >
              즐겨찾기 추가
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.post(`${pagePath}/favorite`, { enabled: false });
                  setNotice("즐겨찾기에서 해제했습니다.");
                })
              }
            >
              즐겨찾기 해제
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.post(`${pagePath}/subscribe`, { enabled: true });
                  setNotice("문서 변경 알림을 구독했습니다.");
                })
              }
            >
              알림 구독
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.post(`${pagePath}/subscribe`, { enabled: false });
                  setNotice("구독을 해제했습니다.");
                })
              }
            >
              구독 해제
            </Button>
            {write && (
              <Button
                disabled={busy || !!draft || detail.settings.state !== "active"}
                onClick={() => {
                  setDraft({
                    id: crypto.randomUUID(),
                    revision: 0,
                    title: detail.page.title,
                    content: latest.content,
                    pageId: selected,
                    baseVersion: latest.number,
                  });
                  setContent(latest.content);
                }}
              >
                개인 초안 시작
              </Button>
            )}
          </div>
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const saved = await flushDraft();
                  setDraft(saved);
                  setNotice(
                    "서버에 개인 초안을 저장했습니다. 발행하지 않았습니다.",
                  );
                });
              }}
            >
              <h3>
                개인 초안 · 기준 v{draft.baseVersion} · 저장 r{draft.revision}
              </h3>
              <p role="status">{saveStatusLabel[saveStatus]}</p>
              <p>{localCopyNotice}</p>
              <p>
                입력 후 최대 1초 안에 자동 저장을 시도하며, 포커스 이동·재연결
                때 다시 시도합니다. 탭 종료 전 전송은 최선의 시도이며 전달을
                보장하지 않습니다.
              </p>
              <label>
                Markdown 본문
                <textarea
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    autosave.current?.edit(e.target.value);
                  }}
                  onBlur={() => {
                    void autosave.current?.flush();
                  }}
                  rows={14}
                  required
                  disabled={busy}
                />
              </label>
              {saveStatus === "conflict" && (
                <section
                  role="dialog"
                  aria-label="개인 초안 저장 충돌"
                  aria-modal="false"
                >
                  <h4>양쪽 입력을 보존했습니다 · 서버 r{conflictRevision}</h4>
                  <details>
                    <summary>서버의 현재 입력</summary>
                    <pre>
                      {conflictServer?.content ?? "현재 서버 초안 없음"}
                    </pre>
                  </details>
                  <details>
                    <summary>이 브라우저의 미전송 입력</summary>
                    <pre>{content}</pre>
                  </details>
                  <p>
                    위 편집창에서 병합할 수 있습니다. 선택 후 새 revision CAS로
                    저장하며 다른 탭이 바꾸면 다시 충돌합니다.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      autosave.current?.resolve(conflictRevision, content);
                      void autosave.current?.flush();
                    }}
                  >
                    내 입력·수동 병합본으로 새 저장 시도
                  </Button>
                  <Button
                    disabled={busy || !conflictServer}
                    onClick={() => {
                      if (!conflictServer) return;
                      setContent(conflictServer.content);
                      autosave.current?.resolve(
                        conflictRevision,
                        conflictServer.content,
                      );
                      void autosave.current?.flush();
                    }}
                  >
                    서버 입력을 명시적으로 선택
                  </Button>
                </section>
              )}
              <Button type="submit" disabled={busy}>
                개인 초안 저장
              </Button>
              <label>
                변경 이유
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                  disabled={busy}
                />
              </label>
              <details>
                <summary>발행본과 제안 비교</summary>
                <div className="op-diff">
                  <section>
                    <h4>현재 발행본 v{latest.number}</h4>
                    <pre>{latest.content}</pre>
                  </section>
                  <section>
                    <h4>제안 본문 · 기준 v{draft.baseVersion}</h4>
                    <pre>{content}</pre>
                  </section>
                </div>
              </details>
              {propose && (
                <Button
                  disabled={busy || !reason.trim() || !content.trim()}
                  onClick={() =>
                    action(async () => {
                      if (
                        !window.confirm(
                          "이 본문과 변경 이유로 검토를 요청할까요? 승인 전에는 발행되지 않습니다.",
                        )
                      )
                        return;
                      const saved = await flushDraft();
                      setDraft(saved);
                      await api.post(
                        `/workflows/drafts/${encodeURIComponent(saved.id)}/submit`,
                        { expectedRevision: saved.revision, reason },
                      );
                      setNotice(
                        "변경 검토함에 제안했습니다. 발행본은 그대로입니다.",
                      );
                    })
                  }
                >
                  저장하고 검토 요청
                </Button>
              )}
              <Button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api.post("/workflows/templates", {
                      id: crypto.randomUUID(),
                      expectedRevision: 0,
                      title: draft.title,
                      content,
                      originPageId: selected,
                    });
                    setNotice(
                      "개인 템플릿으로 저장했습니다. 원본 권한을 계속 따릅니다.",
                    );
                  })
                }
              >
                템플릿으로 저장
              </Button>
            </form>
          )}
          <details>
            <summary>버전 기록 · 복원은 새 변경 제안</summary>
            {pageItems([...detail.page.versions].reverse(), historyPage).map(
              (v) => (
                <article key={v.number}>
                  <h4>
                    v{v.number} · {v.at}
                  </h4>
                  <p>{v.reason}</p>
                  <p>
                    생성 경로:{" "}
                    {v.producer?.kind === "model"
                      ? `모델 · ${v.producer.model ?? "실제 모델명 미수집(실행 계측에서 확인)"}`
                      : v.producer?.kind === "structural"
                        ? "구조 처리 · 모델 미사용"
                        : v.producer?.kind === "user-submission"
                          ? "사용자 제출 · 원작성 여부 미확인"
                          : v.producer?.kind === "api-submission"
                            ? "API 제출 · 원작성 여부 미확인"
                            : v.producer?.kind === "import"
                              ? "가져온 자료 · 원작성 여부 미확인"
                              : "기존 기록 · 생성 주체 미구분"}
                  </p>
                  {v.publishedBy ? (
                    <p>
                      제안 주체 {v.proposedBy ?? "미기록"} · 책임 사용자{" "}
                      {v.responsibleUserId ?? "미기록"} · 발행자 {v.publishedBy}
                    </p>
                  ) : (
                    <p>기존 author 기록 {v.author} · 작성/발행 역할 미구분</p>
                  )}
                  <pre>{v.content}</pre>
                  {propose && (
                    <Button
                      disabled={
                        busy || !reason.trim() || v.number === latest.number
                      }
                      onClick={() =>
                        action(async () => {
                          if (
                            !window.confirm(
                              `v${v.number} 본문을 복원하는 변경 제안을 만들까요? 현재 ACL과 기준 v${latest.number}을 검사합니다.`,
                            )
                          )
                            return;
                          await api.post(`${pagePath}/restore`, {
                            version: v.number,
                            baseVersion: latest.number,
                            reason,
                          });
                          setNotice("복원 제안을 검토함에 등록했습니다.");
                        })
                      }
                    >
                      이 버전 복원 제안
                    </Button>
                  )}
                </article>
              ),
            )}
            <Pager
              count={detail.page.versions.length}
              page={historyPage}
              set={setHistoryPage}
            />
          </details>
          <label>
            작업 이유
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              placeholder="복원·보호·수명주기 변경 이유"
              maxLength={2000}
            />
          </label>
          {can("knowledge.protect") && (
            <details>
              <summary>문서 구조·속성·보호</summary>
              <label>
                상위 문서
                <select
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                >
                  <option value="">최상위</option>
                  {pages
                    .filter((p) => p.id !== selected)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                속성 (문자열 값의 JSON 객체)
                <textarea
                  value={properties}
                  onChange={(e) => setProperties(e.target.value)}
                  rows={4}
                />
              </label>
              <Button
                disabled={busy || !reason.trim()}
                onClick={() =>
                  action(async () => {
                    await api.post(`${pagePath}/state`, {
                      expectedRevision: detail.settings.revision,
                      parentId: parent || null,
                      properties: JSON.parse(properties),
                      reason,
                    });
                    await refreshDocument();
                    setNotice("구조와 속성을 저장했습니다.");
                  })
                }
              >
                구조·속성 저장
              </Button>
              <Button
                disabled={busy || !reason.trim()}
                onClick={() =>
                  action(async () => {
                    if (
                      !window.confirm(
                        "문서 보호 상태를 변경할까요? 기존 승인은 다시 검토해야 합니다.",
                      )
                    )
                      return;
                    await api.post(`${pagePath}/state`, {
                      expectedRevision: detail.settings.revision,
                      protected: !detail.settings.data.protected,
                      reason,
                    });
                    await refreshDocument();
                  })
                }
              >
                {detail.settings.data.protected ? "보호 해제" : "문서 보호"}
              </Button>
            </details>
          )}
          {manage && (
            <details>
              <summary>문서 수명주기</summary>
              <div className="op-actions">
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => action(() => state("archived"))}
                >
                  보관
                </Button>
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => action(() => state("active"))}
                >
                  활성화
                </Button>
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => action(() => state("trash"))}
                >
                  휴지통으로 이동
                </Button>
              </div>
            </details>
          )}
          <h3>버전·문단 댓글</h3>
          {can("comment.write") && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await api.post(`${pagePath}/comments`, {
                    content: comment,
                    version: latest.number,
                    anchor,
                    mentions: mentions
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  });
                  setComment("");
                  setAnchor("");
                  setMentions("");
                  await refreshDocument();
                });
              }}
            >
              <label>
                댓글
                <textarea
                  required
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={20000}
                  disabled={busy}
                />
              </label>
              <label>
                문단 앵커 (본문의 정확한 발췌)
                <input
                  value={anchor}
                  onChange={(e) => setAnchor(e.target.value)}
                  maxLength={1000}
                  disabled={busy}
                />
              </label>
              <label>
                멘션할 사용자 ID (쉼표 구분)
                <input
                  value={mentions}
                  onChange={(e) => setMentions(e.target.value)}
                  disabled={busy}
                />
              </label>
              <Button type="submit" disabled={busy}>
                댓글 등록
              </Button>
            </form>
          )}
          {pageItems(comments, commentPage).map((c) => (
            <article key={c.id} id={`comment-${c.id}`}>
              <h4>
                {c.principal_id} · v{c.version} ·{" "}
                {c.resolved ? "해결됨" : "열림"}
              </h4>
              {c.anchor && <blockquote>{c.anchor}</blockquote>}
              <p style={{ whiteSpace: "pre-wrap" }}>{c.content}</p>
              {c.version !== latest.number && (
                <p>
                  이 댓글은 v{c.version}의 문단에 고정되어 있습니다. 현재 본문의
                  다른 문단에 자동 연결하지 않습니다. 버전 기록에서 당시 본문을
                  확인하세요.
                </p>
              )}
              <a
                href={
                  spaceId
                    ? documentHref(spaceId, selected, c.id)
                    : `#comment-${encodeURIComponent(c.id)}`
                }
              >
                댓글 고유 링크
              </a>
              {!c.deleted && c.principal_id === principalId && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      setEditingComment({ id: c.id, content: c.content })
                    }
                  >
                    내 댓글 수정
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        if (
                          !window.confirm(
                            "댓글 본문을 삭제할까요? 댓글 위치와 삭제 표시는 유지됩니다.",
                          )
                        )
                          return;
                        await api.post(
                          `/workflows/comments/${encodeURIComponent(c.id)}/delete`,
                          { expectedRevision: c.revision },
                        );
                        await refreshDocument();
                      })
                    }
                  >
                    내 댓글 삭제
                  </Button>
                  {editingComment?.id === c.id && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void action(async () => {
                          await api.post(
                            `/workflows/comments/${encodeURIComponent(c.id)}/edit`,
                            {
                              expectedRevision: c.revision,
                              content: editingComment.content,
                            },
                          );
                          setEditingComment(null);
                          await refreshDocument();
                        });
                      }}
                    >
                      <label>
                        댓글 수정 본문
                        <textarea
                          value={editingComment.content}
                          onChange={(e) =>
                            setEditingComment({
                              id: c.id,
                              content: e.target.value,
                            })
                          }
                          maxLength={20000}
                          required
                          disabled={busy}
                        />
                      </label>
                      <Button type="submit" disabled={busy}>
                        댓글 수정 저장
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => setEditingComment(null)}
                      >
                        수정 취소
                      </Button>
                    </form>
                  )}
                </>
              )}
              {can("triage.manage") && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await api.post(
                        `/workflows/comments/${encodeURIComponent(c.id)}/resolve`,
                        { resolved: !c.resolved },
                      );
                      await refreshDocument();
                    })
                  }
                >
                  {c.resolved ? "다시 열기" : "해결 표시"}
                </Button>
              )}
            </article>
          ))}
          <Pager
            count={comments.length}
            page={commentPage}
            set={setCommentPage}
          />
        </>
      )}
      {write && (
        <details>
          <summary>저장된 개인 초안 ({drafts.length})</summary>
          {pageItems(drafts, draftPage).map((d) => (
            <article key={d.id}>
              <strong>{d.title}</strong>
              <span>
                {" "}
                · 기준 v{d.baseVersion} · r{d.revision}
              </span>
              <div className="op-actions">
                <Button
                  disabled={busy || !d.pageId}
                  onClick={() => {
                    if (d.pageId !== selected) {
                      setSelected(d.pageId!);
                      setNotice(
                        "선택한 문서가 열리면 이 초안의 이어 쓰기를 다시 선택하세요.",
                      );
                      return;
                    }
                    setDraft(d);
                    setContent(d.content);
                  }}
                >
                  이어 쓰기
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      if (
                        !window.confirm(
                          "이 개인 초안을 삭제할까요? 발행본은 바뀌지 않습니다.",
                        )
                      )
                        return;
                      await api.post(
                        `/workflows/drafts/${encodeURIComponent(d.id)}/delete`,
                        { expectedRevision: d.revision },
                      );
                      if (draft?.id === d.id) {
                        setDraft(null);
                        setContent("");
                      }
                    })
                  }
                >
                  초안 삭제
                </Button>
              </div>
            </article>
          ))}
          <Pager count={drafts.length} page={draftPage} set={setDraftPage} />
        </details>
      )}
      {write && (
        <details>
          <summary>개인 템플릿 ({templates.length})</summary>
          {pageItems(templates, templatePage).map((t) => (
            <article key={t.id}>
              <strong>{t.title}</strong>
              <Button
                disabled={busy || !detail || !latest}
                onClick={() => {
                  if (!detail || !latest) return;
                  setDraft({
                    id: crypto.randomUUID(),
                    revision: 0,
                    title: detail.page.title,
                    content: t.content,
                    pageId: selected,
                    baseVersion: latest.number,
                    ...(t.originPageId && t.originVersion
                      ? {
                          dependencyVersions: {
                            [t.originPageId]: t.originVersion,
                          },
                        }
                      : {}),
                  });
                  setContent(t.content);
                }}
              >
                선택 문서의 초안으로 사용
              </Button>
            </article>
          ))}
          <Pager
            count={templates.length}
            page={templatePage}
            set={setTemplatePage}
          />
        </details>
      )}
      <details>
        <summary>
          내 알림 ({notifications.filter((n) => !n.read_at).length}건 읽지 않음)
        </summary>
        {pageItems(notifications, notificationPage).map((n) => (
          <article key={n.id}>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await api.post(
                    `/workflows/notifications/${encodeURIComponent(n.id)}/read`,
                    {},
                  );
                  setSelected(n.page_id);
                })
              }
            >
              {n.title} · 댓글 {n.read_at ? "읽음" : "새 알림"}
            </Button>
          </article>
        ))}
        <Pager
          count={notifications.length}
          page={notificationPage}
          set={setNotificationPage}
        />
      </details>
      {manage && (
        <details>
          <summary>휴지통 ({trash.length})</summary>
          <p>
            현재 원본·상위 문서 권한을 만족하는 문서만 표시합니다. 복구로 과거
            권한은 복원하지 않습니다.
          </p>
          {pageItems(trash, trashPage).map((t) => (
            <article key={t.id}>
              <strong>{t.title}</strong>
              <Button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    if (
                      !window.confirm(
                        `${t.title} 문서를 현재 권한으로 복구할까요?`,
                      )
                    )
                      return;
                    await api.post(
                      `/workflows/pages/${encodeURIComponent(t.id)}/state`,
                      {
                        expectedRevision: t.revision,
                        state: "active",
                        reason: "사용자 확인 후 휴지통 복구",
                      },
                    );
                    setNotice("문서를 복구했습니다.");
                  })
                }
              >
                문서 복구
              </Button>
            </article>
          ))}
          <Pager count={trash.length} page={trashPage} set={setTrashPage} />
        </details>
      )}
      <NotificationPreferences api={api} perform={action} />
      {can("space.admin") && (
        <RetentionPanel key={`${principalId}:${spaceId}`} api={api} />
      )}
    </section>
  );
}

type RetentionClass =
  "drafts" | "publishedVersions" | "sourceVersions" | "runtimeResults";
interface RetentionPolicy {
  enabled: boolean;
  drafts: number | null;
  publishedVersions: number | null;
  sourceVersions: number | null;
  runtimeResults: number | null;
}
interface RetentionPreview {
  hash: string;
  policyRevision: number;
  counts: { eligible: number; blocked: number; storageReferences: number };
  records: {
    kind: RetentionClass;
    id: string;
    eligible: boolean;
    reasons: string[];
    retainedBy: { table: string; id: string }[];
  }[];
}
const retentionLabels: Record<RetentionClass, string> = {
  drafts: "개인 초안",
  publishedVersions: "발행 버전",
  sourceVersions: "원본 버전",
  runtimeResults: "실행 결과",
};
const retentionReasons: Record<string, string> = {
  POLICY_DISABLED: "자동 삭제 정책 비활성",
  RETAIN_FOREVER: "영구 보존",
  NOT_DUE: "보존 기간 미경과",
  AGE_UNAVAILABLE: "기준 시각 미확인",
  LEGAL_HOLD: "법적 보존",
  RETAINED_REFERENCE: "보존 자료의 참조 근거",
  IMMUTABLE_HISTORY_REQUIRES_REVIEWED_PRUNING:
    "불변 이력: 검토된 의존성 안전 가지치기 미지원 — 삭제하지 않음",
};
function RetentionReferences({
  items,
}: {
  items: { table: string; id: string }[];
}) {
  const [page, setPage] = useState(0);
  return (
    <details>
      <summary>보존을 요구하는 참조 {items.length}건</summary>
      {pageItems(items, page).map((ref, i) => (
        <p key={i} style={{ overflowWrap: "anywhere" }}>
          {ref.table} · {ref.id}
        </p>
      ))}
      <Pager count={items.length} page={page} set={setPage} />
    </details>
  );
}
export function RetentionPanel({ api }: { api: OperationalApi }) {
  const [settings, setSettings] = useState<{
    revision: number;
    policy: RetentionPolicy;
  } | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [receipts, setReceipts] = useState<
    {
      id: string;
      status: string;
      details: { deleted?: number; blocked?: number };
    }[]
  >([]);
  const [receiptPage, setReceiptPage] = useState(0);
  const [holdClass, setHoldClass] = useState<RetentionClass>("drafts"),
    [holdReason, setHoldReason] = useState("");
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "보존 작업을 완료하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !settings && !busy)
          void run(async () => {
            const [policy, history] = await Promise.all([
              api.get<{ revision: number; policy: RetentionPolicy }>(
                "/retention/policy",
              ),
              api.get<{ items: typeof receipts }>("/retention/receipts"),
            ]);
            setSettings(policy);
            setReceipts(history.items);
          });
      }}
    >
      <summary>자료 유형별 보존 정책 · 공간 관리자</summary>
      <p>
        기본은 자동 삭제 없음입니다. 일반 보존은 법정 삭제나 공간 전체 삭제가
        아닙니다. 참조 중인 원본·이력과 법적 보존 자료는 삭제하지 않습니다.
        발행·원본·실행 이력의 기간을 설정해도 현재 안전한 가지치기가 지원되지
        않으면 차단으로 표시합니다.
      </p>
      {message && <p role="status">{message}</p>}
      {settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              !window.confirm(
                "이 유형별 보존 정책을 적용할까요? 활성화하면 연결된 서버 주기 작업이 적격 개인 초안만 정리할 수 있습니다.",
              )
            )
              return;
            void run(async () => {
              setSettings(
                await api.post("/retention/policy", {
                  expectedRevision: settings.revision,
                  policy: settings.policy,
                }),
              );
              setPreview(null);
              setMessage(
                "정책을 저장했습니다. 실제 삭제 결과는 실행 영수증에서 확인하세요.",
              );
            });
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={settings.policy.enabled}
              disabled={busy}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  policy: { ...settings.policy, enabled: e.target.checked },
                })
              }
            />
            명시적 자동 정리 허용
          </label>
          {(Object.keys(retentionLabels) as RetentionClass[]).map((kind) => (
            <label key={kind}>
              {retentionLabels[kind]} 보존 일수 (빈 값은 영구 보존)
              <input
                type="number"
                min={1}
                max={36500}
                disabled={busy}
                value={settings.policy[kind] ?? ""}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    policy: {
                      ...settings.policy,
                      [kind]:
                        e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
          <Button type="submit" disabled={busy}>
            정책 변경 확인
          </Button>
        </form>
      )}
      {settings && (
        <details>
          <summary>유형별 법적 보존 · 별도 확인</summary>
          <label>
            보존 유형
            <select
              value={holdClass}
              disabled={busy}
              onChange={(e) => setHoldClass(e.target.value as RetentionClass)}
            >
              {(Object.keys(retentionLabels) as RetentionClass[]).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {retentionLabels[kind]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            설정·해제 근거
            <input
              value={holdReason}
              disabled={busy}
              maxLength={2000}
              onChange={(e) => setHoldReason(e.target.value)}
            />
          </label>
          {[true, false].map((enabled) => (
            <Button
              key={String(enabled)}
              disabled={busy || !holdReason.trim()}
              onClick={() => {
                if (
                  !window.confirm(
                    `${retentionLabels[holdClass]}의 유형별 법적 보존을 ${enabled ? "설정" : "해제"}할까요? 원본·문서별 기존 법적 보존은 변경하지 않습니다.`,
                  )
                )
                  return;
                void run(async () => {
                  await api.post("/retention/holds", {
                    contentClass: holdClass,
                    enabled,
                    reason: holdReason,
                    expectedPolicyRevision: settings.revision,
                  });
                  setPreview(null);
                  setMessage(
                    enabled
                      ? "유형별 보존을 설정했습니다."
                      : "유형별 보존을 해제했습니다. 다른 법적 보존은 유지됩니다.",
                  );
                });
              }}
            >
              {enabled ? "유형별 보존 설정" : "유형별 보존 해제 확인"}
            </Button>
          ))}
        </details>
      )}
      <Button
        disabled={busy || !settings}
        onClick={() =>
          run(async () => {
            setPreview(await api.post("/retention/preview", {}));
            setPage(0);
          })
        }
      >
        실제 대상·보존 의존성 미리보기
      </Button>
      {preview && (
        <section>
          <h3>
            삭제 가능 {preview.counts.eligible}건 · 보존/차단{" "}
            {preview.counts.blocked}건
          </h3>
          <p>
            첨부·가져오기 저장 참조 {preview.counts.storageReferences}건을 함께
            검사했습니다.
          </p>
          {pageItems(preview.records, page).map((r, i) => (
            <article key={`${r.kind}:${r.id}:${i}`}>
              <strong style={{ overflowWrap: "anywhere" }}>
                {retentionLabels[r.kind]} · {r.id}
              </strong>
              <p>
                {r.eligible
                  ? "정리 가능"
                  : r.reasons
                      .map((reason) => retentionReasons[reason] ?? reason)
                      .join(" · ")}
              </p>
              <RetentionReferences items={r.retainedBy} />
            </article>
          ))}
          <Pager count={preview.records.length} page={page} set={setPage} />
          <Button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `정리 가능한 초안 ${preview.counts.eligible}건을 실제 정리할까요? 현재 정책·참조·법적 보존을 다시 검사합니다.`,
                )
              )
                return;
              void run(async () => {
                const receipt = await api.post<{
                  status: string;
                  deleted: number;
                  blocked: number;
                }>("/retention/execute", {
                  previewHash: preview.hash,
                  policyRevision: preview.policyRevision,
                });
                setMessage(
                  `${receipt.status === "completed" ? "정리 실행 완료" : "삭제 차단"} · 실제 삭제 ${receipt.deleted}건 · 보존 ${receipt.blocked}건`,
                );
                setPreview(null);
                setReceipts(
                  (
                    await api.get<{ items: typeof receipts }>(
                      "/retention/receipts",
                    )
                  ).items,
                );
              });
            }}
          >
            고정 미리보기로 실행
          </Button>
        </section>
      )}
      <details>
        <summary>실제 보존 실행 영수증 {receipts.length}건</summary>
        {pageItems(receipts, receiptPage).map((r) => (
          <p key={r.id}>
            {r.status === "completed"
              ? "완료"
              : r.status === "blocked"
                ? "차단"
                : "실패"}{" "}
            · 삭제 {r.details.deleted ?? "미확인"} · 보존{" "}
            {r.details.blocked ?? "미확인"} · {r.id}
          </p>
        ))}
        <Pager
          count={receipts.length}
          page={receiptPage}
          set={setReceiptPage}
        />
      </details>
    </details>
  );
}

interface Preferences {
  revision: number;
  mentions: boolean;
  subscriptions: boolean;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  timezone: string;
}
function NotificationPreferences({
  api,
  perform,
}: {
  api: OperationalApi;
  perform: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [prefs, setPrefs] = useState<Preferences | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .get<Preferences>("/workflows/preferences")
      .then((p) => {
        if (active) setPrefs(p);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "알림 설정을 불러오지 못했습니다.",
          );
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <details>
      <summary>내 알림 수신 설정</summary>
      {error && <p role="alert">{error}</p>}
      {prefs && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            void perform(async () => {
              const { revision, ...data } = prefs;
              setPrefs(
                await api.post<Preferences>("/workflows/preferences", {
                  ...data,
                  expectedRevision: revision,
                }),
              );
            }).finally(() => setBusy(false));
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={prefs.mentions}
              onChange={(e) =>
                setPrefs({ ...prefs, mentions: e.target.checked })
              }
              disabled={busy}
            />
            멘션 알림 받기
          </label>
          <label>
            <input
              type="checkbox"
              checked={prefs.subscriptions}
              onChange={(e) =>
                setPrefs({ ...prefs, subscriptions: e.target.checked })
              }
              disabled={busy}
            />
            구독 문서 댓글 알림 받기
          </label>
          <label>
            알림 시각대
            <input
              value={prefs.timezone}
              onChange={(e) => setPrefs({ ...prefs, timezone: e.target.value })}
              disabled={busy}
            />
          </label>
          <Button type="submit" disabled={busy}>
            알림 설정 저장
          </Button>
        </form>
      )}
    </details>
  );
}
