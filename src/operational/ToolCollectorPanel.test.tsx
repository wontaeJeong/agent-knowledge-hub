// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ToolCollectorPanel } from "./ToolCollectorPanel";
import type { OperationalApi } from "./api";
test("shows only approved sessions and submits a selected artifact without caller provenance or credentials", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const post = vi.fn(async (_path: string, _body: unknown) => ({
    id: "synthetic-source",
    duplicate: false,
  }));
  const api = {
    get: async () => ({
      items: [
        {
          id: "host",
          label: "합성 연결",
          active: true,
          revision: 1,
          version: "2.2.2",
          allowedSessionIds: ["ses_one"],
        },
      ],
    }),
    post,
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<ToolCollectorPanel api={api} />));
  expect(el.textContent).toContain("합성 연결");
  expect(el.querySelector('option[value="ses_one"]')).not.toBeNull();
  const change = async (label: string, value: string) => {
    const input = el.querySelector(
      `[aria-label="${label}"]`,
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("메시지 ID", "msg_selected");
  await change("자료 제목", "선택한 자료");
  await act(async () =>
    el
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(post).toHaveBeenCalledWith(
    "/storage/collector-connections/host/collect",
    expect.objectContaining({
      sessionId: "ses_one",
      artifactId: "msg_selected",
      expectedRevision: 1,
      title: "선택한 자료",
    }),
  );
  expect(post.mock.calls[0][1]).not.toHaveProperty("artifact");
  expect(el.textContent).toContain("개인 원본으로 저장했습니다");
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
test("unconfigured collector is explicit and does not offer a fabricated successful connection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div"),
    root = createRoot(el);
  await act(async () =>
    root.render(
      <ToolCollectorPanel
        api={{ get: async () => ({ items: [] }) } as unknown as OperationalApi}
      />,
    ),
  );
  expect(el.textContent).toContain("승인된 연결이 없습니다");
  expect(el.querySelector("form")).toBeNull();
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

test("refresh and collection preserve an active connection/session; changed context clears artifact fields", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const items = [
    {
      id: "a",
      label: "A",
      active: true,
      revision: 1,
      version: "2.2.2",
      allowedSessionIds: ["ses_A"],
    },
    {
      id: "b",
      label: "B",
      active: true,
      revision: 1,
      version: "2.2.2",
      allowedSessionIds: ["ses_B1", "ses_B2"],
    },
  ];
  const api = {
    get: async () => ({ items }),
    post: async () => ({ id: "created", duplicate: false }),
  } as unknown as OperationalApi;
  const el = document.createElement("div"),
    root = createRoot(el);
  await act(async () => root.render(<ToolCollectorPanel api={api} />));
  const selects = () => el.querySelectorAll("select");
  await act(async () => {
    selects()[0].value = "b";
    selects()[0].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    selects()[1].value = "ses_B2";
    selects()[1].dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = el.querySelector(
    '[aria-label="메시지 ID"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "msg_retained");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const refresh = () =>
    Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("새로 고침"),
    )!;
  await act(async () => refresh().click());
  expect(selects()[0].value).toBe("b");
  expect(selects()[1].value).toBe("ses_B2");
  expect(input.value).toBe("msg_retained");
  await act(async () =>
    el
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(selects()[1].value).toBe("ses_B2");
  items[1].active = false;
  await act(async () => refresh().click());
  expect(selects()[0].value).toBe("a");
  expect(input.value).toBe("");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
