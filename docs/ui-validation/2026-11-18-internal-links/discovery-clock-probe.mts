import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const base='/Users/wt.jeong/.codex/worktrees/411f/agent-knowledge-hub';
const {default:pg}=await import(base+'/node_modules/pg/lib/index.js');const {Pool}=pg;
const parent=process.env.TEST_DATABASE_URL!;const admin=new Pool({connectionString:parent});
try{for(const [name,root] of [['main','/private/tmp/akh_c8_baseline_probe'],['c8',base]]){
 const dbName='akh_c8_probe_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${dbName}"`);const url=new URL(parent);url.pathname='/'+dbName;process.env.TEST_DATABASE_URL=url.href;
 try { const {fixture}=await import(pathToFileURL(root+'/server/test-support.ts').href);const {RuntimeService}=await import(pathToFileURL(root+'/server/runtime/knowledge.ts').href);const {discoveryReport}=await import(pathToFileURL(root+'/server/discovery.ts').href);
 for(let i=0;i<8;i++){
 const f=await fixture();try{const runtime=new RuntimeService(f.pool);const answer=await runtime.query(f.editor,'기존','offline');let result,error;
 if(i%2)await f.pool.query("UPDATE runtime_answers SET data=jsonb_set(data,'{inputEnvelope,pageIds}',$3) WHERE workspace_id=$1 AND id=$2",[f.workspaceId,answer.id,JSON.stringify(Array.from({length:501},(_,n)=>'p'+n))]);
 try{result=await discoveryReport(f.pool,runtime,f.editor,7);}catch(e){error=(e as Error).message;}
 const row=(await f.pool.query("SELECT data->>'at' AS answer_at,clock_timestamp() AS db_observed_at FROM runtime_answers WHERE workspace_id=$1 AND id=$2",[f.workspaceId,answer.id])).rows[0];
 console.log(JSON.stringify({code:name,case:i%2?'oversized-envelope':'one-new-answer',iteration:i,answerAt:row.answer_at,dbObservedAt:row.db_observed_at,hostObservedAt:new Date().toISOString(),reportFrom:result?.from,reportTo:result?.to,citations:result?.mostCited,error,answerAfterReportBound:result?row.answer_at>result.to:null}));
 }finally{await f.pool.end();}}
 }finally{await admin.query(`DROP DATABASE "${dbName}"`);}
 console.log(JSON.stringify({code:name,discoverySourceHash:createHash('sha256').update(await readFile(root+'/server/discovery.ts')).digest('hex'),runtimeSourceHash:createHash('sha256').update(await readFile(root+'/server/runtime/knowledge.ts')).digest('hex')}));
}}finally{await admin.end();}
