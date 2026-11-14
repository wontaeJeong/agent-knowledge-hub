// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import OperationalApp from "./App";
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });
test("account shows own sessions and clears protected identity after current revocation", async () => {
  window.history.replaceState(null, "", "/?app=1#account");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url).split("/api/v1")[1];
    const data = path === "/me" ? { principalId: "person", workspaceId: "space", role: "reader", csrfToken: "csrf" }
      : path?.startsWith("/identity/sessions") && options?.method === "DELETE" ? { revoked: true, current: true }
      : path?.startsWith("/identity/sessions") ? { items: [{ id: "a".repeat(64), label: "현재 브라우저", current: true, active: true, createdAt: "2026-01-01", lastSeenAt: "2026-01-01", expiresAt: "2027-01-01" }], total: 1, offset: 0, limit: 25 }
      : path === "/model" ? { configured: false, model: null } : { items: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<OperationalApp />); });
  expect(container.textContent).toContain("현재 브라우저");
  const revoke = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("세션 종료"));
  expect(revoke).toBeDefined();
  await act(async () => { revoke!.click(); });
  expect(container.textContent).not.toContain("현재 브라우저");
  expect(container.textContent).toContain("다시 로그인");
  await act(async () => root.unmount());
});

test("a pending reconnect cannot restore identity after current session revocation", async () => {
  window.history.replaceState(null, "", "/?app=1#account");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let meReads = 0;
  let finishReconnect!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => { finishReconnect = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url).split("/api/v1")[1];
    if (path === "/me" && ++meReads === 3) return pending;
    if (path === "/pages") return new Response(JSON.stringify({ code: "DEPENDENCY_UNAVAILABLE" }), { status: 503 });
    const data = path === "/me" ? { principalId: "person", workspaceId: "space", role: "reader", csrfToken: "csrf" }
      : path?.startsWith("/identity/sessions") && options?.method === "DELETE" ? { revoked: true, current: true }
      : path?.startsWith("/identity/sessions") ? { items: [{ id: "a".repeat(64), label: "현재 브라우저", current: true, active: true, createdAt: "2026-01-01", lastSeenAt: "2026-01-01", expiresAt: "2027-01-01" }], total: 1, offset: 0, limit: 25 }
      : { items: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<OperationalApp />); });
  const reconnect = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("다시 연결"));
  expect(reconnect).toBeDefined();
  await act(async () => { reconnect!.click(); });
  const revoke = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("이 세션 종료"));
  expect(revoke).toBeDefined();
  await act(async () => { revoke!.click(); });
  expect(container.textContent).toContain("SSO 로그인");
  await act(async () => { finishReconnect(new Response(JSON.stringify({ principalId: "person", workspaceId: "space", role: "reader", csrfToken: "stale" }), { status: 200 })); });
  expect(container.textContent).toContain("SSO 로그인");
  expect(container.textContent).not.toContain("현재 브라우저");
  await act(async () => root.unmount());
});

test("logout-all leaves the external IdP result visible after protected UI clears", async () => {
  window.history.replaceState(null, "", "/?app=1#account");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).split("/api/v1")[1];
    const data = path === "/me" ? { principalId: "person", workspaceId: "space", role: "reader", csrfToken: "csrf" }
      : path === "/identity/logout-all" ? { idpLogout: "not_configured" }
      : path?.startsWith("/identity/sessions") ? { items: [{ id: "a".repeat(64), label: "현재 브라우저", current: true, active: true, createdAt: "2026-01-01", lastSeenAt: "2026-01-01", expiresAt: "2027-01-01" }], total: 1, offset: 0, limit: 25 }
      : path === "/model" ? { configured: false, model: null } : { items: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(<OperationalApp />); });
  const confirm = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => { confirm.click(); });
  const logout = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "내 모든 세션 종료")!;
  await act(async () => { logout.click(); });
  expect(container.textContent).toContain("SSO 로그인");
  expect(container.textContent).toContain("외부 인증 서비스 로그아웃은 구성되지 않았습니다");
  await act(async () => root.unmount());
});
