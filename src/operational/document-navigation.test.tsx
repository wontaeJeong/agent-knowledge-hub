// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import {
  DocumentBody,
  LinkCompletion,
  PersonalDocuments,
  RelatedDocuments,
} from "./document-navigation";
import { OperationalApi } from "./api";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const input = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
test("outline jumps to distinct repeated headings and find navigates code and table matches", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <DocumentBody
        content={
          "# 설치\n## 설치\n```\nneedle code\n```\n\n| 값 |\n| --- |\n| needle table |"
        }
      />,
    ),
  );
  const headings = node.querySelectorAll("h1,h2");
  expect(headings).toHaveLength(2);
  expect(headings[0].id).not.toBe(headings[1].id);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await act(async () => {
    (node.querySelector("nav button") as HTMLButtonElement).click();
  });
  expect(focus.mock.instances.at(-1)).toBe(headings[0]);
  await input(node.querySelector("input")!, "needle");
  expect(node.querySelectorAll("mark")).toHaveLength(2);
  await act(async () => {
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent === "다음 일치")!
      .click();
  });
  expect(
    node.querySelector('mark[aria-current="true"]')?.closest("td"),
  ).not.toBeNull();
  await input(node.querySelector("input")!, "absent");
  expect(node.textContent).toContain("일치 0건");
  expect(node.querySelectorAll("mark")).toHaveLength(0);
  await act(async () => root.unmount());
});
test("personal lists and lazy neighborhood open authorized document links without whole graph", async () => {
  vi.spyOn(OperationalApi.prototype, "get").mockImplementation(async (path) =>
    path.endsWith("/navigation")
      ? {
          pageId: "topic",
          version: 1,
          links: [],
          backlinks: [{ id: "back", title: "역참조", version: 1 }],
          related: [],
          truncated: { links: false, backlinks: false, related: false },
        }
      : { items: [{ id: "topic", title: "즐겨 문서", version: 1 }] },
  );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <>
        <PersonalDocuments
          api={new OperationalApi()}
          spaceId="space"
          refreshKey="topic"
          onError={() => {}}
        />
        <RelatedDocuments
          api={new OperationalApi()}
          spaceId="space"
          pageId="topic"
          version={1}
          onError={() => {}}
        />
      </>,
    ),
  );
  expect(node.querySelector("a")?.getAttribute("href")).toBe(
    "/?app=1&space=space&document=topic",
  );
  expect(node.textContent).not.toContain("역참조");
  await act(async () => {
    const details = node.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(
    node.querySelector('a[href="/?app=1&space=space&document=back"]')
      ?.textContent,
  ).toContain("역참조");
  await act(async () => root.unmount());
});
test("link completion inserts escaped markdown only after server search and clears results on failure", async () => {
  vi.spyOn(OperationalApi.prototype, "post")
    .mockResolvedValueOnce({
      items: [{ id: "target", title: "대상 [문서]", version: 1 }],
    })
    .mockResolvedValueOnce({
      items: [{ id: "target", title: "대상 [문서]", version: 2 }],
    })
    .mockRejectedValueOnce(Error("NOT_FOUND"));
  const insert = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <LinkCompletion
        api={new OperationalApi()}
        spaceId="space"
        onInsert={insert}
        onError={() => {}}
      />,
    ),
  );
  await input(node.querySelector("input")!, "대상");
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("대상"))!
      .click();
  });
  expect(insert).toHaveBeenCalledWith(
    "[대상 \\[문서\\]](/?app=1&space=space&document=target)",
    { id: "target", version: 2 },
  );
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(node.textContent).not.toContain("대상 [문서]");
  await act(async () => root.unmount());
});

test("link insertion revalidates a displayed candidate and refuses a revoked target", async () => {
  vi.spyOn(OperationalApi.prototype, "post")
    .mockResolvedValueOnce({
      items: [{ id: "secret", title: "철회 전 제목", version: 1 }],
    })
    .mockResolvedValueOnce({ items: [] });
  const insert = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onError = vi.fn();
  await act(async () =>
    root.render(
      <LinkCompletion
        api={new OperationalApi()}
        spaceId="space"
        onInsert={insert}
        onError={onError}
      />,
    ),
  );
  await input(node.querySelector("input")!, "철회");
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("철회 전 제목"))!
      .click();
  });
  expect(insert).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain("철회 전 제목");
  expect(onError).toHaveBeenCalled();
  await act(async () => root.unmount());
});
test("personal lists clear titles when current-ACL refresh fails", async () => {
  let revoked = false;
  vi.spyOn(OperationalApi.prototype, "get").mockImplementation(async () => {
    if (revoked) throw Error("NOT_FOUND");
    return { items: [{ id: "secret", title: "목록의 이전 제목", version: 1 }] };
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const onError = vi.fn();
  await act(async () =>
    root.render(
      <PersonalDocuments
        api={new OperationalApi()}
        spaceId="space"
        refreshKey="topic"
        onError={onError}
      />,
    ),
  );
  expect(node.textContent).toContain("목록의 이전 제목");
  revoked = true;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(node.textContent).not.toContain("목록의 이전 제목");
  expect(onError).toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("typing a document title completes current authorized links without submitting", async () => {
  vi.spyOn(OperationalApi.prototype, "post").mockResolvedValue({
    items: [{ id: "target", title: "자동 완성 문서", version: 1 }],
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <LinkCompletion
        api={new OperationalApi()}
        spaceId="space"
        onInsert={() => {}}
        onError={() => {}}
      />,
    ),
  );
  await input(node.querySelector("input")!, "자동");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(node.textContent).toContain("자동 완성 문서");
  await act(async () => root.unmount());
});
