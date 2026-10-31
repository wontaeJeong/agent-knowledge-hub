import {test,expect} from 'vitest';
import {fixture,adoptFixture} from '../test-support';
import {AccessService} from '../access/index';
import {RuntimeService} from './knowledge';
import {createRuntimeJobs} from '../jobs/runtime';
import {recordJobTrace,readJobTrace} from './traces';
test('request correlation resolves the real scoped job and returned model records, never another principal or revoked input',async()=>{
  const f=await fixture();await adoptFixture(f.pool,f.workspaceId);const access=new AccessService(f.pool),issued=await access.issueCredential(f.editor,{actions:['knowledge.read'],expiresAt:new Date(Date.now()+3600000).toISOString()}),ctx=await access.authenticateCredential(issued.secret,f.workspaceId),runtime=new RuntimeService(f.pool),bridge=createRuntimeJobs(f.pool,runtime);
  try{
    const job=await bridge.submitInteractive(ctx,'query',{question:'기존',mode:'offline'},'correlation-query');
    await recordJobTrace(f.pool,ctx,'request-one','query',job.id);
    expect(await readJobTrace(f.pool,bridge,ctx,'request-one')).toMatchObject({requestId:'request-one',operation:'query',job:{id:job.id,status:'queued'},modelCalls:[]});
    await f.pool.query("INSERT INTO durable_model_calls(job_id,call_id,attempt,provider,requested_model,model,input_tokens,output_tokens,cost_micros,body_hash,created_at) VALUES($1,'fixture-call',1,'fixture-provider','requested-alias','actual-model',12,3,NULL,'fixture-hash',now())",[job.id]);
    const trace=await readJobTrace(f.pool,bridge,ctx,'request-one');expect(trace.modelCalls).toEqual([{callId:'fixture-call',attempt:1,provider:'fixture-provider',requestedModel:'requested-alias',model:'actual-model',inputTokens:12,outputTokens:3,costMicros:null,errorCode:null}]);
    await expect(readJobTrace(f.pool,bridge,f.ctx,'request-one')).rejects.toThrow('NOT_FOUND');
    await expect(recordJobTrace(f.pool,f.ctx,'request-forged','query',job.id)).rejects.toThrow('NOT_FOUND');
    await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",[f.workspaceId]);
    await expect(readJobTrace(f.pool,bridge,ctx,'request-one')).rejects.toThrow('NOT_FOUND');
  }finally{await bridge.stop();await f.pool.end();}
});
