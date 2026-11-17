import {LinkAutocomplete} from "./LinkAutocomplete";
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Button } from "../../ui/primitives";
import type { ImagePreview } from "../../ui/Markdown";
import { ApiError } from "../api";
import { WorkflowPanel } from "../workflows";
import { DocumentBody } from "../document-navigation";
import {
  DraftAutosave,
  RecoveryCache,
  draftRequest,
  saveStatusLabel,
  type Draft,
  type RecoveryBinding,
  type RecoveryValidation,
  type SaveStatus,
} from "../draft-recovery";
import { NavigationProtection } from "./Navigation";
import { convenienceHref } from "./route";
import { usePersonalKey } from "./personal-client";
type Props = ComponentProps<typeof WorkflowPanel> & {
  mode: "new" | "edit";
  initialDraftId?: string;
  onDraftBound?: (id: string) => void;
  members?: { principalId: string }[];
};
type Template = {
  id: string;
  revision: number;
  title: string;
  content: string;
  originPageId?: string;
  originVersion?: number;
};
type Disclosure = {
  id: string;
  draftId: string;
  draftRevision: number;
  title: string;
  content: string;
  ownerId: string;
  reviewerId: string;
  policyMode: string;
  status: string;
  hash: string;
  audience: string[];
  requestReason?: string;
  decision?: {
    decision: "approve" | "reject";
    reason: string;
    principalId: string;
  };
  parentId: string | null;
  submission?: { batchId: string; hash: string };
};
const templates: Record<string, string> = {
  회의: "## 회의 정보\n\n## 논의\n\n## 결정\n\n## 후속 작업\n",
  조사: "## 질문\n\n## 근거\n\n## 결과\n\n## 한계\n",
  설계: "## 문제\n\n## 요구사항\n\n## 설계\n\n## 대안과 검증\n",
  "장애 분석":
    "## 영향\n\n## 시간순 기록\n\n## 원인과 근거\n\n## 조치 및 검증\n",
  가이드: "## 적용 대상\n\n## 준비\n\n## 절차\n\n## 확인과 예외\n",
};
/** Existing edits retain the established editor; new documents share its CAS coordinator,
 * recovery cache, template service and canonical body renderer. */
export function DocumentComposer(props: Props) {
  const key = usePersonalKey(
    props.api,
    `${props.spaceId}:${props.principalId}:${props.mode}:${props.capabilities.join(",")}`,
  );
  const route = useRef({
    requested: props.initialDraftId,
    active: props.initialDraftId,
    revision: 0,
    exact: !!props.initialDraftId,
  });
  if (route.current.requested !== props.initialDraftId) {
    if (route.current.active !== props.initialDraftId) {
      route.current.revision++;
      route.current.exact = !!props.initialDraftId;
    }
    route.current.requested = props.initialDraftId;
  }
  return props.mode === "edit" ? (
    <WorkflowPanel {...props} />
  ) : (
    <DraftDestination
      key={`${key}:${route.current.revision}`}
      exact={route.current.exact}
      {...props}
      onDraftBound={(id) => {
        route.current.active = id;
        props.onDraftBound?.(id);
      }}
    />
  );
}
/** Resolve the exact own ID before choosing the existing page editor or new-document composer. */
function DraftDestination({ exact, ...props }: Props & { exact: boolean }) {
  const [resolved, setResolved] = useState<
    { draft: Draft } | { error: string } | null
  >(null);
  useEffect(() => {
    if (!exact) return;
    let live = true;
    void props.api
      .get<{ items: Draft[] }>("/workflows/drafts")
      .then((result) => {
        if (!live) return;
        const draft = result.items.find((x) => x.id === props.initialDraftId);
        if (!draft)
          throw new ApiError(
            "요청한 초안이 없거나 현재 접근할 수 없습니다.",
            404,
            "NOT_FOUND",
          );
        setResolved({ draft });
      })
      .catch((e) => {
        if (live) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            try {
              new RecoveryCache(window.localStorage).clear(
                props.principalId!,
                props.spaceId!,
                "draft:" + props.initialDraftId,
              );
            } catch {
              /* Optional storage cleanup. */
            }
          }
          setResolved({
            error:
              e instanceof Error ? e.message : "초안을 불러오지 못했습니다.",
          });
          if (e instanceof ApiError && [401, 403].includes(e.status))
            props.onExpired();
        }
      });
    return () => {
      live = false;
    };
  }, [exact, props.api, props.initialDraftId]);
  if (!exact) return <NewDocument {...props} />;
  if (!resolved) return <p role="status">요청한 개인 초안을 확인하는 중…</p>;
  if ("error" in resolved) return <p role="alert">{resolved.error}</p>;
  if (resolved.draft.pageId)
    return (
      <WorkflowPanel
        {...props}
        initialPageId={resolved.draft.pageId}
        initialDraftId={resolved.draft.id}
      />
    );
  return <NewDocument {...props} resolvedDraft={resolved.draft} />;
}
function NewDocument({
  api,
  principalId,
  spaceId,
  initialDraftId,
  capabilities,
  pages,
  members = [],
  onChanged,
  onExpired,
  onDraftBound,
  resolvedDraft,
}: Props & { resolvedDraft?: Draft }) {
  const [draft, setDraft] = useState<Draft | null>(null),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [parent, setParent] = useState(""),
    [reason, setReason] = useState(""),
    [disclosureEdited, setDisclosureEdited] = useState(false),
    [decisionReasons, setDecisionReasons] = useState<Record<string, string>>(
      {},
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState<SaveStatus>("saved"),
    [preview, setPreview] = useState(false),
    [personal, setPersonal] = useState<boolean | null>(null),
    [reviewers, setReviewers] = useState<string[]>([]),
    [reviewer, setReviewer] = useState(""),
    [additionalReaders, setAdditionalReaders] = useState(""),
    [audience, setAudience] = useState<string[]>(
      principalId ? [principalId] : [],
    ),
    [disclosures, setDisclosures] = useState<Disclosure[]>([]),
    [ownerDisclosures, setOwnerDisclosures] = useState<Disclosure[]>([]),
    [queueNext, setQueueNext] = useState<string | null>(null),
    [queuePartial, setQueuePartial] = useState(false),
    [ownerNext, setOwnerNext] = useState<string | null>(null),
    [savedTemplates, setTemplates] = useState<Template[]>([]),
    [server, setServer] = useState<Draft | null>(null),
    [recovered, setRecovered] = useState<
      import("../draft-recovery").RecoveredDraft | null
    >(null),
    [copyNotice, setCopyNotice] = useState(
      "복구 권한을 확인하기 전에는 브라우저에 본문을 보관하지 않습니다.",
    );
  const coordinator = useRef<DraftAutosave | null>(null),
    cache = useRef<RecoveryCache | null>(null),
    binding = useRef<RecoveryBinding | null>(null),
    generation = useRef(0),
    selectionRevision = useRef(0),
    queueGeneration = useRef(0),
    queueSection = useRef<HTMLElement | null>(null),
    queueFocus = useRef(false),
    queueIntent = useRef(false),
    composing = useRef(false);
  const write = capabilities.includes("draft.write"),
    propose = capabilities.includes("changeset.propose"),
    target = () => "draft:" + coordinator.current?.draft.id;
  const readAttachment = (id: string) =>
    api.get<ImagePreview>(`/storage/blobs/${encodeURIComponent(id)}/preview`);
  const fail = (e: unknown) => {
    setError(
      e instanceof ApiError
        ? `${e.message} (${e.code})`
        : e instanceof Error
          ? e.message
          : "요청 실패",
    );
    if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
      coordinator.current?.dispose();
      cache.current?.clearAll();
      binding.current = null;
      setDraft(null);
      setContent("");
      setTitle("");
      setDisclosures([]);
      setOwnerDisclosures([]);
      setQueueNext(null);
      setOwnerNext(null);
      if (e.status === 401) onExpired();
    }
  };
  type DisclosurePage = {
    items: Disclosure[];
    nextCursor?: string | null;
    partial?: boolean;
  };
  const ownerPath = (draftId: string, cursor?: string | null) =>
    `/workflows/draft-disclosures?draftId=${encodeURIComponent(draftId)}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
  const queuePath = (cursor?: string | null) =>
    `/workflows/draft-disclosures?queue=assigned-pending${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
  const initializeAudience = (resumed: Disclosure) => {
    setAudience(resumed.audience);
    setAdditionalReaders(
      resumed.audience
        .filter(
          (id) =>
            id !== principalId &&
            id !== resumed.reviewerId &&
            !members.some((m) => m.principalId === id),
        )
        .join(", "),
    );
    setReviewer(
      resumed.policyMode === "personal-owner" ? "" : resumed.reviewerId,
    );
    setReason(resumed.requestReason ?? "");
  };
  const refreshOwner = async (cursor?: string | null, initialize = false) => {
    const epoch = generation.current,
      id = coordinator.current?.draft.id;
    if (!id) return;
    const result = await api.get<DisclosurePage>(ownerPath(id, cursor));
    if (epoch !== generation.current) return;
    setOwnerDisclosures(result.items);
    setOwnerNext(result.nextCursor ?? null);
    if (initialize && !selectionRevision.current && result.items[0])
      initializeAudience(result.items[0]);
  };
  const refreshQueue = async (cursor?: string | null, focus = false) => {
    const epoch = generation.current,
      request = ++queueGeneration.current,
      origin = document.activeElement;
    // Disabled native controls can blur to body without a new user intent.
    queueIntent.current =
      focus && queueSection.current?.contains(origin) === true;
    try {
      const result = await api.get<DisclosurePage>(queuePath(cursor));
      if (epoch !== generation.current || request !== queueGeneration.current)
        return;
      queueFocus.current = queueIntent.current;
      setDisclosures(result.items);
      setQueueNext(result.nextCursor ?? null);
      setQueuePartial(result.partial ?? false);
    } catch (e) {
      if (epoch === generation.current && request === queueGeneration.current) {
        queueFocus.current = queueIntent.current;
        setDisclosures([]);
        setQueueNext(null);
        setQueuePartial(false);
        throw e;
      }
    }
  };
  useEffect(() => {
    const leave = (event: Event) => {
      if (
        event.target instanceof Node &&
        !queueSection.current?.contains(event.target)
      )
        queueIntent.current = false;
    };
    const blur = () => {
      queueIntent.current = false;
    };
    document.addEventListener("focusin", leave);
    document.addEventListener("pointerdown", leave, true);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", blur);
    return () => {
      queueIntent.current = false;
      queueFocus.current = false;
      document.removeEventListener("focusin", leave);
      document.removeEventListener("pointerdown", leave, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", blur);
    };
  }, []);
  useLayoutEffect(() => {
    if (queueFocus.current) {
      queueFocus.current = false;
      queueSection.current?.focus({ preventScroll: true });
    }
  }, [disclosures]);
  const refresh = async () => {
    await Promise.all([refreshOwner(), refreshQueue()]);
  };
  const permission = async (instance: DraftAutosave, epoch: number) => {
    if (!instance.draft.revision) return;
    try {
      const d = instance.draft;
      const next = await draftRequest<RecoveryBinding>(
        api,
        "/workflows/recovery/permission",
        {
          kind: "draft",
          id: d.id,
          draftId: d.id,
          expectedRevision: d.revision,
          sourceIds: d.sourceIds ?? [],
          dependencyVersions: d.dependencyVersions ?? {},
        },
        instance.abort.signal,
      );
      if (epoch !== generation.current) return;
      if (next.principalId !== principalId || next.workspaceId !== spaceId)
        throw new ApiError("계정 또는 공간이 변경되었습니다.", 403);
      binding.current = next;
      setCopyNotice(
        "허용된 입력만 최대 5분간 임시 보관합니다. 복구 시 온라인 권한을 다시 확인합니다.",
      );
      if (instance.status !== "saved")
        cache.current?.write(
          next,
          instance.draft,
          instance.content,
          instance.pending,
        );
    } catch (e) {
      if (epoch !== generation.current) return;
      binding.current = null;
      if (e instanceof ApiError)
        cache.current?.clear(
          principalId!,
          spaceId!,
          "draft:" + instance.draft.id,
        );
      setCopyNotice(
        "브라우저 복구가 허용되지 않거나 확인할 수 없습니다. 서버 저장 전 입력은 재시작 시 유실될 수 있습니다.",
      );
      if (e instanceof ApiError && [401, 404].includes(e.status)) fail(e);
    }
  };
  const start = (
    d: Draft,
    unsent?: string,
    pending?: import("../draft-recovery").SaveInput,
  ) => {
    coordinator.current?.dispose();
    binding.current = null;
    const epoch = generation.current;
    let instance: DraftAutosave;
    instance = new DraftAutosave(
      d,
      async (input, signal) => {
        if (!input.title.trim() || !input.content.trim())
          throw Error("제목과 본문을 입력하세요.");
        const saved = await draftRequest<Draft>(
          api,
          "/workflows/drafts",
          input,
          signal,
        );
        return saved;
      },
      (state) => {
        if (epoch !== generation.current) return;
        setDraft({ ...state.draft });
        setStatus(state.status);
        if (state.status === "saved") {
          cache.current?.clear(principalId!, spaceId!, target());
          if (!initialDraftId)
            window.history.replaceState(
              null,
              "",
              convenienceHref({
                kind: "section",
                section: "compose",
                spaceId: spaceId!,
                draft: state.draft.id,
              }),
            );
          onDraftBound?.(state.draft.id);
          void permission(state, epoch);
        } else
          cache.current?.write(
            binding.current,
            state.draft,
            state.content,
            state.pending,
          );
        if (state.status === "conflict")
          void api
            .get<{ items: Draft[] }>("/workflows/drafts")
            .then((r) => {
              if (epoch === generation.current)
                setServer(r.items.find((x) => x.id === d.id) ?? null);
            })
            .catch((e) => {
              if (epoch === generation.current) fail(e);
            });
      },
      pending,
    );
    coordinator.current = instance;
    setDraft(d);
    setTitle(d.title);
    setParent(d.parentId ?? "");
    setContent(unsent ?? d.content);
    setStatus(instance.status);
    instance.content = unsent ?? d.content;
    if (unsent !== undefined && unsent !== d.content) instance.edit(unsent);
    void permission(instance, epoch);
    return instance;
  };
  useEffect(() => {
    const epoch = ++generation.current;
    let active = true,
      initialized = false;
    try {
      cache.current = new RecoveryCache(window.localStorage);
    } catch {
      /* Browser storage is optional. */
    }
    const init = async () => {
      try {
        const [saved, ts, config, requests, owned] = await Promise.all([
          resolvedDraft
            ? Promise.resolve({ items: [resolvedDraft] })
            : api.get<{ items: Draft[] }>("/workflows/drafts"),
          api.get<{ items: Template[] }>("/workflows/templates"),
          api.get<{ personal: boolean; reviewers: string[] }>(
            "/imports/config",
          ),
          api.get<DisclosurePage>(queuePath()),
          initialDraftId
            ? api.get<DisclosurePage>(ownerPath(initialDraftId))
            : Promise.resolve({ items: [] } as DisclosurePage),
        ]);
        if (!active) return;
        setTemplates(ts.items);
        setPersonal(config.personal);
        setReviewers(config.reviewers.filter((x) => x !== principalId));
        setDisclosures(requests.items);
        setQueueNext(requests.nextCursor ?? null);
        setQueuePartial(requests.partial ?? false);
        setOwnerDisclosures(owned.items);
        setOwnerNext(owned.nextCursor ?? null);
        const d = initialDraftId
          ? saved.items.find((x) => x.id === initialDraftId && !x.pageId)
          : { id: crypto.randomUUID(), revision: 0, title: "", content: "" };
        if (!d)
          throw new ApiError(
            "요청한 초안이 없거나 현재 접근할 수 없습니다.",
            404,
            "NOT_FOUND",
          );
        const resumed = owned.items.find(
          (x) =>
            x.draftId === d.id &&
            x.ownerId === principalId &&
            x.draftRevision === d.revision &&
            x.title === d.title &&
            x.content === d.content &&
            x.parentId === (d.parentId ?? null),
        );
        if (resumed) initializeAudience(resumed);
        initialized = true;
        start(d);
        if (initialDraftId && cache.current) {
          const value = await cache.current.recover(
            principalId!,
            spaceId!,
            "draft:" + initialDraftId,
            async (b) => {
              const who = await draftRequest<{
                principalId: string;
                workspaceId: string;
              }>(api, "/me");
              if (
                who.principalId !== principalId ||
                who.workspaceId !== spaceId
              )
                throw new ApiError("계정 또는 공간이 변경되었습니다.", 403);
              return draftRequest<RecoveryValidation>(
                api,
                "/workflows/recovery/validate",
                { binding: b },
              );
            },
          );
          if (active) setRecovered(value);
        }
      } catch (e) {
        if (active) fail(e);
      }
    };
    void init();
    const online = () => {
      const a = coordinator.current;
      if (a) void permission(a, epoch).then(() => a.flush());
    };
    const flush = () => {
      void coordinator.current?.flush();
    };
    const renewal = setInterval(() => {
      if (navigator.onLine && coordinator.current)
        void permission(coordinator.current, epoch);
    }, 60000);
    window.addEventListener("online", online);
    window.addEventListener("pagehide", flush);
    return () => {
      active = false;
      generation.current++;
      coordinator.current?.dispose();
      if (initialized) cache.current?.clearAll();
      clearInterval(renewal);
      window.removeEventListener("online", online);
      window.removeEventListener("pagehide", flush);
    };
    // Identity/API/exact draft changes remount this session; closures belong to this session only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      await work();
    } catch (e) {
      if (epoch === generation.current) fail(e);
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  const flush = async () => {
    const saved = await coordinator.current?.flush();
    if (!saved) throw Error("초안 저장을 먼저 확인하세요.");
    return saved;
  };
  const current = ownerDisclosures.find(
    (d) =>
      d.draftId === draft?.id &&
      d.ownerId === principalId &&
      d.draftRevision === draft.revision &&
      d.title === title &&
      d.content === content &&
      d.parentId === (parent || null),
  );
  const selectionChanged = () => {
    selectionRevision.current++;
    setDisclosureEdited(true);
  };
  const approvalMatchesSelection =
    !!current &&
    !disclosureEdited &&
    [...new Set(audience)].sort().join("\0") ===
      [...current.audience].sort().join("\0") &&
    (current.policyMode === "personal-owner"
      ? !reviewer
      : current.reviewerId === reviewer);
  const selectTemplate = (value: string) => {
    const instance = coordinator.current;
    if (!value || !instance) return;
    const template = savedTemplates.find((x) => "saved:" + x.id === value);
    if (!template) {
      const next = templates[value];
      if (next !== undefined) {
        setContent(next);
        instance.edit(next);
      }
      return;
    }
    // Copy only after the server has bound the complete template lineage. Until
    // then an existing local-copy grant still describes the previous body.
    void action(async () => {
      const epoch = generation.current;
      if (instance.status !== "saved") await flush();
      const d = instance.draft;
      const saved = await draftRequest<Draft>(
        api,
        "/workflows/drafts",
        {
          id: d.id,
          expectedRevision: d.revision,
          mutationId: crypto.randomUUID(),
          title: title.trim() || template.title,
          content: template.content,
          parentId: parent || null,
          sourceIds: d.sourceIds ?? [],
          dependencyVersions: d.dependencyVersions ?? {},
          templateId: template.id,
          templateRevision: template.revision,
        },
        instance.abort.signal,
      );
      if (epoch !== generation.current) return;
      cache.current?.clear(principalId!, spaceId!, "draft:" + d.id);
      const next = start(saved);
      await next.flush();
    });
  };
  return (
    <section className="op-panel document-composer" aria-label="새 문서 작성기">
      <NavigationProtection
        dirty={!!draft && (status !== "saved" || content !== draft.content)}
      />
      <h2>새 문서</h2>
      <p>개인 초안 저장 → 원본 공개 확인 → 지식 검토 → 발행</p>
      {error && <p role="alert">{error}</p>}
      {recovered && (
        <section aria-label="미전송 입력 복구">
          <p>온라인 권한을 확인한 이전 입력이 있습니다.</p>
          <Button
            onClick={() => {
              const a = start(
                recovered.draft,
                recovered.content,
                recovered.pending,
              );
              if (recovered.validation.status === "conflict") {
                a.conflict(recovered.validation.serverDraft);
                setServer(recovered.validation.serverDraft);
              }
              setRecovered(null);
            }}
          >
            이전 입력 복구
          </Button>
          <Button
            onClick={() => {
              cache.current?.clear(
                principalId!,
                spaceId!,
                "draft:" + draft!.id,
              );
              setRecovered(null);
            }}
          >
            서버 초안 유지
          </Button>
        </section>
      )}
      {draft && (
        <>
          <label>
            문서 제목
            <input
              aria-label="문서 제목"
              maxLength={300}
              value={title}
              disabled={!write || busy || !!current?.submission}
              onChange={(e) => {
                setTitle(e.target.value);
                coordinator.current?.editTitle(e.target.value);
              }}
            />
          </label>
          <label>
            대상 위치
            <select
              aria-label="대상 위치"
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                coordinator.current?.editParent(e.target.value || null);
              }}
              disabled={!write || busy || !!current?.submission}
            >
              <option value="">공간 최상위</option>
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            템플릿
            <select
              aria-label="템플릿"
              defaultValue=""
              onChange={(e) => selectTemplate(e.target.value)}
              disabled={!write || busy || !!current?.submission}
            >
              <option value="">선택 안 함</option>
              {Object.keys(templates).map((t) => (
                <option key={t}>{t}</option>
              ))}
              {savedTemplates.map((t) => (
                <option key={t.id} value={"saved:" + t.id}>
                  {t.title} · 개인 템플릿
                </option>
              ))}
            </select>
          </label>
          <div className="op-actions">
            <Button onClick={() => setPreview(!preview)}>
              {preview ? "본문 편집" : "미리보기"}
            </Button>
            <Button
              disabled={
                !write ||
                busy ||
                !title.trim() ||
                !content.trim() ||
                !!current?.submission
              }
              onClick={() =>
                void action(async () => {
                  await flush();
                })
              }
            >
              개인 초안 저장
            </Button>
            <Button
              disabled={!write || busy || !content.trim()}
              onClick={() =>
                void action(async () => {
                  const d = await flush();
                  await api.post("/workflows/templates", {
                    id: crypto.randomUUID(),
                    expectedRevision: 0,
                    title: d.title,
                    content: d.content,
                    retainLineage: true,
                    sourceDraftId: d.id,
                    sourceDraftRevision: d.revision,
                  });
                  setTemplates(
                    (
                      await api.get<{ items: Template[] }>(
                        "/workflows/templates",
                      )
                    ).items,
                  );
                })
              }
            >
              개인 템플릿 저장
            </Button>
          </div>
          {preview ? (
            <DocumentBody content={content} readAttachment={readAttachment} />
          ) : (
            <LinkAutocomplete api={api} spaceId={spaceId!} onError={fail} onReference={target=>{
                  const editor=coordinator.current;if(!editor)return;
                  const retained=editor.draft.dependencyVersions;
                  if(retained&&Object.hasOwn(retained,target.id)&&retained[target.id]!==target.version)throw Error("이 초안의 링크 기준 버전이 변경되었습니다. 새 초안에서 검토하세요.");
                  editor.draft={...editor.draft,dependencyVersions:{...retained,[target.id]:target.version}};
                }}
              aria-label="Markdown 본문"
              rows={16}
              value={content}
              disabled={!write || busy || !!current?.submission}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                coordinator.current?.edit(e.currentTarget.value);
              }}
              onChange={(e) => {
                setContent(e.target.value);
                if (!composing.current)
                  coordinator.current?.edit(e.target.value);
              }}
              onBlur={() => {
                if (!composing.current) void coordinator.current?.flush();
              }}
            />
          )}
          <p role="status">
            {draft.revision ? `개인 초안 r${draft.revision} · ` : ""}
            {saveStatusLabel[status]}
          </p>
          <p>{copyNotice}</p>
          {status === "conflict" && (
            <section aria-label="초안 충돌">
              <h3>양쪽 본문 확인</h3>
              <label>
                서버 본문
                <textarea
                  aria-label="서버 본문"
                  readOnly
                  value={server?.content ?? "서버 초안을 확인할 수 없습니다."}
                />
              </label>
              <label>
                내 미전송 본문
                <textarea
                  aria-label="내 미전송 본문"
                  readOnly
                  value={content}
                />
              </label>
              <Button
                disabled={!server}
                onClick={() => {
                  coordinator.current?.resolve(server!.revision, content);
                  setServer(null);
                }}
              >
                내 입력으로 새 저장 요청
              </Button>
              <Button
                disabled={!server}
                onClick={() => {
                  setContent(server!.content);
                  setTitle(server!.title);
                  coordinator.current?.editTitle(server!.title);
                  coordinator.current?.resolve(
                    server!.revision,
                    server!.content,
                  );
                  setServer(null);
                }}
              >
                서버 본문 선택
              </Button>
            </section>
          )}
          <section aria-label="원본 공개">
            <h3>원본 공개</h3>
            <p>
              현재 저장은 본인만 열람합니다. 공개 요청 시 선택한 고정 본문만
              지정 검토자에게 보입니다.
            </p>
            <p>
              선택한 대상 독자:{" "}
              {personal ? principalId : audience.join(", ") || "선택 안 함"}
            </p>
            {!personal && (
              <>
                <fieldset>
                  <legend>대상 독자</legend>
                  {members.map((m) => (
                    <label key={m.principalId}>
                      <input
                        type="checkbox"
                        checked={audience.includes(m.principalId)}
                        disabled={
                          busy ||
                          !!current?.submission ||
                          m.principalId === principalId
                        }
                        onChange={(e) => {
                          selectionChanged();
                          setAudience((a) =>
                            e.target.checked
                              ? [...new Set([...a, m.principalId])]
                              : a.filter((x) => x !== m.principalId),
                          );
                        }}
                      />
                      {m.principalId}
                    </label>
                  ))}
                </fieldset>
                <label>
                  추가 대상 독자 ID
                  <input
                    aria-label="추가 대상 독자 ID"
                    placeholder="ID를 쉼표로 구분"
                    disabled={busy || !!current?.submission}
                    value={additionalReaders}
                    onChange={(e) => {
                      selectionChanged();
                      setAdditionalReaders(e.target.value);
                      setAudience([
                        ...new Set([
                          ...audience.filter(
                            (id) =>
                              id === principalId ||
                              id === reviewer ||
                              members.some((m) => m.principalId === id),
                          ),
                          ...e.target.value
                            .split(",")
                            .map((id) => id.trim())
                            .filter(Boolean),
                        ]),
                      ]);
                    }}
                  />
                </label>
                <label>
                  독립 공개 검토자
                  <select
                    aria-label="독립 공개 검토자"
                    value={reviewer}
                    disabled={busy || !!current?.submission}
                    onChange={(e) => {
                      selectionChanged();
                      setReviewer(e.target.value);
                      if (e.target.value)
                        setAudience((a) => [
                          ...new Set([...a, e.target.value]),
                        ]);
                    }}
                  >
                    <option value="">선택하세요</option>
                    {reviewers.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              요청 사유
              <input
                aria-label="요청 사유"
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <Button
              disabled={
                busy ||
                !propose ||
                personal === null ||
                !reason.trim() ||
                !content.trim() ||
                !title.trim() ||
                (!personal && !reviewer) ||
                !!current?.submission
              }
              onClick={() =>
                void action(async () => {
                  const d = await flush();
                  const requestedSelection = selectionRevision.current;
                  await api.post(`/workflows/drafts/${d.id}/disclosure`, {
                    expectedRevision: d.revision,
                    title: d.title,
                    parentId: parent || null,
                    readers: personal ? [principalId] : audience,
                    ...(!personal ? { reviewerId: reviewer } : {}),
                    reason,
                    mutationId: crypto.randomUUID(),
                  });
                  await refresh();
                  if (requestedSelection === selectionRevision.current)
                    setDisclosureEdited(false);
                })
              }
            >
              {personal
                ? "본인 전용 원본 확인 요청"
                : "고정 본문과 독자로 공개 검토 요청"}
            </Button>
            <Button disabled={busy} onClick={() => void action(refresh)}>
              검토 상태 새로고침
            </Button>
            {ownerNext && (
              <>
                <p role="status">이전 공개 요청 탐색이 끝나지 않았습니다.</p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void action(() => refreshOwner(ownerNext, true))
                  }
                >
                  이전 공개 요청 확인
                </Button>
              </>
            )}
            {current && (
              <div aria-label="고정 공개 대상">
                <p>요청에 고정된 독자: {current.audience.join(", ")}</p>
                <p>
                  {current.policyMode === "personal-owner"
                    ? "확인자"
                    : "지정 검토자"}
                  : {current.reviewerId}
                </p>
                <p>
                  기록된 요청 사유:{" "}
                  {current.requestReason ?? "이전 요청에 사유 기록 없음"}
                </p>
                {current.decision && (
                  <p>
                    검토 사유 ({current.decision.principalId}):{" "}
                    {current.decision.reason}
                  </p>
                )}
                {!approvalMatchesSelection && !current.submission && (
                  <p>
                    독자 또는 검토자 선택이 변경됐습니다. 새 공개 검토를
                    요청하세요.
                  </p>
                )}
              </div>
            )}
            {current && (
              <p role="status">
                {
                  (
                    {
                      pending: "원본 공개 검토 대기",
                      "pending-confirmation": "본인 전용 원본 확인 대기",
                      approved: "원본 공개 승인됨",
                      rejected: "원본 공개 반려",
                    } as Record<string, string>
                  )[current.status]
                }
              </p>
            )}
            {current?.status === "approved" &&
              approvalMatchesSelection &&
              !current.submission && (
                <Button
                  disabled={busy || !propose || !reason.trim()}
                  onClick={() =>
                    void action(async () => {
                      const d = await flush();
                      await api.post(`/workflows/drafts/${d.id}/submit-new`, {
                        expectedRevision: d.revision,
                        title: d.title,
                        parentId: parent || null,
                        reason,
                        disclosureId: current.id,
                        disclosureHash: current.hash,
                        mutationId: crypto.randomUUID(),
                      });
                      await refresh();
                      await onChanged();
                    })
                  }
                >
                  지식 검토 요청
                </Button>
              )}
            {current?.submission && (
              <p>
                지식 검토 요청됨 · 발행 상태는{" "}
                <a
                  href={convenienceHref({
                    kind: "section",
                    section: "tasks",
                    spaceId: spaceId!,
                    targetKind: "review",
                    targetId: current.submission.batchId,
                  })}
                >
                  변경 검토에서 확인
                </a>
              </p>
            )}
          </section>
        </>
      )}
      <section aria-label="원본 공개 검토함" ref={queueSection} tabIndex={-1}>
        <h3>원본 공개 검토함</h3>
        <Button
          disabled={busy}
          onClick={() => void action(() => refreshQueue(null, true))}
        >
          검토함 새로고침
        </Button>
        <Button
          disabled={busy}
          onClick={() => void action(() => refreshQueue(null, true))}
        >
          검토함 처음
        </Button>
        {queuePartial && (
          <p role="status">
            검토 요청 탐색이 끝나지 않았습니다. 계속 조회하세요.
          </p>
        )}
        {queueNext && (
          <Button
            disabled={busy}
            onClick={() => void action(() => refreshQueue(queueNext, true))}
          >
            다음 검토 요청
          </Button>
        )}
        {disclosures
          .filter(
            (d) =>
              d.reviewerId === principalId &&
              ["pending", "pending-confirmation"].includes(d.status),
          )
          .map((d) => (
            <article key={d.id}>
              <h4>
                {d.title} · r{d.draftRevision}
              </h4>
              <p>
                {d.policyMode === "personal-owner"
                  ? "본인 전용 확인"
                  : "지정된 독립 검토"}{" "}
                · 독자 {d.audience.join(", ")}
              </p>
              <p>
                요청 사유: {d.requestReason ?? "이전 요청에 사유 기록 없음"}
              </p>
              <DocumentBody
                content={d.content}
                readAttachment={readAttachment}
              />
              <label>
                검토 사유
                <textarea
                  aria-label={"검토 사유 " + d.title}
                  maxLength={2000}
                  value={decisionReasons[d.id] ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    setDecisionReasons((value) => ({
                      ...value,
                      [d.id]: e.target.value,
                    }))
                  }
                />
              </label>
              <Button
                disabled={busy || !decisionReasons[d.id]?.trim()}
                onClick={() =>
                  void action(async () => {
                    await api.post(
                      `/workflows/draft-disclosures/${d.id}/decision`,
                      {
                        hash: d.hash,
                        decision: "approve",
                        reason: decisionReasons[d.id].trim(),
                        mutationId: crypto.randomUUID(),
                      },
                    );
                    await Promise.all([
                      refreshOwner(),
                      refreshQueue(null, true),
                    ]);
                  })
                }
              >
                {d.policyMode === "personal-owner"
                  ? "본인 전용 원본 명시적 확인"
                  : "원본 공개 승인"}
              </Button>
              <Button
                disabled={busy || !decisionReasons[d.id]?.trim()}
                onClick={() =>
                  void action(async () => {
                    await api.post(
                      `/workflows/draft-disclosures/${d.id}/decision`,
                      {
                        hash: d.hash,
                        decision: "reject",
                        reason: decisionReasons[d.id].trim(),
                        mutationId: crypto.randomUUID(),
                      },
                    );
                    await Promise.all([
                      refreshOwner(),
                      refreshQueue(null, true),
                    ]);
                  })
                }
              >
                반려
              </Button>
            </article>
          ))}
      </section>
    </section>
  );
}
