import { afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationalApi } from "./api";
import {
  PrivateImportPolicy,
  privateImportApproved,
  approvePrivateImport,
  startApprovedPrivateImport,
  type PrivateImportPolicySnapshot,
} from "./PrivateImportPolicy";
afterEach(() => vi.restoreAllMocks());
const snapshot: PrivateImportPolicySnapshot = {
  importId: "mine",
  importRevision: 3,
  revision: 0,
  classification: "unknown",
  grants: [],
  approvedInputRevision: null,
  modelConfigured: true,
  modelDestinationId: "local-model",
  modelDestinationApproved: true,
  transmissionFeaturesEnabled: true,
  currentInputApproved: false,
  destinations: [
    {
      id: "local-model",
      revision: 2,
      fingerprint: "a".repeat(64),
      purposes: ["organize"],
      classifications: ["synthetic"],
    },
  ],
  impact: "공유·발행·사내 승인이 아닙니다.",
};
test("fresh/dirty/stale/unconfigured/private revision approvals fail closed, exact current grant enables only model mode", () => {
  expect(privateImportApproved(snapshot, "mine", 3, false)).toBe(false);
  const approved = {
    ...snapshot,
    revision: 1,
    classification: "synthetic",
    approvedInputRevision: 3,
    currentInputApproved: true,
    grants: [
      {
        destinationId: "local-model",
        purpose: "organize" as const,
        fingerprint: "a".repeat(64),
      },
    ],
  };
  expect(privateImportApproved(approved, "mine", 3, false)).toBe(true);
  for (const [p, id, revision, dirty] of [
    [approved, "other", 3, false],
    [approved, "mine", 4, false],
    [approved, "mine", 3, true],
    [{ ...approved, modelConfigured: false }, "mine", 3, false],
    [{ ...approved, modelDestinationApproved: false }, "mine", 3, false],
    [
      {
        ...approved,
        destinations: [
          { ...approved.destinations[0], fingerprint: "b".repeat(64) },
        ],
      },
      "mine",
      3,
      false,
    ],
  ] as const)
    expect(privateImportApproved(p, id, revision, dirty)).toBe(false);
  const html = renderToStaticMarkup(
    <PrivateImportPolicy
      api={new OperationalApi()}
      importId="mine"
      revision={3}
      dirty={false}
      disabled={false}
      refresh={0}
      onState={() => {}}
      onExpired={() => {}}
    />,
  );
  expect(html).toContain("모델 전송 승인");
  expect(html).toContain("승인 상태를 확인");
  expect(html).not.toContain("관리자만");
});
test("real OperationalApi CSRF adapter saves explicit policy then starts same revision WITHOUT selection PATCH; stale revision sends no run", async () => {
  let policy = snapshot;
  const calls: {
    path: string;
    method: string;
    body: any;
    csrf: string | null;
  }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://local").pathname;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, csrf: headers.get("X-CSRF-Token") });
    if (path.endsWith("/me"))
      return Response.json({ csrfToken: "fixture-csrf" });
    if (method === "PUT") {
      policy = {
        ...snapshot,
        revision: 1,
        classification: body.classification,
        grants: body.grants,
        approvedInputRevision: body.expectedImportRevision,
        currentInputApproved: true,
      };
      return Response.json({ revision: 1 });
    }
    return Response.json(path.endsWith("/runs") ? { id: "run" } : policy);
  });
  const api = new OperationalApi("http://local");
  await api.me();
  await approvePrivateImport(api, snapshot, "local-model", "synthetic", true);
  await startApprovedPrivateImport(api, "mine", 3, "fixture-run");
  const put = calls.find((c) => c.method === "PUT")!;
  expect(put.csrf).toBe("fixture-csrf");
  expect(put.body).toEqual({
    expectedRevision: 0,
    expectedImportRevision: 3,
    classification: "synthetic",
    grants: [
      {
        destinationId: "local-model",
        purpose: "organize",
        fingerprint: "a".repeat(64),
      },
    ],
    impactAcknowledged: true,
  });
  expect(calls.find((c) => c.path.endsWith("/runs"))?.body).toEqual({
    revision: 3,
    mode: "model",
  });
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  policy = { ...policy, importRevision: 4 };
  await expect(
    startApprovedPrivateImport(api, "mine", 3, "stale-run"),
  ).rejects.toThrow();
  expect(calls.filter((c) => c.path.endsWith("/runs"))).toHaveLength(1);
});
