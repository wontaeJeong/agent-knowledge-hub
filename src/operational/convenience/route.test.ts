import { expect, test } from "vitest";
import * as route from "./route";
const parse = (search: string, hash = "") =>
  route.parseConvenienceLocation(search, hash);

test.each([
  [
    "?app=1&space=team&document=page",
    "",
    { kind: "document", spaceId: "team", document: "page" },
  ],
  [
    "?app=1&space=team&document=page",
    "#comment-c1",
    { kind: "document", spaceId: "team", document: "page", comment: "c1" },
  ],
  [
    "?app=1&space=team&document=page",
    "#share-s1",
    { kind: "document", spaceId: "team", document: "page", share: "s1" },
  ],
  [
    "?app=1&space=team&document=page",
    "#workflows",
    { kind: "document", spaceId: "team", document: "page", tab: "workflows" },
  ],
  [
    "?app=1&space=team",
    "#discovery",
    { kind: "console", spaceId: "team", tab: "discovery" },
  ],
  [
    "?app=1&space=team&document=page&version=3&anchor=paragraph-2",
    "",
    {
      kind: "document",
      spaceId: "team",
      document: "page",
      version: 3,
      anchor: "paragraph-2",
    },
  ],
])(
  "preserves the exact legacy or version destination %s%s",
  (search, hash, expected) => {
    expect(parse(search, hash)).toEqual(expected);
  },
);

test.each([
  "home",
  "favorites",
  "recent",
  "subscriptions",
  "search",
  "compose",
  "tasks",
  "saved-views",
])("opens the explicit %s section", (section) => {
  expect(parse(`?app=1&space=team&section=${section}`)).toEqual({
    kind: "section",
    spaceId: "team",
    section,
  });
});
test.each(["review", "job", "access-request"])(
  "retains the exact %s task across URL building",
  (targetKind) => {
    const location = parse(
      `?app=1&space=team&section=tasks&targetKind=${targetKind}&targetId=target-26`,
    );
    expect(location).toEqual({
      kind: "section",
      spaceId: "team",
      section: "tasks",
      targetKind,
      targetId: "target-26",
    });
    expect(location && route.convenienceHref(location)).toBe(
      `/?app=1&space=team&section=tasks&targetKind=${targetKind}&targetId=target-26`,
    );
  },
);
test("preserves only opaque draft and personal view identities", () => {
  expect(parse("?space=team&section=compose&draft=d1")).toEqual({
    kind: "section",
    spaceId: "team",
    section: "compose",
    draft: "d1",
  });
  expect(parse("?space=team&section=saved-views&view=v1")).toEqual({
    kind: "section",
    spaceId: "team",
    section: "saved-views",
    view: "v1",
  });
});
test.each([
  "?space=team&document=page&draft=d1",
  "?space=team&document=page&section=compose",
  "?space=team&document=page&version=0",
  "?space=team&document=page&version=1.5",
  "?space=team&document=page&version=9007199254740992",
  "?space=team&version=1",
  "?space=team&section=unknown",
  "?section=home",
  "?document=page",
  "?space=../secret&section=home",
  "?space=team&section=tasks&targetKind=job",
  "?space=team&section=home&targetKind=job&targetId=id",
  "?space=team&section=tasks&targetKind=admin&targetId=id",
  "?space=team&section=tasks&targetKind=job&targetId=../hidden",
  "?space=team&section=home&view=v1",
  "?space=team&section=home&section=tasks",
  "?space=team&document=page&anchor=",
])("rejects malformed or contradictory destinations %s", (search) => {
  expect(parse(search)).toMatchObject({ kind: "invalid" });
});
test("rejects comment/share destinations without a document", () => {
  expect(parse("?space=team", "#comment-c1")).toMatchObject({
    kind: "invalid",
  });
});

test("legacy workflow document links round-trip their tab intent", () => {
  const location = parse("?app=1&space=team&document=page", "#workflows");
  expect(location && route.convenienceHref(location)).toBe(
    "/?app=1&space=team&document=page#workflows",
  );
});

test.each([
  "targetKind=job",
  "targetId=j1",
  "targetKind=job&targetId=j1",
  "targetKind=",
])("rejects orphan task query keys without a tasks section: %s", (query) => {
  expect(parse(`?space=team&${query}`)).toMatchObject({ kind: "invalid" });
});

test("standalone share links preserve their stable target without inventing a document", () => {
  const location = parse("?app=1&space=team", "#share-s1");
  expect(location).toEqual({ kind: "share", spaceId: "team", share: "s1" });
  expect(route.convenienceHref(location)).toBe("/?app=1&space=team#share-s1");
});
test.each([
  "?app=1",
  "?space=team&section=tasks",
  "?space=team&draft=d1",
  "?space=team&version=2",
  "?space=team&targetKind=job&targetId=j1",
])("rejects contradictory standalone share location %s", (search) => {
  expect(parse(search, "#share-s1")).toMatchObject({ kind: "invalid" });
});

test.each([
  ["?app=1&space=team", "workspace", "home"],
  ["?app=1", "workspace", "home"],
  ["?app=1&preview=1&space=team", "workspace", "home"],
  ["?preview=1", "preview", "overview"],
  ["?preview=1&space=team", "preview", "overview"],
] as const)(
  "implicit %s landing preserves meaning through its generated %s href",
  (search, mode, tab) => {
    const location = parse(search);
    expect(location).toMatchObject({ kind: "console", tab });
    const generated = new URL(
      route.convenienceHref(location, mode),
      "https://workspace.invalid",
    );
    expect(parse(generated.search, generated.hash)).toEqual(location);
    expect(generated.hash).not.toBe("#home");
  },
);
test.each(["workspace", "preview"] as const)(
  "%s explicit operations and unknown legacy hash keep their meaning",
  (mode) => {
    for (const hash of ["#overview", "#unknown", "#%ZZ"]) {
      const location = parse(
        `?${mode === "preview" ? "preview" : "app"}=1&space=team`,
        hash,
      );
      expect(location).toMatchObject({ kind: "console", tab: "overview" });
      const generated = new URL(
        route.convenienceHref(location, mode),
        "https://workspace.invalid",
      );
      expect(parse(generated.search, generated.hash)).toEqual(location);
    }
  },
);

test("serializer refuses a workspace-only implicit Home in preview rather than generating a drifting URL", () => {
  expect(() =>
    route.convenienceHref(
      { kind: "console", spaceId: "team", tab: "home" },
      "preview",
    ),
  ).toThrow();
});
