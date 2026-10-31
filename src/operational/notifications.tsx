import { useCallback, useEffect, useState } from "react";
import { ApiError, OperationalApi } from "./api";
import { Button } from "../ui/primitives";
interface Preferences {
  revision: number;
  mentions: boolean;
  subscriptions: boolean;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  timezone: string;
  dailyAt: string;
  weeklyAt: string;
  weeklyDay: number;
  quietHours: { enabled: boolean; start: string; end: string };
}
interface Delivery {
  id: string;
  cadence: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  from: string;
  to: string;
  retryAt: string;
  error: string | null;
  receiptId: string | null;
}
interface Review {
  id: string;
  pageId: string;
  title: string;
  revision: number;
  status: string;
  dueAt: string | null;
  reason: string;
  assignedId: string | null;
}
const labels: Record<string, string> = {
  queued: "대기",
  running: "전달 처리 중",
  retry: "실패 · 재시도 대기",
  accepted: "게이트웨이 수락 · 전달 확인 전",
  delivered: "전달 확인",
  "no-delivery": "전달 안 함 · 허용된 새 알림 없음",
  failed: "실패 · 확인 필요",
  superseded: "설정 변경으로 대체",
  unconfigured: "전달 대상·게이트웨이 미설정",
  "needs-reconciliation": "수신 여부 미확인 · 중복 전송 방지 중",
};
export const deliveryStateLabel = (state: string) => labels[state] ?? state;
const initial: Preferences = {
  revision: 0,
  mentions: true,
  subscriptions: true,
  dailyDigest: false,
  weeklyDigest: false,
  timezone: "UTC",
  dailyAt: "09:00",
  weeklyAt: "09:00",
  weeklyDay: 1,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};
export function NotificationPanel({
  api,
  capabilities,
  onExpired,
}: {
  api: OperationalApi;
  capabilities: string[];
  onExpired?: () => void;
}) {
  const canRead = capabilities.includes("knowledge.read"),
    manage = capabilities.includes("knowledge.protect");
  const [prefs, setPrefs] = useState(initial),
    [deliveries, setDeliveries] = useState<Delivery[]>([]),
    [reviews, setReviews] = useState<Review[]>([]),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<unknown>(null),
    [all, setAll] = useState(false);
  const [documentType, setDocumentType] = useState("*"),
    [cadenceDays, setCadenceDays] = useState(90),
    [cadenceRevision, setCadenceRevision] = useState(0);
  const failure = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) onExpired?.();
      setError(
        e instanceof Error ? e.message : "알림 요청을 완료하지 못했습니다.",
      );
    },
    [onExpired],
  );
  const refresh = useCallback(async () => {
    if (!canRead) return;
    const [p, d, r] = await Promise.all([
      api.get<Preferences>("/collaboration/preferences"),
      api.get<{ items: Delivery[] }>(
        `/collaboration/deliveries?offset=${offset}`,
      ),
      api.get<{ items: Review[] }>(
        `/collaboration/review-due?offset=${offset}&all=${all && manage}`,
      ),
    ]);
    setPrefs(p);
    setDeliveries(d.items);
    setReviews(r.items);
  }, [api, canRead, offset, all, manage]);
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
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setPrefs((p) => ({ ...p, [key]: value }));
  return (
    <section className="op-panel" aria-labelledby="collaboration-title">
      <h2 id="collaboration-title">사용자 알림·요약</h2>
      <p>
        웹 알림의 읽음 표시와 이메일 요약 전달은 별개입니다. 작업
        수락·게이트웨이 수락은 수신 확인이 아닙니다. 요약에는 현재 열람 가능한
        제목과 이 앱의 링크만 포함하며 본문을 보내지 않습니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <details open>
        <summary>알림 설정 · 버전 {prefs.revision}</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const { revision, ...data } = prefs;
              await api.post("/collaboration/preferences", {
                expectedRevision: revision,
                ...data,
              });
              setNotice(
                "알림 설정을 저장했습니다. 이전 설정의 대기 요약은 재검사합니다.",
              );
            });
          }}
        >
          {(
            [
              ["mentions", "나를 언급한 댓글"],
              ["subscriptions", "구독한 문서 변경"],
              ["dailyDigest", "일일 요약 받기"],
              ["weeklyDigest", "주간 요약 받기"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={prefs[key]}
                onChange={(e) => update(key, e.target.checked)}
                disabled={busy}
              />
              {label}
            </label>
          ))}
          <label>
            IANA 시간대
            <input
              required
              value={prefs.timezone}
              onChange={(e) => update("timezone", e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            일일 요약 시각
            <input
              type="time"
              required
              value={prefs.dailyAt}
              onChange={(e) => update("dailyAt", e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            주간 요약 시각
            <input
              type="time"
              required
              value={prefs.weeklyAt}
              onChange={(e) => update("weeklyAt", e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            주간 요약 요일
            <select
              value={prefs.weeklyDay}
              onChange={(e) => update("weeklyDay", Number(e.target.value))}
              disabled={busy}
            >
              {["일", "월", "화", "수", "목", "금", "토"].map((d, i) => (
                <option key={d} value={i}>
                  {d}요일
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>조용한 시간</legend>
            <label>
              <input
                type="checkbox"
                checked={prefs.quietHours.enabled}
                onChange={(e) =>
                  update("quietHours", {
                    ...prefs.quietHours,
                    enabled: e.target.checked,
                  })
                }
                disabled={busy}
              />
              해당 시간에는 전달하지 않기
            </label>
            <label>
              시작
              <input
                type="time"
                value={prefs.quietHours.start}
                onChange={(e) =>
                  update("quietHours", {
                    ...prefs.quietHours,
                    start: e.target.value,
                  })
                }
              />
            </label>
            <label>
              종료
              <input
                type="time"
                value={prefs.quietHours.end}
                onChange={(e) =>
                  update("quietHours", {
                    ...prefs.quietHours,
                    end: e.target.value,
                  })
                }
              />
            </label>
          </fieldset>
          <p>
            일광 절약 시간의 존재하지 않는 예약 시각은 건너뛰며 반복 시각은 한
            회차로 처리합니다. 조용한 시간 종료가 사라지는 날은 최초 실제 허용
            시각까지 기다립니다.
          </p>
          <Button type="submit" disabled={busy}>
            알림 설정 저장
          </Button>
        </form>
      </details>
      <div className="op-actions">
        <Button
          disabled={busy}
          onClick={() =>
            perform(async () => {
              setPreview(
                await api.get("/collaboration/digest-preview?cadence=daily"),
              );
            })
          }
        >
          일일 요약 미리보기 · 전송 안 함
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            perform(async () => {
              setPreview(
                await api.get("/collaboration/digest-preview?cadence=weekly"),
              );
            })
          }
        >
          주간 요약 미리보기 · 전송 안 함
        </Button>
        <Button disabled={busy} onClick={() => perform(async () => {})}>
          현재 상태 새로고침
        </Button>
      </div>
      {preview !== null && (
        <details open>
          <summary>현재 권한 기준 미리보기</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {JSON.stringify(preview, null, 2)}
          </pre>
        </details>
      )}
      <h3>요약 전달 이력</h3>
      <p>
        미설정·실패·수신 미확인은 성공으로 표시하지 않습니다. 설정 변경 또는
        권한 철회 이후 이미 수신한 이메일은 회수할 수 없습니다. 재시도는 같은
        전달 ID로 게이트웨이 중복 방지를 사용합니다.
      </p>
      <div
        role="region"
        aria-label="요약 전달 이력 · 가로 스크롤"
        tabIndex={0}
        style={{ overflowX: "auto" }}
      >
        <table style={{ minWidth: 700 }}>
          <thead>
            <tr>
              <th>전달 ID / 주기</th>
              <th>상태</th>
              <th>대상 기간</th>
              <th>시도</th>
              <th>오류·영수증</th>
              <th>조작</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.id}
                  <br />
                  {d.cadence === "daily" ? "일일" : "주간"}
                </td>
                <td>{deliveryStateLabel(d.status)}</td>
                <td>
                  {d.from}
                  <br />
                  {d.to}
                </td>
                <td>
                  {d.attempts}/{d.maxAttempts}
                </td>
                <td>
                  {d.error ?? "오류 없음"}
                  <br />
                  {d.receiptId ?? "수신 영수증 없음"}
                </td>
                <td>
                  {[
                    "failed",
                    "retry",
                    "unconfigured",
                    "needs-reconciliation",
                  ].includes(d.status) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          if (
                            !window.confirm(
                              "현재 설정·권한을 재검사하고 같은 전달 ID로 재시도할까요? 수신 미확인 항목은 자동 중복 전송하지 않습니다.",
                            )
                          )
                            return;
                          await api.post(
                            `/collaboration/deliveries/${encodeURIComponent(d.id)}/retry`,
                            {},
                          );
                          setNotice(
                            "재시도를 요청했습니다. 실제 전달 상태를 확인하세요.",
                          );
                        })
                      }
                    >
                      재시도 요청
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!deliveries.length && (
        <p>요약 전달 기록이 없습니다. 연결·전송 성공을 의미하지 않습니다.</p>
      )}
      <h3>검토 기한 작업함</h3>
      <p>
        검토 기한 경과는 거짓 판정이 아닙니다. 업무 소유권은 열람 권한을
        부여하지 않습니다. 기준일·책임자·현재 디렉터리 상태가 미확인이면 배정
        필요로 남습니다. 수신 확인은 내용 검증 승인이 아닙니다.
      </p>
      {manage && (
        <label>
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked);
              setOffset(0);
            }}
          />
          현재 열람 가능한 미배정 작업도 보기
        </label>
      )}
      <div
        role="region"
        aria-label="검토 기한 작업 목록 · 가로 스크롤"
        tabIndex={0}
        style={{ overflowX: "auto" }}
      >
        <table style={{ minWidth: 600 }}>
          <thead>
            <tr>
              <th>문서</th>
              <th>상태·사유</th>
              <th>기한</th>
              <th>조작</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id}>
                <td>{r.title}</td>
                <td>
                  {r.status === "needs-review"
                    ? "검토 필요"
                    : r.status === "acknowledged"
                      ? "담당 수신 확인"
                      : "배정·기준일 설정 필요"}
                  <br />
                  {r.reason}
                </td>
                <td>{r.dueAt ?? "기준일 미확인 · 기한 추정 안 함"}</td>
                <td>
                  {r.status !== "acknowledged" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        perform(async () => {
                          await api.post(
                            `/collaboration/review-due/${encodeURIComponent(r.id)}/acknowledge`,
                            { expectedRevision: r.revision },
                          );
                          setNotice(
                            "수신을 확인했습니다. 지식 검증이나 검토 완료로 처리하지 않았습니다.",
                          );
                        })
                      }
                    >
                      담당 수신 확인
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="op-actions">
        <Button
          disabled={busy || !offset}
          onClick={() => setOffset(Math.max(0, offset - 25))}
        >
          이전 25건
        </Button>
        <span>
          {offset + 1}~{offset + 25}건 범위
        </span>
        <Button
          disabled={busy || (deliveries.length < 25 && reviews.length < 25)}
          onClick={() => setOffset(offset + 25)}
        >
          다음 25건
        </Button>
      </div>
      {manage && (
        <details>
          <summary>문서 유형별 검토 주기 설정</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                if (
                  !window.confirm(
                    "업무 소유자에게 기한 작업을 배정할 주기를 저장할까요? 문서의 참·거짓이나 승인 상태를 자동 변경하지 않습니다.",
                  )
                )
                  return;
                const saved = await api.post<{ revision: number }>(
                  "/collaboration/review-cadence",
                  {
                    documentType,
                    expectedRevision: cadenceRevision,
                    days: cadenceDays,
                  },
                );
                setCadenceRevision(saved.revision);
              });
            }}
          >
            <label>
              문서 유형 (* = 기본)
              <input
                required
                value={documentType}
                onChange={(e) => {
                  setDocumentType(e.target.value);
                  setCadenceRevision(0);
                }}
              />
            </label>
            <label>
              주기 (일)
              <input
                type="number"
                required
                min={1}
                max={3650}
                value={cadenceDays}
                onChange={(e) => setCadenceDays(Number(e.target.value))}
              />
            </label>
            <label>
              확인한 기준 버전
              <input
                type="number"
                min={0}
                value={cadenceRevision}
                onChange={(e) => setCadenceRevision(Number(e.target.value))}
              />
            </label>
            <Button type="submit" disabled={busy}>
              검토 주기 저장
            </Button>
          </form>
        </details>
      )}
    </section>
  );
}
