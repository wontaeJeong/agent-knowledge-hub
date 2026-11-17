import { z } from "zod";
import { Marked } from "marked";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

const resourceId = /^[a-zA-Z0-9_-]{1,100}$/;
/** z.record drops __proto__; preserve every legal own key at all lineage boundaries. */
export const dependencyVersions = z.custom<Record<string, number>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 100 &&
    Object.entries(value).every(
      ([key, version]) =>
        resourceId.test(key) &&
        Number.isSafeInteger(version) &&
        (version as number) > 0,
    ),
);
export function mergeDependencyVersions(...inputs: Record<string, number>[]) {
  const pins = new Map<string, number>();
  for (const input of inputs)
    for (const [id, version] of Object.entries(
      dependencyVersions.parse(input),
    )) {
      if (pins.has(id) && pins.get(id) !== version)
        throw Error("STALE_VERSION");
      pins.set(id, version);
    }
  return dependencyVersions.parse(Object.fromEntries(pins));
}

/** Trusted deployment configuration only. Omission permits relative links only. */
export function referenceOrigin(value?: string) {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("POLICY_CONFIGURATION");
  return url.origin;
}

/** Parse visible Markdown links using the reader’s raw-HTML exclusion policy.
 * Code examples remain excluded; external origins, paths and spaces are not relations. */
export function internalReferences(
  content: string,
  workspaceId: string,
  trustedOrigin?: string,
) {
  const baseOrigin = trustedOrigin ?? "https://workspace.invalid";
  const links: {targetPageId:string;label:string;sourceBlockId:null}[] = [];
  const tree = parseFragment(new Marked({renderer:{html:()=>""}}).parse(content, { async: false }));
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node) {
      if (["code", "pre", "script", "style", "template"].includes(node.tagName))
        return;
      if (node.tagName === "a") {
        const href = node.attrs.find(
          (attribute) => attribute.name === "href",
        )?.value;
        // Only runtime-owned deployment configuration can authorize absolute or
        // network-path links. Without it, the sentinel resolves relative links only.
        if (
          href &&
          (trustedOrigin ||
            (!URL.canParse(href) && !/^[\\/]{2}/.test(href.trim())))
        ) {
          let url: URL | undefined;
          try {
            url = new URL(href, baseOrigin + "/");
          } catch {
            /* Not a navigable URL. */
          }
          const target = url?.searchParams.get("document");
          if (
            url?.origin === baseOrigin &&
            url.pathname === "/" &&
            url.searchParams.get("app") === "1" &&
            url.searchParams.get("space") === workspaceId &&
            target
          )
            links.push({targetPageId:target,label:nodeText(node).slice(0,1000),sourceBlockId:null});
        }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(tree);
  return links;
}

function nodeText(node: DefaultTreeAdapterTypes.Node): string {
  if ('value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(nodeText).join('') : '';
}
export function internalReferenceIds(content:string,workspaceId:string,trustedOrigin?:string){
 return new Set(internalReferences(content,workspaceId,trustedOrigin).map(r=>r.targetPageId));
}

/** Canonical proposal relation set, shared with reviewable restore projections. */
export function effectiveReferenceIds(content:string,workspaceId:string,relations:string[],origin?:string) {
  return [...new Set([...relations,...internalReferenceIds(content,workspaceId,origin)])];
}
