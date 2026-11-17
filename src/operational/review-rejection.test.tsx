// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ReviewRejection } from "./review-rejection";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
test("requires a reviewer reason before rejecting and sends its exact trimmed value", async () => {
  const div = document.createElement("div"),
    root = createRoot(div),
    reject = vi.fn();
  await act(async () =>
    root.render(
      <ReviewRejection disabled={false} batchId="b1" onReject={reject} />,
    ),
  );
  expect((div.querySelector("button") as HTMLButtonElement).disabled).toBe(
    true,
  );
  const input = div.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "  환경 예외 보완  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    div.querySelector("button")!.click();
  });
  expect(reject).toHaveBeenCalledWith("환경 예외 보완");
  await act(async () => root.unmount());
});
