// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import OperationalApp from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
test("authenticated question tab mounts private conversation workbench", async () => {
  window.history.replaceState(null, "", "/?app=1#query");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split("/api/v1")[1];
      const data =
        path === "/me"
          ? {
              principalId: "reader",
              workspaceId: "space",
              role: "reader",
              csrfToken: "synthetic",
            }
          : path === "/model"
            ? { configured: false, model: null }
            : { items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationalApp />);
  });
  expect(container.textContent).toContain("질문과 후속 대화");
  await act(async () => root.unmount());
});
