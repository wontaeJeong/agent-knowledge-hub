import { describe, it, expect } from "vitest";
import {
  compareClaims,
  lineageRoots,
  selectContext,
  type Evidence,
} from "./logic";
import { claim } from "./fixtures";
describe("temporal/lineage regression fixtures", () => {
  it("KE-02 retains opposite same-condition claims as contradiction", () => {
    expect(compareClaims(claim, { ...claim, id: "c2", value: "no" })).toBe(
      "contradiction",
    );
  });
  it("KE-03 separates valid time from assertion and verification", () => {
    const next = {
      ...claim,
      id: "c2",
      value: "no",
      validFrom: claim.validTo,
      validTo: null,
    };
    expect(compareClaims(claim, next)).toBe("different-time");
    expect(
      selectContext([claim, next], "2026-03-01T00:00:00Z", {
        os: "linux",
      }).items.map((c) => c.id),
    ).toEqual(["c1"]);
    expect(
      selectContext([claim, next], "2026-08-01T00:00:00Z", {
        os: "linux",
      }).items.map((c) => c.id),
    ).toEqual(["c2"]);
  });
  it("KE-04 keeps environment exceptions rather than false contradictions", () => {
    expect(
      compareClaims(claim, {
        ...claim,
        value: "no",
        conditions: { os: "mac", version: "1" },
      }),
    ).toBe("different-environment");
    expect(
      selectContext([claim], "2026-03-01T00:00:00Z", { os: "mac" }).items,
    ).toEqual([]);
    expect(
      selectContext(
        [{ ...claim, validFrom: null, validTo: null }],
        "2026-03-01T00:00:00Z",
        {},
      ).unknownTime,
    ).toEqual(["c1"]);
  });
  it("KE-05/08 duplicate derived answers do not increase independent roots", () => {
    const nodes = [
      { id: "e1", parentIds: [], root: "source:s1:v1" },
      { id: "e2", parentIds: ["e1"], root: null },
      { id: "e3", parentIds: ["e2", "e1"], root: null },
    ] as Evidence[];
    expect(lineageRoots(nodes, "e3")).toEqual(["source:s1:v1"]);
    expect(() =>
      lineageRoots(
        [
          { id: "e1", parentIds: ["e2"], root: null },
          { id: "e2", parentIds: ["e1"], root: null },
        ] as Evidence[],
        "e1",
      ),
    ).toThrow("CIRCULAR_EVIDENCE");
    expect(() => lineageRoots(nodes, "missing")).toThrow("EVIDENCE_MISSING");
  });
});
