// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { QuestionsWorkbench } from "./questions";
import { OperationalApi } from "./api";
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

test("a citation opens its version through the selected-space API", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [{ id: "thread", revision: 1 }], nextCursor: null }
        : path === "/questions/threads/thread"
          ? {
              id: "thread",
              revision: 1,
              title: "대화",
              contextOmitted: false,
              turns: [
                {
                  id: "turn",
                  question: "q",
                  mode: "model",
                  status: "completed",
                  jobId: "job",
                  answer: {
                    id: "answer",
                    version: 1,
                    content: "a",
                    insufficient: false,
                    citations: [{ pageId: "same", version: 1, title: "인용" }],
                  },
                },
              ],
            }
          : {
              title: "selected-space",
              version: { number: 1, content: "selected content" },
            },
    ),
    post: vi.fn(),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="selected:user" />),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "대화 thread")!
      .click(),
  );
  const citation = Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("인용 · v1"),
  );
  expect(citation).toBeDefined();
  await act(async () => citation!.click());
  expect(api.get).toHaveBeenCalledWith("/pages/same/versions/1");
  expect(host.textContent).toContain("selected content");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test.each([
  ["cancelled", false],
  ["dead", false],
  ["cancelled", true],
  ["dead", true],
])(
  "%s terminal result refreshes revision for changed prompt %s",
  async (status, changed) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let revision = 0;
    const writes: {
      expectedRevision: number;
      nonce: string;
      question: string;
    }[] = [];
    const api = {
      get: vi.fn(async (path: string) =>
        path === "/questions/threads"
          ? { items: [], nextCursor: null }
          : path === "/questions/threads/thread"
            ? {
                id: "thread",
                revision,
                title: "대화",
                contextOmitted: false,
                turns: [],
              }
            : path.startsWith("/jobs-v2/")
              ? { id: revision === 1 ? "job1" : "job2", status }
              : {},
      ),
      post: vi.fn(async (path: string, body: unknown) => {
        if (path === "/questions/threads") return { id: "thread", revision: 0 };
        if (path.endsWith("/turns")) {
          writes.push(body as (typeof writes)[number]);
          revision++;
          return { id: revision === 1 ? "job1" : "job2", status: "queued" };
        }
        return {};
      }),
    } as unknown as OperationalApi;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
    );
    const input = host.querySelector("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "same prompt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    if (changed)
      await act(async () => {
        setter.call(input, "different prompt");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await act(async () => {
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(writes).toHaveLength(2);
    expect(writes[0].expectedRevision).toBe(0);
    expect(writes[1].expectedRevision).toBe(1);
    expect(writes[0].nonce).not.toBe(writes[1].nonce);
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  },
);

test("history fetches older pages with an opaque cursor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const turn = (id: string) => ({
    id,
    question: id,
    mode: "offline",
    status: "pending",
    jobId: null,
    answer: null,
  });
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [{ id: "thread", revision: null }], nextCursor: null }
        : path.includes("?cursor=")
          ? {
              id: "thread",
              revision: null,
              continuation: "b".repeat(64),
              title: "대화",
              contextOmitted: false,
              turns: [turn("older")],
              nextCursor: null,
            }
          : {
              id: "thread",
              revision: null,
              continuation: "b".repeat(64),
              title: "대화",
              contextOmitted: false,
              turns: [turn("newer")],
              nextCursor: "opaque-cursor",
            },
    ),
    post: vi.fn(),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "대화 thread")!
      .click(),
  );
  const older = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "이전 대화 불러오기",
  );
  expect(older).toBeDefined();
  await act(async () => older!.click());
  expect(api.get).toHaveBeenCalledWith(
    "/questions/threads/thread?cursor=opaque-cursor",
  );
  expect(host.textContent).toContain("older");
  expect(host.textContent).toContain("newer");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("a thread with revoked history submits its opaque continuation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const token = "c".repeat(64);
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [{ id: "thread", revision: null }], nextCursor: null }
        : path === "/questions/threads/thread"
          ? {
              id: "thread",
              revision: null,
              continuation: token,
              title: "대화",
              contextOmitted: true,
              turns: [],
              nextCursor: null,
            }
          : { id: "job", status: "cancelled" },
    ),
    post: vi.fn(async () => ({ id: "job", status: "queued" })),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "대화 thread")!
      .click(),
  );
  const input = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, "after revocation");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(api.post).toHaveBeenCalledWith(
    "/questions/threads/thread/turns",
    expect.objectContaining({
      expectedRevision: token,
      question: "after revocation",
    }),
    expect.any(String),
  );
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("loading an older page clears cached history when source scope changed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let reads = 0;
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/questions/threads")
        return { items: [{ id: "thread", revision: null }], nextCursor: null };
      if (path === "/pages/same/versions/1")
        return {
          title: "protected snapshot",
          version: { number: 1, content: "revoked snapshot" },
        };
      if (path.includes("?cursor="))
        return {
          id: "thread",
          revision: null,
          continuation: "b".repeat(64),
          title: "대화",
          contextOmitted: true,
          turns: [],
          nextCursor: null,
        };
      reads++;
      return reads === 1
        ? {
            id: "thread",
            revision: null,
            continuation: "a".repeat(64),
            title: "대화",
            contextOmitted: false,
            turns: [
              {
                id: "x",
                question: "revoked secret",
                mode: "offline",
                status: "completed",
                jobId: null,
                answer: {
                  id: "answer",
                  version: 1,
                  content: "a",
                  insufficient: false,
                  citations: [{ pageId: "same", version: 1, title: "인용" }],
                },
              },
            ],
            nextCursor: "opaque",
          }
        : {
            id: "thread",
            revision: null,
            continuation: "b".repeat(64),
            title: "대화",
            contextOmitted: true,
            turns: [],
            nextCursor: "opaque",
          };
    }),
    post: vi.fn(),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "대화 thread")!
      .click(),
  );
  expect(host.textContent).toContain("revoked secret");
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("인용 · v1"))!
      .click(),
  );
  expect(host.textContent).toContain("revoked snapshot");
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "이전 대화 불러오기")!
      .click(),
  );
  expect(host.textContent).not.toContain("revoked secret");
  expect(host.textContent).not.toContain("revoked snapshot");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("answer, feedback and search versions resolve inside the selected workspace", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const space = new Headers(init.headers).get("X-Space-Id")!;
      const path = String(url).split("/api/v1")[1];
      if (path === "/pages/same/versions/1") {
        seen.push(space);
        return new Response(
          JSON.stringify({
            title: space,
            version: { number: 1, content: `content ${space}` },
          }),
        );
      }
      if (path === "/questions/threads")
        return new Response(
          JSON.stringify({
            items: [{ id: "thread", revision: 1 }],
            nextCursor: null,
          }),
        );
      if (path === "/questions/feedback")
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "f",
                answerId: "a",
                version: 1,
                category: "incorrect",
                reason: "r",
                work: [
                  {
                    pageId: "same",
                    version: 1,
                    status: "pending",
                    recipientIds: [],
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        );
      if (path === "/questions/search")
        return new Response(
          JSON.stringify({
            items: [
              {
                pageId: "same",
                version: 1,
                title: "search",
                content: "body",
                historical: false,
                currentRecommendation: true,
                metadataStatus: "known",
                href: "/wrong-space",
              },
            ],
            nextCursor: null,
          }),
        );
      return new Response(
        JSON.stringify({
          id: "thread",
          revision: 1,
          title: "대화",
          contextOmitted: false,
          turns: [
            {
              id: "turn",
              question: "q",
              mode: "model",
              status: "completed",
              jobId: "job",
              answer: {
                id: "answer",
                version: 1,
                content: "a",
                insufficient: false,
                citations: [{ pageId: "same", version: 1, title: "인용" }],
              },
            },
          ],
        }),
      );
    }),
  );
  for (const space of ["space-a", "space-b"]) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QuestionsWorkbench
          api={new OperationalApi("", space)}
          identityKey={`${space}:user`}
        />,
      ),
    );
    const click = async (label: string) =>
      act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((b) => b.textContent?.trim() === label)!
          .click(),
      );
    await click("대화 thread");
    await click("인용 · v1");
    expect(host.textContent).toContain(`content ${space}`);
    await click("현재 허용된 재검토 후보 조회");
    await click("same · v1");
    await act(async () => {
      const search = Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === "검색",
      )!;
      search.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await click("search · v1");
    expect(host.textContent).toContain(`content ${space}`);
    await act(async () => root.unmount());
    host.remove();
  }
  expect(seen).toEqual([
    "space-a",
    "space-a",
    "space-a",
    "space-b",
    "space-b",
    "space-b",
  ]);
  vi.unstubAllGlobals();
});

test("an uncertain submission failure retains the original nonce and revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let attempts = 0;
  const writes: { nonce: string; expectedRevision: number }[] = [];
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/questions/threads"
        ? { items: [], nextCursor: null }
        : path === "/jobs-v2/job"
          ? { id: "job", status: "succeeded", result: { id: "answer" } }
          : {
              id: "thread",
              revision: 1,
              title: "대화",
              contextOmitted: false,
              turns: [],
            },
    ),
    post: vi.fn(async (path: string, body: unknown) => {
      if (path === "/questions/threads") return { id: "thread", revision: 0 };
      writes.push(body as (typeof writes)[number]);
      if (attempts++ === 0) throw Error("lost response");
      return { id: "job", status: "queued" };
    }),
  } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<QuestionsWorkbench api={api} identityKey="space:user" />),
  );
  const input = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, "question");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  for (let i = 0; i < 2; i++)
    await act(async () => {
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });
  expect(writes).toHaveLength(2);
  expect(writes[0].nonce).toBe(writes[1].nonce);
  expect(writes[0].expectedRevision).toBe(writes[1].expectedRevision);
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
