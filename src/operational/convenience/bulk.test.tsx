// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, type OperationalApi } from "../api";
import { PropertiesForm } from "./PropertiesForm";
import { BulkEditor } from "../BulkEditor";
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
});
async function mount(el: React.ReactNode) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(el));
  return host;
}
const metadata = {
  number: 1,
  settingsRevision: 0,
  category: "기술 설계",
  summary: "설명",
  tags: [],
  properties: {},
  environment: "",
  workflowData: {},
};
const props = {
  pageId: "topic",
  scope: "s:u",
  canAssignOwner: false,
  onReadUnavailable: () => {},
  recheckDocument: () => {},
  onExpired: () => {},
};
test("form names canonical fields and blocks missing required metadata without JSON editing", async () => {
  const api = {
    get: async () => ({
      metadata,
      policies: [
        {
          document_type: "기술 설계",
          required_keys: ["environment"],
          mode: "block",
        },
      ],
      owner: null,
    }),
    post: vi.fn(),
  } as unknown as OperationalApi;
  await mount(<PropertiesForm {...props} api={api} />);
  for (const label of ["문서 유형", "태그", "적용 환경", "검토일", "요약"])
    expect(
      [...document.querySelectorAll("label")].some((x) =>
        x.textContent?.includes(label),
      ),
    ).toBe(true);
  expect(document.body.textContent).toContain("필수 속성: environment");
  expect(
    [...document.querySelectorAll("button")].find(
      (x) => x.textContent === "속성 검토 요청",
    )?.disabled,
  ).toBe(true);
  expect(document.body.textContent).toContain("담당자 지정은 접근 권한");
});
test("property responses from an old identity are discarded", async () => {
  let resolve!: (x: unknown) => void;
  const api = {
    get: () => new Promise((r) => (resolve = r)),
  } as unknown as OperationalApi;
  await mount(<PropertiesForm {...props} api={api} />);
  const old = resolve;
  await act(async () =>
    root.render(<PropertiesForm {...props} scope="s:other" api={api} />),
  );
  await act(async () =>
    old({
      metadata: { ...metadata, summary: "PRIVATE" },
      policies: [],
      owner: null,
    }),
  );
  expect(document.body.textContent).not.toContain("PRIVATE");
});
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;

test.each(["dead", "cancelled"])(
  "accepted request replays with its own ID and terminal %s pending targets get fresh consent",
  async (terminal) => {
    const pages = ["pending", "applied", "needs-review"].map((id) => ({
      id,
      title: id,
    }));
    const apply: { previewToken: string; mutationId: string }[] = [];
    const previews: string[][] = [];
    let status = "queued";
    const api = {
      post: async (path: string, body: any) => {
        if (path.endsWith("/preview")) {
          previews.push(body.pageIds);
          return {
            previewToken: "p" + previews.length,
            expiresAt: "later",
            items: body.pageIds.map((id: string) => ({ id, status: "ready" })),
          };
        }
        apply.push(body);
        if (apply.length === 1) throw Error("response lost");
        return { id: "receipt", status: "queued" };
      },
      get: async () => ({
        status,
        items: pages.map((p) => ({
          id: p.id,
          status: status === "queued" ? "pending" : p.id,
        })),
      }),
    } as unknown as OperationalApi;
    const host = await mount(
      <BulkEditor
        api={api}
        pages={pages}
        scope="s:u"
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    );
    const boxes = [
      ...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    ];
    for (const box of boxes) await act(async () => box.click());
    await fill(
      host.querySelector<HTMLInputElement>('input[maxlength="2000"]')!,
      "batch",
    );
    const click = async (name: string) =>
      act(async () => button(host, name).click());
    await click("변경 미리보기");
    await click("미리보기 내용 적용");
    await click("동일 요청의 처리 결과 다시 확인");
    expect(apply[0]).toEqual(apply[1]);
    expect(host.textContent).toContain("접수됨 · 작업자 처리 대기");
    status = terminal;
    await click("처리 결과 새로고침");
    const results = host.querySelector('[aria-label="일괄 변경 결과"]')!;
    expect(results.textContent).toContain("적용됨");
    expect(results.textContent).toContain("검토 필요");
    expect(results.textContent).toContain("대기");
    await click("실패 대상 다시 미리보기");
    expect(boxes.map((x) => x.checked)).toEqual([true, false, false]);
    await click("변경 미리보기");
    await click("미리보기 내용 적용");
    expect(previews[1]).toEqual(["pending"]);
    expect(apply[2].mutationId).not.toBe(apply[0].mutationId);
    await click("변경 미리보기");
    await click("미리보기 내용 적용");
    expect(apply[3].mutationId).not.toBe(apply[2].mutationId);
  },
);

test("a property read denial clears the form and invalidates parent authority", async () => {
  const denied = new ApiError("문서가 없습니다.", 404);
  const api = {
    get: vi.fn().mockRejectedValue(denied),
  } as unknown as OperationalApi;
  const onReadUnavailable = vi.fn();
  const host = await mount(
    <PropertiesForm
      {...props}
      api={api}
      onReadUnavailable={onReadUnavailable}
    />,
  );
  expect(host.querySelector("textarea")).toBeNull();
  expect(onReadUnavailable).toHaveBeenCalledWith(denied);
});

test("the canonical environment object is preserved by an untouched form schema", async () => {
  const { documentPropertiesSchema } =
    await import("../../domain/document-properties");
  expect(
    documentPropertiesSchema.parse({
      category: "guide",
      summary: "",
      tags: [],
      properties: {},
      environment: { os: "linux", version: "17" },
      reviewDue: null,
    }).environment,
  ).toEqual({ os: "linux", version: "17" });
});
test("required environment prefers the canonical value, including explicit clearing, and reads legacy-only fields", async () => {
  const { missingRequiredProperty } =
    await import("../../domain/document-properties");
  expect(
    missingRequiredProperty("environment", {
      properties: { environment: "legacy" },
    }),
  ).toBe(false);
  for (const environment of [null, "  ", {}, { os: "  " }])
    expect(
      missingRequiredProperty("environment", {
        environment,
        properties: { environment: "obsolete" },
      }),
    ).toBe(true);
  expect(
    missingRequiredProperty("environment", {
      environment: { os: "linux" },
      properties: {},
    }),
  ).toBe(false);
});
test("current receipt omissions remove cached target names from selection and retry", async () => {
  const api = {
    post: async (path: string) =>
      path.endsWith("preview")
        ? {
            token: "legacy",
            previewToken: "p",
            expiresAt: "later",
            items: [{ id: "hidden", status: "ready" }],
          }
        : { id: "receipt", status: "queued" },
    get: async () => ({ status: "succeeded", items: [] }),
  } as unknown as OperationalApi;
  const el = await mount(
    <BulkEditor
      api={api}
      pages={[{ id: "hidden", title: "PRIVATE TARGET" }]}
      scope="s:u"
      onChanged={async () => {}}
      onExpired={() => {}}
    />,
  );
  const button = (name: string) =>
    [...el.querySelectorAll("button")].find((x) => x.textContent === name)!;
  await act(async () => {
    (el.querySelector("input[type=checkbox]") as HTMLInputElement).click();
  });
  const reason = [...el.querySelectorAll("input")].find(
    (x) => x.maxLength === 2000,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(reason, "test");
    reason.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("변경 미리보기").click());
  await act(async () => button("미리보기 내용 적용").click());
  expect(el.textContent).not.toContain("PRIVATE TARGET");
});
