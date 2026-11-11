import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DiscoveryReportView } from "./DiscoveryDashboard";
import { discoveryMetrics } from "../domain/discovery";

test("discovery explains the scope and links ranked visible documents to their workspace", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const report = {
    ...discoveryMetrics(
      [
        {
          id: "a",
          title: "A 문서",
          summary: "설명",
          version: 1,
          links: ["b"],
          updatedAt: now.toISOString(),
        },
        {
          id: "b",
          title: "B 문서",
          summary: "설명",
          version: 1,
          links: [],
          updatedAt: now.toISOString(),
        },
      ],
      [{ at: now.toISOString(), pageIds: ["b"] }],
      now,
      7,
    ),
    scope: "self" as const,
  };
  const html = renderToStaticMarkup(
    <DiscoveryReportView report={report} spaceId="space-1" />,
  );
  expect(html).toContain("내 질문 인용");
  expect(html).toContain("최근 갱신된 연결");
  expect(html).toContain("B 문서");
  expect(html).toContain("space=space-1&amp;document=b");
  expect(html).toContain("인용 횟수가 정확성");
});
