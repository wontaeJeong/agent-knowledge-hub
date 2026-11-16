import { useState } from "react";
import type { OperationalApi } from "./api";
import { Button } from "../ui/primitives";
type Selection =
  | { kind: "attachment-version"; slotId: string; revision: number }
  | { kind: "runtime-answer" | "runtime-job"; id: string };
type RecordItem = {
  selection: Selection;
  ownerId: string;
  eligible: boolean;
  reasons: string[];
  retainedBy: { table: string; id: string }[];
};
type Plan = {
  id: string;
  requested_by: string;
  preview_hash: string;
  state: string;
  reviewed_by?: string;
  selection: Selection[];
  expires_at: string;
};
type Preview = {
  hash: string;
  policyRevision: number;
  total: number;
  eligible: number;
  records: RecordItem[];
};
const labels = {
  "attachment-version": "첨부 파일 버전",
  "runtime-answer": "저장된 답변",
  "runtime-job": "실행 이력",
};
const reasons: Record<string, string> = {
  MINIMUM_RETENTION_PERIOD: "설정된 최소 보존 기간 미경과",
  AGE_UNAVAILABLE: "보존 기간 계산에 필요한 시각 없음",
  CURRENT_VERSION: "현재 파일 버전 보존",
  FIXED_SHARED_ANCESTRY: "고정 공유의 근거 보존",
  SHARED_LIVE_BLOB: "동일 파일을 다른 자료가 사용 중",
  RETAINED_REFERENCE: "보존 중인 참조 있음",
  UNKNOWN_REFERENCE: "계보가 확인되지 않은 자료 있음",
  UNKNOWN_LINEAGE: "원본 계보 확인 불가",
  LEGAL_HOLD: "법적 보존",
  ACTIVE_DOWNLOAD_TICKET: "발급된 다운로드 권한 있음",
  RETAINED_SOURCE_EVIDENCE: "발행본의 원본 근거 보존",
  RUNNING_JOB: "실행 중",
  RETAINED_RESULT: "답변과 함께 선택 필요",
};
const key = (s: Selection) => JSON.stringify(s);
const title = (s: Selection) =>
  `${labels[s.kind]} · ${s.kind === "attachment-version" ? `${s.slotId} / ${s.revision}` : s.id}`;
export function GranularRetentionPanel({
  api,
  principalId,
  onExecuted,
}: {
  api: OperationalApi;
  principalId?: string;
  onExecuted?: () => Promise<void>;
}) {
  const [items, setItems] = useState<RecordItem[]>([]),
    [plans, setPlans] = useState<Plan[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [reviewPreviews, setReviewPreviews] = useState<Record<string, Preview>>(
    {},
  );
  const [preview, setPreview] = useState<Preview | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState(0),
    [truncated, setTruncated] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "개별 정리를 완료하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const d = await api.get<{
      items: RecordItem[];
      plans: Plan[];
      truncated: boolean;
    }>("/retention/pruning");
    setItems(d.items);
    setPlans(d.plans);
    setTruncated(d.truncated);
    setLoaded(true);
    setPage(0);
  };
  return (
    <section aria-label="개별 자료 삭제와 이력 정리">
      <h3>개별 자료 삭제와 이력 정리</h3>
      <p>
        이전 첨부 버전·저장된 답변·종료된 실행 이력을 직접 선택합니다. 공간
        소유자가 요청하고 자료 작성자와 다른 관리자가 검토합니다. 자동 삭제
        기간은 설정하지 않습니다.
      </p>
      <p>
        현재 파일·보존 중인 근거·공유·법적 보존과 충돌하면 정리를 차단합니다.
        파일의 물리 정리는 운영자의 승인된 저장소 정리 후 영수증에 반영됩니다.
      </p>
      <Button disabled={busy} onClick={() => void run(refresh)}>
        개별 대상·검토 목록 조회
      </Button>
      {message && <p role="status">{message}</p>}
      {loaded && (
        <>
          <p>
            개별 대상 {items.length}건{truncated ? " · 조회 한도 초과" : ""}.
            답변과 해당 실행 이력은 함께 선택할 수 있습니다.
          </p>
          {items.slice(page * 25, (page + 1) * 25).map((item) => (
            <article
              key={key(item.selection)}
              style={{ overflowWrap: "anywhere" }}
            >
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(key(item.selection))}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, key(item.selection)]
                        : selected.filter((s) => s !== key(item.selection)),
                    );
                    setPreview(null);
                  }}
                />{" "}
                {title(item.selection)}
              </label>
              <p>
                작성자 {item.ownerId || "미확인"} ·{" "}
                {item.eligible
                  ? "개별 정리 가능"
                  : item.reasons.map((r) => reasons[r] ?? r).join(" · ")}
              </p>
            </article>
          ))}
          {items.length > 25 && (
            <div>
              <Button
                disabled={busy || page === 0}
                onClick={() => setPage(page - 1)}
              >
                이전 대상
              </Button>
              <span>
                {page + 1} / {Math.ceil(items.length / 25)}
              </span>
              <Button
                disabled={busy || (page + 1) * 25 >= items.length}
                onClick={() => setPage(page + 1)}
              >
                다음 대상
              </Button>
            </div>
          )}
          <Button
            disabled={busy || !selected.length}
            onClick={() =>
              void run(async () =>
                setPreview(
                  await api.post("/retention/pruning/preview", {
                    selection: items
                      .filter((i) => selected.includes(key(i.selection)))
                      .map((i) => i.selection),
                  }),
                ),
              )
            }
          >
            선택 항목 미리보기
          </Button>
          {preview && (
            <section>
              <h4>
                선택 {preview.total}건 · 삭제 가능 {preview.eligible}건
              </h4>
              {preview.records.map((r) => (
                <p key={key(r.selection)}>
                  {title(r.selection)} ·{" "}
                  {r.eligible
                    ? "검토 요청 가능"
                    : r.reasons.map((v) => reasons[v] ?? v).join(" · ")}
                  {r.retainedBy.length
                    ? ` · 보존 참조 ${r.retainedBy.length}건`
                    : ""}
                </p>
              ))}
              <Button
                disabled={busy || preview.eligible !== preview.total}
                onClick={() =>
                  void run(async () => {
                    await api.post("/retention/pruning/plans", {
                      selection: preview.records.map((r) => r.selection),
                      previewHash: preview.hash,
                      policyRevision: preview.policyRevision,
                    });
                    setPreview(null);
                    setSelected([]);
                    await refresh();
                    setMessage(
                      "독립된 관리자의 검토를 요청했습니다. 검토 뒤 같은 소유자 계정에서 실행하세요.",
                    );
                  })
                }
              >
                별도 검토 요청
              </Button>
            </section>
          )}
          <h4>검토·실행 기록</h4>
          {!plans.length && <p>검토 요청이 없습니다.</p>}
          {plans.slice(0, 25).map((p) => (
            <article key={p.id} style={{ overflowWrap: "anywhere" }}>
              <strong>{p.id}</strong>
              <p>
                요청자 {p.requested_by} ·{" "}
                {p.state === "pending"
                  ? "검토 대기"
                  : p.state === "approved"
                    ? "승인됨"
                    : p.state === "rejected"
                      ? "반려됨"
                      : "실행됨"}
                {p.reviewed_by ? ` · 검토자 ${p.reviewed_by}` : ""}
              </p>
              <p>
                {p.selection.map(title).join(" · ")} · 승인 유효 기한{" "}
                {new Date(p.expires_at).toLocaleString("ko-KR")}
              </p>
              {p.state === "pending" && p.requested_by !== principalId && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const current = await api.post<Preview>(
                        "/retention/pruning/preview",
                        { selection: p.selection },
                      );
                      setReviewPreviews({ ...reviewPreviews, [p.id]: current });
                    })
                  }
                >
                  요청 내용·현재 참조 확인
                </Button>
              )}
              {reviewPreviews[p.id] && (
                <p>
                  현재 확인: 삭제 가능 {reviewPreviews[p.id].eligible} /{" "}
                  {reviewPreviews[p.id].total}건 ·{" "}
                  {reviewPreviews[p.id].hash === p.preview_hash
                    ? "요청 당시 내용과 일치"
                    : "대상·정책·참조가 변경됨. 새 요청 필요"}
                </p>
              )}
              {p.state === "pending" &&
                p.requested_by !== principalId &&
                (["approve", "reject"] as const).map((decision) => (
                  <Button
                    key={decision}
                    disabled={
                      busy ||
                      !reviewPreviews[p.id] ||
                      reviewPreviews[p.id].hash !== p.preview_hash ||
                      reviewPreviews[p.id].eligible !==
                        reviewPreviews[p.id].total
                    }
                    onClick={() =>
                      void run(async () => {
                        await api.post("/retention/pruning/review", {
                          planId: p.id,
                          previewHash: p.preview_hash,
                          decision,
                        });
                        await refresh();
                        setMessage(
                          decision === "approve"
                            ? "검토를 승인했습니다."
                            : "검토를 반려했습니다.",
                        );
                      })
                    }
                  >
                    {decision === "approve" ? "독립 검토 승인" : "반려"}
                  </Button>
                ))}
              {p.state === "approved" && p.requested_by === principalId && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "승인한 개별 자료를 삭제할까요? 현재 권한과 참조를 다시 검사합니다.",
                      )
                    )
                      return;
                    void run(async () => {
                      const result = await api.post<{
                        status: string;
                        deleted: number;
                        physicalPurgePending: number;
                      }>("/retention/pruning/execute", {
                        planId: p.id,
                        previewHash: p.preview_hash,
                      });
                      await refresh();
                      await onExecuted?.();
                      setMessage(
                        `제품 기록 정리 ${result.deleted}건 · 물리 정리 대기 ${result.physicalPurgePending}건 · ${result.status === "completed" ? "완료" : "보류"}`,
                      );
                    });
                  }}
                >
                  승인한 개별 자료 삭제
                </Button>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
