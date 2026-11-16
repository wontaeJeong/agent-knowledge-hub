// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { NotificationPanel } from "./notifications";
import { ApiError, type OperationalApi } from "./api";
test("a failed refresh clears previously visible private titles and links", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let denied = false;
  const api = {
    get: async (path: string) => {
      if (denied) throw new ApiError("접근 불가", 403, "FORBIDDEN");
      if (path === "/collaboration/preferences")
        return {
          revision: 0,
          mentions: true,
          subscriptions: true,
          dailyDigest: false,
          weeklyDigest: false,
          timezone: "UTC",
          dailyAt: "09:00",
          weeklyAt: "09:00",
          weeklyDay: 1,
          quietHours: { enabled: false, start: "22:00", end: "07:00" },
        };
      if (path.startsWith("/collaboration/notifications"))
        return {
          items: [
            {
              pageId: "secret",
              title: "비공개 제목",
              events: [{ id: "n", read: false }],
            },
          ],
        };
      if (path.startsWith("/collaboration/review-due"))
        return {
          items: [
            {
              id: "work",
              pageId: "review-page",
              title: "검토할 문서",
              revision: 1,
              status: "needs-review",
              dueAt: null,
              reason: "OWNER_CURRENT",
              assignedId: "reviewer",
            },
          ],
        };
      return { items: [] };
    },
    post: async () => ({}),
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <NotificationPanel
        api={api}
        capabilities={["knowledge.read"]}
        spaceId="space"
      />,
    ),
  );
  expect(el.textContent).toContain("비공개 제목");
  expect(
    el.querySelector('a[href="/?app=1&space=space&document=review-page"]'),
  ).not.toBeNull();
  denied = true;
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "현재 상태 새로고침",
  )!;
  await act(async () => button.click());
  expect(el.textContent).not.toContain("비공개 제목");
  expect(el.querySelector('a[href*="secret"]')).toBeNull();
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
test("older successful refresh cannot restore titles after a newer permission failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const api = {
    get: async (path: string) => {
      const call = ++calls;
      if (call <= 4) await pending;
      else throw new ApiError("접근 불가", 403, "FORBIDDEN");
      if (path === "/collaboration/preferences")
        return {
          revision: 0,
          mentions: true,
          subscriptions: true,
          dailyDigest: false,
          weeklyDigest: false,
          timezone: "UTC",
          dailyAt: "09:00",
          weeklyAt: "09:00",
          weeklyDay: 1,
          quietHours: { enabled: false, start: "22:00", end: "07:00" },
        };
      if (path.startsWith("/collaboration/notifications"))
        return {
          items: [
            {
              pageId: "secret",
              title: "이전 비공개 제목",
              events: [{ id: "n", read: false }],
            },
          ],
        };
      return { items: [] };
    },
    post: async () => ({}),
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <NotificationPanel
        api={api}
        capabilities={["knowledge.read"]}
        spaceId="space"
      />,
    ),
  );
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "현재 상태 새로고침",
  )!;
  await act(async () => button.click());
  expect(el.textContent).toContain("접근 불가");
  await act(async () => {
    release();
    await pending;
  });
  expect(el.textContent).not.toContain("이전 비공개 제목");
  expect(el.querySelector('a[href*="secret"]')).toBeNull();
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
test("an older failed refresh cannot clear newer authorized results", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const api = {
    get: async (path: string) => {
      const call = ++calls;
      if (call <= 4) {
        await pending;
        throw new ApiError("오래된 오류", 403, "FORBIDDEN");
      }
      if (path === "/collaboration/preferences")
        return {
          revision: 0,
          mentions: true,
          subscriptions: true,
          dailyDigest: false,
          weeklyDigest: false,
          timezone: "UTC",
          dailyAt: "09:00",
          weeklyAt: "09:00",
          weeklyDay: 1,
          quietHours: { enabled: false, start: "22:00", end: "07:00" },
        };
      if (path.startsWith("/collaboration/notifications"))
        return {
          items: [
            {
              pageId: "current",
              title: "현재 허용 제목",
              events: [{ id: "n", read: false }],
            },
          ],
        };
      return { items: [] };
    },
    post: async () => ({}),
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <NotificationPanel
        api={api}
        capabilities={["knowledge.read"]}
        spaceId="space"
      />,
    ),
  );
  const button = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "현재 상태 새로고침",
  )!;
  await act(async () => button.click());
  expect(el.textContent).toContain("현재 허용 제목");
  await act(async () => {
    release();
    await pending;
  });
  expect(el.textContent).toContain("현재 허용 제목");
  expect(el.textContent).not.toContain("오래된 오류");
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
test("scope subscriptions and processing use authenticated API routes and show event meaning", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const posts: { path: string; body: unknown }[] = [];
  const api = {
    get: async (path: string) => {
      if (path === "/collaboration/preferences")
        return {
          revision: 0,
          mentions: true,
          subscriptions: true,
          dailyDigest: false,
          weeklyDigest: false,
          timezone: "UTC",
          dailyAt: "09:00",
          weeklyAt: "09:00",
          weeklyDay: 1,
          quietHours: { enabled: false, start: "22:00", end: "07:00" },
        };
      if (path === "/collaboration/subscriptions")
        return {
          items: [{ scope: "space", target: "" }],
          topics: ["기술 설계"],
        };
      if (path.startsWith("/collaboration/notifications"))
        return {
          items: [
            {
              pageId: "job:synthetic",
              title: "작업 실패",
              url: "/?app=1&space=space#jobs",
              events: [
                {
                  id: "job-event",
                  read: false,
                  kind: "job-failure",
                  processed: false,
                },
              ],
            },
          ],
        };
      return { items: [] };
    },
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
      <NotificationPanel
        api={api}
        capabilities={["knowledge.read"]}
        spaceId="space"
      />,
    ),
  );
  expect(el.textContent).toContain("주제·공간 구독");
  const unsubscribe = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "공간 구독 해제",
  )!;
  await act(async () => unsubscribe.click());
  expect(posts).toContainEqual({
    path: "/collaboration/subscriptions",
    body: { scope: "space", enabled: false },
  });
  expect(el.querySelector('a[href="/?app=1&space=space#jobs"]')).not.toBeNull();
  const process = [...el.querySelectorAll("button")].find(
    (b) => b.textContent === "처리 완료 표시",
  )!;
  await act(async () => process.click());
  expect(posts).toContainEqual({
    path: "/collaboration/notifications/job-event/process",
    body: {},
  });
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});
