// @vitest-environment jsdom
import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Markdown,
  renderMarkdown,
  sanitizeDiagram,
  validateDiagram,
} from "./Markdown";
it("preserves Markdown tables, code and links without executing HTML or automatically fetching resources", () => {
  const markdown =
    '| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = "<img>";\n```\n\n[내부](/?app=1&document=topic)\n\n![내부 그림](/api/v1/storage/blobs/image-a)\n\n![외부](https://external.invalid/x.png)\n<img src="https://external.invalid/raw.png" onerror="alert(1)"><script>alert(1)</script>';
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(markdown);
  expect(container.querySelectorAll("table tr")).toHaveLength(2);
  expect(container.querySelector("code")?.textContent).toBe(
    'const x = "<img>";\n',
  );
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "/?app=1&document=topic",
  );
  expect(container.querySelectorAll("img,script,iframe,object")).toHaveLength(
    0,
  );
  expect(
    container.querySelector('[data-attachment="image-a"]')?.textContent,
  ).toContain("내부 그림");
  expect(markdown).toContain("![내부 그림](/api/v1/storage/blobs/image-a)");
});
it("renders bounded inline and block math as local MathML and leaves fenced code intact", () => {
  const html = renderMarkdown(
    "수식 $x^2$\n\n$$\\frac{1}{2}$$\n\n```txt\n$x^2$\n```",
  );
  const el = document.createElement("div");
  el.innerHTML = html;
  expect(el.querySelectorAll("math")).toHaveLength(2);
  expect(el.querySelector("code")?.textContent).toBe("$x^2$\n");
  const hostile = renderMarkdown(
    "$\\href{javascript:alert(1)}{x}$ $\\includegraphics{https://external.invalid/x.png}$",
  );
  expect(hostile).not.toContain('href="javascript');
  expect(hostile).not.toContain("<img");
});
it("admits documented flowcharts and sequences but blocks directives, external references and callbacks", () => {
  expect(() =>
    validateDiagram("flowchart LR\n A[자료] --> B[검토]"),
  ).not.toThrow();
  expect(() =>
    validateDiagram("sequenceDiagram\n Alice->>Bob: Review"),
  ).not.toThrow();
  for (const source of [
    '%%{init:{securityLevel:"loose"}}%%\nflowchart LR\n A-->B',
    "flowchart LR\n click A call evil()",
    "flowchart LR\n A[<img src=x>]",
    'flowchart LR\n A@{img:"https://x.invalid/a.png"}',
    "---\nconfig:\n securityLevel: loose\n---\nflowchart LR\n A-->B",
    'pie\n "a":1',
  ])
    expect(() => validateDiagram(source)).toThrow();
  const sanitized = sanitizeDiagram(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><iframe src="https://x.invalid"/></foreignObject><image href="https://x.invalid/a.png"/><a href="javascript:alert(1)"><text>x</text></a><style>@import url(https://x.invalid/a.css);</style><path style="fill:url(https://x.invalid/a.svg)" d="M0 0"/></svg>',
  );
  const el = document.createElement("div");
  el.innerHTML = sanitized;
  expect(
    el.querySelectorAll("script,foreignObject,image,a,style,iframe"),
  ).toHaveLength(0);
  expect(sanitized).not.toContain("https://");
});
it("shows supported syntax and image access boundary in the shared reading component", () => {
  const html = renderToStaticMarkup(
    <Markdown text="![자료](/api/v1/storage/blobs/a)" />,
  );
  expect(html).toContain('data-attachment="a"');
  expect(html).not.toContain("<img");
});
it("retains diagram source for the mounted renderer including HTML-looking and multiline labels", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(
    "```mermaid\nflowchart LR\n A[원본] --> B[검토]\n```",
  );
  expect(root.querySelector<HTMLElement>("[data-diagram]")?.textContent).toBe(
    "flowchart LR\n A[원본] --> B[검토]",
  );
});

it("does not duplicate the raw TeX annotation in visible MathML", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown("$x^2$");
  expect(root.querySelector("math")?.textContent).not.toContain("x^2");
});
it("bounds automatic diagram and formula work while preserving excess source as code", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdown(
    "```mermaid\nflowchart LR\n A-->B\n```\n\n".repeat(11) + "$x$ ".repeat(129),
  );
  expect(root.querySelectorAll("[data-diagram]")).toHaveLength(10);
  expect(root.querySelectorAll("math")).toHaveLength(128);
  expect(root.textContent).toContain("flowchart LR");
});
