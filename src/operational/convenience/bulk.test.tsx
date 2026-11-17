// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { OperationalApi } from "../api";
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
test("bulk receipt statuses remain distinct and request acceptance is not completion", async () => {
  const api = {
    get: async () => ({
      status: "running",
      items: [{ id: "topic", status: "needs-review" }],
    }),
    post: vi.fn(),
  } as unknown as OperationalApi;
  await mount(
    <BulkEditor
      api={api}
      pages={[{ id: "topic", title: "주제" }]}
      scope="s:u"
      onChanged={async () => {}}
      onExpired={() => {}}
    />,
  );
  expect(document.body.textContent).toContain("태그 변경은 검토 요청");
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
