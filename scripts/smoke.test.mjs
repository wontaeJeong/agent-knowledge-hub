import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkStaticSite } from "./smoke.mjs";

const html =
  '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/brand/favicon.svg">';
const assets = {
  "/": ["text/html", html],
  "/assets/app.js": ["application/javascript", "console.log('fixture')"],
  "/assets/app.css": ["text/css", "body { color: black }"],
  "/brand/favicon.svg": [
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  ],
};
async function fixture(t, overrides = {}) {
  const routes = { ...assets, ...overrides };
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    res.writeHead(route ? 200 : 404, {
      "Content-Type": route?.[0] || "text/plain",
    });
    res.end(route?.[1] || "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("smoke accepts a complete static build served over HTTP", async (t) => {
  await checkStaticSite(await fixture(t));
});
for (const url of ["/assets/app.js", "/assets/app.css", "/brand/favicon.svg"]) {
  test(`smoke rejects missing referenced asset ${url}`, async (t) => {
    await assert.rejects(
      checkStaticSite(await fixture(t, { [url]: null })),
      /404/,
    );
  });
}
test("smoke rejects SPA HTML fallback masquerading as JavaScript", async (t) => {
  await assert.rejects(
    checkStaticSite(
      await fixture(t, { "/assets/app.js": ["text/html", html] }),
    ),
    /Content-Type/,
  );
});
test("smoke rejects fallback success for an unknown file", async (t) => {
  await assert.rejects(
    checkStaticSite(
      await fixture(t, { "/__smoke_missing__.txt": ["text/html", html] }),
    ),
    /404/,
  );
});
test("smoke rejects an empty application shell", async (t) => {
  await assert.rejects(
    checkStaticSite(await fixture(t, { "/": ["text/html", "<html></html>"] })),
    /root|script/,
  );
});

async function runCLI(cwd, port, args = []) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./smoke.mjs", import.meta.url)), ...args],
    {
      cwd,
      env: { ...process.env, AGENT_KNOWLEDGE_HUB_DEMO_PORT: String(port) },
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { status, output };
}
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
for (const broken of [false, true]) {
  test(
    `local smoke stops its demo child after ${broken ? "failure" : "success"}`,
    { timeout: 15000 },
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "knowledge-smoke-"));
      const port = await freePort();
      try {
        for (const [url, [, body]] of Object.entries(assets)) {
          if (broken && url === "/assets/app.js") continue;
          const filename = join(
            cwd,
            "dist",
            url === "/" ? "index.html" : url.slice(1),
          );
          await mkdir(join(filename, ".."), { recursive: true });
          await writeFile(filename, body);
        }
        const result = await runCLI(cwd, port);
        assert.equal(result.status, broken ? 1 : 0, result.output);
        await assert.rejects(
          fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(1000),
          }),
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}
test(
  "local smoke reports a missing build without hanging",
  { timeout: 15000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "knowledge-no-build-"));
    try {
      const result = await runCLI(cwd, await freePort());
      assert.equal(result.status, 1);
      assert.match(result.output, /npm.*build/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
test("URL-mode CLI propagates a failed HTTP check", async (t) => {
  const base = await fixture(t, { "/assets/app.js": null });
  const result = await runCLI(process.cwd(), 8080, [base]);
  assert.equal(result.status, 1);
  assert.match(result.output, /404/);
});
