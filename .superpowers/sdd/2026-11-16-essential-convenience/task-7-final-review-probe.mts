import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture, adoptFixture, page } from '/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub/server/test-support.ts';
import { RuntimeService } from '/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub/server/runtime/knowledge.ts';
import { createRuntimeHandler } from '/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub/server/runtime/http.ts';
import { OidcAuth, sessionHash } from '/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub/server/runtime/auth.ts';
const require=createRequire('/Users/wt.jeong/.codex/worktrees/31d9/agent-knowledge-hub/package.json');
const {Pool}=require('pg');
const oidc=await import(require.resolve('openid-client'));
const {Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const {StreamableHTTPClientTransport}=await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const base=new URL(process.env.TEST_DATABASE_URL!);
if(base.hostname!=='127.0.0.1'||base.port!=='32769')throw Error('wrong synthetic endpoint');
const admin=new Pool({connectionString:base.href}),name='akh_c7_final_review_'+randomUUID().replaceAll('-','');
let f:any, server:any, provider:any, client:any;
try {
 await admin.query(`CREATE DATABASE ${name}`);base.pathname='/'+name;process.env.TEST_DATABASE_URL=base.href;
 f=await fixture();await adoptFixture(f.pool,f.workspaceId);
 const {versions,...data}=page;
 await f.pool.query("INSERT INTO resources VALUES($1,'page','linked')",[f.workspaceId]);
 await f.pool.query("INSERT INTO resource_readers SELECT $1,'page','linked',unnest($2::text[])",[f.workspaceId,['editor','reviewer','reader']]);
 await f.pool.query('INSERT INTO pages(workspace_id,id,data) VALUES($1,$2,$3)',[f.workspaceId,'linked',{...data,id:'linked',title:'Linked'}]);
 await f.pool.query('INSERT INTO versions VALUES($1,$2,1,$3)',[f.workspaceId,'linked',versions[0]]);
 provider=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({sub:'reviewer',groups:['reviewers']}));}).listen(0,'127.0.0.1');await once(provider,'listening');
 const issuer=`http://127.0.0.1:${provider.address().port}`,config=new oidc.Configuration({issuer,userinfo_endpoint:issuer+'/userinfo'},'client','secret');oidc.allowInsecureRequests(config);
 const auth=new OidcAuth(f.pool,config,'http://localhost',f.workspaceId,{reviewers:'reviewer'});
 await f.pool.query("INSERT INTO runtime_sessions(id,workspace_id,principal_id,csrf,expires_at,subject,access_token) VALUES($1,$2,'reviewer','csrf',now()+interval '1 hour','reviewer','token')",[sessionHash('c7-final-review'),f.workspaceId]);
 server=createServer(createRuntimeHandler({pool:f.pool,service:new RuntimeService(f.pool),auth,origin:'http://localhost',workspaceId:f.workspaceId})).listen(0,'127.0.0.1');await once(server,'listening');
 const endpoint=`http://127.0.0.1:${server.address().port}`,headers={Cookie:'akh_session=c7-final-review',Origin:'http://localhost','X-CSRF-Token':'csrf','Content-Type':'application/json'};
 const call=async(path:string,body?:unknown,secret?:string)=>{const r=await fetch(endpoint+'/api/v1'+path,{method:body?'POST':'GET',headers:secret?{Authorization:'Bearer '+secret,'X-Space-Id':f.workspaceId,'Content-Type':'application/json'}:headers,...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const tree=await call('/convenience/tree');
 const moveInput={pageId:'topic',parentId:null,beforeId:'linked',expectedRevision:0,expectedStructureRevision:tree.body.revision,reason:'review reorder',mutationId:randomUUID()};
 const grant=await call('/convenience/credentials',{operation:'move',input:moveInput,expiresAt:new Date(Date.now()+600000).toISOString()});
 console.log('MACHINE_REORDER_ISSUED',grant.status);
 console.log('MACHINE_REORDER',JSON.stringify(await call('/convenience/pages/move',moveInput,grant.body.secret)));
 const fresh=await call('/convenience/tree');
 console.log('COOKIE_FRESH_REORDER',JSON.stringify(await call('/convenience/pages/move',{...moveInput,expectedStructureRevision:fresh.body.revision,mutationId:randomUUID()})));
 // Exact same canonical body link, different mutation IDs: HTTP and runtime MCP should capture the same origin dependencies.
 await f.pool.query("UPDATE versions SET data=jsonb_set(data,'{content}',to_jsonb($2::text)) WHERE workspace_id=$1 AND page_id='topic'",[f.workspaceId,`[Linked](http://localhost/?app=1&space=${f.workspaceId}&document=linked)`]);
 const copyInput={pageId:'topic',version:1,parentId:null,mutationId:randomUUID()};
 const httpCopy=await call('/convenience/pages/duplicate',copyInput);console.log('HTTP_ABSOLUTE_COPY',httpCopy.status,JSON.stringify(httpCopy.body.dependencyVersions));
 const mcpInput={...copyInput,mutationId:randomUUID()};
 const cg=await call('/convenience/credentials',{operation:'duplicate',input:mcpInput,expiresAt:new Date(Date.now()+600000).toISOString()});
 client=new Client({name:'review',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(endpoint+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+cg.body.secret,'X-Space-Id':f.workspaceId}}}));
 const mcp=await client.callTool({name:'knowledge_duplicate',arguments:mcpInput});console.log('MCP_ABSOLUTE_COPY',mcp.isError??false,JSON.stringify(JSON.parse(mcp.content[0].text).dependencyVersions));
 await f.pool.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='linked' AND principal_id='reviewer'",[f.workspaceId]);
 console.log('HTTP_REPLAY_AFTER_LINK_REVOKE',JSON.stringify(await call('/convenience/pages/duplicate',copyInput)));
 const replay=await client.callTool({name:'knowledge_duplicate',arguments:mcpInput});console.log('MCP_REPLAY_AFTER_LINK_REVOKE',replay.isError??false,JSON.stringify(replay.content));
} finally {
 await client?.close();for(const s of [server,provider])if(s){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
 await f?.pool.end();await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();console.log('OWNED_DATABASE_DROPPED',name);
}
