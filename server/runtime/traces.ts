import type {Pool} from 'pg';
import type {Context} from '../service';
import {transaction} from '../database';
import {authorizeInTransaction} from '../access/index';
import type {RuntimeJobsBridge} from '../jobs/runtime';
const valid=(value:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw Error('VALIDATION_FAILED');return value;};
export async function recordJobTrace(pool:Pool,ctx:Context,requestId:string,operation:string,jobId:string){
  valid(requestId);valid(jobId);if(!['query','ingest','lint','semantic-lint','daily','weekly','index'].includes(operation))throw Error('VALIDATION_FAILED');
  await transaction(pool,ctx.workspaceId,async db=>{
    await ctx.authorization?.assertSession(db);await authorizeInTransaction(db,ctx,'knowledge.read');
    const job=await db.query('SELECT 1 FROM durable_jobs WHERE id=$1 AND workspace_id=$2 AND principal_id=$3',[jobId,ctx.workspaceId,ctx.principalId]);
    if(!job.rowCount)throw Error('NOT_FOUND');
    await db.query('INSERT INTO runtime_request_traces(request_id,workspace_id,principal_id,operation,job_id) VALUES($1,$2,$3,$4,$5)',[requestId,ctx.workspaceId,ctx.principalId,operation,jobId]);
  });
}
const measured=(value:unknown):number|null=>{if(value===null||value===undefined)return null;const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
export async function readJobTrace(pool:Pool,bridge:RuntimeJobsBridge,ctx:Context,requestId:string){
  valid(requestId);await ctx.authorization?.revalidate();
  const record=await transaction(pool,ctx.workspaceId,async db=>{
    await ctx.authorization?.assertSession(db);await authorizeInTransaction(db,ctx,'knowledge.read');
    const result=await db.query('SELECT operation,job_id,created_at FROM runtime_request_traces WHERE request_id=$1 AND workspace_id=$2 AND principal_id=$3',[requestId,ctx.workspaceId,ctx.principalId]);
    if(!result.rowCount)throw Error('NOT_FOUND');return result.rows[0];
  });
  // This also checks every real influencing input, the parent authority and current owner/space.
  const job=await bridge.read(ctx,record.job_id);
  const rows=await pool.query('SELECT call_id,attempt,provider,requested_model,model,input_tokens,output_tokens,cost_micros,error_code FROM durable_model_calls WHERE job_id=$1 ORDER BY created_at,call_id LIMIT 201',[job.id]);
  if(rows.rows.length>200)throw Error('TRACE_RESULT_LIMIT');
  await bridge.read(ctx,job.id);await ctx.authorization?.revalidate();
  return {requestId,operation:record.operation,createdAt:record.created_at,job:{id:job.id,status:job.status,errorCode:job.error},modelCalls:rows.rows.map(row=>({callId:row.call_id,attempt:row.attempt,provider:row.provider,requestedModel:row.requested_model,model:row.model,inputTokens:measured(row.input_tokens),outputTokens:measured(row.output_tokens),costMicros:measured(row.cost_micros),errorCode:row.error_code}))};
}
