// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { VersionsPanel } from "./versions";
import { ApiError, type OperationalApi } from "./api";
import { readConsoleTab } from "./console";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of clean.splice(0)) await f();
  vi.unstubAllGlobals();
});
async function render(api: OperationalApi) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const draw = async (principalId = "old") =>
    act(async () =>
      root.render(
        <VersionsPanel
          api={api}
          pages={[
            { id: "a", title: "Document A" },
            { id: "b", title: "Document B" },
          ]}
          batches={[]}
          spaceId="space"
          principalId={principalId}
          canPropose
          canReview
        />,
      ),
    );
  await draw();
  clean.push(async () => {
    await act(async () => root.unmount());
    el.remove();
  });
  const select = async (index: number, value: string) =>
    act(async () => {
      const s = el.querySelectorAll("select")[index];
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const click = async (text: string) =>
    act(async () => {
      const b = Array.from(el.querySelectorAll("button")).find(
        (x) => x.textContent === text,
      );
      expect(b, `button ${text}`).toBeTruthy();
      b!.click();
    });
  return { el, draw, select, click };
}
const history = {
  items: [
    { number: 2, at: "now", author: "author", metadataKnown: true },
    { number: 1, at: "old", author: "author", metadataKnown: false },
  ],
  next: null,
};
const compare = (offset = 0) => ({
  text: {
    mode: "exact",
    fromCount: 0,
    toCount: 30,
    lines: Array.from({ length: offset ? 5 : 25 }, (_, i) => ({
      kind: "add",
      text: `private-line-${offset + i}`,
      fromLine: null,
      toLine: offset + i + 1,
    })),
    offset,
    totalLines: 30,
    next: offset ? null : 25,
  },
  metadata: [],
  anchors: [],
});

test("late private history cannot reappear after identity changes", async () => {
  let resolve!: (v: unknown) => void;
  const view = await render({
    get: () =>
      new Promise((r) => {
        resolve = r;
      }),
  } as unknown as OperationalApi);
  await view.select(0, "a");
  await view.draw("new");
  await act(async () => resolve(history));
  expect(view.el.textContent).not.toContain("버전 목록");
  expect((view.el.querySelector("select") as HTMLSelectElement).value).toBe("");
});

test("comparison follows server pagination beyond25 and clears private content after permission denial", async () => {
  const post = vi.fn(async (_path: string, body: { offset?: number }) =>
    compare(body.offset),
  );
  let denied = false;
  const view = await render({
    get: async () => {
      if (denied) throw new ApiError("권한 철회", 403);
      return history;
    },
    post,
  } as unknown as OperationalApi);
  await view.select(0, "a");
  await view.click("선택 버전 비교");
  expect(view.el.textContent).toContain("private-line-0");
  await view.click("다음 25줄");
  expect(view.el.textContent).toContain("private-line-29");
  expect(post).toHaveBeenLastCalledWith("/versions/pages/a/compare", {
    from: 1,
    to: 2,
    offset: 25,
  });
  denied = true;
  await view.select(0, "b");
  expect(view.el.textContent).not.toContain("private-line");
  expect(view.el.textContent).not.toContain("버전 목록");
});

test("publication pagination reaches older bundles and document changes discard history while loading", async () => {
  let pending!: (v: unknown) => void;
  const get = async (path: string) => {
    if (path.includes("/bundles"))
      return {
        items: [
          {
            batchId: path.includes("offset=25") ? "old-bundle" : "new-bundle",
            pages: [
              {
                pageId: "a",
                title: path.includes("offset=25")
                  ? "Older publication"
                  : "New publication",
                number: 1,
              },
            ],
          },
        ],
        next: path.includes("offset=25") ? null : 25,
      };
    if (path.includes("/b/"))
      return new Promise((r) => {
        pending = r;
      });
    return history;
  };
  const view = await render({ get } as unknown as OperationalApi);
  await view.click("허용된 발행 묶음 가져오기");
  await view.click("다음 발행 묶음 25개");
  expect(view.el.textContent).toContain("Older publication");
  await view.select(0, "a");
  expect(view.el.textContent).toContain("버전 목록");
  await view.select(0, "b");
  expect(view.el.textContent).not.toContain("버전 목록");
  await act(async () => pending({ items: [], next: null }));
  expect(readConsoleTab("#versions")).toBe("versions");
});
