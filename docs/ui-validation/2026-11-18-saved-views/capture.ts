import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Pool } from "pg";
import * as oidc from "openid-client";
import { adoptFixture, fixture } from "../../../server/test-support";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import { OidcAuth, sessionHash } from "../../../server/runtime/auth";
import { createRuntimeJobs } from "../../../server/jobs/runtime";
import { sourceHashes } from "../2026-11-18-document-reader/manifest.mjs";

const out = "docs/ui-validation/2026-11-18-saved-views";
const base = new URL(process.env.TEST_DATABASE_URL ?? "");
if (
  process.env.AKH_C11_SYNTHETIC !== "1" ||
  !["localhost", "127.0.0.1"].includes(base.hostname) ||
  !base.pathname.includes("test")
)
  throw Error("Explicit loopback test database required");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const database = "akh_c11_test_ui_" + randomUUID().replaceAll("-", "");
const admin = new Pool({ connectionString: base.href });
await admin.query('CREATE DATABASE "' + database + '"');
base.pathname = "/" + database;
process.env.TEST_DATABASE_URL = base.href;
const pools: Pool[] = [];
const provider = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const actor = req.headers.authorization?.slice("Bearer ".length);
  res.end(JSON.stringify({ sub: actor, groups: ["reviewers"] }));
});
const server = createServer();
let browser: any, jobs: ReturnType<typeof createRuntimeJobs> | undefined;
const addr = (s: typeof server) =>
  "http://127.0.0.1:" + (s.address() as { port: number }).port;
const start = async (s: typeof server) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
};
const stop = async (s: typeof server) => {
  if (s.listening) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
};
try {
  const f = await fixture();
  pools.push(f.pool);
  await adoptFixture(f.pool, f.workspaceId);
  const other = await fixture();
  pools.push(other.pool);
  await adoptFixture(other.pool, other.workspaceId);
  await start(provider);
  await start(server);
  const origin = addr(server),
    issuer = addr(provider);
  const config = new oidc.Configuration(
    { issuer, userinfo_endpoint: issuer + "/userinfo" },
    "fixture",
    "synthetic",
  );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(f.pool, config, origin, f.workspaceId, {
      reviewers: "reviewer",
    }),
    service = new RuntimeService(f.pool);
  jobs = createRuntimeJobs(f.pool, service, {
    referenceOrigin: origin,
    workerCount: 1,
    revalidateInteractiveGrant: auth.revalidateInteractiveGrant.bind(auth),
    assertInteractiveGrant: auth.assertInteractiveGrant.bind(auth),
  });
  const handler = createRuntimeHandler({
    pool: f.pool,
    service,
    auth,
    jobs,
    origin,
    workspaceId: f.workspaceId,
  });
  const dist = resolve("dist"),
    types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    };
  server.on("request", async (req, res) => {
    const path = new URL(req.url ?? "/", origin).pathname;
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      void handler(req, res);
      return;
    }
    const local = resolve(dist, "." + (path === "/" ? "/index.html" : path));
    if (!local.startsWith(dist + "/")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(local);
      res
        .writeHead(200, {
          "Content-Type": types[extname(local)] ?? "application/octet-stream",
        })
        .end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  async function session(actor: string, space: string) {
    const raw = randomUUID();
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,$4,now()+interval '1 hour',$3,$3)",
      [sessionHash(raw), space, actor, randomUUID()],
    );
    return { name: "akh_session", value: raw, url: origin, httpOnly: true };
  }
  browser = await chromium.launch({ headless: true });
  const results: object[] = [];
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        timezoneId: "Asia/Seoul",
        colorScheme: theme,
      });
      try {
        await context.addCookies([await session("reader", f.workspaceId)]);
        await context.addInitScript(
          (t: string) => localStorage.setItem("agent-knowledge-hub.theme", t),
          theme,
        );
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        const term = "기존",
          name = "운영 자료 " + width + " " + theme;
        await page.goto(
          origin + "/?app=1&space=" + f.workspaceId + "&section=search",
        );
        const input = page.getByLabel("제목·본문 키워드");
        await input.fill(term);
        await page.getByLabel("보기 이름").fill(name);
        await page.keyboard.press("Tab");
        assert.equal(
          await page.locator(":focus").textContent(),
          "개인 보기 저장",
        );
        await page.keyboard.press("Enter");
        await page.waitForURL(/view=/);
        const exact = page.url();
        const saved = page.getByRole("region", { name: "개인 저장 보기" });
        await saved
          .getByRole("button", { name: "주제", exact: true })
          .waitFor();
        assert.equal(
          await saved.getByLabel("제목·본문 키워드").inputValue(),
          term,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.theme),
          theme,
        );
        await saved.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: out + "/" + width + "-" + theme + "-view.png",
        });
        assert.equal(new URL(exact).searchParams.size, 4);
        for (const q of [name, term])
          assert.equal(
            await page.evaluate(
              (q: string) =>
                decodeURIComponent(location.href).includes(q) ||
                JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
                  q,
                ),
              q,
            ),
            false,
          );
        await saved.getByRole("link", { name: "목록으로" }).click();
        const link = saved.getByRole("link", { name, exact: true });
        await link.waitFor();
        await link.focus();
        await page.screenshot({
          path: out + "/" + width + "-" + theme + "-list.png",
        });
        await page.keyboard.press("Enter");
        await saved
          .getByRole("button", { name: "주제", exact: true })
          .waitFor();
        const id = new URL(exact).searchParams.get("view")!;
        const viewApi = origin + "/api/v1/convenience/views/" + id;
        const before = await (await context.request.get(viewApi)).json();
        const me = await (
          await context.request.get(origin + "/api/v1/me")
        ).json();
        const competing = await context.request.patch(viewApi, {
          headers: { Origin: origin, "X-CSRF-Token": me.csrfToken },
          data: {
            name: name + " 수정",
            filters: before.filters,
            sort: before.sort,
            expectedRevision: before.revision,
            mutationId: randomUUID(),
          },
        });
        assert.equal(competing.status(), 200);
        await saved.getByRole("button", { name: "보기 변경 저장" }).click();
        await saved.getByText(/목록이 변경되었습니다/).waitFor();
        await saved.getByRole("button", { name: "다시 불러오기" }).click();
        await saved
          .getByRole("heading", { name: name + " 수정", exact: true })
          .waitFor();
        await saved.getByLabel("보기 이름").fill(name);
        await saved.getByRole("button", { name: "보기 변경 저장" }).click();
        await saved.getByRole("heading", { name, exact: true }).waitFor();
        await saved.getByRole("link", { name: "목록으로" }).click();
        await saved
          .getByRole("button", { name: "최근 변경", exact: true })
          .click();
        const extra = name + " 순서 확인";
        await saved.getByLabel("보기 이름").fill(extra);
        await saved.getByRole("button", { name: "개인 보기 저장" }).click();
        await saved
          .getByRole("heading", { name: extra, exact: true })
          .waitFor();
        await saved.getByRole("link", { name: "목록으로" }).click();
        const move = saved.getByRole("button", { name: extra + " 위로" });
        await move.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          ({ a, b }: { a: string; b: string }) => {
            const links = [
              ...document.querySelectorAll("[data-view-row] a"),
            ].map((el) => el.textContent);
            return links.includes(a) && links.indexOf(a) < links.indexOf(b);
          },
          { a: extra, b: name },
        );
        await saved.getByRole("button", { name: extra + " 삭제" }).click();
        await saved.getByRole("button", { name: "삭제 확인" }).click();
        await saved
          .getByRole("link", { name: extra, exact: true })
          .waitFor({ state: "detached" });
        // A replacement cookie is a real second runtime session with the same owner.
        await context.addCookies([await session("reader", f.workspaceId)]);
        await page.goto(exact);
        await saved
          .getByRole("button", { name: "주제", exact: true })
          .waitFor();
        await f.pool.query(
          "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reader'",
          [f.workspaceId],
        );
        await page.reload();
        await saved.getByText("0건 표시", { exact: true }).waitFor();
        assert.equal(
          await saved
            .getByRole("button", { name: "주제", exact: true })
            .count(),
          0,
        );
        await f.pool.query(
          "INSERT INTO resource_readers VALUES($1,'source','source-a','reader')",
          [f.workspaceId],
        );
        await context.addCookies([await session("editor", f.workspaceId)]);
        await page.goto(exact);
        await saved.getByRole("alert").waitFor();
        assert.equal(await saved.getByLabel("보기 이름").count(), 0);
        await context.addCookies([await session("reader", other.workspaceId)]);
        const switched = new URL(exact);
        switched.searchParams.set("space", other.workspaceId);
        await page.goto(switched.href);
        await saved.getByRole("alert").waitFor();
        assert.equal(await saved.getByLabel("보기 이름").count(), 0);
        assert.deepEqual(errors, []);
        results.push({
          width,
          theme,
          keyboardSave: true,
          keyboardReopen: true,
          keyboardReorder: true,
          confirmedDelete: true,
          conflictRefreshAndEdit: true,
          relogin: true,
          sourceRevoked: true,
          otherOwnerDenied: true,
          otherSpaceDenied: true,
          privateStorageAndUrl: true,
        });
      } finally {
        await context.close();
      }
    }
  const source = await sourceHashes(),
    artifacts: Record<string, string> = {};
  for (const file of (await readdir(out)).filter((f) => f.endsWith(".png")))
    artifacts[file] = createHash("sha256")
      .update(await readFile(out + "/" + file))
      .digest("hex");
  await writeFile(
    out + "/browser-results.json",
    JSON.stringify(
      {
        productionFingerprint: source.productionFingerprint,
        browser: browser.version(),
        postgres: (await f.pool.query("SHOW server_version")).rows[0]
          .server_version,
        results,
        artifacts,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  if (browser) await browser.close();
  if (jobs) await jobs.stop();
  await stop(server);
  await stop(provider);
  await Promise.all(pools.map((p) => p.end()));
  await admin.query('DROP DATABASE "' + database + '"');
  await admin.end();
}
