import type { Source } from "../domain/types";
import type { Draft, Issue } from "../domain/wiki";

export interface PublishedPage {
  id: string;
  title: string;
  summary: string;
  version: number;
  content: string;
  scope?: string;
}
export interface ChangeSet {
  reviewWarnings?:{pageId:string;key:string;code:'PROPERTY_REQUIRED';mode:'warn'|'block'}[];
  id: string;
  hash: string;
  status: string;
  updates: Draft[];
}
export interface Job {
  id: string;
  status: string;
  kind?: string;
  operation?: string;
  error?: string;
  error_code?: string;
  created_at?: string;
  finished_at?: string;
}
export const consoleGroups = [
  {
    label: "관측과 대응",
    items: [
      { id: "overview", label: "운영 개요" },
      { id: "usage", label: "사용량 분석" },
      { id: "jobs", label: "내 작업 이력" },
    ],
  },
  {
    label: "지식 순환",
    items: [
      { id: "knowledge", label: "발행 지식" },
      { id: "workflows", label: "편집 · 협업" },
      { id: "imports", label: "자료 넣기 · 자동 정리" },
      { id: "sources", label: "원본 · 편입" },
      { id: "review", label: "변경 검토" },
      { id: "query", label: "질문 · 재편입" },
      { id: "lint", label: "지식 건강 점검" },
      { id: "refinement", label: "정련 · 경험" },
    ],
  },
  {
    label: "환경과 거버넌스",
    items: [
      { id: "agents", label: "에이전트 · 토큰" },
      { id: "integrations", label: "연동 · 자동화" },
      { id: "users", label: "사용자 · 세션 목업" },
      { id: "access", label: "공간 · 접근" },
      { id: "policies", label: "검토 · 공유 정책" },
      { id: "lifecycle", label: "편집 · 수명주기" },
      { id: "activity", label: "알림 · 감사 · 운영" },
      { id: "boards", label: "공지 · VOC · 내부 검토" },
      { id: "evaluation", label: "평가 · 성과 환류" },
      { id: "coverage", label: "전체 기능 점검" },
    ],
  },
] as const;
export type ConsoleTab = (typeof consoleGroups)[number]["items"][number]["id"];
export const consoleItems = consoleGroups.flatMap((g) => [...g.items]);
export const consoleLabel = (tab: ConsoleTab) =>
  consoleItems.find((x) => x.id === tab)!.label;
export function readConsoleTab(hash: string): ConsoleTab {
  const id = hash.replace(/^#/, "");
  return consoleItems.some((x) => x.id === id)
    ? (id as ConsoleTab)
    : "overview";
}
export function summarizeConsole(data: {
  pages: Pick<PublishedPage, "id">[];
  sources: Source[];
  changes: Pick<ChangeSet, "status">[];
  jobs: Pick<Job, "status">[];
  issues: Issue[] | null;
}) {
  return {
    pages: data.pages.length,
    sources: data.sources.length,
    pending: data.changes.filter((c) => c.status === "pending").length,
    approved: data.changes.filter((c) => c.status === "approved").length,
    failedJobs: data.jobs.filter((j) => j.status === "failed").length,
    runningJobs: data.jobs.filter((j) => j.status === "running").length,
    issues: data.issues === null ? null : data.issues.length,
  };
}
