// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { test, expect, vi } from "vitest";
import { ShareSelection } from "./ShareSelection";
import type { OperationalApi } from "./api";
test("explicit preview fixes selected child versions and discards them on scope changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const calls: unknown[] = [];
  const api = {
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return {
        token: "sealed",
        expiresAt: "2026-11-16",
        recipientId: "reader",
        items: [
          {
            pageId: "topic",
            version: 2,
            title: "Parent",
            parentId: null,
            audienceChange: "unchanged",
          },
          {
            pageId: "child",
            version: 1,
            title: "Child",
            parentId: "topic",
            audienceChange: "unchanged",
          },
        ],
      };
    },
  } as unknown as OperationalApi;
  const render = (scope: string) =>
    root.render(
      <ShareSelection
        api={api}
        scope={scope}
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    );
  const type = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () => render("old"));
    const inputs = el.querySelectorAll("input");
    await type(inputs[0], "topic");
    await type(inputs[1], "reader");
    await act(async () => el.querySelector("button")!.click());
    expect(el.textContent).toContain("Parent");
    expect(el.textContent).toContain("Child");
    expect(el.textContent).toContain("v2");
    expect(calls).toHaveLength(1);
    await act(async () => render("new"));
    expect(el.textContent).not.toContain("Parent");
    expect(el.textContent).not.toContain("Child");
  } finally {
    await act(async () => root.unmount());
    el.remove();
    vi.unstubAllGlobals();
  }
});
