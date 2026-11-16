// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { JobsPanel } from "./jobs";
import { OperationalApi } from "./api";
const initial = {
  status: "ready",
  engine: "postgresql-gin-trigram",
  observedAt: "2026-11-16T10:00:00Z",
  indexBytes: "8192",
  freshness: {
    mode: "transaction-synchronous",
    lastContentMutationObservedAt: "2026-11-16T09:00:00Z",
    workspaceRevision: "3",
    lagSeconds: null,
  },
  lastSuccess: { at: "2026-11-16T08:00:00Z", kind: "migration" },
  lastAttemptAt: null,
  lastFailure: null,
  progress: [],
};
async function mount(
  api: OperationalApi,
  work: (click: () => Promise<void>, host: HTMLDivElement) => Promise<void>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <JobsPanel
          api={api}
          capabilities={["jobs.manage", "jobs.global", "space.admin"]}
        />,
      ),
    );
    const button = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("검색 색인 재구축"),
    );
    expect(button).toBeDefined();
    await work(async () => {
      await act(async () => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
test("operator panel loads real index status and waits for durable rebuild before refreshing its last success", async () => {
  const api = new OperationalApi();
  let finished = false;
  const post = vi
    .spyOn(api, "post")
    .mockResolvedValue({ id: "index-job", status: "queued" });
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/search/index"
      ? {
          ...initial,
          lastSuccess: finished
            ? { at: "2026-11-16T11:00:00Z", kind: "rebuild" }
            : initial.lastSuccess,
        }
      : path === "/jobs-v2/index-job"
        ? ((finished = true),
          { id: "index-job", status: "succeeded", result: { rebuilt: true } })
        : ({ items: [] } as never),
  );
  await mount(api, async (click, host) => {
    expect(host.textContent).toContain("검색 색인");
    expect(host.textContent).toContain("정상");
    await click();
    expect(post.mock.calls[0][0]).toBe("/search/index/rebuild");
    expect(post.mock.calls[0][1]).toEqual({
      idempotency_key: expect.any(String),
    });
    expect(host.textContent).toContain("재구축이 완료");
    expect(host.textContent).toContain("2026-11-16T11:00:00Z");
  });
});
test.each(["terminal", "uncertain"])(
  "%s rebuild retry respects confirmed versus unknown job outcome",
  async (outcome) => {
    const api = new OperationalApi();
    let attempts = 0;
    const post = vi.spyOn(api, "post").mockImplementation(async () => {
      if (++attempts === 1 && outcome === "uncertain")
        throw Error("NETWORK_INTERRUPTED");
      return { id: "index-job-" + attempts, status: "queued" } as never;
    });
    vi.spyOn(api, "get").mockImplementation(async (path) =>
      path === "/search/index"
        ? initial
        : path === "/jobs-v2/index-job-1"
          ? {
              id: "index-job-1",
              status: "dead",
              error: "SEARCH_INDEX_LOCK_TIMEOUT",
            }
          : path === "/jobs-v2/index-job-2"
            ? {
                id: "index-job-2",
                status: "succeeded",
                result: { rebuilt: true },
              }
            : ({ items: [] } as never),
    );
    await mount(api, async (click) => {
      await click();
      await click();
      const keys = post.mock.calls.map(
        (c) => (c[1] as { idempotency_key: string }).idempotency_key,
      );
      if (outcome === "terminal") expect(keys[1]).not.toBe(keys[0]);
      else expect(keys[1]).toBe(keys[0]);
    });
  },
);
