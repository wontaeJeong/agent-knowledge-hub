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
    {
      id: "old",
      title: "대체 문서",
      currentRecommendation: false,
      lifecycle: "archived",
      effectiveFrom: "2099-01-01T00:00:00Z",
      replacementId: "other",
    },
    {
      id: "unspecified",
      title: "사유 없는 문서",
      currentRecommendation: false,
    },
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
  expect(container.textContent).toContain("현재 권고 대상");
  expect(container.textContent).toContain("현재 권고 비대상");
  expect(container.textContent).toContain("생애주기: archived");
  expect(container.textContent).toContain("시행일: 2099-01-01T00:00:00Z");
  expect(container.textContent).toContain("대체 문서 지정됨");
  expect(container.textContent).toContain(
    "독립 검증이나 공식성을 뜻하지 않습니다",
  );
  expect(container.textContent).toContain("상태 미확인");
  expect(container.textContent).toContain("검토 기한 경과");
  expect(container.textContent).toContain("비대상 사유 미확인");
  expect(container.textContent).toContain("검색 결과 4건");
  expect(
    container.querySelector('a[href="/?app=1&space=space&document=current"]'),
  ).not.toBeNull();
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
    filter.value = "not-current";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("대체 문서");
  expect(container.textContent).toContain("사유 없는 문서");
  expect(container.textContent).not.toContain("현재 문서");
  await act(async () => {
    filter.value = "unknown";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("이전 응답");
  expect(container.textContent).not.toContain("현재 문서");
  expect(container.textContent).not.toContain("대체 문서");
  const search = container.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "결과 없는 검색어");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("검색 결과 0건");
  expect(container.textContent).toContain("선택한 조건에 맞는 발행 지식이 없습니다");
  expect(container.querySelectorAll(".op-page-list article")).toHaveLength(0);
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
  await act(async () => {
    window.location.hash = "workflows";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(container.textContent).not.toContain("문서 0");
  expect(container.querySelector('option[value="id0"]')).toBeNull();
  await act(async () => root.unmount());
});

test("a failure in another required API does not make the pages response a successful refresh", async () => {
  window.history.replaceState(null, "", "/?app=1#knowledge");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).split("/api/v1")[1];
      if (failed && path === "/model")
        throw new Error("model connection failed");
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
                    title: "보호된 문서",
                    summary: "",
                    content: "",
                    version: 1,
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
  expect(container.textContent).toContain("보호된 문서");
  failed = true;
  const refresh = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "새로고침",
  )!;
  await act(async () => refresh.click());
  expect(container.textContent).toContain("요청을 완료하지 못했습니다");
  await act(async () => {
    window.location.hash = "workflows";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(container.textContent).not.toContain("보호된 문서");
  await act(async () => root.unmount());
});

test.each(["empty", "forbidden", "network"])(
  "a late earlier refresh cannot restore pages after a newer %s refresh",
  async (outcome) => {
    window.history.replaceState(null, "", "/?app=1#knowledge");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let pagesCalls = 0;
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const oldPage = {
      id: "secret",
      title: "철회된 비밀",
      summary: "",
      content: "민감 본문",
      version: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = String(url).split("/api/v1")[1];
        if (path === "/pages") {
          pagesCalls++;
          if (pagesCalls === 2) return delayed;
          if (pagesCalls === 3 && outcome === "forbidden")
            return new Response(JSON.stringify({ code: "FORBIDDEN" }), {
              status: 403,
            });
          if (pagesCalls === 3 && outcome === "network")
            throw new Error("network unavailable");
          return new Response(
            JSON.stringify({ items: pagesCalls === 1 ? [oldPage] : [] }),
            { status: 200 },
          );
        }
        const data =
          path === "/me"
            ? {
                principalId: "reader",
                workspaceId: "space",
                role: "reader",
                csrfToken: "synthetic",
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
    expect(container.textContent).toContain("철회된 비밀");
  const refresh = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "새로고침",
  )!;
  // Capture the real handler before refresh unmounts the list: another pending
  // consumer may still invoke the same parent load while the first awaits HTTP.
  const propKey = Object.keys(refresh).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const onRefresh = (
      refresh as unknown as Record<string, { onClick: () => void }>
    )[propKey].onClick;
    await act(async () => {
      onRefresh();
    });
    expect(pagesCalls).toBe(2);
    await act(async () => {
      window.location.hash = "workflows";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.textContent).not.toContain("철회된 비밀");
    expect(container.textContent).not.toContain("민감 본문");
    await act(async () => {
      onRefresh();
    });
    expect(pagesCalls).toBeGreaterThanOrEqual(3);
    if (outcome !== "empty")
      expect(container.textContent).toContain("요청을 완료하지 못했습니다");
    await act(async () => {
      release(
        new Response(JSON.stringify({ items: [oldPage] }), { status: 200 }),
      );
    });
    expect(container.textContent).not.toContain("철회된 비밀");
    await act(async () => {
      window.location.hash = "workflows";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('option[value="secret"]')).toBeNull();
    await act(async () => root.unmount());
  },
);

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
