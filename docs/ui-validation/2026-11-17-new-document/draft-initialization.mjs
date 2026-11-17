// Separate real initialization regression; does not retry or replace failed requests.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
assert.equal(process.env.AKH_C6_SYNTHETIC_CAPTURE,'1');
const f=JSON.parse(await readFile('/private/tmp/akh_c6_browser.json','utf8'));
assert.match(f.database,/^akh_c6_ui_[a-f0-9]{32}$/);
const observations=[],profiles=[];let contexts=[];
async function request(path,body){const start=Date.now();const r=await fetch('http://127.0.0.1:4396/api/v1'+path,{method:body?'POST':'GET',headers:{cookie:'synthetic-editor','X-Space-Id':f.workspaceId,origin:'http://127.0.0.1:5196','Content-Type':'application/json','X-CSRF-Token':'test-only-csrf'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,JSON.stringify({path,status:r.status,code:data.code}));return data;}
const ids=[];
try{
 for(const count of [27,81]){
  while(ids.length<count){const id=crypto.randomUUID(),title='Distinct '+ids.length;await request('/workflows/drafts',{id,expectedRevision:0,title,content:'Synthetic distinct body'});await request(`/workflows/drafts/${id}/disclosure`,{expectedRevision:1,title,parentId:null,readers:['editor','reviewer'],reviewerId:'reviewer',reason:'Distinct initialization',mutationId:crypto.randomUUID()});ids.push({id,title});}
  for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'light'],[390,'dark']]){
   const runs=await Promise.all(['editor','reviewer'].map(async actor=>{
    const profile=await mkdtemp('/private/tmp/akh_c6_profile_');profiles.push(profile);const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width,height:844}});contexts.push(context);const failures=[],responses=[];
    await context.route('**/api/**',async route=>{const q=route.request(),url=new URL(q.url()),start=Date.now();const response=await route.fetch({url:'http://127.0.0.1:4396'+url.pathname+url.search,headers:{...q.headers(),cookie:'synthetic-'+actor,origin:'http://127.0.0.1:5196'}});const detail={at:new Date().toISOString(),path:url.pathname,status:response.status(),elapsedMs:Date.now()-start};if(response.status()>=500){const body=await response.json();failures.push({...detail,code:body.code,requestId:body.requestId});}responses.push(detail);await route.fulfill({response});});
    const page=context.pages()[0],start=Date.now();await page.goto(`http://127.0.0.1:5196/?app=1&space=${f.workspaceId}&section=compose${actor==='editor'?'&draft='+ids[0].id:''}`);await page.getByLabel('문서 제목',{exact:true}).waitFor({timeout:15000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    if(actor==='editor'){assert.equal(await page.getByLabel('문서 제목',{exact:true}).inputValue(),ids[0].title);await page.getByLabel('고정 공개 대상',{exact:true}).waitFor();}
    assert.equal(failures.length,0,JSON.stringify(failures));const result={count,width,theme,actor,elapsedMs:Date.now()-start,failures,responses};console.log(JSON.stringify(result));observations.push(result);await context.close();contexts=contexts.filter(c=>c!==context);return result;
   }));assert.equal(runs.length,2);
  }
 }
 await writeFile('docs/ui-validation/2026-11-17-new-document/draft-initialization.json',JSON.stringify({at:new Date().toISOString(),synthetic:true,observations},null,2)+'\n');
}finally{for(const c of contexts)await c.close().catch(()=>{});for(const p of profiles)await rm(p,{recursive:true,force:true});}
