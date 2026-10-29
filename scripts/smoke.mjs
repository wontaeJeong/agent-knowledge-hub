import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function request(base, pathname) {
  return fetch(new URL(pathname, base), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
}

export async function checkStaticSite(base) {
  const response = await request(base, "/");
  assert.equal(response.status, 200, "HTML: expected HTTP 200");
  assert.match(response.headers.get("content-type") || "", /text\/html/i);
  const html = await response.text();
  assert.match(html, /id=["']root["']/, "HTML: missing application root");
  assert.match(
    html,
    /<script\b[^>]*src=["']\/assets\/[^"']+\.js["']/i,
    "HTML: missing built script",
  );
  assert.match(
    html,
    /href=["']\/assets\/[^"']+\.css["']/i,
    "HTML: missing built stylesheet",
  );
  const paths = new Set(
    [
      ...html.matchAll(/(?:src|href)=["'](\/(?:assets|brand)\/[^"']+)["']/g),
    ].map((match) => match[1]),
  );
  const mimeTypes = {
    js: /(?:application|text)\/javascript/i,
    css: /text\/css/i,
    svg: /image\/svg\+xml/i,
    ico: /image\/(?:x-icon|vnd.microsoft.icon)/i,
    png: /image\/png/i,
    webmanifest: /application\/(?:manifest\+)?json/i,
  };
  for (const pathname of paths) {
    const asset = await request(base, pathname);
    assert.equal(
      asset.status,
      200,
      `${pathname}: expected HTTP 200, got ${asset.status}`,
    );
    const type = mimeTypes[pathname.split(".").at(-1)];
    if (type)
      assert.match(
        asset.headers.get("content-type") || "",
        type,
        `${pathname}: wrong Content-Type`,
      );
    assert.ok(
      (await asset.arrayBuffer()).byteLength > 0,
      `${pathname}: empty asset`,
    );
  }
  const missing = await request(base, "/__smoke_missing__.txt");
  assert.equal(missing.status, 404, "Unknown file: expected HTTP 404");
}

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function checkLocalDemo() {
  const port =
    process.env.AGENT_KNOWLEDGE_HUB_DEMO_PORT || String(await unusedPort());
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./serve-demo.mjs", import.meta.url))],
    {
      env: { ...process.env, AGENT_KNOWLEDGE_HUB_DEMO_PORT: port },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  let output = "";
  child.stderr.on("data", (data) => {
    output += data;
  });
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", ready);
        child.off("error", failed);
        child.off("close", exited);
      };
      const ready = (data) => {
        output += data;
        if (output.includes(`agent-knowledge-hub demo: ${base}\n`)) {
          cleanup();
          resolve();
        }
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const exited = () => failed(new Error(`Demo failed to start: ${output}`));
      const timer = setTimeout(
        () => failed(new Error(`Demo startup timed out: ${output}`)),
        10000,
      );
      child.stdout.on("data", ready);
      child.once("error", failed);
      child.once("close", exited);
    });
    await checkStaticSite(base);
  } finally {
    child.kill();
    await closed;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv[2]) await checkStaticSite(process.argv[2]);
    else await checkLocalDemo();
    console.log(
      "PASS static HTTP smoke: HTML, JS/CSS/brand assets, MIME types, 404",
    );
  } catch (error) {
    console.error(`FAIL static HTTP smoke: ${error.message}`);
    process.exitCode = 1;
  }
}
