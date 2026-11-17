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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const item = (n: number) => ({
  id: `n${n}`,
  sequence: n + 1,
  revision: 1,
  type: "document-updated",
  createdAt: "2026-11-17T00:00:00Z",
  readAt: null,
  archivedAt: null,
  target: { kind: "document", pageId: `page${n}` },
  title: `문서 ${n}`,
  actionState: "published",
});
async function mountBell(api: OperationalApi) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const module = await import(
    /* @vite-ignore */ String("./NotificationBell")
  ).catch(() => ({ NotificationBell: undefined }));
  expect(
    module.NotificationBell,
    "global bell preview component",
  ).toBeDefined();
  const Bell = module.NotificationBell!;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <Bell
        api={api}
        spaceId="space"
        principalId="reader"
        onOpenInbox={() => {}}
        onNavigate={() => true}
      />,
    ),
  );
  return { element, root };
}
test("bell requests five safe preview targets and Escape returns focus to its trigger", async () => {
  const paths: string[] = [];
  const api = {
    get: async (path: string) => {
      paths.push(path);
      return {
        items: Array.from({ length: 5 }, (_, i) => item(i)),
        unreadCount: 8,
        nextCursor: "next",
        readBoundary: "signed",
      };
    },
  } as unknown as OperationalApi;
  const { element } = await mountBell(api);
  const trigger = element.querySelector("button")!;
  trigger.focus();
  await act(async () => trigger.click());
  expect(
    paths.some(
      (path) => new URL(path, "https://test").searchParams.get("limit") === "5",
    ),
  ).toBe(true);
  expect(element.querySelectorAll('a[href*="document="]')).toHaveLength(5);
  expect(element.textContent).toContain("8");
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(trigger);
  expect(element.querySelector('[role="dialog"]')).toBeNull();
});
test("thirty second refresh preserves the focused preview link and stops while hidden", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const api = {
    get: async () => {
      calls++;
      return {
        items: [item(1)],
        unreadCount: 1,
        nextCursor: null,
        readBoundary: "signed",
      };
    },
  } as unknown as OperationalApi;
  const { element } = await mountBell(api);
  await act(async () => element.querySelector("button")!.click());
  const link = element.querySelector("a")!;
  link.focus();
  const before = calls;
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(calls).toBeGreaterThan(before);
  expect(document.activeElement).toBe(link);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const hidden = calls;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(calls).toBe(hidden);
});
test("full inbox sends server filters and does not treat read state as business completion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const module = await import(
    /* @vite-ignore */ String("./NotificationInbox")
  ).catch(() => ({ NotificationInbox: undefined }));
  expect(module.NotificationInbox, "full filtered inbox").toBeDefined();
  const Inbox = module.NotificationInbox!;
  const paths: string[] = [];
  const api = {
    get: async (path: string) => {
      paths.push(path);
      return {
        items: [item(0)],
        unreadCount: 1,
        nextCursor: null,
        readBoundary: "signed",
      };
    },
    post: async () => ({
      ...item(0),
      readAt: "2026-11-17T01:00:00Z",
      revision: 2,
    }),
  } as unknown as OperationalApi;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <Inbox
        api={api}
        spaceId="space"
        principalId="reader"
        onNavigate={() => true}
      />,
    ),
  );
  const filter = element.querySelector(
    'select[aria-label="알림 상태"]',
  ) as HTMLSelectElement;
  expect(filter).not.toBeNull();
  await act(async () => {
    filter.value = "archived";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(paths.at(-1)).toContain("state=archived");
  expect(element.textContent).not.toContain("검토 완료");
});
test("exact rejected review renders outcome without approval actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { ReviewSelection } = await import("./ReviewSelection");
  const api = {
    get: async (path: string) =>
      path === "/changesets/b1"
        ? {
            id: "b1",
            status: "rejected",
            readOnly: true,
            reviewFeedback: { reason: "수정 필요" },
          }
        : { items: [] },
  } as unknown as OperationalApi;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <ReviewSelection api={api} initialTargetId="b1" items={[]}>
        {() => <button>승인</button>}
      </ReviewSelection>,
    ),
  );
  expect(element.textContent).toContain("수정 필요");
  expect(element.textContent).not.toContain("승인");
});
test.each([{capabilities:["knowledge.read"]},{capabilities:["knowledge.read","space.admin"]}])("exact own access decision opens without requesting administrative lists $capabilities", async ({capabilities}) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { GovernanceWorkbench } = await import("../governance");
  const paths: string[] = [];
  const api = async (path: string) => {
    paths.push(path);
    if (path === "/api/v1/governance/access-requests/r1")
      return { id: "r1", status: "rejected", revision: 2, readOnly: true };
    throw Error("FORBIDDEN");
  };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <GovernanceWorkbench
        api={api as any}
        capabilities={capabilities}
        initialAccessRequestId="r1"
        onChanged={() => {}}
        onExpired={() => {}}
      />,
    ),
  );
  expect(element.textContent).toContain("반려");
  expect(paths).toEqual(["/api/v1/governance/access-requests/r1"]);
});
test("late refresh cannot restore titles after a newer tab invalidation loses access", async () => {
  let release!: (value: unknown) => void;
  let calls = 0;
  const api = {
    get: async () => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      throw Error("접근할 수 없습니다.");
    },
  } as unknown as OperationalApi;
  const { element } = await mountBell(api);
  await act(async () => element.querySelector("button")!.click());
  await act(async () => window.dispatchEvent(new Event("akh:inbox-changed")));
  await act(async () =>
    release({
      items: [{ ...item(1), title: "철회된 제목" }],
      unreadCount: 1,
      nextCursor: null,
      readBoundary: "old",
    }),
  );
  expect(element.textContent).not.toContain("철회된 제목");
  expect(element.textContent).toContain("접근할 수 없습니다.");
});
test("the integrated preferences panel can retain settings without a duplicate inbox",async()=>{
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const {NotificationPanel}=await import("../notifications");const Panel=NotificationPanel as any;
 const api={get:async(path:string)=>path==="/collaboration/preferences"?{revision:1,mentions:true,subscriptions:true,dailyDigest:false,weeklyDigest:false,timezone:"UTC",dailyAt:"09:00",weeklyAt:"09:00",weeklyDay:1,quietHours:{enabled:false,start:"22:00",end:"07:00"}}:path.startsWith("/collaboration/notifications")?{items:[{pageId:"topic",title:"중복 목록 제목",events:[{id:"n",read:false}]}]}:{items:[],topics:[]}} as unknown as OperationalApi;
 const element=document.createElement("div");document.body.append(element);const root=createRoot(element);roots.push(root);await act(async()=>root.render(<Panel api={api} capabilities={["knowledge.read"]} spaceId="space" showInbox={false}/>));expect(element.textContent).toContain("알림 설정");expect(element.textContent).not.toContain("중복 목록 제목");
});
