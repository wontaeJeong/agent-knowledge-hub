import type { Action, State, Page, Change } from "./types";
import { makeId } from "./id";
const now = () => new Date().toISOString();
const id = makeId;
export const latest = (p: Page) => p.versions[p.versions.length - 1];
export const canReview = (s: State) => s.role === "reviewer";
export const canWrite = (s: State) => s.role !== "reader";
export function visiblePages(s: State) {
  return s.pages.filter((p) => s.role !== "reader" || p.scope === "company");
}
export function visibleSources(s: State) {
  return s.sources.filter((p) => s.role !== "reader" || p.scope === "company");
}
function audit(s: State, kind: string, detail: string): State {
  return {
    ...s,
    audit: [
      {
        id: id(),
        at: now(),
        actor:
          s.role === "reviewer"
            ? "검토자 · 김민서"
            : s.role === "editor"
              ? "작성자 · 이도윤"
              : "독자 · 박서연",
        kind,
        detail,
      },
      ...s.audit,
    ],
  };
}
export function reduce(s: State, a: Action): State {
  if (a.type === "ROLE") return { ...s, role: a.role };
  if (a.type === "FAVORITE")
    return {
      ...s,
      pages: s.pages.map((p) =>
        p.id === a.id ? { ...p, favorite: !p.favorite } : p,
      ),
    };
  if (a.type === "FEEDBACK")
    return audit(
      {
        ...s,
        pages: s.pages.map((p) =>
          p.id === a.id
            ? { ...p, reused: p.reused + (a.result === "해결됨" ? 1 : 0) }
            : p,
        ),
      },
      "재사용 피드백",
      `${s.pages.find((p) => p.id === a.id)?.title} · ${a.result}`,
    );
  if (!canWrite(s)) throw new Error("독자 역할에서는 변경할 수 없습니다.");
  if (a.type === "ADD_SOURCE") {
    if (!s.pages.some((p) => p.id === a.source.targetPageId))
      throw new Error("연결할 페이지를 선택하세요.");
    const page = s.pages.find((p) => p.id === a.source.targetPageId)!;
    if (page.scope === "company" && a.source.scope !== "company")
      throw new Error(
        "전사 문서에 제한 자료를 자동 통합할 수 없습니다. 같은 범위의 페이지를 선택하세요.",
      );
    if (!a.source.content.trim() || !a.source.title.trim())
      throw new Error("제목과 내용을 입력하세요.");
    return audit(
      { ...s, sources: [a.source, ...s.sources] },
      "산출물 등록",
      a.source.title,
    );
  }
  if (a.type === "RUN") {
    const inputs = s.sources.filter(
      (x) => !x.processed && x.scope !== "private",
    );
    const changes: Change[] = [];
    for (const pageId of [...new Set(inputs.map((x) => x.targetPageId))]) {
      const p = s.pages.find((x) => x.id === pageId)!;
      const sources = inputs.filter((x) => x.targetPageId === pageId);
      const current = latest(p);
      if (
        s.changes.some(
          (c) =>
            c.pageId === p.id && ["pending", "approved"].includes(c.status),
        )
      )
        continue;
      const after =
        current.content +
        sources
          .map(
            (src, i) =>
              `\n\n## 추가 사례 · ${src.title}\n${src.content}\n\n[근거 ${current.sourceIds.length + i + 1}] ${src.verification} · ${src.project}`,
          )
          .join("");
      changes.push({
        id: id(),
        title: `${p.title} 보완`,
        pageId: p.id,
        baseVersion: current.number,
        sourceIds: sources.map((x) => x.id),
        before: current.content,
        after,
        reason:
          "새 산출물의 적용 조건과 확인 결과를 기존 가이드에 연결합니다. 규칙 기반 데모 제안이며 의미 검증을 수행하지 않습니다.",
        status: "pending",
        createdAt: now(),
      });
    }
    const used = new Set(changes.flatMap((x) => x.sourceIds));
    const run = {
      id: id(),
      kind: a.kind,
      at: now(),
      sources: used.size,
      changes: changes.length,
      mode: "deterministic-demo" as const,
      issues:
        a.kind === "Weekly"
          ? [
              "개인 실험 메모는 공유 범위에서 제외했습니다.",
              "모델 기반 의미 충돌 탐지는 프로덕션 로드맵 항목입니다.",
            ]
          : [],
    };
    return audit(
      {
        ...s,
        sources: s.sources.map((x) =>
          used.has(x.id) ? { ...x, processed: true } : x,
        ),
        changes: [...changes, ...s.changes],
        runs: [run, ...s.runs],
      },
      `${a.kind} 점검`,
      `${used.size}개 산출물 · ${changes.length}개 변경안 생성`,
    );
  }
  if (a.type === "APPROVE" || a.type === "REJECT" || a.type === "PUBLISH") {
    if (!canReview(s)) throw new Error("검토자 역할이 필요합니다.");
    const c = s.changes.find((x) => x.id === a.id);
    if (!c) throw new Error("변경안을 찾을 수 없습니다.");
    if (a.type === "PUBLISH" && c.status === "published") return s;
    const p = s.pages.find((x) => x.id === c.pageId)!;
    if (a.type === "REJECT") {
      if (!["pending", "approved"].includes(c.status))
        throw new Error("검토 중인 변경안만 반려할 수 있습니다.");
      return audit(
        {
          ...s,
          changes: s.changes.map((x) =>
            x.id === c.id ? { ...x, status: "rejected" } : x,
          ),
        },
        "변경 반려",
        c.title,
      );
    }
    if (latest(p).number !== c.baseVersion)
      return audit(
        {
          ...s,
          changes: s.changes.map((x) =>
            x.id === c.id ? { ...x, status: "conflict" } : x,
          ),
        },
        "충돌 감지",
        "기준 버전이 변경되어 발행을 차단했습니다.",
      );
    if (a.type === "APPROVE") {
      if (c.status !== "pending")
        throw new Error("검토 대기 중인 변경안만 승인할 수 있습니다.");
      return audit(
        {
          ...s,
          changes: s.changes.map((x) =>
            x.id === c.id ? { ...x, status: "approved", approvedAt: now() } : x,
          ),
        },
        "변경 승인",
        c.title,
      );
    }
    if (c.status !== "approved") throw new Error("승인 후 발행할 수 있습니다.");
    const refs = [...new Set([...latest(p).sourceIds, ...c.sourceIds])];
    if (
      p.scope === "company" &&
      refs.some(
        (ref) => s.sources.find((x) => x.id === ref)?.scope !== "company",
      )
    )
      throw new Error("원본 공개 범위를 다시 확인하세요.");
    return audit(
      {
        ...s,
        pages: s.pages.map((x) =>
          x.id === p.id
            ? {
                ...x,
                versions: [
                  ...x.versions,
                  {
                    id: id(),
                    number: latest(x).number + 1,
                    content: c.after,
                    author: "김민서",
                    reason: c.title,
                    at: now(),
                    sourceIds: refs,
                  },
                ],
              }
            : x,
        ),
        changes: s.changes.map((x) =>
          x.id === c.id ? { ...x, status: "published" } : x,
        ),
      },
      "지식 발행",
      `${p.title} · v${latest(p).number + 1}`,
    );
  }
  if (a.type === "SAVE_PAGE" || a.type === "RESTORE") {
    const p = s.pages.find((x) => x.id === a.id);
    if (!p) throw new Error("문서를 찾을 수 없습니다.");
    const v = latest(p);
    if (a.type === "SAVE_PAGE" && v.number !== a.baseVersion)
      throw new Error("다른 변경이 먼저 저장됐습니다. 최신 버전을 확인하세요.");
    if (p.status === "공식 기준" && !canReview(s))
      throw new Error("공식 문서는 검토자만 수정할 수 있습니다.");
    if (a.type === "RESTORE" && !canReview(s))
      throw new Error("복원은 검토자만 수행할 수 있습니다.");
    const source =
      a.type === "RESTORE" ? p.versions.find((x) => x.number === a.version) : v;
    if (!source) throw new Error("버전을 찾을 수 없습니다.");
    return audit(
      {
        ...s,
        pages: s.pages.map((x) =>
          x.id === p.id
            ? {
                ...x,
                versions: [
                  ...x.versions,
                  {
                    ...source,
                    id: id(),
                    number: v.number + 1,
                    content:
                      a.type === "SAVE_PAGE" ? a.content : source.content,
                    reason:
                      a.type === "RESTORE"
                        ? `v${a.version}에서 복원`
                        : "수동 편집 · 데모 즉시 발행",
                    author: s.role === "reviewer" ? "김민서" : "이도윤",
                    at: now(),
                  },
                ],
              }
            : x,
        ),
      },
      a.type === "RESTORE" ? "버전 복원" : "문서 편집",
      p.title,
    );
  }
  if (a.type === "SHARE")
    return audit(
      { ...s, shares: [a.share, ...s.shares] },
      "공유 링크 생성",
      "이 브라우저 데모 상태 안에서 유효한 링크를 생성했습니다.",
    );
  if (a.type === "REVOKE_SHARE")
    return audit(
      {
        ...s,
        shares: s.shares.map((x) =>
          x.id === a.id ? { ...x, revoked: true } : x,
        ),
      },
      "공유 철회",
      a.id,
    );
  if (a.type === "SCHEDULE")
    return audit(
      {
        ...s,
        schedule: { daily: a.daily, weekly: a.weekly, enabled: a.enabled },
      },
      "일정 설정",
      "데모 설정만 저장했습니다. 브라우저 밖에서 실행하지 않습니다.",
    );
  return s;
}
export function resolveShare(s: State, token: string) {
  const share = s.shares.find((x) => x.id === token);
  if (!share || share.revoked || Date.parse(share.expiresAt) <= Date.now())
    return null;
  const page = visiblePages(s).find((x) => x.id === share.pageId);
  if (!page) return null;
  const version = share.version
    ? page.versions.find((v) => v.number === share.version)
    : latest(page);
  return version ? { page, version } : null;
}
