import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.AKH_PLAYWRIGHT_MODULE);
const root = process.cwd(),
  out = root + "/docs/pr-assets/scheduled-publication";
await mkdir(out, { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: 1100 },
      timezoneId: "Asia/Seoul",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      server.resolvedUrls.local[0] +
        "docs/pr-assets/scheduled-publication/evidence.html",
    );
    await page.getByText("발행 예약", { exact: true }).click();
    const time = new Date(Date.now() + 300000 + 9 * 3600000)
      .toISOString()
      .slice(0, 16);
    await page.locator("input[type=datetime-local]").fill(time);
    await page
      .getByRole("button", { name: "예약 미리보기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "예약 확정", exact: true })
      .waitFor();
    if (
      !(await page
        .getByRole("status")
        .textContent()
        .then((t) => t.includes("UTC")))
    )
      throw Error("UTC_PREVIEW_MISSING");
    await page.screenshot({
      path: out + `/preview-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "예약 확정", exact: true }).click();
    await page
      .getByRole("button", { name: "예약 취소", exact: true })
      .waitFor();
    await page.screenshot({
      path: out + `/scheduled-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "예약 취소", exact: true }).click();
    await page.getByText("취소됨", { exact: false }).waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    if (overflow || errors.length)
      throw Error(JSON.stringify({ overflow, errors }));
    checks.push({
      width,
      height: 1100,
      previewUtc: true,
      explicitConsent: true,
      scheduled: true,
      cancelled: true,
      overflow,
      errors,
    });
    await page.close();
  }
  await writeFile(
    out + "/results.json",
    JSON.stringify(
      {
        kind: "actual React component with synthetic API; native OIDC/PG verified separately",
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
