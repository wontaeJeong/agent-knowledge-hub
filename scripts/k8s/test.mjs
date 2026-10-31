import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This one integration suite needs a dedicated fresh PostgreSQL database AND
// native Kind pod execution. CI's static job must not imply it ran this gate.
export const nativeKindSuites = ["operations-backup-db.test.mjs"];
export function staticSuites(names) {
  return names.filter((name) => name.endsWith(".test.mjs") &&
    !nativeKindSuites.includes(name)).sort();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("NOT EXECUTED: native Kind backup/restore acceptance (operations-backup-db.test.mjs); requires dedicated DB + Kind context.");
  const files = staticSuites(readdirSync(new URL("./", import.meta.url)))
    .map((name) => fileURLToPath(new URL(name, import.meta.url)));
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (result.error) console.error("K8S_TEST_RUNNER_FAILED");
  process.exitCode = result.status ?? 1;
}
