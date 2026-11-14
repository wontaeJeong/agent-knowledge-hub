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
