import { expect, test } from "vitest";
import { entryMode } from "../entry";
import { readConsoleTab, summarizeConsole } from "./console";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleShell } from "./ConsoleShell";

test("preview is explicit and cannot silently replace a workspace or demo", () => {
  expect(entryMode("?preview=1")).toBe("preview");
  expect(entryMode("?preview=0")).toBe("landing");
  expect(entryMode("?app=1&preview=1")).toBe("workspace");
  expect(entryMode("?demo=1&preview=1")).toBe("demo");
});
test("console deep links normalize unknown and malformed routes", () => {
  expect(readConsoleTab("#users")).toBe("users");
  expect(readConsoleTab("#query")).toBe("query");
  expect(readConsoleTab("#workflows")).toBe("workflows");
  expect(readConsoleTab("#refinement")).toBe("refinement");
  expect(readConsoleTab("#access")).toBe("access");
  expect(readConsoleTab("#boards")).toBe("boards");
  expect(readConsoleTab("#%ZZ")).toBe("overview");
  expect(readConsoleTab("")).toBe("overview");
});
test("console shell retains workflow navigation alongside existing management tabs", () => {
  const html = renderToStaticMarkup(createElement(ConsoleShell, {
    preview: true,
    tab: "workflows",
    navigate: () => {},
    account: null,
    children: null,
  }));
  for (const tab of ["overview", "imports", "workflows", "refinement", "access", "coverage"])
    expect(html).toContain(`href="#${tab}"`);
  expect(html.match(/href="#access"/g)).toHaveLength(1);
  expect(html).toContain("실제 서버에 연결하지 않습니다");
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
