// Evidence-only synthetic identity. Never import into the production runtime.
// Creates and drops only its own akh_c2_ui_* database on the provided test server.
import { Pool } from "pg";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fixture, adoptFixture } from "../../../server/test-support";
import { authorizeInTransaction } from "../../../server/access";
import { CollaborationService,resolveGovernanceResponsibility } from "../../../server/collaboration";
import { RuntimeService } from "../../../server/runtime/knowledge";
import { WorkflowService } from "../../../server/workflows/service";
import { KnowledgeService } from "../../../server/service";
import { createRuntimeHandler } from "../../../server/runtime/http";
if (process.env.AKH_C2_SYNTHETIC_CAPTURE !== "1") throw Error("Set AKH_C2_SYNTHETIC_CAPTURE=1 for this evidence-only fixture");
if (!process.env.TEST_DATABASE_URL) throw Error("A dedicated disposable TEST_DATABASE_URL is required");
const root=process.env.TEST_DATABASE_URL;const admin=new Pool({connectionString:root});const name=`akh_c2_ui_${Date.now()}`;await admin.query(`CREATE DATABASE "${name}"`);const url=new URL(root);url.pathname=`/${name}`;process.env.TEST_DATABASE_URL=url.toString();
const f=await fixture();await adoptFixture(f.pool,f.workspaceId);const runtime=new RuntimeService(f.pool);const workflow=new WorkflowService(f.pool,runtime,authorizeInTransaction);const core=new KnowledgeService(f.pool);
const collaboration=new CollaborationService(f.pool,{authorize:authorizeInTransaction,assertDispatcher:async()=>{},verifyRecipient:async()=>{throw Error("UNCONFIGURED");},resolveReviewResponsibility:resolveGovernanceResponsibility},{applicationOrigin:"http://127.0.0.1:5192"});
await collaboration.subscribe(f.ctx,{scope:"space",enabled:true});
for(let n=1;n<=6;n++)await workflow.addComment(f.editor,"topic",{version:1,content:`알림 확인용 합성 댓글 ${n}`,mentions:["reviewer"]});
await core.propose(f.editor,[{id:"topic",title:"변경 검토 예시",summary:"합성 검토",content:"검토할 변경",sourceIds:["source-a"],baseVersion:1,scope:"team",links:[],facts:[]}],["source-a"]);
await collaboration.scanEvents();
const auth={authenticate:async(req: {headers: {cookie?: string}})=>({...((req.headers.cookie === "synthetic-editor") ? f.editor : f.ctx),csrfToken:"test-only-csrf"}),requestGuard:()=>({revalidate:async()=>{},assertSession:async()=>{}})};
const server=createServer(createRuntimeHandler({pool:f.pool,service:runtime,origin:"http://127.0.0.1:5192",workspaceId:f.workspaceId,auth,collaboration} as any));await new Promise<void>(r=>server.listen(4392,"127.0.0.1",r));await writeFile(process.env.AKH_C2_CAPTURE_FIXTURE ?? "/tmp/akh-c2-browser.json",JSON.stringify({workspaceId:f.workspaceId,port:4392,database:name}));
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await new Promise<void>(r=>server.close(()=>r()));await f.pool.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();process.exit(0);};process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());console.log("C2 synthetic runtime ready on4392");
