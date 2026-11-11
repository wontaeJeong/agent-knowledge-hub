import { describe, expect, it } from "vitest";
import { discoveryMetrics } from "./discovery";

const now = new Date("2026-11-11T12:00:00.000Z");
const pages = [
  {
    id: "a",
    title: "공개 A",
    summary: "A",
    version: 1,
    links: ["b", "b", "hidden", "a"],
    updatedAt: "2026-11-10T10:00:00.000Z",
  },
  {
    id: "b",
    title: "공개 B",
    summary: "B",
    version: 2,
    links: [],
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "c",
    title: "공개 C",
    summary: "C",
    version: 1,
    links: ["b"],
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];

describe("knowledge discovery metrics", () => {
  it("counts each visible source link once and excludes self and inaccessible links", () => {
    const result = discoveryMetrics(pages, [], now, 7);
    expect(result.links).toBe(2);
    expect(
      result.mostLinked.map((x) => [x.id, x.links, x.recentLinks]),
    ).toEqual([["b", 2, 1]]);
    expect(JSON.stringify(result)).not.toContain("hidden");
  });
  it("counts a page once per answer inside the UTC window, excluding unknown pages", () => {
    const result = discoveryMetrics(
      pages,
      [
        { at: "2026-11-10T10:00:00.000Z", pageIds: ["a", "a", "hidden"] },
        { at: "2026-11-11T10:00:00.000Z", pageIds: ["a", "b"] },
        { at: "2026-11-04T23:59:59.000Z", pageIds: ["b"] },
        { at: "2026-11-12T00:00:00.000Z", pageIds: ["b"] },
      ],
      now,
      7,
    );
    expect(result.citations).toBe(3);
    expect(result.mostCited.map((x) => [x.id, x.citations])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(result.daily.at(-1)).toEqual({ day: "2026-11-11", citations: 2 });
    expect(result.daily).toHaveLength(7);
  });
});
