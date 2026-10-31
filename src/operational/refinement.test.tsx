import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationalApi } from "./api";
import {
  RefinementPanel,
  contextBody,
  evidenceBody,
  claimBody,
  reviewSourceIds,
  queueRefinement,
  semanticNotice,
  refinementPage,
  executionEvidenceNotice,
  submitSemanticLint,
} from "./refinement";
test("claimed execution kind/ID without authenticated attestation never renders as independently verified", () => {
  expect(
    executionEvidenceNotice({ id: "e1", kind: "independent-execution" }),
  ).toContain("미확인");
  expect(
    executionEvidenceNotice({
      id: "e1",
      kind: "independent-execution",
      executionAttestation: {
        status: "attested-unreviewed",
        executedAt: "2026-10-30T00:00:00Z",
        executorId: "trusted-runner",
        outcome: "success",
      },
    }),
  ).toContain("인간 검토와 별개");
});

test("normal context/evidence/claim builders keep distinct time semantics and exact source quote", () => {
  expect(
    contextBody("2026-03-01T00:00", '{"os":"linux"}', "topic"),
  ).toMatchObject({
    asOf: "2026-03-01T00:00:00.000Z",
    environment: { os: "linux" },
    pageIds: ["topic"],
  });
  const source = {
    id: "s1",
    title: "원본",
    content: "한 줄\n정확한 인용\n마지막",
    sourceVersion: "sha256",
  };
  expect(
    evidenceBody({
      id: "e1",
      source,
      quote: "정확한 인용",
      start: 4,
      kind: "claim",
      parentIds: [],
      assertedAt: "2026-03-01T00:00",
      conditions: "{}",
      executionId: "",
    }),
  ).toMatchObject({
    sourceId: "s1",
    sourceVersion: "sha256",
    location: { start: 4, end: 10, quote: "정확한 인용" },
    verifiedAt: null,
  });
  expect(() =>
    evidenceBody({
      id: "e1",
      source,
      quote: "없는 내용",
      start: 0,
      kind: "claim",
      parentIds: [],
      assertedAt: "2026-03-01T00:00",
      conditions: "{}",
      executionId: "",
    }),
  ).toThrow();
  expect(
    claimBody({
      id: "c1",
      pageId: "topic",
      pageVersion: 2,
      key: "retry",
      value: "조건부",
      kind: "inference",
      evidenceIds: ["e1"],
      conditions: "{}",
      exceptions: "네트워크 단절 제외",
      assertedAt: "2026-03-01T00:00",
      validFrom: "2026-01-01T00:00",
      validTo: "",
      uncertainty: "단일 사례",
      supersedes: [],
      protected: false,
    }),
  ).toMatchObject({
    pageVersion: 2,
    verifiedAt: null,
    validTo: null,
    kind: "inference",
    exceptions: ["네트워크 단절 제외"],
  });
});
test("re-ingest extracts only real root lineage and claim evidence sources, never page/evidence IDs", () => {
  const claims = [
    { id: "c1", evidence: [{ id: "e1", sourceId: "source-b", parentIds: [] }] },
  ];
  expect(
    reviewSourceIds(
      {
        id: "r1",
        claimIds: ["c1"],
        rootLineage: [{ sourceId: "source-a" }, { sourceId: "source-a" }],
      },
      claims,
    ),
  ).toEqual(["source-a", "source-b"]);
  expect(reviewSourceIds({ id: "r2", claimIds: ["unknown"] }, claims)).toEqual(
    [],
  );
  expect(
    refinementPage(
      Array.from({ length: 60 }, (_, i) => i),
      1,
    ),
  ).toEqual(Array.from({ length: 25 }, (_, i) => i + 25));
});
test("review candidate becomes a common ingest job with stable retry key, never approve/publish", async () => {
  const calls: unknown[] = [];
  const api = {
    post: async (...args: unknown[]) => {
      calls.push(args);
      return { jobId: "job-1", status: "queued" };
    },
  } as unknown as OperationalApi;
  const result = await queueRefinement(
    api,
    ["s1", "s1"],
    "model",
    "stable-key",
  );
  expect(calls).toEqual([
    ["/ingest", { sourceIds: ["s1"], mode: "model" }, "stable-key"],
  ]);
  expect(result.message).toContain("대기");
  expect(result.message).toContain("완료가 아닙니다");
  await expect(queueRefinement(api, [], "offline", "key")).rejects.toThrow(
    "원본 근거",
  );
  expect(semanticNotice({ status: "unconfigured" })).toContain("미설정");
  expect(semanticNotice({ status: "error" })).toContain("실패");
  expect(semanticNotice({ status: "no-inputs" })).toContain(
    "실행하지 않았습니다",
  );
});
test("read-only panel offers Korean context/as-of/review exploration but no privileged submit controls", () => {
  const html = renderToStaticMarkup(
    <RefinementPanel
      api={new OperationalApi()}
      capabilities={["knowledge.read"]}
      pages={[{ id: "topic", title: "주제", version: 1 }]}
    />,
  );
  expect(html).toContain("지식 정련");
  expect(html).toContain("기준 시점");
  expect(html).toContain("현재 권한");
  expect(html).toContain("25건");
  expect(html).not.toContain("근거 등록 제출");
  expect(html).not.toContain("인간 검토 기록 제출");
});
test("legacy synchronous responses are not labelled queued and offline jobs do not imply semantic synthesis", async () => {
  const legacy = {
    post: async () => ({ id: "batch-1", status: "pending" }),
  } as unknown as OperationalApi;
  await expect(queueRefinement(legacy, ["s1"], "model", "key")).rejects.toThrow(
    "대기 접수를 확인하지 못했습니다",
  );
  const queue = {
    post: async () => ({ id: "job-1", status: "queued" }),
  } as unknown as OperationalApi;
  expect(
    (await queueRefinement(queue, ["s1"], "offline", "key")).message,
  ).toContain("의미 종합이 아닙니다");
});
test.each([
  "running",
  "succeeded",
  "paused",
  "cancel_requested",
  "dead",
  "cancelled",
])(
  "ingest receipt replay displays actual %s status without inventing a new queue admission",
  async (status) => {
    const api = {
      post: async () => ({ id: "existing-job", status }),
    } as unknown as OperationalApi;
    const result = await queueRefinement(api, ["s1"], "model", "stable-key");
    expect(result.status).toBe(status);
    expect(result.message).toContain(status);
    expect(result.message).not.toContain("대기 접수");
  },
);
test("semantic jobs resolve through fresh ACL-checked GET even for completed receipt replays", async () => {
  const paths: string[] = [],
    actual = {
      status: "completed",
      findings: [],
      requestIds: ["request-fresh"],
    };
  const api = {
    post: async () => ({
      id: "semantic-job",
      status: "succeeded",
      result: { status: "completed", requestIds: ["untrusted-post-cache"] },
    }),
    get: async (path: string) => {
      paths.push(path);
      return { id: "semantic-job", status: "succeeded", result: actual };
    },
  } as unknown as OperationalApi;
  expect(
    await submitSemanticLint(
      api,
      { environment: {} },
      { expectQueued: true, pollMs: 0 },
    ),
  ).toEqual(actual);
  expect(paths).toEqual(["/jobs-v2/semantic-job"]);
});
test("semantic cancellation/failure cannot become empty success and fixture inline statuses remain explicit", async () => {
  const cancelled = {
    post: async () => ({ id: "job-cancelled", status: "running" }),
    get: async () => ({ id: "job-cancelled", status: "cancelled" }),
  } as unknown as OperationalApi;
  await expect(
    submitSemanticLint(
      cancelled,
      { environment: {} },
      { expectQueued: true, pollMs: 0 },
    ),
  ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
  const inline = {
    post: async () => ({ status: "unconfigured", findings: [] }),
  } as unknown as OperationalApi;
  expect(
    await submitSemanticLint(
      inline,
      { environment: {} },
      { expectQueued: false },
    ),
  ).toEqual({ status: "unconfigured", findings: [] });
  await expect(
    submitSemanticLint(inline, { environment: {} }, { expectQueued: true }),
  ).rejects.toMatchObject({ code: "INVALID_JOB_RECEIPT" });
  const signal = new AbortController();
  const abandoned = {
    post: async () => {
      signal.abort();
      return { id: "old-view", status: "queued" };
    },
    get: async () => {
      throw Error("must not poll abandoned view");
    },
  } as unknown as OperationalApi;
  await expect(
    submitSemanticLint(
      abandoned,
      { environment: {} },
      { expectQueued: true, signal: signal.signal },
    ),
  ).rejects.toThrow("이전 화면");
});
test("writer panel exposes structured source/claim/outcome forms without frontend model key or direct publish", () => {
  const html = renderToStaticMarkup(
    <RefinementPanel
      api={new OperationalApi()}
      capabilities={[
        "knowledge.read",
        "changeset.propose",
        "lint.run",
        "knowledge.protect",
      ]}
      pages={[]}
    />,
  );
  for (const label of [
    "정확한 원본 인용",
    "원본 버전 해시",
    "유효 시작",
    "성과 관찰",
    "에이전트 신호 편입",
    "인간 검토 기록 제출",
  ])
    expect(html).toContain(label);
  expect(html).not.toContain("API 키");
  expect(html).not.toContain("자동 승인");
});
