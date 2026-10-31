import type { Pool } from "pg";
export type Provider="openai"|"litellm"|"bedrock"|"systemone";
export type Backend="unknown"|"onprem"|"bedrock"|"systemone"|"external";
export type ModelOperation="ingest"|"query"|"organize"|"assess";
export type Attribution={pool:Pool;workspaceId:string;principalId:string};
export type Meter={
 operation:ModelOperation;provider:Provider;backend:Backend;model:string;deploymentId:string|null;
 succeeded:boolean;latencyMs:number;inputTokens:number|null;outputTokens:number|null;
 cacheReadTokens:number|null;cacheWriteTokens:number|null;costUsd:number|null;errorCode:string|null;
};
const recordNumber=(input:unknown):number|null=>
 typeof input==="number"&&Number.isSafeInteger(input)&&input>=0?input:null;
const finiteMoney=(input:unknown):number|null=>{
 const n=typeof input==="string"&&input.trim()!==""?Number(input):input;
 return typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1000000?n:null;
};
function dict(x:unknown):Record<string,unknown>{
 return x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
}
export function normalizeProviderUsage(provider:Provider,payload:unknown,headers?:Headers){
 const data=dict(payload),usage=dict(data.usage);
 const detail=dict(usage.prompt_tokens_details);
 const bedrock=provider==="bedrock";
 const inputTokens=recordNumber(bedrock?usage.inputTokens:usage.prompt_tokens??usage.input_tokens);
 const outputTokens=recordNumber(bedrock?usage.outputTokens:usage.completion_tokens??usage.output_tokens);
 const cacheReadTokens=recordNumber(bedrock?usage.cacheReadInputTokens:detail.cached_tokens??usage.cache_read_input_tokens);
 const cacheWriteTokens=recordNumber(bedrock?usage.cacheWriteInputTokens:usage.cache_creation_input_tokens??usage.cache_write_input_tokens);
 const costUsd=finiteMoney(provider==="litellm"?headers?.get("x-litellm-response-cost"):undefined);
 const deploymentId=provider==="litellm"?(headers?.get("x-litellm-model-id")||null):null;
 return {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUsd,deploymentId:deploymentId?.slice(0,128)||null};
}
export async function recordModelUsage(attribution:Attribution,meter:Meter):Promise<void>{
 const values=[
  attribution.workspaceId,attribution.principalId,meter.operation,meter.provider,meter.backend,
  meter.model.slice(0,200),meter.deploymentId,meter.succeeded,
  Number.isFinite(meter.latencyMs)&&meter.latencyMs>=0?meter.latencyMs:0,
  meter.inputTokens,meter.outputTokens,meter.cacheReadTokens,meter.cacheWriteTokens,
  meter.costUsd,meter.errorCode,
 ];
 await attribution.pool.query(
  "INSERT INTO model_usage_events(workspace_id,principal_id,operation,provider,backend,model,deployment_id,succeeded,latency_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
  values,
 );
}
