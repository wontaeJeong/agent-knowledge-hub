// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationalApi } from "../api";
import { LinkAutocomplete } from "./LinkAutocomplete";
import { Backlinks } from "./Backlinks";
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
async function mount(el: React.ReactNode) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(el));
}
const candidates = [
  { id: "a", title: "중복", version: 1 },
  { id: "b", title: "중복", version: 2 },
];
function Editor({ api }: { api: OperationalApi }) {
  const [value, setValue] = useState("메모 [[중복");
  return (
    <LinkAutocomplete
      api={api}
      spaceId="s"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      aria-label="본문"
      onError={() => {}}
    />
  );
}
test("duplicate titles require explicit ID choice and insert portable stable Markdown with keyboard", async () => {
  const api = {
    post: async (_path: string, body: any) => ({
      items:
        body.query === "b"
          ? [{ id: "b", title: "바뀐 제목", version: 2 }]
          : candidates,
    }),
  } as OperationalApi;
  await mount(<Editor api={api} />);
  const area = document.querySelector("textarea")!;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  await act(async () => {
    area.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }),
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(area.value).toBe("메모 [[중복");
  expect(document.body.textContent).toContain("a");
  expect(document.body.textContent).toContain("b");
  await act(async () =>
    area.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(document.activeElement?.tagName).toBe("BUTTON");
  const choices = [...document.querySelectorAll("button")].filter((x) =>
    x.textContent?.includes("링크 삽입"),
  );
  await act(async () => choices[1].click());
  expect(area.value).toBe("메모 [바뀐 제목](/?app=1&space=s&document=b)");
  expect(document.activeElement).toBe(area);
});
test("IME composition does not select or search until composition ends; Escape preserves unresolved text", async () => {
  let calls = 0;
  const api = {
    post: async () => {
      calls++;
      return { items: candidates };
    },
  } as unknown as OperationalApi;
  await mount(<Editor api={api} />);
  const area = document.querySelector("textarea")!;
  await act(async () => {
    area.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    area.setSelectionRange(area.value.length, area.value.length);
    area.dispatchEvent(new Event("select", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  expect(calls).toBe(0);
  await act(async () =>
    area.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(calls).toBe(1);
  await act(async () =>
    area.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(area.value).toBe("메모 [[중복");
  expect(document.querySelector("[role=listbox]")).toBeNull();
});
test("revoked candidate cannot be inserted and late identity response cannot reveal suggestions", async () => {
  const errors: string[] = [];
  let calls = 0;
  const api = {
    post: async () => ({ items: ++calls === 1 ? candidates : [] }),
  } as unknown as OperationalApi;
  await mount(
    <LinkAutocomplete
      api={api}
      spaceId="s"
      value="[[중복"
      onChange={() => {}}
      onError={(e) => errors.push(String(e))}
    />,
  );
  const area = document.querySelector("textarea")!;
  area.focus();
  area.setSelectionRange(4, 4);
  await act(async () =>
    area.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }),
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent?.includes("링크 삽입"))!
      .click(),
  );
  expect(area.value).toBe("[[중복");
  expect(errors).toHaveLength(1);
});
test("backlinks paginate by server cursor, clear on identity change and show errors separately from zero", async () => {
  const api = {
    get: async (path: string) => ({
      pageId: "target",
      version: 1,
      items: [
        {
          id: path.includes("cursor=next") ? "two" : "one",
          title: "참조 문서",
          version: 1,
        },
      ],
      nextCursor: path.includes("cursor=next") ? null : "next",
    }),
  } as OperationalApi;
  await mount(
    <Backlinks
      api={api}
      spaceId="s"
      pageId="target"
      version={1}
      onError={() => {}}
    />,
  );
  expect(document.querySelector("a")?.href).toContain("document=one");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((x) => x.textContent === "다음 백링크")!
      .click(),
  );
  expect(document.querySelector("a")?.href).toContain("document=two");
  await act(async () =>
    root.render(
      <Backlinks
        api={
          {
            get: async () => {
              throw Error("denied");
            },
          } as unknown as OperationalApi
        }
        spaceId="other"
        pageId="target"
        version={1}
        onError={() => {}}
      />,
    ),
  );
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelector("[role=alert]")).toBeTruthy();
});

test("late suggestion response after API identity switch never reappears", async () => {
  let resolve!: (value: unknown) => void;
  const old = {
    post: () => new Promise((r) => (resolve = r)),
  } as unknown as OperationalApi;
  await mount(
    <LinkAutocomplete
      api={old}
      spaceId="s"
      value="[[중복"
      onChange={() => {}}
      onError={() => {}}
    />,
  );
  const area = document.querySelector("textarea")!;
  area.focus();
  area.setSelectionRange(4, 4);
  await act(async () =>
    area.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }),
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  const next = {
    post: async () => ({ items: [] }),
  } as unknown as OperationalApi;
  await act(async () =>
    root.render(
      <LinkAutocomplete
        api={next}
        spaceId="other"
        value=""
        onChange={() => {}}
        onError={() => {}}
      />,
    ),
  );
  await act(async () => resolve({ items: candidates }));
  expect(document.querySelector("[role=listbox]")).toBeNull();
  expect(document.body.textContent).not.toContain("중복");
});
