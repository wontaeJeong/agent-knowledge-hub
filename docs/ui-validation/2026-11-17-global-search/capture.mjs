// Actual browser -> canonical loopback native API; no fabricated response DTOs.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Pool } from "pg";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
if (
  process.env.AKH_C5_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Synthetic capture opt-in required");
const f = JSON.parse(
  await readFile("/private/tmp/akh-c5-browser.json", "utf8"),
);
if (!/^akh_c5_ui_[a-f0-9]{32}$/.test(f.database))
  throw Error("Owned database required");
const url = new URL(process.env.TEST_DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.includes("test")
)
  throw Error("Loopback test DB required");
url.pathname = "/" + f.database;
const db = new Pool({ connectionString: url.href }),
  browser = await chromium.launch({ headless: true }),
  results = [];
const output = "docs/ui-validation/2026-11-17-global-search";
try {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
          viewport: { width, height: width === 1440 ? 1000 : 844 },
          timezoneId: "Asia/Seoul",
        }),
        page = await context.newPage(),
        errors = [],
        posts = [],
        external = [];
      let gate = null;
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (
          r.url().startsWith("http") &&
          !r.url().startsWith("http://127.0.0.1:5195/")
        )
          external.push(r.url());
      });
      await page.route("**/api/**", async (route) => {
        const request = route.request(),
          u = new URL(request.url());
        const body =
          request.method() === "POST" ? request.postDataJSON() : null;
        if (request.method() === "POST")
          posts.push({ path: u.pathname, body, at: Date.now() });
        const response = await route.fetch({
          url: `http://127.0.0.1:4395${u.pathname}${u.search}`,
          headers: {
            ...request.headers(),
            cookie: "synthetic-session",
            origin: "http://127.0.0.1:5195",
          },
        });
        if (gate && body?.query === gate.query) {
          const current = gate;
          gate = null;
          current.enter();
          await current.wait;
        }
        await route.fulfill({ response });
      });
      const go = async (section) => {
        await page.goto(
          `http://127.0.0.1:5195/?app=1&space=${f.workspaceId}${section.startsWith("document=") ? `&${section}` : `&section=${section}`}`,
        );
        await page.locator(".global-search > button").waitFor();
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.theme),
          theme,
        );
      };
      const searches = () =>
        posts.filter((p) => p.path === "/api/v1/questions/search");
      const activity = async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) AS n FROM workflow_activity WHERE workspace_id=$1 AND principal_id='reviewer' AND kind='recent'",
              [f.workspaceId],
            )
          ).rows[0].n,
        );
      await db.query(
        "DELETE FROM workflow_activity WHERE workspace_id=$1 AND principal_id='reviewer' AND kind='recent'",
        [f.workspaceId],
      );
      await go("search");
      await page.waitForFunction(
        () => document.querySelectorAll(".search-results li").length === 25,
      );
      assert.equal(await activity(), 0);
      const quick = page.locator(".global-search > button");
      await quick.focus();
      await page.keyboard.press("ControlOrMeta+k");
      const input = page.getByRole("combobox", {
        name: "제목·본문 키워드",
        exact: true,
      });
      await input.waitFor();
      assert.equal(
        await input.evaluate((el) => el === document.activeElement),
        true,
      );
      await page.evaluate(() => {
        window.__ime = [];
        for (const type of [
          "compositionstart",
          "compositionupdate",
          "compositionend",
          "input",
          "keydown",
        ])
          document
            .querySelector('[role="combobox"]')
            .addEventListener(type, (e) =>
              window.__ime.push({
                type: e.type,
                data: e.data ?? null,
                trusted: e.isTrusted,
                composing: e.isComposing ?? null,
              }),
            );
      });
      const cdp = await context.newCDPSession(page),
        before = searches().length;
      await cdp.send("Input.imeSetComposition", {
        text: "코",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await page.waitForTimeout(260);
      assert.equal(searches().length, before);
      await cdp.send("Input.imeSetComposition", {
        text: "코드_retry",
        selectionStart: 8,
        selectionEnd: 8,
      });
      await page.waitForTimeout(260);
      assert.equal(searches().length, before);
      await cdp.send("Input.insertText", { text: "코드_retry" });
      await page.waitForFunction(
        () => document.querySelectorAll('[role="option"]').length === 10,
      );
      const ime = await page.evaluate(() => window.__ime);
      console.log("IME native events", JSON.stringify(ime));
      assert(ime.some((e) => e.type === "compositionstart" && e.trusted));
      assert(ime.some((e) => e.type === "compositionend"));
      assert.equal(
        (
          await page.locator(".quick-open [role=option]").first().innerText()
        ).startsWith("코드_retry 안내"),
        true,
      );
      assert.equal(await page.locator(".quick-open img").count(), 0);
      assert.equal(await activity(), 0);
      await page.screenshot({
        path: `${output}/quick-open-${width}-${theme}.png`,
      });
      await page.getByRole("button", { name: "닫기", exact: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(
        await input.evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page
          .getByRole("button", { name: "닫기", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await input.focus();
      await page.keyboard.press("Escape");
      assert.equal(
        await quick.evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("ControlOrMeta+k");
      await input.fill("코드_retry");
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.quick-open [role="option"]').length ===
          10,
      );
      for (let n = 0; n < 10; n++) await page.keyboard.press("ArrowDown");
      assert.equal(
        await page
          .locator('.quick-open [aria-selected="true"]')
          .evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        true,
      );
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForURL(/document=search-28/);
      await page
        .getByRole("heading", { name: "코드_retry 안내 · v1", exact: true })
        .waitFor();
      assert.equal(await activity(), 1);
      assert.equal(
        new URL(page.url()).searchParams.get("document"),
        "search-28",
      );
      await go("search");
      await page.locator(".search-results li").first().waitFor();
      const q = page.locator(".search-page form input").first();
      await q.fill("code_nonexistent");
      await page.waitForFunction(() =>
        document
          .querySelector(".search-page")
          ?.textContent.includes("0건 표시"),
      );
      assert.equal(await page.locator(".search-results li").count(), 0);
      await page.screenshot({ path: `${output}/empty-${width}-${theme}.png` });
      // A real canonical response is delayed, then invalidated by a newer filter.
      let release, entered;
      const wait = new Promise((r) => (release = r)),
        entry = new Promise((r) => (entered = r));
      gate = { query: "합성", wait, enter: entered };
      await q.fill("합성");
      await entry;
      await q.fill("코드_retry");
      await page.waitForFunction(
        () => document.querySelectorAll(".search-results li").length === 25,
      );
      release();
      await page.waitForTimeout(100);
      assert.equal(await q.inputValue(), "코드_retry");
      assert.equal(await page.locator(".search-results li").count(), 25);
      await page.screenshot({ path: `${output}/detail-${width}-${theme}.png` });
      await page.locator(".search-page summary").click();
      await page
        .getByLabel("작성 기간 시작", { exact: true })
        .fill("2026-01-01T00:00");
      await page
        .getByLabel("작성 기간 끝", { exact: true })
        .fill("2026-12-31T23:59");
      await page.waitForFunction(
        () => document.querySelectorAll(".search-results li").length === 25,
      );
      assert.equal(
        searches().at(-1).body.periodFrom,
        "2025-12-31T15:00:00.000Z",
      );
      assert.equal(searches().at(-1).body.periodTo, "2026-12-31T14:59:00.000Z");
      await page.screenshot({
        path: `${output}/filters-${width}-${theme}.png`,
      });
      await page.getByLabel("작성 기간 시작", { exact: true }).fill("");
      await page.getByLabel("작성 기간 끝", { exact: true }).fill("");
      await page.locator(".search-page summary").click();

      await q.focus();
      await page.keyboard.press("ControlOrMeta+k");
      assert.equal(await page.getByRole("dialog").count(), 0);
      for (const kind of ["bare", "plaintext", "alert", "native"]) {
        await page.evaluate((kind) => {
          const owner = document.createElement(
            kind === "native" ? "dialog" : "div",
          );
          owner.id = "capture-input-owner";
          if (kind === "bare" || kind === "plaintext")
            owner.setAttribute(
              "contenteditable",
              kind === "bare" ? "" : "plaintext-only",
            );
          else if (kind === "alert") owner.setAttribute("role", "alertdialog");
          else owner.setAttribute("open", "");
          const button = document.createElement("button");
          button.textContent = "합성 입력 대상";
          owner.append(button);
          document.body.append(owner);
          button.focus();
        }, kind);
        await page.keyboard.press("ControlOrMeta+k");
        assert.equal(await page.locator(".quick-open").count(), 0);
        assert.equal(
          await page
            .locator("#capture-input-owner button")
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await page.evaluate(() =>
          document.getElementById("capture-input-owner").remove(),
        );
      }
      await q.fill("과거_조건");
      await page.waitForFunction(() =>
        document.querySelector(".search-page").textContent.includes("0건 표시"),
      );
      await page.getByLabel("과거 버전 포함 (현재 권고 아님)").check();
      await page
        .getByRole("button", { name: "이전 전용 제목", exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator(".search-results")
          .innerText()
          .then((t) => t.includes("현재 전용 제목")),
        false,
      );

      await q.fill("전용 제목");
      await page.waitForFunction(
        () => document.querySelectorAll(".search-results li").length === 2,
      );
      const currentRow = await page
        .locator(".search-results li")
        .filter({
          has: page.getByRole("button", {
            name: "현재 전용 제목",
            exact: true,
          }),
        })
        .innerText();
      const oldRow = await page
        .locator(".search-results li")
        .filter({
          has: page.getByRole("button", {
            name: "이전 전용 제목",
            exact: true,
          }),
        })
        .innerText();
      assert(currentRow.includes("현재 버전") && currentRow.includes("· v2"));
      assert(oldRow.includes("과거 버전") && oldRow.includes("· v1"));
      await page.screenshot({
        path: `${output}/historical-${width}-${theme}.png`,
      });
      await q.fill("과거_조건");
      await page
        .getByRole("button", { name: "이전 전용 제목", exact: true })
        .waitFor();

      await page
        .getByRole("button", { name: "이전 전용 제목", exact: true })
        .click();
      await page.waitForURL(/document=history-topic&version=1/);
      await page
        .getByRole("heading", { name: "이전 전용 제목 · v1", exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('[aria-label="고정 문서 버전"]')
          .innerText()
          .then((t) => t.includes("현재 전용 제목")),
        false,
      );
      assert.equal(await activity(), 2);
      const recent = async () =>
        (
          await db.query(
            "SELECT at::text FROM workflow_activity WHERE workspace_id=$1 AND principal_id='reviewer' AND page_id='history-topic' AND kind='recent'",
            [f.workspaceId],
          )
        ).rows[0].at;
      const at = await recent();
      const readResponse = page.waitForResponse(
        (r) =>
          r.url().endsWith("/versions/pages/history-topic/1") &&
          r.request().method() === "GET",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await readResponse;
      assert.equal(await recent(), at);
      await page.screenshot({
        path: `${output}/snapshot-${width}-${theme}.png`,
      });
      // Invalidate a real signed cursor through a canonical ACL revision change.
      await go("search");
      await page.waitForFunction(
        () => document.querySelectorAll(".search-results li").length === 25,
      );
      await db.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
        [f.workspaceId],
      );
      await page
        .getByRole("button", { name: "다음 결과 25건", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "처음부터 다시 검색" })
        .waitFor();
      assert.equal(await page.locator(".search-results li").count(), 0);
      await page.screenshot({
        path: `${output}/stale-cursor-${width}-${theme}.png`,
      });
      await page
        .getByRole("button", { name: "처음부터 다시 검색", exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector(".search-page").textContent.includes("0건 표시"),
      );
      assert.equal(await page.locator(".search-results li").count(), 0);
      await db.query(
        "INSERT INTO resource_readers(workspace_id,kind,resource_id,principal_id) VALUES($1,'source','source-a','reviewer')",
        [f.workspaceId],
      );
      assert(posts.every((p) => p.path === "/api/v1/questions/search"));
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      const storage = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
          url: location.href,
        }),
      );
      assert(
        !/코드_retry|과거_조건|이전 전용 제목|현재 전용 제목/.test(storage),
      );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false);
      results.push({
        width,
        theme,
        browser: browser.version(),
        themeVerified: theme,
        quickCount: 10,
        detailCount: 25,
        imeNativeCompositionStartUpdate: true,
        commitEventTrusted: ime.find((e) => e.type === "compositionend")
          .trusted,
        imeMethod:
          "Chromium CDP Input.imeSetComposition + Input.insertText; no OS IME",
        ime,
        keyboardTrap: true,
        escapeFocusReturn: true,
        activeResultVisible: true,
        datetimeLocalToUtc: true,
        shortcutOtherOwnerPreserved: true,
        historicalRows: { currentVersion: 2, oldVersion: 1 },
        timezone: "Asia/Seoul",
        exactCurrentOpen: true,
        exactHistoricalOpen: true,
        lateRealResponseBlocked: true,
        historicalDefaultExcluded: true,
        searchNonvisit: true,
        snapshotVisitOneRow: true,
        focusRefreshNonvisit: true,
        staleCursorCleared: true,
        sourceAclEmpty: true,
        noModelOrQuestionPosts: true,
        noExternalRequests: true,
        noSensitiveStorage: true,
        overflow,
        errors,
      });
      await context.close();
    }
  await writeFile(
    `${output}/browser-results.json`,
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      results.map(({ ime, ...rest }) => rest),
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await db.end();
}
