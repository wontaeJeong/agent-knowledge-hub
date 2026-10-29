export interface UsageSummary {
  scope: "self" | "workspace";
  from: string;
  to: string;
  timezone: "UTC";
  total: number;
  succeeded: number;
  failed: number;
  activeUsers: number;
  publications: number;
  daily: { day: string; succeeded: number; failed: number }[];
  operations: {
    operation: string;
    total: number;
    failed: number;
    averageDurationMs: number;
  }[];
  model: { inputTokens: null; outputTokens: null; cost: null };
}
