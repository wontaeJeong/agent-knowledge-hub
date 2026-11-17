// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { OperationalApi } from "../api";
import type { SearchItem } from "./search-client";
let roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function load() {
  const m = await import(/* @vite-ignore */ String("./QuickOpen")).catch(
    () => ({ QuickOpen: undefined }),
  );
  expect(m.QuickOpen, "quick document opening").toBeDefined();
  return m;
}
async function mount(Component: any, props: any) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => root.render(<Component {...props} />));
  return { element, root };
}
const item = (id: string): SearchItem => ({
  pageId: id,
  version: 1,
  versionId: `v-${id}`,
  at: "2026-01-01T00:00:00Z",
  title: id,
  content: "코드_retry <img src=x onerror=alert(1)>",
  historical: false,
  currentRecommendation: true,
  metadataStatus: "known",
  unknownMetadataKeys: [],
  metadata: { type: "기술 설계", environment: "test", reviewDate: null },
  href: `/api/v1/pages/${id}/versions/1`,
});
const result = (id: string) => ({
  items: [item(id)],
  nextCursor: null,
  asof: "2026-11-01T00:00:00Z",
});
async function input(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick(ms = 200) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
test("IME waits for composition end and debounces 200ms before safe keyword results", async () => {
  const { QuickOpen } = await load();
  vi.useFakeTimers();
  const requests: any[] = [];
  const api = {
    post: async (path: string, body: any) => {
      requests.push({ path, body });
      return result("코드_retry");
    },
  } as unknown as OperationalApi;
  const { element } = await mount(QuickOpen, {
    api,
    onOpen: () => {},
    onClose: () => {},
  });
  const q = element.querySelector("input")!;
  await act(async () =>
    q.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await input(q, "코드_retry");
  await tick(400);
  expect(requests).toEqual([]);
  await act(async () =>
    q.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "코드_retry",
      }),
    ),
  );
  await tick(199);
  expect(requests).toEqual([]);
  await tick(1);
  expect(requests).toEqual([
    {
      path: "/questions/search",
      body: {
        query: "코드_retry",
        tags: [],
        historical: false,
        sort: "title",
        limit: 10,
      },
    },
  ]);
  expect(element.textContent).toContain("코드_retry");
  expect(element.querySelector("img")).toBeNull();
  expect(element.querySelector("mark")?.textContent).toBe("코드_retry");
  expect(localStorage.length).toBe(0);
});
test("old responses cannot replace a changed query or API identity and requests are aborted", async () => {
  const { QuickOpen } = await load();
  vi.useFakeTimers();
  let finish: any;
  let signal: AbortSignal | undefined;
  const old = {
    post: (_p: any, _b: any, _k: any, s: AbortSignal) => {
      signal = s;
      return new Promise((r) => (finish = r));
    },
  } as unknown as OperationalApi;
  const fresh = {
    post: async () => result("새 문서"),
  } as unknown as OperationalApi;
  const { element, root } = await mount(QuickOpen, {
    api: old,
    onOpen: () => {},
    onClose: () => {},
  });
  await input(element.querySelector("input")!, "old");
  await tick();
  await input(element.querySelector("input")!, "new");
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    root.render(<QuickOpen api={fresh} onOpen={() => {}} onClose={() => {}} />),
  );
  await act(async () => finish(result("비공개 이전 제목")));
  expect(element.textContent).not.toContain("비공개 이전 제목");
  expect(element.querySelector("input")?.value).toBe("");
});
test("keyboard selection opens the exact document, traps Tab and composition Escape does not close", async () => {
  const { QuickOpen } = await load();
  vi.useFakeTimers();
  const opened: any[] = [],
    closed: any[] = [];
  const api = {
    post: async () => result("exact"),
  } as unknown as OperationalApi;
  const { element } = await mount(QuickOpen, {
    api,
    onOpen: (v: any) => {
      opened.push(v);
      return false;
    },
    onClose: () => closed.push(true),
  });
  const q = element.querySelector("input")!;
  await input(q, "코드_retry");
  await tick();
  expect(document.activeElement).toBe(q);
  await act(async () =>
    q.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(q.getAttribute("aria-activedescendant")).toBe(
    element.querySelector('[role="option"]')?.id,
  );
  await act(async () =>
    q.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(opened[0]).toMatchObject({ pageId: "exact", version: 1 });
  expect(closed).toEqual([]);
  await act(async () =>
    q.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  expect(closed).toEqual([]);
  const last = Array.from(element.querySelectorAll("button")).at(-1)!;
  last.focus();
  await act(async () =>
    last.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.activeElement).toBe(q);
  await act(async () =>
    q.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(closed).toEqual([true]);
});
test("abort signal reaches native keyword transport with no model endpoint", async () => {
  const m = await import(/* @vite-ignore */ String("./search-client")).catch(
    () => ({ searchDocuments: undefined, normalizeSearchFilters: undefined }),
  );
  expect(m.searchDocuments).toBeDefined();
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(result("real")), { status: 200 });
  });
  const controller = new AbortController();
  const page = await m.searchDocuments!(
    new OperationalApi(),
    { query: " code " },
    { limit: 25, signal: controller.signal },
  );
  expect(page.items[0].pageId).toBe("real");
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("/api/v1/questions/search");
  expect(JSON.parse(calls[0].init.body)).toMatchObject({
    query: "code",
    historical: false,
    limit: 25,
  });
  controller.abort();
  expect(calls[0].init.signal.aborted).toBe(true);
  expect(() => m.normalizeSearchFilters!({ historical: "true" })).toThrow();
});
test("global shortcut respects editable and other dialog targets, returns focus only on explicit close", async () => {
  const { GlobalSearch } = await import("./QuickOpen");
  const outside = document.createElement("button");
  outside.textContent = "outside";
  document.body.append(outside);
  const api = {
    post: async () => result("found"),
  } as unknown as OperationalApi;
  const { element } = await mount(GlobalSearch, {
    api,
    identityKey: "s:p",
    onOpen: () => true,
    onSearch: () => true,
  });
  outside.focus();
  await act(async () =>
    outside.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(element.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () =>
    element
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
  );
  expect(document.activeElement).toBe(outside);
  const editable = document.createElement("input");
  document.body.append(editable);
  editable.focus();
  await act(async () =>
    editable.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => element.querySelector("button")!.click());
  outside.focus();
  await act(async () =>
    Array.from(element.querySelectorAll("button"))
      .find((b) => b.textContent === "닫기")!
      .click(),
  );
  expect(document.activeElement).toBe(outside);
});
test("detail filters use the canonical schema, reset cursors and clear failures instead of showing stale rows", async () => {
  const { SearchPage } = await import(
    /* @vite-ignore */ String("./SearchPage")
  ).catch(() => ({ SearchPage: undefined }));
  expect(SearchPage).toBeDefined();
  vi.useFakeTimers();
  const calls: any[] = [];
  const api = {
    post: async (_p: string, body: any) => {
      calls.push(body);
      if (body.cursor)
        throw new (await import("../api")).ApiError(
          "stale",
          409,
          "STALE_CURSOR",
        );
      return {
        ...result(body.historical ? "old" : "current"),
        nextCursor: "signed",
      };
    },
  } as unknown as OperationalApi;
  const { element, root } = await mount(SearchPage, {
    api,
    identityKey: "s:p",
    onOpen: () => {},
  });
  await tick();
  expect(calls[0]).toMatchObject({
    historical: false,
    sort: "recent",
    limit: 25,
  });
  await act(async () =>
    Array.from(element.querySelectorAll("button"))
      .find((b) => b.textContent === "다음 결과 25건")!
      .click(),
  );
  expect(element.textContent).not.toContain("current");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    "처음부터",
  );
  await act(async () =>
    element.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
  );
  await tick();
  expect(calls.at(-1)).toMatchObject({ historical: true, limit: 25 });
  expect(calls.at(-1).cursor).toBeUndefined();
  await input(element.querySelectorAll("input")[7], "2026-11-18T09:00");
  await input(element.querySelectorAll("input")[8], "2026-11-17T09:00");
  await tick();
  expect(element.textContent).not.toContain("old");
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () =>
    root.render(
      <SearchPage api={api} identityKey="s:another" onOpen={() => {}} />,
    ),
  );
  expect(element.textContent).not.toContain("old");
  expect(element.querySelectorAll("input")[10].value).toBe("");
});
test("fixed snapshot reads exact historical metadata and clears old identity/version content before late responses", async () => {
  const m = await import(/* @vite-ignore */ String("./DocumentSnapshot")).catch(
    () => ({ DocumentSnapshot: undefined }),
  );
  expect(m.DocumentSnapshot, "fixed version reader").toBeDefined();
  const calls: string[] = [];
  let finish: any;
  const api = {
    get: async (path: string) => {
      calls.push(path);
      if (path.includes("/2")) return new Promise((r) => (finish = r));
      return {
        pageId: "p",
        number: 1,
        currentTitle: "現在の秘密タイトル",
        content: "# 過去本文",
        at: "2026-01-01T00:00:00Z",
        metadata: { known: false, snapshot: null, hash: null },
        anchors: { anchors: [] },
        attribution: {
          author: "reader",
          producer: { kind: "unknown" },
          proposedBy: null,
          publishedBy: null,
        },
      };
    },
  } as unknown as OperationalApi;
  const { element, root } = await mount(m.DocumentSnapshot, {
    api,
    identityKey: "s:p",
    pageId: "p",
    version: 1,
  });
  expect(calls[0]).toBe("/versions/pages/p/1?visit=1");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(calls[1]).toBe("/versions/pages/p/1");
  expect(element.textContent).toContain("과거 제목 기록 없음");
  expect(element.textContent).not.toContain("現在の秘密タイトル");
  expect(element.textContent).toContain("過去本文");
  await act(async () =>
    root.render(
      <m.DocumentSnapshot api={api} identityKey="s:p" pageId="p" version={2} />,
    ),
  );
  expect(element.textContent).not.toContain("過去本文");
  await act(async () =>
    root.render(
      <m.DocumentSnapshot
        api={
          {
            get: async () => {
              throw Error("현재 접근할 수 없습니다");
            },
          } as unknown as OperationalApi
        }
        identityKey="other:p"
        pageId="p"
        version={3}
      />,
    ),
  );
  await act(async () =>
    finish({
      pageId: "p",
      number: 2,
      content: "폐기할 늦은 내용",
      currentTitle: "late",
      metadata: { known: false, snapshot: null, hash: null },
    }),
  );
  expect(element.textContent).not.toContain("폐기할 늦은 내용");
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
});
test("detail refresh recovers only removed focused results and never reclaims outside focus", async () => {
  const { SearchPage } = await import("./SearchPage");
  vi.useFakeTimers();
  let empty = false;
  const api = {
    post: async () =>
      empty
        ? { items: [], nextCursor: null, asof: "2026-11-01T00:00:00Z" }
        : result("visible"),
  } as unknown as OperationalApi;
  const { element } = await mount(SearchPage, {
    api,
    identityKey: "s:p",
    onOpen: () => {},
  });
  await tick();
  element.querySelector<HTMLButtonElement>(".search-results button")!.focus();
  empty = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(element.contains(document.activeElement)).toBe(true);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(document.activeElement).toBe(outside);
});
test("historical search mode distinguishes latest, older and unknown versions without claiming recommendation", async () => {
  const { SearchDescription } = await import("./SearchResults");
  const { element, root } = await mount(SearchDescription, {
    item: {
      ...item("latest"),
      historical: true,
      currentRecommendation: false,
      isCurrentVersion: true,
    },
    query: "",
  });
  expect(element.textContent).toContain("현재 버전");
  expect(element.textContent).not.toContain("과거 버전");
  await act(async () =>
    root.render(
      <SearchDescription
        item={
          {
            ...item("old"),
            historical: true,
            currentRecommendation: false,
            isCurrentVersion: false,
          } as any
        }
        query=""
      />,
    ),
  );
  expect(element.textContent).toContain("과거 버전");
  await act(async () =>
    root.render(
      <SearchDescription
        item={{
          ...item("legacy"),
          historical: true,
          currentRecommendation: false,
        }}
        query=""
      />,
    ),
  );
  expect(element.textContent).toContain("현재 여부 알 수 없음");
});
test("keyboard active result scrolls into view without moving the combobox focus", async () => {
  const { QuickOpen } = await load();
  vi.useFakeTimers();
  const api = {
    post: async () => result("visible"),
  } as unknown as OperationalApi;
  const { element } = await mount(QuickOpen, {
    api,
    onOpen: () => {},
    onClose: () => {},
  });
  const q = element.querySelector("input")!;
  await input(q, "코드_retry");
  await tick();
  const option = element.querySelector<HTMLElement>('[role="option"]')!;
  const scroll = vi.fn();
  option.scrollIntoView = scroll;
  await act(async () =>
    q.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  expect(document.activeElement).toBe(q);
});
test("date filters convert explicit local calendar values to ISO and preserve existing ISO without normalizing invalid dates", async () => {
  const m = (await import("./search-client")) as any;
  expect(m.searchDateToIso).toBeDefined();
  vi.stubEnv("TZ", "Asia/Seoul");
  expect(m.searchDateToIso("2026-11-17T09:30")).toBe(
    "2026-11-17T00:30:00.000Z",
  );
  expect(m.searchDateToLocal("2026-11-17T00:30:00.000Z")).toBe(
    "2026-11-17T09:30",
  );
  expect(m.searchDateToIso("2026-11-17T00:30:00.000Z")).toBe(
    "2026-11-17T00:30:00.000Z",
  );
  expect(m.searchDateToIso("")).toBeUndefined();
  expect(() => m.searchDateToIso("2026-02-30T12:00")).toThrow();
  expect(() =>
    m.normalizeSearchFilters({
      periodFrom: m.searchDateToIso("2026-11-18T09:00"),
      periodTo: m.searchDateToIso("2026-11-17T09:00"),
    }),
  ).toThrow();
  vi.unstubAllEnvs();
});
test.each(["api", "account", "space", "version"])(
  "fixed snapshot isolates a late response after only %s changes",
  async (kind) => {
    const { DocumentSnapshot } = await import("./DocumentSnapshot");
    let finish: any,
      calls = 0;
    const old = {
      get: async () =>
        ++calls === 1
          ? new Promise((r) => (finish = r))
          : {
              pageId: "p",
              number: kind === "version" ? 2 : 1,
              content: "new authorized",
              at: "2026-01-01T00:00:00Z",
              metadata: { known: false, snapshot: null },
            },
    } as unknown as OperationalApi;
    const fresh = {
      get: async () => ({
        pageId: "p",
        number: 1,
        content: "new authorized",
        at: "2026-01-01T00:00:00Z",
        metadata: { known: false, snapshot: null },
      }),
    } as unknown as OperationalApi;
    const { element, root } = await mount(DocumentSnapshot, {
      api: old,
      identityKey: "s:p",
      pageId: "p",
      version: 1,
    });
    await act(async () =>
      root.render(
        <DocumentSnapshot
          api={kind === "api" ? fresh : old}
          identityKey={
            kind === "account"
              ? "s:other"
              : kind === "space"
                ? "other:p"
                : "s:p"
          }
          pageId="p"
          version={kind === "version" ? 2 : 1}
        />,
      ),
    );
    expect(element.textContent).toContain("new authorized");
    await act(async () =>
      finish({
        pageId: "p",
        number: 1,
        content: "old private",
        metadata: { known: false, snapshot: null },
      }),
    );
    expect(element.textContent).toContain("new authorized");
    expect(element.textContent).not.toContain("old private");
  },
);
test("global search identity replacement closes synchronously and never steals departed focus", async () => {
  const { GlobalSearch } = await import("./QuickOpen");
  const api = {
    post: async () => result("private"),
  } as unknown as OperationalApi;
  const props = {
    api,
    identityKey: "s:p",
    onOpen: () => true,
    onSearch: () => true,
  };
  const { element, root } = await mount(GlobalSearch, props);
  await act(async () => element.querySelector("button")!.click());
  expect(element.querySelector('[role="dialog"]')).not.toBeNull();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  await act(async () =>
    root.render(<GlobalSearch {...props} identityKey="s:new" />),
  );
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(outside);
});
test("explicit cursor reset discards a cursor carried by reusable filters", async () => {
  const { searchDocuments } = await import("./search-client");
  let body: any;
  const api = {
    post: async (_path: string, input: any) => {
      body = input;
      return result("reset");
    },
  } as unknown as OperationalApi;
  await searchDocuments(
    api,
    { query: "code", cursor: "obsolete" },
    { cursor: null },
  );
  expect(body.cursor).toBeNull();
});
test.each([
  "bare-editable",
  "plaintext-editable",
  "alertdialog",
  "native-dialog",
])("global shortcut preserves %s input ownership", async (kind) => {
  const { GlobalSearch } = await import("./QuickOpen");
  const { element } = await mount(GlobalSearch, {
    api: {} as OperationalApi,
    identityKey: "s:p",
    onOpen: () => true,
    onSearch: () => true,
  });
  const owner = document.createElement(
    kind === "native-dialog" ? "dialog" : "div",
  );
  if (kind === "bare-editable") owner.setAttribute("contenteditable", "");
  else if (kind === "plaintext-editable")
    owner.setAttribute("contenteditable", "plaintext-only");
  else if (kind === "alertdialog") owner.setAttribute("role", "alertdialog");
  else owner.setAttribute("open", "");
  const child = document.createElement("button");
  owner.append(child);
  document.body.append(owner);
  child.focus();
  await act(async () =>
    child.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(child);
});
