// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentSnapshot } from "./DocumentSnapshot";
import { DocumentReader } from "./DocumentReader";
import { segmentAnchors } from "../../../server/workflows/versions/diff";
import { parseConvenienceLocation } from "./route";
import { ApiError } from "../api";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount(el: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(el));
  return host;
}
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
const text = "# Head\n\nFirst Korean\n\nLast Korean";
const snapshot = {
  pageId: "doc",
  number: 2,
  isCurrentVersion: true,
  content: text,
  at: "2026-11-18",
  metadata: { known: true, snapshot: { title: "Title" } },
  anchors: { anchors: segmentAnchors("doc", 2, text, [], true).anchors },
};
for (const version of [undefined, 2])
  test(`${version ?? "latest"} periodic read hides protected DOM then restores same-version query, match, selection and focus without replaying anchor`, async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    const api = {
      get: vi.fn().mockImplementation((path: string) =>
        path.endsWith("?visit=1")
          ? Promise.resolve(snapshot)
          : new Promise((r) => {
              finish = r;
            }),
      ),
    } as any;
    const host = await mount(
      <StrictMode>
        <DocumentSnapshot
          api={api}
          identityKey="space:reader"
          spaceId="space"
          pageId="doc"
          version={version}
          targetAnchor={snapshot.anchors.anchors[1].id}
        />
      </StrictMode>,
    );
    const input = host.querySelector("input")!;
    await fill(input, "Korean");
    await click(host, "다음 일치");
    expect(host.textContent).toContain("2 / 2");
    input.focus();
    input.setSelectionRange(1, 4);
    await act(async () => vi.advanceTimersByTime(60000));
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).not.toContain("First Korean");
    await act(async () => finish(structuredClone(snapshot)));
    const restored = host.querySelector("input")!;
    expect(restored.value).toBe("Korean");
    expect(host.querySelectorAll("mark")).toHaveLength(2);
    expect(host.textContent).toContain("2 / 2");
    expect(document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([1, 4]);
    await click(host, "현재 위치로 이동");
    expect(document.activeElement?.parentElement?.textContent).toContain(
      "Last Korean",
    );
    await act(async () => vi.advanceTimersByTime(60000));
    await act(async () => finish(structuredClone(snapshot)));
    expect(document.activeElement?.getAttribute("data-match")).toBe("1");
  });
for (const boundary of ["denial", "identity", "space", "version"] as const)
  test(`${boundary} discards retained reading state and pending copy fallback`, async () => {
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const api = {
      get: vi
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockImplementation(
          () =>
            new Promise((a, b) => {
              resolve = a;
              reject = b;
            }),
        ),
    } as any;
    const props = {
      api,
      identityKey: "space:reader",
      spaceId: "space",
      pageId: "doc",
    };
    const host = await mount(<DocumentSnapshot {...props} />);
    await fill(host.querySelector("input")!, "Korean");
    await act(async () => window.dispatchEvent(new Event("focus")));
    if (boundary === "denial") {
      await act(async () => reject(new ApiError("revoked", 404, "NOT_FOUND")));
      expect(host.textContent).not.toContain("First Korean");
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => resolve(snapshot));
    } else if (boundary === "identity" || boundary === "space") {
      const old = resolve;
      await act(async () =>
        root.render(
          <DocumentSnapshot
            {...props}
            {...(boundary === "identity"
              ? { identityKey: "space:other" }
              : { spaceId: "other" })}
          />,
        ),
      );
      await act(async () => old(snapshot));
      expect(host.querySelector("input")).toBeNull();
      await act(async () => resolve(snapshot));
    } else await act(async () => resolve({ ...snapshot, number: 3 }));
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.querySelector("textarea")).toBeNull();
  });
for (const text of [
  "before $$x$$\nafter",
  "$$x$$\nOriginal paragraph",
  "$$x$$\n$$y$$\nAfter",
])
  test(`ambiguous math boundary never offers a misleading share: ${JSON.stringify(text)}`, async () => {
    const refs = segmentAnchors("doc", 2, text, [], true).anchors;
    const host = await mount(
      <DocumentReader
        document={{ id: "doc", spaceId: "space", content: text }}
        version={2}
        blocks={refs}
        targetAnchor={refs[0].id}
      />,
    );
    expect(host.querySelectorAll("[data-block-share]")).toHaveLength(0);
    expect(host.textContent).toContain("부분 링크를 제공하지");
    expect(host.textContent).toContain("위치가 변경되었거나 사라졌습니다");
    expect(document.activeElement?.hasAttribute("data-block-id")).not.toBe(
      true,
    );
  });
for (const fixed of [false, true])
  test(`separate math blocks copy and reopen their exact ${fixed ? "fixed" : "latest"} location`, async () => {
    const text = "before\n\n$$x$$\n\nafter",
      refs = segmentAnchors("doc", 2, text, [], true).anchors;
    let copied = "";
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async (v: string) => {
          copied = v;
        },
      },
    });
    const props = {
      document: { id: "doc", spaceId: "space", content: text },
      version: 2,
      blocks: refs,
    };
    const host = await mount(<DocumentReader {...props} />);
    const shares =
      host.querySelectorAll<HTMLButtonElement>("[data-block-share]");
    expect(shares).toHaveLength(3);
    await act(async () => shares[1].click());
    await click(host, fixed ? "고정 부분 링크 복사" : "최신 부분 링크 복사");
    const url = new URL(copied),
      route = parseConvenienceLocation(url.search, url.hash);
    expect(route.kind).toBe("document");
    if (route.kind !== "document") throw Error("route");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(<DocumentReader {...props} targetAnchor={route.anchor} />),
    );
    expect(document.activeElement?.querySelector("math")).not.toBeNull();
    expect(
      host.querySelectorAll(`[data-block-id="${route.anchor}"]`),
    ).toHaveLength(1);
  });

test("legacy coarse ranges refuse guessed sub-block links without altering stored references", async () => {
  const content = "# Heading\nParagraph",
    refs = segmentAnchors("doc", 1, content).anchors,
    original = JSON.stringify(refs);
  const host = await mount(
    <DocumentReader
      document={{ id: "doc", spaceId: "space", content }}
      version={1}
      blocks={refs}
      targetAnchor={refs[0].id}
    />,
  );
  expect(host.querySelectorAll("[data-block-share]")).toHaveLength(0);
  expect(host.textContent).toContain("부분 링크를 제공하지");
  expect(host.textContent).toContain("위치가 변경되었거나 사라졌습니다");
  expect(JSON.stringify(refs)).toBe(original);
});
test("same-version read retains selected block, drops protected copy fallback and respects new outside focus", async () => {
  let finish!: (v: unknown) => void;
  const api = {
    get: vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockImplementation(
        () =>
          new Promise((r) => {
            finish = r;
          }),
      ),
  } as any;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async () => {
        throw Error("denied");
      },
    },
  });
  const host = await mount(
    <DocumentSnapshot
      api={api}
      identityKey="space:reader"
      pageId="doc"
      spaceId="space"
    />,
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-block-share]")!.click(),
  );
  await click(host, "고정 부분 링크 복사");
  expect(host.querySelector("textarea")).not.toBeNull();
  await fill(host.querySelector("input")!, "Korean");
  host.querySelector("input")!.focus();
  await act(async () => window.dispatchEvent(new Event("focus")));
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(outside);
  outside.focus();
  await act(async () => finish(snapshot));
  expect(host.querySelector("input")!.value).toBe("Korean");
  expect(host.querySelector('[aria-label="선택한 부분 링크"]')).not.toBeNull();
  expect(host.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(outside);
});

test("StrictMode effect replay keeps the initial anchor focused and never redirects routine revalidation", async () => {
  const anchor = snapshot.anchors.anchors[1].id;
  const host = await mount(
    <StrictMode>
      <DocumentReader
        document={{ id: "doc", spaceId: "space", content: text }}
        version={2}
        blocks={snapshot.anchors.anchors}
        targetAnchor={anchor}
      />
    </StrictMode>,
  );
  expect(document.activeElement?.getAttribute("data-block-id")).toBe(anchor);
  expect(host.textContent).not.toContain("위치가 변경되었거나 사라졌습니다");
});

test("explicit repeated TOC navigation remains independent of an already visited initial anchor", async () => {
  const content = "# Same\n\nFirst\n\n# Same\n\nLast",
    blocks = segmentAnchors("doc", 2, content, [], true).anchors;
  const host = await mount(
    <DocumentReader
      document={{ id: "doc", spaceId: "space", content }}
      version={2}
      blocks={blocks}
      targetAnchor={blocks[1].id}
    />,
  );
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    'nav[aria-label="문서 목차"] button',
  );
  await act(async () => buttons[1].click());
  expect(document.activeElement?.tagName).toBe("H1");
  const second = document.activeElement;
  await act(async () => buttons[0].click());
  expect(document.activeElement?.tagName).toBe("H1");
  expect(document.activeElement).not.toBe(second);
});
