export type ImportFormat = "auto" | "text" | "json" | "csv";
export interface ImportSelection {
  format: ImportFormat;
  encoding: "utf-8" | "euc-kr" | "utf-16le";
  namespace: string;
  timezone: "unknown" | "Asia/Seoul" | "UTC";
  project: string;
  from: string;
  to: string;
  excludedIds: string[];
  acknowledgeWarnings: boolean;
  csv: {
    text: string;
    author: string;
    time: string;
    id: string;
    conversation: string;
  };
}
export const defaultSelection: ImportSelection = {
  format: "auto",
  encoding: "utf-8",
  namespace: "",
  timezone: "unknown",
  project: "",
  from: "",
  to: "",
  excludedIds: [],
  acknowledgeWarnings: false,
  csv: {
    text: "text",
    author: "author",
    time: "timestamp",
    id: "id",
    conversation: "conversation",
  },
};
export interface ImportRecord {
  id: string;
  externalId: string;
  conversationId: string;
  author: string;
  text: string;
  occurredAt: string | null;
  occurredRaw: string;
  threadId: string | null;
  event: "message" | "edited" | "deleted" | "note";
  identityVerified: false;
  sourceKey: string;
  contentHash: string;
  anchor: {
    fileId: string;
    fileName: string;
    entry: string;
    location: string;
    sha256: string;
  };
}
export interface ImportWarning {
  code: string;
  detail: string;
  recordId?: string;
}
export interface ParsedImport {
  records: ImportRecord[];
  warnings: ImportWarning[];
  formats: string[];
  counts: {
    total: number;
    selected: number;
    excluded: number;
    duplicates: number;
    deleted: number;
  };
}
export const statementKinds = [
  "statement",
  "proposal",
  "decision_report",
  "question",
  "commitment",
  "completion_claim",
  "observation",
] as const;
export type StatementKind = (typeof statementKinds)[number];
export interface ImportStatement {
  kind: StatementKind;
  text: string;
  context: string;
  recordId: string;
  quote: string;
}
export interface ImportTopic {
  key: string;
  title: string;
  summary: string;
  content: string;
  targetPageId: string | null;
  statements: ImportStatement[];
  relatedPageIds: string[];
}
export interface ImportResult {
  topics: ImportTopic[];
  excluded: { recordId: string; reason: string }[];
  calls: number;
  mode: "model" | "offline";
  coverage: { selected: number; processed: number };
}
export interface ImportRunView {
  id: string;
  importId: string;
  status: string;
  stage: string;
  attempt: number;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  result: ImportResult | null;
  changeSet: { id: string; hash: string } | null;
}
export interface ImportView {
  id: string;
  title: string;
  revision: number;
  status: string;
  selection: ImportSelection;
  files: {
    id: string;
    name: string;
    size: number;
    received: number;
    sha256: string;
  }[];
  parsed: ParsedImport | null;
  runs: ImportRunView[];
}
