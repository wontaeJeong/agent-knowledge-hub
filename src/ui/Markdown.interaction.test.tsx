// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, it, expect } from "vitest";
import { Markdown, type AttachmentReader, type ImagePreview } from "./Markdown";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const raster: ImagePreview = {
  render: "raster-image",
  mime: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  width: 1,
  height: 1,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const text =
  "![A](/api/v1/storage/blobs/image-a)\n\n![B](/api/v1/storage/blobs/image-b)";
let root: ReturnType<typeof createRoot> | undefined, container: HTMLDivElement;
async function mount(reader: AttachmentReader) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<Markdown text={text} readAttachment={reader} />),
  );
}
async function click(id: string) {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[data-attachment="${id}"]`)!
      .click(),
  );
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
it("does not restore an earlier image after the latest request observes a permission denial", async () => {
  const first = deferred<ImagePreview>(),
    second = deferred<ImagePreview>();
  let n = 0;
  await mount(() => (++n === 1 ? first.promise : second.promise));
  await click("image-a");
  await click("image-a");
  await act(async () => second.reject(Error("NOT_FOUND")));
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(container.textContent).toContain("현재 권한 또는 검사 상태");
  await act(async () => first.resolve(raster));
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(container.textContent).toContain("현재 권한 또는 검사 상태");
});
it("keeps the most recently selected attachment when replies arrive in reverse order", async () => {
  const a = deferred<ImagePreview>(),
    b = deferred<ImagePreview>();
  await mount((id) => (id === "image-a" ? a.promise : b.promise));
  await click("image-a");
  await click("image-b");
  await act(async () => b.resolve(raster));
  expect(container.querySelector("img")?.alt).toBe("B");
  await act(async () => a.resolve(raster));
  expect(container.querySelector("img")?.alt).toBe("B");
});
it("closing a pending image cancels its ability to display a late response", async () => {
  const request = deferred<ImagePreview>();
  await mount(() => request.promise);
  await click("image-a");
  const close = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "이미지 닫기",
  );
  expect(close).toBeDefined();
  await act(async () => close!.click());
  await act(async () => request.resolve(raster));
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(container.textContent).not.toContain("권한을 확인하고 있습니다");
});
it("ignores replies after the reader context changes or the component is unmounted", async () => {
  const old = deferred<ImagePreview>(),
    current = deferred<ImagePreview>();
  await mount(() => old.promise);
  await click("image-a");
  const reader = () => current.promise;
  await act(async () =>
    root!.render(<Markdown text={text} readAttachment={reader} />),
  );
  await act(async () => old.resolve(raster));
  expect(container.querySelectorAll("img")).toHaveLength(0);
  await click("image-b");
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => current.resolve(raster));
  expect(container.querySelectorAll("img")).toHaveLength(0);
});
