import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import LandingPage from "./LandingPage";
import { entryMode } from "../entry";

test("public introduction renders without an API, authentication or browser storage", () => {
  const network = vi.spyOn(globalThis, "fetch");
  try {
    const html = renderToStaticMarkup(<LandingPage />);
    expect(network).not.toHaveBeenCalled();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const ids = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    );
    const links = [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) =>
      match[1].replaceAll("&amp;", "&"),
    );
    for (const link of links.filter((link) => link.startsWith("#")))
      expect(ids.has(link.slice(1)), `missing target ${link}`).toBe(true);
    for (const mode of ["workspace", "demo"])
      expect(
        links.some(
          (link) =>
            entryMode(new URL(link, "https://example.test").search) === mode,
        ),
      ).toBe(true);
    expect(html).not.toContain("/api/");
  } finally {
    network.mockRestore();
  }
});
