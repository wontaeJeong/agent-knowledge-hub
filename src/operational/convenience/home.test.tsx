// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
let roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const keys = [
  "recent",
  "favorites",
  "drafts",
  "requests",
  "revisions",
  "reviews",
  "failedJobs",
  "accessRequests",
];
const summary = () =>
  Object.fromEntries(
    keys.map((k) => [k, { status: "ready", items: [], nextCursor: null }]),
  );
async function mount(api: any, principalId = "editor") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const m = await import(/* @vite-ignore */ String("./Home")).catch(() => ({
    Home: undefined,
  }));
  expect(m.Home, "personal Home component").toBeDefined();
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  const props = {
    api,
    spaceId: "s",
    principalId,
    capabilities: ["knowledge.read", "draft.write", "changeset.propose"],
  };
  await act(async () => root.render(<m.Home {...props} />));
  return { el, root, Home: m.Home, props };
}
test("home distinguishes successful empty and failed widgets, retries only one and preserves exact resume", async () => {
  const h = summary();
  h.drafts = {
    status: "ready",
    items: [
      {
        id: "d26",
        title: "이어 쓸 초안",
        state: "saved",
        href: "/?app=1&space=s&section=compose&draft=d26",
      },
    ],
    nextCursor: null,
  } as any;
  h.requests = { status: "error", items: [], nextCursor: null };
  const calls: string[] = [];
  const { el } = await mount({
    get: async (p: string) => {
      calls.push(p);
      return p === "/convenience/home"
        ? h
        : { status: "ready", items: [], nextCursor: null };
    },
  });
  expect(el.querySelector('a[href*="draft=d26"]')).not.toBeNull();
  expect(
    el.querySelector('[data-home-widget="favorites"]')?.textContent,
  ).toContain("항목이 없습니다");
  expect(
    el.querySelector('[data-home-widget="requests"]')?.textContent,
  ).toContain("불러오지 못했습니다");
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>('[data-home-widget="requests"] button')!
      .click(),
  );
  expect(calls).toEqual([
    "/convenience/home",
    "/convenience/home?widget=requests",
  ]);
  expect(el.textContent).toContain("이어 쓸 초안");
  expect(el.textContent).toContain("읽음은 업무 완료를 뜻하지 않습니다");
});
test("loading and account generation never show previous personal rows or late responses", async () => {
  let release: (v: any) => void = () => {};
  const { el, root, Home, props } = await mount({
    get: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  expect(el.textContent).toContain("불러오는 중");
  await act(async () =>
    root.render(
      <Home
        {...props}
        principalId="next"
        api={{ get: async () => summary() }}
      />,
    ),
  );
  const old = summary();
  old.drafts = {
    status: "ready",
    items: [{ id: "secret", title: "SECRET", href: "/" }],
    nextCursor: null,
  } as any;
  await act(async () => release(old));
  expect(el.textContent).not.toContain("SECRET");
});

test("exact page-bound draft beyond first 25 delegates to the existing editor with original CAS/base", async () => {
  const { DocumentComposer } = await import("./DocumentComposer");
  const { OperationalApi } = await import("../api");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: any) => setTimeout(fn, 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  const api = new OperationalApi();
  const exact = {
    id: "older-exact",
    title: "정확한 기존 초안",
    revision: 7,
    pageId: "topic",
    baseVersion: 2,
    content: "ORIGINAL EXACT CONTENT",
  };
  vi.spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path === "/workflows/drafts")
      return {
        items: [
          ...Array.from({ length: 26 }, (_, i) => ({
            ...exact,
            id: `other-${i}`,
            content: "WRONG",
          })),
          exact,
        ],
      } as any;
    if (path === "/workflows/pages/topic")
      return {
        page: {
          id: "topic",
          title: "발행 문서",
          versions: [{ number: 9, content: "new published" }],
        },
        settings: { revision: 1, parent_id: null, state: "active", data: {} },
      } as any;
    if (path === "/imports/config")
      return { personal: false, reviewers: [] } as any;
    return { items: [] } as any;
  });
  vi.spyOn(api, "transport").mockResolvedValue(
    new Response(JSON.stringify({ code: "RECOVERY_NOT_ALLOWED" }), {
      status: 409,
    }),
  );
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () =>
    root.render(
      <DocumentComposer
        mode="new"
        api={api}
        pages={[{ id: "topic", title: "발행 문서" }]}
        principalId="editor"
        spaceId="s"
        capabilities={["knowledge.read", "draft.write", "changeset.propose"]}
        initialDraftId="older-exact"
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    ),
  );
  expect(
    [...el.querySelectorAll("textarea")].some(
      (t) => t.value === "ORIGINAL EXACT CONTENT",
    ),
  ).toBe(true);
  expect(el.textContent).toContain("기준 v2");
  expect(el.textContent).toContain("r7");
  expect(el.textContent).not.toContain("요청한 초안이 없거나");
});

test("current ACL refresh removes a focused row with keyboard fallback and never steals deliberate outside focus", async () => {
  const h = summary();
  h.drafts = {
    status: "ready",
    items: [
      {
        id: "sensitive",
        title: "현재 초안",
        state: "개인 저장",
        href: "/?app=1&space=s&section=compose&draft=sensitive",
      },
    ],
    nextCursor: null,
  } as any;
  let release: (v: any) => void = () => {};
  const { el } = await mount({
    get: async (path: string) =>
      path === "/convenience/home"
        ? h
        : new Promise((r) => {
            release = r;
          }),
  });
  const widget = el.querySelector<HTMLElement>('[data-home-widget="drafts"]')!;
  widget.querySelector<HTMLAnchorElement>("a")!.focus();
  await act(async () =>
    widget.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(widget.contains(document.activeElement)).toBe(true);
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  await act(async () =>
    release({ status: "ready", items: [], nextCursor: null }),
  );
  expect(document.activeElement).toBe(outside);
  expect(widget.textContent).not.toContain("현재 초안");
});
test("ordinary widget forbidden retry stays local while whole session invalidation reaches the owner", async () => {
  const { ApiError } = await import("../api");
  const h = summary();
  h.drafts = { status: "error", items: [], nextCursor: null };
  let errors = 0;
  const { el, root, Home, props } = await mount({
    get: async (path: string) => {
      if (path === "/convenience/home") return h;
      throw new ApiError("권한 철회", 403, "FORBIDDEN");
    },
  });
  await act(async () =>
    root.render(
      <Home
        {...props}
        onError={() => {
          errors++;
        }}
      />,
    ),
  );
  await act(async () =>
    el
      .querySelector<HTMLButtonElement>('[data-home-widget="drafts"] button')!
      .click(),
  );
  expect(errors).toBe(0);
  expect(
    el.querySelector('[data-home-widget="favorites"]')?.textContent,
  ).toContain("항목이 없습니다");
});

test("access approval is rendered as an access decision rather than unpublished knowledge", async () => {
  const h = summary();
  h.accessRequests = {
    status: "ready",
    items: [
      {
        id: "a",
        title: "접근 요청",
        state: "access-approved",
        href: "/?app=1&space=s&section=tasks&targetKind=access-request&targetId=a",
      },
    ],
    nextCursor: null,
  } as any;
  const { el } = await mount({ get: async () => h });
  expect(
    el.querySelector('[data-home-widget="accessRequests"]')?.textContent,
  ).toContain("접근 승인");
  expect(
    el.querySelector('[data-home-widget="accessRequests"]')?.textContent,
  ).not.toContain("발행 전");
});
