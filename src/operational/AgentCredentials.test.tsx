// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import AgentCredentials from "./AgentCredentials";
import type { Identity, OperationalApi } from "./api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("revoked keys show when they were revoked to their owner and space administrator", async () => {
  const revokedAt = "2026-10-30T12:34:00.000Z";
  const item = { id: "key-1", issuer: "user-1", name: "Test key", scope: "read", suffix: "abcd", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z", revokedAt, lastUsedAt: null, requests30d: 0, activeDays30d: 0 };
  const api = { get: async (path: string) => ({ items: path === "/credentials/clients" ? [] : [item] }) } as unknown as OperationalApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<AgentCredentials api={api} identity={{ spaceRole: "Admin" } as Identity} onExpired={() => {}} section="agents" />); });
  const tables = host.querySelectorAll("table");
  const expected = new Date(revokedAt).toLocaleString("ko-KR");
  expect(tables).toHaveLength(2);
  expect(tables[0].textContent).toContain(expected);
  expect(tables[1].textContent).toContain(expected);
  await act(async () => root.unmount());
  host.remove();
});
