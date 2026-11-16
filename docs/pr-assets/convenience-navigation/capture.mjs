const { chromium } = await import(process.env.C1_PLAYWRIGHT_MODULE ?? 'playwright');
import assert from 'node:assert/strict';
const out = new URL('.', import.meta.url).pathname;
const baseUrl = process.env.C1_BASE_URL ?? 'http://127.0.0.1:5191';
const browser=await chromium.launch({headless:true});
const capabilities=['knowledge.read','draft.write','changeset.propose','changeset.approve','queue.triage','jobs.read','space.admin','usage.read_aggregate','knowledge.protect','lifecycle.manage'];
const errors=[];
async function contextFor(width,theme,caps=capabilities){
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
 await context.addInitScript(t=>{localStorage.setItem('agent-knowledge-hub.theme',t);},theme);
 await context.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.replace('/api/v1','');
  const data=path==='/me'?{principalId:'synthetic-person',workspaceId:'test-space',role:'reviewer',csrfToken:'synthetic-csrf',capabilities:caps}
   :path==='/model'?{configured:false,model:null}
   :path==='/governance/workbench'?{pages:[],owners:[],proposals:[],policies:[],canManage:true}
   :path==='/jobs-v2/job-29'?{id:'job-29',kind:'lint',status:'succeeded',attempts:1,maxAttempts:3,error:null,checkpoint:{},result:{},heartbeatAt:null}
   :{items:[],nextOffset:null};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 return {context,page};
}
try{
 for(const width of [1440,390]) for(const theme of ['light','dark']){
  const {context,page}=await contextFor(width,theme);
  await page.goto(`${baseUrl}/?app=1&space=test-space&section=favorites`);
  await page.getByText('이 화면은 아직 연결되지 않았습니다.',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal viewport overflow');
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);
  if(width===390){
   const menu=page.getByRole('button',{name:/메뉴 ·/});await menu.focus();await page.keyboard.press('Enter');
   assert.equal(await page.getByRole('button',{name:'탐색 닫기'}).getAttribute('aria-expanded'),'true');
  }
  await page.screenshot({path:`${out}/${width}-${theme}-navigation.png`,fullPage:false});
  const recent=page.getByRole('link',{name:'최근 방문',exact:true});await recent.focus();await page.keyboard.press('Enter');
  await page.waitForURL('**section=recent');
  await page.waitForFunction(()=>document.activeElement?.id==='op-main');
  if(width===390) assert.equal(await page.getByRole('button',{name:/메뉴 · 최근 방문/}).getAttribute('aria-expanded'),'false');
  // Quick actions remain reachable with the mobile navigation collapsed.
  assert.equal(await page.getByRole('button',{name:'검색',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'새 문서',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('button',{name:'알림',exact:true}).isVisible(),true);
  await page.goto(`${baseUrl}/?app=1&space=test-space&section=tasks&targetKind=job&targetId=job-29`);
  await page.getByRole('heading',{name:'실행 근거 · job-29'}).waitFor();
  await page.screenshot({path:`${out}/${width}-${theme}-job.png`,fullPage:true});
  await context.close();
 }
 for(const [label,caps,expected] of [['reader',['knowledge.read'],[]],['writer',['knowledge.read','draft.write','changeset.propose'],['새 문서']],['maintainer',['knowledge.read','knowledge.protect','lifecycle.manage'],['검토 · 공유 정책','편집 · 수명주기']]]){
  const {context,page}=await contextFor(1440,'light',caps);
  await page.goto(`${baseUrl}/?app=1&space=test-space&section=home`);
  await page.getByText('이 화면은 아직 연결되지 않았습니다.',{exact:false}).waitFor();
  const nav=page.getByRole('navigation',{name:'운영 콘솔'});
  for(const name of expected) assert.equal(await nav.getByRole('link',{name,exact:true}).count(),1,label);
  assert.equal(await nav.getByRole('link',{name:'공간 · 접근',exact:true}).count(),0,label+' must not inherit admin from role');
  if(label==='reader') assert.equal(await page.getByRole('button',{name:'새 문서',exact:true}).count(),0);
  await context.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({screenshots:8,widths:[1440,390],themes:['light','dark'],keyboard:'Enter navigation, menu closes, focus returns to main',roles:['reader','writer','maintainer'],pageErrors:errors},null,2));
}finally{await browser.close();}
