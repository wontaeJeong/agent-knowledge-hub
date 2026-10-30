import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  GitPullRequest,
  Layers3,
  ShieldAlert,
} from "lucide-react";
import { Badge, Button } from "../ui/primitives";
import type { UsageSummary } from "../domain/usage";
import type { ConsoleTab, summarizeConsole } from "./console";

export function Overview({
  summary: s,
  usage,
  usageError,
  model,
  navigate,
  retry,
  preview,
}: {
  summary: ReturnType<typeof summarizeConsole>;
  usage: UsageSummary | null;
  usageError: string;
  model: { configured: boolean; model: string | null };
  navigate: (tab: ConsoleTab) => void;
  retry: () => void;
  preview: boolean;
}) {
  const failureRate =
    usage && usage.total > 0
      ? ((usage.failed / usage.total) * 100).toFixed(1)
      : null;
  const max = Math.max(
    1,
    ...(usage?.daily.map((d) => d.succeeded + d.failed) ?? []),
  );
  return (
    <div className="console-overview">
      <section className="console-verdict" aria-label="운영 판단">
        <div className="console-verdict-icon">
          <Layers3 size={24} />
        </div>
        <div>
          <Badge tone="plum">
            지식 순환 · 현재 접근 범위{preview ? " · 예시" : ""}
          </Badge>
          <h2>
            {s.pending || s.approved
              ? "다음 에이전트가 쓸 지식, 검토를 기다립니다."
              : "지식이 다음 업무로 이어질 준비를 확인하세요."}
          </h2>
          <p>
            검토 대기 {s.pending}건 · 승인 후 발행 대기 {s.approved}건 · 내 실패
            작업 {s.failedJobs}건. 승인과 호출 성공은 지식의 정확성이나 업무
            성공을 뜻하지 않습니다.
          </p>
        </div>
        <Button variant="primary" onClick={() => navigate("review")}>
          검토함 열기 <ArrowRight size={16} />
        </Button>
      </section>
      <div className="console-metrics">
        {[
          ["발행 지식", s.pages, "현재 접근 가능 · 페이지", "knowledge"],
          ["검토 대기", s.pending, "접근 가능한 변경 집합", "review"],
          ["내 실패 작업", s.failedJobs, "전체 이력 · 재시도와 구분", "jobs"],
          [
            "지식 점검",
            s.issues === null ? "미점검" : `${s.issues}건`,
            "이번 세션 수동 점검 결과",
            "lint",
          ],
        ].map(([label, value, caption, tab]) => (
          <button
            className="console-metric"
            key={String(label)}
            onClick={() => navigate(tab as ConsoleTab)}
          >
            <span>
              {label}
              <ArrowUpRight size={16} />
            </span>
            <strong>{value}</strong>
            <small>{caption}</small>
          </button>
        ))}
      </div>
      <div className="console-two-col">
        <section className="op-panel console-cycle">
          <div className="op-section-head">
            <h2>지식이 누적되는 순환</h2>
            <Badge>조회 시점 상태</Badge>
          </div>
          <p className="muted">
            원본 보존부터 질문 결과 재편입까지. 단계별 숫자는 전환율이 아닌 현재
            개체 수입니다.
          </p>
          <div className="console-cycle-steps">
            {[
              ["01", "Ingest", "원본 · 편입", `${s.sources}개 원본`, "sources"],
              [
                "02",
                "Review",
                "검토 · 발행",
                `${s.approved}건 발행 대기`,
                "review",
              ],
              ["03", "Query", "질문 · 재편입", "발행본과 고정 인용", "query"],
              [
                "04",
                "Lint",
                "점검 · 갱신",
                s.issues === null ? "미점검" : `${s.issues}건 점검 항목`,
                "lint",
              ],
            ].map(([n, title, label, detail, tab]) => (
              <button key={n} onClick={() => navigate(tab as ConsoleTab)}>
                <small>{n}</small>
                <strong>{title}</strong>
                <span>{label}</span>
                <small>{detail}</small>
              </button>
            ))}
          </div>
          <div className="console-loop-note">
            ↳ 새 근거와 업무 결과는 기존 결론·조건을 재검토하는 변경 제안으로
            돌아옵니다.
          </div>
        </section>
        <section className="op-panel">
          <h2>지금 확인할 항목</h2>
          <div className="console-action-list">
            <button onClick={() => navigate("review")}>
              <GitPullRequest size={20} />
              <span>
                <strong>미발행 변경 확인</strong>
                <small>
                  검토 {s.pending}건 · 승인 {s.approved}건
                </small>
              </span>
              <ArrowRight size={17} />
            </button>
            <button onClick={() => navigate("jobs")}>
              <ShieldAlert size={20} />
              <span>
                <strong>실패 원인과 실행 상태</strong>
                <small>
                  내 실패 {s.failedJobs}건 · 실행 중 {s.runningJobs}건
                </small>
              </span>
              <ArrowRight size={17} />
            </button>
            <button onClick={() => navigate("agents")}>
              <Bot size={20} />
              <span>
                <strong>에이전트 연결과 권한</strong>
                <small>서비스 주체 · 토큰 관리 목업</small>
              </span>
              <ArrowRight size={17} />
            </button>
          </div>
        </section>
      </div>
      <section className="op-panel">
        <div className="op-section-head">
          <div>
            <h2>기록된 서비스 호출</h2>
            <p className="muted">
              {preview ? "예시 데이터 · " : ""}
              {usage
                ? `${usage.scope === "workspace" ? "현재 공간 전체" : "본인"} · ${usage.from.slice(0, 10)} ~ ${usage.to.slice(0, 10)} · UTC`
                : "최근 7일 · 집계 범위는 서버 권한으로 결정"}
            </p>
          </div>
          <Button onClick={() => navigate("usage")}>
            상세 사용량 <ArrowUpRight size={16} />
          </Button>
        </div>
        {usage ? (
          <>
            <div className="console-usage-summary">
              <span>
                <strong>{usage.total.toLocaleString("ko-KR")}</strong>건 호출
              </span>
              <span>성공 {usage.succeeded}건</span>
              <span>
                실패 {usage.failed}건 ·{" "}
                {failureRate === null
                  ? "실패율 해당 없음"
                  : `${failureRate}% (${usage.failed}/${usage.total})`}
              </span>
              <span>실제 발행 {usage.publications}건</span>
            </div>
            <div
              className="console-chart"
              role="region"
              tabIndex={0}
              aria-label="UTC 일별 성공 실패 호출 그래프 · 가로 스크롤 가능"
            >
              <div className="console-chart-inner">
                {usage.daily.map((d) => (
                  <div className="console-chart-day" key={d.day}>
                    <span>{d.succeeded + d.failed}건</span>
                    <div
                      className="console-chart-bars"
                      role="img"
                      aria-label={`${d.day} 성공 ${d.succeeded}건, 실패 ${d.failed}건`}
                    >
                      <i style={{ height: `${(d.succeeded / max) * 96}px` }} />
                      <i style={{ height: `${(d.failed / max) * 96}px` }} />
                    </div>
                    <span>{d.day.slice(5)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="console-chart-legend">
              <span>● 성공</span>
              <span>● 실패</span> · 단위: 건 · 오늘은 집계 중 · 전체
              날짜/원시값은 상세 사용량에서 확인
            </p>
          </>
        ) : (
          <div
            className="console-usage-empty"
            role={usageError ? "alert" : "status"}
          >
            {usageError ? (
              <>
                <strong>사용량 집계를 불러오지 못했습니다.</strong>
                <p>{usageError}</p>
                <Button onClick={retry}>집계 다시 시도</Button>
              </>
            ) : (
              "서버 집계를 확인하고 있습니다…"
            )}
          </div>
        )}
        <p className="console-measurement-note">
          계측 대상: 페이지 단건·고정 버전 조회, 원본 등록, 변경 제안·승인·발행.
          질문·Lint·목록 조회 등 전체 API 호출을 포함하지 않습니다. 재시도는
          별도 호출이며 발행·재사용 성공과 다릅니다.
        </p>
      </section>
      <div className="console-two-col console-bottom">
        <section className="op-panel">
          <h2>연결과 측정의 경계</h2>
          <dl>
            <div>
              <dt>종합 모델</dt>
              <dd>{model.configured ? model.model : "미연결"}</dd>
            </div>
            <div>
              <dt>토큰 · 비용</dt>
              <dd>미수집</dd>
            </div>
            <div>
              <dt>실행 환경</dt>
              <dd>
                {preview
                  ? "독립 합성 목업 · 구조 검사만"
                  : "서버 정본 · 현재 권한 재검사"}
              </dd>
            </div>
          </dl>
        </section>
        <section className="op-panel">
          <h2>좋아진 지식인가요?</h2>
          <Badge tone="amber">미평가 · 운영 수용과 별개</Badge>
          <p>
            근거 정확성, 상충 해소, 적용 조건, 후속 에이전트의 과제 성공률은
            대조 평가 전입니다. 문서 수나 호출 수로 효과를 대신하지 않습니다.
          </p>
          <Button variant="ghost" onClick={() => navigate("evaluation")}>
            평가 · 성과 환류 목업 보기 <ArrowRight size={16} />
          </Button>
        </section>
      </div>
    </div>
  );
}
