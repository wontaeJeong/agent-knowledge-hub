import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/primitives";
import { OperationalApi, ApiError } from "./api";

interface ExecutionIdentity {
  workspaceId: string;
  principalId: string;
  credentialId: string;
}
interface Job {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  checkpoint: unknown;
  result: unknown;
  heartbeatAt: string | null;
}
interface Usage {
  call_id: string;
  provider: string;
  model: string | null;
  requested_model?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  error_code: string | null;
}
interface Schedule {
  id: string;
  schedule_key: string;
  revision: number;
  enabled: boolean;
  next_at: string;
  last_error: string | null;
  config: {
    timezone: string;
    cadence: "daily" | "weekly";
    time: string;
    weekday?: number;
    holidays: string[];
    catchup: "skip" | "latest" | "bounded";
    catchupLimit?: number;
    job: {
      pageIds: string[];
      sourceIds: string[];
      reservation: { tokens: number; costMicros: number };
    };
  };
}
interface Budget {
  principal_id: string;
  tokens_reserved: number;
  tokens_charged: number;
  cost_reserved: number;
  cost_charged: number;
}
const statusLabels: Record<string, string> = {
  queued: "대기",
  running: "실행 중",
  cancel_requested: "취소 요청됨 · 중단 확인 전",
  cancelled: "중단 확인",
  succeeded: "작업 완료 · 발행과 별개",
  dead: "실패 · 재처리함",
  paused: "일시정지",
};
export const actualValue = (value: number | string | null, unit: string) =>
  value === null
    ? "미확인"
    : `${Number(value).toLocaleString("ko-KR")} ${unit}`;
export function JobUsage({ items }: { items: Usage[] }) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="실제 모델 호출 사용량 · 가로 스크롤"
      style={{ overflowX: "auto" }}
    >
      <table style={{ minWidth: 650 }}>
        <caption>실제 공급자·모델 호출 기록 (추정 아님)</caption>
        <thead>
          <tr>
            <th>호출</th>
            <th>실제 공급자 / 모델</th>
            <th>입력</th>
            <th>출력</th>
            <th>비용 (USD)</th>
            <th>오류</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.call_id}>
              <td>{u.call_id}</td>
              <td>
                {u.provider} / {u.model ?? "응답 모델 미확인"}
                {u.requested_model && (
                  <small> · 요청: {u.requested_model}</small>
                )}
              </td>
              <td>{actualValue(u.input_tokens, "토큰")}</td>
              <td>{actualValue(u.output_tokens, "토큰")}</td>
              <td>
                {u.cost_micros === null
                  ? "미확인"
                  : `$${(Number(u.cost_micros) / 1000000).toFixed(6)}`}
              </td>
              <td>{u.error_code ?? "없음"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <p>
          기록된 모델 호출이 없습니다. 미실행을 0 토큰 성공으로 표시하지
          않습니다.
        </p>
      )}
    </div>
  );
}
interface ScheduleForm {
  key: string;
  cadence: "daily" | "weekly";
  time: string;
  timezone: string;
  weekday: number;
  pageIds: string[];
  sourceIds: string[];
  tokens: number;
  costMicros: number;
  identity: ExecutionIdentity;
  holidays?: string[];
  catchup?: "skip" | "latest" | "bounded";
  catchupLimit?: number;
  expectedRevision?: number;
}
export function scheduleRequest(form: ScheduleForm) {
  return {
    key: form.key,
    cadence: form.cadence,
    time: form.time,
    timezone: form.timezone,
    ...(form.cadence === "weekly" ? { weekday: form.weekday } : {}),
    holidays: form.holidays ?? [],
    catchup: form.catchup ?? "latest",
    ...(form.catchup === "bounded"
      ? { catchupLimit: form.catchupLimit ?? 3 }
      : {}),
    ...(form.expectedRevision !== undefined
      ? { expectedRevision: form.expectedRevision }
      : {}),
    identity: {
      workspaceId: form.identity.workspaceId,
      principalId: form.identity.principalId,
      credentialId: form.identity.credentialId,
    },
    approvedPageIds: form.pageIds,
    approvedSourceIds: form.sourceIds,
    job: {
      kind: form.cadence,
      payload: { mode: "offline" },
      pageIds: form.pageIds,
      sourceIds: form.sourceIds,
      reservation: { tokens: form.tokens, costMicros: form.costMicros },
      timeoutMs: 60000,
      maxAttempts: 3,
      limits: { documents: 200, changes: 20 },
    },
  };
}
export function JobsPanel({
  api,
  capabilities,
  executionIdentities = [],
  onExpired,
}: {
  api: OperationalApi;
  capabilities: string[];
  executionIdentities?: ExecutionIdentity[];
  onExpired?: () => void;
}) {
  const manage = capabilities.includes("jobs.manage"),
    canRead = manage || capabilities.includes("jobs.read");
  const [jobs, setJobs] = useState<Job[]>([]),
    [schedules, setSchedules] = useState<Schedule[]>([]),
    [budgets, setBudgets] = useState<Budget[]>([]);
  const [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [usage, setUsage] = useState<Usage[]>([]),
    [preview, setPreview] = useState<unknown>(null),
    [stopped, setStopped] = useState(false);
  const [key, setKey] = useState("daily"),
    [cadence, setCadence] = useState<"daily" | "weekly">("daily"),
    [time, setTime] = useState("09:00"),
    [zone, setZone] = useState("Asia/Seoul"),
    [weekday, setWeekday] = useState(1),
    [credential, setCredential] = useState("");
  const [pages, setPages] = useState(""),
    [sources, setSources] = useState(""),
    [tokens, setTokens] = useState(0),
    [cost, setCost] = useState(0);
  const [budgetPrincipal, setBudgetPrincipal] = useState("*"),
    [budgetTokens, setBudgetTokens] = useState(100000),
    [budgetCost, setBudgetCost] = useState(1000000);
  const [holidays, setHolidays] = useState(""),
    [catchup, setCatchup] = useState<"skip" | "latest" | "bounded">("latest"),
    [catchupLimit, setCatchupLimit] = useState(3),
    [editing, setEditing] = useState<{ key: string; revision: number } | null>(
      null,
    );
  const failure = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onExpired?.();
      setError(e instanceof Error ? e.message : "작업 요청에 실패했습니다.");
    },
    [onExpired],
  );
  const refresh = useCallback(async () => {
    if (!canRead) return;
    const result = await api.get<{ items: Job[]; nextOffset: number | null }>(
      `/jobs-v2?offset=${offset}${manage ? "&scope=workspace" : ""}`,
    );
    setJobs(result.items);
    setNext(result.nextOffset);
    if (manage) {
      const [s, b, st] = await Promise.all([
        api.get<{ items: Schedule[] }>("/jobs-v2/schedules"),
        api.get<{ items: Budget[] }>("/jobs-v2/budgets"),
        api.get<{ items: { scope: string; stopped: boolean }[] }>(
          "/jobs-v2/stops",
        ),
      ]);
      setSchedules(s.items);
      setBudgets(b.items);
      setStopped(st.items.some((s) => s.scope === "workspace" && s.stopped));
    }
  }, [api, canRead, manage, offset]);
  useEffect(() => {
    void refresh().catch(failure);
  }, [refresh, failure]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      failure(e);
    } finally {
      setBusy(false);
    }
  };
  if (!canRead) return null;
  const split = (value: string) => [
    ...new Set(value.split(/[,\s]+/).filter(Boolean)),
  ];
  return (
    <section className="op-panel" aria-labelledby="durable-jobs-title">
      <h2 id="durable-jobs-title">지속 작업·위키 매니저</h2>
      <p>
        작업 수락은 실행·발행 완료가 아닙니다. 변경 제안은 사람의 검토·승인 후
        별도로 발행합니다. 원본·문서·권한·규칙이 바뀌면 오래된 결과를 반영하지
        않습니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <Button disabled={busy} onClick={() => perform(async () => {})}>
        현재 상태 새로고침
      </Button>
      <div
        role="region"
        aria-label="작업 목록 · 가로 스크롤"
        tabIndex={0}
        style={{ overflowX: "auto" }}
      >
        <table style={{ minWidth: 650 }}>
          <caption>
            {manage ? "공간의 제한된 실행 작업" : "내 작업"} · 25건씩
          </caption>
          <thead>
            <tr>
              <th>식별자 / 종류</th>
              <th>상태</th>
              <th>시도</th>
              <th>최근 심박</th>
              <th>조작</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.id}
                  <br />
                  {j.kind}
                </td>
                <td>
                  {statusLabels[j.status] ?? j.status}
                  {j.error && <p>{j.error}</p>}
                </td>
                <td>
                  {j.attempts} / {j.maxAttempts}
                </td>
                <td>{j.heartbeatAt ?? "아직 없음"}</td>
                <td>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        setSelected(j.id);
                        setUsage(
                          (
                            await api.get<{ items: Usage[] }>(
                              `/jobs-v2/${encodeURIComponent(j.id)}/telemetry`,
                            )
                          ).items,
                        );
                      })
                    }
                  >
                    실행 근거
                  </Button>
                  {!["succeeded", "dead", "cancelled"].includes(j.status) && (
                    <Button
                      disabled={busy || j.status === "cancel_requested"}
                      onClick={() =>
                        perform(async () => {
                          if (
                            !window.confirm(
                              "취소를 요청할까요? 이미 완료된 변경은 되돌리지 않습니다.",
                            )
                          )
                            return;
                          await api.post(
                            `/jobs-v2/${encodeURIComponent(j.id)}/cancel`,
                            {},
                          );
                          setNotice(
                            "취소를 요청했습니다. 실제 중단 상태를 확인하세요.",
                          );
                        })
                      }
                    >
                      취소 요청
                    </Button>
                  )}
                  {manage && ["queued", "paused"].includes(j.status) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await api.post(
                            `/jobs-v2/${encodeURIComponent(j.id)}/pause`,
                            { paused: j.status !== "paused" },
                          );
                        })
                      }
                    >
                      {j.status === "paused" ? "재개" : "일시정지"}
                    </Button>
                  )}
                  {manage && j.status === "dead" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          if (
                            !window.confirm(
                              "새 예산을 예약하여 실패 단계를 재처리할까요? 완료된 단계는 중복 적용하지 않으며, 미확인 모델 사용량이나 변경된 입력은 재처리를 차단합니다.",
                            )
                          )
                            return;
                          await api.post(
                            `/jobs-v2/${encodeURIComponent(j.id)}/retry`,
                            {},
                          );
                          setNotice("실패 단계 재처리를 수락했습니다.");
                        })
                      }
                    >
                      실패 단계 재처리
                    </Button>
                  )}
                  <details>
                    <summary>체크포인트·결과</summary>
                    <pre
                      style={{
                        maxWidth: "70ch",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {JSON.stringify(
                        { checkpoint: j.checkpoint, result: j.result },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!jobs.length && <p>표시할 작업이 없습니다.</p>}
      <div className="op-actions">
        <Button
          disabled={busy || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          이전 25건
        </Button>
        <Button
          disabled={busy || next === null}
          onClick={() => setOffset(next ?? offset)}
        >
          다음 25건
        </Button>
      </div>
      {selected && (
        <section aria-label="선택한 작업의 실제 사용량">
          <h3>실행 근거 · {selected}</h3>
          <JobUsage items={usage} />
        </section>
      )}
      {manage && (
        <>
          <h3>일정·긴급 중지</h3>
          <p>
            일정은 서버에서 실행합니다. 개인 커넥터를 상시 실행하지 않습니다.
            자격 증명은 제한된 서비스 실행 식별자만 사용하며 사람 세션을
            저장하지 않습니다. 누락 회차는 최근 1건만 실행하며 DST 공백은
            건너뛰고 반복 시각은 하루 1회입니다.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                if (
                  !window.confirm(
                    stopped
                      ? "최신 정책을 다시 검사하며 공간 매니저를 재개할까요?"
                      : "이 공간의 대기·실행 중 작업의 새 반영을 긴급 차단할까요?",
                  )
                )
                  return;
                const me = await api.me();
                await api.post("/jobs-v2/stops", {
                  scope: "workspace",
                  key: me.workspaceId,
                  stopped: !stopped,
                });
              })
            }
          >
            {stopped ? "공간 긴급 중지 해제" : "공간 긴급 중지"}
          </Button>
          {schedules.map((s) => (
            <article key={s.id}>
              <h4>
                {s.schedule_key} · 규칙 버전 {s.revision}
              </h4>
              <p>
                {s.config.cadence} · {s.config.timezone} · 다음 {s.next_at} ·{" "}
                {s.enabled ? "활성" : "일시정지"}
              </p>
              {s.last_error && <p role="status">최근 실패: {s.last_error}</p>}
              <div className="op-actions">
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing({ key: s.schedule_key, revision: s.revision });
                    setKey(s.schedule_key);
                    setCadence(s.config.cadence);
                    setTime(s.config.time);
                    setZone(s.config.timezone);
                    setWeekday(s.config.weekday ?? 1);
                    setHolidays(s.config.holidays.join(", "));
                    setCatchup(s.config.catchup);
                    setCatchupLimit(s.config.catchupLimit ?? 3);
                    setPages(s.config.job.pageIds.join(", "));
                    setSources(s.config.job.sourceIds.join(", "));
                    setTokens(s.config.job.reservation.tokens);
                    setCost(s.config.job.reservation.costMicros);
                    setCredential("");
                    setNotice(
                      "일정 수정 양식에서 서비스 자격 증명과 변경할 구조 점검 규칙을 다시 승인하세요.",
                    );
                  }}
                >
                  일정 수정
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      setPreview(
                        await api.get(`/jobs-v2/schedules/${s.id}/preview`),
                      );
                    })
                  }
                >
                  대상·한도·다음 실행 미리보기
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      if (
                        !window.confirm(
                          "검토용 작업을 지금 대기열에 넣을까요? 발행하지 않습니다.",
                        )
                      )
                        return;
                      await api.post(`/jobs-v2/schedules/${s.id}/run`, {
                        key: crypto.randomUUID(),
                      });
                      setNotice(
                        "수동 실행을 수락했습니다. 대기열에서 완료·실패를 확인하세요.",
                      );
                    })
                  }
                >
                  즉시 실행 요청
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api.post(`/jobs-v2/schedules/${s.id}/enabled`, {
                        enabled: !s.enabled,
                      });
                    })
                  }
                >
                  {s.enabled ? "일정 정지" : "일정 재개"}
                </Button>
              </div>
            </article>
          ))}
          {preview !== null && (
            <details open>
              <summary>
                본문을 변경하지 않는 미리보기 · 예약 한도는 실제 비용이 아닙니다
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {JSON.stringify(preview, null, 2)}
              </pre>
            </details>
          )}
          <details open={editing ? true : undefined}>
            <summary>Daily / Weekly 일정 만들기</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  const identity = executionIdentities.find(
                    (i) => i.credentialId === credential,
                  );
                  if (!identity)
                    throw Error("서버에서 허용한 실행 자격 증명을 선택하세요.");
                  if (
                    !window.confirm(
                      "선택한 대상과 한도를 승인하고 일정을 저장할까요? 변경안의 자동 승인·발행은 허용하지 않습니다.",
                    )
                  )
                    return;
                  await api.post(
                    "/jobs-v2/schedules",
                    scheduleRequest({
                      key,
                      cadence,
                      time,
                      timezone: zone,
                      weekday,
                      pageIds: split(pages),
                      sourceIds: split(sources),
                      tokens,
                      costMicros: cost,
                      identity,
                      holidays: split(holidays),
                      catchup,
                      catchupLimit,
                      ...(editing && editing.key === key
                        ? { expectedRevision: editing.revision }
                        : {}),
                    }),
                  );
                  setNotice(
                    "일정을 저장했습니다. 실행 전 미리보기로 대상과 다음 회차를 확인하세요.",
                  );
                  setEditing(null);
                });
              }}
            >
              <label>
                일정 이름
                <input
                  required
                  value={key}
                  maxLength={200}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              <label>
                주기
                <select
                  value={cadence}
                  onChange={(e) =>
                    setCadence(e.target.value as "daily" | "weekly")
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              <label>
                현지 시각
                <input
                  required
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <label>
                IANA 시간대
                <input
                  required
                  value={zone}
                  onChange={(e) => setZone(e.target.value)}
                />
              </label>
              {cadence === "weekly" && (
                <label>
                  요일
                  <select
                    value={weekday}
                    onChange={(e) => setWeekday(Number(e.target.value))}
                  >
                    {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
                      <option key={d} value={i}>
                        {d}요일
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                건너뛸 휴일 (YYYY-MM-DD, 쉼표 구분)
                <textarea
                  value={holidays}
                  onChange={(e) => setHolidays(e.target.value)}
                />
              </label>
              <label>
                누락 회차 처리
                <select
                  value={catchup}
                  onChange={(e) =>
                    setCatchup(e.target.value as "skip" | "latest" | "bounded")
                  }
                >
                  <option value="skip">건너뛰기</option>
                  <option value="latest">최근 1회만</option>
                  <option value="bounded">제한된 회차 보충</option>
                </select>
              </label>
              {catchup === "bounded" && (
                <label>
                  최대 보충 회차 (1~10)
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    value={catchupLimit}
                    onChange={(e) => setCatchupLimit(Number(e.target.value))}
                  />
                </label>
              )}
              {editing && (
                <p>
                  규칙 버전 {editing.revision} 기준으로 수정합니다. 최신 버전이
                  바뀌면 저장하지 않습니다. 이 양식은 구조 점검 규칙을 저장하며
                  모델 실행 규칙으로 간주하지 않습니다.
                </p>
              )}
              <label>
                승인할 문서 ID (쉼표 구분)
                <textarea
                  value={pages}
                  onChange={(e) => setPages(e.target.value)}
                />
              </label>
              <label>
                승인할 원본 ID (쉼표 구분)
                <textarea
                  value={sources}
                  onChange={(e) => setSources(e.target.value)}
                />
              </label>
              <label>
                실행 자격 증명
                <select
                  required
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                >
                  <option value="">제한된 서비스 자격 증명 선택</option>
                  {executionIdentities.map((i) => (
                    <option key={i.credentialId} value={i.credentialId}>
                      {i.principalId} · {i.credentialId}
                    </option>
                  ))}
                </select>
              </label>
              {!executionIdentities.length && (
                <p>
                  서버에서 승인한 서비스 실행 자격 증명이 없습니다. 사람
                  세션으로 대신 실행하지 않습니다.
                </p>
              )}
              <label>
                실행 전체 토큰 예약 상한
                <input
                  type="number"
                  min={0}
                  value={tokens}
                  onChange={(e) => setTokens(Number(e.target.value))}
                />
              </label>
              <label>
                비용 예약 상한 (micro-USD, 1 USD = 1,000,000)
                <input
                  type="number"
                  min={0}
                  value={cost}
                  onChange={(e) => setCost(Number(e.target.value))}
                />
              </label>
              <p>
                기본 일정은 구조 점검입니다. 실제 모델 의미 종합으로 표시하지
                않습니다. 모델 작업에는 별도 서버 설정과 전송 허용 정책이
                필요합니다.
              </p>
              <Button type="submit" disabled={busy || !credential}>
                일정 저장
              </Button>
            </form>
          </details>
          <h3>오늘의 예산 (UTC)</h3>
          <p>
            예약·보수적 청구는 실제 사용량과 다릅니다. 알 수 없는 사용량은
            예약을 보존하고 실제 호출 표에는 미확인으로 남깁니다.
          </p>
          <details>
            <summary>공간·사용자별 일일 예산 설정</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform(async () => {
                  if (
                    !window.confirm(
                      "일일 한도를 저장할까요? 이미 수락된 예약도 변경된 한도를 반영 직전에 다시 검사합니다.",
                    )
                  )
                    return;
                  await api.post("/jobs-v2/budgets", {
                    principalId: budgetPrincipal,
                    tokens: budgetTokens,
                    costMicros: budgetCost,
                  });
                  setNotice("UTC 일일 예산 한도를 저장했습니다.");
                });
              }}
            >
              <label>
                대상 주체 ID (* = 공간 전체)
                <input
                  required
                  maxLength={200}
                  value={budgetPrincipal}
                  onChange={(e) => setBudgetPrincipal(e.target.value)}
                />
              </label>
              <label>
                일일 토큰 상한
                <input
                  required
                  type="number"
                  min={0}
                  step={1}
                  value={budgetTokens}
                  onChange={(e) => setBudgetTokens(Number(e.target.value))}
                />
              </label>
              <label>
                일일 비용 상한 (micro-USD)
                <input
                  required
                  type="number"
                  min={0}
                  step={1}
                  value={budgetCost}
                  onChange={(e) => setBudgetCost(Number(e.target.value))}
                />
              </label>
              <Button type="submit" disabled={busy}>
                일일 예산 한도 저장
              </Button>
            </form>
          </details>
          <div
            role="region"
            aria-label="예산 표 · 가로 스크롤"
            tabIndex={0}
            style={{ overflowX: "auto" }}
          >
            <table style={{ minWidth: 550 }}>
              <thead>
                <tr>
                  <th>대상</th>
                  <th>예약 토큰</th>
                  <th>정산 토큰</th>
                  <th>예약 비용 (micro-USD)</th>
                  <th>정산 비용 (micro-USD)</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <tr key={b.principal_id}>
                    <td>
                      {b.principal_id === "*" ? "공간 전체" : b.principal_id}
                    </td>
                    <td>{b.tokens_reserved}</td>
                    <td>{b.tokens_charged}</td>
                    <td>{b.cost_reserved}</td>
                    <td>{b.cost_charged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
