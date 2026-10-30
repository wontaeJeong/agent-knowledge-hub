const escape = (value) =>
  String(value ?? "미확인").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  "no-wiki": "위키 미사용",
  "raw-retrieval": "원본 검색",
  "persistent-wiki": "유지 위키",
};
const percent = (value) =>
  value === null ? "해당 없음" : `${(value * 100).toFixed(1)}%`;
export function renderReport(report) {
  const table = (caption, headers, rows) =>
    `<div class="scroll" tabindex="0" role="region" aria-label="${escape(caption)} 가로 스크롤"><table><caption>${escape(caption)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const summary = table(
    "조건별 배정 전체 분모",
    [
      "조건",
      "배정 (건)",
      "완료 (건)",
      "검증 성공 (건)",
      "성공률 (성공/배정)",
      "안전 실패 (건)",
    ],
    Object.entries(report.conditions).map(([k, v]) => [
      labels[k],
      v.assigned,
      v.completed,
      v.succeeded,
      `${percent(v.successRate)} (${v.succeeded}/${v.assigned})`,
      v.safetyFailures,
    ]),
  );
  const groups = [];
  for (let i = 0; i < report.results.length; i += 25)
    groups.push(
      `<details><summary>상세 실행 ${i + 1}–${Math.min(i + 25, report.results.length)}건</summary>${table(
        "개별 실행 및 미실행 근거",
        [
          "과제/시나리오",
          "조건",
          "상태",
          "답변",
          "검증 성공",
          "안전 실패",
          "시간 (ms)",
          "비용 (USD)",
          "토큰 (개)",
        ],
        report.results
          .slice(i, i + 25)
          .map((r) => [
            `${r.taskId} / ${r.scenario}`,
            labels[r.condition],
            r.status,
            r.answer,
            r.success ? "예" : "아니오",
            r.safetyFailure ? "예" : "아니오",
            r.durationMs === null ? null : r.durationMs.toFixed(1),
            r.cost,
            r.tokens,
          ]),
      )}</details>`,
    );
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>지식 정련 평가 보고서</title><style>:root{font-family:system-ui,sans-serif;color:#29212d;background:#faf7fc;font-size:16px}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;padding:24px;margin:auto}h1{font-size:28px}h2{font-size:22px}section,details{background:#fff;border:1px solid #d9cddd;border-radius:12px;padding:20px;margin:20px 0}.notice{border-left:5px solid #77536f;background:#f1e7f3}a{color:#653a70}nav{display:flex;flex-wrap:wrap;gap:16px}p,li{line-height:1.6}.scroll{max-width:100%;overflow-x:auto;border-radius:8px;outline-offset:3px}table{border-collapse:collapse;min-width:760px;width:100%;font-size:14px}th,td{padding:12px;text-align:left;border-bottom:1px solid #e5dce9;vertical-align:top;min-width:90px;overflow-wrap:anywhere}caption{text-align:left;padding:12px;font-weight:600}th{background:#eee6f2}summary{cursor:pointer;padding:8px;font-weight:600}:focus-visible{outline:3px solid #77536f}code{overflow-wrap:anywhere}@media(max-width:500px){main{padding:16px}section,details{padding:14px}h1{font-size:24px}}</style></head><body><main><h1>지식 정련 평가 보고서</h1><section class="notice" aria-label="결론과 제한"><h2>실제 효과 미확인</h2><p>시험 종류: ${escape(report.kind)} · 상태: ${escape(report.status)}. 합성 회귀 결과를 실제 업무 개선이나 회사 승인으로 해석하지 않습니다.</p><ul>${report.limits.map((l) => `<li>${escape(l)}</li>`).join("")}</ul></section><nav aria-label="보고서 탐색"><a href="#metrics">핵심 수치</a><a href="#details">상세 근거</a><a href="#versions">재현 정보</a></nav><section id="metrics"><h2>핵심 수치</h2><p>배정 ${report.assigned}건 / 실행 ${report.executed}건 / 완료 ${report.completed}건 / 검증 성공 ${report.succeeded}건 / 실행 오류 ${report.failed}건 / 중단 ${report.aborted}건 / 미실행 ${report.unexecuted}건</p><p>전체 성공률 ${percent(report.successRate)} (${report.succeeded}/${report.assigned}), 완료 집합 성공률 ${percent(report.completedSuccessRate)} (${report.succeeded}/${report.completed}). 안전 실패 ${report.safetyFailures}건.</p><p>총비용 ${escape(report.cost)} USD · 확인된 부분 비용 ${escape(report.knownCost)} USD (${report.knownCostCases}/${report.assigned}건) · 유지 비용 ${escape(report.maintenanceCost)} USD · 토큰 ${escape(report.tokens)}개. 미확인은 0 실측이 아닙니다.</p>${summary}</section><section id="details"><h2>상세 근거</h2><p>모든 배정 행을 보존합니다. 표는 키보드로 초점을 이동한 뒤 좌우 스크롤할 수 있습니다. 원문 인용·조회 이력은 함께 생성한 JSON을 확인하세요.</p>${groups.join("")}</section><section id="versions"><h2>재현 정보</h2><p>평가 ID <code>${escape(report.id)}</code><br>자료 <code>${escape(report.datasetId)} / ${escape(report.datasetVersion)}</code><br>자료 해시 <code>${escape(report.datasetHash)}</code><br>정답 해시 <code>${escape(report.expectedHash)}</code></p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(JSON.stringify(report.config, null, 2))}</pre></section></main></body></html>`;
}
