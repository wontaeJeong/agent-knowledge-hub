export const isDemoRequested = (search: string) =>
  new URLSearchParams(search).get("demo") === "1";
export const pageItems = <T>(items: T[], page: number): T[] =>
  items.slice(page * 25, (page + 1) * 25);
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
  csrfToken: string;
}
export class OperationalApi {
  private csrf = "";
  constructor(private readonly origin = "") {}
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const res = await fetch(`${this.origin}/api/v1${path}`, {
      method,
      credentials: "same-origin",
      redirect: "error",
      headers: {
        ...(body !== undefined
          ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }
          : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) this.csrf = "";
      const code =
        typeof data.code === "string" && /^[A-Z_]{1,80}$/.test(data.code)
          ? data.code
          : "REQUEST_FAILED";
      const messages: Record<string, string> = {
        MODEL_OUTPUT_LIMIT: "모델 출력이 토큰 한도로 잘려 반영하지 않았습니다. 입력 규모와 추론 모드 설정을 확인하세요.",
        MODEL_CONFIGURATION: "서버의 모델 설정이 올바르지 않습니다.",
        UNAUTHENTICATED: "세션이 만료되었습니다. 다시 로그인하세요.",
        FORBIDDEN: "이 작업 권한이 없습니다.",
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
    const me = await this.request<Identity>("/me");
    this.csrf = me.csrfToken;
    return me;
  }
  get<T>(path: string) {
    return this.request<T>(path);
  }
  post<T>(path: string, body: unknown, key?: string) {
    return this.request<T>(path, "POST", body, key);
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
