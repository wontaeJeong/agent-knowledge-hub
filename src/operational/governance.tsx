import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../ui/primitives";

type Api = <T>(
  path: string,
  options?: { method: string; body: unknown },
) => Promise<T>;
export interface GovernanceProps {
  api: Api;
  capabilities: readonly string[];
  onChanged: () => void;
  onExpired: () => void;
}
type Owner = {
  page_id: string;
  revision: number;
  owner_id: string;
  backup_id: string;
};
type Assignment = {
  id: string;
  revision: number | null;
  assignee_ids: string[] | null;
  backup_id: string | null;
  deadline: string | null;
  absent_ids: string[] | null;
  propertyWarnings?: { pageId: string; key: string; mode: "warn" | "block" }[];
};
type Policy = {
  document_type: string;
  revision: number;
  required_keys: string[];
  mode: "warn" | "block";
  cadence_days: number | null;
};
type Workbench = {
  pages: { id: string; title: string; category: string; version: number }[];
  owners: Owner[];
  proposals: Assignment[];
  policies: Policy[];
  canManage: boolean;
};
type AccessRequest = {
  id: string;
  principal_id: string;
  resource_id: string;
  reason: string;
  revision: number;
  version: number;
  status: string;
};
type Review = Assignment & {
  assigned: boolean;
  late: boolean;
  absent: boolean;
  stale: boolean;
};
type Handoff = {
  page_id: string;
  owner_id: string;
  backup_id: string;
  work: {
    proposalIds: string[];
    reviewBatchIds: string[];
    reviewDue: string | null;
  };
};
type Event = {
  kind: string;
  revision: number;
  actor_id: string;
  reason: string;
  at: string;
};
export const governancePage = <T,>(items: readonly T[], page: number): T[] =>
  items.slice(Math.max(0, page) * 25, (Math.max(0, page) + 1) * 25);
export function governanceFailure(error: unknown) {
  const e = error instanceof Error ? error.message : String(error);
  if (/UNAUTHENTICATED|401/.test(e))
    return "인증이 만료되었습니다. 다시 로그인하세요.";
  if (/STALE_VERSION|APPROVAL_STALE|409/.test(e))
    return "기준 버전이 변경되었습니다. 다시 불러온 뒤 검토하세요.";
  if (/PROPERTY_REQUIRED/.test(e))
    return "필수 속성이 누락되어 발행할 수 없습니다.";
  if (/SOURCE_SCOPE_CONFLICT/.test(e))
    return "원본·상위 문서의 현재 접근 범위를 넘습니다. 원본 권한은 자동 부여하지 않습니다.";
  return "요청에 실패했습니다. 변경은 확인되지 않았습니다.";
}
function Paged<T>({
  items,
  label,
  render,
}: {
  items: readonly T[];
  label: string;
  render: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(0),
    current = Math.min(page, Math.max(0, Math.ceil(items.length / 25) - 1));
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      {!items.length ? (
        <p>표시할 작업이 없습니다.</p>
      ) : (
        <ul>
          {governancePage(items, current).map((i, index) => (
            <li key={index}>{render(i)}</li>
          ))}
        </ul>
      )}
      {items.length > 25 && (
        <nav aria-label={`${label} 페이지`}>
          <Button disabled={current === 0} onClick={() => setPage(current - 1)}>
            이전 25건
          </Button>{" "}
          <span>
            {current + 1} / {Math.ceil(items.length / 25)}
          </span>{" "}
          <Button
            disabled={(current + 1) * 25 >= items.length}
            onClick={() => setPage(current + 1)}
          >
            다음 25건
          </Button>
        </nav>
      )}
    </section>
  );
}
/** The host's authenticated, selected-space/CSRF adapter is mandatory. No identity inputs. */
export function GovernanceWorkbench({
  api,
  capabilities,
  onChanged,
  onExpired,
}: GovernanceProps) {
  const [data, setData] = useState<Workbench>(),
    [requests, setRequests] = useState<AccessRequest[]>([]),
    [reviews, setReviews] = useState<Review[]>([]),
    [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [status, setStatus] = useState("작업함을 불러오는 중입니다."),
    [busy, setBusy] = useState(false),
    [generation, setGeneration] = useState(0);
  const [pageId, setPageId] = useState(""),
    [eligible, setEligible] = useState<{ id: string }[]>([]),
    [ownerId, setOwnerId] = useState(""),
    [backupId, setBackupId] = useState(""),
    [events, setEvents] = useState<Event[]>([]);
  const [batchId, setBatchId] = useState(""),
    [reviewers, setReviewers] = useState<{ id: string }[]>([]),
    [assigneeIds, setAssigneeIds] = useState<string[]>([]),
    [reviewBackup, setReviewBackup] = useState(""),
    [deadline, setDeadline] = useState(""),
    [reviewEvents, setReviewEvents] = useState<Event[]>([]),
    [absentIds, setAbsentIds] = useState<string[]>([]);
  const [documentType, setDocumentType] = useState("연결된 지식"),
    [required, setRequired] = useState(""),
    [mode, setMode] = useState<"warn" | "block">("warn"),
    [cadence, setCadence] = useState("");
  const [why, setWhy] = useState(""),
    [requestId, setRequestId] = useState(""),
    [requestReason, setRequestReason] = useState("");
  const allowed = capabilities.includes("space.admin");
  const fail = (e: unknown) => {
    setStatus(governanceFailure(e));
    if (/UNAUTHENTICATED|401/.test(e instanceof Error ? e.message : String(e)))
      onExpired();
  };
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setRequests([]);
    setReviews([]);
    setHandoffs([]);
    Promise.all([
      api<Workbench>("/api/v1/governance/workbench"),
      api<{ items: Review[] }>("/api/v1/governance/review-inbox"),
      ...(allowed
        ? [
            api<{ items: AccessRequest[] }>("/api/v1/governance/access-inbox"),
            api<{ items: Handoff[] }>("/api/v1/governance/handoffs"),
          ]
        : []),
    ])
      .then((result) => {
        if (!alive) return;
        setData(result[0] as Workbench);
        setReviews((result[1] as { items: Review[] }).items);
        if (allowed) {
          setRequests((result[2] as { items: AccessRequest[] }).items);
          setHandoffs((result[3] as { items: Handoff[] }).items);
        }
        setStatus(
          "현재 권한으로 확인한 작업입니다. 지연과 부재는 별도로 표시합니다.",
        );
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [api, allowed, generation]);
  useEffect(() => {
    let alive = true;
    setEligible([]);
    setEvents([]);
    setOwnerId("");
    setBackupId("");
    if (!pageId || !allowed || !data) return;
    const owner = data.owners.find((o) => o.page_id === pageId);
    setOwnerId(owner?.owner_id ?? "");
    setBackupId(owner?.backup_id ?? "");
    Promise.all([
      api<{ items: { id: string }[] }>(
        `/api/v1/governance/pages/${encodeURIComponent(pageId)}/eligible-owners`,
      ),
      api<{ items: Event[] }>(
        `/api/v1/governance/pages/${encodeURIComponent(pageId)}/history`,
      ),
    ])
      .then(([e, h]) => {
        if (alive) {
          setEligible(e.items);
          setEvents(h.items);
        }
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [api, pageId, allowed, data]);
  useEffect(() => {
    let alive = true;
    setReviewers([]);
    setReviewEvents([]);
    setAssigneeIds([]);
    setReviewBackup("");
    setDeadline("");
    setAbsentIds([]);
    if (!batchId || !allowed || !data) return;
    const assigned = data.proposals.find((b) => b.id === batchId);
    setAssigneeIds(assigned?.assignee_ids ?? []);
    setReviewBackup(assigned?.backup_id ?? "");
    setAbsentIds(assigned?.absent_ids ?? []);
    setDeadline(
      assigned?.deadline
        ? new Date(assigned.deadline).toISOString().slice(0, 16)
        : "",
    );
    Promise.all([
      api<{ items: { id: string }[] }>(
        `/api/v1/governance/changesets/${encodeURIComponent(batchId)}/eligible-reviewers`,
      ),
      api<{ items: Event[] }>(
        `/api/v1/governance/changesets/${encodeURIComponent(batchId)}/history`,
      ),
    ])
      .then(([e, h]) => {
        if (alive) {
          setReviewers(e.items);
          setReviewEvents(h.items);
        }
      })
      .catch((e) => {
        if (alive) fail(e);
      });
    return () => {
      alive = false;
    };
  }, [api, batchId, allowed, data]);
  useEffect(() => {
    const p = data?.policies.find((p) => p.document_type === documentType);
    setRequired(p?.required_keys.join(", ") ?? "");
    setMode(p?.mode ?? "warn");
    setCadence(p?.cadence_days?.toString() ?? "");
  }, [documentType, data]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    try {
      await api(path, { method: "POST", body });
      setStatus("변경을 저장했습니다. 현재 작업을 다시 확인합니다.");
      setWhy("");
      setGeneration((g) => g + 1);
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const submit = (fn: () => void) => (e: FormEvent) => {
    e.preventDefault();
    fn();
  };
  const pageLabel = (id: string) =>
    data?.pages.find((p) => p.id === id)?.title ?? id;
  const options = (items: { id: string }[]) =>
    items.map((p) => (
      <option key={p.id} value={p.id}>
        {p.id}
      </option>
    ));
  return (
    <section aria-label="문서 운영 작업함">
      <h2>문서 운영 작업함</h2>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <p>
        업무 담당자 지정은 접근 권한을 부여하지 않습니다. 검토 배정은 승인
        자격을 대신하지 않습니다.
      </p>
      <Button disabled={busy} onClick={() => setGeneration((g) => g + 1)}>
        현재 상태 다시 불러오기
      </Button>
      {data && (
        <Paged
          items={reviews}
          label="내 검토 작업"
          render={(r) => (
            <>
              <code>{r.id}</code> · {r.assigned ? "담당 검토" : "검토 가능"} ·{" "}
              {r.late ? "검토 지연" : "기한 내 또는 기한 미지정"} ·{" "}
              {r.absent ? "담당자 부재" : "부재 아님"}
              {r.stale && " · 기준 변경 — 재배정 필요"}
              {r.deadline && <time dateTime={r.deadline}> · {r.deadline}</time>}
              {r.propertyWarnings?.map((w) => (
                <p key={`${w.pageId}:${w.key}`}>
                  {w.mode === "block" ? "발행 차단" : "발행 경고"}: {w.pageId} ·
                  필수 속성 {w.key} 누락
                </p>
              ))}
            </>
          )}
        />
      )}
      {allowed && data && (
        <fieldset disabled={busy || !data}>
          <legend>담당자·정책·배정 관리</legend>
          <label>
            변경·결정 이유{" "}
            <textarea
              required
              maxLength={2000}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
          <form
            onSubmit={submit(
              () =>
                void mutate(
                  `/api/v1/governance/pages/${encodeURIComponent(pageId)}/owner`,
                  {
                    expectedRevision:
                      data?.owners.find((o) => o.page_id === pageId)
                        ?.revision ?? 0,
                    ownerId,
                    backupId,
                    reason: why,
                  },
                ),
            )}
          >
            <h3>업무 담당자와 대체 담당자</h3>
            <label>
              현재 문서{" "}
              <select
                required
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
              >
                <option value="">문서를 선택하세요</option>
                {data?.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              업무 담당자{" "}
              <select
                required
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                <option value="">현재 열람 가능한 인간 구성원</option>
                {options(eligible)}
              </select>
            </label>
            <label>
              대체 담당자{" "}
              <select
                required
                value={backupId}
                onChange={(e) => setBackupId(e.target.value)}
              >
                <option value="">대체 담당자를 선택하세요</option>
                {options(eligible.filter((p) => p.id !== ownerId))}
              </select>
            </label>
            <Button
              type="submit"
              disabled={!pageId || !ownerId || !backupId || !why.trim()}
            >
              업무 담당자 저장
            </Button>
          </form>
          <details>
            <summary>선택 문서 결정 이력</summary>
            <Paged
              items={events}
              label="결정 이력"
              render={(e) => (
                <>
                  <time dateTime={e.at}>{e.at}</time> · {e.kind} · 버전{" "}
                  {e.revision} · {e.actor_id} · {e.reason}
                </>
              )}
            />
          </details>
          <form
            onSubmit={submit(
              () =>
                void mutate("/api/v1/governance/type-policy", {
                  documentType,
                  expectedRevision:
                    data?.policies.find((p) => p.document_type === documentType)
                      ?.revision ?? 0,
                  requiredKeys: required
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean),
                  mode,
                  cadenceDays: cadence ? Number(cadence) : null,
                  reason: why,
                }),
            )}
          >
            <h3>유형별 발행 필수 속성</h3>
            <p>
              기존 문서는 현재 유형, 새 문서는 연결된 지식 유형을 검사합니다.
              누락 차단은 승인·발행 모두에 적용됩니다. 정책 변경 시 기존 승인은
              재검토합니다.
            </p>
            <label>
              문서 유형{" "}
              <select
                value={documentType}
                onChange={(e) => setDocumentType(e.target.value)}
              >
                {[
                  ...new Set([
                    "연결된 지식",
                    ...(data?.pages.map((p) => p.category) ?? []),
                    ...(data?.policies.map((p) => p.document_type) ?? []),
                  ]),
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              필수 속성 키 (쉼표 구분){" "}
              <input
                value={required}
                onChange={(e) => setRequired(e.target.value)}
                placeholder="environment, businessOwner, reviewDue"
              />
            </label>
            <label>
              누락 시{" "}
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "warn" | "block")}
              >
                <option value="warn">경고</option>
                <option value="block">승인·발행 차단</option>
              </select>
            </label>
            <label>
              유형 검토 주기 (일, 선택){" "}
              <input
                type="number"
                min={1}
                max={3650}
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={!why.trim()}>
              발행 속성 정책 저장
            </Button>
          </form>
          <form
            onSubmit={submit(
              () =>
                void mutate(
                  `/api/v1/governance/changesets/${encodeURIComponent(batchId)}/assignment`,
                  {
                    expectedRevision:
                      data?.proposals.find((b) => b.id === batchId)?.revision ??
                      0,
                    assigneeIds,
                    backupId: reviewBackup,
                    deadline: new Date(`${deadline}:00Z`).toISOString(),
                    absentIds,
                    reason: why,
                  },
                ),
            )}
          >
            <h3>개별 변경 집합 검토 배정</h3>
            {data.proposals
              .find((b) => b.id === batchId)
              ?.propertyWarnings?.map((w) => (
                <p key={`${w.pageId}:${w.key}`} role="note">
                  {w.mode === "block" ? "발행 차단" : "발행 경고"}: {w.pageId} ·
                  필수 속성 {w.key} 누락
                </p>
              ))}
            <label>
              현재 검토 대상{" "}
              <select
                required
                value={batchId}
                onChange={(e) => setBatchId(e.target.value)}
              >
                <option value="">변경 집합 선택</option>
                {data?.proposals.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              검토자 (복수 선택){" "}
              <select
                multiple
                required
                value={assigneeIds}
                onChange={(e) => {
                  const ids = Array.from(
                    e.target.selectedOptions,
                    (o) => o.value,
                  );
                  setAssigneeIds(ids);
                  setAbsentIds((a) =>
                    a.filter((id) => ids.includes(id) || id === reviewBackup),
                  );
                }}
              >
                {options(reviewers.filter((p) => p.id !== reviewBackup))}
              </select>
            </label>
            <label>
              대체 검토자{" "}
              <select
                required
                value={reviewBackup}
                onChange={(e) => {
                  setReviewBackup(e.target.value);
                  setAbsentIds([]);
                }}
              >
                <option value="">독립 승인 자격을 가진 구성원</option>
                {options(reviewers.filter((p) => !assigneeIds.includes(p.id)))}
              </select>
            </label>
            <label>
              검토 마감 (UTC){" "}
              <input
                type="datetime-local"
                required
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </label>
            <label>
              부재 표시 (지연과 별개){" "}
              <select
                multiple
                value={absentIds}
                onChange={(e) =>
                  setAbsentIds(
                    Array.from(e.target.selectedOptions, (o) => o.value),
                  )
                }
              >
                {options(
                  reviewers.filter(
                    (p) => assigneeIds.includes(p.id) || p.id === reviewBackup,
                  ),
                )}
              </select>
            </label>
            <p>재배정 사유는 결정 이력에 남으며 기존 승인을 무효화합니다.</p>
            <Button
              type="submit"
              disabled={
                !batchId ||
                !assigneeIds.length ||
                !reviewBackup ||
                !deadline ||
                !why.trim()
              }
            >
              검토 배정 저장
            </Button>
          </form>
          <details>
            <summary>선택 검토 배정 이력</summary>
            <Paged
              items={reviewEvents}
              label="검토 배정 이력"
              render={(e) => (
                <>
                  {e.at} · {e.actor_id} · 버전 {e.revision} · {e.reason}
                </>
              )}
            />
          </details>
          <Paged
            items={requests}
            label="접근 요청 결정함"
            render={(r) => (
              <>
                <span>
                  {r.principal_id} · {pageLabel(r.resource_id)} · {r.reason} ·{" "}
                  {r.status === "pending"
                    ? "결정 대기"
                    : r.status === "approved"
                      ? "승인"
                      : "반려"}
                </span>
                {r.status === "pending" && (
                  <>
                    <Button
                      disabled={!why.trim()}
                      onClick={() =>
                        void mutate(
                          `/api/v1/governance/access-requests/${r.id}/decision`,
                          {
                            expectedRevision: r.revision,
                            expectedVersion: r.version,
                            decision: "approve",
                            reason: why,
                          },
                        )
                      }
                    >
                      접근 승인
                    </Button>
                    <Button
                      disabled={!why.trim()}
                      onClick={() =>
                        void mutate(
                          `/api/v1/governance/access-requests/${r.id}/decision`,
                          {
                            expectedRevision: r.revision,
                            expectedVersion: r.version,
                            decision: "reject",
                            reason: why,
                          },
                        )
                      }
                    >
                      접근 반려
                    </Button>
                  </>
                )}
              </>
            )}
          />
          <Paged
            items={handoffs}
            label="업무 인계 대상"
            render={(h) => (
              <>
                {pageLabel(h.page_id)} · 기존 {h.owner_id} → 대체 {h.backup_id}{" "}
                · 미처리 제안 {h.work.proposalIds.length}건 · 검토{" "}
                {h.work.reviewBatchIds.length}건 · 검토일{" "}
                {h.work.reviewDue ?? "미지정"}
                <Button onClick={() => setPageId(h.page_id)}>
                  인계 담당자 지정
                </Button>
              </>
            )}
          />
        </fieldset>
      )}
      <form
        onSubmit={submit(
          () =>
            void mutate("/api/v1/governance/access-requests", {
              resourceId: requestId,
              reason: requestReason,
            }),
        )}
      >
        <h3>내용 노출 없는 접근 요청</h3>
        <p>요청 수락은 접근 승인이나 문서 존재 확인이 아닙니다.</p>
        <label>
          문서 식별자{" "}
          <input
            required
            pattern="[a-zA-Z0-9_-]{1,100}"
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
          />
        </label>
        <label>
          요청 이유{" "}
          <textarea
            required
            maxLength={2000}
            value={requestReason}
            onChange={(e) => setRequestReason(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy}>
          접근 요청 보내기
        </Button>
      </form>
    </section>
  );
}
