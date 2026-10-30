import paths from "./brand-mark.json";

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Palette-aware favicon; /brand/favicon.svg stays as the no-JS fallback. */
export function brandFaviconSvg(primary: string, secondary: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${paths.outerPath}" fill="none" stroke="${escapeAttribute(primary)}" stroke-width="${paths.outerStrokeWidth}" stroke-linejoin="round"/><path d="${paths.innerPath}" fill="none" stroke="${escapeAttribute(secondary)}" stroke-width="${paths.innerStrokeWidth}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** Sync SVG favicon with active root design tokens; the CSP allows img-src data:. */
export function watchBrandFavicon(): () => void {
  const icon = document.querySelector<HTMLLinkElement>(
    'link[rel="icon"][type="image/svg+xml"]',
  );
  if (!icon) return () => {};
  const update = () => {
    const tokens = getComputedStyle(document.documentElement);
    const primary = tokens.getPropertyValue("--brand-mark-primary").trim();
    const secondary = tokens.getPropertyValue("--brand-mark-secondary").trim();
    if (!primary || !secondary) return;
    icon.href = `data:image/svg+xml,${encodeURIComponent(brandFaviconSvg(primary, secondary))}`;
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-palette", "class", "style"],
  });
  return () => observer.disconnect();
}
