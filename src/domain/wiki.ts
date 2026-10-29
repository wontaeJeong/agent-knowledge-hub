import type { Page, Source, State } from "./types";
import { makeId } from "./id";

export const POLICY_VERSION = "agent-knowledge-hub/2";
export type Mode = "offline" | "model";
export interface Fact {
  key: string;
  context: string;
  value: string;
  sourceId: string;
  quote: string;
}
export interface Draft {
  id: string;
  title: string;
  summary: string;
  content: string;
  scope: Page["scope"];
  links: string[];
  sourceIds: string[];
  facts: Fact[];
  baseVersion: number;
}
export interface Batch {
  id: string;
  title: string;
  mode: Mode;
  createdAt: string;
  policyVersion: string;
  status: "pending" | "approved" | "published" | "rejected" | "conflict";
  updates: Draft[];
  snapshots: Source[];
  baseSnapshots: Record<string, string>;
  reason: string;
  answerId?: string;
  approvedFingerprint?: string;
}
export interface Citation {
  pageId: string;
  version: number;
  title: string;
  quote: string;
}
export interface Answer {
  id: string;
  question: string;
  content: string;
  citations: Citation[];
  at: string;
  mode: Mode;
  insufficient: boolean;
  filedBatchId?: string;
}
export interface Issue {
  id: string;
  kind:
    "broken-link" | "orphan" | "stale" | "contradiction" | "missing-evidence";
  pageIds: string[];
  detail: string;
}
export interface Knowledge {
  batches: Batch[];
  answers: Answer[];
  issues: Issue[];
  lintAt?: string;
}
export const memory = (s: State): Knowledge =>
  s.knowledge ?? { batches: [], answers: [], issues: [] };
export const current = (p: Page) => p.versions[p.versions.length - 1];
export const readable = (s: State) =>
  s.pages.filter((p) => s.role !== "reader" || p.scope === "company");
const writable = (s: State) => {
  if (s.role === "reader") throw Error("독자 역할에서는 변경할 수 없습니다.");
};
const stamp = () => new Date().toISOString();
const actor = (s: State) =>
  s.role === "reviewer" ? "김민서" : s.role === "editor" ? "이도윤" : "박서연";
function record(s: State, kind: string, detail: string): State {
  return {
    ...s,
    audit: [
      { id: makeId(), at: stamp(), actor: actor(s), kind, detail },
      ...s.audit,
    ],
  };
}
export const draftOf = (p: Page): Draft => ({
  id: p.id,
  title: p.title,
  summary: p.summary,
  content: current(p).content,
  scope: p.scope,
  links: p.links ?? [],
  sourceIds: current(p).sourceIds,
  facts: p.facts ?? [],
  baseVersion: current(p).number,
});
const stableId = (text: string) => {
  let n = 2166136261;
  for (const char of text) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  return `concept-${(n >>> 0).toString(16)}`;
};
const snapshot = (p: Page) =>
  JSON.stringify([p.title, p.summary, p.scope, p.links, p.facts, current(p)]);
const fingerprint = (b: Batch) =>
  JSON.stringify([b.updates, b.snapshots, b.baseSnapshots, b.policyVersion]);
const factsFrom = (text: string, sourceId: string): Fact[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*[-*]?\s*사실:\s*([^|]+)\|([^|]+)\|(.+)$/.exec(line);
    return m
      ? [
          {
            key: m[1].trim(),
            context: m[2].trim(),
            value: m[3].trim(),
            sourceId,
            quote: line.trim(),
          },
        ]
      : [];
  });

/** Offline compiler is deliberately explicit: headings and fact records are a small input language, not semantic LLM extraction. */
export function compileOffline(s: State, sourceIds: string[]): Draft[] {
  writable(s);
  const sources = sourceIds.map((id) => s.sources.find((x) => x.id === id));
  if (!sources.length || sources.some((x) => !x || x.scope === "private"))
    throw Error("공유 가능한 원본을 선택하세요.");
  const updates = new Map<string, Draft>();
  const get = (id: string) =>
    updates.get(id) ??
    (s.pages.find((p) => p.id === id)
      ? draftOf(s.pages.find((p) => p.id === id)!)
      : undefined);
  for (const src of sources as Source[]) {
    const parent = get(src.targetPageId);
    if (!parent || parent.scope !== src.scope)
      throw Error("원본과 대상 지식의 공유 범위를 맞추세요.");
    const sections = [
      ...src.content.matchAll(
        /^## 지식:\s*(.+)\n([\s\S]*?)(?=^## 지식:|(?![\s\S]))/gm,
      ),
    ];
    const parts = sections.length
      ? sections.map((m) => ({ title: m[1].trim(), body: m[2].trim() }))
      : [{ title: src.title, body: src.content.trim() }];
    const links: string[] = [];
    for (const part of parts) {
      const cid = stableId(`${src.scope}:${part.title}`);
      const old = get(cid);
      // Only the named source section is replaced on re-ingest; other sources and human text survive.
      const marker = `<!-- source:${src.id} -->`;
      const end = `<!-- /source:${src.id} -->`;
      const quote = `### ${src.title}\n${marker}\n${part.body}\n${end}\n\n근거: 원본 ${src.id} · ${src.verification}`;
      let content =
        old?.content ?? `## 적용 지식\n${part.title}\n\n## 근거별 기록\n`;
      const start = content.indexOf(marker),
        stop = content.indexOf(end);
      if (start >= 0 && stop >= start)
        content =
          content.slice(0, start) +
          `${marker}\n${part.body}\n${end}` +
          content.slice(stop + end.length);
      else content += `\n\n${quote}`;
      updates.set(cid, {
        id: cid,
        title: part.title,
        summary: part.body.replace(/^[-#*]\s*/gm, "").slice(0, 130),
        content,
        scope: src.scope,
        links: [...new Set([...(old?.links ?? []), parent.id])],
        sourceIds: [...new Set([...(old?.sourceIds ?? []), src.id])],
        facts: [
          ...(old?.facts ?? []).filter((f) => f.sourceId !== src.id),
          ...factsFrom(part.body, src.id),
        ],
        baseVersion: old?.baseVersion ?? 0,
      });
      links.push(cid);
    }
    const allLinks = [...new Set([...parent.links, ...links])];
    const indexMarker = "\n\n<!-- compiled-index -->";
    const body = parent.content.split(indexMarker)[0];
    updates.set(parent.id, {
      ...parent,
      links: allLinks,
      sourceIds: [...new Set([...parent.sourceIds, src.id])],
      content: `${body}${indexMarker}\n## 연결된 적용 지식\n${allLinks
        .map((id) => {
          const p = get(id)!;
          return `- [${p.title}](#/wiki/${id}) — ${p.summary}`;
        })
        .join(
          "\n",
        )}\n\n각 사례의 적용 조건과 검증 상태는 연결된 지식과 원본에서 확인하세요.`,
    });
  }
  return [...updates.values()];
}

export function createBatch(
  s: State,
  updates: Draft[],
  sourceIds: string[],
  mode: Mode,
  title = "자료 편입",
  answerId?: string,
): Batch {
  writable(s);
  const sources = sourceIds.map((id) => s.sources.find((x) => x.id === id));
  if (sources.some((x) => !x || x.scope === "private"))
    throw Error("접근할 수 없는 원본입니다.");
  if (
    !updates.length ||
    updates.length > 20 ||
    new Set(updates.map((x) => x.id)).size !== updates.length
  )
    throw Error("변경 집합이 비어 있거나 중복·상한을 초과했습니다.");
  const allIds = new Set([
    ...s.pages.map((x) => x.id),
    ...updates.map((x) => x.id),
  ]);
  for (const d of updates) {
    const p = s.pages.find((x) => x.id === d.id);
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(d.id) ||
      !d.title?.trim() ||
      !d.content?.trim() ||
      d.content.length > 100_000
    )
      throw Error("지식 ID·제목·본문 형식을 확인하세요.");
    if (
      (p && (d.baseVersion !== current(p).number || d.scope !== p.scope)) ||
      (!p && d.baseVersion !== 0)
    )
      throw Error("기준 버전 또는 공유 범위가 다릅니다.");
    if (
      !d.sourceIds.length ||
      sourceIds.some((id) => !s.sources.some((x) => x.id === id))
    )
      throw Error("원본 근거가 필요합니다.");
    for (const id of d.sourceIds) {
      const src = s.sources.find((x) => x.id === id);
      if (!src || src.scope !== d.scope || src.scope === "private")
        throw Error(
          "원본 범위를 넓히거나 존재하지 않는 근거를 사용할 수 없습니다.",
        );
    }
    if (d.links.some((id) => !allIds.has(id) || id === d.id))
      throw Error("연결 대상이 없거나 자기 자신입니다.");
    if (
      d.links.some((id) => {
        const target =
          updates.find((x) => x.id === id) ?? s.pages.find((x) => x.id === id);
        return target?.scope !== d.scope;
      })
    )
      throw Error("다른 공개 범위의 지식을 자동 연결할 수 없습니다.");
    for (const fact of d.facts) {
      const src = s.sources.find((x) => x.id === fact.sourceId);
      if (
        !d.sourceIds.includes(fact.sourceId) ||
        !src ||
        !fact.quote ||
        !src.content.includes(fact.quote)
      )
        throw Error("사실의 인용이 원본에 없습니다.");
    }
  }
  const snapshots = s.sources.filter(
    (x) =>
      sourceIds.includes(x.id) ||
      updates.some((d) => d.sourceIds.includes(x.id)),
  );
  return {
    id: makeId(),
    title,
    mode,
    createdAt: stamp(),
    policyVersion: POLICY_VERSION,
    status: "pending",
    updates,
    snapshots: structuredClone(snapshots),
    baseSnapshots: Object.fromEntries(
      updates.flatMap((d) => {
        const p = s.pages.find((x) => x.id === d.id);
        return p ? [[p.id, snapshot(p)]] : [];
      }),
    ),
    reason:
      mode === "model"
        ? "연결된 모델이 기존 위키와 원본을 종합한 변경 제안"
        : "제목·구조화 사실을 읽은 오프라인 편입 결과 · 의미 추론 없음",
    answerId,
  };
}
export function enqueueBatch(s: State, batch: Batch): State {
  writable(s);
  createBatch(
    s,
    batch.updates,
    batch.snapshots.map((x) => x.id),
    batch.mode,
  );
  if (
    Object.entries(batch.baseSnapshots).some(([id, base]) => {
      const p = s.pages.find((p) => p.id === id);
      return !p || snapshot(p) !== base;
    })
  )
    throw Error("참조한 지식이 변경됐습니다. 다시 실행하세요.");
  if (
    batch.snapshots.some(
      (src) =>
        JSON.stringify(src) !==
        JSON.stringify(s.sources.find((x) => x.id === src.id)),
    )
  )
    throw Error("모델 실행 중 원본이 변경됐습니다. 다시 편입하세요.");
  const k = memory(s);
  if (
    k.batches.some(
      (b) =>
        ["pending", "approved"].includes(b.status) &&
        b.updates.some((d) => batch.updates.some((x) => x.id === d.id)),
    )
  )
    throw Error(
      "같은 지식에 대기 중인 변경 집합이 있습니다. 먼저 발행하거나 반려하세요.",
    );
  return record(
    {
      ...s,
      knowledge: {
        ...k,
        batches: [batch, ...k.batches],
        answers: k.answers.map((a) =>
          a.id === batch.answerId ? { ...a, filedBatchId: batch.id } : a,
        ),
      },
    },
    "ingest · 변경 집합 생성",
    `${batch.updates.length}개 페이지 · ${batch.id}`,
  );
}
export function decideBatch(
  s: State,
  id: string,
  action: "approve" | "publish" | "reject",
): State {
  if (s.role !== "reviewer") throw Error("검토자만 승인·발행할 수 있습니다.");
  const k = memory(s),
    b = k.batches.find((x) => x.id === id);
  if (!b) throw Error("변경 집합이 없습니다.");
  if (action === "publish" && b.status === "published") return s;
  if (!["pending", "approved"].includes(b.status))
    throw Error("검토 가능한 변경 집합이 아닙니다.");
  let status: Batch["status"] =
    action === "reject"
      ? "rejected"
      : action === "approve"
        ? "approved"
        : "published";
  if (action === "approve" && b.status !== "pending")
    throw Error("이미 승인된 변경입니다.");
  if (action === "publish" && b.status !== "approved")
    throw Error("승인한 변경만 발행할 수 있습니다.");
  if (action !== "reject") {
    const stale =
      (action === "publish" && b.approvedFingerprint !== fingerprint(b)) ||
      b.policyVersion !== POLICY_VERSION ||
      Object.entries(b.baseSnapshots).some(([id, base]) => {
        const p = s.pages.find((p) => p.id === id);
        return !p || snapshot(p) !== base;
      }) ||
      b.snapshots.some(
        (src) =>
          JSON.stringify(src) !==
          JSON.stringify(s.sources.find((x) => x.id === src.id)),
      ) ||
      b.updates.some((d) => {
        const p = s.pages.find((x) => x.id === d.id);
        return p ? snapshot(p) !== b.baseSnapshots[p.id] : d.baseVersion !== 0;
      });
    if (stale) status = "conflict";
    else
      createBatch(
        s,
        b.updates,
        b.snapshots.map((x) => x.id),
        b.mode,
      ); // Recheck scope and source references.
  }
  let pages = s.pages;
  if (status === "published") {
    const replacements = b.updates.map((d) => {
      const p = pages.find((x) => x.id === d.id);
      return {
        id: d.id,
        title: d.title,
        summary: d.summary,
        category: p?.category ?? "연결된 지식",
        scope: d.scope,
        status: "팀 검토" as const,
        owner: p?.owner ?? "플랫폼팀",
        tags: p?.tags ?? ["위키 편입"],
        favorite: p?.favorite ?? false,
        reused: p?.reused ?? 0,
        links: d.links,
        facts: d.facts,
        verifiedAt: p?.verifiedAt,
        versions: [
          ...(p?.versions ?? []),
          {
            id: makeId(),
            number: d.baseVersion + 1,
            content: d.content,
            author: actor(s),
            reason: b.title,
            at: stamp(),
            sourceIds: d.sourceIds,
          },
        ],
      };
    });
    pages = [
      ...pages.filter((p) => !replacements.some((x) => x.id === p.id)),
      ...replacements,
    ];
  }
  return record(
    {
      ...s,
      pages,
      sources:
        status === "published"
          ? s.sources.map((src) =>
              b.snapshots.some((x) => x.id === src.id)
                ? { ...src, processed: true }
                : src,
            )
          : s.sources,
      knowledge: {
        ...k,
        batches: k.batches.map((x) =>
          x.id === id
            ? {
                ...x,
                status,
                approvedFingerprint:
                  action === "approve" && status === "approved"
                    ? fingerprint(b)
                    : x.approvedFingerprint,
              }
            : x,
        ),
      },
    },
    `변경 집합 · ${status}`,
    `${b.title} · ${b.updates.length}개 페이지`,
  );
}

const tokens = (text: string) => [
  ...new Set(text.toLowerCase().match(/[a-z0-9_]+|[가-힣]{2,}/g) ?? []),
];
export function retrieve(s: State, question: string): Page[] {
  const terms = tokens(question);
  return readable(s)
    .map((p) => {
      const hay = `${p.title} ${p.summary} ${current(p).content}`.toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + (hay.includes(term) ? 1 : 0),
        0,
      );
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((x) => x.p);
}
export function answerOffline(s: State, question: string): Answer {
  if (!question.trim()) throw Error("질문을 입력하세요.");
  const pages = retrieve(s, question);
  const citations = pages.map((p) => ({
    pageId: p.id,
    version: current(p).number,
    title: p.title,
    quote: current(p).content.slice(0, 900),
  }));
  // Exact extracts, rather than fabricated semantic answers. Citation quotes are validated before filing.
  return {
    id: makeId(),
    question,
    mode: "offline",
    at: stamp(),
    insufficient: !citations.length,
    citations,
    content: citations.length
      ? `관련 발행본에서 찾은 내용입니다. 아래는 원문 발췌이며, 질문에 대한 의미 추론은 모델 연결 모드에서 수행합니다.\n\n${citations.map((c, i) => `### [${i + 1}] ${c.title}\n${c.quote}\n\n[발행본 v${c.version}](#/snapshot/${c.pageId}/${c.version})`).join("\n\n")}`
      : "현재 접근 가능한 위키에서 관련 근거를 찾지 못했습니다. 자료를 추가하거나 질문에 프로젝트·기술 이름을 포함하세요.",
  };
}
export function saveAnswer(s: State, a: Answer): State {
  const allowed = readable(s);
  for (const c of a.citations) {
    const p = allowed.find((x) => x.id === c.pageId),
      v = p?.versions.find((v) => v.number === c.version);
    if (!v || !c.quote || !v.content.includes(c.quote))
      throw Error("답변 인용이 실제 발행본에 없습니다.");
  }
  if (!a.insufficient && !a.citations.length)
    throw Error("답변에는 발행본 인용이 필요합니다.");
  return record(
    { ...s, knowledge: { ...memory(s), answers: [a, ...memory(s).answers] } },
    "query · 답변",
    a.question,
  );
}
export function fileAnswer(s: State, answerId: string): State {
  writable(s);
  const a = memory(s).answers.find((x) => x.id === answerId);
  if (!a || a.insufficient || !a.citations.length)
    throw Error("근거 있는 답변만 편입할 수 있습니다.");
  if (
    a.filedBatchId &&
    !["rejected", "conflict"].includes(
      memory(s).batches.find((b) => b.id === a.filedBatchId)?.status ?? "",
    )
  )
    throw Error("이미 편입된 답변입니다.");
  const refs = a.citations.map((c) => {
    const p = readable(s).find((x) => x.id === c.pageId);
    if (!p || current(p).number !== c.version)
      throw Error("인용한 지식이 변경됐습니다. 질문을 다시 실행하세요.");
    return p;
  });
  const scopes = new Set(refs.map((p) => p.scope));
  if (scopes.size !== 1 || scopes.has("private"))
    throw Error("같은 공유 범위의 지식으로만 답변을 편입할 수 있습니다.");
  const sourceIds = [...new Set(refs.flatMap((p) => current(p).sourceIds))];
  if (!sourceIds.length || refs.some((p) => !current(p).sourceIds.length))
    throw Error(
      "원본 근거가 없는 인용 문서가 있습니다. 원본을 먼저 연결하세요.",
    );
  const id = `answer-${a.id}`;
  const d: Draft = {
    id,
    title: a.question,
    summary: "질문에서 축적된 분석 · 인용 버전 보존",
    scope: refs[0].scope,
    content: `## 질문\n${a.question}\n\n## 답변\n${a.content}\n\n## 인용 기준\n${a.citations.map((c) => `- ${c.title} · v${c.version}`).join("\n")}\n\n이 페이지는 질문의 파생 결과이며 독립적인 검증 증거가 아닙니다.`,
    links: refs.map((p) => p.id),
    sourceIds,
    facts: [],
    baseVersion: 0,
  };
  const batch = createBatch(
    s,
    [d],
    sourceIds,
    a.mode,
    "질문 결과의 위키 편입",
    a.id,
  );
  for (const p of refs) batch.baseSnapshots[p.id] = snapshot(p);
  return enqueueBatch(s, batch);
}
export function lintWiki(s: State, now = new Date()): Issue[] {
  const pages = readable(s),
    ids = new Set(pages.map((p) => p.id));
  const issues: Issue[] = [];
  const add = (kind: Issue["kind"], pageIds: string[], detail: string) =>
    issues.push({
      id: `${kind}:${pageIds.join(":")}:${issues.length}`,
      kind,
      pageIds,
      detail,
    });
  const inbound = new Set(pages.flatMap((p) => p.links ?? []));
  for (const p of pages) {
    const markdownLinks = [
      ...current(p).content.matchAll(/\]\(#\/wiki\/([a-zA-Z0-9_-]+)\)/g),
    ].map((m) => m[1]);
    for (const id of new Set([...(p.links ?? []), ...markdownLinks]))
      if (!ids.has(id) && !s.pages.some((x) => x.id === id))
        add("broken-link", [p.id], `존재하지 않는 문서 연결: ${id}`);
    if (!inbound.has(p.id) && !(p.links ?? []).length)
      add(
        "orphan",
        [p.id],
        "다른 지식과 연결되지 않았습니다. 관련 주제 연결을 검토하세요.",
      );
    if (
      !p.verifiedAt ||
      !Number.isFinite(Date.parse(p.verifiedAt)) ||
      now.getTime() - Date.parse(p.verifiedAt) > 90 * 86400000
    )
      add(
        "stale",
        [p.id],
        p.verifiedAt
          ? "마지막 검증 후 90일이 지났습니다."
          : "검증 시점이 없습니다. 최신 수정 시점과 검증은 다릅니다.",
      );
    if (
      !current(p).sourceIds.length ||
      current(p).sourceIds.some((id) => !s.sources.some((src) => src.id === id))
    )
      add("missing-evidence", [p.id], "발행본의 원본 근거가 없습니다.");
  }
  const facts = pages.flatMap((p) => (p.facts ?? []).map((f) => ({ p, f })));
  for (let i = 0; i < facts.length; i++)
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i],
        b = facts[j];
      if (
        a.f.key === b.f.key &&
        a.f.context === b.f.context &&
        a.f.value !== b.f.value
      )
        add(
          "contradiction",
          [...new Set([a.p.id, b.p.id])],
          `동일 조건의 상충 기록: ${a.f.key} / ${a.f.context} → “${a.f.value}” ↔ “${b.f.value}”. 원본 ${a.f.sourceId}, ${b.f.sourceId} 확인 필요.`,
        );
    }
  return issues.sort(
    (a, b) =>
      (a.kind === "contradiction" ? 0 : a.kind === "broken-link" ? 1 : 2) -
      (b.kind === "contradiction" ? 0 : b.kind === "broken-link" ? 1 : 2),
  );
}
export function runLint(s: State): State {
  writable(s);
  const issues = lintWiki(s);
  return record(
    { ...s, knowledge: { ...memory(s), issues, lintAt: stamp() } },
    "lint · 주간 점검",
    `${issues.length}개 실제 규칙 점검 결과 · 의미 충돌 추론은 모델 영역`,
  );
}
