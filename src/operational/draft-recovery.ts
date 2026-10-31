import { ApiError, type OperationalApi } from "./api";
export async function draftRequest<T>(
  api: OperationalApi,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await api.transport(path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      "초안 요청을 완료하지 못했습니다.",
      response.status,
      typeof data?.error === "string"
        ? data.error
        : typeof data?.error?.code === "string"
          ? data.error.code
          : (data?.code ?? "REQUEST_FAILED"),
    );
  return data as T;
}
export interface Draft {
  id: string;
  revision: number;
  title: string;
  content: string;
  pageId?: string;
  baseVersion?: number;
  sourceIds?: string[];
  dependencyVersions?: Record<string, number>;
}
export interface RecoveryBinding {
  id: string;
  pageId: string;
  baseVersion: number;
  expectedRevision: number;
  sourceIds: string[];
  dependencyVersions: Record<string, number>;
  principalId: string;
  workspaceId: string;
  lineageHash: string;
  policyHash: string;
  expiresAt: number;
  /** Non-authenticating server cache binding. No login/session/CSRF token, key or role. */
  cacheBinding: string;
}
export interface SaveInput extends Omit<Draft, "revision"> {
  expectedRevision: number;
  mutationId: string;
}
export interface RecoveryValidation {
  status: "ready" | "conflict";
  revision: number;
  serverDraft: Draft | null;
}
export interface RecoveredDraft {
  draft: Draft;
  content: string;
  binding: RecoveryBinding;
  validation: RecoveryValidation;
  pending?: SaveInput;
}
const prefix = "akh:permitted-draft-recovery:v1:";
const bytes = (value: string) => new TextEncoder().encode(value).length;
const key = (principal: string, space: string, page: string) =>
  prefix + [principal, space, page].map(encodeURIComponent).join(":");
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function cleanDraft(d: Draft): Draft {
  return {
    id: d.id,
    revision: d.revision,
    title: d.title,
    content: d.content,
    pageId: d.pageId,
    baseVersion: d.baseVersion,
    ...(d.sourceIds ? { sourceIds: [...d.sourceIds] } : {}),
    ...(d.dependencyVersions
      ? { dependencyVersions: { ...d.dependencyVersions } }
      : {}),
  };
}
function cleanBinding(b: RecoveryBinding): RecoveryBinding {
  return {
    id: b.id,
    pageId: b.pageId,
    baseVersion: b.baseVersion,
    expectedRevision: b.expectedRevision,
    sourceIds: [...b.sourceIds],
    dependencyVersions: { ...b.dependencyVersions },
    principalId: b.principalId,
    workspaceId: b.workspaceId,
    lineageHash: b.lineageHash,
    policyHash: b.policyHash,
    expiresAt: b.expiresAt,
    cacheBinding: b.cacheBinding,
  };
}
function sameInputs(b: RecoveryBinding, d: Draft) {
  const sorted = (v: unknown) =>
    JSON.stringify(v, (_k, value) =>
      value && !Array.isArray(value) && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value,
    );
  return (
    b.id === d.id &&
    b.pageId === d.pageId &&
    b.baseVersion === d.baseVersion &&
    sorted([...b.sourceIds].sort()) ===
      sorted([...(d.sourceIds ?? [])].sort()) &&
    sorted(b.dependencyVersions) === sorted(d.dependencyVersions ?? {})
  );
}
export function saveInput(
  draft: Draft,
  content: string,
  mutationId = crypto.randomUUID(),
): SaveInput {
  const { revision, ...d } = cleanDraft(draft);
  return { ...d, expectedRevision: revision, content, mutationId };
}
/** Private plaintext cache, not server authority. Reads NEVER expose content before a
 * fresh server identity/ACL/policy/CAS check. Expiry stops new writes; no physical
 * erasure of previously exported user files is promised.
 */
export class RecoveryCache {
  constructor(
    readonly storage: Pick<
      Storage,
      "length" | "key" | "getItem" | "setItem" | "removeItem"
    >,
    readonly clock = Date.now,
  ) {}
  clear(principal: string, space: string, page: string) {
    this.storage.removeItem(key(principal, space, page));
  }
  clearAll() {
    for (const k of this.keys()) this.storage.removeItem(k);
  }
  private keys() {
    return Array.from({ length: this.storage.length }, (_, i) =>
      this.storage.key(i),
    ).filter((k): k is string => !!k?.startsWith(prefix));
  }
  write(
    binding: RecoveryBinding | null,
    draft: Draft,
    content: string,
    pending?: SaveInput,
  ) {
    if (
      !binding ||
      binding.expiresAt <= this.clock() ||
      binding.expiresAt > this.clock() + 300000 ||
      !sameInputs(binding, draft)
    )
      return false;
    const k = key(binding.principalId, binding.workspaceId, binding.pageId);
    const safePending = pending
      ? {
          ...cleanDraft({ ...pending, revision: pending.expectedRevision }),
          expectedRevision: pending.expectedRevision,
          mutationId: pending.mutationId,
        }
      : undefined;
    if (safePending) delete (safePending as Partial<Draft>).revision;
    const value = JSON.stringify({
      schema: "private-plaintext-draft-cache-v1",
      binding: cleanBinding(binding),
      draft: cleanDraft(draft),
      content,
      ...(safePending ? { pending: safePending } : {}),
    });
    if (bytes(value) > 131072) return false;
    try {
      this.storage.setItem(k, value);
      const keys = this.keys();
      let total = keys.reduce(
        (n, k) => n + bytes(this.storage.getItem(k) ?? ""),
        0,
      );
      for (const old of keys.filter((old) => old !== k)) {
        if (this.keys().length <= 10 && total <= 524288) break;
        total -= bytes(this.storage.getItem(old) ?? "");
        this.storage.removeItem(old);
      }
      return true;
    } catch {
      this.storage.removeItem(k);
      return false;
    }
  }
  async recover(
    principal: string,
    space: string,
    page: string,
    validate: (binding: RecoveryBinding) => Promise<RecoveryValidation>,
  ): Promise<RecoveredDraft | null> {
    const k = key(principal, space, page),
      value = this.storage.getItem(k);
    if (!value) return null;
    try {
      if (bytes(value) > 131072) throw Error("RECOVERY_CACHE_BOUND");
      const record = JSON.parse(value);
      const b = record.binding as RecoveryBinding,
        d = record.draft as Draft;
      if (
        record.schema !== "private-plaintext-draft-cache-v1" ||
        !b ||
        !d ||
        !validId(d.id) ||
        b.principalId !== principal ||
        b.workspaceId !== space ||
        b.pageId !== page ||
        b.id !== d.id ||
        b.expiresAt <= this.clock() ||
        b.expiresAt > this.clock() + 300000 ||
        !Number.isSafeInteger(d.revision) ||
        d.revision < 0 ||
        typeof record.content !== "string" ||
        typeof d.title !== "string" ||
        typeof d.content !== "string" ||
        b.baseVersion !== d.baseVersion
      ) {
        this.storage.removeItem(k);
        return null;
      }
      if (
        !sameInputs(b, d) ||
        (record.pending &&
          (!sameInputs(b, record.pending) ||
            typeof record.pending.content !== "string" ||
            typeof record.pending.mutationId !== "string" ||
            !Number.isSafeInteger(record.pending.expectedRevision)))
      )
        throw Error("RECOVERY_INVALID");
      const validation = await validate(cleanBinding(b)); // No offline fallback, including network failure.
      if (!["ready", "conflict"].includes(validation.status))
        throw Error("RECOVERY_INVALID");
      return {
        draft: cleanDraft(d),
        content: record.content,
        binding: b,
        validation,
        ...(record.pending ? { pending: record.pending } : {}),
      };
    } catch (e) {
      this.storage.removeItem(k);
      throw e;
    }
  }
}
export type SaveStatus =
  "dirty" | "saving" | "saved" | "offline" | "conflict" | "error";
export const saveStatusLabel: Record<SaveStatus, string> = {
  dirty: "저장 대기 · 아직 서버에 저장되지 않았습니다",
  saving: "서버에 저장 중…",
  saved: "서버에 저장됨 · 발행되지 않음",
  offline: "연결 중단 · 서버 저장 확인 안 됨",
  conflict: "저장 충돌 · 양쪽 본문을 확인하고 선택하세요",
  error: "저장 실패 · 입력을 유지하고 있습니다",
};
/** One in-flight CAS. A lost ACK retries the SAME mutation before newer typing.
 * No last-writer-wins retry, and dispose aborts/ignores old-identity completions.
 */
export class DraftAutosave {
  status: SaveStatus = "saved";
  content: string;
  pending?: SaveInput;
  serverDraft: Draft | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<Draft | null>;
  private disposed = false;
  readonly abort = new AbortController();
  constructor(
    public draft: Draft,
    readonly save: (input: SaveInput, signal?: AbortSignal) => Promise<Draft>,
    readonly changed: (state: DraftAutosave) => void,
    pending?: SaveInput,
  ) {
    this.content = draft.content;
    this.pending = pending;
    this.status = draft.revision ? "saved" : "dirty";
  }
  private notify() {
    if (!this.disposed) this.changed(this);
  }
  edit(content: string) {
    if (this.disposed) return;
    this.content = content;
    if (this.status !== "conflict") this.status = "dirty";
    this.notify();
    if (!this.timer && this.status !== "conflict")
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 1000);
  }
  flush(): Promise<Draft | null> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || this.status === "conflict")
      return Promise.resolve(null);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.inFlight = this.perform().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async perform(): Promise<Draft | null> {
    for (let n = 0; n < 5 && !this.disposed; n++) {
      if (
        !this.pending &&
        this.content === this.draft.content &&
        this.draft.revision > 0
      ) {
        this.status = "saved";
        this.notify();
        return this.draft;
      }
      this.pending ??= saveInput(this.draft, this.content);
      this.status = "saving";
      this.notify();
      try {
        const saved = await this.save(this.pending, this.abort.signal);
        if (this.disposed) return null;
        this.draft = cleanDraft(saved);
        this.pending = undefined;
        if (this.content === saved.content) {
          this.status = "saved";
          this.notify();
          return this.draft;
        }
      } catch (e) {
        if (this.disposed) return null;
        this.status =
          e instanceof ApiError &&
          (e.code === "STALE_VERSION" || e.status === 409)
            ? "conflict"
            : e instanceof TypeError
              ? "offline"
              : "error";
        this.notify();
        return null;
      }
    }
    this.status = "dirty";
    this.notify();
    if (!this.disposed)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 1000);
    return null;
  }
  conflict(serverDraft: Draft | null) {
    this.serverDraft = serverDraft;
    this.status = "conflict";
    this.notify();
  }
  /** Invoke only from an explicit user choice. A new CAS still checks the winner. */
  resolve(revision: number, content: string) {
    this.draft = { ...this.draft, revision };
    this.pending = undefined;
    this.serverDraft = null;
    this.status = "dirty";
    this.edit(content);
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
  }
}
