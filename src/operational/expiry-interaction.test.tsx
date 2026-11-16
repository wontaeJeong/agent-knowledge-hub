// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { WorkflowPanel } from "./workflows";
import type { OperationalApi } from "./api";
test("document expiry settings retain the base revision and require a change reason", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const posts: any[] = [];
  const api = {
    get: async (path: string) =>
      path === "/workflows/pages/topic"
        ? {
            page: {
              id: "topic",
              title: "Synthetic document",
              versions: [{ number: 1, content: "body", sourceIds: [] }],
            },
            settings: {
              revision: 4,
              state: "active",
              parent_id: null,
              data: { effectiveUntil: "2030-01-01T00:00:00Z" },
            },
          }
        : { items: [] },
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return {};
    },
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <WorkflowPanel
        api={api}
        pages={[{ id: "topic", title: "Synthetic document" }]}
        capabilities={[
          "knowledge.read",
          "lifecycle.manage",
          "knowledge.protect",
        ]}
        onChanged={async () => {}}
        onExpired={() => {}}
        initialPageId="topic"
      />,
    ),
  );
  expect(el.textContent).toContain("유효기간 종료 (UTC)");
  const btn = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "유효기간 저장",
  )!;
  expect(btn.disabled).toBe(true);
  const input = el.querySelector(
    'input[placeholder="복원·보호·수명주기 변경 이유"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Synthetic expiry review");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => btn.click());
  expect(posts).toContainEqual({
    path: "/workflows/pages/topic/state",
    body: {
      expectedRevision: 4,
      effectiveUntil: "2030-01-01T00:00:00.000Z",
      reason: "Synthetic expiry review",
    },
  });
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
