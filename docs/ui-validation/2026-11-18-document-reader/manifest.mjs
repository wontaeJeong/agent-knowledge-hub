import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const dir = "docs/ui-validation/2026-11-18-document-reader";
const hash = async (p) =>
  createHash("sha256")
    .update(await readFile(p))
    .digest("hex");
export async function sourceHashes() {
  const files = execFileSync("rg", ["--files", "src", "server"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((p) => !p.includes(".test.") && /\.(ts|tsx|sql|css|json)$/.test(p));
  files.push("vite.config.ts", "package.json", "package-lock.json", "scripts/rebuild-links.ts");
  const production = Object.fromEntries(
    await Promise.all(files.sort().map(async (p) => [p, await hash(p)])),
  );
  return {
    production,
    productionFingerprint: createHash("sha256")
      .update(JSON.stringify(production))
      .digest("hex"),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--frontend-start")) {
    await writeFile(
      "/private/tmp/akh_c9_frontend-start.json",
      JSON.stringify({
        startedAt: new Date().toISOString(),
        ...(await sourceHashes()),
      }),
    );
  } else if (process.argv.includes("--verify")) {
    const m = JSON.parse(await readFile(dir + "/source-manifest.json", "utf8"));
    for (const [p, h] of Object.entries({
      ...m.production,
      ...m.harness,
      ...m.regressions,
      ...m.artifacts,
      ...m.logs,
    }))
      if ((await hash(p)) !== h) throw Error("Evidence hash mismatch: " + p);
    console.log(
      `Verified ${Object.keys(m.production).length} production, ${Object.keys(m.harness).length} harness, ${Object.keys(m.regressions).length} regression sources, ${Object.keys(m.artifacts).length} artifacts, ${Object.keys(m.logs).length} logs`,
    );
  } else {
    const source = await sourceHashes(),
      browser = JSON.parse(
        await readFile(dir + "/browser-results.json", "utf8"),
      );
    if (source.productionFingerprint !== browser.productionFingerprint)
      throw Error("Browser/source fingerprint mismatch");
    const harness = Object.fromEntries(
      await Promise.all(
        ["reader-runtime.ts", "capture.mjs", "manifest.mjs"].map(
          async (p) => [dir + "/" + p, await hash(dir + "/" + p)],
        ),
      ),
    );
    const regressions = Object.fromEntries(
      await Promise.all(
        [
          "src/operational/convenience/reader.test.tsx",
          "src/operational/convenience/reader-revalidation.test.tsx",
          "src/operational/workflows-reader.test.tsx",
          "server/convenience/anchors.test.ts",
          "server/workflows/lineage-closure.test.ts",
          "server/workflows/navigation-http.test.ts",
        ].map(async (p) => [p, await hash(p)]),
      ),
    );
    const artifacts = Object.fromEntries(
      await Promise.all(
        (await readdir(dir))
          .filter(
            (p) =>
              p.endsWith(".png") ||
              ["browser-results.json", "cleanup.json", "withdrawn-discovery-fixture.patch"].includes(p),
          )
          .sort()
          .map(async (p) => [dir + "/" + p, await hash(dir + "/" + p)]),
      ),
    );
    const logdir = ".superpowers/sdd/2026-11-16-essential-convenience",
      logs = Object.fromEntries(
        await Promise.all(
          (await readdir(logdir))
            .filter((p) => /^c9-.*\.log$/.test(p) && p !== "c9-baseline.log")
            .sort()
            .map(async (p) => [logdir + "/" + p, await hash(logdir + "/" + p)]),
        ),
      );
    await writeFile(
      dir + "/source-manifest.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          base: "79a90cc9c06c476cd270dec2d17ce11faf11e7e3",
          runtimeStartedAt: browser.startedAt,
          frontendStartedAt: browser.frontendStartedAt,
          ...source,
          harness,
          regressions,
          artifacts,
          logs,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Bound final production, runtime/frontend start, harness, artifacts and logs",
    );
  }
}
