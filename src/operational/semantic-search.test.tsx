// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { QuestionsWorkbench } from "./questions";
import { OperationalApi } from "./api";
test("semantic search waits for the durable result and displays the actual provider and model with relevance proposals", async () => {
  const api = new OperationalApi();
  const post = vi
    .spyOn(api, "post")
    .mockResolvedValue({ id: "semantic-job", status: "queued" });
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/jobs-v2/semantic-job"
      ? {
          id: "semantic-job",
          status: "succeeded",
          result: {
            items: [
              {
                pageId: "topic",
                version: 1,
                title: "재시도",
                content: "지수 백오프",
                historical: false,
                currentRecommendation: true,
                metadataStatus: "known",
                href: "",
                match: {
                  quote: "지수 백오프",
                  reason: "호출 제한 뒤 재시도",
                  status: "model-relevance-proposal",
                },
              },
            ],
            nextCursor: null,
            retrieval: {
              kind: "semantic-model-selection",
              invoked: true,
              provider: "openai",
              model: "deployed-fixture",
            },
          },
        }
      : ({ items: [] } as never),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () =>
      root.render(
        <QuestionsWorkbench api={api} identityKey="fixture:editor" />,
      ),
    );
    const select = [...host.querySelectorAll("select")].find((s) =>
      s.closest("label")?.textContent?.includes("검색 방식"),
    );
    expect(select).toBeDefined();
    await act(async () => {
      select!.value = "semantic";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = [...host.querySelectorAll("input")].find((i) =>
      i.closest("label")?.textContent?.includes("본문·제목 검색"),
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "호출 제한");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(post.mock.calls[0][0]).toBe("/search/semantic");
    expect(post.mock.calls[0][1]).toMatchObject({
      filters: { query: "호출 제한" },
      idempotency_key: expect.any(String),
    });
    expect(host.textContent).toContain("deployed-fixture");
    expect(host.textContent).toContain("openai");
    expect(host.textContent).toContain("호출 제한 뒤 재시도");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
