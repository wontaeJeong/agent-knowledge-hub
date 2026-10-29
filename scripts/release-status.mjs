import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function buildReleaseStatus(requirements, evidence = {}) {
  const items = requirements.map((r) => ({
    id: r.id,
    domain: r.domain,
    title: r.title,
    priority: r.priority,
    acceptance: r.acceptance,
    baselineStatus: r.status,
    implementationStatus: evidence[r.id]
      ? "부분 구현 근거 있음"
      : "개별 구현·검증 근거 확인 필요",
    evidence: evidence[r.id] ?? null,
    productionAccepted: false,
  }));
  return {
    version: 1,
    summary: {
      total: items.length,
      required: items.filter((r) => r.priority === "필수").length,
      withPartialEvidence: items.filter((r) => r.evidence).length,
      productionAccepted: 0,
    },
    items,
    notice:
      "구현 경로·회귀 근거는 수용 기준 전체의 통과가 아닙니다. 사내 인수 증거 없이 자동 완료 승격하지 않습니다.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rows = [
    "docs/requirements/requirements.json",
    "docs/requirements/core-requirements.json",
  ].flatMap((p) => JSON.parse(readFileSync(p, "utf8")).requirements);
  const evidence = JSON.parse(
    readFileSync("docs/requirements/operational-evidence.json", "utf8"),
  );
  const result = buildReleaseStatus(rows, evidence);
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(result.notice);
}
