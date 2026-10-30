import type { UsageSummary } from "../domain/usage";

export function validateUsage(value: unknown): UsageSummary {
  const bad = () => {
    throw Error("사용량 응답 형식이 올바르지 않습니다.");
  };
  if (!value || typeof value !== "object") return bad();
  const d = value as UsageSummary;
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (
    !["self", "workspace"].includes(d.scope) ||
    d.timezone !== "UTC" ||
    !Number.isFinite(Date.parse(d.from)) ||
    !Number.isFinite(Date.parse(d.to)) ||
    Date.parse(d.from) > Date.parse(d.to) ||
    ![d.total, d.succeeded, d.failed, d.activeUsers, d.publications].every(
      count,
    ) ||
    d.total !== d.succeeded + d.failed ||
    d.activeUsers > d.total ||
    !Array.isArray(d.daily) ||
    d.daily.length > 90 ||
    !d.daily.every(
      (r) =>
        r &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.day) &&
        Number.isFinite(Date.parse(r.day)) &&
        count(r.succeeded) &&
        count(r.failed),
    ) ||
    !Array.isArray(d.operations) ||
    !d.operations.every(
      (r) =>
        r &&
        typeof r.operation === "string" &&
        count(r.total) &&
        count(r.failed) &&
        r.failed <= r.total &&
        Number.isFinite(r.averageDurationMs) &&
        r.averageDurationMs >= 0,
    ) ||
    !d.model ||
    ![d.model.inputTokens,d.model.outputTokens,d.model.cost,d.model.cacheReadTokens,d.model.cacheWriteTokens].every(v=>v===undefined||v===null||(typeof v==="number"&&Number.isFinite(v)&&v>=0)) ||
    ![d.model.calls,d.model.failed,d.model.measuredCalls,d.model.outputMeasuredCalls,d.model.pricedCalls].every(v=>v===undefined||count(v)) ||
    (d.model.byProvider!==undefined&&(!Array.isArray(d.model.byProvider)||!d.model.byProvider.every(g=>g&&typeof g.model==="string"&&typeof g.provider==="string"&&typeof g.backend==="string"&&count(g.calls)&&count(g.failed)&&count(g.measuredCalls)&&count(g.pricedCalls)&&[g.inputTokens,g.outputTokens,g.cacheReadTokens,g.cacheWriteTokens,g.cost].every(n=>n===null||(typeof n==="number"&&Number.isFinite(n)&&n>=0)))) )
  )
    return bad();
  return d;
}
export async function loadUsage(
  days: number,
  signal?: AbortSignal,
): Promise<UsageSummary> {
  const response = await fetch(`/api/v1/usage?days=${days}`, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw Error(
      "사용량 서버에 연결할 수 없습니다. 인증된 서버 연결을 확인하세요.",
    );
  return validateUsage(await response.json());
}
