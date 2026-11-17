// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationalApi } from "../api";
let roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function components() {
  const m = await import(/* @vite-ignore */ String("./PersonalLibrary")).catch(
    () => ({ PersonalLibrary: undefined, DocumentPersonalControls: undefined }),
  );
  expect(m.PersonalLibrary, "personal library view").toBeDefined();
  return m;
}
const row = (id: string) => ({ id, title: `문서 ${id}`, version: 1, at: null });
const page = (
  ids: string[],
  nextCursor: string | null = null,
  revision = 1,
) => ({ items: ids.map(row), nextCursor, revision });
async function mount(Component: any, props: any) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => root.render(<Component {...props} />));
  return { element, root };
}
const button = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll("button")).find(
    (x) => x.textContent === text,
  )!;
test("library follows server cursors, shows subscriptions and never opens documents to authorize results", async () => {
  const { PersonalLibrary } = await components();
  const paths: string[] = [];
  const api = {
    get: async (path: string) => {
      paths.push(path);
      return path.includes("cursor=") ? page(["b"]) : page(["a"], "signed");
    },
  } as unknown as OperationalApi;
  const { element } = await mount(PersonalLibrary, {
    api,
    spaceId: "s",
    principalId: "p",
    kind: "subscriptions",
  });
  expect(paths).toEqual(["/workflows/subscriptions?limit=25"]);
  expect(element.querySelector("a")?.href).toContain("document=a");
  await act(async () => button(element, "다음 25개").click());
  expect(paths.at(-1)).toContain("cursor=signed");
  expect(element.textContent).not.toContain("문서 a");
  expect(element.textContent).toContain("문서 b");
  expect(localStorage.length).toBe(0);
});
test("keyboard-friendly move buttons use current revision and refresh authorized order", async () => {
  const { PersonalLibrary } = await components();
  let ids = ["a", "b"];
  const mutations: any[] = [];
  const api = {
    get: async () => page(ids, null, mutations.length ? 2 : 1),
    post: async (path: string, input: any) => {
      mutations.push({ path, ...input });
      ids = ["b", "a"];
      return { revision: 2 };
    },
  } as unknown as OperationalApi;
  const { element } = await mount(PersonalLibrary, {
    api,
    spaceId: "s",
    principalId: "p",
    kind: "favorites",
  });
  const move = element.querySelector<HTMLButtonElement>(
    '[aria-label="문서 b 위로 이동"]',
  )!;
  expect(move).not.toBeNull();
  move.focus();
  await act(async () => move.click());
  expect(mutations[0]).toMatchObject({
    path: "/workflows/favorites/reorder",
    pageIds: ["b", "a"],
    expectedRevision: 1,
  });
  expect(
    Array.from(element.querySelectorAll("a")).map((x) => x.textContent),
  ).toEqual(["문서 b", "문서 a"]);
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "문서 b 아래로 이동",
  );
});
test("account, space and API switches discard late reads and mutations synchronously", async () => {
  const { PersonalLibrary } = await components();
  let finish: (v: any) => void = () => {};
  const old = {
    get: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as OperationalApi;
  const fresh = { get: async () => page(["new"]) } as unknown as OperationalApi;
  const { element, root } = await mount(PersonalLibrary, {
    api: old,
    spaceId: "s",
    principalId: "old",
    kind: "favorites",
  });
  await act(async () =>
    root.render(
      <PersonalLibrary
        api={fresh}
        spaceId="next"
        principalId="new"
        kind="favorites"
      />,
    ),
  );
  await act(async () => finish(page(["SECRET"])));
  expect(element.textContent).not.toContain("SECRET");
  expect(element.textContent).toContain("문서 new");
});
test("revoked refresh clears cached titles and failed reorder shows an error rather than success", async () => {
  const { PersonalLibrary } = await components();
  let revoked = false;
  const api = {
    get: async () => (revoked ? page([]) : page(["a", "b"])),
    post: async () => {
      revoked = true;
      throw Error("권한 변경");
    },
  } as unknown as OperationalApi;
  const { element } = await mount(PersonalLibrary, {
    api,
    spaceId: "s",
    principalId: "p",
    kind: "favorites",
  });
  await act(async () =>
    element
      .querySelector<HTMLButtonElement>('[aria-label="문서 b 위로 이동"]')!
      .click(),
  );
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(element.textContent).not.toContain("문서 a");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(element.textContent).not.toContain("문서 b");
});
test("document toggles reflect current server state and reject stale account mutation completion", async () => {
  const { DocumentPersonalControls } = await components();
  expect(DocumentPersonalControls).toBeDefined();
  let favorite = true;
  let finish: (v: any) => void = () => {};
  const api = {
    get: async () => ({ favorite, subscribed: false }),
    post: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as OperationalApi;
  const { element, root } = await mount(DocumentPersonalControls, {
    api,
    spaceId: "s",
    principalId: "p",
    pageId: "a",
  });
  expect(button(element, "즐겨찾기 해제")?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  await act(async () => button(element, "즐겨찾기 해제").click());
  favorite = false;
  await act(async () =>
    root.render(
      <DocumentPersonalControls
        api={
          {
            get: async () => ({ favorite: false, subscribed: true }),
          } as unknown as OperationalApi
        }
        spaceId="s"
        principalId="other"
        pageId="b"
      />,
    ),
  );
  await act(async () => finish({ enabled: false }));
  expect(button(element, "즐겨찾기 추가")).toBeDefined();
  expect(button(element, "구독 해제")).toBeDefined();
  expect(element.textContent).not.toContain("저장했습니다");
});
test("a focus read during a pending favorite mutation cannot suppress its authorized readback", async () => {
  const { DocumentPersonalControls } = await components();
  let favorite = true,
    finish: (v: any) => void = () => {};
  const api = {
    get: async () => ({ favorite, subscribed: false }),
    post: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as OperationalApi;
  const { element } = await mount(DocumentPersonalControls, {
    api,
    spaceId: "s",
    principalId: "p",
    pageId: "a",
  });
  await act(async () => button(element, "즐겨찾기 해제").click());
  await act(async () => window.dispatchEvent(new Event("focus")));
  favorite = false;
  await act(async () => finish({ enabled: false }));
  expect(button(element, "즐겨찾기 추가")).toBeDefined();
});
test("obsolete library mutation completion cannot refresh a new API/account and current mutation survives a focus refresh", async () => {
  const { PersonalLibrary } = await components();
  let ids = ["a", "b", "c"],
    finish: (v: any) => void = () => {};
  const api = {
    get: async () => page(ids, null, 1),
    post: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as OperationalApi;
  const { element, root } = await mount(PersonalLibrary, {
    api,
    spaceId: "s",
    principalId: "p",
    kind: "favorites",
  });
  await act(async () =>
    element
      .querySelector<HTMLButtonElement>('[aria-label="문서 b 아래로 이동"]')!
      .click(),
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  ids = ["a", "c", "b"];
  await act(async () => finish({ revision: 2 }));
  expect(
    Array.from(element.querySelectorAll("a")).map((x) => x.textContent),
  ).toEqual(["문서 a", "문서 c", "문서 b"]);
  await act(async () =>
    element
      .querySelector<HTMLButtonElement>('[aria-label="문서 c 아래로 이동"]')!
      .click(),
  );
  const fresh = {
    get: vi.fn(async () => page(["new"])),
  } as unknown as OperationalApi;
  await act(async () =>
    root.render(
      <PersonalLibrary
        api={fresh}
        spaceId="s"
        principalId="other"
        kind="favorites"
      />,
    ),
  );
  await act(async () => finish({ revision: 3 }));
  expect(element.textContent).not.toContain("문서 c");
  expect(fresh.get).toHaveBeenCalledTimes(1);
});
