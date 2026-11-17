import { sourceHashes } from "./manifest.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { Pool } from "pg";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
if (
  process.env.AKH_C7_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Explicit synthetic opt-in required");
const frontend = JSON.parse(
    await readFile("/private/tmp/akh_c7_frontend-start.json", "utf8"),
  ),
  fixture = JSON.parse(
    await readFile("/private/tmp/akh_c7_browser.json", "utf8"),
  );
assert.equal(
  (await sourceHashes()).productionFingerprint,
  fixture.productionFingerprint,
);
assert.equal(frontend.productionFingerprint, fixture.productionFingerprint);
assert.match(fixture.database, /^akh_c7_test_ui_[a-f0-9]{32}$/);
const url = new URL(process.env.TEST_DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
url.pathname = "/" + fixture.database;
const db = new Pool({ connectionString: url.href }),
  output = "docs/ui-validation/2026-11-18-document-structure",
  profiles = [],
  contexts = [],
  results = [];
try {
  let index = 0;
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const f = fixture.scenarios[index++],
        profile = await mkdtemp("/private/tmp/akh_c7_profile_");
      profiles.push(profile);
      const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        timezoneId: "Asia/Seoul",
      });
      contexts.push(context);
      context.setDefaultTimeout(20000);
      const requests = [],
        errors = [];
      let held = null;
      const holdNext = (path) => {
        let release, observed, finished;
        const gate = new Promise((r) => (release = r)),
          seen = new Promise((r) => (observed = r)),
          done = new Promise((r) => (finished = r));
        held = { path, gate, observed, finished };
        return { release, seen, done };
      };
      await context.route("**/api/**", async (route) => {
        const req = route.request(),
          u = new URL(req.url());
        requests.push({ path: u.pathname + u.search, method: req.method() });
        try {
          const response = await route.fetch({
            url: `http://127.0.0.1:4397${u.pathname}${u.search}`,
            headers: {
              ...req.headers(),
              cookie: "synthetic-reviewer",
              origin: "http://127.0.0.1:5197",
            },
          });
          const delay =
            held?.path === u.pathname && req.method() === "GET" ? held : null;
          if (delay) {
            held = null;
            delay.observed();
            await delay.gate;
          }
          await route.fulfill({ response });
          delay?.finished();
        } catch (e) {
          if (
            !/Target.*closed|cancel|Request.*closed|disposed/i.test(e.message)
          )
            throw e;
        }
      });
      const page = context.pages()[0] ?? (await context.newPage());
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (message) => {
        if (message.type() === "error" && message.text().includes("same key"))
          errors.push(message.text());
      });
      const oldLink = `http://127.0.0.1:5197/?app=1&space=${f.spaceId}&document=leaf`;
      const go = async () => {
        await page.goto(oldLink);
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
      };
      const canonical = async (path, body) => {
        const response = await fetch(`http://127.0.0.1:4397/api/v1${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie: "synthetic-reviewer",
            origin: "http://127.0.0.1:5197",
            "X-Space-Id": f.spaceId,
            "X-CSRF-Token": "test-only-csrf",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        assert.ok(
          response.ok,
          JSON.stringify({ path, status: response.status, data }),
        );
        return data;
      };
      await go();
      await page.locator("[data-document-heading]").waitFor();
      await page
        .getByRole("navigation", { name: "문서 경로", exact: true })
        .getByRole("link", { name: "문서 구조", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("navigation", { name: "문서 경로", exact: true })
          .getByRole("link")
          .count(),
        3,
      );
      assert.equal(
        await page.getByText("비공개 자료", { exact: true }).count(),
        0,
      );
      if (width === 390) {
        await page
          .getByRole("button", { name: "문서 트리 열기", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "문서 트리",
          exact: true,
        });
        await dialog
          .getByRole("button", { name: "운영 지식 하위 문서 펼치기" })
          .click();
        await dialog
          .getByRole("button", { name: "문서 탐색 하위 문서 펼치기" })
          .click();
        await dialog
          .getByRole("link", { name: "문서 구조", exact: true })
          .waitFor();
        await page.screenshot({
          path: `${output}/${width}-${theme}.png`,
          fullPage: false,
        });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() =>
          document.activeElement?.hasAttribute("data-document-heading"),
        );
      } else {
        const tree = page.getByRole("navigation", {
          name: "문서 트리",
          exact: true,
        });
        await tree
          .getByRole("button", { name: "운영 지식 하위 문서 펼치기" })
          .click();
        await tree
          .getByRole("button", { name: "문서 탐색 하위 문서 펼치기" })
          .click();
        await tree
          .getByRole("link", { name: "문서 구조", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "문서 트리 열기", exact: true })
            .isVisible(),
          false,
        );
        assert.equal(
          await tree
            .getByRole("button", { name: "운영 지식 하위 문서 접기" })
            .innerText(),
          "",
        );
        await tree.evaluate((el) => el.scrollIntoView({ block: "start" }));
        await page.screenshot({
          path: `${output}/${width}-${theme}.png`,
          fullPage: false,
        });
      }
      if (width === 390) {
        for (const outside of [false, true]) {
          await page
            .getByRole("button", { name: "문서 트리 열기", exact: true })
            .click();
          const drawer = page.getByRole("dialog", {
            name: "문서 트리",
            exact: true,
          });
          const delay = holdNext("/api/v1/workflows/pages/review");
          await drawer
            .getByRole("link", { name: "검토 절차", exact: true })
            .focus();
          await page.keyboard.press("Enter");
          await delay.seen;
          assert.equal(
            await page.locator("[data-document-heading]").count(),
            0,
          );
          const select = page.getByRole("combobox", {
            name: "문서 선택",
            exact: true,
          });
          if (outside) await select.focus();
          delay.release();
          await delay.done;
          await page
            .locator("[data-document-heading]")
            .filter({ hasText: "검토 절차" })
            .waitFor();
          if (outside)
            assert.ok(
              await select.evaluate((el) => el === document.activeElement),
            );
          else {
            assert.ok(
              await page
                .locator("[data-document-heading]")
                .evaluate((el) => el === document.activeElement),
            );
            await page.screenshot({
              path: `${output}/${width}-${theme}-selection-focus.png`,
            });
          }
          await go();
          await page
            .locator("[data-document-heading]")
            .filter({ hasText: "문서 구조" })
            .waitFor();
        }
      }
      // Keyboard only equivalent to drag, current destination revision and canonical mutation.
      await page
        .getByRole("button", { name: "문서 이동", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", {
        name: "문서 이동",
        exact: true,
      });
      await dialog
        .getByRole("combobox", { name: "배치 위치" })
        .selectOption("topic");
      await dialog
        .getByRole("textbox", { name: "이동 이유" })
        .fill("키보드로 구조 정리");
      await dialog
        .getByRole("button", { name: "이동 적용", exact: true })
        .focus();
      const refreshDelay = holdNext("/api/v1/workflows/pages/leaf");
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" });
      await refreshDelay.seen;
      const documentSelect = page.getByRole("combobox", {
        name: "문서 선택",
        exact: true,
      });
      await documentSelect.focus();
      await documentSelect.selectOption("review");
      await page
        .locator("[data-document-heading]")
        .filter({ hasText: "검토 절차" })
        .waitFor();
      refreshDelay.release();
      await refreshDelay.done;
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      assert.match(
        await page.locator("[data-document-heading]").innerText(),
        /검토 절차/,
      );
      assert.ok(
        await documentSelect.evaluate((el) => el === document.activeElement),
      );
      await page.screenshot({
        path: `${output}/${width}-${theme}-move-race.png`,
      });
      const copyInput = {
        pageId: "leaf",
        version: 1,
        parentId: null,
        mutationId: randomUUID(),
      };
      const issued = await canonical("/convenience/credentials", {
        operation: "duplicate",
        input: copyInput,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
      const machine = () =>
        fetch("http://127.0.0.1:4397/api/v1/convenience/pages/duplicate", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${issued.secret}`,
            "X-Space-Id": f.spaceId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(copyInput),
        });
      const firstResponse = await machine();
      assert.equal(firstResponse.status, 200);
      const firstCopy = await firstResponse.json();
      assert.equal(firstCopy.dependencyVersions.review, 1);
      assert.equal(firstCopy.dependencyVersions.leaf, 1);
      const moved = await canonical("/workflows/pages/leaf");
      assert.equal(moved.settings.parent_id, null);
      assert.equal(moved.page.id, "leaf");
      await go();
      await page.locator("[data-document-heading]").waitFor();
      await page
        .getByRole("navigation", { name: "문서 경로", exact: true })
        .getByRole("link", { name: "문서 구조", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("navigation", { name: "문서 경로", exact: true })
          .getByRole("link")
          .count(),
        1,
      );
      await canonical("/workflows/pages/leaf/state", {
        expectedRevision: moved.settings.revision,
        state: "trash",
        reason: "합성 이름 변경 복원 검증",
      });
      await canonical("/workflows/pages/leaf/state", {
        expectedRevision: moved.settings.revision + 1,
        state: "active",
        restoreTitle: "문서 구조 변경 기록",
        reason: "합성 이름 변경 복원 검증",
      });
      await go();
      await page
        .locator("[data-document-heading]")
        .filter({ hasText: "문서 구조 변경 기록" })
        .waitFor();
      const replayResponse = await machine();
      assert.equal(replayResponse.status, 200);
      assert.deepEqual(await replayResponse.json(), firstCopy);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM workflow_drafts WHERE workspace_id=$1 AND id=$2",
            [f.spaceId, firstCopy.id],
          )
        ).rows[0].n,
        1,
      );
      await page
        .getByRole("button", { name: "개인 초안으로 복제", exact: true })
        .click();
      await page.waitForURL(/section=compose.*draft=copy-/);
      await page
        .getByRole("textbox", { name: "문서 제목", exact: true })
        .waitFor();
      const draftId = new URL(page.url()).searchParams.get("draft"),
        drafts = await canonical("/workflows/drafts");
      assert.ok(
        drafts.items.some(
          (d) =>
            d.id === draftId && d.dependencyVersions.leaf === 1 && !d.pageId,
        ),
      );
      await db.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND principal_id='reviewer'",
        [f.spaceId],
      );
      assert.notEqual((await machine()).status, 200);
      await go();
      await page.waitForFunction(
        () => !document.querySelector("[data-document-heading]"),
      );
      assert.equal((await canonical("/convenience/tree")).items.length, 0);
      assert.equal((await canonical("/workflows/drafts")).items.length, 0);
      assert.equal(errors.length, 0, errors.join("\n"));
      results.push({
        width,
        theme,
        spaceId: f.spaceId,
        threeLevelPath: true,
        hiddenTitleAbsent: true,
        keyboardMove: true,
        mobileFocus: width === 390 ? "verified" : "not-applicable",
        oldLinkAfterMoveAndRename: true,
        privateDuplicate: true,
        linkedDuplicateRenameReplay: true,
        issuedMachinePermitAndRevocation: true,
        delayedMoveRefreshSelection: true,
        mobileDelayedSelectionFocus:
          width === 390 ? "verified" : "not-applicable",
        mobileOutsideFocusPreserved:
          width === 390 ? "verified" : "not-applicable",
        sourceRevocation: true,
        requests: requests.length,
        pageErrors: errors,
      });
      await context.close();
    }
  await writeFile(
    output + "/browser-results.json",
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        browser: "Chromium headless",
        actorAdapter:
          "explicit synthetic loopback; canonical HTTP/PG responses unchanged",
        runtimeStartedAt: fixture.startedAt,
        frontendStartedAt: frontend.startedAt,
        productionFingerprint: fixture.productionFingerprint,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  console.error("Capture failure:", e);
  for (const context of contexts) {
    const page = context.pages()[0];
    if (page)
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "closed")
        ).slice(0, 10000),
      );
  }
  throw e;
} finally {
  for (const c of contexts) {
    await c.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await c.close().catch(() => {});
  }
  for (const p of profiles) await rm(p, { recursive: true, force: true });
  await db.end();
}
