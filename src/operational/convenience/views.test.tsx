// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { SavedViews, SaveViewForm } from "./SavedViews";
import { normalizeSearchFilters } from "./search-client";
import type { OperationalApi } from "../api";
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  return {
    element,
    render: async (el: React.ReactNode) => act(async () => root.render(el)),
  };
}
const result = (content?: string) => ({
  items: content
    ? [
        {
          pageId: "doc",
          version: 1,
          title: content,
          content,
          metadata: null,
          metadataStatus: "unknown",
          unknownMetadataKeys: [],
        },
      ]
    : [],
  nextCursor: null,
});
const definition = (scope: string) => ({
  id: "v",
  name: "보기 " + scope,
  ownerId: "reader",
  workspaceId: scope,
  filters: normalizeSearchFilters({
    query: "fixture sensitive words",
    sort: "title",
  }),
  sort: "title",
  revision: 1,
});
const props = {
  spaceId: "space",
  principalId: "reader",
  onOpen: () => {},
  onView: () => {},
};
const tick = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(205);
  });
test("samples require selection and obsolete saved searches cannot repopulate a refreshed or changed identity", async () => {
  const { element, render } = mount();
  let releaseOld!: (result: unknown) => void,
    grant = true;
  const pending = new Promise((r) => {
    releaseOld = r;
  });
  const get = vi.fn(async (path: string) =>
    path.endsWith("/views") ? { items: [] } : definition("space"),
  );
  const post = vi
    .fn()
    .mockResolvedValueOnce(result())
    .mockImplementationOnce(() => pending)
    .mockImplementation(() =>
      Promise.resolve(grant ? result("current") : result()),
    );
  const api = { get, post } as unknown as OperationalApi;
  await render(<SavedViews {...props} api={api} />);
  await tick();
  expect(post).not.toHaveBeenCalled();
  await act(async () =>
    [...element.querySelectorAll("button")]
      .find((b) => b.textContent === "내 담당 문서")!
      .click(),
  );
  await tick();
  expect(post.mock.calls[0][1].businessOwner).toBe("reader");
  await render(<SavedViews {...props} api={api} viewId="v" />);
  await tick();
  expect(element.textContent).toContain("보기 space");
  expect(post.mock.calls[1][1].query).toBe("fixture sensitive words");
  grant = false;
  await act(async () => window.dispatchEvent(new Event("focus")));
  await tick();
  await act(async () => releaseOld(result("old confidential result")));
  expect(element.textContent).toContain("0건 표시");
  expect(element.textContent).not.toContain("old confidential result");
  expect(
    location.href + JSON.stringify({ ...localStorage, ...sessionStorage }),
  ).not.toContain("fixture sensitive words");
  let releaseDefinition!: (v: ReturnType<typeof definition>) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((r) => {
        releaseDefinition = r;
      }),
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  const newApi = {
    get: async () => {
      throw Error("현재 보기 접근 불가");
    },
  } as unknown as OperationalApi;
  await render(
    <SavedViews {...props} api={newApi} viewId="v" principalId="another" />,
  );
  await act(async () => releaseDefinition(definition("old")));
  expect(element.textContent).not.toContain("보기 old");
  expect(element.textContent).toContain("현재 보기 접근 불가");
});
test("lost save response reuses a nonce for the same definition; editing creates a new nonce", async () => {
  const { element, render } = mount(),
    request = vi.fn().mockRejectedValue(Error("연결 중단"));
  const api = { request } as unknown as OperationalApi;
  await render(
    <SaveViewForm
      filters={normalizeSearchFilters({ query: "private term" })}
      api={api}
      disabled={false}
      onSaved={() => {}}
    />,
  );
  const input = element.querySelector("input")!;
  async function name(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const save = async () =>
    act(async () => element.querySelector("button")!.click());
  await name("private name");
  await save();
  await save();
  await name("new private name");
  await save();
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[1][2].mutationId).toBe(
    request.mock.calls[0][2].mutationId,
  );
  expect(request.mock.calls[2][2].mutationId).not.toBe(
    request.mock.calls[0][2].mutationId,
  );
  expect(
    location.href + JSON.stringify({ ...localStorage, ...sessionStorage }),
  ).not.toContain("private");
});
