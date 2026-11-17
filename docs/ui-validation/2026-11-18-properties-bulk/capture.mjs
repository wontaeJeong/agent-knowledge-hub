import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {sourceHashes} from '../2026-11-18-document-reader/manifest.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const f=JSON.parse(await readFile('/private/tmp/akh_c10_browser.json','utf8'));
assert.equal((await sourceHashes()).productionFingerprint,f.productionFingerprint);
const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+f.database;
const db=new Pool({connectionString:url.href}),out='docs/ui-validation/2026-11-18-properties-bulk',results=[];
let index=0;const browser=await chromium.launch({headless:true});
try{for(const width of [1440,390])for(const theme of ['light','dark']){
 const scenario=f.scenarios[index++],context=await browser.newContext({viewport:{width,height:width===1440?1000:844},timezoneId:'Asia/Seoul'}),errors=[],requests=[];
 try{
 await context.addInitScript(t=>localStorage.setItem('agent-knowledge-hub.theme',t),theme);
 await context.route('**/api/**',async route=>{const req=route.request(),u=new URL(req.url());requests.push({path:u.pathname,method:req.method()});const response=await route.fetch({url:'http://127.0.0.1:4400'+u.pathname+u.search,headers:{...req.headers(),cookie:'akh_session='+scenario.cookie,origin:'http://127.0.0.1:5200'}});await route.fulfill({response});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 const api=async(path,body)=>{const r=await fetch('http://127.0.0.1:4400/api/v1'+path,{method:body?'POST':'GET',headers:{cookie:'akh_session='+scenario.cookie,origin:'http://127.0.0.1:5200','X-Space-Id':scenario.spaceId,'X-CSRF-Token':'test-only-csrf','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,data}));return data;};
 await page.goto(`http://127.0.0.1:5200/?app=1&space=${scenario.spaceId}&document=topic`);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 await page.getByText('문서 구조·속성·보호',{exact:true}).click();const form=page.getByRole('region',{name:'문서 속성',exact:true});await form.getByLabel('문서 유형',{exact:true}).waitFor();
 assert.ok(await form.getByRole('button',{name:'속성 검토 요청',exact:true}).isDisabled());
 await form.getByLabel('적용 환경',{exact:true}).fill('PostgreSQL 17 · 합성 검증');await form.getByLabel('태그 (쉼표 구분)',{exact:true}).fill('운영, 운영, 검증');await form.getByLabel('검토일',{exact:true}).fill('2026-12-01');await form.getByLabel('변경 이유',{exact:true}).fill('속성 검토 요청');
 await form.getByLabel('문서 유형',{exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').getAttribute('maxlength'),'3000');
 await form.scrollIntoViewIfNeeded();await form.screenshot({path:`${out}/${width}-${theme}-properties.png`});
 await form.getByRole('button',{name:'속성 검토 요청',exact:true}).click();await form.getByText('속성 검토를 요청했습니다. 승인·발행 전에는 현재 문서가 유지됩니다.',{exact:true}).waitFor();
 assert.deepEqual((await api('/workflows/pages/topic/properties')).metadata.tags,[]);
 const summary=page.getByText('여러 문서의 태그·위치·보관 변경',{exact:true});await summary.click();const bulk=summary.locator('..');
 for(const title of ['정리 대상','기준 변경 대상','접근 변경 대상'])await bulk.getByLabel(title,{exact:true}).check();await bulk.locator('select').first().selectOption('archive');await bulk.getByLabel('변경 이유',{exact:true}).fill('합성 일괄 보관');
 await bulk.getByRole('button',{name:'변경 미리보기',exact:true}).click();await bulk.getByRole('region',{name:'일괄 변경 미리보기'}).waitFor();await bulk.scrollIntoViewIfNeeded();await bulk.screenshot({path:`${out}/${width}-${theme}-preview.png`});
 await bulk.getByRole('button',{name:'미리보기 내용 적용',exact:true}).click();await bulk.getByText('접수됨 · 작업자 처리 대기',{exact:true}).waitFor();
 await api('/workflows/pages/stale/state',{expectedRevision:0,properties:{environment:'race'},reason:'미리보기 후 변경'});
 await db.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='denied' AND principal_id='fixture-owner'",[scenario.spaceId]);
 await fetch('http://127.0.0.1:4400/__synthetic_tick',{method:'POST'});await bulk.getByRole('button',{name:'처리 결과 새로고침',exact:true}).click();
 const receipt=bulk.getByRole('region',{name:'일괄 변경 결과'});await receipt.getByText(/기준 변경 · 다시 미리보기/).waitFor();assert.equal(await bulk.getByText('접근 변경 대상',{exact:true}).count(),0);assert.equal(await bulk.getByLabel('접근 변경 대상',{exact:true}).count(),0);await bulk.getByText('현재 접근하거나 변경할 수 없는 선택을 제거했습니다. 필요한 문서는 권한을 확인한 뒤 다시 선택하세요.',{exact:true}).waitFor();await receipt.scrollIntoViewIfNeeded();await bulk.screenshot({path:`${out}/${width}-${theme}-partial.png`});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);results.push({width,theme,checks:['canonical property policy','keyboard Tab','reviewed metadata no direct publish','queued acceptance','partial applied/stale','denied target filtered','no horizontal overflow'],requests:requests.length,errors});
 }finally{await context.close();}
 }}finally{await browser.close();await db.end();}
await writeFile(out+'/browser-results.json',JSON.stringify({startedAt:f.startedAt,productionFingerprint:f.productionFingerprint,browser:'Chromium',results},null,2));
