import {createServer,type Server} from "node:http";
import {afterAll,afterEach,beforeAll,beforeEach,expect,test} from "vitest";
import {fixture,adoptFixture} from "../test-support";
import {approveLocalTransmissionFixture} from "../policy/test-fixture";
import {normalizeProviderUsage} from "../model-usage";
import {callModel} from "./model";
import {usageSummary,exportModelUsageCsv} from "../usage";
import {assessPage} from "./systemone";
import {RuntimeService} from "./knowledge";
const original={...process.env};
let provider:Server,base:string,systemStatus=200,mode:"chat"|"systemone"="chat";
let providerCalls=0;
let f:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{
 provider=createServer(async(req,res)=>{
  providerCalls++;
  if(mode==="systemone"){
   res.writeHead(systemStatus,{"Content-Type":"application/json"});
   return res.end(systemStatus===200?JSON.stringify({answers:{needs_review:{type:"noul",noul:0.7}},usage:{input_tokens:14,output_tokens:2}}):"private model diagnostic");
  }
  res.writeHead(systemStatus,{"Content-Type":"application/json","x-litellm-response-cost":"0.0125","x-litellm-model-id":"deployment-123"});
  res.end(systemStatus===200?JSON.stringify({
   model:"routed-model",
   usage:{prompt_tokens:120,completion_tokens:25,prompt_tokens_details:{cached_tokens:30}},
   choices:[{finish_reason:"stop",message:{content:JSON.stringify({content:"answer",insufficient:true,citations:[]})}}],
  }):"secret internal failure body");
 });
 await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
 base="http://127.0.0.1:"+ (provider.address() as {port:number}).port;
});
afterAll(async()=>{await new Promise<void>(resolve=>provider.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);});
beforeEach(async()=>{f=await fixture();mode="chat";systemStatus=200;providerCalls=0;});
afterEach(async()=>{await f.pool.end();});
test("normalization preserves unknown fields and server-reported zero vs missing",()=>{
 expect(normalizeProviderUsage("litellm",{usage:{prompt_tokens:0,completion_tokens:7}},new Headers({"x-litellm-response-cost":"0"}))).toMatchObject({inputTokens:0,outputTokens:7,costUsd:0,cacheReadTokens:null});
 expect(normalizeProviderUsage("bedrock",{usage:{inputTokens:8,outputTokens:2,cacheReadInputTokens:4,cacheWriteInputTokens:1}})).toMatchObject({inputTokens:8,outputTokens:2,cacheReadTokens:4,cacheWriteTokens:1,costUsd:null});
 expect(normalizeProviderUsage("openai",{})).toMatchObject({inputTokens:null,outputTokens:null,costUsd:null});
});
test.each([
 {status:200,succeeded:true,input:"120",output:"25"},
 {status:500,succeeded:false,input:null,output:null},
])("default OpenAI provider records actual HTTP call with status $status",async({status,succeeded,input,output})=>{
 delete process.env.AGENT_KNOWLEDGE_HUB_LLM_PROVIDER;
 Object.assign(process.env,{
  AGENT_KNOWLEDGE_HUB_LLM_BACKEND:"unknown",
  AGENT_KNOWLEDGE_HUB_LLM_BASE_URL:base+"/v1",
  AGENT_KNOWLEDGE_HUB_LLM_MODEL:"test",
  AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION:"true",
 });
 systemStatus=status;
 let hookProvider:string|undefined,usageProvider:string|undefined;
 const call=callModel("query",{question:"secret"},{
  pool:f.pool,workspaceId:f.workspaceId,principalId:"editor",
  beforeCall:async(provider)=>{hookProvider=provider;},
  onUsage:async(usage)=>{usageProvider=usage.provider;},
 });
 if(succeeded) await expect(call).resolves.toMatchObject({content:"answer"});
 else await expect(call).rejects.toThrow("MODEL_UNAVAILABLE");
 expect(providerCalls).toBe(1);
 const result=await f.pool.query("SELECT * FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId]);
 expect(result.rowCount).toBe(1);
 expect(result.rows[0]).toMatchObject({provider:"openai",succeeded,input_tokens:input,output_tokens:output});
 expect(hookProvider).toBe("openai");
 expect(usageProvider).toBe("openai");
});
test("LiteLLM reports actual token/cache/cost per principal without storing prompts",async()=>{
 Object.assign(process.env,{
  AGENT_KNOWLEDGE_HUB_LLM_PROVIDER:"litellm",
  AGENT_KNOWLEDGE_HUB_LLM_BACKEND:"unknown",
  AGENT_KNOWLEDGE_HUB_LLM_BASE_URL:base+"/v1",
  AGENT_KNOWLEDGE_HUB_LLM_MODEL:"routed-model",
  AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION:"true",
 });
 const input={question:"source content should never be in metrics",pages:[]};
 await callModel("query",input,{pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"});
 const metric=await f.pool.query("SELECT * FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId]);
 expect(metric.rowCount).toBe(1);
 expect(metric.rows[0]).toMatchObject({provider:"litellm",backend:"unknown",input_tokens:"120",output_tokens:"25",cache_read_tokens:"30",cost_usd:"0.0125000000",succeeded:true});
 expect(JSON.stringify(metric.rows)).not.toContain(input.question);
 const reader=await usageSummary(f.pool,f.reader,7);
 expect(reader.model.calls).toBe(0);
 const owner=await usageSummary(f.pool,f.ctx,7);
 expect(owner.model).toMatchObject({calls:1,inputTokens:120,outputTokens:25,cacheReadTokens:30,cost:0.0125,measuredCalls:1,pricedCalls:1});
 const csv=await exportModelUsageCsv(f.pool,f.ctx,7);
 expect(csv).toContain('"litellm"');
 expect(csv).not.toContain(input.question);
});
test("provider failures cannot leak body or invent usage or cost",async()=>{
 Object.assign(process.env,{
  AGENT_KNOWLEDGE_HUB_LLM_PROVIDER:"litellm",AGENT_KNOWLEDGE_HUB_LLM_BACKEND:"unknown",
  AGENT_KNOWLEDGE_HUB_LLM_BASE_URL:base+"/v1",AGENT_KNOWLEDGE_HUB_LLM_MODEL:"test",
  AGENT_KNOWLEDGE_HUB_LLM_ALLOW_TRANSMISSION:"true",
 });
 systemStatus=500;
 await expect(callModel("query",{question:"secret"}, {pool:f.pool,workspaceId:f.workspaceId,principalId:"editor"})).rejects.toThrow("MODEL_FAILED");
 const result=await f.pool.query("SELECT * FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId]);
 expect(result.rows[0]).toMatchObject({succeeded:false,input_tokens:null,output_tokens:null,cost_usd:null});
 expect(JSON.stringify(result.rows)).not.toContain("secret");
});
test("SystemOne cannot send a page without explicit destination and source approval",async()=>{
 mode="systemone";
 delete process.env.AGENT_KNOWLEDGE_HUB_SYSTEMONE_DESTINATION_ID;
 Object.assign(process.env,{
  NODE_ENV:"test",AGENT_KNOWLEDGE_HUB_SYSTEMONE_BASE_URL:base,
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_MODEL:"synthetic-systemone",
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_ALLOW_TRANSMISSION:"true",
 });
 await expect(assessPage(f.pool,new RuntimeService(f.pool),f.ctx,"topic")).rejects.toThrow("MODEL_TRANSMISSION_DENIED");
 expect(providerCalls).toBe(0);
});
test("SystemOne reviewer score cannot create a published page or pretend to be a generative answer",async()=>{
 mode="systemone";
 await adoptFixture(f.pool,f.workspaceId);
 Object.assign(process.env,{
  NODE_ENV:"test",AGENT_KNOWLEDGE_HUB_SYSTEMONE_BASE_URL:base,
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_MODEL:"synthetic-systemone",
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_ALLOW_TRANSMISSION:"true",
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_REVIEW_THRESHOLD:"0.6",
  AGENT_KNOWLEDGE_HUB_SYSTEMONE_DESTINATION_ID:"systemone-fixture",
 });
 const authorization=await approveLocalTransmissionFixture(f.pool,f.workspaceId,base+"/v1/systemone",["assessment"],"systemone-fixture");
 const result=await assessPage(f.pool,new RuntimeService(f.pool),{...f.ctx,authorization},"topic");
 expect(result).toMatchObject({needsReview:true,score:0.7,threshold:0.6,pageId:"topic"});
 const rows=await f.pool.query("SELECT * FROM model_usage_events WHERE workspace_id=$1",[f.workspaceId]);
 expect(rows.rows[0]).toMatchObject({provider:"systemone",operation:"assess",input_tokens:"14",output_tokens:"2",cost_usd:null});
 expect((await f.pool.query("SELECT count(*)::int AS n FROM publications WHERE workspace_id=$1",[f.workspaceId])).rows[0].n).toBe(0);
});
