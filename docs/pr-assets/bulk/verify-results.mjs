import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if(!process.argv[2]||!process.argv[3]) throw Error('Provide Playwright module and browser executable paths');
const {chromium}=await import(pathToFileURL(resolve(process.argv[2])).href);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixture=`__bulk_review_${process.pid}`;
const html=resolve(root,`${fixture}.html`),tsx=resolve(root,`${fixture}.tsx`);
await writeFile(html,`<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/${fixture}.tsx"></script></body></html>`);
await writeFile(tsx,`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BulkEditor}from'./src/operational/BulkEditor';import './src/ui/tokens.css';import './src/styles.css';import './src/operational/styles.css';const api={post:async(path)=>path.endsWith('preview')?{token:'synthetic-only',expiresAt:'2026-11-16T15:00:00Z',items:[{id:'a',status:'ready',expectedRevision:0,patch:{state:'archived'}},{id:'b',status:'ready',expectedRevision:0,patch:{state:'archived'}}]}:{items:[{id:'a',status:'applied',revision:1},{id:'b',status:'unconfirmed',code:'NOT_PROCESSED'}]}};function Host(){const[ready,setReady]=useState(true);return <main className="operational-app" style={{padding:24,maxWidth:1000,margin:'auto'}}><section className="op-panel"><h1>일괄 편집 결과 · 합성 검증</h1><p>실제 BulkEditor와 앱 CSS. 서버 응답은 합성 fixture입니다.</p>{ready?<BulkEditor api={api} pages={[{id:'a',title:'문서 A'},{id:'b',title:'문서 B'}]} scope="synthetic:user" onChanged={async()=>setReady(false)} onExpired={()=>setReady(false)}/>:<p>호스트 문서 목록 다시 불러오는 중</p>}</section></main>}createRoot(document.getElementById('root')).render(<Host/>);`);
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','33673'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
try{
 for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:33673/${fixture}.html`);if(r.ok)break;}catch{}if(i===99)throw Error('fixture server not ready');await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:resolve(process.argv[3]),args:['--disable-gpu']});
 const results=[];
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:33673/${fixture}.html`);
  await page.getByText('여러 문서의 태그·위치·보관 변경',{exact:true}).click();
  await page.getByRole('checkbox',{name:'문서 A',exact:true}).check();await page.getByRole('checkbox',{name:'문서 B',exact:true}).check();
  await page.getByLabel('변경 종류').selectOption('archive');await page.getByLabel('변경 이유').fill('합성 문서 분류 정리');
  await page.getByRole('button',{name:'변경 미리보기',exact:true}).click();await page.getByRole('button',{name:'미리보기 내용 적용',exact:true}).click();
  await page.getByText('NOT_PROCESSED',{exact:false}).waitFor();
  const recovery=page.getByRole('button',{name:'동일 요청의 처리 결과 다시 확인',exact:true});assert(await recovery.isVisible());
  const refresh=page.getByRole('button',{name:'결과 확인 후 문서 목록 새로고침',exact:true});assert(await refresh.isVisible());
  await refresh.scrollIntoViewIfNeeded();await page.screenshot({path:resolve(root,`docs/pr-assets/bulk/host-results-${width}.png`)});
  await recovery.click();await page.getByText('NOT_PROCESSED',{exact:false}).waitFor();
  await refresh.click();await page.getByText('호스트 문서 목록 다시 불러오는 중',{exact:true}).waitFor();assert.equal(await page.getByText('NOT_PROCESSED',{exact:false}).count(),0);
  assert.deepEqual(errors,[]);results.push({width,partialResultPreserved:true,recoveryPreserved:true,explicitHostRefresh:true,pageErrors:errors});await context.close();
 }
 await writeFile(resolve(root,'docs/pr-assets/bulk/host-results.json'),JSON.stringify({data:'synthetic API fixture; actual BulkEditor and app CSS',browser:await browser.version(),results},null,2)+'\n');console.log(JSON.stringify(results));
}finally{if(browser)await browser.close();server.kill();await rm(html,{force:true});await rm(tsx,{force:true});}
