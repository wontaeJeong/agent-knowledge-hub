import { renderMarkdown } from "../../ui/Markdown";
export interface BlockReference {
  id: string;
  hash: string;
  startLine: number;
  endLine: number;
  beforeHash: string | null;
  afterHash: string | null;
  stable: boolean;
  kind: string;
}
export interface OutlineItem {
  id: string;
  title: string;
  level: number;
  blockId: string | null;
}
export interface DocumentMatch {
  index: number;
  text: string;
  start: number;
}

export const matchLimit = 1000;
export const searchableText = (root: Node) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      !node.parentElement?.closest(
        "math,svg,[data-diagram],button,figure,[role=status],.markdown-help",
      )
    )
      nodes.push(node);
  }
  return nodes;
};
export function blockForElement(element: Element, blocks: BlockReference[]) {
  const wrapper = element.closest<HTMLElement>("[data-document-start]");
  if (!wrapper) return null;
  const start = Number(wrapper.dataset.documentStart),
    end = Number(wrapper.dataset.documentEnd);
  // Only exact, one-to-one rendered ranges are shareable. Custom math may
  // split a plain Markdown token; old coarse metadata must never be guessed.
  const candidates = blocks.filter(
    (block) =>
      block.stable && block.startLine === start && block.endLine === end,
  );
  if (candidates.length !== 1) return null;
  const siblings =
    wrapper.parentElement?.querySelectorAll<HTMLElement>(
      "[data-document-start]",
    ) ?? [];
  const overlaps = [...siblings].filter(
    (node) =>
      Number(node.dataset.documentStart) <= end &&
      Number(node.dataset.documentEnd) >= start,
  );
  return overlaps.length === 1 && overlaps[0] === wrapper
    ? candidates[0]
    : null;
}
export function buildDocumentOutline(
  markdown: string,
  blocks: BlockReference[],
  rendered?: HTMLElement,
): OutlineItem[] {
  const root = rendered ?? document.createElement("div");
  if (!rendered) root.innerHTML = renderMarkdown(markdown);
  return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .slice(0, 1000)
    .map((element, index) => ({
      id: `document-section-${index}`,
      title: element.textContent ?? "",
      level: Number(element.tagName[1]),
      blockId: blockForElement(element, blocks)?.id ?? null,
    }));
}
export function findDocumentMatches(
  markdown: string,
  query: string,
): DocumentMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(markdown);
  const matches: DocumentMatch[] = [];
  for (const node of searchableText(root)) {
    const text = node.textContent ?? "",
      lower = text.toLocaleLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0 && matches.length < matchLimit) {
      matches.push({
        index: matches.length,
        text: text.slice(at, at + needle.length),
        start: at,
      });
      at = lower.indexOf(needle, at + needle.length);
    }
    if (matches.length === matchLimit) break;
  }
  return matches;
}
