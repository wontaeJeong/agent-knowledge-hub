/** Public introduction and explicit, isolated application entry points. */
export const workspaceHref = "/?app=1";
export const demoHref = "/?demo=1";

export const previewHref = "/?preview=1";
export function entryMode(
  search: string,
): "landing" | "workspace" | "demo" | "preview" {
  const params = new URLSearchParams(search);
  if (params.get("demo") === "1") return "demo";
  if (params.get("app") === "1") return "workspace";
  return params.get("preview") === "1" ? "preview" : "landing";
}
