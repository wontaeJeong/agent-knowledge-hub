// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { WorkflowPanel } from "./workflows";
import { ApiError } from "./api";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const detail = {
  page: {
    id: "topic",
    title: "Title",
    versions: [
      {
        number: 1,
        content: "Protected Korean paragraph\n\nSecond Korean",
        sourceIds: [],
      },
    ],
  },
  settings: {
    revision: 4,
    state: "active",
    parent_id: null,
    data: { effectiveUntil: "2030-01-01T00:00:00Z" },
  },
};
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(host: HTMLElement, label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === label)!
      .click(),
  );
}
async function setup(spaceId?: string, propertyPost?: () => Promise<unknown>) {
  let reads = 0,
    manual!: (v: any) => void,
    background!: (v: any) => void,
    deny!: (e: unknown) => void;
  const api = {
    get: async (path: string) => {
      if (path === "/workflows/pages/topic/properties" && propertyPost)
        return {
          metadata: {
            number: 1,
            settingsRevision: 4,
            category: "guide",
            summary: "제한 요약",
            tags: ["제한 태그"],
            properties: {},
            environment: null,
            workflowData: {},
          },
          policies: [],
          owner: null,
        };
      if (path === "/workflows/pages/topic") {
        if (++reads === 1) return detail;
        return new Promise((r) => {
          manual = r;
        });
      }
      if (path === "/workflows/pages/topic?visit=0")
        return new Promise((a, b) => {
          background = a;
          deny = b;
        });
      return { items: [], revision: "r", nextCursor: null };
    },
    post: async (path: string) =>
      path.endsWith("/properties") && propertyPost ? propertyPost() : {},
  } as any;
  const props = {
    api,
    pages: [{ id: "topic", title: "Title" }],
    capabilities: ["knowledge.read", "lifecycle.manage", "knowledge.protect"],
    onChanged: async () => {},
    onExpired: vi.fn(),
    initialPageId: "topic",
    principalId: "reader",
    spaceId,
  };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<WorkflowPanel {...props} />));
  return {
    host,
    props,
    get manual() {
      return manual;
    },
    background: (v: any) => background(v),
    deny: () => deny(new ApiError("revoked now", 404, "NOT_FOUND")),
  };
}
test.each([true, false])(
  "property write denial rechecks current document and invalidates earlier sibling reads (readable %s)",
  async (readable) => {
    let rejectWrite!: (error: Error) => void;
    const f = await setup(
      undefined,
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const region = f.host.querySelector('[aria-label="문서 속성"]')!;
    await fill(
      [...region.querySelectorAll("label")]
        .find((l) => l.textContent === "변경 이유")!
        .querySelector("input")!,
      "검토 요청",
    );
    await click(f.host, "속성 검토 요청");
    // An earlier manual document read unmounts the form while the write is still pending.
    await fill(
      f.host.querySelector(
        'input[placeholder="복원·보호·수명주기 변경 이유"]',
      )!,
      "기한",
    );
    await click(f.host, "유효기간 저장");
    const early = f.manual;
    await act(async () => rejectWrite(new ApiError("쓰기 권한 변경", 403)));
    await act(async () => early(detail));
    expect(f.host.textContent).not.toContain("Protected Korean");
    if (readable) {
      await act(async () => f.background(detail));
      expect(f.host.textContent).toContain("Protected Korean");
      expect(
        f.host.querySelector<HTMLTextAreaElement>(
          '[aria-label="문서 속성"] textarea',
        )?.value,
      ).toBe("제한 요약");
    } else {
      await act(async () => f.deny());
      expect(f.host.textContent).toContain("revoked now");
      expect(f.host.textContent).not.toContain("Protected Korean");
      expect(
        f.host.querySelector('[aria-label="문서 속성"] textarea'),
      ).toBeNull();
    }
  },
);
test.each(["principal", "space"])(
  "a delayed property write denial cannot refresh a replacement %s",
  async (boundary) => {
    let rejectWrite!: (reason: Error) => void;
    const f = await setup(
      "first",
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const form = f.host.querySelector('[aria-label="문서 속성"]')!;
    await fill(
      [...form.querySelectorAll("label")]
        .find((l) => l.textContent === "변경 이유")!
        .querySelector("input")!,
      "검토",
    );
    await click(f.host, "속성 검토 요청");
    const spy = vi.spyOn(f.props.api, "get");
    await act(async () =>
      root.render(
        <WorkflowPanel
          {...f.props}
          {...(boundary === "principal"
            ? { principalId: "other" }
            : { spaceId: "other" })}
        />,
      ),
    );
    await act(async () => f.manual(detail));
    const previous = spy.mock.calls.length;
    await act(async () => rejectWrite(new ApiError("이전 작업", 404)));
    expect(spy.mock.calls).toHaveLength(previous);
    expect(f.host.textContent).toContain("Protected Korean");
    expect(f.host.textContent).not.toContain("이전 작업");
  },
);
for (const order of ["denial-first", "manual-first"] as const)
  test(`manual expiry refresh and newer denial share one authority (${order})`, async () => {
    const f = await setup();
    await fill(
      f.host.querySelector(
        'input[placeholder="복원·보호·수명주기 변경 이유"]',
      )!,
      "Review expiry",
    );
    await click(f.host, "유효기간 저장");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(f.host.textContent).not.toContain("Protected Korean");
    if (order === "denial-first") {
      await act(async () => f.deny());
      await act(async () => f.manual(detail));
    } else {
      await act(async () => f.manual(detail));
      expect(f.host.textContent).not.toContain("Protected Korean");
      await act(async () => f.deny());
    }
    expect(f.host.textContent).toContain("revoked now");
    expect(f.host.textContent).not.toContain("Protected Korean");
  });
for (const boundary of ["principal", "space", "selection", "unmount"] as const)
  test(`pending manual read cannot cross ${boundary}`, async () => {
    const f = await setup();
    await fill(
      f.host.querySelector(
        'input[placeholder="복원·보호·수명주기 변경 이유"]',
      )!,
      "Review expiry",
    );
    await click(f.host, "유효기간 저장");
    const finish = f.manual;
    if (boundary === "unmount") await act(async () => root.unmount());
    else if (boundary === "selection")
      await act(async () => {
        const s = [...f.host.querySelectorAll("select")].find((s) =>
          s.closest("label")?.textContent?.includes("문서 선택"),
        )!;
        s.value = "";
        s.dispatchEvent(new Event("change", { bubbles: true }));
      });
    else
      await act(async () =>
        root.render(
          <WorkflowPanel
            {...f.props}
            {...(boundary === "principal"
              ? { principalId: "other" }
              : { spaceId: "other" })}
          />,
        ),
      );
    await act(async () => finish(detail));
    expect(f.host.textContent).not.toContain("Protected Korean");
  });
test("workflow background read preserves current search state after authorization without keeping protected DOM", async () => {
  const f = await setup();
  const input = [...f.host.querySelectorAll("input")].find((i) =>
    i.closest("label")?.textContent?.includes("문서 내 검색"),
  )!;
  await fill(input, "Korean");
  await click(f.host, "다음 일치");
  input.focus();
  input.setSelectionRange(2, 5);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(f.host.textContent).not.toContain("Protected Korean");
  await act(async () => f.background(structuredClone(detail)));
  const next = [...f.host.querySelectorAll("input")].find((i) =>
    i.closest("label")?.textContent?.includes("문서 내 검색"),
  )!;
  expect(next.value).toBe("Korean");
  expect(f.host.textContent).toContain("2 / 2");
  expect(document.activeElement).toBe(next);
  expect([next.selectionStart, next.selectionEnd]).toEqual([2, 5]);
});

for (const order of ["denial-first", "structure-first"] as const)
  test(`structure callback participates in the same read authority (${order})`, async () => {
    const f = await setup("space");
    await click(f.host, "문서 이동");
    await fill(
      f.host.querySelector('input[aria-label="이동 이유"]')!,
      "Move in synthetic tree",
    );
    await click(f.host, "이동 적용");
    const finish = f.manual;
    await act(async () => window.dispatchEvent(new Event("focus")));
    if (order === "denial-first") {
      await act(async () => f.deny());
      await act(async () => finish(detail));
    } else {
      await act(async () => finish(detail));
      expect(f.host.textContent).not.toContain("Protected Korean");
      await act(async () => f.deny());
    }
    expect(f.host.textContent).toContain("revoked now");
    expect(f.host.textContent).not.toContain("Protected Korean");
  });
test("focus while exact-draft admission is pending cannot cancel it or reset the admitted unsent editor on refresh", async () => {
  let admit!: (v: unknown) => void, refresh!: (v: unknown) => void;
  const pending = new Promise((r) => {
    admit = r;
  });
  const exact = {
    id: "exact",
    revision: 4,
    title: "Draft",
    pageId: "topic",
    baseVersion: 1,
    content: "Admitted draft",
  };
  const paths: string[] = [];
  const api = {
    get: async (path: string) => {
      paths.push(path);
      if (path === "/workflows/drafts") return pending;
      if (path === "/workflows/pages/topic") return detail;
      if (path === "/workflows/pages/topic?visit=0")
        return new Promise((r) => {
          refresh = r;
        });
      return { items: [], revision: "r", nextCursor: null };
    },
    post: async () => ({}),
    transport: async () =>
      new Response(
        JSON.stringify({
          error: { message: "Local copy disabled", code: "FORBIDDEN" },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
  } as any;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <WorkflowPanel
        api={api}
        principalId="reader"
        spaceId="space"
        pages={[{ id: "topic", title: "Title" }]}
        capabilities={["draft.write"]}
        initialPageId="topic"
        initialDraftId="exact"
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    ),
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(paths.filter((p) => p.endsWith("?visit=0"))).toHaveLength(0);
  await act(async () => admit({ items: [exact] }));
  const input = host.querySelector<HTMLTextAreaElement>('textarea[rows="14"]')!;
  expect(input.value).toBe("Admitted draft");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "Unsent editor text");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.querySelector('textarea[rows="14"]')).toBeNull();
  await act(async () => refresh(structuredClone(detail)));
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[rows="14"]')!.value,
  ).toBe("Unsent editor text");
  expect(host.textContent).toContain("기준 v1 · 저장 r4");
});

test("identity change never paints the previously admitted document before passive effects clear it", async () => {
  const f = await setup();
  let sawOld = false;
  function Frame({ principalId }: { principalId: string }) {
    useLayoutEffect(() => {
      if (principalId === "other")
        sawOld = f.host.textContent!.includes("Protected Korean");
    }, [principalId]);
    return <WorkflowPanel {...f.props} principalId={principalId} />;
  }
  // Install a persistent owner first, then inspect the committed DOM before child passive cleanup.
  await act(async () => root.render(<Frame principalId="reader" />));
  await act(async () => f.manual(detail));
  await act(async () => root.render(<Frame principalId="other" />));
  expect(sawOld).toBe(false);
});
