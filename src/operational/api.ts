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
  spaceRole?: import("../domain/access").SpaceRole | null;
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
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.origin}/api/v1${path}`, {
      method,
      credentials: "same-origin",
      redirect: "error",
      headers: {
        ...extraHeaders,
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
