// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import OperationalApp from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("published list keeps all pages and filters only explicit server recommendation values", async () => {
  window.history.replaceState(null, "", "/?app=1#knowledge");
  const items = [
    {
      id: "current",
      title: "현재 문서",
      currentRecommendation: true,
      reviewOverdue: true,
    },
    { id: "old", title: "대체 문서", currentRecommendation: false },
    { id: "legacy", title: "이전 응답" },
  ].map((p) => ({ ...p, summary: "요약", content: "내용", version: 1 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split("/api/v1")[1];
      const data =
        path === "/me"
          ? {
              principalId: "reader",
              workspaceId: "space",
              role: "reader",
              csrfToken: "synthetic",
            }
          : path === "/pages"
            ? { items }
            : path === "/model"
              ? { configured: false, model: null }
              : { items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationalApp />);
  });
  expect(container.textContent).toContain("현재 문서");
  expect(container.textContent).toContain("대체 문서");
  expect(container.textContent).toContain("이전 응답");
  expect(container.textContent).toContain("현재 권고");
  expect(container.textContent).toContain("비권고");
  expect(container.textContent).toContain("상태 미확인");
  expect(container.textContent).toContain("검토 기한 경과");
  expect(container.textContent).toContain("검색 결과 3건");
  expect(container.querySelector('a[href="/?app=1&space=space&document=current"]')).not.toBeNull();
  const filter = Array.from(container.querySelectorAll("select")).find(
    (s) => s.getAttribute("aria-label") === "권고 상태 필터",
  )!;
  await act(async () => {
    filter.value = "current";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("현재 문서");
  expect(container.textContent).not.toContain("대체 문서");
  expect(container.textContent).not.toContain("이전 응답");
  expect(container.textContent).toContain("검색 결과 1건");
  await act(async () => {
    filter.value = "unknown";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("이전 응답");
  expect(container.textContent).not.toContain("현재 문서");
  expect(container.textContent).not.toContain("대체 문서");
  await act(async () => root.unmount());
});

test("search resets pagination and failed refresh hides the previously loaded list", async () => {
  window.history.replaceState(null, "", "/?app=1#knowledge");
  let denied = false;
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: `id${i}`,
    title: `문서 ${i}`,
    summary: "요약",
    content: "내용",
    version: 1,
    currentRecommendation: true,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split("/api/v1")[1];
      if (path === "/pages" && denied)
        return new Response(JSON.stringify({ code: "FORBIDDEN" }), {
          status: 403,
        });
      const data =
        path === "/me"
          ? {
              principalId: "reader",
              workspaceId: "space",
              role: "reader",
              csrfToken: "synthetic",
            }
          : path === "/pages"
            ? { items }
            : path === "/model"
              ? { configured: false, model: null }
              : { items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationalApp />);
  });
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    )!;
  await act(async () => button("다음").click());
  expect(container.textContent).toContain("문서 29");
  const search = container.querySelector(
    'input[type="search"]',
  ) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search, "문서 0");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("문서 0");
  expect(container.textContent).not.toContain("문서 29");
  denied = true;
  await act(async () => button("새로고침").click());
  expect(container.textContent).not.toContain("문서 0");
  expect(container.textContent).toContain("요청을 완료하지 못했습니다");
  await act(async () => root.unmount());
});

test("session expiry clears previously visible published content", async () => {
  window.history.replaceState(null, "", "/?app=1#knowledge");
  let expired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split("/api/v1")[1];
      if (expired)
        return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
          status: 401,
        });
      const data =
        path === "/me"
          ? {
              principalId: "reader",
              workspaceId: "space",
              role: "reader",
              csrfToken: "synthetic",
            }
          : path === "/pages"
            ? {
                items: [
                  {
                    id: "p",
                    title: "보호된 지식",
                    summary: "",
                    content: "",
                    version: 1,
                    currentRecommendation: true,
                  },
                ],
              }
            : path === "/model"
              ? { configured: false, model: null }
              : { items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationalApp />);
  });
  expect(container.textContent).toContain("보호된 지식");
  expired = true;
  const refresh = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "새로고침",
  )!;
  await act(async () => refresh.click());
  expect(container.textContent).not.toContain("보호된 지식");
  expect(container.textContent).toContain("조직 계정으로 로그인");
  await act(async () => root.unmount());
});

test("switching spaces replaces the old published list", async () => {
  window.history.replaceState(null, "", "/?app=1&space=one#knowledge");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url).split("/api/v1")[1];
      const space = (init.headers as Record<string, string>)["X-Space-Id"];
      const data =
        path === "/me"
          ? {
              principalId: "reader",
              workspaceId: space,
              role: "reader",
              csrfToken: "synthetic",
              capabilities: ["knowledge.read"],
            }
          : path === "/pages"
            ? {
                items: [
                  {
                    id: "p",
                    title: space === "one" ? "첫 공간 지식" : "둘째 공간 지식",
                    summary: "",
                    content: "",
                    version: 1,
                  },
                ],
              }
            : path === "/spaces"
              ? {
                  items: [
                    {
                      id: "one",
                      namespaceSlug: "a",
                      slug: "one",
                      role: "read",
                    },
                    {
                      id: "two",
                      namespaceSlug: "a",
                      slug: "two",
                      role: "read",
                    },
                  ],
                }
              : path === "/model"
                ? { configured: false, model: null }
                : { items: [] };
      return new Response(JSON.stringify(data), { status: 200 });
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OperationalApp />);
  });
  expect(container.textContent).toContain("첫 공간 지식");
  const space = Array.from(container.querySelectorAll("select")).find(
    (s) => s.value === "one",
  )!;
  await act(async () => {
    space.value = "two";
    space.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).not.toContain("첫 공간 지식");
  expect(container.textContent).toContain("둘째 공간 지식");
  await act(async () => root.unmount());
});
