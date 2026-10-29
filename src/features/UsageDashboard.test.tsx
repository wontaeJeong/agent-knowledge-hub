import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { UsageReport } from "./UsageDashboard";
import { validateUsage } from "../adapters/usage";
import type { UsageSummary } from "../domain/usage";

const data: UsageSummary = {
  scope: "workspace",
  from: "2026-10-23T00:00:00Z",
  to: "2026-10-29T12:00:00Z",
  timezone: "UTC",
  total: 3,
  succeeded: 2,
  failed: 1,
  activeUsers: 2,
  publications: 1,
  daily: [{ day: "2026-10-29", succeeded: 2, failed: 1 }],
  operations: [
    { operation: "page.read", total: 3, failed: 1, averageDurationMs: 12.5 },
  ],
  model: { inputTokens: null, outputTokens: null, cost: null },
};
test("renders measured counts, denominator, UTC and unknown model usage without invented cost", () => {
  const html = renderToStaticMarkup(<UsageReport data={data} />);
  expect(html).toContain("전체 호출");
  expect(html).toContain("3건 중 2건 성공 · 1건 실패");
  expect(html).toContain("UTC");
  expect(html).toContain("미수집");
  expect(html).toContain("페이지 조회");
  expect(html).toContain("12.5 ms");
  expect(html).not.toContain("$0");
});
test("rejects invalid and internally inconsistent server statistics", () => {
  expect(validateUsage(data)).toEqual(data);
  for (const value of [
    null,
    {},
    { ...data, total: -1 },
    { ...data, failed: 9 },
    { ...data, operations: null },
    { ...data, daily: [{ day: "bad", failed: -1, succeeded: 0 }] },
  ]) {
    expect(() => validateUsage(value)).toThrow();
  }
});
test("empty measured usage is distinguished from missing model measurements", () => {
  const html = renderToStaticMarkup(
    <UsageReport
      data={{
        ...data,
        total: 0,
        succeeded: 0,
        failed: 0,
        activeUsers: 0,
        publications: 0,
        daily: [],
        operations: [],
      }}
    />,
  );
  expect(html).toContain("기록된 사용량이 없습니다");
  expect(html).toContain("미수집");
});
