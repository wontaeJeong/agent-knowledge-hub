// Real browser -> canonical APIs, with explicit synthetic authentication adapter.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { Pool } from "pg";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
if (
  process.env.AKH_C6_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic capture opt-in required");
const fixture = JSON.parse(
  await readFile("/private/tmp/akh_c6_browser.json", "utf8"),
);
if (!/^akh_c6_ui_[a-f0-9]{32}$/.test(fixture.database))
  throw Error("Owned DB required");
const url = new URL(process.env.TEST_DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.includes("test")
)
  throw Error("Loopback test DB required");
url.pathname = "/" + fixture.database;
const db = new Pool({ connectionString: url.href });
const output = "docs/ui-validation/2026-11-17-new-document",
  results = [];
const profiles = [];
let contexts = [];
async function make(width, theme, actor, profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width, height: width === 1440 ? 1000 : 844 },
    timezoneId: "Asia/Seoul",
  });
  contexts.push(context);
  context.setDefaultTimeout(10000);
  const state = { offline: false, posts: [], errors: [], external: [] };
  await context.route("**/api/**", async (route) => {
    const request = route.request(),
      u = new URL(request.url());
    if (request.method() === "POST")
      state.posts.push({
        path: u.pathname,
        body: request.postDataJSON(),
        at: Date.now(),
      });
    if (state.offline) {
      await route.abort("internetdisconnected");
      return;
    }
    const response = await route.fetch({
      url: `http://127.0.0.1:4396${u.pathname}${u.search}`,
      headers: {
        ...request.headers(),
        cookie: `synthetic-${actor}`,
        origin: "http://127.0.0.1:5196",
      },
    });
    if (
      request.method() === "GET" &&
      u.pathname === "/api/v1/workflows/drafts" &&
      state.holdDrafts
    )
      await state.holdDrafts;
    await route.fulfill({ response });
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => state.errors.push(e.message));
  page.on("request", (r) => {
    if (
      r.url().startsWith("http") &&
      !r.url().startsWith("http://127.0.0.1:5196/")
    )
      state.external.push(r.url());
  });
  const go = async (space, draft) => {
    await page.goto(
      `http://127.0.0.1:5196/?app=1&space=${space}&section=compose${draft ? "&draft=" + draft : ""}`,
    );
    await page.getByLabel("문서 제목", { exact: true }).waitFor();
    await page.evaluate(
      (t) => (document.documentElement.dataset.theme = t),
      theme,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      theme,
    );
  };
  const api = async (path, body) =>
    page.evaluate(
      async ({ path, body }) => {
        const r = await fetch("/api/v1" + path, {
          method: body === undefined ? "GET" : "POST",
          headers:
            body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": "test-only-csrf",
                  ...(path.endsWith("/publish")
                    ? { "Idempotency-Key": crypto.randomUUID() }
                    : {}),
                },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: r.status, body: await r.json() };
      },
      { path, body },
    );
  return { context, page, state, go, api };
}
try {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const profile = await mkdtemp("/private/tmp/akh_c6_profile_");
      profiles.push(profile);
      let ui = await make(width, theme, "editor", profile);
      let { page, state } = ui;
      await ui.go(fixture.workspaceId);
      console.log("Started", width, theme);
      const globalNew = page.getByRole("button", {
        name: "새 문서",
        exact: true,
      });
      await globalNew.focus();
      await page.keyboard.press("Enter");
      await page.getByLabel("문서 제목", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("section"), "compose");
      assert.equal(new URL(page.url()).searchParams.has("draft"), false);
      await page.getByLabel("문서 제목", { exact: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "대상 위치",
      );
      const title = `합성 새 문서 ${width} ${theme} ${crypto.randomUUID().slice(0,8)}`;
      await page.getByLabel("문서 제목", { exact: true }).fill(title);
      await page
        .getByLabel("Markdown 본문", { exact: true })
        .fill("# 수동 작성\n\n검토할 업무 절차입니다.");
      await page
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      await page.waitForFunction(() =>
        new URL(location.href).searchParams.has("draft"),
      );
      const draftId = new URL(page.url()).searchParams.get("draft");
      assert(draftId);
      const privateRows = await ui.api("/workflows/drafts");
      assert.equal(privateRows.status, 200);
      assert(
        privateRows.body.items.some(
          (d) => d.id === draftId && d.title === title,
        ),
      );
      const searched = await ui.api("/questions/search", { query: title });
      assert.equal(searched.status, 200);
      assert(
        !searched.body.items.some(
          (x) => x.title === title || x.pageId === draftId,
        ),
      );
      const nav = await ui.api("/workflows/pages/topic/navigation");
      assert.equal(nav.status, 200);
      assert(!JSON.stringify(nav.body).includes(title));
      await page.getByRole("button", { name: "미리보기", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("heading", { name: "수동 작성", exact: true })
        .waitFor();
      await page.screenshot({fullPage:true,
        path: `${output}/preview-${width}-${theme}.png`,
      });
      await page
        .getByRole("button", { name: "본문 편집", exact: true })
        .click();
      await page
        .getByText("허용된 입력만 최대 5분간", { exact: false })
        .waitFor();
      const beforeIme = state.posts.filter(
        (p) => p.path === "/api/v1/workflows/drafts",
      ).length;
      await page.getByLabel("Markdown 본문", { exact: true }).focus();
      await page
        .getByLabel("Markdown 본문", { exact: true })
        .press("ControlOrMeta+End");
      const cdp = await ui.context.newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "한",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await page.waitForTimeout(1100);
      assert.equal(
        state.posts.filter((p) => p.path === "/api/v1/workflows/drafts").length,
        beforeIme,
      );
      await cdp.send("Input.insertText", { text: "한국어 확정" });
      await page
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      state.offline = true;
      const unsent = "# 미전송 복구\n\n연결 중단 중 입력한 내용";
      await page.getByLabel("Markdown 본문", { exact: true }).fill(unsent);
      await page.getByRole("status").filter({ hasText: "연결 중단" }).waitFor();
      assert(
        (
          await page.evaluate(() => Object.values(localStorage).join(""))
        ).includes(unsent.replaceAll("\n", "\\n")),
      );
      await page.screenshot({fullPage:true,
        path: `${output}/offline-${width}-${theme}.png`,
      });
      await ui.context.close();
      contexts = contexts.filter((c) => c !== ui.context);
      ui = await make(width, theme, "editor", profile);
      ({ page, state } = ui);
      await ui.go(fixture.workspaceId, draftId);
      await page
        .getByRole("button", { name: "이전 입력 복구", exact: true })
        .waitFor();
      console.log("Restart recovered", width, theme);
      await page
        .getByRole("button", { name: "이전 입력 복구", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("Markdown 본문", { exact: true }).inputValue(),
        unsent,
      );
      await page
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      // A second real tab changes the same server draft; the first keeps both sides.
      const tab = await ui.context.newPage();
      await tab.goto(page.url());
      await tab.getByLabel("Markdown 본문", { exact: true }).waitFor();
      await tab
        .getByLabel("Markdown 본문", { exact: true })
        .fill("다른 탭의 서버 본문");
      await tab
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await tab
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      let releaseDrafts;
      state.holdDrafts = new Promise((resolve) => {
        releaseDrafts = resolve;
      });
      await page
        .getByLabel("Markdown 본문", { exact: true })
        .fill("내 탭의 미전송 본문");
      await page
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await page.getByRole("region", { name: "초안 충돌" }).waitFor();
      assert.equal(
        await page
          .getByRole("button", {
            name: "내 입력으로 새 저장 요청",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      releaseDrafts();
      state.holdDrafts = null;
      await page.waitForFunction(
        () =>
          document.querySelector('textarea[aria-label="서버 본문"]')?.value ===
          "다른 탭의 서버 본문",
      );
      assert.equal(
        await page
          .getByRole("region", { name: "초안 충돌" })
          .locator("textarea")
          .nth(0)
          .inputValue(),
        "다른 탭의 서버 본문",
      );
      assert.equal(
        await page
          .getByRole("region", { name: "초안 충돌" })
          .locator("textarea")
          .nth(1)
          .inputValue(),
        "내 탭의 미전송 본문",
      );
      assert.equal(
        await page
          .getByRole("button", {
            name: "내 입력으로 새 저장 요청",
            exact: true,
          })
          .isEnabled(),
        true,
      );
      await page.screenshot({fullPage:true,
        path: `${output}/conflict-${width}-${theme}.png`,
      });
      await page
        .getByRole("button", { name: "내 입력으로 새 저장 요청", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      await tab.close();
      await page
        .getByLabel("독립 공개 검토자", { exact: true })
        .selectOption("reviewer");
      await page
        .getByLabel("요청 사유", { exact: true })
        .fill("합성 업무 절차 검토");
      await page
        .getByRole("button", {
          name: "고정 본문과 독자로 공개 검토 요청",
          exact: true,
        })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: "원본 공개 검토 대기" })
        .waitFor();
      await page.screenshot({fullPage:true,
        path: `${output}/disclosure-${width}-${theme}.png`,
      });
      const reviewerProfile = await mkdtemp("/private/tmp/akh_c6_profile_");
      profiles.push(reviewerProfile);
      const reviewer = await make(width, theme, "reviewer", reviewerProfile);
      await reviewer.go(fixture.workspaceId);
      const reviewArticle = reviewer.page
        .getByRole("article")
        .filter({
          has: reviewer.page.getByRole("heading", { name: new RegExp(title) }),
        });
      await reviewArticle
        .getByRole("button", { name: "원본 공개 승인", exact: true })
        .click();
      assert.equal(
        (await reviewer.api("/workflows/drafts")).body.items.some(
          (d) => d.id === draftId,
        ),
        false,
      );
      await page
        .getByRole("button", { name: "검토 상태 새로고침", exact: true })
        .click();
      await page
        .getByRole("button", { name: "지식 검토 요청", exact: true })
        .click();
      await page
        .getByRole("link", { name: "변경 검토에서 확인", exact: true })
        .waitFor();
      const disclosure = (
        await ui.api("/workflows/draft-disclosures")
      ).body.items.find((d) => d.draftId === draftId);
      assert(disclosure.submission);
      const batchId = disclosure.submission.batchId;
      const hash = disclosure.submission.hash;
      assert.equal(
        (await reviewer.api(`/changesets/${batchId}/approve`, { hash })).status,
        200,
      );
      assert.equal(
        (await reviewer.api(`/changesets/${batchId}/publish`, { hash })).status,
        200,
      );
      const published = await db.query(
        "SELECT data FROM versions WHERE workspace_id=$1 AND page_id=$2",
        [fixture.workspaceId, "document-" + disclosure.id],
      );
      assert.equal(published.rows[0].data.content, "내 탭의 미전송 본문");
      assert.equal(published.rows[0].data.producer.kind, "user-submission");
      await reviewer.context.close();
      contexts = contexts.filter((c) => c !== reviewer.context);
      // Owner-only namespace follows explicit raw confirmation and separate knowledge approval.
      const personalProfile = await mkdtemp("/private/tmp/akh_c6_profile_");
      profiles.push(personalProfile);
      const personal = await make(width, theme, "personal", personalProfile);
      await personal.go(fixture.personalId);
      await personal.page
        .getByLabel("문서 제목", { exact: true })
        .fill(`개인 합성 ${width} ${theme}`);
      await personal.page
        .getByLabel("Markdown 본문", { exact: true })
        .fill("본인 전용 수동 지식");
      await personal.page
        .getByRole("button", { name: "개인 초안 저장", exact: true })
        .click();
      await personal.page
        .getByRole("status")
        .filter({ hasText: "서버에 저장됨" })
        .waitFor();
      await personal.page
        .getByLabel("요청 사유", { exact: true })
        .fill("본인 전용 검토");
      await personal.page
        .getByRole("button", { name: "본인 전용 원본 확인 요청", exact: true })
        .click();
      await personal.page
        .getByRole("button", {
          name: "본인 전용 원본 명시적 확인",
          exact: true,
        })
        .click();
      await personal.page.getByRole("status").filter({hasText:"원본 공개 승인됨"}).waitFor();
      await personal.page.screenshot({fullPage:true,
        path: `${output}/personal-${width}-${theme}.png`,
      });
      await personal.page
        .getByRole("button", { name: "지식 검토 요청", exact: true })
        .click();
      await personal.page
        .getByRole("link", { name: "변경 검토에서 확인", exact: true })
        .waitFor();
      const personalId = new URL(personal.page.url()).searchParams.get("draft");
      const pd = (
        await personal.api("/workflows/draft-disclosures")
      ).body.items.find((d) => d.draftId === personalId);
      assert.equal(pd.policyMode, "personal-owner");
      assert.deepEqual(pd.audience, ["editor"]);
      assert.equal(
        (
          await personal.api(`/changesets/${pd.submission.batchId}/approve`, {
            hash: pd.submission.hash,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await personal.api(`/changesets/${pd.submission.batchId}/publish`, {
            hash: pd.submission.hash,
          })
        ).status,
        200,
      );
      // Canonical API evidence, no fabricated job/model completion.
      const calls = await db.query(
        "SELECT count(*)::int n FROM model_usage_events WHERE workspace_id=ANY($1::text[])",
        [[fixture.workspaceId, fixture.personalId]],
      );
      assert.equal(calls.rows[0].n, 0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false);
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.external, []);
      assert.equal(
        await page.getByLabel("문서 제목", { exact: true }).inputValue(),
        title,
      );
      // Revoke an influencing source while the actual browser is closed. A new
      // process must not expose the cached unsent body before online authorization.
      const revokedId = "revoked-" + crypto.randomUUID();
      const restricted = await ui.api("/workflows/drafts", {
        id: revokedId,
        expectedRevision: 0,
        title: "철회할 합성 초안",
        content: "서버 제한 내용",
        sourceIds: ["source-a"],
      });
      assert.equal(restricted.status, 201);
      await ui.go(fixture.workspaceId, revokedId);
      await page
        .getByText("허용된 입력만 최대 5분간", { exact: false })
        .waitFor();
      state.offline = true;
      const revokedText = "C6_REVOKED_UNSENT_" + width + theme;
      await page.getByLabel("Markdown 본문", { exact: true }).fill(revokedText);
      await page.getByRole("status").filter({ hasText: "연결 중단" }).waitFor();
      assert(
        (
          await page.evaluate(() => Object.values(localStorage).join(""))
        ).includes(revokedText),
      );
      await ui.context.close();
      contexts = contexts.filter((c) => c !== ui.context);
      await db.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",
        [fixture.workspaceId],
      );
      ui = await make(width, theme, "editor", profile);
      ({ page, state } = ui);
      await page.goto(
        `http://127.0.0.1:5196/?app=1&space=${fixture.workspaceId}&section=compose&draft=${revokedId}`,
      );
      await page.getByRole("alert").filter({ hasText: "NOT_FOUND" }).waitFor();
      assert(!(await page.locator("body").innerText()).includes(revokedText));
      assert(
        !(
          await page.evaluate(() => Object.values(localStorage).join(""))
        ).includes(revokedText),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "이전 입력 복구", exact: true })
          .count(),
        0,
      );
      await page.evaluate(
        (t) => (document.documentElement.dataset.theme = t),
        theme,
      );
      await page.screenshot({fullPage:true,
        path: `${output}/revoked-${width}-${theme}.png`,
      });
      await db.query(
        "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'source','source-a','editor')",
        [fixture.workspaceId],
      );
      results.push({
        width,
        theme,
        exactDraftId: draftId,
        globalEntryKeyboard: true,
        privateSearchAndBacklinksAbsent: true,
        revokedRestartCacheCleared: true,
        conflictDisabledUntilCanonicalReady: true,
        actualBrowserRestart: true,
        offlineUnsentRecovered: true,
        dualTabConflictBothPreserved: true,
        ime: "CDP composition; not OS IME certification",
        teamReviewedPublication: batchId,
        personalReviewedPublication: pd.submission.batchId,
        modelCalls: calls.rows[0].n,
        overflow,
        errors: state.errors,
        external: state.external,
      });
      await personal.context.close();
      contexts = contexts.filter((c) => c !== personal.context);
      await ui.context.close();
      contexts = contexts.filter((c) => c !== ui.context);
    }
  await writeFile(
    output + "/browser-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        authentication: "synthetic loopback adapter",
        database: "disposable owned PG17",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  for (const c of contexts) {
    const p = c.pages()[0];
    if (p) {
      console.error((await p.locator("body").innerText()).slice(-5000));
      await p.screenshot({ path: "/private/tmp/akh_c6_failure.png" });
    }
  }
  throw e;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  for (const profile of profiles)
    await rm(profile, { recursive: true, force: true });
  await db.end();
}
