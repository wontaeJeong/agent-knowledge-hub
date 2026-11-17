// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  buildDocumentOutline,
  findDocumentMatches,
  type BlockReference,
} from "./document-reader";
import { DocumentReader } from "./DocumentReader";
import { segmentAnchors } from "../../../server/workflows/versions/diff";
import { convenienceHref, parseConvenienceLocation } from "./route";
import { resumeWorkspaceLink } from "../api";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const content =
  '# 설치\n\n첫 한글 문단\n\n## 설치\n\n```ts\nconst 한글 = "<script>bad()</script>";\n```\n\n| 값 |\n| --- |\n| 한글 |\n\n<script>alert(1)</script>\n';
const blocks = () =>
  segmentAnchors("doc", 2, content).anchors as BlockReference[];
const mount = async (
  text = content,
  refs = blocks(),
  targetAnchor?: string,
) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <DocumentReader
        document={{ id: "doc", spaceId: "space", content: text }}
        version={2}
        blocks={refs}
        targetAnchor={targetAnchor}
      />,
    ),
  );
  return { host, root };
};
const click = async (host: HTMLElement, label: string) =>
  act(async () => {
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === label)!
      .click();
  });
test("outline separates Korean headings and excludes fenced or raw HTML headings", () => {
  const result = buildDocumentOutline(
    content + "\n<div><h2>숨김</h2></div>",
    blocks(),
  );
  expect(result.map((x) => x.title)).toEqual(["설치", "설치"]);
  expect(new Set(result.map((x) => x.id)).size).toBe(2);
  expect(result.every((x) => x.blockId)).toBe(true);
});
test("search uses rendered safe text including Korean code/table with a bounded result count", () => {
  expect(findDocumentMatches(content, "한글")).toHaveLength(3);
  expect(findDocumentMatches(content, "alert")).toHaveLength(0);
  expect(findDocumentMatches("한글 ".repeat(2000), "한글")).toHaveLength(1000);
});
test("reader preserves sanitizer, navigates previous/next with keyboard and offers denied code-copy fallback", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockRejectedValue(Error("denied")) },
  });
  const { host, root } = await mount();
  expect(host.querySelector("script")).toBeNull();
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "한글");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll("mark")).toHaveLength(3);
  await click(host, "다음 일치");
  expect(document.activeElement?.closest("code")).not.toBeNull();
  await click(host, "이전 일치");
  expect(document.activeElement?.closest("p")).not.toBeNull();
  await click(host, "코드 복사");
  expect(host.querySelector("textarea")?.value).toContain("const 한글");
  expect(host.textContent).toContain("복사하지 못했습니다");
  await act(async () => root.unmount());
});
test("stable anchors jump exactly; removed or ambiguous anchors never jump to another paragraph", async () => {
  const refs = blocks();
  const stable = refs.find((b) => b.startLine === 3)!;
  const { host, root } = await mount(content, refs, stable.id);
  expect(document.activeElement?.textContent).toContain("첫 한글 문단");
  await act(async () =>
    root.render(
      <DocumentReader
        document={{ id: "doc", spaceId: "space", content }}
        version={2}
        blocks={refs}
        targetAnchor="a-missing"
      />,
    ),
  );
  expect(host.textContent).toContain("위치가 변경되었거나 사라졌습니다");
  await act(async () => root.unmount());
  const duplicate = "같음\n\n같음";
  const repeated = segmentAnchors("doc", 3, duplicate).anchors;
  const mounted = await mount(duplicate, repeated, repeated[0].id);
  expect(mounted.host.textContent).toContain(
    "위치가 변경되었거나 사라졌습니다",
  );
  expect(mounted.host.querySelectorAll("[data-block-share]")).toHaveLength(0);
  await act(async () => mounted.root.unmount());
});
test("latest and pinned paragraph links round trip through login without tab/comment hash collision", () => {
  for (const version of [undefined, 2]) {
    const href = convenienceHref({
      kind: "document",
      spaceId: "space",
      document: "doc",
      anchor: "a-123",
      ...(version ? { version } : {}),
    });
    expect(resumeWorkspaceLink(href)).toBe(href);
    const url = new URL(href, "https://wiki.example");
    expect(url.hash).toBe("");
    expect(parseConvenienceLocation(url.search, url.hash)).toMatchObject({
      kind: "document",
      anchor: "a-123",
      ...(version ? { version } : {}),
    });
  }
  expect(
    parseConvenienceLocation(
      "?app=1&space=space&document=doc&anchor=a-123",
      "#comment-c",
    ),
  ).toMatchObject({ kind: "invalid" });
});

test("latest reader rejects removed anchors and clears revoked permissions before a late response can restore content", async () => {
  const { DocumentSnapshot } = await import("./DocumentSnapshot");
  const { ApiError } = await import("../api");
  const snap = {
    pageId: "doc",
    number: 2,
    isCurrentVersion: true,
    content,
    at: "2026-11-18",
    metadata: { known: true, snapshot: { title: "읽기 검증" } },
    currentTitle: "현재 이름",
    anchors: { anchors: blocks() },
  };
  let late: ((value: unknown) => void) | undefined;
  const get = vi
    .fn()
    .mockResolvedValueOnce(snap)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    )
    .mockRejectedValueOnce(
      new ApiError("현재 접근할 수 없습니다.", 404, "NOT_FOUND"),
    );
  const api = { get } as any,
    host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <DocumentSnapshot
        api={api}
        identityKey="space:reader"
        spaceId="space"
        pageId="doc"
        targetAnchor="a-gone"
      />,
    ),
  );
  expect(get).toHaveBeenCalledWith("/versions/pages/doc/latest?visit=1");
  expect(host.textContent).toContain("현재 이름");
  expect(host.textContent).not.toContain("읽기 검증");
  expect(host.textContent).toContain("위치가 변경되었거나 사라졌습니다");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.textContent).not.toContain("첫 한글 문단");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.textContent).toContain("현재");
  await act(async () => late!(snap));
  expect(host.textContent).not.toContain("첫 한글 문단");
  await act(async () => root.unmount());
});
test("latest/fixed copy uses the selected stable block and denied Clipboard exposes selectable exact URL", async () => {
  const writeText = vi.fn().mockRejectedValue(Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { host, root } = await mount();
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-block-share]")!.click(),
  );
  await click(host, "최신 부분 링크 복사");
  const latest = host.querySelector("textarea")!.value;
  expect(latest).toContain("anchor=" + blocks()[0].id);
  expect(latest).not.toContain("version=");
  await click(host, "고정 부분 링크 복사");
  const fixed = host.querySelector("textarea")!.value;
  expect(fixed).toContain("version=2");
  expect(fixed).toContain("anchor=" + blocks()[0].id);
  expect(writeText).toHaveBeenLastCalledWith(fixed);
  expect(host.textContent).not.toContain("복사했습니다.");
  await act(async () => root.unmount());
});
