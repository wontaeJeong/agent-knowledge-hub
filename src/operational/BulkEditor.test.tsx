// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { BulkEditor } from "./BulkEditor";
import type { OperationalApi } from "./api";
test("bulk editing requires preview, displays partial failures and selects only failures for retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const calls: { path: string; body: unknown }[] = [];
  const api = {
    post: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return path.endsWith("preview")
        ? {
            token: "sealed",
            expiresAt: "2026-11-16",
            items: [
              {
                id: "a",
                status: "ready",
                expectedRevision: 0,
                patch: { state: "archived" },
              },
            ],
          }
        : { items: [{ id: "a", status: "failed", code: "STALE_VERSION" }] };
    },
  } as unknown as OperationalApi;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props = {
    api,
    pages: [{ id: "a", title: "문서 A" }],
    scope: "s:user",
    onChanged: vi.fn(async () => {}),
    onExpired: vi.fn(),
  };
  try {
    await act(async () => root.render(<BulkEditor {...props} />));
    const button = (text: string) =>
      [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;
    expect(button("변경 미리보기").disabled).toBe(true);
    expect(el.textContent).not.toContain("미리보기 내용 적용");
    await act(async () =>
      (el.querySelector("input[type=checkbox]") as HTMLInputElement).click(),
    );
    const reason = el.querySelectorAll("input")[2] as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(reason, "분류 정리");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("변경 미리보기").click());
    expect(calls[0].path).toBe("/workflows/bulk/preview");
    await act(async () => button("미리보기 내용 적용").click());
    expect(el.textContent).toContain("STALE_VERSION");
    expect(calls[1].body).toEqual({ token: "sealed" });
    await act(async () => button("실패 대상 다시 미리보기").click());
    expect(
      (el.querySelector("input[type=checkbox]") as HTMLInputElement).checked,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    vi.unstubAllGlobals();
  }
});
test("a scope change removes a late preview and protected results", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const api = { post: vi.fn() } as unknown as OperationalApi;
  try {
    await act(async () =>
      root.render(
        <BulkEditor
          api={api}
          pages={[{ id: "a", title: "문서 A" }]}
          scope="old"
          onChanged={async () => {}}
          onExpired={() => {}}
        />,
      ),
    );
    await act(async () =>
      (el.querySelector("input[type=checkbox]") as HTMLInputElement).click(),
    );
    await act(async () =>
      root.render(
        <BulkEditor
          api={api}
          pages={[]}
          scope="new"
          onChanged={async () => {}}
          onExpired={() => {}}
        />,
      ),
    );
    expect(el.textContent).not.toContain("문서 A");
    expect(el.querySelector("input[type=checkbox]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    el.remove();
    vi.unstubAllGlobals();
  }
});

test("partial results survive the host refresh boundary until the user refreshes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const api = {
    post: async (path: string) => path.endsWith("preview")
      ? { token: "sealed", expiresAt: "2026-11-16", items: [{ id: "a", status: "ready" }] }
      : { items: [{ id: "a", status: "unconfirmed", code: "NOT_PROCESSED" }] },
  } as unknown as OperationalApi;
  function Host() {
    const [ready, setReady] = useState(true);
    return ready ? <BulkEditor api={api} pages={[{id:"a",title:"문서 A"}]} scope="s:user" onChanged={async()=>{setReady(false);}} onExpired={()=>{}} /> : <p>호스트 목록 다시 불러오는 중</p>;
  }
  const button = (text: string) => [...el.querySelectorAll("button")].find(b=>b.textContent===text)!;
  try {
    await act(async()=>root.render(<Host />));
    await act(async()=>(el.querySelector("input[type=checkbox]") as HTMLInputElement).click());
    const reason = el.querySelectorAll("input")[2] as HTMLInputElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(reason,"분류 정리");
      reason.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>button("변경 미리보기").click());
    await act(async()=>button("미리보기 내용 적용").click());
    expect(el.textContent).toContain("NOT_PROCESSED");
    expect(el.textContent).not.toContain("호스트 목록 다시 불러오는 중");
    expect(button("결과 확인 후 문서 목록 새로고침")).toBeTruthy();
    await act(async()=>button("결과 확인 후 문서 목록 새로고침").click());
    expect(el.textContent).toContain("호스트 목록 다시 불러오는 중");
  } finally {
    await act(async()=>root.unmount());el.remove();vi.unstubAllGlobals();
  }
});
