import {sourceHashes} from './manifest.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {Pool} from 'pg';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
if(process.env.AKH_C9_SYNTHETIC_CAPTURE!=='1'||!process.env.TEST_DATABASE_URL)throw Error('Explicit synthetic opt-in required');
const fixture=JSON.parse(await readFile('/private/tmp/akh_c9_browser.json','utf8')),frontend=JSON.parse(await readFile('/private/tmp/akh_c9_frontend-start.json','utf8'));
assert.equal((await sourceHashes()).productionFingerprint,fixture.productionFingerprint);assert.equal(frontend.productionFingerprint,fixture.productionFingerprint);
assert.match(fixture.database,/^akh_c9_test_ui_[a-f0-9]{32}$/);
const url=new URL(process.env.TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname));url.pathname='/'+fixture.database;
const db=new Pool({connectionString:url.href}),output='docs/ui-validation/2026-11-18-document-reader',results=[];
try{
 let index=0;
 for(const width of [1440,390])for(const theme of ['light','dark']){
  console.log('case',width,theme);
  const f=fixture.scenarios[index++],profile=await mkdtemp('/private/tmp/akh_c9_profile_');
  const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width,height:width===1440?1000:844},timezoneId:'Asia/Seoul'});
  try{
   context.setDefaultTimeout(20000);const errors=[],requests=[];let mutation=0,browserActor='editor';
   // Hold actual canonical responses after HTTP authorization, never fabricate bodies.
   const held=new Map();
   const hold=path=>{let release,captured;const pending=new Promise(r=>release=r),seen=new Promise(r=>captured=r);held.set(path,{pending,captured});return {release,seen};};
   await context.addInitScript(t=>{localStorage.setItem('agent-knowledge-hub.theme',t);Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{if(window.__c9CopyMode==='hold-first'){window.__c9CopyMode='deny';return new Promise(resolve=>{window.__c9FinishCopy=resolve;});}throw Error('Synthetic Clipboard denial');}},configurable:true});},theme);
   await context.route('**/api/**',async route=>{const req=route.request(),u=new URL(req.url());requests.push({path:u.pathname+u.search,method:req.method()});try{const response=await route.fetch({url:`http://127.0.0.1:4399${u.pathname}${u.search}`,headers:{...req.headers(),cookie:'synthetic-'+browserActor,origin:'http://127.0.0.1:5199'}});const gate=held.get(u.pathname+u.search);if(gate){held.delete(u.pathname+u.search);gate.captured(response.status());await gate.pending;}await route.fulfill({response});}catch(e){if(!/closed|cancel|disposed/i.test(e.message))throw e;}});
   const page=context.pages()[0]??await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
   const canonical=async(path,body,actor='editor')=>{const response=await fetch(`http://127.0.0.1:4399/api/v1${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:'synthetic-'+actor,origin:'http://127.0.0.1:5199','X-Space-Id':f.spaceId,'X-CSRF-Token':'test-only-csrf','Content-Type':'application/json','Idempotency-Key':'c9-'+width+'-'+theme+'-'+(++mutation)},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,data}));return data;};
   const snapshot=await canonical('/versions/pages/topic/latest'),anchor=snapshot.anchors.anchors.find(a=>a.startLine===5).id;
   const go=async(query='')=>{await page.goto(`http://127.0.0.1:5199/?app=1&space=${f.spaceId}&document=topic${query}`);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.getByRole('region',{name:'문서 읽기',exact:true}).waitFor();};
   await go();assert.equal(await page.locator('[data-document-heading]').count(),1);
   await go(`&version=2&anchor=${anchor}`);
   const reader=page.getByRole('region',{name:'문서 읽기',exact:true});
   await page.waitForFunction(a=>document.activeElement?.getAttribute('data-block-id')===a,anchor);
   const headings=reader.getByRole('navigation',{name:'문서 목차'}).getByRole('button',{name:'설치',exact:true});assert.equal(await headings.count(),2);
   await headings.nth(1).focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'설치');
   const headingId=await page.evaluate(()=>document.activeElement?.id);await headings.nth(0).focus();await page.keyboard.press('Enter');assert.notEqual(await page.evaluate(()=>document.activeElement?.id),headingId);
   const search=reader.getByLabel('문서 내 검색');await search.fill('한글');await reader.getByText('1 / 4',{exact:true}).waitFor();await search.focus();await page.keyboard.press('Enter');await reader.getByText('2 / 4',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'MARK');
   await search.focus();await page.keyboard.press('Shift+Enter');await reader.getByText('1 / 4',{exact:true}).waitFor();
   assert.equal(await reader.locator('script').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await reader.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-reader.png`,fullPage:true});
   // Final I3: execute the real registered 60s timer under Chromium's controlled clock.
   await search.focus();await search.evaluate(el=>el.setSelectionRange(0,1));
   const sameRead=hold('/api/v1/versions/pages/topic/2');await page.clock.fastForward(60000);assert.equal(await sameRead.seen,200);
   assert.equal(await reader.count(),0);sameRead.release();await reader.waitFor();
   assert.equal(await search.inputValue(),'한글');await reader.getByText('1 / 4',{exact:true}).waitFor();
   assert.equal(await search.evaluate(el=>document.activeElement===el),true);assert.deepEqual(await search.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,1]);
   await search.focus();await page.keyboard.press('Enter');await reader.getByText('2 / 4',{exact:true}).waitFor();
   const matchRead=hold('/api/v1/versions/pages/topic/2');await page.clock.fastForward(60000);assert.equal(await matchRead.seen,200);assert.equal(await reader.count(),0);matchRead.release();await reader.waitFor();
   await page.waitForFunction(()=>document.activeElement?.getAttribute('data-match')==='1');
   await page.screenshot({path:`${output}/${width}-${theme}-reading-restored.png`,fullPage:true});
   console.log('periodic restoration passed',width,theme);
   // I2: an older successful latest copy must not erase a newer fixed-copy failure.
   await page.evaluate(()=>window.__c9CopyMode='hold-first');
   await reader.getByRole('button',{name:'최신 문서 링크 복사',exact:true}).click();
   await reader.getByRole('button',{name:'v2 고정 링크 복사',exact:true}).click();
   const raceFallback=reader.getByLabel('직접 복사할 내용');const failedFixed=await raceFallback.inputValue();assert.ok(failedFixed.includes('version=2'));
   await page.evaluate(async()=>{window.__c9FinishCopy();await new Promise(requestAnimationFrame);});
   assert.equal(await raceFallback.inputValue(),failedFixed);assert.equal(await reader.getByText('복사했습니다.',{exact:true}).count(),0);
   await raceFallback.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-copy-race.png`,fullPage:true});
   await reader.getByRole('button',{name:'코드 복사',exact:true}).click();const fallback=reader.getByLabel('직접 복사할 내용');assert.match(await fallback.inputValue(),/const 한글 = "<script>안전한 예제<\/script>";/);assert.equal(await reader.getByText('복사했습니다.',{exact:true}).count(),0);
   await fallback.focus();assert.equal(await fallback.evaluate(el=>el.selectionEnd-el.selectionStart), (await fallback.inputValue()).length);
   await fallback.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-copy-fallback.png`,fullPage:true});
   await reader.locator(`[data-block-share="${anchor}"]`).click();await reader.getByRole('button',{name:'고정 부분 링크 복사',exact:true}).click();const pinned=await fallback.inputValue();assert.match(pinned,/version=2/);assert.ok(pinned.includes('anchor='+anchor));
   await reader.getByRole('button',{name:'최신 부분 링크 복사',exact:true}).click();const latest=await fallback.inputValue();assert.ok(!latest.includes('version='));assert.ok(latest.includes('anchor='+anchor));
   const changed=await canonical('/workflows/pages/topic/edit',{baseVersion:2,content:'# 문서 읽기\n\n위치가 바뀐 새 문단',reason:'합성 문단 삭제'});await canonical(`/changesets/${changed.id}/approve`,{hash:changed.hash},'reviewer');await canonical(`/changesets/${changed.id}/publish`,{hash:changed.hash},'reviewer');
   await go('&anchor='+anchor);await reader.getByText('위치가 변경되었거나 사라졌습니다. 다른 문단으로 이동하지 않았습니다.',{exact:true}).waitFor();assert.notEqual(await page.evaluate(()=>document.activeElement?.getAttribute('data-block-id')),anchor);
   await reader.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-missing-anchor.png`,fullPage:true});
   await go('&version=2&anchor='+anchor);await page.waitForFunction(a=>document.activeElement?.getAttribute('data-block-id')===a,anchor);await page.getByText('과거 발행 기록 · 현재 권고 아님',{exact:true}).waitFor();
   await db.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",[f.spaceId]);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>!document.body.textContent.includes('한글 첫 문단'));assert.equal(await reader.count(),0);
   await page.screenshot({path:`${output}/${width}-${theme}-revoked.png`,fullPage:true});
   // Re-admit exactly our synthetic reader, then revoke during the current workflow view.
   await db.query("INSERT INTO resource_readers VALUES($1,'source','source-a','editor')",[f.spaceId]);
   await go();await reader.getByText('위치가 바뀐 새 문단',{exact:true}).waitFor();
   await db.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='editor'",[f.spaceId]);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>!document.body.textContent.includes('위치가 바뀐 새 문단'));assert.equal(await reader.count(),0);
   // I1: actual approved publication with CR-only and mixed CR/LF source text.
   await db.query("INSERT INTO resource_readers VALUES($1,'source','source-a','editor')",[f.spaceId]);
   const publish=async(content,baseVersion)=>{const b=await canonical('/workflows/pages/topic/edit',{baseVersion,content,reason:'C9 CR 위치 회귀'});await canonical(`/changesets/${b.id}/approve`,{hash:b.hash},'reviewer');await canonical(`/changesets/${b.id}/publish`,{hash:b.hash},'reviewer');};
   await publish('# 줄바꿈\r\r원래 문단',3);
   const cr=await canonical('/versions/pages/topic/latest'),crAnchor=cr.anchors.anchors[1].id;
   await go('&anchor='+crAnchor);await page.waitForFunction(a=>document.activeElement?.getAttribute('data-block-id')===a,crAnchor);assert.ok((await page.evaluate(()=>document.activeElement?.textContent)).includes('원래 문단'));
   await publish('앞 문단\n\n# 줄바꿈\r\r원래 문단',4);
   await go('&anchor='+crAnchor);await page.waitForFunction(a=>document.activeElement?.getAttribute('data-block-id')===a,crAnchor);assert.ok((await page.evaluate(()=>document.activeElement?.textContent)).includes('원래 문단'));
   await publish('앞 문단\n\n# 줄바꿈\r\r대체 문단',5);
   await go('&anchor='+crAnchor);await reader.getByText('위치가 변경되었거나 사라졌습니다. 다른 문단으로 이동하지 않았습니다.',{exact:true}).waitFor();assert.equal(await reader.locator(`[data-block-id="${crAnchor}"]`).count(),0);
   await reader.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/${width}-${theme}-newline-unavailable.png`,fullPage:true});
   await go('&version=4&anchor='+crAnchor);await page.waitForFunction(a=>document.activeElement?.getAttribute('data-block-id')===a,crAnchor);assert.ok((await page.evaluate(()=>document.activeElement?.textContent)).includes('원래 문단'));
   await publish('앞 문단\n\n# 줄바꿈',6);
   await go('&anchor='+crAnchor);await reader.getByText('위치가 변경되었거나 사라졌습니다. 다른 문단으로 이동하지 않았습니다.',{exact:true}).waitFor();assert.equal(await reader.locator(`[data-block-id="${crAnchor}"]`).count(),0);
   // Final I2: same-line/adjacent math is explicitly unavailable; separated math
   // remains exact through actual latest/fixed copy URLs and HTTP navigation.
   await publish('before $$x$$\nafter\n\n$$z$$\nAdjacent paragraph\n\n# Safe\n\n$$y$$\n\n# End',7);
   const mathSnapshot=await canonical('/versions/pages/topic/latest'),ambiguous=mathSnapshot.anchors.anchors[0].id;
   await go('&anchor='+ambiguous);await reader.getByText('위치가 변경되었거나 사라졌습니다. 다른 문단으로 이동하지 않았습니다.',{exact:true}).waitFor();assert.equal(await reader.locator(`[data-block-share="${ambiguous}"]`).count(),0);
   const destinations=await reader.locator('[data-block-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.blockId));assert.equal(new Set(destinations).size,destinations.length);
   await page.screenshot({path:`${output}/${width}-${theme}-math-unavailable.png`,fullPage:true});
   for(const fixed of [false,true]){
    const mathTarget=reader.locator('[data-block-id]').filter({has:page.locator('math')});assert.equal(await mathTarget.count(),1);const mathId=await mathTarget.getAttribute('data-block-id');
    await mathTarget.getByRole('button',{name:'부분 링크',exact:true}).click();await reader.getByRole('button',{name:fixed?'고정 부분 링크 복사':'최신 부분 링크 복사',exact:true}).click();const copied=await reader.getByLabel('직접 복사할 내용').inputValue();assert.ok(copied.includes('anchor='+mathId));assert.equal(copied.includes('version=8'),fixed);
    await page.goto(copied);await reader.waitFor();await page.waitForFunction(id=>document.activeElement?.getAttribute('data-block-id')===id,mathId);assert.equal(await page.evaluate(()=>document.activeElement?.querySelector('math')?.textContent),'y');
   }
   console.log('math round trips passed',width,theme);
   // Final I1: expiry-save's authorized GET races a newer real source-ACL denial.
   // Exercise both response completion orders through the actual UI and handlers.
   browserActor='reviewer';
   for(const order of ['denial-first','manual-first']){
    await go();await page.getByPlaceholder('복원·보호·수명주기 변경 이유').fill('Synthetic final read authority check');await page.getByText('문서 수명주기',{exact:true}).click();
    const old=hold('/api/v1/workflows/pages/topic');await page.getByRole('button',{name:'유효기간 저장',exact:true}).click();assert.equal(await old.seen,200);
    await db.query("DELETE FROM resource_readers WHERE workspace_id=$1 AND kind='source' AND resource_id='source-a' AND principal_id='reviewer'",[f.spaceId]);
    const denied=hold('/api/v1/workflows/pages/topic?visit=0'),deniedComments=hold('/api/v1/workflows/pages/topic/comments');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.equal(await denied.seen,404);assert.equal(await deniedComments.seen,404);
    assert.equal(await reader.count(),0);
    if(order==='denial-first'){denied.release();deniedComments.release();await page.waitForTimeout(80);old.release();}else{old.release();await page.waitForTimeout(80);assert.equal(await reader.count(),0);denied.release();deniedComments.release();}
    await page.waitForTimeout(100);assert.equal(await reader.count(),0);assert.equal(await page.getByText('Adjacent paragraph',{exact:true}).count(),0);
    await page.screenshot({path:`${output}/${width}-${theme}-revocation-${order}.png`,fullPage:true});
    await db.query("INSERT INTO resource_readers VALUES($1,'source','source-a','reviewer')",[f.spaceId]);
   }
   assert.deepEqual(errors,[]);
   results.push({width,theme,periodicReadingStateRestored:true,mathUnavailableAndExactRoundTrip:true,manualRevocationBothOrders:true,copyOutOfOrder:true,crMixedMovedChangedDeleted:true,keyboard:true,distinctRepeatedHeadings:true,koreanSearch:4,codeCopyDenied:true,selectableFallback:true,fixedAndLatest:true,missingAnchorFailClosed:true,historicalCurrentAcl:true,overflow:false,errors,requests,browserVersion:context.browser()?.version()});
  }finally{await context.close();await rm(profile,{recursive:true,force:true});}
 }
 await writeFile(output+'/browser-results.json',JSON.stringify({startedAt:fixture.startedAt,finishedAt:new Date().toISOString(),productionFingerprint:fixture.productionFingerprint,frontendStartedAt:frontend.startedAt,synthetic:true,results},null,2));console.log(JSON.stringify(results.map(({requests,...r})=>r),null,2));
}finally{await db.end();}
