import { consoleItems, readConsoleTab } from "../console";
import { convenienceSections, type ConvenienceLocation } from "./types";
const id = /^[a-zA-Z0-9_-]{1,100}$/;
const keys = [
  "space",
  "document",
  "section",
  "draft",
  "view",
  "version",
  "anchor",
  "targetKind",
  "targetId",
];
const invalid = (): ConvenienceLocation => ({
  kind: "invalid",
  error: "이동 주소가 올바르지 않습니다. 공간과 대상을 다시 확인하세요.",
});
export function parseConvenienceLocation(
  search: string,
  hash: string,
): ConvenienceLocation {
  const params = new URLSearchParams(search);
  if (keys.some((key) => params.getAll(key).length > 1)) return invalid();
  for (const key of [
    "space",
    "document",
    "draft",
    "view",
    "anchor",
    "targetId",
  ])
    if (params.has(key) && !id.test(params.get(key)!)) return invalid();
  const spaceId = params.get("space") ?? undefined;
  const document = params.get("document"),
    section = params.get("section");
  const draft = params.get("draft"),
    view = params.get("view");
  const version = params.get("version"),
    anchor = params.get("anchor");
  const targetKind = params.get("targetKind"),
    targetId = params.get("targetId");
  if (
    (document ||
      section ||
      draft ||
      view ||
      version !== null ||
      anchor ||
      targetKind ||
      targetId) &&
    !spaceId
  )
    return invalid();
  if (document) {
    if (
      section ||
      draft !== null ||
      view !== null ||
      targetKind !== null ||
      targetId !== null
    )
      return invalid();
    if (
      version !== null &&
      (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version)))
    )
      return invalid();
    const match = hash.match(/^#(comment|share)-([a-zA-Z0-9_-]{1,100})$/);
    if (hash && !match && hash !== "#workflows") return invalid();
    if (match && (version !== null || anchor)) return invalid();
    return {
      kind: "document",
      spaceId: spaceId!,
      document,
      ...(version !== null ? { version: Number(version) } : {}),
      ...(anchor ? { anchor } : {}),
      ...(match ? { [match[1]]: match[2] } : {}),
      ...(hash === "#workflows" ? { tab: "workflows" as const } : {}),
    };
  }
  const standaloneShare = hash.match(/^#share-([a-zA-Z0-9_-]{1,100})$/);
  if (standaloneShare) {
    if (
      !spaceId ||
      section !== null ||
      draft !== null ||
      view !== null ||
      version !== null ||
      anchor !== null ||
      targetKind !== null ||
      targetId !== null
    )
      return invalid();
    return { kind: "share", spaceId, share: standaloneShare[1] };
  }
  if (version !== null || anchor || /^#(?:comment|share)-/.test(hash))
    return invalid();
  if (section !== null) {
    if (!convenienceSections.some((value) => value === section) || hash)
      return invalid();
    if (
      (draft !== null && section !== "compose") ||
      (view !== null && section !== "saved-views")
    )
      return invalid();
    if (targetKind !== null || targetId !== null) {
      if (
        section !== "tasks" ||
        !targetId ||
        !["review", "job", "access-request"].includes(targetKind ?? "")
      )
        return invalid();
      return {
        kind: "section",
        spaceId: spaceId!,
        section,
        targetKind: targetKind as "review" | "job" | "access-request",
        targetId,
      };
    }
    return {
      kind: "section",
      spaceId: spaceId!,
      section,
      ...(draft ? { draft } : {}),
      ...(view ? { view } : {}),
    } as ConvenienceLocation;
  }
  if (
    draft !== null ||
    view !== null ||
    targetKind !== null ||
    targetId !== null
  )
    return invalid();
  return {
    kind: "console",
    ...(spaceId ? { spaceId } : {}),
    tab: readConsoleTab(hash),
  };
}
export function convenienceHref(
  location: ConvenienceLocation,
  mode: "workspace" | "preview" = "workspace",
): string {
  if (location.kind === "invalid") throw Error(location.error);
  const params = new URLSearchParams(
    mode === "preview" ? { preview: "1" } : { app: "1" },
  );
  if (location.spaceId) params.set("space", location.spaceId);
  let hash = "";
  if (location.kind === "console") hash = `#${location.tab}`;
  if (location.kind === "share") hash = `#share-${location.share}`;
  if (location.kind === "document") {
    params.set("document", location.document);
    if (location.version !== undefined)
      params.set("version", String(location.version));
    if (location.anchor) params.set("anchor", location.anchor);
    if (location.comment) hash = `#comment-${location.comment}`;
    if (location.share) hash = `#share-${location.share}`;
    if (location.tab) hash = `#${location.tab}`;
  }
  if (location.kind === "section") {
    params.set("section", location.section);
    if ("draft" in location && location.draft)
      params.set("draft", location.draft);
    if ("view" in location && location.view) params.set("view", location.view);
    if (location.section === "tasks" && location.targetKind) {
      params.set("targetKind", location.targetKind);
      params.set("targetId", location.targetId);
    }
  }
  const href = `/?${params}${hash}`;
  if (parseConvenienceLocation(`?${params}`, hash).kind === "invalid")
    throw Error("이동 주소가 올바르지 않습니다.");
  return href;
}
export const isLegacyConsoleHash = (hash: string) =>
  consoleItems.some((item) => hash === `#${item.id}`);
