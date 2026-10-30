/** Public introduction and explicit, isolated application entry points. */
export const workspaceHref = "/?app=1";
export const demoHref = "/?demo=1";

export function entryMode(search: string): "landing" | "workspace" | "demo" {
  const params = new URLSearchParams(search);
  if (params.get("demo") === "1") return "demo";
  return params.get("app") === "1" ? "workspace" : "landing";
}
