import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";
import { productionFailures } from "./release.mjs";
const directory = process.argv[2];
if (!directory) {
  console.error("Usage: node scripts/k8s/validate-production.mjs SITE_OVERLAY");
  process.exit(1);
}
try {
  const rendered = execFileSync("kubectl", ["kustomize", directory], {
    encoding: "utf8",
  });
  const resources = parseAllDocuments(rendered)
    .map((d) => {
      if (d.errors.length) throw Error("YAML_INVALID");
      return d.toJSON();
    })
    .filter(Boolean);
  const failures = productionFailures(resources);
  if (failures.length) {
    for (const reason of failures) console.error(`배포 차단: ${reason}`);
    process.exitCode = 1;
  } else
    console.log(
      "정적 구성 검사 통과. 실제 SSO/TLS/CNI/복원/운영 인수는 별도 실행해야 합니다.",
    );
} catch {
  console.error("운영 overlay 렌더링 실패");
  process.exitCode = 1;
}
