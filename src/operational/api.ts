export const isDemoRequested = (search: string) => new URLSearchParams(search).get("demo") === "1";
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface Identity { principalId: string; workspaceId: string; role: "reader" | "editor" | "reviewer"; csrfToken: string }
export class OperationalApi {
  private csrf = "";
  constructor(private readonly origin = "") {}
  async request<T>(path: string, method = "GET", body?: unknown, key?: string): Promise<T> {
    const res = await fetch(`${this.origin}/api/v1${path}`, {
      method, credentials: "same-origin", redirect: "error",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(typeof data.error === "string" ? data.error : "서버 요청에 실패했습니다.", res.status);
    return data;
  }
  async me() { const me = await this.request<Identity>("/me"); this.csrf = me.csrfToken; return me; }
  get<T>(path: string) { return this.request<T>(path); }
  post<T>(path: string, body: unknown, key?: string) { return this.request<T>(path, "POST", body, key); }
  async logout() {
    const res = await fetch(`${this.origin}/auth/logout`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": this.csrf, "Content-Type": "application/json" }, body: "{}", redirect: "error" });
    if (!res.ok) throw new ApiError("로그아웃에 실패했습니다.", res.status);
  }
}
