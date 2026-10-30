import type { UsageSummary } from "../domain/usage";
import { useEffect, useState } from "react";
import { loadUsage } from "../adapters/usage";
import { Badge, Button, Empty } from "../ui/primitives";
import "./usage.css";

const operationNames: Record<string, string> = {
  "page.read": "페이지 조회",
  "source.register": "원본 등록",
  "batch.propose": "변경 제안",
  "batch.approve": "변경 승인",
  "batch.publish": "발행 호출",
};
const number = (v: number) => v.toLocaleString("ko-KR");

export function UsageReport({ data }: { data: UsageSummary }) {
  const max = Math.max(1, ...data.daily.map((d) => d.succeeded + d.failed));
  return (
    <div className="usage-report">
      <section className="usage-notice" aria-label="집계 기준">
        <Badge tone="plum">
          {data.scope === "workspace" ? "워크스페이스 전체" : "내 사용량"}
        </Badge>
        <p>{`${number(data.total)}건 중 ${number(data.succeeded)}건 성공 · ${number(data.failed)}건 실패`}</p>
        <p>
          계측된 서비스 호출 기준입니다. 페이지 단건/고정 버전 조회, 원본 등록,
          변경 제안·승인·발행만 포함하며 질문·Lint·목록 조회 등 전체 API
          사용량이 아닙니다. 재시도도 호출에 포함되며 실제 발행 건수와
          구분합니다. 로컬 데모 화면의 활동은 수집하지 않습니다.
        </p>
        <p className="muted">
          {data.from.slice(0, 10)} ~ {data.to.slice(0, 10)} · UTC · 오늘은 집계
          중
        </p>
      </section>
      <div className="usage-cards">
        {[
          ["전체 호출", data.total, "건"],
          ["실패 호출", data.failed, "건"],
          ["활성 사용자", data.activeUsers, "명"],
          ["실제 발행", data.publications, "건"],
        ].map(([label, value, unit]) => (
          <section
            className="usage-card"
            key={label}
            aria-label={String(label)}
          >
            <h2>{label}</h2>
            <p>
              <strong>{number(Number(value))}</strong> {unit}
            </p>
          </section>
        ))}
      </div>
      <p className="muted">
        활성 사용자는 선택 기간에 기록된 호출 주체의 고유 수입니다. 로그인
        사용자·전체 멤버·에이전트 재사용 성공 수가 아닙니다.
      </p>
      {data.total === 0 && (
        <Empty
          title="기록된 사용량이 없습니다"
          description="선택 기간에 서버에 기록된 호출이 없습니다. 서버 미연결 상태와는 다릅니다."
        />
      )}
      {data.total > 0 && (
        <>
          <section className="usage-panel">
            <h2>일별 호출 추이</h2>
            <p className="muted">
              단위: 건 · 최대 {number(max)}건 · 성공과 실패를 함께 표시합니다.
            </p>
            <p className="usage-legend">
              <span>
                <i className="usage-success" />
                성공
              </span>
              <span>
                <i className="usage-failure" />
                실패
              </span>
            </p>
            <p id="usage-chart-help" className="muted">
              좌우로 스크롤해 모든 날짜를 확인하세요. 각 막대에 성공·실패 건수가
              표시됩니다.
            </p>
            <div
              className="usage-chart-scroll"
              tabIndex={0}
              role="region"
              aria-label="일별 호출 그래프"
              aria-describedby="usage-chart-help"
            >
              <div
                className="usage-chart"
                style={{
                  minWidth: `${Math.max(560, data.daily.length * 76)}px`,
                }}
              >
                {data.daily.map((d) => (
                  <div className="usage-day" key={d.day}>
                    <span className="usage-day-count">
                      {d.succeeded + d.failed}건
                    </span>
                    <div
                      className="usage-bars"
                      role="img"
                      aria-label={`${d.day} 성공 ${d.succeeded}건, 실패 ${d.failed}건`}
                    >
                      <div
                        className="usage-success"
                        style={{ height: `${(d.succeeded / max) * 140}px` }}
                      />
                      <div
                        className="usage-failure"
                        style={{ height: `${(d.failed / max) * 140}px` }}
                      />
                    </div>
                    <span>{d.day.slice(5).replace("-", "/")}</span>
                    <span className="usage-day-detail">
                      성공 {d.succeeded}
                      <br />
                      실패 {d.failed}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
          <section className="usage-panel">
            <h2>작업별 사용량</h2>
            <p className="muted">
              평균 소요시간은 서버 측정값이며 실패·대기 시간을 포함합니다. 짧은
              실패를 성능 개선으로 해석하지 않습니다.
            </p>
            <div
              className="usage-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="작업별 사용량 표 · 가로 스크롤 가능"
            >
              <table>
                <caption>선택 기간 내 작업별 호출 및 실패 건수</caption>
                <thead>
                  <tr>
                    <th scope="col">작업</th>
                    <th scope="col">전체 호출</th>
                    <th scope="col">실패</th>
                    <th scope="col">평균 소요시간</th>
                  </tr>
                </thead>
                <tbody>
                  {data.operations.map((op) => (
                    <tr key={op.operation}>
                      <th scope="row">
                        {operationNames[op.operation] ?? op.operation}
                      </th>
                      <td>{number(op.total)}건</td>
                      <td>{number(op.failed)}건</td>
                      <td>{op.averageDurationMs.toFixed(1)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <section className="usage-panel">
        <h2>모델 사용량 · 미수집</h2>
        <p>
          입력·출력 토큰과 비용은 아직 계측하지 않습니다. 미수집 값을 0이나
          무료로 표시하지 않습니다.
        </p>
      </section>
    </div>
  );
}

export function UsageDashboard() {
  const [days, setDays] = useState(7);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ data?: UsageSummary; error?: string }>(
    {},
  );
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    loadUsage(days, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            error:
              error instanceof Error
                ? error.message
                : "사용량 조회에 실패했습니다.",
          });
      });
    return () => controller.abort();
  }, [days, retry]);
  return (
    <div className="page-wrap usage-dashboard">
      <div className="page-heading">
        <div>
          <h1>사용량 대시보드</h1>
          <p>서버에 남긴 사용 기록과 작업별 활동을 확인합니다.</p>
        </div>
        <label className="usage-period">
          조회 기간
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>최근 7일</option>
            <option value={30}>최근 30일</option>
          </select>
        </label>
      </div>
      <p className="usage-boundary">
        데모 역할 선택은 조회 권한을 바꾸지 않습니다. 서버의 인증 주체와
        권한으로 집계 범위를 결정합니다.
      </p>
      {state.data ? (
        <UsageReport data={state.data} />
      ) : state.error ? (
        <section role="alert" className="usage-panel">
          <h2>사용량을 불러오지 못했습니다</h2>
          <p>{state.error}</p>
          <p>
            로컬 데모에는 인증된 사용량 서버가 연결되어 있지 않습니다. 기록
            없음이나 0건으로 대체하지 않습니다.
          </p>
          <Button onClick={() => setRetry((v) => v + 1)}>다시 시도</Button>
        </section>
      ) : (
        <p role="status" className="usage-panel">
          서버 사용량을 불러오는 중입니다…
        </p>
      )}
    </div>
  );
}
