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

async function withSemanticForm(
  api: OperationalApi,
  run: (submit: () => Promise<void>, host: HTMLDivElement) => Promise<void>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<QuestionsWorkbench api={api} identityKey="fixture:retry" />),
    );
    const select = [...host.querySelectorAll("select")].find((s) =>
      s.closest("label")?.textContent?.includes("검색 방식"),
    )!;
    await act(async () => {
      select.value = "semantic";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = host.querySelector('input[maxlength="2000"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "retry same filters");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await run(async () => {
      await act(async () => {
        input
          .closest("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await new Promise((r) => setTimeout(r, 10));
      });
    }, host);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}
const emptySemanticResult = {
  items: [],
  nextCursor: null,
  retrieval: {
    kind: "semantic-model-selection",
    invoked: true,
    provider: "fixture",
    model: "fixture-model",
  },
};
test.each(["dead", "cancelled"])(
  "observed %s semantic job allows identical filters to start a new job",
  async (status) => {
    const api = new OperationalApi();
    let admissions = 0;
    const post = vi
      .spyOn(api, "post")
      .mockImplementation(
        async () =>
          ({ id: "semantic-job-" + ++admissions, status: "queued" }) as never,
      );
    vi.spyOn(api, "get").mockImplementation(async (path) =>
      path === "/jobs-v2/semantic-job-1"
        ? { id: "semantic-job-1", status, error: "MODEL_UNAVAILABLE" }
        : path === "/jobs-v2/semantic-job-2"
          ? {
              id: "semantic-job-2",
              status: "succeeded",
              result: emptySemanticResult,
            }
          : ({ items: [] } as never),
    );
    await withSemanticForm(api, async (submit, host) => {
      await submit();
      expect(host.textContent).toContain(
        status === "cancelled" ? "취소" : "실패",
      );
      await submit();
      const one = (post.mock.calls[0][1] as { idempotency_key: string })
        .idempotency_key;
      const two = (post.mock.calls[1][1] as { idempotency_key: string })
        .idempotency_key;
      expect(two).not.toBe(one);
      expect(host.textContent).toContain("fixture-model");
    });
  },
);
test.each(["admission-network", "poll-network", "poll-timeout"])(
  "uncertain %s retains the semantic key for identical retry",
  async (failure) => {
    const api = new OperationalApi();
    let admissions = 0,
      polls = 0,
      clockNow = 1000;
    const post = vi.spyOn(api, "post").mockImplementation(async () => {
      if (failure === "admission-network" && ++admissions === 1)
        throw Error("NETWORK_INTERRUPTED");
      return { id: "semantic-job", status: "queued" } as never;
    });
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (path !== "/jobs-v2/semantic-job") return { items: [] } as never;
      if (++polls === 1) {
        if (failure === "poll-network") throw Error("NETWORK_INTERRUPTED");
        if (failure === "poll-timeout") {
          clockNow = 181001;
          return { id: "semantic-job", status: "running" } as never;
        }
      }
      return {
        id: "semantic-job",
        status: "succeeded",
        result: emptySemanticResult,
      } as never;
    });
    await withSemanticForm(api, async (submit, host) => {
      const clock =
        failure === "poll-timeout"
          ? vi.spyOn(Date, "now").mockImplementation(() => clockNow)
          : null;
      await submit();
      clock?.mockRestore();
      expect(host.textContent).toContain(
        failure === "poll-timeout"
          ? "대기 시간을 넘었습니다"
          : "NETWORK_INTERRUPTED",
      );
      await submit();
      expect(
        (post.mock.calls[1][1] as { idempotency_key: string }).idempotency_key,
      ).toBe(
        (post.mock.calls[0][1] as { idempotency_key: string }).idempotency_key,
      );
      expect(host.textContent).toContain("fixture-model");
    });
  },
);
