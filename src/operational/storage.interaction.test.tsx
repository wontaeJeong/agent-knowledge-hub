// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { it, expect, vi } from "vitest";
import { StoragePanel } from "./storage";
import { OperationalApi } from "./api";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps a newly uploaded image available for preview without resetting the document workflow", async () => {
  const api = new OperationalApi();
  vi.spyOn(api, "post").mockResolvedValue({
    items: [
      {
        id: "image",
        filename: "ui-upload.png",
        mime: "image/png",
        size: 50,
        scan_state: "clean",
        slot_id: "slot",
        file_revision: 1,
        head_revision: 1,
        head_id: "image",
        is_head: true,
      },
    ],
    total: 1,
  });
  function Host() {
    const [key, setKey] = useState(0);
    return (
      <StoragePanel
        key={key}
        api={api}
        parent={{ kind: "page", id: "topic" }}
        canCreate
        transport={async () => new Response("{}", { status: 201 })}
        onChanged={async () => setKey((v) => v + 1)}
      />
    );
  }
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => root.render(<Host />));
    const input =
      container.querySelector<HTMLInputElement>("input[type=file]")!;
    Object.defineProperty(input, "files", {
      value: [new File(["pixels"], "ui-upload.png", { type: "image/png" })],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("ui-upload.png");
    expect(
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent === "이미지 미리보기" && !b.disabled,
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});
