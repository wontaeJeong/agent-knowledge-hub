// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { GranularRetentionPanel } from "./granular-retention";
import type { OperationalApi } from "./api";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
test("selecting an individually owned artifact shows the server preview and creates a separate pending review plan", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const record = {
    selection: { kind: "runtime-job", id: "finished-job" },
    ownerId: "editor",
    eligible: true,
    reasons: [],
    retainedBy: [],
  };
  let planned = false;
  const api = {
    get: async () => ({ items: [record], plans: [], truncated: false }),
    post: async (path: string) => {
      if (path.endsWith("/preview"))
        return {
          hash: "a".repeat(64),
          policyRevision: 0,
          total: 1,
          eligible: 1,
          records: [record],
        };
      planned = true;
      return { id: "plan-1", state: "pending" };
    },
  } as unknown as OperationalApi;
  try {
    await act(async () =>
      root.render(<GranularRetentionPanel api={api} principalId="owner" />),
    );
    const button = (text: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      )!;
    await act(async () => button("개별 대상·검토 목록 조회").click());
    expect(host.textContent).toContain("finished-job");
    expect(host.textContent).toContain("editor");
    await act(async () =>
      host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
    );
    await act(async () => button("선택 항목 미리보기").click());
    expect(host.textContent).toContain("선택 1건 · 삭제 가능 1건");
    await act(async () => button("별도 검토 요청").click());
    expect(planned).toBe(true);
    expect(host.textContent).toContain("독립된 관리자의 검토를 요청했습니다");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("completed granular execution refreshes its parent receipt summary", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host),
    originalConfirm = window.confirm;
  window.confirm = () => true;
  let executed = false;
  const api = {
    get: async () => ({
      items: [],
      plans: executed
        ? []
        : [
            {
              id: "approved-plan",
              state: "approved",
              requested_by: "owner",
              reviewed_by: "reviewer",
              preview_hash: "a".repeat(64),
              selection: [{ kind: "runtime-job", id: "job" }],
              expires_at: "2026-11-17T12:00:00Z",
            },
          ],
      truncated: false,
    }),
    post: async () => {
      executed = true;
      return { status: "completed", deleted: 1, physicalPurgePending: 0 };
    },
  } as unknown as OperationalApi;
  function Host() {
    const [count, setCount] = useState(0);
    return (
      <>
        <p>확인한 영수증 {count}건</p>
        <GranularRetentionPanel
          api={api}
          principalId="owner"
          onExecuted={async () => setCount(1)}
        />
      </>
    );
  }
  try {
    await act(async () => root.render(<Host />));
    const button = (name: string) =>
      Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === name,
      )!;
    await act(async () => button("개별 대상·검토 목록 조회").click());
    await act(async () => button("승인한 개별 자료 삭제").click());
    expect(host.textContent).toContain("확인한 영수증 1건");
    expect(host.textContent).toContain(
      "제품 기록 정리 1건 · 물리 정리 대기 0건 · 완료",
    );
  } finally {
    window.confirm = originalConfirm;
    await act(async () => root.unmount());
    host.remove();
  }
});
