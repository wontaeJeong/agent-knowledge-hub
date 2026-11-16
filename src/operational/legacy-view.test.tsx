// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import OperationalApp from "./App";
test("a legacy reader can load source list without receiving proposal permission", async () => {
  window.history.replaceState(null, "", "/?app=1#sources");
  const fetcher = vi.fn(async (url: string) => {
    const path = String(url).split("/api/v1")[1];
    const data =
      path === "/me"
        ? {
            principalId: "reader",
            workspaceId: "legacy",
            role: "reader",
            csrfToken: "csrf",
            legacyAccess: true,
            capabilities: ["knowledge.read", "queue.triage", "jobs.read"],
          }
        : path === "/model"
          ? { configured: false, model: null }
          : { items: [] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<OperationalApp />));
  expect(
    fetcher.mock.calls.some((call) =>
      String(call[0]).endsWith("/api/v1/sources"),
    ),
  ).toBe(true);
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
