// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { OperationalApi } from "../api";
test("exact new draft resume loads the requested private ID and preserves it for editing", async () => {
  const module = await import(
    /* @vite-ignore */ String("./DocumentComposer")
  ).catch(() => ({ DocumentComposer: undefined }));
  expect(module.DocumentComposer, "new document composer").toBeDefined();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const api = new OperationalApi();
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    if (path === "/workflows/drafts")
      return {
        items: [
          {
            id: "other",
            revision: 1,
            title: "다른 초안",
            content: "열지 않음",
          },
          {
            id: "exact",
            revision: 2,
            title: "요청한 초안",
            content: "정확한 본문",
          },
        ],
      } as any;
    if (path === "/workflows/templates") return { items: [] } as any;
    if (path === "/imports/config")
      return { personal: false, reviewers: ["reviewer"] } as any;
    if (path === "/workflows/draft-disclosures") return { items: [] } as any;
    throw Error(path);
  });
  vi.spyOn(api, "transport").mockResolvedValue(
    new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
  );
  await act(async () =>
    root.render(
      <module.DocumentComposer
        mode="new"
        api={api}
        pages={[]}
        capabilities={["draft.write", "changeset.propose"]}
        principalId="editor"
        spaceId="team"
        initialDraftId="exact"
        onChanged={async () => {}}
        onExpired={() => {}}
        members={[{ principalId: "editor" }, { principalId: "reviewer" }]}
      />,
    ),
  );
  expect(
    (element.querySelector('[aria-label="문서 제목"]') as HTMLInputElement)
      ?.value,
  ).toBe("요청한 초안");
  expect(
    (
      element.querySelector(
        'textarea[aria-label="Markdown 본문"]',
      ) as HTMLTextAreaElement
    )?.value,
  ).toBe("정확한 본문");
  expect(element.textContent).not.toContain("열지 않음");
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("development StrictMode remount does not erase a permitted restart cache before online validation", async () => {
  const { StrictMode } = await import("react");
  const { RecoveryCache } = await import("../draft-recovery");
  const { DocumentComposer } = await import("./DocumentComposer");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const draft = {
    id: "restart",
    revision: 1,
    title: "복구 제목",
    content: "서버 본문",
  };
  const grant = {
    kind: "draft" as const,
    id: "restart",
    draftId: "restart",
    expectedRevision: 1,
    sourceIds: [],
    dependencyVersions: {},
    principalId: "editor",
    workspaceId: "team",
    lineageHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    expiresAt: Date.now() + 300000,
    cacheBinding: "c".repeat(64),
  };
  new RecoveryCache(localStorage).write(grant, draft, "복구할 미전송 본문");
  const api = new OperationalApi();
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/workflows/drafts"
      ? { items: [draft] }
      : path === "/imports/config"
        ? { personal: false, reviewers: ["reviewer"] }
        : ({ items: [] } as any),
  );
  vi.spyOn(api, "transport").mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === "/me"
            ? { principalId: "editor", workspaceId: "team" }
            : path === "/workflows/recovery/validate"
              ? { status: "ready", revision: 1, serverDraft: draft }
              : grant,
        ),
        { status: 200 },
      ),
  );
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <StrictMode>
        <DocumentComposer
          mode="new"
          api={api}
          pages={[]}
          capabilities={["draft.write"]}
          principalId="editor"
          spaceId="team"
          initialDraftId="restart"
          onChanged={async () => {}}
          onExpired={() => {}}
        />
      </StrictMode>,
    ),
  );
  try {
    expect(el.textContent).toContain("이전 입력 복구");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
test("saved template body enters the composer only after canonical lineage-bound save succeeds", async () => {
  const { DocumentComposer } = await import("./DocumentComposer");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = new OperationalApi();
  const d = {
    id: "template-target",
    revision: 1,
    title: "기존 제목",
    content: "기존 본문",
  };
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/workflows/drafts"
      ? { items: [d] }
      : path === "/workflows/templates"
        ? {
            items: [
              {
                id: "private-template",
                revision: 2,
                title: "제한 템플릿",
                content: "제한된 템플릿 본문",
              },
            ],
          }
        : path === "/imports/config"
          ? { personal: false, reviewers: ["reviewer"] }
          : ({ items: [] } as any),
  );
  let finish: (value: Response) => void = () => {};
  const sent: any[] = [];
  vi.spyOn(api, "transport").mockImplementation(async (path, init) => {
    if (path === "/workflows/drafts") {
      sent.push(JSON.parse(init?.body as string));
      return await new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return new Response(JSON.stringify({ error: "FORBIDDEN" }), {
      status: 403,
    });
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <DocumentComposer
        mode="new"
        api={api}
        pages={[]}
        capabilities={["draft.write"]}
        principalId="editor"
        spaceId="team"
        initialDraftId={d.id}
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    ),
  );
  try {
    const select = el.querySelector(
      '[aria-label="템플릿"]',
    ) as HTMLSelectElement;
    await act(async () => {
      select.value = "saved:private-template";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      (
        el.querySelector(
          'textarea[aria-label="Markdown 본문"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("기존 본문");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: d.id,
      expectedRevision: 1,
      templateId: "private-template",
      templateRevision: 2,
      content: "제한된 템플릿 본문",
    });
    expect(select.disabled).toBe(true);
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({
            ...d,
            revision: 2,
            content: "제한된 템플릿 본문",
            sourceIds: ["source-a"],
          }),
          { status: 200 },
        ),
      ),
    );
    expect(
      (
        el.querySelector(
          'textarea[aria-label="Markdown 본문"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("제한된 템플릿 본문");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
test("a requested draft removed by current ACL clears its restart cache before rendering", async () => {
  const { DocumentComposer } = await import("./DocumentComposer");
  const { RecoveryCache } = await import("../draft-recovery");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const d = {
    id: "revoked",
    revision: 1,
    title: "제한 초안",
    content: "서버 본문",
  };
  new RecoveryCache(localStorage).write(
    {
      kind: "draft",
      draftId: d.id,
      id: d.id,
      expectedRevision: 1,
      sourceIds: [],
      dependencyVersions: {},
      principalId: "editor",
      workspaceId: "team",
      lineageHash: "a".repeat(64),
      policyHash: "b".repeat(64),
      expiresAt: Date.now() + 300000,
      cacheBinding: "c".repeat(64),
    },
    d,
    "철회된 미전송 본문",
  );
  const api = new OperationalApi();
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/imports/config"
      ? { personal: false, reviewers: ["reviewer"] }
      : ({ items: [] } as any),
  );
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <DocumentComposer
        mode="new"
        api={api}
        pages={[]}
        capabilities={["draft.write"]}
        principalId="editor"
        spaceId="team"
        initialDraftId={d.id}
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    ),
  );
  try {
    expect(el.textContent).not.toContain("철회된 미전송 본문");
    expect(Object.values(localStorage).join("")).not.toContain(
      "철회된 미전송 본문",
    );
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});
async function disclosureComposer(status = "approved", principalId = "editor") {
  const { DocumentComposer } = await import("./DocumentComposer");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const api = new OperationalApi();
  const draft = {
    id: "approved-draft",
    revision: 1,
    title: "승인 대상",
    content: "검토 본문",
  };
  const disclosure = {
    id: "disclosure",
    draftId: draft.id,
    draftRevision: 1,
    title: draft.title,
    content: draft.content,
    ownerId: "editor",
    reviewerId: "reviewer",
    policyMode: "independent-review",
    status,
    hash: "a".repeat(64),
    audience: ["editor", "reader", "reviewer"],
    parentId: null,
    requestReason: "팀 공유 이유",
  };
  let requests = [disclosure];
  const posted: any[] = [];
  vi.spyOn(api, "get").mockImplementation(async (path) =>
    path === "/workflows/drafts"
      ? { items: principalId === "editor" ? [draft] : [] }
      : path === "/imports/config"
        ? { personal: false, reviewers: ["reviewer", "reviewer2"] }
        : path === "/workflows/draft-disclosures"
          ? { items: requests }
          : ({ items: [] } as any),
  );
  vi.spyOn(api, "transport").mockResolvedValue(
    new Response(JSON.stringify({ error: "FORBIDDEN" }), { status: 403 }),
  );
  vi.spyOn(api, "post").mockImplementation(async (path, body) => {
    posted.push({ path, body });
    return {} as any;
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <DocumentComposer
        mode="new"
        api={api}
        pages={[]}
        capabilities={["draft.write", "changeset.propose"]}
        principalId={principalId}
        spaceId="team"
        initialDraftId={principalId === "editor" ? draft.id : undefined}
        members={[
          { principalId: "editor" },
          { principalId: "reader" },
          { principalId: "reviewer" },
        ]}
        onChanged={async () => {}}
        onExpired={() => {}}
      />,
    ),
  );
  const button = (name: string) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent === name);
  const change = async (selector: string, value: string) => {
    const field = el.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        field.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    el.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  };
  return {
    api,
    el,
    root,
    draft,
    disclosure,
    posted,
    button,
    change,
    close,
    setRequests: (next: any[]) => {
      requests = next;
    },
  };
}
test("approved exact resume displays the immutable readers and reviewer and initializes matching controls", async () => {
  const t = await disclosureComposer();
  try {
    expect(
      (
        t.el.querySelector(
          '[aria-label="독립 공개 검토자"]',
        ) as HTMLSelectElement
      ).value,
    ).toBe("reviewer");
    const reader = [...t.el.querySelectorAll("label")]
      .find((l) => l.textContent?.trim() === "reader")!
      .querySelector("input")!;
    expect(reader.checked).toBe(true);
    expect(
      t.el.querySelector('[aria-label="고정 공개 대상"]')?.textContent,
    ).toContain("editor, reader, reviewer");
    await t.change('[aria-label="요청 사유"]', "지식 검토 요청 이유");
    expect(t.button("지식 검토 요청")?.disabled).toBe(false);
  } finally {
    await t.close();
  }
});
test.each(["reader", "reviewer"])(
  "editing approved %s invalidates the old disclosure even after status refresh",
  async (field) => {
    const t = await disclosureComposer();
    try {
      await t.change('[aria-label="요청 사유"]', "새 공유 검토 이유");
      await act(async () => {
        if (field === "reader") {
          [...t.el.querySelectorAll("label")]
            .find((l) => l.textContent?.trim() === "reader")!
            .querySelector("input")!
            .click();
        } else {
          const select = t.el.querySelector(
            '[aria-label="독립 공개 검토자"]',
          ) as HTMLSelectElement;
          select.value = "reviewer2";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await act(async () => t.button("검토 상태 새로고침")!.click());
      expect(t.button("지식 검토 요청")).toBeUndefined();
      expect(
        t.el.querySelector('[aria-label="고정 공개 대상"]')?.textContent,
      ).toContain("editor, reader, reviewer");
      expect(t.posted).toHaveLength(0);
    } finally {
      await t.close();
    }
  },
);
test("reviewer enters a meaningful rejection rationale that is sent with the exact disclosure hash", async () => {
  const t = await disclosureComposer("pending", "reviewer");
  try {
    expect(t.button("반려")?.disabled).toBe(true);
    await t.change(
      '[aria-label="검토 사유 승인 대상"]',
      "담당자와 롤백 절차를 보완해 주세요",
    );
    await act(async () => t.button("반려")!.click());
    expect(t.posted[0]).toMatchObject({
      path: "/workflows/draft-disclosures/disclosure/decision",
      body: {
        hash: "a".repeat(64),
        decision: "reject",
        reason: "담당자와 롤백 절차를 보완해 주세요",
      },
    });
  } finally {
    await t.close();
  }
});
test("a late disclosure refresh cannot restore an invalidated audience or cross an account boundary", async () => {
  const t = await disclosureComposer();
  let release: (r: any) => void = () => {};
  try {
    vi.mocked(t.api.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }) as any,
    );
    await act(async () => t.button("검토 상태 새로고침")!.click());
    // Native disabled controls prevent edits during a refresh; a different account still remounts immediately.
    expect(
      (
        t.el.querySelector(
          '[aria-label="독립 공개 검토자"]',
        ) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    vi.mocked(t.api.get).mockImplementation(async (path) =>
      path === "/imports/config"
        ? { personal: false, reviewers: [] }
        : ({ items: [] } as any),
    );
    const { DocumentComposer } = await import("./DocumentComposer");
    await act(async () =>
      t.root.render(
        <DocumentComposer
          mode="new"
          api={t.api}
          pages={[]}
          capabilities={["draft.write"]}
          principalId="other"
          spaceId="other-space"
          onChanged={async () => {}}
          onExpired={() => {}}
        />,
      ),
    );
    await act(async () => release({ items: [t.disclosure] }));
    expect(t.el.querySelector('[aria-label="고정 공개 대상"]')).toBeNull();
    expect(t.el.textContent).not.toContain("팀 공유 이유");
    expect(
      (t.el.querySelector('[aria-label="문서 제목"]') as HTMLInputElement)
        .value,
    ).toBe("");
  } finally {
    await t.close();
  }
});
test("additional reader input retains a typed comma while requiring a fresh approval", async () => {
  const t = await disclosureComposer();
  try {
    await t.change('[aria-label="추가 대상 독자 ID"]', "colleague,");
    expect(
      (
        t.el.querySelector(
          '[aria-label="추가 대상 독자 ID"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("colleague,");
    expect(t.button("지식 검토 요청")).toBeUndefined();
  } finally {
    await t.close();
  }
});
