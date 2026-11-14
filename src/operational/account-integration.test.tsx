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
