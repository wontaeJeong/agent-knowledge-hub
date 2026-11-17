// Explicit synthetic local OIDC UserInfo; canonical runtime routes, session DAO and PostgreSQL.
import {sourceHashes} from "../2026-11-18-document-reader/manifest.mjs";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {once} from "node:events";
import {writeFile} from "node:fs/promises";
import * as oidc from "openid-client";
import {fixture,adoptFixture,page} from "../../../server/test-support";
import {RuntimeService} from "../../../server/runtime/knowledge";
import {createRuntimeHandler} from "../../../server/runtime/http";
import {OidcAuth,sessionHash} from "../../../server/runtime/auth";
import {createRuntimeJobs} from "../../../server/jobs/runtime";
if(process.env.AKH_C10_SYNTHETIC_CAPTURE!=="1"||!process.env.TEST_DATABASE_URL)throw Error("Explicit synthetic opt-in required");
const base=new URL(process.env.TEST_DATABASE_URL);if(!["127.0.0.1","localhost"].includes(base.hostname)||!base.pathname.includes("test"))throw Error("Loopback test DB required");
const admin=new Pool({connectionString:base.href}),database="akh_c10_test_ui_"+randomUUID().replaceAll("-","");await admin.query(`CREATE DATABASE "${database}"`);base.pathname="/"+database;process.env.TEST_DATABASE_URL=base.href;
const pools:Pool[]=[];const scenarios=[];
for(let n=0;n<4;n++){
 const f=await fixture();pools.push(f.pool);await adoptFixture(f.pool,f.workspaceId);
 for(const [id,title] of [["one","정리 대상"],["stale","기준 변경 대상"],["denied","접근 변경 대상"],["rollback","이전 화면 검증 문서"],["rollback-archive","이전 화면 보관 문서"],["current-review","현행 화면 검토 문서"]]){const {versions,...metadata}=page;await f.pool.query("INSERT INTO resources VALUES($1,'page',$2)",[f.workspaceId,id]);await f.pool.query("INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)",[f.workspaceId,id,{...metadata,id,title}]);await f.pool.query("INSERT INTO versions VALUES($1,$2,1,$3)",[f.workspaceId,id,versions[0]]);await f.pool.query("INSERT INTO resource_readers SELECT $1,'page',$2,unnest($3::text[])",[f.workspaceId,id,["fixture-owner","editor","reviewer","reader"]]);}
 await f.pool.query("INSERT INTO resource_readers SELECT workspace_id,kind,resource_id,'fixture-owner' FROM resource_readers WHERE workspace_id=$1 AND principal_id='reviewer' ON CONFLICT DO NOTHING",[f.workspaceId]);
 await f.pool.query("INSERT INTO workflow_document_state(workspace_id,page_id,data) SELECT $1, id, $2 FROM unnest(ARRAY['rollback','current-review']) AS id",[f.workspaceId,{environment:{os:"linux",version:"17"},properties:{}}]);
 await f.pool.query("INSERT INTO governance_type_policies VALUES($1,'기술 설계',1,ARRAY['environment'],'block',NULL)",[f.workspaceId]);
 const cookie="c10-"+randomUUID();await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'fixture-owner','test-only-csrf',now()+interval '1 hour','fixture-owner','synthetic')",[sessionHash(cookie),f.workspaceId]);scenarios.push({spaceId:f.workspaceId,cookie});
}
const pool=pools[0],provider=createServer((_req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({sub:"fixture-owner",groups:["reviewers"]}));}).listen(0,"127.0.0.1");await once(provider,"listening");
const issuer=`http://127.0.0.1:${(provider.address() as any).port}`,config=new oidc.Configuration({issuer,userinfo_endpoint:issuer+"/userinfo"},"fixture","synthetic");oidc.allowInsecureRequests(config);
const auth=new OidcAuth(pool,config,"http://127.0.0.1:5200",scenarios[0].spaceId,{reviewers:"reviewer"}),service=new RuntimeService(pool),jobs=createRuntimeJobs(pool,service,{workerCount:1,revalidateInteractiveGrant:auth.revalidateInteractiveGrant.bind(auth),assertInteractiveGrant:auth.assertInteractiveGrant.bind(auth)});
const handler=createRuntimeHandler({pool,service,auth,jobs,origin:"http://127.0.0.1:5200",workspaceId:scenarios[0].spaceId});
const server=createServer((req,res)=>{if(req.url==="/__synthetic_tick"&&req.method==="POST"){void jobs.worker.tick().then(()=>{res.end("ok");});return;}void handler(req,res);});server.listen(4400,"127.0.0.1");await once(server,"listening");
await writeFile("/private/tmp/akh_c10_browser.json",JSON.stringify({database,scenarios,startedAt:new Date().toISOString(),...(await sourceHashes())}));console.log("C10 synthetic runtime ready 4400");
let stopping=false;async function stop(){if(stopping)return;stopping=true;await jobs.stop();server.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>provider.close(()=>r()))]);await Promise.all(pools.map(p=>p.end()));await admin.query(`DROP DATABASE "${database}"`);await admin.end();process.exit(0);}
process.on("SIGINT",()=>void stop());process.on("SIGTERM",()=>void stop());
