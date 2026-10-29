import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handleModel } from "./model-api.mjs";
const root = fs.existsSync("dist/index.html")
  ? path.resolve("dist")
  : path.resolve("demo-dist");
if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error("Packaged build not found. Run npm ci && npm run build first.");
  process.exit(1);
}
const port = Number(process.env.AGENT_KNOWLEDGE_HUB_DEMO_PORT || 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("AGENT_KNOWLEDGE_HUB_DEMO_PORT must be 1024..65535");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (await handleModel(req, res, pathname)) return;
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405);
    return res.end();
  }
  const file = path.resolve(
    root,
    "." + (pathname === "/" ? "/index.html" : pathname),
  );
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file).pipe(res);
  });
});
server.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `agent-knowledge-hub demo: http://127.0.0.1:${port}\nLocal synthetic demo only. Ctrl+C to stop.`,
  ),
);
