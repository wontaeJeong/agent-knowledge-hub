import { Badge, Button } from "../ui/primitives";
import { featureCoverage } from "./coverage";
import { consoleLabel } from "./console";
import type { ConsoleTab } from "./console";
import { ConsoleTable } from "./ConsoleTable";
import { useState } from "react";

export function Coverage({
  navigate,
}: {
  navigate: (tab: ConsoleTab) => void;
}) {
  const [priority, setPriority] = useState("전체");
  const [selected, setSelected] = useState<string | null>(null);
  const r = featureCoverage.find((r) => r.id === selected);
  const visible = featureCoverage.filter(
    (r) => priority === "전체" || r.priority === priority,
  );
  return (
    <>
      <section className="op-panel">
        <div className="op-section-head">
          <h2>전체 기능 점검표</h2>
          <Badge tone="amber">251개 · 운영 수용 미검증</Badge>
        </div>
        <p>
          239개 기준 + 핵심 순환 12개를 빠짐없이 보존합니다. 화면 연결은 탐색
          경로이며 해당 수용 기준 전체를 구현했다는 뜻이 아닙니다. 상세에서
          요구사항과 남은 검증 조건을 확인하세요.
        </p>
        <label className="console-inline-filter">
          우선순위
          <select
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
              setSelected(null);
            }}
          >
            {["전체", "필수", "확장", "선택"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <ConsoleTable
          key={priority}
          caption="전체 제품 요구사항"
          columns={["ID · 기능", "영역", "우선순위", "탐색 경로", "운영 상태"]}
          rows={visible.map((r) => ({
            id: r.id,
            search: `${r.id} · ${r.title} ${r.domain} ${r.requirement} ${r.priority}`,
            cells: [
              <span>
                <code>{r.id}</code>
                <strong className="console-cell-title">{r.title}</strong>
              </span>,
              r.domain,
              r.priority,
              <Button variant="ghost" onClick={() => navigate(r.surface)}>
                {consoleLabel(r.surface)}
              </Button>,
              <Badge tone="amber">미검증</Badge>,
            ],
          }))}
          select={setSelected}
        />
      </section>
      {r && (
        <section className="op-panel console-detail" tabIndex={-1}>
          <div className="op-section-head">
            <h2>
              {r.id} · {r.title}
            </h2>
            <Button onClick={() => setSelected(null)}>상세 닫기</Button>
          </div>
          <p>{r.requirement}</p>
          <h3>수용 기준 · 아직 통과 결과가 아닙니다</h3>
          <p>{r.acceptance}</p>
          <p>
            담당 역할: {r.owner_role} · 단계: {r.phase}
          </p>
          <p>
            남은 조건: 실제 서버 연결, 권한/실패 회귀 및 요구사항별 독립 증거가
            필요합니다. 관리 화면은 목업이며 선택 기능은 정책 승인 전
            비활성입니다.
          </p>
          <Button onClick={() => navigate(r.surface)}>연결 화면 열기</Button>
        </section>
      )}
    </>
  );
}
