// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { DiscoveryDashboard } from "./DiscoveryDashboard";
import { discoveryMetrics } from "../domain/discovery";
import type { OperationalApi } from "./api";

test("period changes hide old protected data and ignore a late earlier response", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const now = new Date("2026-11-11T12:00:00Z");
  const report = (title: string, days: 7 | 14) => ({
    ...discoveryMetrics(
      [
        {
          id: "a",
          title,
          summary: "",
          version: 1,
          links: ["b"],
          updatedAt: now.toISOString(),
        },
        {
          id: "b",
          title,
          summary: "",
          version: 1,
          links: [],
          updatedAt: now.toISOString(),
        },
      ],
      [{ at: now.toISOString(), pageIds: ["b"] }],
      now,
      days,
    ),
    scope: "self" as const,
  });
  const pending = new Map<string, (data: unknown) => void>();
  const api = {
    get: (path: string) => new Promise((resolve) => pending.set(path, resolve)),
  } as unknown as OperationalApi;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<DiscoveryDashboard api={api} spaceId="space" />),
  );
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "14";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    pending.get("/discovery?days=14")!(report("새 결과", 14)),
  );
  expect(container.textContent).toContain("새 결과");
  await act(async () =>
    pending.get("/discovery?days=7")!(report("이전 보호 결과", 7)),
  );
  expect(container.textContent).toContain("새 결과");
  expect(container.textContent).not.toContain("이전 보호 결과");
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
