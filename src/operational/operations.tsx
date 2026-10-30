import { useEffect, useState } from "react";
import type { OperationalApi } from "./api";
export function erasureRequest(
  scope: "resource" | "workspace",
  kind: "source" | "page",
  id: string,
  wholeWorkspace = false,
) {
  if (scope === "workspace") {
    if (!wholeWorkspace) throw Error("WORKSPACE_SCOPE_CONFIRMATION_REQUIRED");
    return { scope };
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error("INVALID_RESOURCE_ID");
  return { scope, resource: { kind, id } };
}
export function retentionBody(
  expectedRevision: number,
  auditDays: number,
  telemetryDays: number,
  backupDays: number,
) {
  for (const n of [auditDays, telemetryDays, backupDays])
    if (!Number.isInteger(n) || n < 1) throw Error("INVALID_RETENTION");
  return { expectedRevision, auditDays, telemetryDays, backupDays };
}
type Policy = {
  revision: number;
  audit_days: number;
  telemetry_days: number;
  backup_days: number;
};
type Preview = {
  previewHash: string;
  scope: "resource" | "workspace";
  resource?: { kind: "source" | "page"; id: string };
  counts: Record<string, number>;
  total: number;
  legalHold: boolean;
  unresolvedUnlineagedRows: number;
};
type Receipt = {
  id: string;
  status: string;
  scope?: string;
  counts?: Record<string, number>;
  error_code?: string;
  created_at?: string;
};
/** Host supplies the authenticated selected-space API. Secrets, SQL, storage paths and policy authority files are never browser inputs. */
export function OperationsPanel({
  api,
  canAdmin = false,
  canOwner = false,
}: {
  api: Pick<OperationalApi, "request">;
  canAdmin?: boolean;
  canOwner?: boolean;
}) {
  const [policy, setPolicy] = useState<Policy>({
      revision: 0,
      audit_days: 365,
      telemetry_days: 30,
      backup_days: 30,
    }),
    [status, setStatus] = useState<Record<string, unknown>>({}),
    [message, setMessage] = useState(
      "미확인: 아직 운영 상태를 조회하지 않았습니다.",
    ),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState<"resource" | "workspace">("resource"),
    [kind, setKind] = useState<"source" | "page">("source"),
    [resourceId, setResourceId] = useState(""),
    [whole, setWhole] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirm, setConfirm] = useState(""),
    [receipts, setReceipts] = useState<Receipt[]>([]),
    [offset, setOffset] = useState(0),
    [tab, setTab] = useState<"receipts" | "tombstones" | "archives">(
      "receipts",
    );
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "작업에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [p, s] = await Promise.all([
      api.request<Policy>("/operations/policy"),
      api.request<Record<string, unknown>>("/operations/status"),
    ]);
    setPolicy(p);
    setStatus(s);
    setMessage(
      "현재 운영 상태를 조회했습니다. 미확인은 0 또는 성공이 아닙니다.",
    );
  }
  useEffect(() => {
    if (canAdmin) void work(refresh);
  }, [api, canAdmin]);
  async function page(next: number, view = tab) {
    const path =
      view === "receipts"
        ? "erasure/receipts"
        : view === "tombstones"
          ? "tombstones/list"
          : "audit/archives";
    const d = await api.request<{ items: Receipt[] }>(
      `/operations/${path}`,
      "POST",
      { offset: next },
    );
    setReceipts(d.items);
    setOffset(next);
    setTab(view);
  }
  if (!canAdmin)
    return (
      <section>
        <h2>운영 및 복구</h2>
        <p>
          현재 공간의 관리자 권한이 필요합니다. Owner나 검토자로 자동 승격하지
          않습니다.
        </p>
      </section>
    );
  return (
    <section aria-labelledby="operations-title">
      <h2 id="operations-title">운영 및 복구</h2>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <p>
        삭제는 되돌릴 수 없습니다. 미확인 값은 성공이나 0이 아닙니다. 과거
        백업·사용자 반출·제3자 사본까지 모두 지웠다고 표시하지 않습니다.
      </p>
      <button disabled={busy} onClick={() => void work(refresh)}>
        상태 새로 고침
      </button>
      <dl>
        <dt>마지막 검증 백업</dt>
        <dd>
          {typeof status.lastBackup === "string" ? status.lastBackup : "미확인"}
        </dd>
        <dt>현재 공간 대기 작업</dt>
        <dd>
          {typeof status.queueDepth === "number" ? status.queueDepth : "미확인"}
        </dd>
        <dt>현재 공간 파일 용량</dt>
        <dd>
          {typeof status.blobBytes === "number"
            ? `${status.blobBytes.toLocaleString()} bytes`
            : "미확인"}
        </dd>
      </dl>
      <details open>
        <summary>개인정보·운영 보관 정책</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              await api.request(
                "/operations/policy",
                "PUT",
                retentionBody(
                  policy.revision,
                  policy.audit_days,
                  policy.telemetry_days,
                  policy.backup_days,
                ),
              );
              await refresh();
            });
          }}
        >
          {(
            [
              ["audit_days", "감사 온라인 보관 일수", 3650],
              ["telemetry_days", "사용량 보관 일수", 365],
              ["backup_days", "백업 보관 일수", 3650],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min="1"
                max={max}
                required
                value={policy[key]}
                onChange={(e) =>
                  setPolicy({ ...policy, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
          <button disabled={busy}>정책 저장</button>
        </form>
        <button
          disabled={busy || policy.revision === 0}
          onClick={() =>
            void work(async () => {
              await api.request("/operations/retention/telemetry", "POST", {
                confirm: "PRUNE_TELEMETRY",
              });
              setMessage(
                "설정 기간을 지난 현재 공간의 사용량 기록을 삭제했습니다.",
              );
            })
          }
        >
          기한이 지난 사용량 삭제
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const r = await api.request<{ archived: number }>(
                "/operations/audit/archive",
                "POST",
                {
                  includeUnexpired: false,
                  confirm: "ARCHIVE_AND_PRUNE_EXPIRED_AUDIT",
                },
              );
              setMessage(
                `독립 서명·암호화 보관 검증 후 감사 ${r.archived}건을 온라인에서 정리했습니다.`,
              );
            })
          }
        >
          기한이 지난 감사 기록 보관·정리
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const r = await api.request<{ archived: number }>(
                "/operations/audit/archive",
                "POST",
                { includeUnexpired: true, confirm: "ARCHIVE_ACTIVE_AUDIT" },
              );
              setMessage(
                `현재 감사 ${r.archived}건을 분할 암호화 보관했습니다. 루트 앵커와 삭제 영수증은 유지합니다.`,
              );
            })
          }
        >
          10,000건 이상 감사 분할 보관
        </button>
        <p>
          정책 저장만으로 백업 예약이 실행되지는 않습니다. 키·복구 정책은 운영자
          전용 CLI에서 관리합니다.
        </p>
      </details>
      <details>
        <summary>근거 계보 법정 삭제 — Owner 전용</summary>
        {!canOwner ? (
          <p>현재 검증된 Owner만 실행할 수 있습니다.</p>
        ) : (
          <>
            <label>
              명시적 삭제 범위
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as "resource" | "workspace");
                  setPreview(null);
                  setConfirm("");
                }}
              >
                <option value="resource">
                  선택한 자료 및 실제 파생 계보만
                </option>
                <option value="workspace">공간 전체 — 별도 승인</option>
              </select>
            </label>
            {scope === "resource" ? (
              <>
                <label>
                  자료 종류
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as "source" | "page");
                      setPreview(null);
                    }}
                  >
                    <option value="source">원본</option>
                    <option value="page">페이지</option>
                  </select>
                </label>
                <label>
                  자료 ID
                  <input
                    value={resourceId}
                    onChange={(e) => {
                      setResourceId(e.target.value);
                      setPreview(null);
                    }}
                  />
                </label>
              </>
            ) : (
              <label>
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(e) => {
                    setWhole(e.target.checked);
                    setPreview(null);
                  }}
                />
                원본·초안·템플릿·댓글·알림·개인 기록·모델/작업 결과를 포함해
                공간 전체를 삭제 대상으로 미리 봅니다.
              </label>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const p = await api.request<Preview>(
                    "/operations/erasure/preview",
                    "POST",
                    erasureRequest(scope, kind, resourceId, whole),
                  );
                  setPreview(p);
                  setConfirm("");
                  setMessage(
                    "삭제 미리보기를 생성했습니다. 변경이 있으면 해시가 달라져 재검토가 필요합니다.",
                  );
                })
              }
            >
              삭제 영향 미리보기
            </button>
            {preview && (
              <div>
                <p>
                  대상 {preview.total}행 · 법적 보존{" "}
                  {preview.legalHold ? "차단" : "확인된 차단 없음"} · 계보
                  미확인 {preview.unresolvedUnlineagedRows}행
                </p>
                <p>
                  계보가 없는 자료는 선택 자료의 사본이라고 추정하지 않으며,
                  별도의 공간 전체 미리보기 없이 자동 확대 삭제하지 않습니다.
                </p>
                <pre
                  tabIndex={0}
                  style={{ overflow: "auto", maxHeight: "20rem" }}
                >
                  {JSON.stringify(preview.counts, null, 2)}
                </pre>
                <p>
                  <code>{preview.previewHash}</code>
                </p>
                <label>
                  확인 문구: 영구 삭제 승인
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
                <button
                  disabled={
                    busy || preview.legalHold || confirm !== "영구 삭제 승인"
                  }
                  onClick={() =>
                    void work(async () => {
                      const result = await api.request<{
                        status: string;
                        allCopiesErased: false;
                      }>("/operations/erasure/execute", "POST", {
                        scope: preview.scope,
                        ...(preview.resource
                          ? { resource: preview.resource }
                          : {}),
                        previewHash: preview.previewHash,
                        confirm:
                          preview.scope === "workspace"
                            ? "ERASE_ENTIRE_WORKSPACE"
                            : "ERASE_PREVIEWED_RESOURCE_LINEAGE",
                      });
                      setMessage(
                        `삭제 영수증 상태: ${result.status}. 외부 사본까지 모두 삭제되었다는 의미는 아닙니다.`,
                      );
                      setPreview(null);
                      setConfirm("");
                      await page(0, "receipts");
                    })
                  }
                >
                  영구 삭제 실행
                </button>
              </div>
            )}
          </>
        )}
      </details>
      <details>
        <summary>삭제·제한·보관 영수증 — 페이지당 25건</summary>
        <nav aria-label="운영 기록 종류">
          {(
            [
              ["receipts", "삭제 영수증"],
              ["tombstones", "삭제·접근 제한 기록"],
              ["archives", "감사 보관 앵커"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              disabled={busy}
              onClick={() => void work(() => page(0, key))}
            >
              {label}
            </button>
          ))}
        </nav>
        <div
          role="region"
          aria-label="운영 영수증 표"
          tabIndex={0}
          style={{ overflowX: "auto" }}
        >
          <table style={{ minWidth: "38rem" }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>범위·상태</th>
                <th>실행 시각</th>
                <th>제한</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.id}</code>
                  </td>
                  <td>
                    {r.scope ?? "기록"} / {r.status ?? "보관됨"}
                  </td>
                  <td>{r.created_at ?? "별도 보관 기록"}</td>
                  <td>{r.error_code ?? "전체 외부 사본 삭제 보장 없음"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          disabled={busy || offset === 0}
          onClick={() => void work(() => page(Math.max(0, offset - 25)))}
        >
          이전 25건
        </button>
        <button
          disabled={busy || receipts.length < 25}
          onClick={() => void work(() => page(offset + 25))}
        >
          다음 25건
        </button>
      </details>
      <details>
        <summary>복구 운영자 절차</summary>
        <ol>
          <li>
            암호화된 DB·파일·삭제 제한 기록을 격리 복원하고 모든 과거
            세션·자격증명·자동 실행을 폐기합니다.
          </li>
          <li>
            독립 서명된 현재 조직·팀·Owner·정상 검토자 정책과 DB/백업 식별자를
            확인합니다.
          </li>
          <li>
            미리보기 해시와 명시적 운영자 승인으로만 격리를 해제하며, 사용자는
            새 SSO 로그인 후 접근합니다.
          </li>
        </ol>
        <p>브라우저는 복구 키·경로·SQL·현재 정책 권위 파일을 받지 않습니다.</p>
      </details>
    </section>
  );
}
