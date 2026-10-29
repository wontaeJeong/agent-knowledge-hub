import { createBatch, current, readable, retrieve } from "../domain/wiki";
import type { Answer, Draft } from "../domain/wiki";
import type { State } from "../domain/types";
import { makeId } from "../domain/id";

export async function modelRequest(
  operation: "ingest" | "query",
  context: unknown,
): Promise<unknown> {
  const res = await fetch("/api/model/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, context }),
    signal: AbortSignal.timeout(65_000),
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "모델 요청에 실패했습니다.");
  return data.result;
}
function parseDrafts(data: unknown): Draft[] {
  const updates = (data as { updates?: unknown })?.updates;
  if (!Array.isArray(updates))
    throw Error("모델 응답에 updates 배열이 없습니다.");
  for (const d of updates) {
    if (
      !d ||
      !["id", "title", "summary", "content", "scope"].every(
        (k) => typeof d[k] === "string",
      ) ||
      !["company", "team"].includes(d.scope) ||
      !Number.isInteger(d.baseVersion) ||
      !Array.isArray(d.links) ||
      !d.links.every((x: unknown) => typeof x === "string") ||
      !Array.isArray(d.sourceIds) ||
      !d.sourceIds.every((x: unknown) => typeof x === "string") ||
      !Array.isArray(d.facts) ||
      !d.facts.every(
        (f: Record<string, unknown>) =>
          f &&
          ["key", "context", "value", "sourceId", "quote"].every(
            (k) => typeof f[k] === "string",
          ),
      )
    )
      throw Error("모델 변경안의 스키마가 올바르지 않습니다.");
  }
  return updates as Draft[];
}
export async function compileModel(s: State, sourceIds: string[]) {
  const sources = s.sources.filter(
    (x) => sourceIds.includes(x.id) && x.scope !== "private",
  );
  if (sources.length !== sourceIds.length || !sources.length)
    throw Error("공유할 원본을 선택하세요.");
  const scopes = new Set(sources.map((x) => x.scope));
  const pages = readable(s).filter(
    (p) => scopes.has(p.scope) && p.scope !== "private",
  );
  if (pages.length > 40)
    throw Error(
      "모델 데모는 한 번에 40개 페이지까지 처리합니다. 공간을 나눠주세요.",
    );
  const data = await modelRequest("ingest", {
    sources,
    pages: pages.map((p) => ({
      ...p,
      content: current(p).content,
      baseVersion: current(p).number,
      versions: undefined,
    })),
  });
  return createBatch(s, parseDrafts(data), sourceIds, "model");
}
export async function answerModel(s: State, question: string): Promise<Answer> {
  const pages = retrieve(s, question);
  if (!pages.length)
    return {
      id: makeId(),
      question,
      content: "현재 접근 가능한 위키에서 관련 근거를 찾지 못했습니다.",
      citations: [],
      insufficient: true,
      at: new Date().toISOString(),
      mode: "model",
    };
  const data = (await modelRequest("query", {
    question,
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      version: current(p).number,
      content: current(p).content,
    })),
  })) as Record<string, unknown>;
  if (
    typeof data?.content !== "string" ||
    typeof data.insufficient !== "boolean" ||
    !Array.isArray(data.citations)
  )
    throw Error("모델 답변 형식이 올바르지 않습니다.");
  for (const c of data.citations)
    if (
      !c ||
      typeof c.pageId !== "string" ||
      typeof c.quote !== "string" ||
      typeof c.title !== "string" ||
      !Number.isInteger(c.version)
    )
      throw Error("모델 인용 형식이 올바르지 않습니다.");
  return {
    id: makeId(),
    question,
    content: data.content,
    insufficient: data.insufficient,
    citations: data.citations,
    at: new Date().toISOString(),
    mode: "model",
  };
}
