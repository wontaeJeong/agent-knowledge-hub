import { expect, test } from "vitest";
import { entryMode } from "../entry";
import { readConsoleTab, summarizeConsole } from "./console";

test("preview is explicit and cannot silently replace a workspace or demo", () => {
  expect(entryMode("?preview=1")).toBe("preview");
  expect(entryMode("?preview=0")).toBe("landing");
  expect(entryMode("?app=1&preview=1")).toBe("workspace");
  expect(entryMode("?demo=1&preview=1")).toBe("demo");
});
test("console deep links normalize unknown and malformed routes", () => {
  expect(readConsoleTab("#users")).toBe("users");
  expect(readConsoleTab("#query")).toBe("query");
  expect(readConsoleTab("#%ZZ")).toBe("overview");
  expect(readConsoleTab("")).toBe("overview");
});
test("overview preserves pending publication, own failures and unexecuted lint", () => {
  expect(
    summarizeConsole({
      pages: [{ id: "a" }],
      sources: [],
      changes: [
        { status: "pending" },
        { status: "approved" },
        { status: "published" },
      ],
      jobs: [
        { status: "failed" },
        { status: "cancelled" },
        { status: "running" },
      ],
      issues: null,
    }),
  ).toEqual({
    pages: 1,
    sources: 0,
    pending: 1,
    approved: 1,
    failedJobs: 1,
    runningJobs: 1,
    issues: null,
  });
});
