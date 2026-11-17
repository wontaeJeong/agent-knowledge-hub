import {sourceHashes} from './manifest.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {Pool} from 'pg';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
if(process.env.AKH_C8_SYNTHETIC_CAPTURE!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit synthetic opt-in required');
const fixture=JSON.parse(await readFile('/private/tmp/akh_c8_browser.json','utf8')),frontend=JSON.parse(await readFile('/private/tmp/akh_c8_frontend-start.json','utf8'));
assert.equal((await sourceHashes()).productionFingerprint,fixture.productionFingerprint);assert.equal(frontend.productionFingerprint,fixture.productionFingerprint);
assert.match(fixture.database,/^akh_c8_test_ui_[a-f0-9]{32}$/);
const url=new URL(process.env.TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));url.pathname='/'+fixture.database;
const db=new Pool({connectionString:url.href}),output='docs/ui-validation/2026-11-18-internal-links',results=[];
try{
 let index=0;
 for(const width of [1440,390])for(const theme of ['light','dark']){
  const f=fixture.scenarios[index++],profile=await mkdtemp('/private/tmp/akh_c8_profile_');
  const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width,height:width===1440?1000:844},timezoneId:'Asia/Seoul'});
  try{
   context.setDefaultTimeout(20000);const errors=[],requests=[];let actor='editor';
   await context.route('**/api/**',async route=>{const req=route.request(),u=new URL(req.url());requests.push({path:u.pathname+u.search,method:req.method()});try{const response=await route.fetch({url:`http://127.0.0.1:4398${u.pathname}${u.search}`,headers:{...req.headers(),cookie:'synthetic-'+actor,origin:'http://127.0.0.1:5198'}});await route.fulfill({response});}catch(e){if(!/closed|cancel|disposed/i.test(e.message))throw e;}});
   const page=context.pages()[0]??await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   const canonical=async(path,body,who=actor)=>{const response=await fetch(`http://127.0.0.1:4398/api/v1${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:'synthetic-'+who,origin:'http://127.0.0.1:5198','X-Space-Id':f.spaceId,'X-CSRF-Token':'test-only-csrf','Content-Type':'application/json','Idempotency-Key':'c8-'+width+'-'+theme+'-'+path},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,data}));return data;};
   const go=async(id)=>{await page.goto(`http://127.0.0.1:5198/?app=1&space=${f.spaceId}&document=${id}`);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('[data-document-heading]').waitFor();};
   await go('topic');await page.getByRole('button',{name:'개인 초안 시작',exact:true}).click();
   const area=page.locator('textarea[rows="14"]');await area.dispatchEvent('compositionstart');await area.fill('검토할 연결\n\n[[중복');
   assert.equal(await page.getByRole('listbox',{name:'링크 후보'}).count(),0);await area.dispatchEvent('compositionend');
   await page.getByRole('listbox',{name:'링크 후보'}).waitFor();
   assert.equal(await page.getByRole('listbox',{name:'링크 후보'}).getByRole('button').count(),2);
   assert.ok((await area.inputValue()).includes('[[중복'));
   await area.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-suggestions.png`,fullPage:true});
   await area.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelector('textarea[rows="14"]')?.value.includes('document=leaf'));
   assert.equal(await area.inputValue(),`검토할 연결\n\n[중복 제목](/?app=1&space=${f.spaceId}&document=leaf)`);
   assert.equal(await area.evaluate(el=>el===document.activeElement),true);
   await page.waitForFunction(()=>document.body.textContent.includes('서버에 저장됨 · 발행되지 않음'));
   const drafts=await canonical('/workflows/drafts'),draft=drafts.items.find(x=>x.pageId==='topic');assert.ok(draft);assert.equal(draft.dependencyVersions.leaf,1);
   assert.deepEqual((await canonical('/convenience/pages/leaf/backlinks')).items,[]);
   const batch=await canonical(`/workflows/drafts/${draft.id}/submit`,{expectedRevision:draft.revision,reason:'합성 연결 검토'});
   await canonical(`/changesets/${batch.id}/approve`,{hash:batch.hash},'reviewer');await canonical(`/changesets/${batch.id}/publish`,{hash:batch.hash},'reviewer');
   assert.equal((await canonical('/convenience/pages/leaf/backlinks')).items[0].id,'topic');
   // Round1: actual content-only restore preview and independent reviewer disclosure.
   const removed=await canonical('/workflows/pages/topic/edit',{baseVersion:2,content:'연결 제거',reason:'합성 제거'});
   await canonical(`/changesets/${removed.id}/approve`,{hash:removed.hash},'reviewer');await canonical(`/changesets/${removed.id}/publish`,{hash:removed.hash},'reviewer');
   assert.deepEqual((await canonical('/convenience/pages/leaf/backlinks')).items,[]);
   await page.goto(`http://127.0.0.1:5198/?app=1&space=${f.spaceId}#versions`);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.getByRole('heading',{name:'버전 비교 · 선택 복원과 판단'}).waitFor();
   await page.getByText('발행 묶음에서 선택 복원',{exact:true}).click();await page.getByRole('button',{name:'허용된 발행 묶음 가져오기'}).click();
   await page.getByLabel('복원 기준 발행 묶음').selectOption(batch.id);
   await page.getByRole('checkbox',{name:'본문',exact:true}).check();
   await page.getByLabel('나중의 사람 편집을 보존한 검토용 병합 본문(선택)').fill(`검토할 연결\n\n[중복 제목](/?app=1&space=${f.spaceId}&document=leaf)`);
   await page.getByRole('button',{name:'현재 버전·충돌 미리보기'}).click();
   const disclosure=page.getByRole('region',{name:'복원 연결 변경'});await disclosure.getByText('topic · 본문 링크로 추가되는 연결: leaf',{exact:true}).waitFor();
   await disclosure.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-restore-preview.png`,fullPage:true});
   await page.getByLabel('복원 이유',{exact:true}).fill('본문 연결 복원 검토');
   const response=page.waitForResponse(r=>r.url().endsWith('/versions/restore/propose')&&r.request().method()==='POST');
   await page.getByRole('button',{name:'새 복원 검토 제안 만들기'}).click();const proposedResponse=await response;assert.equal(proposedResponse.status(),201);const restored=await proposedResponse.json();
   actor='reviewer';await page.goto(`http://127.0.0.1:5198/?app=1&space=${f.spaceId}&section=tasks&targetKind=review&targetId=${restored.batchId}`);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.getByRole('region',{name:'복원 연결 변경'}).getByText('topic · 본문 링크로 추가되는 연결: leaf',{exact:true}).waitFor();
   await page.getByRole('region',{name:'복원 연결 변경'}).scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-restore-review.png`,fullPage:true});
   await page.getByRole('button',{name:'승인',exact:true}).click();await page.getByRole('button',{name:'승인 집합 발행',exact:true}).click();
   await page.getByText('변경 집합 전체를 발행했습니다.',{exact:true}).waitFor();actor='editor';
   assert.equal((await canonical('/convenience/pages/leaf/backlinks')).items[0].version,4);
   // Canonical metadata fixture rename (synthetic only); actual UI navigation continues via unchanged ID.
   await db.query("UPDATE pages SET data=jsonb_set(data,'{title}',to_jsonb('선택 문서 이름 변경'::text)) WHERE workspace_id=$1 AND id='leaf'",[f.spaceId]);
   await go('topic');const bodyLink=page.locator('a[href*="document=leaf"]').filter({hasText:'중복 제목'});await bodyLink.first().click();await page.locator('[data-document-heading]').filter({hasText:'선택 문서 이름 변경'}).waitFor();
   await page.getByText('연결·백링크·관련 문서',{exact:true}).click();
   const panel=page.getByRole('region',{name:'이 문서를 참조하는 문서'});await panel.getByRole('link',{name:'운영 지식',exact:true}).waitFor();
   await panel.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-backlinks.png`,fullPage:true});
   await db.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='page' AND resource_id='topic' AND principal_id='editor'",[f.spaceId]);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await panel.getByText('현재 열람 가능한 발행 백링크가 없습니다.',{exact:true}).waitFor();
   assert.equal(await panel.getByRole('link').count(),0);
   assert.deepEqual((await canonical('/convenience/pages/leaf/backlinks')).items,[]);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:`${output}/${width}-${theme}-revoked.png`,fullPage:true});
   assert.deepEqual(errors,[]);results.push({width,theme,duplicateChoice:true,keyboard:true,syntheticComposition:true,versionPin:true,draftNoEdges:true,publication:true,contentOnlyRestore:true,inducedPreview:true,independentReviewDisclosure:true,renameNavigation:true,sourceRevocation:true,overflow:false,errors,requests});
  }finally{await context.close();await rm(profile,{recursive:true,force:true});}
 }
 await writeFile(output+'/browser-results.json',JSON.stringify({startedAt:fixture.startedAt,finishedAt:new Date().toISOString(),productionFingerprint:fixture.productionFingerprint,frontendStartedAt:frontend.startedAt,synthetic:true,results},null,2));console.log(JSON.stringify(results.map(({requests,...r})=>r),null,2));
}finally{await db.end();}
