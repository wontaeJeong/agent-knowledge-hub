import { useEffect, useState } from "react";
import type { OperationalApi } from "./api";
import { Button } from "../ui/primitives";
type Schedule = {
  id: string;
  status: string;
  dueAt: string;
  authorizationExpiresAt: string;
  errorCode: string | null;
};
type Preview = {
  previewHash: string;
  dueAt: string;
  authorizationExpiresAt: string;
  versions: Record<string, number>;
};
const labels: Record<string, string> = {
  scheduled: "예약됨",
  published: "발행됨",
  cancelled: "취소됨",
  failed: "실패",
};
export function PublicationSchedule({
  api,
  batchId,
  hash,
  canSchedule,
}: {
  api: OperationalApi;
  batchId: string;
  hash: string;
  canSchedule: boolean;
}) {
  const [open, setOpen] = useState(false),
    [local, setLocal] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [items, setItems] = useState<Schedule[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const path = `/changesets/${encodeURIComponent(batchId)}/publication-schedules`;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () =>
      api.get<{ items: Schedule[] }>(path).then(
        (r) => {
          if (active) {
            setItems(r.items);
            setError("");
          }
        },
        (e) => {
          if (active)
            setError(e instanceof Error ? e.message : "예약 상태 조회 실패");
        },
      );
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, path, open]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "예약 요청 실패");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="op-publication-schedule"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>발행 예약</summary>
      <p>
        승인된 변경 집합만 예약합니다. 현재 세션의 유효 기간 내에서 실행하며,
        로그아웃·권한·내용·기준 버전·정책 변경 시 발행하지 않고 실패를
        기록합니다.
      </p>
      {canSchedule && (
        <div>
          <label>
            예약 시각 (현재 기기의 시간대:{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone})
            <input
              type="datetime-local"
              value={local}
              disabled={busy}
              onChange={(e) => {
                setLocal(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <Button
            disabled={busy || !local}
            onClick={() =>
              void work(async () => {
                const dueAt = new Date(local).toISOString();
                setPreview(
                  await api.post<Preview>(path + "/preview", { hash, dueAt }),
                );
              })
            }
          >
            예약 미리보기
          </Button>
          {preview && (
            <div role="status">
              <p>
                예약: {new Date(preview.dueAt).toLocaleString("ko-KR")} · UTC{" "}
                {preview.dueAt}
              </p>
              <p>
                실행 권한 만료:{" "}
                {new Date(preview.authorizationExpiresAt).toLocaleString(
                  "ko-KR",
                )}{" "}
                · UTC {preview.authorizationExpiresAt}
              </p>
              <p>
                대상 버전:{" "}
                {Object.entries(preview.versions)
                  .map(([id, v]) => `${id} → v${v}`)
                  .join(", ")}
              </p>
              <p>
                이 미리보기는 현재 검사 결과이며 예약 시각의 성공을 보장하지
                않습니다.
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await api.post(path, {
                      hash,
                      dueAt: preview.dueAt,
                      previewHash: preview.previewHash,
                      confirm: "SCHEDULE_APPROVED_PUBLICATION",
                    });
                    setPreview(null);
                    setItems(
                      (await api.get<{ items: Schedule[] }>(path)).items,
                    );
                  })
                }
              >
                예약 확정
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {open && items.length === 0 && !error && <p>내 발행 예약이 없습니다.</p>}
      {items.map((s) => (
        <div key={s.id} className="op-schedule-row">
          <p>
            {labels[s.status] ?? s.status} ·{" "}
            {new Date(s.dueAt).toLocaleString("ko-KR")} · UTC {s.dueAt}
          </p>
          {s.errorCode && (
            <p role="status">
              실행 실패: {s.errorCode} · 현재 상태를 확인하고 다시 검토하세요.
            </p>
          )}
          {s.status === "scheduled" && (
            <Button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await api.post(
                    `/publication-schedules/${encodeURIComponent(s.id)}/cancel`,
                    {},
                  );
                  setItems((await api.get<{ items: Schedule[] }>(path)).items);
                })
              }
            >
              예약 취소
            </Button>
          )}
        </div>
      ))}
    </details>
  );
}
