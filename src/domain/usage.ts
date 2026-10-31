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
  model: {
    inputTokens:number|null;outputTokens:number|null;cost:number|null;
    calls?:number;failed?:number;measuredCalls?:number;outputMeasuredCalls?:number;pricedCalls?:number;
    cacheReadTokens?:number|null;cacheWriteTokens?:number|null;
    byProvider?:{
      provider:string;backend:string;model:string;calls:number;failed:number;
      measuredCalls:number;pricedCalls:number;inputTokens:number|null;outputTokens:number|null;
      cacheReadTokens:number|null;cacheWriteTokens:number|null;cost:number|null;averageDurationMs:number;
    }[];
  };
}
