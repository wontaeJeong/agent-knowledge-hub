export const isDemoRequested = (search: string) =>
  new URLSearchParams(search).get("demo") === "1";
export const pageItems = <T>(items: T[], page: number): T[] =>
  items.slice(page * 25, (page + 1) * 25);
export const documentHref = (
  spaceId: string,
  pageId: string,
  commentId?: string,
) =>
  `/?app=1&space=${encodeURIComponent(spaceId)}&document=${encodeURIComponent(pageId)}${commentId ? `#comment-${encodeURIComponent(commentId)}` : ""}`;
export function resumeWorkspaceLink(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, "https://workspace.invalid");
    if (
      url.origin !== "https://workspace.invalid" ||
      url.pathname !== "/" ||
      url.searchParams.get("app") !== "1" ||
      url.searchParams.has("demo")
    )
      return null;
    const space = url.searchParams.get("space"),
      document = url.searchParams.get("document");
    if (
      (space && !/^[a-zA-Z0-9_-]{1,100}$/.test(space)) ||
      (document && !/^[a-zA-Z0-9_-]{1,100}$/.test(document)) ||
      (url.hash && !/^#(?:comment|share)-[a-zA-Z0-9_-]{1,100}$/.test(url.hash))
    )
      return null;
    if ((document || url.hash) && !space) return null;
    return `/?app=1${space ? `&space=${encodeURIComponent(space)}` : ""}${document ? `&document=${encodeURIComponent(document)}` : ""}${url.hash}`;
  } catch {
    return null;
  }
}
export const snapshotPath = (pageId: string, version: number): string => {
  if (!Number.isSafeInteger(version) || version < 1)
    throw Error("정확한 인용 버전이 필요합니다.");
  return `/pages/${encodeURIComponent(pageId)}/versions/${version}`;
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly requestId?: string,
  ) {
    super(message);
  }
}
export interface Identity {
  principalId: string;
  workspaceId: string;
  role: "reader" | "editor" | "reviewer";
  spaceRole?: import("../domain/access").SpaceRole | null;
  canReviewKnowledge?: boolean;
  personalSpace?: boolean;
  csrfToken: string;
  capabilities?: string[];
  effectiveRole?: "read" | "triage" | "write" | "maintain" | "admin";
  space?: {
    id: string;
    namespaceKind: "personal" | "team";
    owner: boolean;
    namespaceSlug?: string;
    slug?: string;
    policyVersion?: number;
  } | null;
}
export class OperationalApi {
  private csrf = "";
  private meSequence = 0;
  private expiredHandler?: () => void;
  onExpired(handler: (() => void) | undefined) {
    this.expiredHandler = handler;
  }
  private sessionExpired() {
    this.meSequence++;
    const authenticated = !!this.csrf;
    this.csrf = "";
    if (authenticated) this.expiredHandler?.();
  }
  constructor(
    private readonly origin = "",
    private readonly spaceId = "",
  ) {}
  private async fetchResponse(
    path: string,
    init: RequestInit,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${this.origin}/api/v1${path}`, init);
      const header = res.headers.get("Retry-After"),
        delay = header === null ? NaN : Number(header);
      if (
        res.status !== 429 ||
        (init.method ?? "GET").toUpperCase() !== "GET" ||
        attempt === 2 ||
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        delay > 2
      )
        return res;
      await res.body?.cancel();
      if (delay)
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    }
    throw new ApiError("요청 재시도 한도에 도달했습니다.", 429, "RATE_LIMITED");
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await this.fetchResponse(path, {
      method,
      credentials: "same-origin",
      redirect: "error",
      headers: {
        ...extraHeaders,
        ...(this.spaceId ? { "X-Space-Id": this.spaceId } : {}),
        ...(body !== undefined
          ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }
          : {}),
        ...(!["GET", "HEAD"].includes(method.toUpperCase())
          ? { "Idempotency-Key": key ?? crypto.randomUUID() }
          : key
            ? { "Idempotency-Key": key }
            : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) this.sessionExpired();
      const code =
        typeof data.code === "string" && /^[A-Z_]{1,80}$/.test(data.code)
          ? data.code
          : "REQUEST_FAILED";
      const messages: Record<string, string> = {
        LAST_OWNER:
          "마지막 Organization Owner를 제거하거나 강등할 수 없습니다. 다른 멤버가 Owner 초대를 수락한 뒤 변경하세요.",
        INVITATION_REQUIRED:
          "첫 공간 권한이나 Owner 지정은 초대를 보내고 대상자의 수락을 받아야 합니다.",
        ORGANIZATION_MEMBERSHIP_REQUIRED:
          "먼저 같은 Organization에 가입해야 합니다.",
        ALREADY_MANAGED: "이미 조직 권한으로 관리되는 공간입니다.",
        IMPORT_QUOTA:
          "개인 250 MiB 또는 공간 1 GiB 수집 한도에 도달했습니다. 불필요한 수집 자료를 정리하세요.",
        MODEL_CONFIGURATION_CHANGED:
          "실행 중 모델 설정이 바뀌었습니다. 새 정리 작업을 시작하세요.",
        POLICY_CHANGED:
          "편입 정책 버전이 바뀌었습니다. 입력을 다시 확인해 새 작업을 시작하세요.",
        INPUT_CHANGED: "입력 선택이 변경됐습니다. 최신 미리보기를 확인하세요.",
        INPUT_FROZEN: "처리 중이거나 공유 제안된 입력은 바꿀 수 없습니다.",
        WARNINGS_REQUIRE_ACKNOWLEDGEMENT:
          "누락·불확실성 안내를 확인한 뒤 정리를 시작하세요.",
        ENCODING_REQUIRED: "원본 인코딩을 확인하고 다시 분석하세요.",
        CSV_MAPPING_REQUIRED: "CSV 본문 컬럼을 지정하세요.",
        INVALID_MODEL_EVIDENCE:
          "모델이 원문과 다른 근거를 제시해 결과를 반영하지 않았습니다.",
        CONTEXT_INCOMPLETE:
          "모든 입력의 처리 여부를 확인하지 못했습니다. 범위를 조정해 다시 실행하세요.",
        BUDGET_EXCEEDED:
          "자료·모델 처리 예산을 초과했습니다. 기간/대상을 줄여 다시 선택하세요.",
        CHECKSUM_MISMATCH:
          "파일 전송 검증에 실패했습니다. 같은 파일로 재전송하세요.",
        UPLOAD_INCOMPLETE: "파일 전송이 아직 끝나지 않았습니다.",
        UNSAFE_ARCHIVE:
          "지원하지 않는 압축 내용/경로/형식을 발견해 처리하지 않았습니다.",
        ARCHIVE_LIMIT: "압축 해제 크기 또는 파일 수 한도를 초과했습니다.",
        UNSUPPORTED_FORMAT: "지원하지 않는 파일 형식입니다.",
        AUTHORIZATION_REQUIRED: "실행 권한/세션을 다시 확인한 뒤 재개하세요.",
        NO_RECORDS: "선택 범위에 처리할 자료가 없습니다.",
        ALREADY_PROPOSED:
          "이미 공유 제안된 결과입니다. 변경 검토에서 확인하세요.",
        MODEL_OUTPUT_LIMIT:
          "모델 출력이 토큰 한도로 잘려 반영하지 않았습니다. 입력 규모와 추론 모드 설정을 확인하세요.",
        MODEL_CONFIGURATION: "서버의 모델 설정이 올바르지 않습니다.",
        UNAUTHENTICATED: "세션이 만료되었습니다. 다시 로그인하세요.",
        FORBIDDEN: "이 작업 권한이 없습니다.",
        OFFICIAL_REVIEW_REQUIRED:
          "공식 기준은 별도의 지정 인간 2명 이상 검토 정책이 필요합니다. 관리자에게 검토 정책 설정을 요청하세요.",
        DOCUMENT_PROTECTED:
          "보관·보호된 문서입니다. 현재 정책과 수동 보호 내용을 먼저 확인하세요.",
        SOURCE_REGISTRATION_REQUIRED:
          "개인 작업본만으로 근거를 대신할 수 없습니다. 원본을 먼저 등록하세요.",
        NOT_FOUND: "자료가 없거나 현재 접근할 수 없습니다.",
        MODEL_UNAVAILABLE:
          "모델을 사용할 수 없습니다. 설정과 작업 상태를 확인하세요.",
        MODEL_INVALID: "모델 출력 검증에 실패해 반영하지 않았습니다.",
        APPROVAL_STALE: "승인 기준이 변경되었습니다. 다시 검토하세요.",
        STALE_VERSION:
          "다른 변경이 반영되었습니다. 최신 버전에서 다시 제안하세요.",
        RATE_LIMITED:
          "요청 또는 실행 예산을 초과했습니다. 잠시 뒤 다시 시도하세요.",
      };
      const requestId =
        typeof data.requestId === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId)
          ? data.requestId
          : undefined;
      throw new ApiError(
        `${messages[code] || "서버 요청을 완료하지 못했습니다."} (${code}${requestId ? ` · 추적 ${requestId}` : ""})`,
        res.status,
        code,
        requestId,
      );
    }
    return data;
  }
  async me() {
    const sequence = ++this.meSequence;
    const me = await this.request<Identity>("/me");
    if (sequence === this.meSequence) this.csrf = me.csrfToken;
    return me;
  }
  get<T>(path: string) {
    return this.request<T>(path);
  }
  post<T>(path: string, body: unknown, key?: string) {
    return this.request<T>(path, "POST", body, key);
  }
  async transport(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.spaceId) headers.set("X-Space-Id", this.spaceId);
    if (!["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()))
      headers.set("X-CSRF-Token", this.csrf);
    const res = await this.fetchResponse(path, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      if (res.status === 401) this.sessionExpired();
      const data = await res.json().catch(() => ({}));
      const code =
        typeof data.code === "string" && /^[A-Z_]{1,80}$/.test(data.code)
          ? data.code
          : "REQUEST_FAILED";
      const requestId =
        typeof data.requestId === "string" &&
        /^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId)
          ? data.requestId
          : undefined;
      throw new ApiError(
        `${res.status === 401 ? "세션이 만료되었습니다. 다시 로그인하세요." : "파일 요청을 완료하지 못했습니다."} (${code})`,
        res.status,
        code,
        requestId,
      );
    }
    return res;
  }
  async logout() {
    const res = await fetch(`${this.origin}/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "X-CSRF-Token": this.csrf,
        "Content-Type": "application/json",
      },
      body: "{}",
      redirect: "error",
    });
    if (!res.ok) throw new ApiError("로그아웃에 실패했습니다.", res.status);
  }
}
