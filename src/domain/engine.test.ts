import { describe, it, expect } from "vitest";
import { seed } from "./seed";
import { reduce, latest, resolveShare, visiblePages } from "./engine";
const fresh = () => structuredClone(seed);
describe("demo domain invariants", () => {
  it("creates a source-backed proposal without publishing", () => {
    const s = reduce(fresh(), { type: "RUN", kind: "Daily" });
    expect(s.changes).toHaveLength(1);
    expect(s.changes[0].sourceIds).toContain("src-python");
    expect(latest(s.pages[0]).number).toBe(1);
  });
  it("does not duplicate unchanged ingests", () => {
    const a = reduce(fresh(), { type: "RUN", kind: "Daily" });
    const b = reduce(a, { type: "RUN", kind: "Weekly" });
    expect(b.changes).toHaveLength(1);
    expect(b.runs[0].changes).toBe(0);
  });
  it("requires approval before publishing", () => {
    const s = reduce(fresh(), { type: "RUN", kind: "Daily" });
    expect(() => reduce(s, { type: "PUBLISH", id: s.changes[0].id })).toThrow(
      /승인/,
    );
  });
  it("publishes once and preserves provenance", () => {
    let s = reduce(fresh(), { type: "RUN", kind: "Daily" });
    const id = s.changes[0].id;
    s = reduce(s, { type: "APPROVE", id });
    s = reduce(s, { type: "PUBLISH", id });
    expect(latest(s.pages[0]).sourceIds).toEqual(["src-ca", "src-python"]);
    expect(latest(s.pages[0]).number).toBe(2);
    const again = reduce(s, { type: "PUBLISH", id });
    expect(latest(again.pages[0]).number).toBe(2);
  });
  it("blocks stale proposal after manual editing", () => {
    let s = reduce(fresh(), { type: "RUN", kind: "Daily" });
    s = reduce(s, { type: "APPROVE", id: s.changes[0].id });
    s = reduce(s, {
      type: "SAVE_PAGE",
      id: "container-ca",
      content: "human change",
      baseVersion: 1,
    });
    s = reduce(s, { type: "PUBLISH", id: s.changes[0].id });
    expect(s.changes[0].status).toBe("conflict");
    expect(latest(s.pages[0]).content).toBe("human change");
  });
  it("restores as new version preserving current scope", () => {
    let s = fresh();
    s.pages[0].scope = "team";
    s = reduce(s, {
      type: "SAVE_PAGE",
      id: "container-ca",
      content: "edit",
      baseVersion: 1,
    });
    s = reduce(s, { type: "RESTORE", id: "container-ca", version: 1 });
    expect(latest(s.pages[0]).number).toBe(3);
    expect(latest(s.pages[0]).content).toBe(seed.pages[0].versions[0].content);
    expect(s.pages[0].scope).toBe("team");
  });
  it("does not grant reviewer powers to editor", () => {
    let s = reduce(fresh(), { type: "RUN", kind: "Daily" });
    s.role = "editor";
    expect(() => reduce(s, { type: "APPROVE", id: s.changes[0].id })).toThrow(
      /검토자/,
    );
  });
  it("denies reader writes and hides private demo pages", () => {
    const s = fresh();
    s.role = "reader";
    expect(visiblePages(s).every((p) => p.scope === "company")).toBe(true);
    expect(() => reduce(s, { type: "RUN", kind: "Daily" })).toThrow(/독자/);
  });
  it("rejects cross-scope source promotion", () => {
    const s = fresh();
    expect(() =>
      reduce(s, {
        type: "ADD_SOURCE",
        source: { ...s.sources[1], id: "private", scope: "private" },
      }),
    ).toThrow(/제한 자료/);
  });
  it("rejects stale manual edits", () => {
    const s = reduce(fresh(), {
      type: "SAVE_PAGE",
      id: "container-ca",
      content: "first",
      baseVersion: 1,
    });
    expect(() =>
      reduce(s, {
        type: "SAVE_PAGE",
        id: "container-ca",
        content: "second",
        baseVersion: 1,
      }),
    ).toThrow(/먼저/);
  });
  it("fixed links stay pinned while latest links update", () => {
    let s = fresh();
    s.shares = [
      {
        id: "fixed",
        pageId: "container-ca",
        version: 1,
        expiresAt: "2099-01-01",
        revoked: false,
      },
      {
        id: "latest",
        pageId: "container-ca",
        expiresAt: "2099-01-01",
        revoked: false,
      },
    ];
    s = reduce(s, {
      type: "SAVE_PAGE",
      id: "container-ca",
      content: "second",
      baseVersion: 1,
    });
    expect(resolveShare(s, "fixed")?.version.number).toBe(1);
    expect(resolveShare(s, "latest")?.version.number).toBe(2);
  });
  it("denies revoked, expired and missing share tokens", () => {
    const s = fresh();
    s.shares = [
      {
        id: "old",
        pageId: "container-ca",
        expiresAt: "2001-01-01",
        revoked: false,
      },
      {
        id: "revoked",
        pageId: "container-ca",
        expiresAt: "2099-01-01",
        revoked: true,
      },
    ];
    for (const token of ["old", "revoked", "unknown"])
      expect(resolveShare(s, token)).toBeNull();
  });
});
