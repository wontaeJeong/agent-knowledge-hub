// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import OperationalApp from "../App";
import type { Identity } from "../api";
import * as navigation from "./Navigation";
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.body.innerHTML = "";
});
const person: Identity = {
  principalId: "person",
  workspaceId: "team",
  csrfToken: "csrf",
  role: "reviewer",
  capabilities: [
    "knowledge.read",
    "draft.write",
    "changeset.propose",
    "queue.triage",
    "changeset.approve",
    "jobs.read",
    "space.admin",
  ],
};
test("capabilities determine navigation without promoting a reviewer role", () => {
  const items = navigation.navigationItems({
    ...person,
    capabilities: ["knowledge.read"],
  });
  expect(items?.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "home",
      "discovery",
      "favorites",
      "recent",
      "subscriptions",
      "search",
      "tasks",
      "saved-views",
    ]),
  );
  expect(items?.map((item) => item.id)).not.toEqual(
    expect.arrayContaining(["compose"]),
  );
  expect(
    items?.some(
      (item) =>
        item.id === "policies" || item.id === "access" || item.id === "sources",
    ),
  ).toBe(false);
  expect(
    navigation.navigationItems(person).some((item) => item.id === "compose"),
  ).toBe(true);
  expect(
    navigation
      .navigationItems({ ...person, capabilities: ["draft.write"] })
      .some((item) => item.id === "compose"),
  ).toBe(true);
});
async function mount(
  href: string,
  data: (path: string) => unknown,
  authenticated = true,
  currentIdentity: () => Identity = () => person,
) {
  window.history.replaceState(null, "", href);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).split("/api/v1")[1];
    if (path === "/me" && !authenticated)
      return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
        status: 401,
      });
    const result =
      path === "/me"
        ? currentIdentity()
        : path === "/model"
          ? { configured: false, model: null }
          : path?.startsWith("/workflows/pages/") && !path.endsWith("/comments")
            ? new Response(JSON.stringify({ code: "NOT_FOUND" }), {
                status: 404,
              })
            : data(path);
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<OperationalApp />));
  return container;
}
const rows = Array.from({ length: 30 }, (_, i) => ({
  id: `review-${i}`,
  hash: `hash-${i}`,
  status: "pending",
  updates: [
    {
      id: `p${i}`,
      title: `검토 내용 ${i}`,
      content: "내용",
      sourceIds: [],
      links: [],
      baseVersion: 0,
    },
  ],
}));
test("login return selects the exact authorized review beyond the first 25 rows", async () => {
  sessionStorage.setItem(
    "akh-login-return",
    "/?app=1&space=team&section=tasks&targetKind=review&targetId=review-29",
  );
  const container = await mount("/?app=1", (path) =>
    path === "/changesets" ? { items: rows } : { items: [] },
  );
  expect(container.textContent).toContain("검토 내용 29");
  expect(container.textContent).not.toContain("검토 내용 0");
  expect(window.location.search).toContain("targetId=review-29");
});
test.each(["review", "job", "access-request"])(
  "denied or deleted %s target shows an unavailable error, not another task",
  async (kind) => {
    const container = await mount(
      `/?app=1&space=team&section=tasks&targetKind=${kind}&targetId=missing`,
      (path) => {
        if (path === "/jobs-v2/missing")
          return new Response(JSON.stringify({ code: "NOT_FOUND" }), {
            status: 404,
          });
        if (path === "/governance/workbench")
          return {
            pages: [],
            owners: [],
            proposals: [],
            policies: [],
            canManage: true,
          };
        return { items: [] };
      },
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "현재 접근할 수 없습니다",
    );
  },
);
test("job destination reads the selected job instead of relying on the first list page", async () => {
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=job&targetId=job-29",
    (path) => {
      if (path === "/jobs-v2/job-29")
        return {
          id: "job-29",
          kind: "lint",
          status: "succeeded",
          attempts: 1,
          maxAttempts: 3,
          error: null,
          checkpoint: {},
          result: {},
          heartbeatAt: null,
        };
      if (path.startsWith("/jobs-v2")) return { items: [], nextOffset: null };
      return { items: [] };
    },
  );
  expect(container.textContent).toContain("실행 근거 · job-29");
});
test("access-request destination selects the exact authorized request beyond 25 rows", async () => {
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=access-request&targetId=access-29",
    (path) => {
      if (path === "/governance/workbench")
        return {
          pages: [],
          owners: [],
          proposals: [],
          policies: [],
          canManage: true,
        };
      if (path === "/governance/access-inbox")
        return {
          items: Array.from({ length: 30 }, (_, i) => ({
            id: `access-${i}`,
            principal_id: `person-${i}`,
            resource_id: `p${i}`,
            reason: `접근 이유 ${i}`,
            revision: 1,
            version: 1,
            status: "pending",
          })),
        };
      return { items: [] };
    },
  );
  expect(container.textContent).toContain("접근 이유 29");
  expect(container.textContent).not.toContain("접근 이유 0");
});
test("a new destination cannot silently present a future feature as connected", async () => {
  const container = await mount("/?app=1&space=team&section=favorites", () => ({
    items: [],
  }));
  expect(container.textContent).toContain("아직 연결되지 않았습니다");
  expect(
    container.querySelector('a[aria-current="page"]')?.textContent,
  ).toContain("즐겨찾기");
});
test("invalid locations show an explicit error and do not select a document", async () => {
  const container = await mount(
    "/?app=1&space=team&document=page&draft=draft",
    () => ({ items: [] }),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "이동 주소",
  );
  expect(container.textContent).not.toContain("문서 고유 링크");
});

test("session expiration clears an exact protected destination", async () => {
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=job&targetId=private-job",
    (path) =>
      path === "/jobs-v2/private-job"
        ? new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
            status: 401,
          })
        : { items: [] },
  );
  expect(container.textContent).toContain("SSO 로그인");
  expect(window.location.search).not.toContain("targetId");
  expect(container.textContent).not.toContain("private-job");
});
test("an account transition clears the previous exact review selection", async () => {
  let current = person;
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=review&targetId=review-29",
    (path) => {
      if (path === "/changesets/review-29/approve") {
        current = { ...person, principalId: "other-person" };
        return {};
      }
      return path === "/changesets"
        ? { items: current.principalId === "person" ? rows : [] }
        : { items: [] };
    },
    true,
    () => current,
  );
  const approve = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "승인",
  );
  expect(approve).toBeDefined();
  await act(async () => approve!.click());
  expect(container.textContent).not.toContain("검토 내용 29");
  expect(window.location.search).not.toContain("targetId");
  expect(container.textContent).toContain("other-person");
});
test("navigation respects a cancelled unsaved-input departure event", async () => {
  const container = await mount("/?app=1&space=team#account", () => ({
    items: [],
  }));
  const cancel = (event: Event) => event.preventDefault();
  window.addEventListener("akh:before-navigate", cancel);
  try {
    const menu = container.querySelector(
      '[aria-controls="console-navigation"]',
    ) as HTMLButtonElement;
    await act(async () => menu.click());
    const link = container.querySelector(
      'a[href="/?app=1&space=team&section=favorites"]',
    ) as HTMLAnchorElement;
    await act(async () => link.click());
    expect(window.location.hash).toBe("#account");
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).not.toContain("아직 연결되지 않았습니다");
  } finally {
    window.removeEventListener("akh:before-navigate", cancel);
  }
});

test("unsaved document navigation can be cancelled and guard releases after input is saved", async () => {
  expect(navigation.NavigationProtection).toBeTypeOf("function");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const Guard = navigation.NavigationProtection;
  await act(async () => root!.render(<Guard dirty />));
  expect(
    window.dispatchEvent(
      new Event("akh:before-navigate", { cancelable: true }),
    ),
  ).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  await act(async () => root!.render(<Guard dirty={false} />));
  expect(
    window.dispatchEvent(
      new Event("akh:before-navigate", { cancelable: true }),
    ),
  ).toBe(true);
  confirm.mockRestore();
});

test("a withdrawn review cannot reopen its rejected content as an active target", async () => {
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=review&targetId=review-29",
    (path) =>
      path === "/changesets"
        ? { items: [{ ...rows[29], status: "rejected" }] }
        : { items: [] },
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "현재 접근할 수 없습니다",
  );
  expect(container.textContent).not.toContain("검토 내용 29");
});
test("refreshing an exact job removes previously visible details after permission denial", async () => {
  let denied = false;
  const container = await mount(
    "/?app=1&space=team&section=tasks&targetKind=job&targetId=job-29",
    (path) => {
      if (path === "/jobs-v2/job-29")
        return denied
          ? new Response(JSON.stringify({ code: "FORBIDDEN" }), { status: 403 })
          : {
              id: "job-29",
              kind: "lint",
              status: "succeeded",
              attempts: 1,
              maxAttempts: 3,
              error: null,
              checkpoint: {},
              result: {},
              heartbeatAt: null,
            };
      return { items: [], nextOffset: null };
    },
  );
  expect(container.textContent).toContain("실행 근거 · job-29");
  denied = true;
  const refresh = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "현재 상태 새로고침",
  );
  await act(async () => refresh!.click());
  expect(container.textContent).not.toContain("실행 근거 · job-29");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "현재 접근할 수 없습니다",
  );
});
