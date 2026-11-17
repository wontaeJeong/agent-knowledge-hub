// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentComposer } from "./DocumentComposer";
import { OperationalApi } from "../api";
import {
  RecoveryCache,
  type Draft,
  type RecoveryBinding,
} from "../draft-recovery";
let roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const r of roots) await act(async () => r.unmount());
  roots = [];
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const saved: Draft = {
  id: "resume",
  revision: 1,
  title: "page draft",
  content: "server body",
  pageId: "topic",
  baseVersion: 1,
};
const grant = (id = "resume"): RecoveryBinding => ({
  id,
  pageId: "topic",
  baseVersion: 1,
  expectedRevision: 1,
  sourceIds: [],
  dependencyVersions: {},
  principalId: "editor",
  workspaceId: "s",
  lineageHash: "a".repeat(64),
  policyHash: "b".repeat(64),
  expiresAt: Date.now() + 300000,
  cacheBinding: "c".repeat(64),
});
const click = async (el: Element, text: string) =>
  act(async () =>
    [...el.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === text)!
      .click(),
  );
async function setup(
  options: {
    mode?: "exact" | "ordinary";
    cacheId?: string;
    validation?: string;
    expired?: boolean;
    revision?: number;
    defer?: boolean;
    identity?: string;
    restoreRevoked?: boolean;
    reloadOnChanged?: boolean;
  } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  localStorage.clear();
  const cache = new RecoveryCache(localStorage);
  const cached = { ...saved, id: options.cacheId ?? saved.id };
  expect(cache.write(grant(cached.id), cached, "UNSENT LOCAL BODY")).toBe(true);
  if (options.expired) vi.setSystemTime(Date.now() + 300001);
  const api = new OperationalApi(),
    calls: string[] = [],
    saves: any[] = [];
  let release: () => void = () => {};
  const server = {
    ...saved,
    revision: options.revision ?? 1,
    content: options.revision ? "winner body" : saved.content,
  };
  vi.spyOn(api, "get").mockImplementation(async (p) =>
    p === "/workflows/drafts"
      ? ({ items: [server] } as any)
      : p === "/workflows/pages/topic"
        ? ({
            page: {
              id: "topic",
              title: "Published",
              versions: [{ number: 1, content: "published" }],
            },
            settings: {
              revision: 1,
              parent_id: null,
              state: "active",
              data: {},
            },
          } as any)
        : ({ items: [] } as any),
  );
  vi.spyOn(api, "transport").mockImplementation(async (p, init) => {
    calls.push(p);
    if (p === "/me")
      return new Response(
        JSON.stringify({
          principalId: options.identity ?? "editor",
          workspaceId: "s",
        }),
      );
    if (p === "/workflows/recovery/validate") {
      if (
        options.restoreRevoked &&
        calls.filter((p) => p === "/workflows/recovery/validate").length > 1
      )
        return new Response(JSON.stringify({ code: "FORBIDDEN" }), {
          status: 403,
        });
      if (options.defer)
        await new Promise<void>((r) => {
          release = r;
        });
      if (options.validation)
        return new Response(JSON.stringify({ code: options.validation }), {
          status: options.validation === "REVOKED" ? 403 : 503,
        });
      return new Response(
        JSON.stringify({
          status: options.revision ? "conflict" : "ready",
          revision: server.revision,
          serverDraft: server,
        }),
      );
    }
    if (p === "/workflows/drafts") {
      const body = JSON.parse(init!.body as string);
      saves.push(body);
      return new Response(
        JSON.stringify({ ...body, revision: body.expectedRevision + 1 }),
      );
    }
    return new Response(JSON.stringify(grant()));
  });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () =>
    root.render(
      <DocumentComposer
        mode={options.mode === "ordinary" ? "edit" : "new"}
        api={api}
        principalId="editor"
        spaceId="s"
        initialPageId="topic"
        initialDraftId={options.mode === "ordinary" ? undefined : "resume"}
        pages={[{ id: "topic", title: "Published" }]}
        capabilities={["knowledge.read", "draft.write", "changeset.propose"]}
        onChanged={async () => {
          if (options.reloadOnChanged) root.render(null);
        }}
        onExpired={() => {}}
      />,
    ),
  );
  return { el, root, cache, calls, saves, release: () => release() };
}
test.each(["exact", "ordinary"] as const)(
  "%s recovery offers authorized unsent input before an editor, and explicit restore preserves original CAS",
  async (mode) => {
    const t = await setup({ mode });
    expect(
      t.el.querySelector('[aria-label="개인 초안 입력 복구"]'),
    ).not.toBeNull();
    expect(
      [...t.el.querySelectorAll("textarea")].some(
        (x) => x.value === "UNSENT LOCAL BODY",
      ),
    ).toBe(false);
    expect(t.calls.slice(0, 2)).toEqual([
      "/me",
      "/workflows/recovery/validate",
    ]);
    await click(t.el, "권한 재확인 후 입력 복구");
    expect(
      [...t.el.querySelectorAll("textarea")].some(
        (x) => x.value === "UNSENT LOCAL BODY",
      ),
    ).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(t.saves[0]).toMatchObject({
      id: "resume",
      expectedRevision: 1,
      baseVersion: 1,
      content: "UNSENT LOCAL BODY",
    });
  },
);
test("explicit discard starts the exact server draft without silently restoring cached input", async () => {
  const t = await setup();
  await click(t.el, "보관 입력 버리기");
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "server body",
    ),
  ).toBe(true);
  expect(Object.values(localStorage).join("")).not.toContain(
    "UNSENT LOCAL BODY",
  );
});
test("another draft on the same page is neither restored nor erased by exact saved-editor flush/unmount", async () => {
  const t = await setup({ cacheId: "other" });
  expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "server body",
    ),
  ).toBe(true);
  expect(t.cache.write(grant(), saved, "REPLACE OTHER")).toBe(false);
  await click(t.el, "개인 초안 저장");
  await act(async () => t.root.unmount());
  roots = roots.filter((r) => r !== t.root);
  expect(Object.values(localStorage).join("")).toContain("UNSENT LOCAL BODY");
});
test("changed server revision restores old local CAS only into explicit conflict without automatic overwrite", async () => {
  const t = await setup({ revision: 2 });
  expect(
    t.el.querySelector('[aria-label="개인 초안 입력 복구"]'),
  ).not.toBeNull();
  await click(t.el, "권한 재확인 후 입력 복구");
  expect(
    t.el.querySelector('[aria-label="개인 초안 저장 충돌"]'),
  ).not.toBeNull();
  expect(t.el.textContent).toContain("저장 r1");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(t.saves).toEqual([]);
});
test.each(["REVOKED", "FAILED"])(
  "%s validation never assigns cached body and clears matching invalid cache",
  async (validation) => {
    const t = await setup({ validation });
    expect(t.calls).toContain("/workflows/recovery/validate");
    expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
    expect(
      [...t.el.querySelectorAll("textarea")].some(
        (x) => x.value === "UNSENT LOCAL BODY",
      ),
    ).toBe(false);
    expect(Object.values(localStorage).join("")).not.toContain(
      "UNSENT LOCAL BODY",
    );
  },
);
test("expired grant is removed and exact resume keeps authorized server body", async () => {
  const t = await setup({ expired: true });
  expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "server body",
    ),
  ).toBe(true);
  expect(Object.values(localStorage).join("")).not.toContain(
    "UNSENT LOCAL BODY",
  );
});
test("pending validation exposes no cached body and keeps it unoffered until online authority completes", async () => {
  const t = await setup({ defer: true });
  expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "UNSENT LOCAL BODY",
    ),
  ).toBe(false);
  expect(Object.values(localStorage).join("")).toContain("UNSENT LOCAL BODY");
  await act(async () => t.release());
  expect(
    t.el.querySelector('[aria-label="개인 초안 입력 복구"]'),
  ).not.toBeNull();
});

test("mismatched online identity fails closed before canonical recovery or server editor initialization", async () => {
  const t = await setup({ identity: "other" });
  expect(t.calls).not.toContain("/workflows/recovery/validate");
  expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "UNSENT LOCAL BODY" || x.value === "server body",
    ),
  ).toBe(false);
  expect(Object.values(localStorage).join("")).not.toContain(
    "UNSENT LOCAL BODY",
  );
});
test("revocation between offer and explicit restore clears cached input and exposes no editor", async () => {
  const t = await setup({ restoreRevoked: true });
  expect(
    t.el.querySelector('[aria-label="개인 초안 입력 복구"]'),
  ).not.toBeNull();
  await click(t.el, "권한 재확인 후 입력 복구");
  expect(t.el.querySelector('[aria-label="개인 초안 입력 복구"]')).toBeNull();
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "UNSENT LOCAL BODY",
    ),
  ).toBe(false);
  expect(Object.values(localStorage).join("")).not.toContain(
    "UNSENT LOCAL BODY",
  );
});
test("late exact recovery validation cannot initialize an unmounted editor", async () => {
  const t = await setup({ defer: true });
  await act(async () => t.root.unmount());
  roots = roots.filter((r) => r !== t.root);
  await act(async () => t.release());
  expect(t.el.textContent).toBe("");
  expect(t.saves).toEqual([]);
});

test("local recovery persists its CAS before any parent reload can unmount the editor", async () => {
  const t = await setup({ reloadOnChanged: true });
  await click(t.el, "권한 재확인 후 입력 복구");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(t.saves[0]).toMatchObject({
    id: "resume",
    expectedRevision: 1,
    content: "UNSENT LOCAL BODY",
  });
  expect(
    [...t.el.querySelectorAll("textarea")].some(
      (x) => x.value === "UNSENT LOCAL BODY",
    ),
  ).toBe(true);
});
