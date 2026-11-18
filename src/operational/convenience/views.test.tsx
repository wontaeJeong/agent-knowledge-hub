// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { SavedViews, SaveViewForm } from "./SavedViews";
import { normalizeSearchFilters } from "./search-client";
import { ApiError, type OperationalApi } from "../api";
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

test("revalidating the same revision hides private DOM, then restores unfinished name, filter and selection", async () => {
  const { element, render } = mount(),
    v = definition("space");
  const get = vi.fn(async () => v),
    api = { get, post: async () => result() } as unknown as OperationalApi;
  await render(<SavedViews {...props} api={api} viewId="v" />);
  await tick();
  const field = (selector: string) =>
    element.querySelector<HTMLInputElement>(selector)!;
  async function type(selector: string, value: string) {
    await act(async () => {
      const control = field(selector);
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await type(".saved-view-form input", "미저장 이름");
  await type("[data-search-field=query]", "미저장 조건");
  field("[data-search-field=query]").focus();
  field("[data-search-field=query]").setSelectionRange(1, 4);
  let finish!: (row: typeof v) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(element.querySelector(".saved-view-form input")).toBeNull();
  await act(async () => finish(v));
  expect(field(".saved-view-form input").value).toBe("미저장 이름");
  expect(field("[data-search-field=query]").value).toBe("미저장 조건");
  expect(document.activeElement).toBe(field("[data-search-field=query]"));
  expect(field("[data-search-field=query]").selectionStart).toBe(1);
  expect(field("[data-search-field=query]").selectionEnd).toBe(4);
});
test.each([401, 403, 404])(
  "denial %i clears examples, old results and pending work",
  async (status) => {
    const { element, render } = mount();
    const get = vi.fn().mockResolvedValue({ items: [] });
    const api = {
      get,
      post: async () => result("only while authorized"),
    } as unknown as OperationalApi;
    await render(<SavedViews {...props} api={api} />);
    await tick();
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((n) => n.textContent === "최근 변경")!
        .click(),
    );
    await tick();
    expect(element.textContent).toContain("only while authorized");
    let decline!: (e: unknown) => void;
    get.mockImplementationOnce(
      () => new Promise((_r, reject) => (decline = reject)),
    );
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((n) => n.textContent === "다시 불러오기")!
        .click(),
    );
    expect(element.textContent).not.toContain("only while authorized");
    expect(element.querySelector(".search-page")).toBeNull();
    await act(async () =>
      decline(new ApiError("지금 접근 불가", status, "FORBIDDEN")),
    );
    await tick();
    expect(element.textContent).toContain("지금 접근 불가");
    expect(element.querySelector(".search-page")).toBeNull();
  },
);
test("a newer server revision preserves a dirty input until explicitly accepted", async () => {
  const { element, render } = mount(),
    one = definition("space"),
    two = { ...one, name: "새 이름", revision: 2 };
  const get = vi.fn().mockResolvedValueOnce(one).mockResolvedValue(two);
  await render(
    <SavedViews
      {...props}
      viewId="v"
      api={{ get, post: async () => result() } as unknown as OperationalApi}
    />,
  );
  await tick();
  const input = element.querySelector<HTMLInputElement>(
    ".saved-view-form input",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "내 입력");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await tick();
  expect(
    element.querySelector<HTMLInputElement>(".saved-view-form input")!.value,
  ).toBe("내 입력");
  expect(element.textContent).toContain("서버의 보기가 변경");
  expect(
    element.querySelector<HTMLButtonElement>(".saved-view-form button")!
      .disabled,
  ).toBe(true);
  await act(async () =>
    [...element.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("최신 정의 사용"))!
      .click(),
  );
  expect(
    element.querySelector<HTMLInputElement>(".saved-view-form input")!.value,
  ).toBe("새 이름");
});
test("a returned definition must match the independently rendered actor/space", async () => {
  const { element, render } = mount(),
    changed = vi.fn(),
    foreign = {
      ...definition("space"),
      ownerId: "another",
      name: "foreign fixture",
    };
  await render(
    <SavedViews
      {...props}
      onIdentityChanged={changed}
      api={
        { get: async () => ({ items: [foreign] }) } as unknown as OperationalApi
      }
    />,
  );
  expect(changed).toHaveBeenCalledOnce();
  expect(element.textContent).not.toContain("foreign fixture");
});

test("an example create whose response was lost keeps its mutation ID across window revalidation", async () => {
  const { element, render } = mount(),
    request = vi.fn().mockRejectedValue(Error("연결 중단"));
  const api = {
    get: async () => ({ items: [] }),
    post: async () => result(),
    request,
  } as unknown as OperationalApi;
  await render(<SavedViews {...props} api={api} />);
  await tick();
  await act(async () =>
    [...element.querySelectorAll("button")]
      .find((n) => n.textContent === "최근 변경")!
      .click(),
  );
  await tick();
  const input = element.querySelector<HTMLInputElement>(
    ".saved-view-form input",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "저장 재시도");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = async () =>
    act(async () =>
      element
        .querySelector<HTMLButtonElement>(".saved-view-form button")!
        .click(),
    );
  await save();
  await act(async () => window.dispatchEvent(new Event("focus")));
  await tick();
  await save();
  expect(request.mock.calls[1][2].mutationId).toBe(
    request.mock.calls[0][2].mutationId,
  );
});
