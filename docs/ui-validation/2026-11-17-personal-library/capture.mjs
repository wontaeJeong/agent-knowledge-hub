// Real browser -> actual native API with explicit synthetic loopback identities only.
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
if (
  process.env.AKH_C3_SYNTHETIC_CAPTURE !== "1" ||
  !process.env.TEST_DATABASE_URL
)
  throw Error("Synthetic capture opt-in required");
const fixture = JSON.parse(
  await readFile("/private/tmp/akh-c3-browser.json", "utf8"),
);
if (!/^akh_c3_ui_\d+$/.test(fixture.database))
  throw Error("Owned database required");
const url = new URL(process.env.TEST_DATABASE_URL);
url.pathname = "/" + fixture.database;
const db = new Pool({ connectionString: url.href }),
  browser = await chromium.launch({ headless: true }),
  results = [];
const output = "docs/ui-validation/2026-11-17-personal-library";
try {
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
          viewport: { width, height: width === 1440 ? 1000 : 844 },
        }),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let stateGate = null,
        reorderGate = null;
      const delay = (kind) => {
        let entered, release;
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        const gate = {
          wait,
          release,
          entered: new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error(`No delayed ${kind} response`)),
              10000,
            );
            entered = () => {
              clearTimeout(timer);
              resolve();
            };
          }),
          enter: () => entered(),
        };
        if (kind === "state") stateGate = gate;
        else reorderGate = gate;
        return gate;
      };
      await page.route("**/api/**", async (route) => {
        const request = route.request(),
          u = new URL(request.url());
        const response = await route.fetch({
          url: `http://127.0.0.1:4393${u.pathname}${u.search}`,
          headers: {
            ...request.headers(),
            cookie: "synthetic-session",
            origin: "http://127.0.0.1:5193",
          },
        });
        // Only delay actual canonical responses; never fabricate API DTOs.
        const gate = u.pathname.endsWith("/personal-state")
          ? stateGate
          : u.pathname.endsWith("/favorites/reorder")
            ? reorderGate
            : null;
        if (gate) {
          if (u.pathname.endsWith("/personal-state")) stateGate = null;
          else reorderGate = null;
          gate.enter();
          await gate.wait;
        }
        await route.fulfill({ response });
      });
      const visits = async () =>
        Number(
          (
            await db.query(
              "SELECT count(*) n FROM workflow_activity WHERE workspace_id=$1 AND principal_id='reviewer' AND kind='recent'",
              [fixture.workspaceId],
            )
          ).rows[0].n,
        );
      const before = await visits();
      const go = async (kind) => {
        await page.goto(
          `http://127.0.0.1:5193/?app=1&space=${fixture.workspaceId}&section=${kind}`,
        );
        await page.locator(".personal-library-list a").first().waitFor();
        await page.evaluate(
          (t) => (document.documentElement.dataset.theme = t),
          theme,
        );
        await page.locator(".personal-library").scrollIntoViewIfNeeded();
      };
      await go("favorites");
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".personal-library-list li").length === 25,
      );
      const firstCount = await page
        .locator(".personal-library-list li")
        .count();
      const edge = page.locator(".personal-library-list li").nth(1),
        edgeTitle = await edge.locator("a").innerText();
      await edge
        .getByRole("button", { name: `${edgeTitle} 위로 이동`, exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (title) =>
          document.activeElement?.getAttribute("aria-label") ===
          `${title} 아래로 이동`,
        edgeTitle,
      );
      const moved = page.locator(".personal-library-list li").nth(1),
        movedTitle = await moved.locator("a").innerText(),
        down = moved.getByRole("button", {
          name: `${movedTitle} 아래로 이동`,
          exact: true,
        });
      await down.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (title) =>
          document.querySelectorAll(".personal-library-list a")[2]
            ?.textContent === title,
        movedTitle,
      );
      await page.waitForFunction(
        (title) =>
          document.activeElement?.getAttribute("aria-label") ===
          `${title} 아래로 이동`,
        movedTitle,
      );
      await page.screenshot({
        path: `${output}/favorites-${width}-${theme}.png`,
      });
      for (const departure of ["keyboard", "pointer"]) {
        const row = page.locator(".personal-library-list li").nth(1);
        const title = await row.locator("a").innerText();
        const move = row.getByRole("button", {
          name: `${title} 아래로 이동`,
          exact: true,
        });
        const gate = delay("reorder");
        await move.focus();
        await page.keyboard.press("Enter");
        await gate.entered;
        const outside = page
          .locator(".console-topbar")
          .getByRole("button", { name: "검색", exact: true });
        if (departure === "keyboard") await outside.focus();
        else await page.locator(".console-topbar strong").click();
        const readback = page.waitForResponse((r) =>
          r.url().includes("/workflows/favorites?"),
        );
        gate.release();
        await readback;
        await page.waitForFunction(
          (title) =>
            document.querySelectorAll(".personal-library-list a")[2]
              ?.textContent === title,
          title,
        );
        if (
          departure === "keyboard" &&
          !(await outside.evaluate((e) => document.activeElement === e))
        )
          throw Error("Reorder stole intentional outside keyboard focus");
        if (
          departure === "pointer" &&
          (await page.evaluate(() =>
            document
              .querySelector(".personal-library")
              ?.contains(document.activeElement),
          ))
        )
          throw Error("Reorder stole intentional outside pointer focus");
      }
      await page
        .getByRole("button", { name: "다음 25개", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".personal-library-list li").length === 3,
      );
      const lastCount = await page.locator(".personal-library-list li").count();
      await page.screenshot({
        path: `${output}/favorites-next-${width}-${theme}.png`,
      });
      await page.evaluate(() => scrollTo(0, 0));
      if (width === 390) await page.locator(".console-menu-toggle").click();
      await page
        .locator("#console-navigation")
        .getByRole("link", { name: "구독", exact: true })
        .click();
      await page
        .locator(
          '.personal-library[aria-label="구독 문서"] .personal-library-list a',
        )
        .first()
        .waitFor();
      if (
        width === 390 &&
        (await page
          .locator(".console-menu-toggle")
          .getAttribute("aria-expanded")) !== "false"
      )
        throw Error("Mobile navigation did not close");
      await page.locator(".personal-library").scrollIntoViewIfNeeded();
      const subscriptions = await page
        .locator(".personal-library-list li")
        .count();
      await page.screenshot({
        path: `${output}/subscriptions-${width}-${theme}.png`,
      });
      await go("recent");
      await page.screenshot({ path: `${output}/recent-${width}-${theme}.png` });
      if ((await visits()) !== before)
        throw Error("Rendering lists recorded a visit");
      await page.goto(
        `http://127.0.0.1:5193/?app=1&space=${fixture.workspaceId}&document=library-28`,
      );
      const controls = page.locator('[aria-label="개인 문서 설정"]');
      await controls
        .getByRole("button", { name: "즐겨찾기 해제", exact: true })
        .waitFor();
      for (const [before, after] of [
        ["즐겨찾기 해제", "즐겨찾기 추가"],
        ["즐겨찾기 추가", "즐겨찾기 해제"],
        ["알림 구독", "구독 해제"],
        ["구독 해제", "알림 구독"],
      ]) {
        const control = controls.getByRole("button", {
          name: before,
          exact: true,
        });
        const node = await control.elementHandle();
        const gate = delay("state");
        await control.focus();
        await page.keyboard.press("Enter");
        await gate.entered;
        if (
          !(await node.evaluate(
            (e) => e.isConnected && document.activeElement === e,
          ))
        )
          throw Error("Pending toggle readback removed keyboard focus");
        const readback = page.waitForResponse((r) =>
          r.url().includes("/pages/library-28/personal-state"),
        );
        gate.release();
        await readback;
        await controls
          .getByRole("button", { name: after, exact: true })
          .waitFor();
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '[aria-label="개인 문서 설정"] button[aria-disabled="true"]',
            ),
        );
        if (
          !(await node.evaluate(
            (e) => e.isConnected && document.activeElement === e,
          ))
        )
          throw Error("Authorized toggle readback lost keyboard focus");
      }
      for (const label of ["즐겨찾기 해제", "알림 구독"]) {
        const control = controls.getByRole("button", {
            name: label,
            exact: true,
          }),
          node = await control.elementHandle(),
          gate = delay("state");
        await control.focus();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await gate.entered;
        if (
          !(await node.evaluate(
            (e) => e.isConnected && document.activeElement === e,
          ))
        )
          throw Error("Pending focus refresh removed control focus");
        const readback = page.waitForResponse((r) =>
          r.url().includes("/pages/library-28/personal-state"),
        );
        gate.release();
        await readback;
        if (
          !(await node.evaluate(
            (e) => e.isConnected && document.activeElement === e,
          ))
        )
          throw Error("Authorized focus refresh lost control focus");
      }
      await controls.scrollIntoViewIfNeeded();
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      if (
        (await page.evaluate(() => document.documentElement.dataset.theme)) !==
        theme
      )
        throw Error("Document theme did not apply");

      await page.screenshot({
        path: `${output}/document-state-${width}-${theme}.png`,
      });
      if ((await visits()) < before) throw Error("Recent visit lost");
      await go("favorites");
      await db.query(
        "DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",
        [fixture.workspaceId],
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() =>
        document
          .querySelector(".personal-library")
          ?.textContent?.includes("표시할 문서 없음"),
      );
      if (
        (await page.locator(".personal-library").innerText()).includes(
          "합성 문서",
        )
      )
        throw Error("Revoked title persisted");
      await page.screenshot({
        path: `${output}/revoked-${width}-${theme}.png`,
      });
      const persisted = await page.evaluate(() => ({
        local: Object.values(localStorage).some((v) => v.includes("합성 문서")),
        session: Object.values(sessionStorage).some((v) =>
          v.includes("합성 문서"),
        ),
      }));
      if (persisted.local || persisted.session)
        throw Error("Protected title persisted in browser storage");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      if (overflow) throw Error("Horizontal overflow");
      await db.query(
        "INSERT INTO resource_readers VALUES($1,'source','source-a','reviewer') ON CONFLICT DO NOTHING",
        [fixture.workspaceId],
      );
      results.push({
        browser: browser.version(),
        width,
        theme,
        firstCount,
        lastCount,
        subscriptions,
        keyboardReorder: true,
        boundaryFocusFallback: true,
        focusRestored: true,
        mobileNavigation: true,
        currentStateToggle: true,
        delayedBothToggleFocus: true,
        delayedBothRefreshFocus: true,
        reorderOutsideKeyboardNoSteal: true,
        reorderOutsidePointerNoSteal: true,
        documentThemeVerified: theme,
        listsDoNotVisit: true,
        currentAclRevocation: true,
        noHiddenPersistence: true,
        overflow,
        errors,
      });
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  await writeFile(
    `${output}/browser-results.json`,
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await db.query(
    "INSERT INTO resource_readers VALUES($1,'source','source-a','reviewer') ON CONFLICT DO NOTHING",
    [fixture.workspaceId],
  );
  await db.end();
  await browser.close();
}
