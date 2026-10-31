import { ApiError, OperationalApi } from "./api";
export interface JobReceipt {
  id: string;
  status: string;
  result?: unknown;
  error_code?: string | null;
  errorCode?: string | null;
  error?: string | null;
}
const statuses = new Set([
  "queued",
  "running",
  "paused",
  "cancel_requested",
  "succeeded",
  "dead",
  "cancelled",
]);
export function isJobReceipt(value: unknown): value is JobReceipt {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.id) &&
    "status" in value &&
    typeof value.status === "string" &&
    statuses.has(value.status)
  );
}
async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted)
    throw Error(
      "결과 대기를 중단했습니다. 서버 작업의 상태·취소 여부는 작업 목록에서 확인하세요.",
    );
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        Error(
          "결과 대기를 중단했습니다. 서버 작업은 작업 목록에서 확인하세요.",
        ),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** A durable acknowledgement is neither a published batch nor a completed model answer. */
export async function resolveJob<T>(
  api: OperationalApi,
  value: unknown,
  options: {
    pollMs?: number;
    maxWaitMs?: number;
    signal?: AbortSignal;
    onProgress?: (job: { id: string; status: string }) => void;
    expectQueued?: boolean;
  } = {},
): Promise<T> {
  if (!isJobReceipt(value)) {
    if (options.expectQueued)
      throw new ApiError(
        "지속 작업 접수 형식을 확인하지 못했습니다. 완료로 표시하지 않았습니다.",
        502,
        "INVALID_JOB_RECEIPT",
      );
    return value as T;
  }
  const id = value.id,
    pollMs = options.pollMs ?? 1000,
    maxWait = options.maxWaitMs ?? 180000;
  if (
    !Number.isSafeInteger(pollMs) ||
    pollMs < 0 ||
    pollMs > 30000 ||
    !Number.isSafeInteger(maxWait) ||
    maxWait < 0 ||
    maxWait > 3600000
  )
    throw Error("잘못된 결과 대기 설정입니다.");
  const until = Date.now() + maxWait;
  options.onProgress?.({ id, status: value.status });
  for (;;) {
    if (options.signal?.aborted)
      throw Error(
        "화면의 결과 대기를 중단했습니다. 서버 작업은 작업 목록에서 확인하세요.",
      );
    const current = await api.get<JobReceipt>(
      `/jobs-v2/${encodeURIComponent(id)}`,
    );
    if (options.signal?.aborted)
      throw Error(
        "이전 화면의 결과 대기를 중단했습니다. 서버 작업은 작업 목록에서 확인하세요.",
      );
    if (!isJobReceipt(current) || current.id !== id)
      throw new ApiError(
        "작업 응답을 확인하지 못했습니다.",
        502,
        "INVALID_JOB_RECEIPT",
      );
    options.onProgress?.({ id, status: current.status });
    if (current.status === "succeeded") {
      if (current.result === undefined || current.result === null)
        throw new ApiError(
          "작업은 종료됐지만 결과가 없습니다. 완료한 답변으로 표시하지 않았습니다.",
          502,
          "EXECUTION_RESULT_UNAVAILABLE",
        );
      return current.result as T;
    }
    if (current.status === "dead" || current.status === "cancelled") {
      const raw = current.error_code ?? current.errorCode ?? current.error;
      const code =
        current.status === "cancelled"
          ? "JOB_CANCELLED"
          : typeof raw === "string" && /^[A-Z0-9_]{1,80}$/.test(raw)
            ? raw
            : "EXECUTION_FAILED";
      throw new ApiError(
        `작업 ${id}이 ${current.status === "cancelled" ? "취소" : "실패"}했습니다. (${code})`,
        current.status === "cancelled" ? 409 : 502,
        code,
      );
    }
    if (Date.now() >= until)
      throw new ApiError(
        "화면의 결과 대기 시간을 넘었습니다. 서버 작업의 완료·실패·취소 상태를 작업 목록에서 확인하세요.",
        504,
        "POLL_TIMEOUT",
      );
    await delay(pollMs, options.signal);
  }
}
