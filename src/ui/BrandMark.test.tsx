import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { BrandMark } from "./BrandMark";
import { brandFaviconSvg } from "./brand-favicon";
import paths from "./brand-mark.json";

test("the theme-aware mark retains the approved original Folio Wiki geometry", () => {
  const original = readFileSync(
    new URL("../../brand-kit/mark-light.svg", import.meta.url),
    "utf8",
  );
  const html = renderToStaticMarkup(<BrandMark size={38} />);
  expect(original).toContain(`d="${paths.outerPath}"`);
  expect(original).toContain(`d="${paths.innerPath}"`);
  expect(original).toContain(`stroke-width="${paths.outerStrokeWidth}"`);
  expect(original).toContain(`stroke-width="${paths.innerStrokeWidth}"`);
  expect(html).toContain(`d="${paths.outerPath}"`);
  expect(html).toContain(`d="${paths.innerPath}"`);
  expect(html).toContain('stroke="var(--brand-mark-primary)"');
  expect(html).toContain('stroke="var(--brand-mark-secondary)"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('width="38"');
  expect((html.match(/<path /g) || [])).toHaveLength(2);
  expect(html).not.toMatch(/stroke="#[0-9a-f]+"/i);
});

test("the inline mark supports an accessible standalone title", () => {
  const html = renderToStaticMarkup(<BrandMark title="agent-knowledge-hub" />);
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="agent-knowledge-hub"');
  expect(html).not.toContain('aria-hidden="true"');
});

test("favicon uses the same vector paths but any palette colors", () => {
  const ocean = brandFaviconSvg("#2261a5", "#85c5ff");
  expect(ocean).toContain(`d="${paths.outerPath}"`);
  expect(ocean).toContain(`d="${paths.innerPath}"`);
  expect(ocean).toContain('stroke="#2261a5"');
  expect(ocean).toContain('stroke="#85c5ff"');
  expect(ocean).not.toContain("#78469e");
  expect(brandFaviconSvg('" /><script', "#123456")).toContain("&quot;");
});

test("brand mark tokens delegate to the semantic accent in both modes", () => {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  expect(css.match(/--brand-mark-primary:\s*var\(--color-accent\);/g)).toHaveLength(2);
  expect(css.match(/--brand-mark-secondary:\s*var\(--color-accent-strong\);/g)).toHaveLength(2);
});
