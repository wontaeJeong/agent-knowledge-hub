import { expect, test } from "vitest";
import { entryMode, workspaceHref, demoHref } from "./entry";

test("public and informational links stay on the landing page without opting into a client", () => {
  for (const search of [
    "",
    "?app=0",
    "?demo=0",
    "?utm_source=wiki",
    "?app=true",
  ])
    expect(entryMode(search)).toBe("landing");
});

test("explicit workspace and demo links preserve their separate clients", () => {
  expect(entryMode(new URL(workspaceHref, "https://example.test").search)).toBe(
    "workspace",
  );
  expect(entryMode(new URL(demoHref, "https://example.test").search)).toBe(
    "demo",
  );
  expect(entryMode("?app=1&demo=1")).toBe("demo");
  expect(entryMode("?app=1&demo=0")).toBe("workspace");
});
