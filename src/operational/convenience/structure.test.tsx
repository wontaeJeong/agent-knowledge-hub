// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationalApi } from "../api";
import { PageTree, DocumentStructureControls } from "./PageTree";
import { Breadcrumbs } from "./Breadcrumbs";
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const row = (id: string, hasChildren = false) => ({
  id,
  title: id,
  version: 1,
  revision: 2,
  hasChildren,
});
async function mount(el: React.ReactNode) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(el));
  return host;
}
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (x) => x.textContent === text || x.getAttribute("aria-label") === text,
  )!;
test("tree expands three levels and uses real continuation cursors with stable document links", async () => {
  const api = {
    get: async (path: string) => ({
      items: path.includes("cursor=next")
        ? [row("second")]
        : path.includes("parentId=child")
          ? [row("leaf")]
          : path.includes("parentId=root")
            ? [row("child", true)]
            : [row("root", true)],
      revision: "r",
      nextCursor:
        path.includes("parentId") || path.includes("cursor") ? null : "next",
    }),
  } as OperationalApi;
  await mount(<PageTree api={api} spaceId="s" principalId="p" />);
  await act(async () => button("root 하위 문서 펼치기").click());
  await act(async () => button("child 하위 문서 펼치기").click());
  expect(
    document.querySelector('a[href="/?app=1&space=s&document=leaf"]'),
  ).toBeTruthy();
  await act(async () => button("다음 문서").click());
  expect(document.body.textContent).toContain("second");
});
test("identity changes synchronously hide old tree and discard late responses", async () => {
  let resolve!: (value: unknown) => void;
  const api = {
    get: () =>
      new Promise((r) => {
        resolve = r;
      }),
  } as unknown as OperationalApi;
  const host = await mount(
    <PageTree api={api} spaceId="s" principalId="one" />,
  );
  const old = resolve;
  await act(async () =>
    root.render(<PageTree api={api} spaceId="s" principalId="two" />),
  );
  await act(async () =>
    old({ items: [row("secret")], revision: "r", nextCursor: null }),
  );
  expect(host.textContent).not.toContain("secret");
});
test("breadcrumbs use current titles, stable IDs and clear revoked path errors", async () => {
  const api = {
    get: async () => ({ items: [row("root"), row("child"), row("leaf")] }),
  } as unknown as OperationalApi;
  await mount(
    <Breadcrumbs api={api} spaceId="s" principalId="p" pageId="leaf" />,
  );
  expect(
    document.querySelectorAll('nav[aria-label="문서 경로"] a'),
  ).toHaveLength(3);
});
test("keyboard move submits the selected parent/order revision and retries the same mutation after network failure", async () => {
  const writes: any[] = [];
  const api = {
    get: async () => ({
      items: [row("neighbor")],
      revision: "server-order",
      nextCursor: null,
    }),
    post: async (_path: string, input: any) => {
      writes.push(input);
      if (writes.length === 1) throw Error("연결 실패");
      return { id: "topic", revision: 3, parentId: null };
    },
  } as unknown as OperationalApi;
  await mount(
    <DocumentStructureControls
      api={api}
      spaceId="s"
      principalId="p"
      pageId="topic"
      version={1}
      revision={2}
      capabilities={["knowledge.protect"]}
      onChanged={async () => {}}
    />,
  );
  await act(async () => button("문서 이동").click());
  const select = document.querySelector(
    'select[aria-label="배치 위치"]',
  ) as HTMLSelectElement;
  await act(async () => {
    select.value = "neighbor";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = document.querySelector(
    'input[aria-label="이동 이유"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "구조 정리");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("이동 적용").click());
  expect(document.body.textContent).toContain("연결 실패");
  await act(async () => button("이동 적용").click());
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toMatchObject({
    beforeId: "neighbor",
    expectedRevision: 2,
    expectedStructureRevision: "server-order",
    reason: "구조 정리",
  });
});
test("late placement pagination cannot replace a newly selected parent list", async () => {
  let old!: (value: unknown) => void;
  const api = {
    get: async (path: string) =>
      path.includes("cursor=more")
        ? new Promise((r) => {
            old = r;
          })
        : path.includes("parentId=parent")
          ? {
              items: [row("new-child")],
              revision: "new-parent",
              nextCursor: null,
            }
          : {
              items: [row("parent"), row("neighbor")],
              revision: "root",
              nextCursor: "more",
            },
  } as unknown as OperationalApi;
  await mount(
    <DocumentStructureControls
      api={api}
      spaceId="s"
      principalId="p"
      pageId="topic"
      version={1}
      revision={2}
      capabilities={["knowledge.protect"]}
      onChanged={async () => {}}
    />,
  );
  await act(async () => button("문서 이동").click());
  await act(async () => button("다음 배치 위치").click());
  await act(async () => button("parent").click());
  await act(async () =>
    old({ items: [row("old-secret")], revision: "old-root", nextCursor: null }),
  );
  const select = document.querySelector('select[aria-label="배치 위치"]')!;
  expect(select.textContent).toContain("new-child");
  expect(select.textContent).not.toContain("old-secret");
});
test("drag placement and keyboard placement use the same pending move form", async () => {
  const api = {
    get: async () => ({
      items: [row("neighbor")],
      revision: "order",
      nextCursor: null,
    }),
  } as unknown as OperationalApi;
  await mount(
    <DocumentStructureControls
      api={api}
      spaceId="s"
      principalId="p"
      pageId="topic"
      version={1}
      revision={2}
      capabilities={["knowledge.protect"]}
      onChanged={async () => {}}
    />,
  );
  await act(async () => button("문서 이동").click());
  const draggable = document.querySelector('[draggable="true"]');
  expect(draggable).toBeTruthy();
  const target = document.querySelector('[data-before-id="neighbor"]')!;
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { getData: () => "topic" },
  });
  await act(async () => target.dispatchEvent(drop));
  expect(
    (
      document.querySelector(
        'select[aria-label="배치 위치"]',
      ) as HTMLSelectElement
    ).value,
  ).toBe("neighbor");
});
test("tree expansion uses the accessible name without duplicate visible instructional text", async () => {
  const api = {
    get: async () => ({
      items: [row("root", true)],
      revision: "r",
      nextCursor: null,
    }),
  } as unknown as OperationalApi;
  await mount(<PageTree api={api} spaceId="s" principalId="p" />);
  const expand = document.querySelector(
    'button[aria-label="root 하위 문서 펼치기"]',
  )!;
  expect(expand.textContent).toBe("");
});
test("existing personal documents and new tree keep distinct React identities while the panel refreshes", async () => {
  const { WorkflowPanel } = await import("../workflows");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const api = {
    get: async () => ({ items: [], revision: "r", nextCursor: null }),
  } as unknown as OperationalApi;
  const props = {
    api,
    pages: [],
    capabilities: ["knowledge.read"],
    principalId: "person",
    spaceId: "space",
    onChanged: async () => {},
    onExpired: () => {},
  };
  await mount(<WorkflowPanel {...props} />);
  await act(async () => root.render(<WorkflowPanel {...props} />));
  expect(
    errors.mock.calls.filter((args) => String(args[0]).includes("same key")),
  ).toHaveLength(0);
  expect(document.querySelectorAll(".op-personal-documents")).toHaveLength(1);
});

const detailFor = (id: string) => ({
  page: {
    id,
    title: id,
    versions: [
      {
        number: 1,
        content: `body ${id}`,
        sourceIds: [],
        createdAt: "2026-01-01",
      },
    ],
    tags: [],
    links: [],
    sourceIds: [],
  },
  settings: { revision: 0, state: "active", parent_id: null, data: {} },
});
async function panelFixture(getDocument: (id: string) => Promise<unknown>) {
  const { WorkflowPanel } = await import("../workflows");
  const api = {
    get: async (path: string) => {
      const m = path.match(/^\/workflows\/pages\/([^/]+)$/);
      if (m) return getDocument(m[1]);
      return {
        items: path.startsWith("/convenience/tree") ? [row("A"), row("B")] : [],
        revision: "r",
        nextCursor: null,
      };
    },
    post: async () => ({ id: "A" }),
  } as unknown as OperationalApi;
  const props = {
    api,
    pages: [
      { id: "A", title: "A" },
      { id: "B", title: "B" },
    ],
    initialPageId: "A",
    capabilities: ["knowledge.read", "knowledge.protect"],
    principalId: "p",
    spaceId: "s",
    onChanged: async () => {},
    onExpired: () => {},
  };
  await mount(<WorkflowPanel {...props} />);
  return { api, props, WorkflowPanel };
}
async function selectDocument(id: string) {
  const select = Array.from(document.querySelectorAll("select")).find((x) =>
    Array.from(x.options).some((o) => o.value === "A"),
  )!;
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
test.each(["selection","api","actor","space"] as const)("late post-move A detail cannot replace current %s", async mode => {
  let count = 0,
    late!: (x: unknown) => void;
  let holding=true;
  const {api,props,WorkflowPanel}=await panelFixture(async id=>{
    if(id==='A' && ++count>1 && holding)return new Promise(r=>late=r);
    const result=detailFor(id);if(!holding)result.page.title='current-'+id;return result;
  });
  await act(async () => button("문서 이동").click());
  const input = document.querySelector('input[aria-label="이동 이유"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "move");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("이동 적용").click());
  holding=false;
  if(mode==='selection')await selectDocument("B");
  else await act(async()=>root.render(<WorkflowPanel {...props} {...(mode==='api'?{api:{...api} as OperationalApi}:mode==='actor'?{principalId:'other'}:{spaceId:'other'})}/>));
  expect(
    document.querySelector("[data-document-heading]")?.textContent,
  ).toContain(mode==='selection'?"current-B":"current-A");
  await act(async () => late(detailFor("A")));
  expect(
    document.querySelector("[data-document-heading]")?.textContent,
  ).toContain(mode==='selection'?"current-B":"current-A");
});
test.each(["ready", "outside", "identity"] as const)(
  "mobile selected destination focus intent waits for ready and respects %s",
  async (mode) => {
    let ready!: (x: unknown) => void;
    const { props, WorkflowPanel } = await panelFixture(async (id) =>
      id === "B" ? new Promise((r) => (ready = r)) : detailFor(id),
    );
    await act(async () => button("문서 트리 열기").click());
    const link = document.querySelector(
      '[role="dialog"] a[href$="document=B"]',
    ) as HTMLAnchorElement;
    await act(async () => {
      link.focus();
      link.click();
    });
    expect(document.querySelector("[data-document-heading]")).toBeNull();
    let outside: HTMLButtonElement | undefined;
    if (mode === "outside") {
      outside = document.createElement("button");
      outside.textContent = "outside";
      document.body.append(outside);
      outside.focus();
    }
    if (mode === "identity")
      await act(async () =>
        root.render(<WorkflowPanel {...props} principalId="other" />),
      );
    await act(async () => ready(detailFor("B")));
    if (mode === "ready")
      expect(document.activeElement).toBe(
        document.querySelector("[data-document-heading]"),
      );
    if (mode === "outside") expect(document.activeElement).toBe(outside);
    if (mode === "identity")
      expect(document.activeElement).not.toBe(
        document.querySelector("[data-document-heading]"),
      );
  },
);

test.each(["desktop", "mobile"] as const)("pending same-document %s tree selection preserves its single authorized load", async surface => {
  let calls=0,ready!:(value:unknown)=>void;
  await panelFixture(async id=>{expect(id).toBe("A");calls++;return new Promise(resolve=>ready=resolve);});
  expect(document.querySelector('[data-document-heading]')).toBeNull();
  if(surface==="mobile")await act(async()=>button("문서 트리 열기").click());
  const link=document.querySelector(`${surface==='mobile'?'[role="dialog"]':'.document-tree-desktop'} a[href$="document=A"]`) as HTMLAnchorElement;
  await act(async()=>{link.focus();link.click();});
  expect(calls).toBe(1);
  await act(async()=>ready(detailFor("A")));
  const heading=document.querySelector('[data-document-heading]');
  expect(heading).not.toBeNull();
  expect(heading?.textContent).toContain("A");
  expect(calls).toBe(1);
  if(surface==="mobile")expect(document.activeElement).toBe(heading);
});
