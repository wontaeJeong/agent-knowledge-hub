// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OperationalApi } from "./api";
import { LinkCompletion } from "./document-navigation";
import { WorkflowPanel } from "./workflows";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function change(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (node: HTMLElement, text: string) =>
  Array.from(node.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === text,
  )!;
const candidates = { items: [{ id: "target", title: "Target", version: 1 }] };

test("pending insertion invokes the committed current draft callback", async () => {
  let resolve!: (value: typeof candidates) => void;
  const api = new OperationalApi();
  vi.spyOn(api, "post")
    .mockResolvedValueOnce(candidates)
    .mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  let saved = "";
  const onError = vi.fn();
  const oldInsert = (markdown: string) => {
    saved = `original\n${markdown}`;
  };
  const newInsert = (markdown: string) => {
    saved = `original with new edits\n${markdown}`;
  };
  try {
    await act(async () =>
      root.render(
        <LinkCompletion
          api={api}
          spaceId="space"
          onInsert={oldInsert}
          onError={onError}
        />,
      ),
    );
    await change(node.querySelector("input")!, "target");
    await act(async () =>
      node
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await act(async () => button(node, "Target · 링크 삽입").click());
    await act(async () =>
      root.render(
        <LinkCompletion
          api={api}
          spaceId="space"
          onInsert={newInsert}
          onError={onError}
        />,
      ),
    );
    await act(async () => resolve(candidates));
    expect(saved).toBe(
      "original with new edits\n[Target](/?app=1&space=space&document=target)",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test.each([false, true])("typing while insertion authorization is pending survives in the actual editor and persisted autosave (save in flight: %s)", async (saveInFlight) => {
  let finishInitialSave!: () => void;
  let resolveInsertion!: (response: Response) => void;
  let searches = 0;
  let candidateVersion = 1;
  let templateInput: Record<string, unknown> | undefined;
  let persisted = "";
  let persistedRevision = 0;
  let persistedDependencies: unknown;
  const response = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const published = {
    id: "topic",
    title: "Original",
    summary: "",
    category: "기술 설계",
    scope: "team",
    status: "미검증",
    owner: "team",
    tags: [],
    favorite: false,
    reused: 0,
    versions: [
      {
        id: "v1",
        number: 1,
        content: "original",
        author: "synthetic",
        reason: "fixture",
        at: "2026-11-16T00:00:00Z",
        sourceIds: [],
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).split("/api/v1")[1];
      if (path === "/workflows/pages/topic")
        return response({
          page: published,
          settings: { revision: 0, state: "active", parent_id: null, data: {} },
        });
      if (path === "/workflows/recovery/permission")
        return response({ code: "FORBIDDEN" }, 403);
      if (path === "/workflows/links/search") {
        searches++;
        if (searches === 2)
          return new Promise<Response>((resolve) => {
            resolveInsertion = resolve;
          });
        return response({items:[{...candidates.items[0],version:candidateVersion}]});
      }
      if (path === "/workflows/templates" && init.method === "POST") {
        templateInput = JSON.parse(String(init.body));
        return response({code:"SOURCE_SCOPE_CONFLICT"},409);
      }
      if (path === "/workflows/drafts" && init.method === "POST") {
        const {
          expectedRevision,
          mutationId: _mutationId,
          ...draft
        } = JSON.parse(String(init.body));
        if (expectedRevision !== persistedRevision)
          return response({ code: "STALE_VERSION" }, 409);
        persisted = draft.content;
        persistedDependencies = draft.dependencyVersions;
        persistedRevision++;
        if (saveInFlight && expectedRevision === 0)
          return new Promise<Response>((resolve) => {
            finishInitialSave = () => resolve(response({ ...draft, revision: 1 }));
          });
        return response({ ...draft, revision: persistedRevision });
      }
      return response({ items: [] });
    }),
  );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <WorkflowPanel
          api={new OperationalApi("", "space")}
          pages={[{ id: "topic", title: "Original" }]}
          initialPageId="topic"
          capabilities={["knowledge.read", "draft.write"]}
          principalId="synthetic-editor"
          spaceId="space"
          onChanged={async () => {}}
          onExpired={() => {}}
        />,
      ),
    );
    await act(async () => button(node, "개인 초안 시작").click());
    const completion = node.querySelector<HTMLElement>(
      '[aria-label="내부 링크 삽입"]',
    )!;
    await change(completion.querySelector("input")!, "target");
    await act(async () =>
      completion
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await act(async () => button(completion, "Target · 링크 삽입").click());
    const editor = node.querySelector<HTMLTextAreaElement>(
      "textarea[rows='14']",
    )!;
    expect(editor.disabled).toBe(false);
    if (saveInFlight)
      await act(async () =>
        editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
      );
    await change(editor, "original with new edits");
    await act(async () => resolveInsertion(response(candidates)));
    const expected =
      "original with new edits\n[Target](/?app=1&space=space&document=target)";
    expect(editor.value).toBe(expected);
    if (saveInFlight) await act(async () => finishInitialSave());
    // Focus loss flushes the real DraftAutosave coordinator through OperationalApi.
    await act(async () =>
      editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    expect(persisted).toBe(expected);
    expect(persistedDependencies).toEqual({ target: 1 });
    expect(persistedRevision).toBe(saveInFlight ? 2 : 1);
    expect(node.textContent).toContain("서버에 저장됨");
    candidateVersion = 2;
    await act(async () => completion.querySelector("form")!.dispatchEvent(
      new Event("submit", {bubbles:true,cancelable:true}),
    ));
    await act(async () => button(completion,"Target · 링크 삽입").click());
    expect(editor.value).toBe(expected);
    await act(async () => editor.dispatchEvent(new FocusEvent("focusout",{bubbles:true})));
    expect(persistedDependencies).toEqual({target:1});
    await act(async () => button(node,"템플릿으로 저장").click());
    expect(templateInput).toMatchObject({
      sourceDraftId: expect.any(String), sourceDraftRevision: persistedRevision,
      originPageId:"topic", content:expected,
    });

  } finally {
    await act(async () => root.unmount());
  }
});
