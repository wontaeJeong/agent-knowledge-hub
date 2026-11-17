import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const head='/Users/wt.jeong/.codex/worktrees/411f/agent-knowledge-hub';
const {default:pg}=await import(head+'/node_modules/pg/lib/index.js');
const parent=process.env.TEST_DATABASE_URL!;
const admin=new pg.Pool({connectionString:parent});
try {
 for(const [label,root,placement] of [['base','/private/tmp/akh_c8_storage_base_3b8f310',true],['head',head,true],['head-control-no-placement',head,false]] as const){
  const dbName='akh_c8_storage_probe_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE DATABASE "${dbName}"`);const url=new URL(parent);url.pathname='/'+dbName;process.env.TEST_DATABASE_URL=url.href;
  let f:any;
  try {
   const support=await import(pathToFileURL(root+'/server/test-support.ts').href);
   const {selectErasureRows,previewErasure,executeErasure}=await import(pathToFileURL(root+'/server/operations/erasure.ts').href);
   const {OperationsService}=await import(pathToFileURL(root+'/server/operations/service.ts').href);
   const {authorizeInTransaction}=await import(pathToFileURL(root+'/server/access/index.ts').href);
   f=await support.fixture();await support.adoptFixture(f.pool,f.workspaceId);
   const ctx={workspaceId:f.workspaceId,principalId:'fixture-owner'};
   const independent={...support.source,id:'independent',content:'independent original',...(placement?{}:{targetPageId:undefined})};
   await f.pool.query("INSERT INTO resources VALUES($1,'source','independent')",[f.workspaceId]);
   await f.pool.query('INSERT INTO sources(workspace_id,id,data) VALUES($1,$2,$3)',[f.workspaceId,'independent',independent]);
   await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,id,'fixture-owner' FROM resources WHERE workspace_id=$1 ON CONFLICT DO NOTHING",[f.workspaceId]);
   const rows=[];
   for(const table of ['sources','pages','versions']){
    const result=await f.pool.query(`SELECT ctid::text AS locator,to_jsonb(t) AS data FROM ${table} t WHERE workspace_id=$1`,[f.workspaceId]);
    rows.push(...result.rows.map((r:any)=>({table,...r})));
   }
   const selected=selectErasureRows(rows,{kind:'source',id:'source-a'});
   const ops=new OperationsService(f.pool,authorizeInTransaction,{physicalDeletionGateConfirmed:true});
   const request={scope:'resource',resource:{kind:'source',id:'source-a'}};
   const preview=await previewErasure(ops,ctx,request);
   const erased=await executeErasure(ops,ctx,{...request,previewHash:preview.previewHash,confirm:'ERASE_PREVIEWED_RESOURCE_LINEAGE'});
   const tombstones=(await f.pool.query('SELECT resource_kind,resource_id FROM operations_tombstones WHERE workspace_id=$1 ORDER BY resource_kind,resource_id',[f.workspaceId])).rows;
   const readers=(await f.pool.query("SELECT principal_id FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='independent' ORDER BY principal_id",[f.workspaceId])).rows;
   console.log(JSON.stringify({label,sourcePlacement:independent.targetPageId??null,selected:selected.map((r:any)=>({table:r.table,id:r.data.id??r.data.page_id,targetPageId:r.data.data?.targetPageId??null,sourceIds:r.data.data?.sourceIds??null})),previewCounts:preview.counts,eraseStatus:erased.status,tombstones,independentReaders:readers}));
  } finally {await f?.pool.end();await admin.query(`DROP DATABASE "${dbName}"`);}
 }
}finally{await admin.end();}
