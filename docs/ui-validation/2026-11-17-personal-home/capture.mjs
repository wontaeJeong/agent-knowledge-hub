// Real Chromium -> running canonical HTTP APIs. Responses are forwarded unchanged.
import { sourceHashes } from "./manifest.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { Pool } from "pg";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
if (
  process.env.AKH_C4_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic capture opt-in required");
const frontend = JSON.parse(
  await readFile("/private/tmp/akh_c4_frontend-start.json", "utf8"),
);
const fixture = JSON.parse(
  await readFile("/private/tmp/akh_c4_browser.json", "utf8"),
);
assert.equal(
  (await sourceHashes()).productionFingerprint,
  fixture.productionFingerprint,
  "runtime/current source bytes",
);
assert.equal(
  frontend.productionFingerprint,
  fixture.productionFingerprint,
  "fresh frontend/runtime bytes",
);
if (!/^akh_c4_test_ui_[a-f0-9]{32}$/.test(fixture.database))
  throw Error("Owned DB required");
const url = new URL(process.env.TEST_DATABASE_URL);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  !url.pathname.includes("test")
)
  throw Error("Loopback DB required");
url.pathname = "/" + fixture.database;
const db = new Pool({ connectionString: url.href });
const output = "docs/ui-validation/2026-11-17-personal-home",
  results = [],
  profiles = [],
  contexts = [];
const counts = async (space) =>
  (
    await db.query(
      "SELECT count(*)::integer n FROM workflow_activity WHERE workspace_id=$1 AND kind='recent'",
      [space],
    )
  ).rows[0].n;
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for observed browser state");
};
try {
  let scenario = 0;
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const f = fixture.scenarios[scenario++],
        profile = await mkdtemp("/private/tmp/akh_c4_profile_");
      profiles.push(profile);
      const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        timezoneId: "Asia/Seoul",
      });
      contexts.push(context);
      context.setDefaultTimeout(15000);
      const state = {
        actor: "editor",
        requests: [],
        errors: [],
        hold: null,
        held: false,
        offlineDraftSaves: false,
      };
      await context.route("**/api/**", async (route) => {
        const req = route.request(),
          u = new URL(req.url());
        state.requests.push({
          path: u.pathname + u.search,
          method: req.method(),
        });
        if (
          state.offlineDraftSaves &&
          u.pathname === "/api/v1/workflows/drafts" &&
          req.method() === "POST"
        ) {
          await route.abort("internetdisconnected");
          return;
        }
        try {
          const response = await route.fetch({
            url: `http://127.0.0.1:4394${u.pathname}${u.search}`,
            headers: {
              ...req.headers(),
              cookie: `synthetic-${state.actor}`,
              origin: "http://127.0.0.1:5194",
            },
          });
          if (
            state.hold &&
            u.pathname === "/api/v1/convenience/home" &&
            !u.search
          ) {
            state.held = true;
            await state.hold;
          }
          try {
            await route.fulfill({ response });
          } catch (e) {
            if (
              !/Target.*closed|cancel|Request.*closed|disposed/i.test(e.message)
            )
              throw e;
          }
        } catch (e) {
          if (
            !/Target.*closed|cancel|Request.*closed|disposed/i.test(e.message)
          )
            throw e;
        }
      });
      const page = context.pages()[0] ?? (await context.newPage());
      page.on("pageerror", (e) => state.errors.push(e.message));
      const go = async (space, query = "") => {
        await page.goto(`http://127.0.0.1:5194/?app=1&space=${space}${query}`);
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
      };
      const canonical = async (path, body) => {
        const response = await fetch(`http://127.0.0.1:4394/api/v1${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie: "synthetic-editor",
            origin: "http://127.0.0.1:5194",
            "X-Space-Id": f.spaceId,
            "X-CSRF-Token": "test-only-csrf",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        assert.ok(
          response.ok,
          `${path}: ${response.status} ${JSON.stringify(data)}`,
        );
        return data;
      };
      const shot = async (name) => {
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.theme),
          theme,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1,
          ),
          true,
          "no document horizontal overflow",
        );
        await page.screenshot({
          path: `${output}/${name}-${width}-${theme}.png`,
          fullPage: true,
        });
      };
      const beforePreview = state.requests.length;
      await page.goto("http://127.0.0.1:5194/?preview=1");
      await page.locator(".console-overview").waitFor();
      assert.equal(await page.locator("h1").innerText(), "운영 개요");
      assert.equal(await page.locator("[data-home-widget]").count(), 0);
      assert.equal(
        state.requests.length,
        beforePreview,
        "bare preview uses its supported local body without native API",
      );
      await shot("preview");
      await go(fixture.emptySpace);
      await page
        .locator('[data-home-widget="favorites"]')
        .getByText("항목이 없습니다.", { exact: true })
        .waitFor();
      assert.equal(await page.locator("[data-home-widget]").count(), 8);
      await shot("empty");
      const beforeSpaceChange = state.requests.length;
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator(".op-context select").selectOption(f.spaceId);
      await page.waitForURL(
        (url) => url.searchParams.get("space") === f.spaceId && url.hash === "",
      );
      await page.locator('[data-home-widget="drafts"] li').first().waitFor();
      assert.equal(await page.locator("h1").innerText(), "홈");
      assert.equal(await page.locator(".console-overview").count(), 0);
      assert.equal(
        state.requests
          .slice(beforeSpaceChange)
          .some((x) =>
            /^\/api\/v1\/(pages|sources|members|jobs(?:-v2)?)(?:[?]|$)/.test(
              x.path,
            ),
          ),
        false,
        "space-changed default Home stays independent of operations aggregates",
      );
      await shot("space-change");
      let release;
      state.hold = new Promise((r) => (release = r));
      state.held = false;
      await go(f.spaceId);
      await page
        .getByText("내 문서와 작업을 불러오는 중…", { exact: true })
        .waitFor();
      await until(() => state.held);
      await shot("loading");
      state.hold = null;
      release();
      await page.locator('[data-home-widget="drafts"] li').first().waitFor();
      assert.equal(
        await counts(f.spaceId),
        0,
        "Home metadata reads are not visits",
      );
      assert.equal(
        await page.getByText("다른 사람 비공개 초안", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.locator('[data-home-widget="drafts"] li').count(),
        25,
      );
      await shot("home");
      const draftsWidget = page.locator('[data-home-widget="drafts"]');
      await draftsWidget.locator("li a").first().focus();
      for (let tab = 0; tab < 24; tab++) await page.keyboard.press("Tab");
      assert.equal(
        await draftsWidget
          .locator("li a")
          .last()
          .evaluate((el) => el === document.activeElement),
        true,
        "keyboard reaches offscreen 25th item",
      );
      assert.equal(
        await draftsWidget.locator("ul").evaluate((el) => el.scrollTop > 0),
        true,
        "native list scroll follows keyboard",
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const continuation = draftsWidget.getByRole("button", {
        name: "다음 25개",
        exact: true,
      });
      assert.equal(
        await continuation.evaluate((el) => el === document.activeElement),
        true,
        "keyboard reaches continuation outside list",
      );
      await shot("keyboard-bottom");
      await page.keyboard.press("Tab");
      assert.equal(
        await draftsWidget.evaluate((el) =>
          el.contains(document.activeElement),
        ),
        false,
        "no keyboard focus trap",
      );
      await db.query(
        "ALTER TABLE workflow_access_requests RENAME TO akh_c4_access_unavailable",
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page
        .locator('[data-home-widget="accessRequests"]')
        .getByRole("alert")
        .waitFor();
      assert.equal(
        await page.locator('[data-home-widget="drafts"] li').count(),
        25,
      );
      assert.equal(
        await page.locator('[data-home-widget="requests"] li').count(),
        2,
      );
      await shot("partial-error");
      await db.query(
        "ALTER TABLE akh_c4_access_unavailable RENAME TO workflow_access_requests",
      );
      const beforeRetry = state.requests.length;
      await page
        .locator('[data-home-widget="accessRequests"]')
        .getByRole("button", { name: "다시 시도", exact: true })
        .click();
      await page
        .locator('[data-home-widget="accessRequests"] li')
        .first()
        .waitFor();
      assert.deepEqual(
        state.requests
          .slice(beforeRetry)
          .filter((x) => x.path.includes("convenience/home"))
          .map((x) => x.path),
        ["/api/v1/convenience/home?widget=accessRequests"],
      );
      await go(f.spaceId, "&section=tasks");
      await page.locator('[data-home-widget="drafts"] li').first().waitFor();
      assert.equal(
        await page.locator('[data-home-widget="recent"]').count(),
        0,
      );
      await shot("tasks");
      await page
        .locator('[data-home-widget="drafts"]')
        .getByRole("button", { name: "다음 25개", exact: true })
        .click();
      const older = page
        .locator('[data-home-widget="drafts"]')
        .getByRole("link", { name: "정확한 기존 문서 초안", exact: true });
      await older.waitFor();
      assert.ok((await older.getAttribute("href")).endsWith("&draft=d27"));
      await older.focus();
      assert.equal(
        await older.evaluate((el) => el === document.activeElement),
        true,
      );
      // Revalidate the current continuation, preserving its exact focused node.
      const currentNode = await older.elementHandle();
      const cursorRequests = () =>
        state.requests.filter((x) =>
          x.path.includes("convenience/home?widget=drafts&cursor="),
        );
      for (const event of ["focus", "visibility", "timer"]) {
        const before = cursorRequests().length;
        const response = page.waitForResponse(
          (r) => r.url().includes("convenience/home?widget=drafts&cursor="),
          { timeout: 35000 },
        );
        if (event === "focus")
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        if (event === "visibility")
          await page.evaluate(() =>
            document.dispatchEvent(new Event("visibilitychange")),
          );
        // The timer case waits for the application's actual 30-second interval.
        assert.equal((await response).status(), 200);
        await until(
          async () =>
            (await draftsWidget.getAttribute("aria-busy")) === "false",
        );
        assert.ok(cursorRequests().length > before);
        assert.equal(
          await currentNode.evaluate(
            (el) => el.isConnected && el === document.activeElement,
          ),
          true,
        );
        assert.ok((await older.getAttribute("href")).endsWith("&draft=d27"));
      }
      await shot("current-page-refresh");
      // Change the real revision dependency; an old cursor must clear rows.
      await db.query(
        "UPDATE workflow_drafts SET updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_id='editor' AND id='d00'",
        [f.spaceId],
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await draftsWidget.getByRole("alert").waitFor();
      assert.equal(await draftsWidget.locator("li").count(), 0);
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.hasAttribute("data-home-fallback"),
        ),
        true,
      );
      await shot("current-page-stale");
      await draftsWidget
        .getByRole("button", { name: "처음부터", exact: true })
        .click();
      await draftsWidget
        .getByRole("button", { name: "다음 25개", exact: true })
        .click();
      await older.waitFor();
      await older.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(/section=compose&draft=d27/, {
        waitUntil: "domcontentloaded",
      });
      await page.getByLabel("Markdown 본문", { exact: false }).waitFor();
      assert.equal(
        await page.getByLabel("Markdown 본문", { exact: false }).inputValue(),
        "정확한 기존 문서 초안 본문",
      );
      assert.ok(page.url().includes("section=compose&draft=d27"));
      await shot("page-draft-resume");
      // Produce a real permitted cache through failed autosave, then reload the exact URL.
      await page
        .getByText("로컬 복사가 허용된 입력만", { exact: false })
        .waitFor();
      const unsent = `C4_UNSENT_${width}_${theme}`;
      state.offlineDraftSaves = true;
      await page.getByLabel("Markdown 본문", { exact: false }).fill(unsent);
      await page.getByRole("status").filter({ hasText: "연결 중단" }).waitFor();
      assert.ok(
        (
          await page.evaluate(() => Object.values(localStorage).join(""))
        ).includes(unsent),
      );
      await go(f.spaceId, "&section=compose&draft=d26");
      await page.getByLabel("Markdown 본문", { exact: false }).waitFor();
      assert.equal(
        await page.getByLabel("Markdown 본문", { exact: false }).inputValue(),
        "개인 작업 본문 26",
      );
      assert.equal(
        await page
          .getByRole("dialog", { name: "개인 초안 입력 복구", exact: true })
          .count(),
        0,
      );
      assert.ok(
        (
          await page.evaluate(() => Object.values(localStorage).join(""))
        ).includes(unsent),
      );
      await shot("recovery-other-id");
      await go(f.spaceId, "&section=compose&draft=d27");
      const recovery = page.getByRole("dialog", {
        name: "개인 초안 입력 복구",
        exact: true,
      });
      await recovery.waitFor();
      assert.equal(
        await page
          .locator("textarea")
          .evaluateAll(
            (els, value) => els.some((el) => el.value === value),
            unsent,
          ),
        false,
      );
      await shot("recovery-offered");
      state.offlineDraftSaves = false;
      await recovery
        .getByRole("button", { name: "권한 재확인 후 입력 복구", exact: true })
        .click();
      await until(
        async () =>
          (await page
            .getByLabel("Markdown 본문", { exact: false })
            .inputValue()) === unsent,
      );
      await until(
        async () =>
          (await canonical("/workflows/drafts")).items.find(
            (d) => d.id === "d27",
          )?.content === unsent,
      );
      await shot("recovery-restored");
      await go(f.spaceId, "&section=compose&draft=d27");
      await page
        .getByText("로컬 복사가 허용된 입력만", { exact: false })
        .waitFor();
      // A second offline recovery keeps its old CAS when another writer wins.
      state.offlineDraftSaves = true;
      const conflictText = unsent + "_CONFLICT";
      await page
        .getByLabel("Markdown 본문", { exact: false })
        .fill(conflictText);
      await page.getByRole("status").filter({ hasText: "연결 중단" }).waitFor();
      const latest = (await canonical("/workflows/drafts")).items.find(
        (d) => d.id === "d27",
      );

      await canonical("/workflows/drafts", {
        id: latest.id,
        title: latest.title,
        pageId: latest.pageId,
        baseVersion: latest.baseVersion,
        sourceIds: latest.sourceIds,
        dependencyVersions: latest.dependencyVersions,
        expectedRevision: latest.revision,
        content: "C4_SERVER_WINNER",
        mutationId: crypto.randomUUID(),
      });
      await go(f.spaceId, "&section=compose&draft=d27");
      await recovery.waitFor();
      state.offlineDraftSaves = false;
      await recovery
        .getByRole("button", { name: "권한 재확인 후 입력 복구", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "개인 초안 저장 충돌", exact: true })
        .waitFor();
      assert.equal(
        await page.getByLabel("Markdown 본문", { exact: false }).inputValue(),
        conflictText,
      );
      assert.equal(
        (await canonical("/workflows/drafts")).items.find((d) => d.id === "d27")
          ?.content,
        "C4_SERVER_WINNER",
      );
      await shot("recovery-conflict");
      // Dispose this owned conflict before continuing unrelated navigation captures.
      await page
        .getByRole("button", {
          name: "서버 입력을 명시적으로 선택",
          exact: true,
        })
        .click();

      assert.ok(
        (await counts(f.spaceId)) > 0,
        "actual editor document open records visit",
      );
      await go(f.spaceId, "&section=tasks");
      await page.locator('[data-home-widget="drafts"] li').first().waitFor();
      await page
        .locator('[data-home-widget="drafts"]')
        .getByRole("button", { name: "다음 25개", exact: true })
        .click();
      await page
        .locator('[data-home-widget="drafts"]')
        .getByRole("link", { name: "정확한 신규 문서 초안", exact: true })
        .click();
      await page.getByLabel("Markdown 본문", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("Markdown 본문", { exact: true }).inputValue(),
        "정확한 신규 문서 본문",
      );
      await shot("new-draft-resume");
      await go(f.spaceId, "&section=compose&draft=other-owner");
      await page
        .getByRole("alert")
        .filter({ hasText: "요청한 초안이 없거나" })
        .waitFor();
      assert.equal(
        await page.getByText("외부 표시 금지", { exact: true }).count(),
        0,
      );
      await shot("other-owner-denied");
      await go(f.spaceId);
      await page.locator('[data-home-widget="favorites"] a').waitFor();
      await page.locator('[data-home-widget="favorites"] a').focus();
      await db.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND principal_id='editor' AND kind='source'",
        [f.spaceId],
      );
      await page
        .locator('[data-home-widget="favorites"]')
        .getByRole("button", { name: "새로 고침", exact: true })
        .evaluate((el) => el.click());
      await page
        .locator('[data-home-widget="favorites"]')
        .getByText("항목이 없습니다.", { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.hasAttribute("data-home-fallback"),
        ),
        true,
      );
      await shot("acl-revoked");
      // Same-page API account change is additionally covered by the component generation regression.
      state.actor = "reviewer";
      await go(f.spaceId);
      await page.locator('[data-home-widget="drafts"] a').first().waitFor();
      assert.equal(
        await page.getByText("개인 작업 0", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .locator('[data-home-widget="drafts"]')
          .getByRole("link", { name: "다른 사람 비공개 초안", exact: true })
          .count(),
        1,
      );
      await shot("account-switched");
      assert.deepEqual(state.errors, []);
      assert.ok(
        !state.requests.some((x) =>
          /model.*POST/.test(x.path + " " + x.method),
        ),
      );
      results.push({
        width,
        theme,
        space: f.spaceId,
        checks: [
          "bare-preview-supported-overview-no-native-api",
          "actual-default-home-space-change",
          "empty",
          "actual-response-loading",
          "own-only",
          "bounded25-continuation",
          "read-not-visit",
          "partial-error-real-server",
          "individual-retry",
          "my-tasks",
          "current-page-focus-visibility-real30s-timer-node-retained",
          "canonical-stale-cursor-clears-and-explicit-restart",
          "real-offline-cache-exact-resume-online-offer-and-restore",
          "other-draft-same-page-cache-preserved",
          "canonical-concurrent-writer-recovery-CAS-conflict",
          "keyboard-exact-older-page-draft",
          "exact-new-draft",
          "other-owner-denied",
          "current-source-ACL",
          "focus-fallback",
          "nested-list-keyboard25-next-no-trap",
          "account-switch",
        ],
        requestCount: state.requests.length,
        errors: state.errors,
      });
      console.log("Captured", width, theme);
      await context.close();
      contexts.splice(contexts.indexOf(context), 1);
    }
  await writeFile(
    `${output}/browser-results.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        runtimeStartedAt: fixture.startedAt,
        frontendStartedAt: frontend.startedAt,
        productionFingerprint: fixture.productionFingerprint,
        origin: "http://127.0.0.1:5194",
        backend: "http://127.0.0.1:4394",
        authentication:
          "Explicit synthetic loopback actor adapter; production canonical APIs/current ACL; no fabricated DTO",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  console.error("Primary capture failure", e);
  for (const context of contexts) {
    const page = context.pages()[0];
    if (page) {
      console.error("Observed URL", page.url());
      console.error(
        "Observed DOM",
        (await page.locator("body").innerText()).slice(-7000),
      );
      await page.screenshot({
        path: "/private/tmp/akh_c4_capture_failure.png",
        fullPage: true,
      });
    }
  }
  throw e;
} finally {
  await Promise.all(
    contexts.map(async (c) => {
      await c.unrouteAll({ behavior: "ignoreErrors" });
      await c.close();
    }),
  );
  await Promise.all(
    profiles.map((p) => rm(p, { recursive: true, force: true })),
  );
  await db.end();
}
