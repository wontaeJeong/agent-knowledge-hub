export type Role = "editor" | "reviewer" | "reader";
export type Scope = "company" | "team" | "private";
export type PageState = "미검증" | "팀 검토" | "실행 검증" | "공식 기준";
export interface Version {
  id: string;
  number: number;
  content: string;
  author: string;
  reason: string;
  at: string;
  sourceIds: string[];
  /** Server attribution: generation, responsible proposal and publication are different events. */
  batchId?: string;
  proposedBy?: string | null;
  publishedBy?: string;
  responsibleUserId?: string | null;
  producer?: {
    kind:
      | "unknown"
      | "user-submission"
      | "structural"
      | "model"
      | "api-submission"
      | "import";
    principalId?: string;
    provider?: string | null;
    model?: string | null;
  };
}
export interface Page {
  id: string;
  title: string;
  summary: string;
  category: string;
  scope: Scope;
  status: PageState;
  owner: string;
  tags: string[];
  versions: Version[];
  favorite: boolean;
  reused: number;
  links?: string[];
  verifiedAt?: string;
  facts?: import("./wiki").Fact[];
}
export interface Source {
  id: string;
  title: string;
  tool: string;
  project: string;
  content: string;
  scope: Scope;
  verification: "작성자 확인" | "실행 증거 첨부" | "미검증";
  createdAt: string;
  processed: boolean;
  targetPageId: string;
}
export interface Change {
  id: string;
  title: string;
  pageId: string;
  baseVersion: number;
  sourceIds: string[];
  before: string;
  after: string;
  reason: string;
  status: "pending" | "approved" | "published" | "rejected" | "conflict";
  createdAt: string;
  approvedAt?: string;
}
export interface Run {
  id: string;
  kind: "Daily" | "Weekly";
  at: string;
  sources: number;
  changes: number;
  issues: string[];
  mode: "deterministic-demo";
}
export interface Audit {
  id: string;
  at: string;
  actor: string;
  kind: string;
  detail: string;
}
export interface Share {
  id: string;
  pageId: string;
  version?: number;
  expiresAt: string;
  revoked: boolean;
}
export interface State {
  schemaVersion: 1;
  pages: Page[];
  sources: Source[];
  changes: Change[];
  runs: Run[];
  audit: Audit[];
  shares: Share[];
  schedule: { daily: string; weekly: string; enabled: boolean };
  role: Role;
  knowledge?: import("./wiki").Knowledge;
}
export type Action =
  | { type: "ROLE"; role: Role }
  | { type: "FAVORITE"; id: string }
  | { type: "ADD_SOURCE"; source: Source }
  | { type: "RUN"; kind: Run["kind"] }
  | { type: "APPROVE" | "PUBLISH" | "REJECT"; id: string }
  | { type: "RESTORE"; id: string; version: number }
  | { type: "SAVE_PAGE"; id: string; content: string; baseVersion: number }
  | { type: "SHARE"; share: Share }
  | { type: "REVOKE_SHARE"; id: string }
  | { type: "FEEDBACK"; id: string; result: string }
  | { type: "SCHEDULE"; daily: string; weekly: string; enabled: boolean };
