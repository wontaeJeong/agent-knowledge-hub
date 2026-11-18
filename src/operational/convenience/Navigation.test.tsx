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
  vi.restoreAllMocks();
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
  preview = false,
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
  await act(async () => root!.render(<OperationalApp preview={preview} />));
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
test("saved views opens the private list and offers examples only on selection", async () => {
  const container = await mount("/?app=1&space=team&section=saved-views", () => ({
    items: [],
  }));
  expect(container.textContent).toContain("저장한 보기가 없습니다");
  expect(container.textContent).toContain("예시 보기");
  expect(
    container.querySelector('a[aria-current="page"]')?.textContent,
  ).toContain("저장 보기");
});
test.each(["favorites", "recent", "subscriptions"])("personal %s destination renders its current authorized server list", async section => {
  const paths: string[] = [];
  const container = await mount(`/?app=1&space=team&section=${section}`, path => {
    paths.push(path);
    return path.startsWith(`/workflows/${section}?`) ? {items:[{id:"library-one",title:"현재 문서",version:1,at:null}],nextCursor:null,revision:0} : {items:[]};
  });
  expect(paths).toContain(`/workflows/${section}?limit=25`);
  expect(container.querySelector('a[href="/?app=1&space=team&document=library-one"]')?.textContent).toBe("현재 문서");
  expect(container.textContent).not.toContain("아직 연결되지 않았습니다");
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

test("existing boards and refinement remain discoverable with their read capability", () => {
  expect(
    navigation
      .navigationItems({ ...person, capabilities: ["knowledge.read"] })
      .map((item) => item.id),
  ).toEqual(expect.arrayContaining(["boards", "refinement"]));
  expect(
    navigation
      .navigationItems({ ...person, capabilities: ["draft.write"] })
      .map((item) => item.id),
  ).not.toEqual(expect.arrayContaining(["boards", "refinement"]));
});

test("Back and Forward bind colliding task IDs to the restored API space and fence a pending previous response", async () => {
  window.history.replaceState(
    null,
    "",
    "/?app=1&space=one&section=tasks&targetKind=job&targetId=collision",
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("confirm", () => true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let releaseOld!: (response: Response) => void;
  let pendingOld = true;
  const oldResponse = new Promise<Response>((resolve) => {
    releaseOld = resolve;
  });
  const exactSpaces: string[] = [];
  const job = (space: string) => ({
    id: "collision",
    kind: space === "one" ? "첫 공간 작업" : "둘째 공간 작업",
    status: "succeeded",
    attempts: 1,
    maxAttempts: 3,
    error: null,
    checkpoint: {},
    result: {},
    heartbeatAt: null,
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = String(url).split("/api/v1")[1];
    const space = new Headers(init.headers).get("X-Space-Id")!;
    if (path === "/jobs-v2/collision") {
      exactSpaces.push(space);
      if (space === "two" && pendingOld) {
        pendingOld = false;
        return oldResponse;
      }
      return new Response(JSON.stringify(job(space)));
    }
    const data =
      path === "/me"
        ? { ...person, workspaceId: space }
        : path === "/spaces"
          ? {
              items: ["one", "two"].map((id) => ({
                id,
                namespaceSlug: "team",
                slug: id,
                role: "read",
              })),
            }
          : path === "/model"
            ? { configured: false, model: null }
            : { items: [], nextOffset: null };
    return new Response(JSON.stringify(data));
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<OperationalApp />));
  expect(container.textContent).toContain("첫 공간 작업");
  const favorites = container.querySelector(
    'a[href="/?app=1&space=one&section=favorites"]',
  ) as HTMLAnchorElement;
  await act(async () => favorites.click());
  const selector = () =>
    Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.options).some((option) => option.value === "two"),
    )!;
  await act(async () => {
    selector().value = "two";
    selector().dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Restore a valid exact target in the current entry, as an app deep-link update does.
  await act(async () => {
    window.history.replaceState(
      null,
      "",
      "/?app=1&space=two&section=tasks&targetKind=job&targetId=collision",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(exactSpaces).toEqual(["one", "two"]);
  const traverse = async (direction: "back" | "forward") => {
    await act(async () => {
      const traversed = new Promise<void>((resolve) =>
        window.addEventListener("popstate", () => resolve(), { once: true }),
      );
      window.history[direction]();
      await traversed;
    });
  };
  window.addEventListener(
    "akh:before-navigate",
    (event) => event.preventDefault(),
    { once: true },
  );
  await traverse("back");
  expect(window.location.search).toContain("space=two");
  expect(selector().value).toBe("two");
  expect(exactSpaces).toEqual(["one", "two"]);
  await traverse("back");
  expect(window.location.search).toContain("space=one");
  expect(selector().value).toBe("one");
  expect(container.textContent).toContain("첫 공간 작업");
  expect(exactSpaces).toEqual(["one", "two", "one"]);
  await act(async () => releaseOld(new Response(JSON.stringify(job("two")))));
  expect(container.textContent).toContain("첫 공간 작업");
  expect(container.textContent).not.toContain("둘째 공간 작업");
  await traverse("forward");
  expect(window.location.search).toContain("space=two");
  expect(selector().value).toBe("two");
  expect(container.textContent).toContain("둘째 공간 작업");
  expect(container.textContent).not.toContain("첫 공간 작업");
  expect(exactSpaces).toEqual(["one", "two", "one", "two"]);
});

test.each([
  ["reader", ["knowledge.read"], false],
  ["writer", ["knowledge.read", "draft.write", "changeset.propose"], false],
  [
    "maintain",
    ["knowledge.read", "changeset.approve", "knowledge.protect"],
    true,
  ],
] as const)(
  "%s keeps personal credentials/device tools and only qualified review evaluation",
  (_, caps, evaluate) => {
    const items = navigation.navigationItems({
      ...person,
      capabilities: [...caps],
    });
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["agents", "integrations"]),
    );
    expect(items.some((item) => item.id === "evaluation")).toBe(evaluate);
    expect(items.some((item) => item.id === "access")).toBe(false);
    expect(
      items
        .filter((item) => item.id === "agents" || item.id === "integrations")
        .every((item) => item.group !== "관리·운영"),
    ).toBe(true);
  },
);

test("a share URL produced by AccessPanel survives unauthenticated login return and opens only the authorized snapshot", async () => {
  const effective = {
    role: "admin",
    paths: [],
    grants: [],
    space: {
      id: "team",
      namespaceId: "ns",
      namespaceKind: "team",
      namespaceSlug: "example",
      slug: "team",
      visibility: "team",
      policyVersion: 1,
      owner: false,
    },
  };
  let container = await mount("/?app=1&space=team#access", (path) =>
    path === "/spaces/team/access"
      ? effective
      : path === "/access"
        ? new Response(JSON.stringify({ code: "FORBIDDEN" }), { status: 403 })
        : path === "/shares"
        ? {
            items: [
              {
                id: "share-real",
                pageId: "page-real",
                version: 2,
                principalId: "person",
                expiresAt: "2027-01-01T00:00:00Z",
                revoked: false,
              },
            ],
          }
        : { items: [] },
  );
  const produced = Array.from(container.querySelectorAll("a"))
    .find((link) => link.textContent === "공유 고유 링크")!
    .getAttribute("href")!;
  expect(produced).toBe("/?app=1&space=team#share-share-real");
  await act(async () => root!.unmount());
  root = undefined;
  container = await mount(produced, () => ({ items: [] }), false);
  const login = container.querySelector(
    'a[href="/auth/login"]',
  ) as HTMLAnchorElement;
  login.addEventListener("click", (event) => event.preventDefault(), {
    once: true,
  });
  await act(async () => login.click());
  expect(sessionStorage.getItem("akh-login-return")).toBe(produced);
  await act(async () => root!.unmount());
  root = undefined;
  let reads = 0;
  container = await mount("/?app=1", (path) => {
    if (path === "/shares/share-real") {
      reads++;
      return { id: "page-real", version: 2, content: "현재 인가된 공유 내용" };
    }
    return { items: [] };
  });
  expect(window.location.hash).toBe("#share-share-real");
  expect(reads).toBeGreaterThan(0);
  expect(container.textContent).toContain("page-real · 고정 v2");
  expect(container.textContent).toContain("현재 인가된 공유 내용");
  expect(container.textContent).not.toContain("이동 주소가 올바르지 않습니다");
});

test("preview menu URL and cancelled history restoration remain preview when reopened", async () => {
  window.history.replaceState(null, "", "/?preview=1#overview");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
    setTimeout(() => fn(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<OperationalApp preview />));
  const knowledge = container.querySelector(
    'a[href="#knowledge"]',
  ) as HTMLAnchorElement;
  await act(async () => knowledge.click());
  const { entryMode } = await import("../../entry");
  expect(entryMode(window.location.search)).toBe("preview");
  expect(window.location.hash).toBe("#knowledge");
  expect(window.location.search).not.toContain("app=1");
  window.addEventListener(
    "akh:before-navigate",
    (event) => event.preventDefault(),
    { once: true },
  );
  await act(async () => {
    const traversed = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.back();
    await traversed;
  });
  expect(entryMode(window.location.search)).toBe("preview");
  expect(window.location.hash).toBe("#knowledge");
  await act(async () => root!.unmount());
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <OperationalApp
        preview={entryMode(window.location.search) === "preview"}
      />,
    ),
  );
  expect(container.textContent).toContain("목업 미리보기");
  expect(container.textContent).not.toContain("SSO 로그인");
});

test.each([403, 404])(
  "a denied or withdrawn standalone share reports the existing authorized lookup error (%s)",
  async (status) => {
    const container = await mount(
      "/?app=1&space=team#share-unavailable",
      (path) =>
        path === "/shares/unavailable"
          ? new Response(
              JSON.stringify({
                code: status === 403 ? "FORBIDDEN" : "NOT_FOUND",
              }),
              { status },
            )
          : { items: [] },
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      status === 403 ? "FORBIDDEN" : "NOT_FOUND",
    );
    expect(container.textContent).not.toContain("고정 v");
    expect(container.textContent).not.toContain(
      "이동 주소가 올바르지 않습니다",
    );
  },
);
test("a current review qualification denial hides evaluation even with approval capability", () => {
  expect(
    navigation
      .navigationItems({
        ...person,
        capabilities: ["knowledge.read", "changeset.approve"],
        canReviewKnowledge: false,
      })
      .some((item) => item.id === "evaluation"),
  ).toBe(false);
});
test("global search route replaces its pending screen and opens keyboard quick search",async()=>{
 const paths:string[]=[];
 const container=await mount("/?app=1&space=team&section=search",path=>{paths.push(path);return {items:[],nextCursor:null,asof:"2026-11-01T00:00:00Z"};});
 expect(container.querySelector('[aria-label="전역 키워드 검색"]')).not.toBeNull();
 expect(container.textContent).not.toContain("이 화면은 아직 연결되지 않았습니다");
 const trigger=Array.from(container.querySelectorAll("button")).find(b=>b.getAttribute("aria-haspopup")==="dialog" && b.textContent?.includes("검색"));
 expect(trigger).toBeDefined();await act(async()=>trigger!.click());
 expect(container.querySelector('[role="combobox"]')).not.toBeNull();
 expect(paths).not.toContain("/questions/threads");
});

async function writeSearchInput(control:HTMLInputElement,value:string){
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(control,value);control.dispatchEvent(new Event("input",{bubbles:true}));});
}
test.each(["fresh","already-mounted"])("quick search continues the private term in %s detail without URL/storage",async(mode)=>{
 vi.spyOn(window,"scrollTo").mockImplementation(()=>{});
 const container=await mount(`/?app=1&space=team&section=${mode==="fresh"?"saved-views":"search"}`,()=>({items:[],nextCursor:null,revision:0,asof:"2026-11-17T00:00:00Z"}));
 if(mode!=="fresh"){
  await writeSearchInput(container.querySelector<HTMLInputElement>('.search-page input')!,"old query");
  await writeSearchInput(container.querySelectorAll<HTMLInputElement>('.search-page input')[3],"old");
 }
 await act(async()=>container.querySelector<HTMLButtonElement>('.global-search > button')!.click());
 await writeSearchInput(container.querySelector<HTMLInputElement>('.quick-open input')!,"private code");
 await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('.quick-open button')).find(b=>b.textContent==="상세 검색")!.click());
 expect(container.querySelector<HTMLInputElement>('.search-page input')?.value).toBe("private code");
 expect(container.querySelectorAll<HTMLInputElement>('.search-page input')[3].value).toBe("");
 expect(container.querySelector('.quick-open')).toBeNull();expect(location.search).not.toContain("private");expect(JSON.stringify({...localStorage,...sessionStorage})).not.toContain("private code");
});
test("cancelled detail navigation keeps the prior detail query and does not hand off the quick term",async()=>{
 const container=await mount('/?app=1&space=team&section=search',()=>({items:[],nextCursor:null,revision:0,asof:"2026-11-17T00:00:00Z"}));
 await writeSearchInput(container.querySelector<HTMLInputElement>('.search-page input')!,"prior query");
 await act(async()=>container.querySelector<HTMLButtonElement>('.global-search > button')!.click());await writeSearchInput(container.querySelector<HTMLInputElement>('.quick-open input')!,"private code");
 const cancel=(event:Event)=>event.preventDefault();window.addEventListener("akh:before-navigate",cancel);
 try{await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('.quick-open button')).find(b=>b.textContent==="상세 검색")!.click());expect(container.querySelector('.quick-open')).not.toBeNull();expect(container.querySelector<HTMLInputElement>('.search-page input')?.value).toBe("prior query");}finally{window.removeEventListener("akh:before-navigate",cancel);}
});

test("default personal landing does not depend on legacy administration bootstrap and operations overview remains explicit", async()=>{
 const calls:string[]=[];const h=Object.fromEntries(["recent","favorites","drafts","requests","revisions","reviews","failedJobs","accessRequests"].map(k=>[k,{status:"ready",items:[],nextCursor:null}]));
 const container=await mount("/?app=1&space=team",path=>{calls.push(path);if(path==="/convenience/home")return h;if(path==="/spaces")return {items:[]};throw Error("unrelated aggregate must not load");});
 expect(container.querySelector("h1")?.textContent).toBe("홈");expect(container.textContent).toContain("내 초안");expect(calls).not.toContain("/pages");expect(calls).not.toContain("/members");expect(container.textContent).not.toContain("서버 정본 ·");
 const overview=Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(a=>a.textContent==="운영 개요");expect(overview?.href).toContain("#overview");
});

test("actual space selection preserves the implicit personal Home rather than drifting to operations",async()=>{
 vi.spyOn(window,"confirm").mockReturnValue(true);
 const h=Object.fromEntries(["recent","favorites","drafts","requests","revisions","reviews","failedJobs","accessRequests"].map(k=>[k,{status:"ready",items:[],nextCursor:null}]));
 const container=await mount("/?app=1&space=team",path=>{
  if(path==="/convenience/home")return h;
  if(path==="/spaces")return {items:[{id:"team",namespaceSlug:"org",slug:"first",role:"write"},{id:"other",namespaceSlug:"org",slug:"second",role:"write"}]};
  if(path.startsWith("/usage"))return new Response(JSON.stringify({code:"UNAVAILABLE"}),{status:503});
  return {items:[]};
 },true,()=>({...person,workspaceId:new URLSearchParams(window.location.search).get("space")??"team"}));
 expect(container.querySelector("h1")?.textContent).toBe("홈");
 const space=container.querySelector<HTMLSelectElement>(".op-context select")!;expect(space).not.toBeNull();
 await act(async()=>{space.value="other";space.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(new URLSearchParams(window.location.search).get("space")).toBe("other");expect(window.location.hash).not.toBe("#home");expect(container.querySelector("h1")?.textContent).toBe("홈");expect(container.querySelector('[data-home-widget="drafts"]')).not.toBeNull();expect(container.querySelector(".console-overview")).toBeNull();
});
test("bare preview renders its supported Overview body without calling authenticated Home",async()=>{
 const container=await mount("/?preview=1",()=>{throw Error("preview must not call native API");},true,()=>person,true);
 expect(container.querySelector("h1")?.textContent).toBe("운영 개요");expect(container.querySelector(".console-overview")).not.toBeNull();expect(container.querySelector('[data-home-widget]')).toBeNull();
});
