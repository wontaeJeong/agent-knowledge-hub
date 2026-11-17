// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Home } from "./Home";
import { ApiError } from "../api";
const names = [
  "recent",
  "favorites",
  "drafts",
  "requests",
  "revisions",
  "reviews",
  "failedJobs",
  "accessRequests",
];
const row = (id: string) => ({
  id,
  title: id,
  state: "saved",
  href: "/?app=1&space=s&section=compose&draft=" + id,
});
const page = (id?: string, nextCursor: string | null = null) => ({
  status: "ready",
  items: id ? [row(id)] : [],
  nextCursor,
});
const summary = () =>
  Object.fromEntries(
    names.map((k) => [k, k === "drafts" ? page("first", "page2") : page()]),
  );
let roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const r of roots) await act(async () => r.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(get: (p: string) => Promise<any>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  const props = {
    api: { get } as any,
    principalId: "p",
    spaceId: "s",
    capabilities: ["knowledge.read", "draft.write"],
  };
  await act(async () => root.render(<Home {...props} />));
  return { el, root, props };
}
const button = (el: Element, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  )!;
const widget = (el: Element) =>
  el.querySelector('[data-home-widget="drafts"]')!;
const trigger = async (kind: string) =>
  act(async () => {
    if (kind === "timer") await vi.advanceTimersByTimeAsync(30000);
    else if (kind === "focus") window.dispatchEvent(new Event("focus"));
    else document.dispatchEvent(new Event("visibilitychange"));
  });
test.each(["focus", "visibility", "timer"])(
  "unchanged current page and focused node survive automatic %s revalidation",
  async (kind) => {
    if (kind === "timer") vi.useFakeTimers();
    const calls: string[] = [];
    const { el } = await mount(async (p) => {
      calls.push(p);
      return p === "/convenience/home"
        ? summary()
        : p.includes("widget=drafts")
          ? p.includes("cursor=page2")
            ? page("second")
            : page("first", "page2")
          : page();
    });
    await act(async () => button(widget(el), "다음 25개").click());
    const link = widget(el).querySelector<HTMLAnchorElement>("a")!;
    link.focus();
    await trigger(kind);
    expect(widget(el).textContent).toContain("second");
    expect(widget(el).textContent).not.toContain("first");
    expect(widget(el).querySelector("a")).toBe(link);
    expect(document.activeElement).toBe(link);
    expect(calls.filter((p) => p === "/convenience/home")).toHaveLength(1);
    expect(calls.filter((p) => p.includes("cursor=page2"))).toHaveLength(2);
  },
);
test("automatic refresh racing Next revalidates its requested page and ignores late earlier response", async () => {
  let release: (x: any) => void = () => {};
  let count = 0;
  const { el } = await mount(async (p) =>
    p === "/convenience/home"
      ? summary()
      : p.includes("cursor=page2")
        ? ++count === 1
          ? new Promise((r) => {
              release = r;
            })
          : page("current-second")
        : page(),
  );
  await act(async () => button(widget(el), "다음 25개").click());
  await trigger("focus");
  await act(async () => release(page("late-old-second")));
  expect(widget(el).textContent).toContain("current-second");
  expect(widget(el).textContent).not.toContain("late-old");
});
test.each([409, 403, 503])(
  "automatic current-page %s clears invalid rows and requires explicit retry or restart",
  async (status) => {
    let invalid = false;
    const { el } = await mount(async (p) => {
      if (p === "/convenience/home") return summary();
      if (p.includes("widget=drafts")) {
        if (invalid && p.includes("cursor="))
          throw new ApiError(
            "current denied",
            status,
            status === 409 ? "STALE_CURSOR" : "FORBIDDEN",
          );
        return p.includes("cursor=") ? page("second") : page("first", "page2");
      }
      return page();
    });
    await act(async () => button(widget(el), "다음 25개").click());
    widget(el).querySelector<HTMLAnchorElement>("a")!.focus();
    invalid = true;
    await trigger("visibility");
    expect(widget(el).textContent).not.toContain("second");
    expect(widget(el).textContent).not.toContain("first");
    expect(widget(el).querySelector('[role="alert"]')).not.toBeNull();
    expect(document.activeElement?.hasAttribute("data-home-fallback")).toBe(
      true,
    );
    await act(async () => button(widget(el), "처음부터").click());
    expect(widget(el).textContent).toContain("first");
  },
);
test("a Next click wins over an older background first-page response", async () => {
  let release: (x: any) => void = () => {};
  const { el } = await mount(async (p) =>
    p === "/convenience/home"
      ? summary()
      : p.includes("widget=drafts")
        ? p.includes("cursor=page2")
          ? page("second")
          : new Promise((r) => {
              release = r;
            })
        : page(),
  );
  await trigger("focus");
  await act(async () => button(widget(el), "다음 25개").click());
  await act(async () => release(page("late-first", "page2")));
  expect(widget(el).textContent).toContain("second");
  expect(widget(el).textContent).not.toContain("late-first");
});
test("late current-page response cannot cross identity", async () => {
  let release: (x: any) => void = () => {};
  let hold = false;
  const { el, root, props } = await mount(async (p) =>
    p === "/convenience/home"
      ? summary()
      : p.includes("widget=drafts")
        ? hold
          ? new Promise((r) => {
              release = r;
            })
          : page("second")
        : page(),
  );
  await act(async () => button(widget(el), "다음 25개").click());
  hold = true;
  await trigger("focus");
  await act(async () =>
    root.render(
      <Home
        {...props}
        principalId="next"
        api={
          {
            get: async () => Object.fromEntries(names.map((k) => [k, page()])),
          } as any
        }
      />,
    ),
  );
  await act(async () => release(page("SECRET OLD ACTOR")));
  expect(el.textContent).not.toContain("SECRET");
  expect(widget(el).textContent).not.toContain("second");
});
test("an error DTO clears current rows without stealing outside focus", async () => {
  let invalid = false;
  const { el } = await mount(async (p) =>
    p === "/convenience/home"
      ? summary()
      : p.includes("widget=drafts")
        ? invalid
          ? { status: "error", items: [], nextCursor: null }
          : page("second")
        : page(),
  );
  await act(async () => button(widget(el), "다음 25개").click());
  widget(el).querySelector<HTMLAnchorElement>("a")!.focus();
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  invalid = true;
  await trigger("focus");
  expect(widget(el).textContent).not.toContain("second");
  expect(widget(el).querySelector('[role="alert"]')).not.toBeNull();
  expect(document.activeElement).toBe(outside);
});

test("repeated automatic checks do not starve an in-flight revalidation failure", async () => {
  vi.useFakeTimers();
  let fail: (reason: unknown) => void = () => {};
  let requests = 0;
  const { el } = await mount(async (p) =>
    p === "/convenience/home"
      ? summary()
      : p.includes("widget=drafts")
        ? (++requests,
          new Promise((_resolve, reject) => {
            fail = reject;
          }))
        : page(),
  );
  await trigger("focus");
  await trigger("timer");
  await trigger("visibility");
  expect(requests).toBe(1);
  await act(async () => fail(new ApiError("validation timed out", 503)));
  expect(widget(el).textContent).not.toContain("first");
  expect(widget(el).querySelector('[role="alert"]')).not.toBeNull();
});
