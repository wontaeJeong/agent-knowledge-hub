import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, OperationalApi, pageItems, snapshotPath } from "./api";

type Mode = "model" | "offline";
type EvidenceKind =
  "claim" | "inference" | "hypothesis" | "independent-execution";
export interface RefinementPage {
  id: string;
  title: string;
  version?: number;
  versions?: { number: number }[];
}
export interface SourceSnapshot {
  id: string;
  title: string;
  content: string;
  sourceVersion: string;
}
export interface EvidenceView {
  id: string;
  kind?: string;
  sourceId?: string;
  sourceVersion?: string;
  location?: { start: number; end: number; quote: string };
  parentIds?: string[];
  executionAttestation?: {
    status: string;
    reason?: string;
    provider?: string;
    executorId?: string;
    executedAt?: string;
    outcome?: string;
  };
}
export interface ClaimView {
  id: string;
  pageId?: string;
  pageVersion?: number;
  key?: string;
  value?: string;
  kind?: string;
  conditions?: Record<string, string>;
  exceptions?: string[];
  assertedAt?: string;
  validFrom?: string | null;
  validTo?: string | null;
  verifiedAt?: string | null;
  uncertainty?: string;
  evidence?: EvidenceView[];
  validation?: string;
  validAtRequestedTime?: boolean;
  verificationReviews?: {
    id: string;
    status: string;
    verifiedAt: string;
    reason?: string;
    attestationStatus?: string;
    attestationError?: string;
    executionReceipts?: {
      receiptId: string;
      provider: string;
      executionId: string;
      executorId: string;
      executedAt: string;
      outcome: string;
      sourceId: string;
      sourceVersion: string;
      location: { start: number; end: number };
    }[];
  }[];
}
export interface ReviewRequest {
  id: string;
  claimIds?: string[];
  reason?: string;
  status?: string;
  result?: string;
  observations?: string;
  uncertainty?: string;
  limits?: string;
  rootLineage?: {
    sourceId: string;
    sourceVersion?: string;
    location?: unknown;
  }[];
}
interface OutcomeView {
  id: string;
  claimIds: string[];
  result: string;
  observations: string;
  lesson?: string;
  limits?: string;
  humanValidation: string;
  reviews?: { status: string; recordedAt?: string; verifiedAt?: string }[];
}
interface ContextView {
  items: ClaimView[];
  unknownTime?: string[];
  omitted?: number;
  asOf?: string;
  temporalMode?: string;
  conflicts?: { claimIds: string[]; kind: string; resolution: string }[];
}
interface SemanticResult {
  status: string;
  findings?: { kind: string; explanation: string; claimIds: string[] }[];
  requestIds?: string[];
}
const now = () => new Date().toISOString().slice(0, 16);
const unique = (values: string[]) => [...new Set(values)];
export function executionEvidenceNotice(e: EvidenceView): string {
  if (e.kind !== "independent-execution")
    return "등록된 근거 유형이며 독립 실행의 증명이 아닙니다.";
  const proof = e.executionAttestation;
  return proof?.status === "attested-unreviewed"
    ? `신뢰 게이트웨이 실행 영수증 확인 · 실제 실행 ${proof.executedAt} · 실행자 ${proof.executorId} · 결과 ${proof.outcome}. 별도 인간 검토와 별개이며 공식 채택을 뜻하지 않습니다.`
    : `신뢰 실행 영수증 미확인 (${proof?.reason ?? "등록 유형/ID만으로 증명할 수 없음"}). 업로드 본문이나 LLM 성공 선언은 실행 증명이 아닙니다.`;
}
const parseConditions = (value: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(value || "{}");
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    Object.keys(parsed).length > 30 ||
    Object.entries(parsed).some(
      ([k, v]) =>
        !k || k.length > 100 || typeof v !== "string" || !v || v.length > 500,
    )
  )
    throw Error("조건은 최대 30개의 문자열 값 JSON 객체로 입력하세요.");
  return parsed as Record<string, string>;
};
const iso = (value: string) => {
  if (!value) throw Error("시각을 입력하세요.");
  const date = new Date(/Z$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(date.getTime()))
    throw Error("올바른 UTC 시각을 입력하세요.");
  return date.toISOString();
};
export const refinementPage = <T,>(items: T[], page: number) =>
  pageItems(items, page);
export function contextBody(
  asOf: string,
  environment: string,
  pageId: string,
  includeHistory = false,
) {
  return {
    environment: parseConditions(environment),
    ...(asOf ? { asOf: iso(asOf) } : {}),
    ...(pageId ? { pageIds: [pageId] } : {}),
    includeHistory,
    limit: 100,
  };
}
export function evidenceBody(d: {
  id: string;
  source: SourceSnapshot;
  quote: string;
  start: number;
  kind: EvidenceKind;
  parentIds: string[];
  assertedAt: string;
  conditions: string;
  executionId: string;
}) {
  if (
    !Number.isInteger(d.start) ||
    d.start < 0 ||
    !d.quote ||
    d.source.content.slice(d.start, d.start + d.quote.length) !== d.quote
  )
    throw Error("정확한 원본 인용과 시작 위치를 확인하세요.");
  if (
    (d.kind === "inference" || d.kind === "hypothesis") &&
    !d.parentIds.length
  )
    throw Error("파생 근거의 부모 계보를 선택하세요.");
  if (
    d.kind === "independent-execution" &&
    (!d.executionId || d.parentIds.length)
  )
    throw Error(
      "독립 실행 ID가 필요하며 파생 근거를 독립 실행으로 바꿀 수 없습니다.",
    );
  return {
    id: d.id,
    kind: d.kind,
    sourceId: d.source.id,
    sourceVersion: d.source.sourceVersion,
    location: { start: d.start, end: d.start + d.quote.length, quote: d.quote },
    parentIds: unique(d.parentIds),
    assertedAt: iso(d.assertedAt),
    verifiedAt: null,
    conditions: parseConditions(d.conditions),
    ...(d.executionId ? { executionId: d.executionId } : {}),
  };
}
export function claimBody(d: {
  id: string;
  pageId: string;
  pageVersion: number;
  key: string;
  value: string;
  kind: "claim" | "inference" | "hypothesis";
  evidenceIds: string[];
  conditions: string;
  exceptions: string;
  assertedAt: string;
  validFrom: string;
  validTo: string;
  uncertainty: string;
  supersedes: string[];
  protected: boolean;
}) {
  if (
    !d.pageId ||
    !Number.isSafeInteger(d.pageVersion) ||
    d.pageVersion < 1 ||
    !d.evidenceIds.length
  )
    throw Error("현재 문서·버전과 근거를 선택하세요.");
  const { conditions, exceptions, assertedAt, validFrom, validTo, ...rest } = d;
  return {
    ...rest,
    evidenceIds: unique(d.evidenceIds),
    conditions: parseConditions(conditions),
    exceptions: exceptions
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean),
    assertedAt: iso(assertedAt),
    validFrom: validFrom ? iso(validFrom) : null,
    validTo: validTo ? iso(validTo) : null,
    verifiedAt: null,
  };
}
export function reviewSourceIds(
  request: ReviewRequest,
  claims: ClaimView[],
): string[] {
  return unique([
    ...(request.rootLineage ?? []).map((r) => r.sourceId),
    ...claims
      .filter((c) => request.claimIds?.includes(c.id))
      .flatMap((c) =>
        (c.evidence ?? []).flatMap((e) => (e.sourceId ? [e.sourceId] : [])),
      ),
  ]);
}
export async function queueRefinement(
  api: OperationalApi,
  sourceIds: string[],
  mode: Mode,
  key: string,
) {
  if (!sourceIds.length)
    throw Error("원본 근거가 없습니다. 먼저 근거 원본을 등록·연결하세요.");
  const result = await api.post<{
    id?: string;
    jobId?: string;
    job_id?: string;
    status?: string;
  }>("/ingest", { sourceIds: unique(sourceIds), mode }, key);
  const id = result.id ?? result.jobId ?? result.job_id;
  if (!id || result.status !== "queued")
    throw Error(
      "서버가 작업 대기 접수를 확인하지 못했습니다. 완료로 표시하지 않습니다.",
    );
  return {
    id,
    message: `작업 ${id} 대기 접수 — 편입·검토·발행 완료가 아닙니다. ${mode === "offline" ? "오프라인 명시 구조 검사이며 의미 종합이 아닙니다." : "모델 실행 결과와 인간 변경 집합 검토를 확인하세요."}`,
  };
}
export function semanticNotice(result: SemanticResult) {
  if (result.status === "unconfigured")
    return "의미 점검 모델 미설정 — 실행 결과가 없습니다.";
  if (result.status !== "completed")
    return "의미 점검 실패 — 결과를 지어내거나 반영하지 않았습니다.";
  return `모델 점검의 검토 후보 ${result.findings?.length ?? 0}건. 확률적 제안이며 사실 검증·승인·실제 업무 품질 개선을 뜻하지 않습니다.`;
}
function Pager({
  items,
  page,
  onPage,
  label,
}: {
  items: unknown[];
  page: number;
  onPage: (value: number) => void;
  label: string;
}) {
  return (
    <nav aria-label={`${label} 25건 페이지`}>
      <button
        type="button"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        이전
      </button>
      <span>
        {items.length
          ? `${page * 25 + 1}–${Math.min((page + 1) * 25, items.length)} / ${items.length}건`
          : "0건"}{" "}
        · 25건씩
      </span>
      <button
        type="button"
        disabled={(page + 1) * 25 >= items.length}
        onClick={() => onPage(page + 1)}
      >
        다음
      </button>
    </nav>
  );
}
function Picker({
  label,
  items,
  selected,
  onSelect,
}: {
  label: string;
  items: { id: string; label: string }[];
  selected: string[];
  onSelect: (ids: string[]) => void;
}) {
  const [page, setPage] = useState(0);
  const p = Math.min(page, Math.max(0, Math.ceil(items.length / 25) - 1));
  return (
    <fieldset>
      <legend>
        {label} ({selected.length}개 선택)
      </legend>
      <Pager label={label} items={items} page={p} onPage={setPage} />
      {refinementPage(items, p).map((item) => (
        <label key={item.id} className="ref-check">
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            onChange={(e) =>
              onSelect(
                e.target.checked
                  ? unique([...selected, item.id])
                  : selected.filter((id) => id !== item.id),
              )
            }
          />
          {item.label}
        </label>
      ))}
      {!items.length && (
        <p>
          조회된 후보가 없습니다. 먼저 문맥/과거 후보를 조회하거나 근거를
          등록하세요.
        </p>
      )}
    </fieldset>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ref-field">
      {label}
      {children}
    </label>
  );
}
const emptyEvidence = () => ({
  quote: "",
  start: 0,
  kind: "claim" as EvidenceKind,
  parentIds: [] as string[],
  assertedAt: now(),
  conditions: "{}",
  executionId: "",
});
const emptyClaim = () => ({
  pageId: "",
  key: "",
  value: "",
  kind: "claim" as "claim" | "inference" | "hypothesis",
  evidenceIds: [] as string[],
  conditions: "{}",
  exceptions: "",
  assertedAt: now(),
  validFrom: "",
  validTo: "",
  uncertainty: "단일 사례; 독립 검증과 다른 환경 적용은 미확인",
  supersedes: [] as string[],
  protected: false,
});
const emptyOutcome = () => ({
  claimIds: [] as string[],
  result: "unknown",
  problem: "",
  attempt: "",
  observations: "",
  conditions: "{}",
  evidenceIds: [] as string[],
  lesson: "",
  limits: "단일 사례; 다른 환경에서의 재사용은 미검증",
});
const emptyReview = () => ({
  target: "claim",
  claimIds: [] as string[],
  outcomeId: "",
  status: "reviewed",
  evidenceIds: [] as string[],
  reason: "",
});

export interface RefinementPanelProps {
  api: OperationalApi;
  capabilities: readonly string[];
  pages?: readonly RefinementPage[];
  onExpired?: () => void;
  onChanged?: () => void | Promise<void>;
}
export function RefinementPanel({
  api,
  capabilities,
  pages,
  onExpired = () => {},
  onChanged = () => {},
}: RefinementPanelProps) {
  const canWrite = capabilities.includes("changeset.propose"),
    canReview = capabilities.includes("knowledge.protect"),
    canLint = capabilities.includes("lint.run");
  const [loadedPages, setLoadedPages] = useState<RefinementPage[]>([]),
    [sources, setSources] = useState<{ id: string; title: string }[]>([]),
    [sourceId, setSourceId] = useState(""),
    [source, setSource] = useState<SourceSnapshot | null>(null),
    [sourcePage, setSourcePage] = useState(0);
  const [context, setContext] = useState<ContextView>({ items: [] }),
    [requests, setRequests] = useState<ReviewRequest[]>([]),
    [outcomes, setOutcomes] = useState<OutcomeView[]>([]),
    [registered, setRegistered] = useState<EvidenceView[]>([]),
    [message, setMessage] = useState("현재 권한의 문맥을 조회하세요."),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState(""),
    [environment, setEnvironment] = useState("{}"),
    [filterPage, setFilterPage] = useState(""),
    [history, setHistory] = useState(false),
    [contextPage, setContextPage] = useState(0),
    [requestPage, setRequestPage] = useState(0),
    [outcomePage, setOutcomePage] = useState(0),
    [mode, setMode] = useState<Mode>("model"),
    [semantic, setSemantic] = useState<SemanticResult | null>(null);
  const [ev, setEv] = useState(emptyEvidence),
    [cl, setCl] = useState(emptyClaim),
    [out, setOut] = useState(emptyOutcome),
    [review, setReview] = useState(emptyReview),
    [job, setJob] = useState("");
  const epoch = useRef(0),
    keys = useRef(new Map<string, string>());
  const [accessBlocked, setAccessBlocked] = useState(false);
  const availablePages = accessBlocked ? [] : (pages ?? loadedPages);
  const knownEvidence = [
    ...new Map(
      [...registered, ...context.items.flatMap((c) => c.evidence ?? [])].map(
        (e) => [e.id, e],
      ),
    ).values(),
  ];
  const evidenceOptions = knownEvidence.map((e) => ({
    id: e.id,
    label: `${e.id} · ${e.kind ?? "유형 미확인"}${e.sourceId ? ` · ${e.sourceId}` : " · 파생 계보"}`,
  }));
  const claimOptions = context.items.map((c) => ({
    id: c.id,
    label: `${c.key ?? c.id} (${c.id}) · ${c.pageId ?? "문서 미확인"} v${c.pageVersion ?? "?"}`,
  }));
  const permissions = [...capabilities].sort().join("|"),
    pageKey = (pages ?? [])
      .map((p) => `${p.id}:${p.version ?? p.versions?.at(-1)?.number}`)
      .join("|");
  function clearProtected() {
    setSourcePage(0);
    setContextPage(0);
    setRequestPage(0);
    setOutcomePage(0);
    setContext({ items: [] });
    setRequests([]);
    setOutcomes([]);
    setSources([]);
    setSource(null);
    setSourceId("");
    setRegistered([]);
    setEv(emptyEvidence());
    setCl(emptyClaim());
    setOut(emptyOutcome());
    setReview(emptyReview());
    setSemantic(null);
    setLoadedPages([]);
    keys.current.clear();
    setJob("");
  }
  async function run<T>(
    work: () => Promise<T>,
    done: (value: T) => void,
    changed = false,
  ) {
    const n = epoch.current;
    setBusy(true);
    setError("");
    try {
      const value = await work();
      if (n !== epoch.current) return;
      done(value);
      if (changed) await onChanged();
    } catch (e) {
      if (n !== epoch.current) return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        clearProtected();
        setAccessBlocked(true);
        setMessage(
          "현재 권한을 확인하지 못해 이전 문맥·원본·성과·입력 내용을 비웠습니다. 다시 인증/조회하세요.",
        );
        if (e.status === 401) onExpired();
      }
      const executionErrors: Record<string, string> = {
        EXECUTION_VERIFIER_UNCONFIGURED:
          "승인된 실행 검증 게이트웨이가 미설정입니다. 실행 유형/ID만으로 검증할 수 없습니다.",
        EXECUTION_VERIFIER_CONFIGURATION:
          "실행 검증 공급자/서버 설정이 일치하지 않습니다.",
        TRUSTED_EXECUTION_REQUIRED:
          "서명된 신뢰 실행 영수증이 없습니다. 원본 본문·LLM 주장만으로 실행 검증할 수 없습니다.",
        EXECUTION_ATTESTATION_INVALID:
          "실행 영수증의 원본·위치·ID·요청 결박이 올바르지 않습니다.",
        EXECUTION_SIGNATURE_INVALID: "실행 영수증 서명이 유효하지 않습니다.",
        EXECUTION_ATTESTATION_STALE:
          "실행 영수증이 만료되었거나 시각이 유효하지 않습니다.",
        EXECUTION_VERIFIER_UNAVAILABLE:
          "신뢰 실행 검증 게이트웨이 호출에 실패했습니다.",
        EXECUTION_VERIFIER_OUTPUT_LIMIT:
          "실행 검증 응답이 허용 크기를 초과했습니다.",
        EXECUTION_FAILED:
          "실패 실행은 성공한 실행 검증으로 승격할 수 없습니다. 실패 관찰은 별도로 보존하세요.",
        EXECUTION_RECEIPT_REPLAY:
          "이미 등록한 실행 영수증입니다. 기존 근거를 재사용하세요.",
        EXECUTION_SOURCE_CHANGED:
          "실행 근거의 원본 버전이 달라졌습니다. 현재 원본을 다시 확인하세요.",
        EXECUTION_CLAIM_MISMATCH:
          "실행 영수증이 이 주장의 정확한 원본 위치/버전을 지지하지 않습니다.",
      };
      setError(
        e instanceof ApiError && executionErrors[e.code]
          ? `${executionErrors[e.code]} (${e.code})`
          : e instanceof Error
            ? e.message
            : "요청을 완료하지 못했습니다.",
      );
    } finally {
      if (n === epoch.current) setBusy(false);
    }
  }
  async function load() {
    return Promise.all([
      api.post<ContextView>(
        "/refinement/context",
        contextBody(asOf, environment, filterPage, history),
      ),
      api.get<{ items: ReviewRequest[] }>("/refinement/requests"),
      api.get<{ items: OutcomeView[] }>("/refinement/outcomes"),
    ]);
  }
  const loaded = (data: Awaited<ReturnType<typeof load>>) => {
    setAccessBlocked(false);
    setContext(data[0]);
    setRequests(data[1].items);
    setOutcomes(data[2].items);
    setContextPage(0);
    setRequestPage(0);
    setOutcomePage(0);
    setMessage(
      "현재 권한으로 문맥·검토 요청·성과를 조회했습니다. 미검증 후보를 공식 결론으로 사용하지 마세요.",
    );
  };
  useEffect(() => {
    const n = ++epoch.current;
    clearProtected();
    setAccessBlocked(false);
    setAsOf("");
    setEnvironment("{}");
    setFilterPage("");
    setHistory(false);
    setMessage("현재 권한의 문맥과 검토 후보를 불러오는 중입니다.");
    void run(
      async () => {
        const base = await Promise.all([
          api.post<ContextView>("/refinement/context", {
            environment: {},
            limit: 100,
          }),
          api.get<{ items: ReviewRequest[] }>("/refinement/requests"),
          api.get<{ items: OutcomeView[] }>("/refinement/outcomes"),
        ]);
        const extra = await Promise.all([
          pages
            ? Promise.resolve({ items: [] as RefinementPage[] })
            : api.get<{ items: RefinementPage[] }>("/pages"),
          canWrite
            ? api.get<{ items: { id: string; title: string }[] }>("/sources")
            : Promise.resolve({ items: [] as { id: string; title: string }[] }),
        ]);
        return { base, extra };
      },
      ({ base, extra }) => {
        if (n !== epoch.current) return;
        loaded(base);
        setLoadedPages(extra[0].items);
        setSources(extra[1].items);
      },
    );
    return () => {
      epoch.current++;
    };
    // The selected-space API, capability set and current resource versions define the privacy boundary.
  }, [api, permissions, pageKey]);
  const openSource = (id: string) => {
    setSource(null);
    return void run(
      () =>
        api.post<SourceSnapshot>("/refinement/source-snapshot", {
          sourceId: id,
        }),
      (snapshot) => {
        setSource(snapshot);
        setSourceId(snapshot.id);
        setEv(emptyEvidence());
        setMessage("현재 권한으로 정확한 원본·버전을 열었습니다.");
      },
    );
  };
  const rootLink = (id: string) => (
    <a
      href="#refinement-source-details"
      aria-disabled={busy}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        openSource(id);
      }}
    >
      {id} 원본 열기
    </a>
  );
  const refresh = () => void run(load, loaded);
  const mutationId = (kind: string, value: unknown) => {
    const fingerprint = `mutation:${kind}:${JSON.stringify(value)}`;
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(fingerprint, key);
    }
    return key;
  };
  const submitEvidence = () =>
    void run(
      () => {
        if (!source) throw Error("현재 원본을 선택해 읽으세요.");
        const body = evidenceBody({ ...ev, id: "candidate", source });
        return api.post<EvidenceView>("/refinement/evidence", {
          ...body,
          id: mutationId("evidence", body),
        });
      },
      (e) => {
        setRegistered((prev) => [
          ...new Map([...prev, e].map((v) => [v.id, v])).values(),
        ]);
        setCl((prev) => ({
          ...prev,
          evidenceIds: unique([...prev.evidenceIds, e.id]),
        }));
        setMessage(
          `근거 ${e.id} 등록. 실행 유형/ID는 그 자체로 실행 증명이 아닙니다. 신뢰 실행 영수증과 별도 인간 검토가 필요합니다. 원본 주장·추론과 구분하세요.`,
        );
      },
      true,
    );
  const submitClaim = () =>
    void run(
      async () => {
        const p = availablePages.find((p) => p.id === cl.pageId);
        const body = claimBody({
          ...cl,
          id: "candidate",
          pageVersion: p?.version ?? p?.versions?.at(-1)?.number ?? 0,
        });
        const created = await api.post<ClaimView>("/refinement/claims", {
          ...body,
          id: mutationId("claim", body),
        });
        return { created, data: await load() };
      },
      ({ created: c, data }) => {
        loaded(data);
        setMessage(
          `주장 ${c.id}과 재검토 요청을 등록했습니다. 발행본은 바뀌지 않았습니다.`,
        );
      },
      true,
    );
  const queue = (r: ReviewRequest) =>
    void run(
      async () => {
        const ids = reviewSourceIds(r, context.items),
          fingerprint = JSON.stringify([r.id, mode, ids]);
        let key = keys.current.get(fingerprint);
        if (!key) {
          key = crypto.randomUUID();
          keys.current.set(fingerprint, key);
        }
        return queueRefinement(api, ids, mode, key);
      },
      (result) => {
        setJob(result.id);
        setMessage(result.message);
      },
      true,
    );
  return (
    <section className="panel refinement-panel" aria-label="지식 정련">
      <style>{`.refinement-panel{font-size:14px;min-width:0}.refinement-panel h2{font-size:22px}.refinement-panel p{line-height:1.6}.refinement-panel form,.refinement-panel fieldset,.refinement-panel article,.refinement-panel details{min-width:0;margin:12px 0;padding:12px;border:1px solid #d9cddd;border-radius:8px}.refinement-panel label.ref-field{display:grid;gap:6px;margin:10px 0}.refinement-panel input:not([type=checkbox]),.refinement-panel select,.refinement-panel textarea{min-width:0;max-width:100%;width:100%;padding:8px;font:inherit;box-sizing:border-box}.refinement-panel textarea{min-height:80px}.refinement-panel .ref-check{display:flex;gap:8px;align-items:flex-start;margin:8px 0}.refinement-panel button{font:inherit;min-height:36px;margin:4px;padding:6px 10px;white-space:normal}.refinement-panel nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.refinement-panel code,.refinement-panel dd,.refinement-panel li{overflow-wrap:anywhere}.refinement-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}.refinement-panel dl{display:grid;grid-template-columns:minmax(80px,1fr) minmax(0,3fr);gap:6px}.refinement-panel dd{margin:0}.refinement-panel a{color:#663f70}.refinement-panel summary{cursor:pointer;min-height:32px}.refinement-panel :focus-visible{outline:3px solid #79526e;outline-offset:2px}.refinement-panel .ref-notice{background:#f4edf5;border-left:4px solid #79526e;padding:12px}.refinement-panel fieldset:disabled{opacity:.75}`}</style>
      <h2>지식 정련 · 시간·근거·경험</h2>
      <p className="ref-notice">
        결론: 현재 권한으로 읽은 검토 후보입니다. 단일 사례·추론·검토 승인은
        독립 실행 검증이나 공식 지식과 다릅니다. 시점 조회도 과거 권한을
        복원하지 않습니다. 모델의 실제 업무 효과는 아직 검증하지 않았습니다.
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {error && <p role="alert">{error}</p>}
      {job && (
        <p>
          <a href="#durable-jobs-title">대기 작업 {job} 확인</a> · 작업 목록에서
          실행/실패와 변경 집합을 확인하세요.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          refresh();
        }}
      >
        <fieldset disabled={busy}>
          <legend>문맥 · 현재/과거 시점</legend>
          <p>
            시각 입력은 모두 UTC입니다. 유효 시점·주장 시점·검증 이벤트 시각을
            구분합니다.
          </p>
          <Field label="기준 시점 (UTC, 비우면 현재)">
            <input
              type="datetime-local"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </Field>
          <Field label="문서 선택 (현재 접근 가능)">
            <select
              value={filterPage}
              onChange={(e) => setFilterPage(e.target.value)}
            >
              <option value="">전체 문서</option>
              {availablePages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.id}
                </option>
              ))}
            </select>
          </Field>
          <details>
            <summary>환경 조건 (고급 JSON)</summary>
            <Field label="조회 환경 조건">
              <textarea
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                maxLength={20000}
              />
            </Field>
            <p>
              예: {`{"os":"linux","version":"2.0"}`}. 미입력 조건은 일치로
              확정하지 않습니다.
            </p>
          </details>
          <label className="ref-check">
            <input
              type="checkbox"
              checked={history}
              onChange={(e) => setHistory(e.target.checked)}
            />
            과거·시점 미확인 후보도 보기 (현행 권고 아님)
          </label>
          <button type="submit">현재 권한으로 문맥·검토 목록 조회</button>
        </fieldset>
      </form>
      {canWrite && (
        <button
          disabled={busy}
          onClick={() =>
            void run(
              async () => {
                const result = await api.post<{ imported: string[] }>(
                  "/refinement/import-agent-signals",
                  {},
                );
                return { result, data: await load() };
              },
              ({ result: r, data }) => {
                loaded(data);
                setMessage(
                  `에이전트 신호 ${r.imported.length}건을 재검토 요청으로 편입했습니다. 독립 증거/검증/발행이 아닙니다.`,
                );
              },
              true,
            )
          }
        >
          에이전트 신호 편입
        </button>
      )}
      {canLint && (
        <button
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                api.post<SemanticResult>(
                  "/refinement/semantic-lint",
                  contextBody(asOf, environment, filterPage, true),
                ),
              (r) => {
                setSemantic(r);
                setMessage(semanticNotice(r));
              },
              true,
            )
          }
        >
          모델 의미 점검 요청
        </button>
      )}
      {semantic && (
        <details>
          <summary>
            의미 점검 결과 ·{" "}
            {semantic.status === "completed" ? "검토 제안" : "미실행/실패"}
          </summary>
          <p>{semanticNotice(semantic)}</p>
          {semantic.findings?.map((f, i) => (
            <p key={i}>
              {f.kind} · {f.explanation} · {f.claimIds.join(", ")}
            </p>
          ))}
        </details>
      )}
      <section aria-label="시점별 주장">
        <details>
          <summary>주장·근거 문맥 ({context.items.length}건 · 25건씩)</summary>
          <p>
            조회 기준 {context.asOf ?? "미조회"} ·{" "}
            {context.temporalMode === "history-not-current-recommendation"
              ? "과거 후보 포함 — 현재 권고 아님"
              : "유효 시점별 후보"}
            . 시점 미확인 {context.unknownTime?.length ?? 0}건 · 분량 상한 생략{" "}
            {context.omitted ?? 0}건. 생략되면 문서별로 다시 조회하세요.
          </p>
          <Pager
            label="주장"
            items={context.items}
            page={contextPage}
            onPage={setContextPage}
          />
          {refinementPage(context.items, contextPage).map((c) => (
            <article key={c.id}>
              <h4>
                {c.key ?? c.id} · {c.validation ?? "미검증"}
              </h4>
              <p>{c.value}</p>
              <p>
                문서 {c.pageId} v{c.pageVersion} ·{" "}
                {c.validAtRequestedTime
                  ? "조회 시점의 유효 후보"
                  : "조회 시점 유효성 미확인/기간 밖"}
              </p>
              <dl>
                <dt>주장 기록</dt>
                <dd>{c.assertedAt ?? "미확인"}</dd>
                <dt>유효 기간</dt>
                <dd>
                  {c.validFrom ?? "시작 미확인"} → {c.validTo ?? "종료 미확인"}
                </dd>
                <dt>원래 검증 시각</dt>
                <dd>
                  {c.verifiedAt ?? "미검증 (수정 시각으로 대체하지 않음)"}
                </dd>
                <dt>불확실성</dt>
                <dd>{c.uncertainty ?? "미등록"}</dd>
                <dt>환경/예외</dt>
                <dd>
                  {JSON.stringify(c.conditions ?? {})} ·{" "}
                  {c.exceptions?.join(" / ") || "예외 미등록"}
                </dd>
              </dl>
              <details>
                <summary>정확한 근거·부모 계보·별도 검증 이벤트</summary>
                {c.evidence?.map((e) => (
                  <div key={e.id}>
                    <p>
                      <code>{e.id}</code> · {e.kind ?? "유형 미확인"} ·{" "}
                      {e.sourceId ? rootLink(e.sourceId) : "파생 근거"}
                    </p>
                    <p>{executionEvidenceNotice(e)}</p>
                    <p>
                      원본 버전{" "}
                      <code>{e.sourceVersion ?? "부모 원본 참조"}</code> · 위치{" "}
                      {e.location
                        ? `${e.location.start}–${e.location.end}`
                        : "부모 참조"}
                    </p>
                    <blockquote>{e.location?.quote}</blockquote>
                    <p>부모 {e.parentIds?.join(", ") || "없음"}</p>
                  </div>
                ))}
                {c.verificationReviews?.map((r) => (
                  <p key={r.id}>
                    별도 인간 검토 {r.status} · 검증 이벤트 시각 {r.verifiedAt}{" "}
                    · {r.reason}
                    {r.attestationStatus === "unverified" &&
                      ` · 신뢰 영수증 미확인 (${r.attestationError}); 현재 실행 검증으로 사용하지 않음`}
                    {r.executionReceipts?.map((p) => (
                      <span style={{ display: "block" }} key={p.receiptId}>
                        서명 확인된 실행 영수증 {p.receiptId} · 공급자{" "}
                        {p.provider} · 실행 {p.executionId} · 실제 실행 시각{" "}
                        {p.executedAt} · 실행자 {p.executorId} · 결과{" "}
                        {p.outcome} · {rootLink(p.sourceId)} · 버전{" "}
                        <code>{p.sourceVersion}</code> · 위치 {p.location.start}
                        –{p.location.end}. 인간 검토 시각과 실제 실행 시각은
                        별개입니다.
                      </span>
                    ))}
                  </p>
                ))}
              </details>
            </article>
          ))}
          {context.conflicts?.length ? (
            <details>
              <summary>
                상충/시간/환경 차이 {context.conflicts.length}건
              </summary>
              {context.conflicts.map((f, i) => (
                <p key={i}>
                  {f.claimIds.join(" ↔ ")} · {f.kind} · 자동 확정하지 않고
                  재검토
                </p>
              ))}
            </details>
          ) : null}
        </details>
      </section>
      <section aria-label="재검토 요청">
        <details>
          <summary>
            재검토 요청 → 원본 근거로 재편입 ({requests.length}건 · 25건씩)
          </summary>
          <p>
            후보의 실제 원본을 공통 Ingest에 보내 연결된 변경 집합을 제안합니다.
            새 문서에 단순 추가하거나 즉시 발행하지 않습니다.
          </p>
          {canWrite && (
            <Field label="재편입 실행 모드">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                <option value="model">연결된 모델 종합 (실패 시 오류)</option>
                <option value="offline">
                  오프라인 명시 구조 검사 (의미 종합 아님)
                </option>
              </select>
            </Field>
          )}
          <Pager
            label="재검토 요청"
            items={requests}
            page={requestPage}
            onPage={setRequestPage}
          />
          {refinementPage(requests, requestPage).map((r) => {
            const ids = reviewSourceIds(r, context.items);
            return (
              <article key={r.id}>
                <h4>
                  {r.reason ?? "재검토"} · {r.id}
                </h4>
                <p>
                  {r.status ?? "pending-review"} · {r.result ?? "성과 미확인"}
                </p>
                {r.observations && <p>{r.observations}</p>}
                <p>
                  {r.uncertainty ?? "검토 후보이며 독립 검증은 미확인"}{" "}
                  {r.limits}
                </p>
                <details>
                  <summary>현재 ACL의 원본 근거 {ids.length}개</summary>
                  <ul>
                    {ids.map((id) => (
                      <li key={id}>
                        {rootLink(id)}
                        {r.rootLineage
                          ?.filter((v) => v.sourceId === id)
                          .map((v, i) => (
                            <p key={i}>
                              버전 <code>{v.sourceVersion ?? "원본 참조"}</code>{" "}
                              · 위치{" "}
                              <code>
                                {typeof v.location === "string"
                                  ? v.location
                                  : JSON.stringify(v.location ?? {})}
                              </code>
                            </p>
                          ))}
                      </li>
                    ))}
                  </ul>
                </details>
                {canWrite && (
                  <button
                    disabled={busy || !ids.length}
                    onClick={() => queue(r)}
                  >
                    원본 근거로 재편입 제안
                  </button>
                )}
                {!ids.length && (
                  <p>
                    연결된 원본 근거가 없습니다. 원본을 등록하고 근거 계보를
                    연결한 뒤 재편입하세요. 페이지/주장 ID를 원본 ID로 대신
                    보내지 않습니다.
                  </p>
                )}
              </article>
            );
          })}
        </details>
      </section>
      <section id="refinement-source-details" aria-label="정확한 원본">
        <h3>정확한 원본 · 현재 접근 재검사</h3>
        {canWrite && (
          <>
            <Pager
              label="원본 선택"
              items={sources}
              page={sourcePage}
              onPage={setSourcePage}
            />
            <Field label="근거 원본 선택">
              <select
                value={
                  refinementPage(sources, sourcePage).some(
                    (s) => s.id === sourceId,
                  )
                    ? sourceId
                    : ""
                }
                onChange={(e) => {
                  setSource(null);
                  setSourceId(e.target.value);
                  if (e.target.value) openSource(e.target.value);
                }}
                disabled={busy}
              >
                <option value="">원본 선택</option>
                {refinementPage(sources, sourcePage).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {s.id}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="원본 버전 해시">
          <input
            value={
              source?.sourceVersion ??
              "원본 선택 후 서버의 정확한 버전 해시 표시"
            }
            readOnly
          />
        </Field>
        {source ? (
          <>
            <h4>
              {source.title} · {source.id}
            </h4>
            <details>
              <summary>현재 원본 본문 열기</summary>
              <pre>{source.content}</pre>
            </details>
          </>
        ) : (
          <p>
            원본 링크나 현재 원본 선택으로 조회하세요. 접근이 철회되면 읽을 수
            없습니다.
          </p>
        )}
      </section>
      {canWrite && (
        <>
          <details>
            <summary>새 근거 등록</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitEvidence();
              }}
            >
              <fieldset disabled={busy || !source}>
                <legend>원본 위치·유형·주장 시각</legend>
                <Field label="근거 유형">
                  <select
                    value={ev.kind}
                    onChange={(e) =>
                      setEv({ ...ev, kind: e.target.value as EvidenceKind })
                    }
                  >
                    <option value="claim">원본 주장 (미검증)</option>
                    <option value="inference">파생 추론</option>
                    <option value="hypothesis">가설</option>
                    <option value="independent-execution">
                      독립 실행 주장 (신뢰 영수증 + 별도 인간 검토 필요)
                    </option>
                  </select>
                </Field>
                <Field label="정확한 원본 인용">
                  <textarea
                    required
                    value={ev.quote}
                    onChange={(e) =>
                      setEv({
                        ...ev,
                        quote: e.target.value,
                        start: Math.max(
                          0,
                          source?.content.indexOf(e.target.value) ?? 0,
                        ),
                      })
                    }
                    maxLength={20000}
                  />
                </Field>
                <Field label="인용 시작 offset (문자열 기준, 반복 인용 시 위치 확인)">
                  <input
                    type="number"
                    required
                    min={0}
                    value={ev.start}
                    onChange={(e) =>
                      setEv({ ...ev, start: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="주장/관찰 시각 (UTC)">
                  <input
                    type="datetime-local"
                    required
                    value={ev.assertedAt}
                    onChange={(e) =>
                      setEv({ ...ev, assertedAt: e.target.value })
                    }
                  />
                </Field>
                <Field label="독립 실행 ID (독립 실행 유형에 필수)">
                  <input
                    value={ev.executionId}
                    onChange={(e) =>
                      setEv({ ...ev, executionId: e.target.value })
                    }
                    maxLength={100}
                  />
                </Field>
                <p>
                  실행 ID는 영수증이 아닙니다. 서버에 승인된 검증 게이트웨이가
                  없으면 미확인 상태이며 실행 검증으로 승격할 수 없습니다.
                </p>
                <Picker
                  label="파생 근거 부모"
                  items={evidenceOptions}
                  selected={ev.parentIds}
                  onSelect={(ids) => setEv({ ...ev, parentIds: ids })}
                />
                <details>
                  <summary>근거 환경 조건 (고급 JSON)</summary>
                  <textarea
                    aria-label="근거 환경 조건 JSON"
                    value={ev.conditions}
                    onChange={(e) =>
                      setEv({ ...ev, conditions: e.target.value })
                    }
                  />
                </details>
                <p>
                  verifiedAt은 직접 입력하지 않습니다. 등록은 검증/공식 채택이
                  아니며 검증 시각은 별도 인간 검토 이벤트입니다.
                </p>
                <button type="submit">근거 등록 제출</button>
              </fieldset>
            </form>
          </details>
          <details>
            <summary>주장·시간·환경 정련 후보 작성</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitClaim();
              }}
            >
              <fieldset disabled={busy}>
                <legend>불변 주장 후보</legend>
                <Field label="주장 대상 문서">
                  <select
                    required
                    value={cl.pageId}
                    onChange={(e) => setCl({ ...cl, pageId: e.target.value })}
                  >
                    <option value="">현재 문서 선택</option>
                    {availablePages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} · v{p.version ?? p.versions?.at(-1)?.number}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="주장 키">
                  <input
                    required
                    value={cl.key}
                    onChange={(e) => setCl({ ...cl, key: e.target.value })}
                    maxLength={300}
                  />
                </Field>
                <Field label="주장 값/내용">
                  <textarea
                    required
                    value={cl.value}
                    onChange={(e) => setCl({ ...cl, value: e.target.value })}
                    maxLength={10000}
                  />
                </Field>
                <Field label="주장 유형">
                  <select
                    value={cl.kind}
                    onChange={(e) =>
                      setCl({ ...cl, kind: e.target.value as typeof cl.kind })
                    }
                  >
                    <option value="claim">주장</option>
                    <option value="inference">추론</option>
                    <option value="hypothesis">가설</option>
                  </select>
                </Field>
                <Field label="주장 시각 (UTC)">
                  <input
                    type="datetime-local"
                    required
                    value={cl.assertedAt}
                    onChange={(e) =>
                      setCl({ ...cl, assertedAt: e.target.value })
                    }
                  />
                </Field>
                <Field label="유효 시작 (UTC, 모르면 비움)">
                  <input
                    type="datetime-local"
                    value={cl.validFrom}
                    onChange={(e) =>
                      setCl({ ...cl, validFrom: e.target.value })
                    }
                  />
                </Field>
                <Field label="유효 종료 (UTC, 미포함)">
                  <input
                    type="datetime-local"
                    value={cl.validTo}
                    onChange={(e) => setCl({ ...cl, validTo: e.target.value })}
                  />
                </Field>
                <Field label="예외 (한 줄에 하나)">
                  <textarea
                    value={cl.exceptions}
                    onChange={(e) =>
                      setCl({ ...cl, exceptions: e.target.value })
                    }
                  />
                </Field>
                <Field label="불확실성·일반화 한계">
                  <textarea
                    required
                    value={cl.uncertainty}
                    onChange={(e) =>
                      setCl({ ...cl, uncertainty: e.target.value })
                    }
                    maxLength={2000}
                  />
                </Field>
                <details>
                  <summary>주장 적용 환경 (고급 JSON)</summary>
                  <textarea
                    aria-label="주장 환경 조건 JSON"
                    value={cl.conditions}
                    onChange={(e) =>
                      setCl({ ...cl, conditions: e.target.value })
                    }
                  />
                </details>
                <Picker
                  label="주장 근거"
                  items={evidenceOptions}
                  selected={cl.evidenceIds}
                  onSelect={(ids) => setCl({ ...cl, evidenceIds: ids })}
                />
                <Picker
                  label="대체 검토할 기존 주장 (양쪽 근거 보존)"
                  items={claimOptions}
                  selected={cl.supersedes}
                  onSelect={(ids) => setCl({ ...cl, supersedes: ids })}
                />
                {canReview && (
                  <label className="ref-check">
                    <input
                      type="checkbox"
                      checked={cl.protected}
                      onChange={(e) =>
                        setCl({ ...cl, protected: e.target.checked })
                      }
                    />
                    인간 보호 사실로 등록 (서버 권한 재검사)
                  </label>
                )}
                <button type="submit" disabled={!cl.evidenceIds.length}>
                  주장 후보 제출
                </button>
              </fieldset>
            </form>
          </details>
          <details>
            <summary>성공·실패 경험 등록</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  async () => {
                    const selected = context.items.filter((c) =>
                      out.claimIds.includes(c.id),
                    );
                    if (!selected.length)
                      throw Error("사용한 주장을 선택하세요.");
                    const body = {
                      ...out,
                      conditions: parseConditions(out.conditions),
                      usedVersions: [
                        ...new Map(
                          selected.map((c) => [
                            `${c.pageId}:${c.pageVersion}`,
                            { pageId: c.pageId, version: c.pageVersion },
                          ]),
                        ).values(),
                      ],
                    };
                    await api.post<OutcomeView>("/refinement/outcomes", {
                      ...body,
                      id: mutationId("outcome", body),
                    });
                    return load();
                  },
                  (data) => {
                    loaded(data);
                    setMessage(
                      "성과 관찰과 재검토 요청을 등록했습니다. 성공 선언은 독립 검증/공식 발행이 아닙니다.",
                    );
                  },
                  true,
                );
              }}
            >
              <fieldset disabled={busy}>
                <legend>조건부 경험·성과 관찰</legend>
                <Picker
                  label="실제로 사용한 주장·버전"
                  items={claimOptions}
                  selected={out.claimIds}
                  onSelect={(ids) => setOut({ ...out, claimIds: ids })}
                />
                <Field label="보고한 결과">
                  <select
                    value={out.result}
                    onChange={(e) => setOut({ ...out, result: e.target.value })}
                  >
                    <option value="unknown">미확인</option>
                    <option value="success">성공 주장</option>
                    <option value="partial">부분 성공 주장</option>
                    <option value="failure">실패 관찰</option>
                  </select>
                </Field>
                {(
                  [
                    ["problem", "문제"],
                    ["attempt", "실제 시도"],
                    ["observations", "성과 관찰"],
                    ["lesson", "조건부 교훈 후보"],
                    ["limits", "단일 사례·재사용 한계"],
                  ] as const
                ).map(([key, label]) => (
                  <Field key={key} label={label}>
                    <textarea
                      required
                      maxLength={
                        key === "attempt" || key === "observations"
                          ? 10000
                          : 5000
                      }
                      value={out[key]}
                      onChange={(e) =>
                        setOut({ ...out, [key]: e.target.value })
                      }
                    />
                  </Field>
                ))}
                <details>
                  <summary>경험 적용 환경 (고급 JSON)</summary>
                  <textarea
                    aria-label="경험 환경 조건 JSON"
                    value={out.conditions}
                    onChange={(e) =>
                      setOut({ ...out, conditions: e.target.value })
                    }
                  />
                </details>
                <Picker
                  label="성과 근거 (없으면 미확인 상태)"
                  items={evidenceOptions}
                  selected={out.evidenceIds}
                  onSelect={(ids) => setOut({ ...out, evidenceIds: ids })}
                />
                <button type="submit" disabled={!out.claimIds.length}>
                  성과 관찰 제출
                </button>
              </fieldset>
            </form>
          </details>
        </>
      )}
      <section aria-label="성과와 인간 검증">
        <details>
          <summary>
            성과 관찰 · 별도 인간 검증 ({outcomes.length}건 · 25건씩)
          </summary>
          <Pager
            label="성과"
            items={outcomes}
            page={outcomePage}
            onPage={setOutcomePage}
          />
          {refinementPage(outcomes, outcomePage).map((o) => (
            <article key={o.id}>
              <h4>
                {o.id} · {o.result}
              </h4>
              <p>인간 검증: {o.humanValidation} (실행 결과·공식 채택과 별개)</p>
              <p>{o.observations}</p>
              <p>
                {o.lesson} {o.limits}
              </p>
              {o.reviews?.map((r, i) => (
                <p key={i}>
                  별도 검토 이벤트 {r.status} ·{" "}
                  {r.verifiedAt ?? r.recordedAt ?? "시각 미확인"}
                </p>
              ))}
            </article>
          ))}
        </details>
      </section>
      {canReview && (
        <details>
          <summary>독립 인간 검토 기록</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                async () => {
                  const body = {
                    ...(review.target === "claim"
                      ? { claimIds: review.claimIds }
                      : { outcomeId: review.outcomeId }),
                    status: review.status,
                    evidenceIds: review.evidenceIds,
                    reason: review.reason,
                  };
                  await api.post(
                    `/refinement/${review.target === "claim" ? "claim-reviews" : "outcome-reviews"}`,
                    {
                      id: mutationId(`review-${review.target}`, body),
                      ...body,
                    },
                  );
                  return load();
                },
                (data) => {
                  loaded(data);
                  setMessage(
                    "별도 인간 검토 이벤트를 기록했습니다. 원래 주장 시각/유효 기간은 바꾸지 않았으며 자동 발행하지 않았습니다.",
                  );
                },
                true,
              );
            }}
          >
            <fieldset disabled={busy}>
              <legend>독립 검토 (작성자 자기 검토 금지)</legend>
              <Field label="검토 대상 유형">
                <select
                  value={review.target}
                  onChange={(e) =>
                    setReview({
                      ...review,
                      target: e.target.value,
                      status:
                        e.target.value === "claim" ? "reviewed" : "confirmed",
                    })
                  }
                >
                  <option value="claim">주장</option>
                  <option value="outcome">성과 관찰</option>
                </select>
              </Field>
              {review.target === "claim" ? (
                <Picker
                  label="검토할 주장"
                  items={claimOptions}
                  selected={review.claimIds}
                  onSelect={(ids) => setReview({ ...review, claimIds: ids })}
                />
              ) : (
                <Field label="검토할 성과">
                  <select
                    required
                    value={review.outcomeId}
                    onChange={(e) =>
                      setReview({ ...review, outcomeId: e.target.value })
                    }
                  >
                    <option value="">성과 선택</option>
                    {outcomes.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id} · {o.result}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="인간 판단">
                <select
                  value={review.status}
                  onChange={(e) =>
                    setReview({ ...review, status: e.target.value })
                  }
                >
                  {review.target === "claim" ? (
                    <>
                      <option value="reviewed">
                        검토 완료 (진실/실행 검증과 별개)
                      </option>
                      <option value="execution-verified">
                        신뢰 실행 영수증 + 독립 인간 검토
                      </option>
                    </>
                  ) : (
                    <option value="confirmed">
                      관찰 확인 (독립 실행 성공 확정 아님)
                    </option>
                  )}
                  <option value="rejected">반증/반려</option>
                </select>
              </Field>
              <Picker
                label="인간 검토 근거"
                items={evidenceOptions}
                selected={review.evidenceIds}
                onSelect={(ids) => setReview({ ...review, evidenceIds: ids })}
              />
              <Field label="검토 이유·확인 방법">
                <textarea
                  required
                  value={review.reason}
                  onChange={(e) =>
                    setReview({ ...review, reason: e.target.value })
                  }
                  maxLength={5000}
                />
              </Field>
              <p>
                검증 이벤트 시각은 서버에서 새로 기록합니다. 원래
                Claim.verifiedAt을 덮어쓰거나 수정 시각으로 바꾸지 않습니다.
              </p>
              <button
                type="submit"
                disabled={
                  !review.evidenceIds.length ||
                  (review.target === "claim"
                    ? !review.claimIds.length
                    : !review.outcomeId)
                }
              >
                인간 검토 기록 제출
              </button>
            </fieldset>
          </form>
        </details>
      )}
    </section>
  );
}
