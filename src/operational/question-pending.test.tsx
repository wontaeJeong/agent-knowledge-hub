// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { QuestionsWorkbench } from "./questions";
import type { OperationalApi } from "./api";
test("a reopened pending turn offers resume and cancellation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [{ id: "thread", revision: 1 }], nextCursor: null }
        : {
            id: "thread",
            revision: 1,
            title: "대화",
            contextOmitted: false,
            turns: [
              {
                id: "turn",
                question: "pending",
                mode: "model",
                status: "pending",
                jobId: "job",
                answer: null,
              },
            ],
          },
    ),
    post: vi.fn(async () => ({})),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  const thread = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "대화 thread",
  )!;
  await act(async () => thread.click());
  expect(host.textContent).toContain("작업 다시 확인");
  expect(host.textContent).toContain("취소 요청");
  const cancel = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "취소 요청",
  )!;
  await act(async () => cancel.click());
  expect(api.post).toHaveBeenCalledWith("/jobs-v2/job/cancel", {});
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
test("an active question exposes cancellation without waiting for polling to finish", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [], nextCursor: null }
        : path === "/jobs-v2/job"
          ? { id: "job", status: "running" }
          : {},
    ),
    post: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { id: "thread", revision: 0 }
        : path.endsWith("/turns")
          ? { id: "job", status: "queued" }
          : {},
    ),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  const textarea = host.querySelector("textarea")!;
  const set = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    set.call(textarea, "question");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  const cancel = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "현재 작업 취소",
  );
  expect(cancel).toBeDefined();
  await act(async () => cancel!.click());
  expect(api.post).toHaveBeenCalledWith("/jobs-v2/job/cancel", {});
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
