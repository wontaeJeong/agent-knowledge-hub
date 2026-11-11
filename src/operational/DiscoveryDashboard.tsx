import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Link2,
  MessageSquareQuote,
  TrendingUp,
} from "lucide-react";
import type { DiscoveryRank, DiscoveryReport } from "../domain/discovery";
import { ApiError, OperationalApi, documentHref } from "./api";
import "./discovery.css";

type Period = 7 | 14 | 30 | 90;
function Ranking({
  title,
  description,
  items,
  metric,
  spaceId,
  preview,
}: {
  title: string;
  description: string;
  items: DiscoveryRank[];
  metric: "citations" | "links" | "recentLinks";
  spaceId: string;
  preview?: boolean;
}) {
  return (
    <section className="op-panel discovery-ranking">
      <div className="discovery-section-head">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="discovery-empty">표시할 기록이 아직 없습니다.</p>
      ) : (
        <ol>
          {items.map((item, i) => (
            <li key={item.id}>
              <span className="discovery-rank">
                {String(i + 1).padStart(2, "0")}
              </span>
              <a
                href={
                  preview
                    ? "?preview=1#knowledge"
                    : `${documentHref(spaceId, item.id)}#workflows`
                }
              >
                <strong>{item.title}</strong>
                <small>{item.summary || `발행본 v${item.version}`}</small>
              </a>
              <span className="discovery-count">
                {item[metric]}
                <small>건</small>
              </span>
              <ArrowUpRight size={16} aria-hidden="true" />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function DiscoveryReportView({
  report,
  spaceId,
  preview = false,
}: {
  report: DiscoveryReport;
  spaceId: string;
  preview?: boolean;
}) {
  const max = Math.max(1, ...report.daily.map((d) => d.citations));
  const items = [
    {
      label: "현재 권고 대상 문서",
      value: report.pages,
      unit: "개",
      icon: BookOpen,
    },
    { label: "문서 간 연결", value: report.links, unit: "건", icon: Link2 },
    {
      label: report.scope === "self" ? "내 질문 인용" : "공간 질문 인용",
      value: report.citations,
      unit: "건",
      icon: MessageSquareQuote,
    },
  ];
  return (
    <>
      <div className="discovery-cards">
        {items.map(({ label, value, unit, icon: Icon }) => (
          <div className="discovery-card" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={18} aria-hidden="true" />
            </div>
            <strong>
              {value.toLocaleString()}
              <small>{unit}</small>
            </strong>
          </div>
        ))}
      </div>
      <section className="op-panel discovery-chart">
        <div className="discovery-section-head">
          <div>
            <h2>질문 인용 추이</h2>
            <p>
              {report.scope === "self"
                ? "내 질문"
                : "공간 내 접근 가능한 입력의 질문"}
              에서 문서별로 인용된 답변 수 · UTC
            </p>
          </div>
          <span className="discovery-chart-total">
            {report.citations.toLocaleString()} <small>건</small>
          </span>
        </div>
        <div
          className="discovery-chart-bars"
          role="img"
          aria-label={`선택 기간 질문 인용 ${report.citations}건. 상세 일별 값은 아래 표를 확인하세요.`}
        >
          {report.daily.map((d) => (
            <div className="discovery-bar-column" key={d.day}>
              <div
                title={`${d.day}: ${d.citations}건`}
                className="discovery-bar"
                style={{
                  height: `${d.citations ? Math.max(3, (d.citations / max) * 100) : 0}%`,
                }}
              />
            </div>
          ))}
        </div>
        <div className="discovery-chart-axis">
          <span>{report.daily[0]?.day}</span>
          <span>{report.daily.at(-1)?.day}</span>
        </div>
        <p className="discovery-cutoff">
          UTC {report.to.replace("T", " ").slice(0, 16)} 기준 · 오늘은 집계 중
        </p>
        <details className="discovery-table-details">
          <summary>일별 데이터 보기</summary>
          <table>
            <thead>
              <tr>
                <th>날짜 (UTC)</th>
                <th>인용</th>
              </tr>
            </thead>
            <tbody>
              {report.daily.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.citations}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
      <div className="discovery-rankings">
        <Ranking
          title="트렌딩 지식"
          description="기간 중 갱신된 다른 발행 문서에서 연결된 횟수"
          items={report.trending}
          metric="recentLinks"
          spaceId={spaceId}
          preview={preview}
        />
        <Ranking
          title="많이 연결된 지식"
          description="접근 가능한 전체 발행 문서에서 연결된 횟수"
          items={report.mostLinked}
          metric="links"
          spaceId={spaceId}
          preview={preview}
        />
        <Ranking
          title={
            report.scope === "self"
              ? "내 질문에서 자주 인용"
              : "질문에서 자주 인용"
          }
          description="선택한 기간 · 답변 하나에서 같은 문서는 한 번만 계산"
          items={report.mostCited}
          metric="citations"
          spaceId={spaceId}
          preview={preview}
        />
      </div>
      <p className="discovery-note">
        <TrendingUp size={16} aria-hidden="true" /> 트렌딩은 조회 수가 아닌 최근
        갱신된 연결을 기준으로 합니다. 인용 횟수가 정확성이나 독립적인 근거의
        수를 보증하지 않습니다. 현재 권고 대상인 발행본과 접근이 유효한 입력만
        집계하며, 권한·문서 변경 시 이전 수치가 달라질 수 있습니다.
      </p>
    </>
  );
}

export function DiscoveryDashboard({
  api,
  spaceId,
  preview = false,
}: {
  api: OperationalApi;
  spaceId: string;
  preview?: boolean;
}) {
  const [days, setDays] = useState<Period>(7);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    days: Period;
    report?: DiscoveryReport;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    api
      .get<DiscoveryReport>(`/discovery?days=${days}`)
      .then((report) => {
        if (active) setResult({ days, report });
      })
      .catch((error: unknown) => {
        if (active)
          setResult({
            days,
            error:
              error instanceof ApiError && error.code === "DISCOVERY_CAPACITY"
                ? error.message
                : "집계를 불러오지 못했습니다. 권한과 서버 상태를 확인해 주세요.",
          });
      });
    return () => {
      active = false;
    };
  }, [api, days, attempt]);
  const current = result?.days === days ? result : null;
  return (
    <div className="discovery-dashboard">
      <div className="discovery-intro">
        <div>
          <span className="discovery-eyebrow">KNOWLEDGE DISCOVERY</span>
          <h2>주목할 지식을 찾아보세요</h2>
          <p>많이 연결된 문서와 최근 지식의 흐름을 한눈에 확인합니다.</p>
        </div>
        <label>
          기간{" "}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as Period)}
            aria-label="지식 통계 기간"
          >
            <option value={7}>최근 7일</option>
            <option value={14}>최근 14일</option>
            <option value={30}>최근 30일</option>
            <option value={90}>최근 90일</option>
          </select>
        </label>
      </div>
      {current?.report ? (
        <DiscoveryReportView
          report={current.report}
          spaceId={spaceId}
          preview={preview}
        />
      ) : current?.error ? (
        <section className="op-panel" role="alert">
          <p>{current.error}</p>
          <button
            className="button secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            다시 시도
          </button>
        </section>
      ) : (
        <section className="op-panel" role="status">
          지식 통계를 불러오는 중입니다…
        </section>
      )}
    </div>
  );
}
