import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { Pool } from "pg";
import * as oidc from "openid-client";
import { validateBaseUrl } from "../../../scripts/test-server.mjs";
import { adoptFixture, fixture } from "../../../server/test-support";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { createRuntimeHandler } from "../../../server/runtime/http";
import { OidcAuth, sessionHash } from "../../../server/runtime/auth";
import { createRuntimeJobs } from "../../../server/jobs/runtime";
import { approveLocalTransmissionFixture } from "../../../server/policy/test-fixture";
import { fileURLToPath } from "node:url";
import { createCollaborationHost } from "../../../server/runtime/collaboration-host";

const base = validateBaseUrl(process.env.TEST_DATABASE_URL);
assert(
  process.env.AKH_C12_SYNTHETIC === "1" &&
    ["localhost", "127.0.0.1"].includes(base.hostname) &&
    base.pathname.includes("test"),
);
for (const key of Object.keys(process.env))
  if (key.startsWith("AGENT_KNOWLEDGE_HUB_LLM_")) delete process.env[key];
process.env.IMPORT_DISCLOSURE_REVIEWERS = "reviewer";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const out = new URL("./", import.meta.url);
const database = "akh_c12_test_" + randomUUID().replaceAll("-", "");
const admin = new Pool({ connectionString: base.href });
await admin.query('CREATE DATABASE "' + database + '"');
base.pathname = "/" + database;
process.env.TEST_DATABASE_URL = base.href;
const results: { step: string; observed: unknown }[] = [];
const mark = (step: string, observed: unknown) => {
  results.push({ step, observed });
  console.log(step, observed);
};
let failedModelCalls = 0;
const model = createServer(async (req, res) => {
  for await (const _ of req) {
  }
  failedModelCalls++;
  res
    .writeHead(503, { "content-type": "application/json" })
    .end(JSON.stringify({ error: "fixture unavailable" }));
});
const app = createServer(),
  issuer = createServer((req, res) => {
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({
          sub: req.headers.authorization?.slice(7),
          groups: ["reviewers"],
        }),
      );
  });
const url = (s: typeof app) =>
  "http://127.0.0.1:" + (s.address() as { port: number }).port;
const start = async (s: typeof app) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
};
const stop = async (s: typeof app) => {
  if (s.listening) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
};
let pool: Pool | undefined,
  browser: any,
  jobs: ReturnType<typeof createRuntimeJobs> | undefined,
  phase = "fixture",
  page: any;
try {
  const f = await fixture();
  pool = f.pool;
  await adoptFixture(pool, f.workspaceId);
  await pool.query(
    "INSERT INTO access_source_policy(workspace_id,source_id,local_copy_allowed,export_allowed) VALUES($1,'source-a',true,false)",
    [f.workspaceId],
  );
  await start(issuer);
  await start(app);
  await start(model);
  const endpoint = url(model) + "/v1";
  Object.assign(process.env, {
    AGENT_KNOWLEDGE_HUB_LLM_BASE_URL: endpoint,
    AGENT_KNOWLEDGE_HUB_LLM_MODEL: "c12-fixture",
    AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION: "true",
    AGENT_KNOWLEDGE_HUB_LLM_DESTINATION_ID: "c12-loopback",
  });
  await approveLocalTransmissionFixture(
    pool,
    f.workspaceId,
    endpoint + "/chat/completions",
    ["query"],
    "c12-loopback",
  );
  const origin = url(app),
    issuerUrl = url(issuer),
    config = new oidc.Configuration(
      { issuer: issuerUrl, userinfo_endpoint: issuerUrl + "/userinfo" },
      "fixture",
      "synthetic",
    );
  oidc.allowInsecureRequests(config);
  const auth = new OidcAuth(pool, config, origin, f.workspaceId, {
      reviewers: "reviewer",
    }),
    service = new RuntimeService(pool);
  const dispatcher = "c12-" + randomUUID();
  await pool.query(
    "INSERT INTO access_principals(id,kind,active) VALUES($1,'service',true)",
    [dispatcher],
  );
  const collaboration = createCollaborationHost(pool, origin, {
    dispatcherId: dispatcher,
  });
  jobs = createRuntimeJobs(pool, service, {
    referenceOrigin: origin,
    workerCount: 1,
    revalidateInteractiveGrant: auth.revalidateInteractiveGrant.bind(auth),
    assertInteractiveGrant: auth.assertInteractiveGrant.bind(auth),
  });
  const handler = createRuntimeHandler({
    pool,
    service,
    auth,
    jobs,
    origin,
    workspaceId: f.workspaceId,
    collaboration: collaboration.service,
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
  app.on("request", async (req, res) => {
    const path = new URL(req.url ?? "/", origin).pathname;
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      void handler(req, res);
      return;
    }
    const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(dist + "/")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      res
        .writeHead(200, {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
        })
        .end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  browser = await chromium.launch({ headless: true });
  async function actor(id: string) {
    const raw = randomUUID(),
      csrf = randomUUID(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
      });
    await f.pool.query(
      "INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,$3,$4,now()+interval '1 hour',$3,$3)",
      [sessionHash(raw), f.workspaceId, id, csrf],
    );
    await context.addCookies([
      { name: "akh_session", value: raw, url: origin, httpOnly: true },
    ]);
    const p = await context.newPage();
    p.setDefaultTimeout(9000);
    const api = (path: string, body?: object) =>
      p.evaluate(
        async ({ path, body, space, csrf }: any) => {
          const r = await fetch("/api/v1" + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "content-type": "application/json",
              "x-space-id": space,
              "x-csrf-token": csrf,
              "idempotency-key": crypto.randomUUID(),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: r.status, body: await r.json() };
        },
        { path, body, space: f.workspaceId, csrf },
      );
    return { p, api, sessionId: sessionHash(raw) };
  }
  const author = await actor("editor"),
    review = await actor("reviewer"),
    reader = await actor("reader");
  page = author.p;
  const goto = (p: any, q: string) =>
    p.goto(origin + "/?app=1&space=" + f.workspaceId + "&" + q);
  const button = (p: any, name: string) =>
    p.getByRole("button", { name, exact: true });
  const label = (p: any, name: string) => p.getByLabel(name, { exact: true });
  const title = "통합검토 " + randomUUID().slice(0, 8);
  const initialBody = "서버에 저장한 첫 본문";
  const body =
    "## 연결 검토\n\n[주제](/?app=1&space=" +
    f.workspaceId +
    "&document=topic)";
  mark("environment", {
    browser: browser.version(),
    postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
    viewport: "390x844",
    workspace: f.workspaceId,
  });
  await goto(page, "section=home");
  phase = "model outage";
  const semantic = await author.api("/search/semantic", {
    filters: { query: "주제" },
    idempotency_key: randomUUID(),
  });
  assert.equal(semantic.status, 202, JSON.stringify(semantic));
  await jobs.worker.tick();
  const receipt = await author.api("/jobs-v2/" + semantic.body.id);
  assert.equal(receipt.status, 200);
  assert(failedModelCalls > 0, JSON.stringify(receipt));
  assert.equal(receipt.body.status, "queued");
  assert.equal(
    receipt.body.errorCode ?? receipt.body.error,
    "MODEL_UNAVAILABLE",
  );
  assert(!receipt.body.result);
  mark("model provider outage", {
    job: semantic.body.id,
    http: 503,
    calls: failedModelCalls,
    status: receipt.body.status,
    error: receipt.body.errorCode ?? receipt.body.error ?? null,
  });
  phase = "create and save";
  await goto(page, "section=compose");
  await label(page, "문서 제목").fill(title);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.locator(":focus").getAttribute("aria-label"),
    "대상 위치",
  );
  await label(page, "Markdown 본문").fill(initialBody);
  await button(page, "개인 초안 저장").click();
  await page.waitForURL(/draft=/);
  const exact = page.url(),
    draft = new URL(exact).searchParams.get("draft");
  await page.reload();
  await page.waitForFunction(
    (value: string) =>
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Markdown 본문"]',
      )?.value === value,
    initialBody,
  );
  mark("saved draft reopened", {
    draft,
    bodyRestored: true,
    keyboardTarget: "대상 위치",
  });
  phase = "unsent recovery";
  await page.getByText("허용된 입력만 최대 5분간", { exact: false }).waitFor();
  const saveRoute = "**/api/v1/workflows/drafts";
  await page.route(saveRoute, async (route: any) => {
    if (route.request().method() === "POST")
      await route.abort("internetdisconnected");
    else await route.continue();
  });
  await label(page, "Markdown 본문").fill(body);
  await page.getByRole("status").filter({ hasText: "연결 중단" }).waitFor();
  await page.unroute(saveRoute);
  await page.reload();
  const recovery = button(page, "이전 입력 복구");
  await recovery.waitFor();
  await page.screenshot({
    path: fileURLToPath(new URL("390-recovery.png", out)),
  });
  await recovery.click();
  assert.equal(await label(page, "Markdown 본문").inputValue(), body);
  await button(page, "개인 초안 저장").click();
  await page.getByRole("status").filter({ hasText: "서버에 저장됨" }).waitFor();
  mark("unsent recovery", {
    draft,
    source: "blocked draft POST",
    userConfirmed: true,
  });
  phase = "shared-source review";
  await label(page, "독립 공개 검토자").selectOption("reviewer");
  await label(page, "추가 대상 독자 ID").fill("reader");
  await label(page, "요청 사유").fill("합성 인수 검토");
  await button(page, "고정 본문과 독자로 공개 검토 요청").click();
  await page
    .getByRole("status")
    .filter({ hasText: "원본 공개 검토 대기" })
    .waitFor();
  await goto(review.p, "section=compose");
  const article = review.p
    .getByRole("article")
    .filter({
      has: review.p.getByRole("heading", { name: new RegExp(title) }),
    });
  await label(article, "검토 사유 " + title).fill("본문과 고정 독자를 검토함");
  await button(article, "원본 공개 승인").click();
  await article.waitFor({ state: "hidden" });
  await button(page, "검토 상태 새로고침").click();
  await button(page, "지식 검토 요청").click();
  const href = await page
    .getByRole("link", { name: "변경 검토에서 확인" })
    .getAttribute("href");
  assert(href);
  const received = (
    await author.api("/workflows/draft-disclosures")
  ).body.items.find((i: any) => i.draftId === draft);
  assert(received.submission);
  const pageId = "document-" + received.id,
    batch = received.submission.batchId;
  mark("disclosure approval and knowledge proposal", {
    draft,
    disclosure: received.id,
    batch,
    pageId,
  });
  phase = "knowledge approval and publication";
  await review.p.goto(new URL(href, origin).href);
  await button(review.p, "승인").click();
  await button(review.p, "승인 집합 발행").click();
  await review.p
    .getByText("변경 집합 전체를 발행했습니다.", { exact: true })
    .waitFor();
  const published = await pool.query(
    "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2",
    [f.workspaceId, pageId],
  );
  assert.equal(published.rowCount, 1);
  assert.equal(published.rows[0].data.content, body);
  mark("published", {
    batch,
    pageId,
    version: published.rows[0].data.number,
    producer: published.rows[0].data.producer.kind,
  });
  phase = "IME search and favorite";
  await goto(page, "section=search");
  const query = label(page, "제목·본문 키워드");
  let composing = true,
    earlyRequests = 0;
  page.on("request", (r: any) => {
    if (
      composing &&
      r.url().endsWith("/questions/search") &&
      r.postData()?.includes(title)
    )
      earlyRequests++;
  });
  await query.focus();
  await query.dispatchEvent("compositionstart");
  await query.fill(title);
  await page.waitForTimeout(350);
  await query.dispatchEvent("compositionend");
  composing = false;
  assert.equal(earlyRequests, 0);
  const result = button(page, title);
  await result.focus();
  await page.keyboard.press("Enter");
  await page
    .locator("[data-document-heading]")
    .filter({ hasText: title })
    .waitFor();
  await button(page, "즐겨찾기 추가").click();
  await button(page, "즐겨찾기 해제").waitFor();
  await goto(page, "section=favorites");
  const fav = page.getByRole("link", { name: title, exact: true });
  await fav.focus();
  await page.keyboard.press("Enter");
  await page
    .locator("[data-document-heading]")
    .filter({ hasText: title })
    .waitFor();
  mark("search and favorite revisit", {
    pageId,
    syntheticComposition: true,
    keyboard: "Enter",
  });
  phase = "backlink navigation";
  const target = page
    .locator('a[href*="document=topic"]')
    .filter({ hasText: "주제" })
    .first();
  await target.click();
  await page
    .locator("[data-document-heading]")
    .filter({ hasText: "주제" })
    .waitFor();
  await page.getByText("연결·백링크·관련 문서", { exact: true }).click();
  await page
    .getByRole("region", { name: "이 문서를 참조하는 문서" })
    .getByRole("link", { name: title })
    .click();
  await page
    .locator("[data-document-heading]")
    .filter({ hasText: title })
    .waitFor();
  mark("published backlink round-trip", {
    from: pageId,
    to: "topic",
    back: pageId,
  });
  phase = "comment and inbox";
  const note = "같은 문서 검토 댓글";
  await label(page, "댓글").fill(note);
  await label(page, "멘션할 사용자 ID (쉼표 구분)").fill("reviewer");
  await button(page, "댓글 등록").click();
  await page.getByText(note, { exact: true }).waitFor();
  await collaboration.service.scanEvents();
  await goto(review.p, "#notifications");
  const notification = review.p
    .locator(".inbox-list li")
    .filter({ hasText: title })
    .first();
  await notification.waitFor();
  await notification.locator("a").first().click();
  await review.p.getByText(note, { exact: true }).waitFor();
  const fragment = new URL(review.p.url()).hash;
  assert.match(fragment, /^#comment-[\w-]+$/);
  assert((await review.p.locator(fragment).innerText()).includes(note));
  await review.p.screenshot({
    path: fileURLToPath(new URL("390-comment.png", out)),
  });
  mark("comment and recipient inbox", {
    pageId,
    exactComment: fragment.slice("#comment-".length),
  });
  phase = "resume home";
  await goto(page, "section=home");
  const homeLink = page
    .locator('a[href*="draft="]')
    .filter({ hasText: title })
    .first();
  await homeLink.click();
  await label(page, "문서 제목").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("draft"), draft);
  await goto(page, "section=tasks");
  const taskLink = page
    .locator('[data-home-widget="drafts"] a')
    .filter({ hasText: title })
    .first();
  await taskLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (expected: string) =>
      document.querySelector<HTMLInputElement>('[aria-label="문서 제목"]')
        ?.value === expected,
    title,
  );
  assert.equal(new URL(page.url()).searchParams.get("draft"), draft);
  mark("home and my tasks resume", { draft, keyboard: "Enter" });
  phase = "ordinary withdrawal and expiry";
  await goto(reader.p, "document=" + pageId);
  await reader.p
    .locator("[data-document-heading]")
    .filter({ hasText: title })
    .waitFor();
  const sourceId = published.rows[0].data.sourceIds[0];
  const revoked = await pool.query(
    "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id=$2 AND principal_id='reader'",
    [f.workspaceId, sourceId],
  );
  assert.equal(revoked.rowCount, 1);
  await reader.p.reload();
  const backlinks = await reader.api("/convenience/pages/topic/backlinks");
  assert.equal(backlinks.status, 200);
  assert(!backlinks.body.items.some((i: any) => i.id === pageId));
  const blocked = await reader.api(
    "/workflows/pages/" + pageId + "/navigation",
  );
  assert([403, 404].includes(blocked.status));
  await reader.p.getByText(title, { exact: true }).waitFor({ state: "hidden" });
  mark("source withdrawal", {
    pageId,
    documentReadStatus: blocked.status,
    backlinkHidden: true,
  });
  await pool.query(
    "UPDATE runtime_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [author.sessionId],
  );
  assert.equal((await author.api("/me")).status, 401);
  await pool.query(
    "UPDATE access_principals SET active=false WHERE id='reviewer'",
  );
  assert.equal((await review.api("/me")).status, 401);
  mark("expired session and withdrawn identity", {
    expired: 401,
    inactive: 401,
  });
} catch (e) {
  console.error("phase", phase, e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (jobs) await jobs.stop();
  await stop(app);
  await stop(issuer);
  await stop(model);
  await pool?.end();
  await admin.query('DROP DATABASE "' + database + '"');
  const owned = (
    await admin.query("SELECT datname FROM pg_database WHERE datname=$1", [
      database,
    ])
  ).rowCount;
  assert.equal(owned, 0);
  await admin.end();
  await writeFile(
    new URL("journey.json", out),
    JSON.stringify(
      {
        results,
        lastPhase: phase,
        exitCode: process.exitCode ?? 0,
        ownedDatabaseDropped: true,
      },
      null,
      2,
    ) + "\n",
  );
}
